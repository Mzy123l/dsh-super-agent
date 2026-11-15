// SQLite 存储层。
//
// 核心约定（见 schema.sql）：
//   * 索引是给模型看的 token（`#0` `#1` …），标在消息里。
//   * **一个会话内线性递增**，从 0 开始，不间断不跳号。
//   * 不再用 (sessionId, seq, kind) 三元组——一条消息一个槽位一个编号。
//   * 内部行号 row_id 只给 FTS 当 rowid 用，不对外暴露。

import DatabaseConstructor from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  IndexStatus,
  KeywordHit,
  MessageRecord,
  MessageResult,
  Role,
} from '../types.js'
import { segmentForFts } from '../search/segment.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>
type SqliteStatement = import('better-sqlite3').Statement<unknown[], unknown>

/** 定位 schema.sql */
function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const p of [join(here, 'schema.sql'), join(here, '..', '..', 'src', 'store', 'schema.sql')]) {
    if (existsSync(p)) return p
  }
  throw new Error(`schema.sql not found near ${here}`)
}

/** 打开选项 */
export interface OpenOptions {
  path?: string
}

/** message 表联查后的行 */
interface MessageRow {
  row_id: number
  sessionId: string
  idx: number
  role: string
  text: string
  at: string
  in_context: number
  tags: string
}

/**
 * 消息存储。
 *
 * 写入按会话线性分配 idx：会话内第一个消息 idx=0，之后 +1。
 * 已存在（同 sessionId + 同文本 + 同位置）则复用编号。
 */
export class MemoryStore {
  private readonly db: BetterSqlite3
  private readonly dbPath: string

  private readonly stmtInsert: SqliteStatement
  private readonly stmtFindByText: SqliteStatement
  private readonly stmtNextIdx: SqliteStatement
  private readonly stmtInsertFts: SqliteStatement
  private readonly stmtDeleteFts: SqliteStatement

  constructor(options: OpenOptions = {}) {
    this.dbPath = options.path ?? ':memory:'
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true })
    this.db = DatabaseConstructor(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()

    this.stmtInsert = this.db.prepare(
      `INSERT INTO message (sessionId, idx, role, text, at, in_context, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    // 幂等查找：同一会话内，同角色同正文的消息视为同一条
    this.stmtFindByText = this.db.prepare(
      `SELECT row_id, idx FROM message WHERE sessionId = ? AND role = ? AND text = ? LIMIT 1`,
    )
    this.stmtNextIdx = this.db.prepare(
      `SELECT IFNULL(MAX(idx), -1) + 1 AS next FROM message WHERE sessionId = ?`,
    )
    this.stmtInsertFts = this.db.prepare(`INSERT INTO message_fts (rowid, text) VALUES (?, ?)`)
    this.stmtDeleteFts = this.db.prepare(`DELETE FROM message_fts WHERE rowid = ?`)
  }

  private migrate(): void {
    this.db.exec(readFileSync(schemaPath(), 'utf8'))
  }

  close(): void {
    this.db.close()
  }

  /** 底层连接（供 segment/pending/vector 复用同一连接） */
  get raw(): ReturnType<typeof DatabaseConstructor> {
    return this.db
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /**
   * 追加一条消息，返回它的会话内索引。
   *
   * 幂等：同一会话内、同角色、同正文的消息已存在时复用原编号。
   * 否则分配 `MAX(idx)+1`（会话第一条为 0）。
   *
   * @param msg - 消息内容。
   * @returns 该消息的会话内索引。
   */
  appendMessage(msg: Omit<MessageRecord, 'idx'>): number {
    const existing = this.stmtFindByText.get(msg.sessionId, msg.role, msg.text) as
      | { row_id: number; idx: number }
      | undefined
    if (existing) {
      // 已存在：更新上下文状态与便签，编号不变
      this.db
        .prepare(`UPDATE message SET in_context = ?, tags = ?, at = ? WHERE row_id = ?`)
        .run(msg.inContext === false ? 0 : 1, JSON.stringify(msg.tags ?? []), msg.at, existing.row_id)
      return existing.idx
    }

    const next = this.stmtNextIdx.get(msg.sessionId) as { next: number }
    const idx = next.next
    this.stmtInsert.run(
      msg.sessionId,
      idx,
      msg.role,
      msg.text,
      msg.at,
      msg.inContext === false ? 0 : 1,
      JSON.stringify(msg.tags ?? []),
    )
    const row = this.stmtFindByText.get(msg.sessionId, msg.role, msg.text) as { row_id: number; idx: number }
    this.stmtDeleteFts.run(row.row_id)
    this.stmtInsertFts.run(row.row_id, segmentForFts(msg.text))
    return idx
  }

  /** 批量追加（单事务）。返回每条消息的索引。 */
  appendBatch(msgs: Array<Omit<MessageRecord, 'idx'>>): number[] {
    const tx = this.db.transaction((rows: Array<Omit<MessageRecord, 'idx'>>) =>
      rows.map(m => this.appendMessage(m)),
    )
    return tx(msgs)
  }

  /** 把某会话的某些 idx 标记为「已不在上下文」。 */
  markOutOfContext(sessionId: string, fromIdx: number, toIdx: number): number {
    const info = this.db
      .prepare(`UPDATE message SET in_context = 0 WHERE sessionId = ? AND idx >= ? AND idx <= ?`)
      .run(sessionId, fromIdx, toIdx)
    return info.changes
  }

  /** 追加一条便签（程序内部维护）。 */
  addTag(sessionId: string, idx: number, tag: string): void {
    const row = this.db
      .prepare(`SELECT row_id, tags FROM message WHERE sessionId = ? AND idx = ?`)
      .get(sessionId, idx) as { row_id: number; tags: string } | undefined
    if (!row) return
    const tags = parseTags(row.tags)
    if (tags.includes(tag)) return
    tags.push(tag)
    this.db.prepare(`UPDATE message SET tags = ? WHERE row_id = ?`).run(JSON.stringify(tags), row.row_id)
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /** 按 (sessionId, idx) 取**全量**消息——这是模型要查的东西。 */
  getMessage(sessionId: string, idx: number): MessageResult | undefined {
    const row = this.db
      .prepare(`SELECT * FROM message WHERE sessionId = ? AND idx = ?`)
      .get(sessionId, idx) as MessageRow | undefined
    return row ? toResult(row) : undefined
  }

  /** 按内部 row_id 取（FTS 回链用）。 */
  getByRowId(rowId: number): MessageResult | undefined {
    const row = this.db.prepare(`SELECT * FROM message WHERE row_id = ?`).get(rowId) as MessageRow | undefined
    return row ? toResult(row) : undefined
  }

  /** 某会话的编号范围（最小/最大 idx），用于告诉模型可查范围。 */
  indexRange(sessionId: string): { min: number; max: number } | undefined {
    const row = this.db
      .prepare(`SELECT MIN(idx) AS lo, MAX(idx) AS hi FROM message WHERE sessionId = ?`)
      .get(sessionId) as { lo: number | null; hi: number | null }
    if (row.lo === null || row.hi === null) return undefined
    return { min: row.lo, max: row.hi }
  }

  /** 某会话的消息总数。 */
  count(sessionId: string): number {
    return (this.db
      .prepare(`SELECT COUNT(*) AS n FROM message WHERE sessionId = ?`)
      .get(sessionId) as { n: number }).n
  }

  /** 按编号区间列出消息（升序）。 */
  listRange(sessionId: string, fromIdx: number, toIdx: number): MessageResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM message WHERE sessionId = ? AND idx >= ? AND idx <= ? ORDER BY idx ASC`)
      .all(sessionId, fromIdx, toIdx) as MessageRow[]
    return rows.map(toResult)
  }

  /** FTS 关键词查询。 */
  searchFts(query: string, limit: number, sessionId?: string): KeywordHit[] {
    const rows = sessionId
      ? this.db.prepare(
          `SELECT m.row_id, m.sessionId, m.idx, m.role, m.at, rank
           FROM message_fts JOIN message m ON m.row_id = message_fts.rowid
           WHERE message_fts MATCH ? AND m.sessionId = ?
           ORDER BY rank LIMIT ?`,
        ).all(query, sessionId, limit)
      : this.db.prepare(
          `SELECT m.row_id, m.sessionId, m.idx, m.role, m.at, rank
           FROM message_fts JOIN message m ON m.row_id = message_fts.rowid
           WHERE message_fts MATCH ?
           ORDER BY rank LIMIT ?`,
        ).all(query, limit)
    return (rows as Array<{
      row_id: number
      sessionId: string
      idx: number
      role: string
      at: string
      rank: number
    }>).map(r => ({
      rowId: r.row_id,
      sessionId: r.sessionId,
      idx: r.idx,
      role: r.role as Role,
      at: r.at,
      rank: r.rank,
    }))
  }

  /** FTS snippet。 */
  snippet(rowId: number, query: string): string | undefined {
    const row = this.db
      .prepare(`SELECT snippet(message_fts, 0, '[', ']', '…', 24) AS s FROM message_fts WHERE message_fts MATCH ? AND rowid = ?`)
      .get(query, rowId) as { s: string } | undefined
    if (!row) return undefined
    return row.s.replace(/([\u4e00-\u9fff\u3400-\u4dbf]) (?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
  }

  // -------------------------------------------------------------------------
  // 元信息 / 统计
  // -------------------------------------------------------------------------

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(key, value)
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value
  }

  /** 索引状态。 */
  status(): IndexStatus {
    const n = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n
    return {
      sessions: n(`SELECT COUNT(DISTINCT sessionId) AS n FROM message`),
      messages: n(`SELECT COUNT(*) AS n FROM message`),
      inContext: n(`SELECT COUNT(*) AS n FROM message WHERE in_context = 1`),
      segments: n(`SELECT COUNT(*) AS n FROM segment`),
      liveSegments: n(`SELECT COUNT(*) AS n FROM segment WHERE stage = 'live'`),
      lastIndexedAt: this.getMeta('lastIndexedAt') ?? null,
    }
  }
}

/** 安全解析标签数组。 */
export function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(t => typeof t === 'string') : []
  } catch {
    return []
  }
}

function toResult(row: MessageRow): MessageResult {
  return {
    rowId: row.row_id,
    sessionId: row.sessionId,
    idx: row.idx,
    role: row.role as Role,
    text: row.text,
    at: row.at,
    inContext: row.in_context === 1,
    tags: parseTags(row.tags),
  }
}
