// SQLite 存储层。
//
// 编号规则（见 schema.sql）：
//   * 会话内完全线性：0,1,2… 连续无空洞、不复用、不跳号。
//   * #0 = 该会话第一个 user prompt。
//   * 内部行号 row_id 只给 FTS 当 rowid，不对外。

import DatabaseConstructor from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IndexStatus, KeywordHit, Unit, UnitKind, UnitResult } from '../types.js'
import { segmentForFts } from '../search/segment.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>
type Statement = import('better-sqlite3').Statement<unknown[], unknown>

/** 定位 schema.sql。 */
function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const p of [join(here, 'schema.sql'), join(here, '..', '..', 'src', 'store', 'schema.sql')]) {
    if (existsSync(p)) return p
  }
  throw new Error(`schema.sql not found near ${here}`)
}

/** 打开选项。 */
export interface OpenOptions {
  path?: string
}

/** message 表的行。 */
interface Row {
  row_id: number
  sessionId: string
  idx: number
  kind: string
  summary: string
  content: string
  at: string
  in_context: number
  tags: string
}

/**
 * 单位存储。
 *
 * 两条关键规则：
 * 1. 编号线性且永不改变（含 summary 挂接、老化标记）。
 * 2. thinking 的 content **不进 FTS**（只进向量），但它的 summary 进 FTS。
 */
export class MemoryStore {
  private readonly db: BetterSqlite3
  private readonly dbPath: string

  private readonly stmtInsert: Statement
  private readonly stmtFind: Statement
  private readonly stmtNext: Statement
  private readonly stmtFtsInsert: Statement
  private readonly stmtFtsDelete: Statement

  constructor(options: OpenOptions = {}) {
    this.dbPath = options.path ?? ':memory:'
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true })
    this.db = DatabaseConstructor(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(readFileSync(schemaPath(), 'utf8'))
    this.assertSchema()

    this.stmtInsert = this.db.prepare(
      `INSERT INTO message (sessionId, idx, kind, summary, content, at, in_context, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtFind = this.db.prepare(
      `SELECT * FROM message WHERE sessionId = ? AND idx = ?`,
    )
    this.stmtNext = this.db.prepare(
      `SELECT IFNULL(MAX(idx), -1) + 1 AS next FROM message WHERE sessionId = ?`,
    )
    this.stmtFtsInsert = this.db.prepare(`INSERT INTO message_fts (rowid, text) VALUES (?, ?)`)
    this.stmtFtsDelete = this.db.prepare(`DELETE FROM message_fts WHERE rowid = ?`)
  }

  /**
   * 校验库结构与当前 schema 一致。
   *
   * `CREATE TABLE IF NOT EXISTS` 不会迁移旧表——旧版本的库（例如 message 表
   * 用 role 列而非 kind 列）不会被自动修正，继续使用会得到难以理解的
   * "no column named kind" 报错。这里提前失败并说明怎么处理。
   */
  private assertSchema(): void {
    const cols = this.db
      .prepare(`SELECT name FROM pragma_table_info('message')`)
      .all() as Array<{ name: string }>
    const names = new Set(cols.map(c => c.name))
    if (names.size === 0) return // 表刚建好，异常路径
    const required = ['sessionId', 'idx', 'kind', 'summary', 'content', 'at', 'in_context', 'tags']
    const missing = required.filter(r => !names.has(r))
    if (missing.length > 0) {
      throw new Error(
        `memory.sqlite 结构过旧（message 表缺少列：${missing.join(', ')}）。`
        + `这是旧版本留下的数据库，不支持自动迁移。`
        + `请删除该数据库重建：删除 ${this.dbPath} 后重启插件。`,
      )
    }
  }

  close(): void {
    this.db.close()
  }

  /** 底层连接（供向量表复用）。 */
  get raw(): ReturnType<typeof DatabaseConstructor> {
    return this.db
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /**
   * 追加一个单位，返回它的编号。
   *
   * 幂等：同会话内 kind + content 完全相同视为同一单位，复用编号
   * （只更新 summary/in_context/tags）。这是同步同一批消息不产生重复编号的关键。
   */
  appendUnit(unit: Omit<Unit, 'idx'>): number {
    const existing = this.db
      .prepare(`SELECT idx, row_id FROM message WHERE sessionId = ? AND kind = ? AND content = ? LIMIT 1`)
      .get(unit.sessionId, unit.kind, unit.content) as { idx: number; row_id: number } | undefined

    if (existing) {
      this.db
        .prepare(`UPDATE message SET in_context = ?, tags = ?, at = ? WHERE row_id = ?`)
        .run(unit.inContext === false ? 0 : 1, JSON.stringify(unit.tags ?? []), unit.at, existing.row_id)
      return existing.idx
    }

    const next = this.stmtNext.get(unit.sessionId) as { next: number }
    const idx = next.next
    this.stmtInsert.run(
      unit.sessionId,
      idx,
      unit.kind,
      unit.summary,
      unit.content,
      unit.at,
      unit.inContext === false ? 0 : 1,
      JSON.stringify(unit.tags ?? []),
    )
    const row = this.stmtFind.get(unit.sessionId, idx) as Row
    this.reindexFts(row)
    return idx
  }

  /**
   * 挂接 summary（总结完成后调用）。
   *
   * 编号不变；summary 参与 FTS。
   */
  setSummary(sessionId: string, idx: number, summary: string): boolean {
    const row = this.stmtFind.get(sessionId, idx) as Row | undefined
    if (!row) return false
    this.db.prepare(`UPDATE message SET summary = ? WHERE row_id = ?`).run(summary, row.row_id)
    const updated = { ...row, summary }
    this.reindexFts(updated)
    return true
  }

  /**
   * 重建一条单位的 FTS 记录。
   *
   * 收录规则：summary + content；但 thinking 的 content 只进向量不进 FTS
   * （既定决策：思考内容别索引，避免搜索命中过多）。
   */
  private reindexFts(row: Row): void {
    const parts: string[] = []
    if (row.summary.trim().length > 0) parts.push(row.summary)
    if (row.kind !== 'thinking') parts.push(row.content)
    const text = parts.join('\n').trim()
    this.stmtFtsDelete.run(row.row_id)
    if (text.length > 0) this.stmtFtsInsert.run(row.row_id, segmentForFts(text))
  }

  /** 标记某单位已离开上下文（编号保留）。 */
  markOutOfContext(sessionId: string, idx: number): void {
    this.db.prepare(`UPDATE message SET in_context = 0 WHERE sessionId = ? AND idx = ?`).run(sessionId, idx)
  }

  /** 追加便签（程序内部维护）。 */
  addTag(sessionId: string, idx: number, tag: string): void {
    const row = this.stmtFind.get(sessionId, idx) as Row | undefined
    if (!row) return
    const tags = parseTags(row.tags)
    if (tags.includes(tag)) return
    tags.push(tag)
    this.db.prepare(`UPDATE message SET tags = ? WHERE row_id = ?`).run(JSON.stringify(tags), row.row_id)
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /** 取一个单位（全量 content）。 */
  getUnit(sessionId: string, idx: number): UnitResult | undefined {
    const row = this.stmtFind.get(sessionId, idx) as Row | undefined
    return row ? toResult(row) : undefined
  }

  /** 按内部 row_id 取。 */
  getByRowId(rowId: number): UnitResult | undefined {
    const row = this.db.prepare(`SELECT * FROM message WHERE row_id = ?`).get(rowId) as Row | undefined
    return row ? toResult(row) : undefined
  }

  /** 某会话的编号范围。 */
  indexRange(sessionId: string): { min: number; max: number } | undefined {
    const row = this.db
      .prepare(`SELECT MIN(idx) AS lo, MAX(idx) AS hi FROM message WHERE sessionId = ?`)
      .get(sessionId) as { lo: number | null; hi: number | null }
    if (row.lo === null || row.hi === null) return undefined
    return { min: row.lo, max: row.hi }
  }

  /** 单位总数。 */
  count(sessionId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM message WHERE sessionId = ?`).get(sessionId) as { n: number }).n
  }

  /** 按编号区间列出（升序）。 */
  listRange(sessionId: string, fromIdx: number, toIdx: number): UnitResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM message WHERE sessionId = ? AND idx >= ? AND idx <= ? ORDER BY idx ASC`)
      .all(sessionId, fromIdx, toIdx) as Row[]
    return rows.map(toResult)
  }

  /** FTS 检索。 */
  searchFts(query: string, limit: number, sessionId?: string): KeywordHit[] {
    const rows = sessionId
      ? this.db.prepare(
          `SELECT m.row_id, m.sessionId, m.idx, m.kind, m.at, rank
           FROM message_fts JOIN message m ON m.row_id = message_fts.rowid
           WHERE message_fts MATCH ? AND m.sessionId = ? ORDER BY rank LIMIT ?`,
        ).all(query, sessionId, limit)
      : this.db.prepare(
          `SELECT m.row_id, m.sessionId, m.idx, m.kind, m.at, rank
           FROM message_fts JOIN message m ON m.row_id = message_fts.rowid
           WHERE message_fts MATCH ? ORDER BY rank LIMIT ?`,
        ).all(query, limit)
    return (rows as Array<{ row_id: number; sessionId: string; idx: number; kind: string; at: string; rank: number }>)
      .map(r => ({
        rowId: r.row_id,
        sessionId: r.sessionId,
        idx: r.idx,
        kind: r.kind as UnitKind,
        at: r.at,
        rank: r.rank,
      }))
  }

  // -------------------------------------------------------------------------
  // 元信息
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
      units: n(`SELECT COUNT(*) AS n FROM message`),
      inContext: n(`SELECT COUNT(*) AS n FROM message WHERE in_context = 1`),
      withSummary: n(`SELECT COUNT(*) AS n FROM message WHERE summary <> ''`),
      lastIndexedAt: this.getMeta('lastIndexedAt') ?? null,
    }
  }
}

/** 解析便签。 */
export function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(t => typeof t === 'string') : []
  } catch {
    return []
  }
}

function toResult(row: Row): UnitResult {
  return {
    rowId: row.row_id,
    sessionId: row.sessionId,
    idx: row.idx,
    kind: row.kind as UnitKind,
    summary: row.summary,
    content: row.content,
    at: row.at,
    inContext: row.in_context === 1,
    tags: parseTags(row.tags),
  }
}
