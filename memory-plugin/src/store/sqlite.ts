// SQLite 存储层。
//
// 核心约定（见 schema.sql）：
//   * **每个事件都有自己的编号 `event_no`，且编号在每个会话内独立递增**（从 1 开始）。
//     会话 A 的 #1 与会话 B 的 #1 是不同事件；唯一定位需要 (sessionId, event_no)。
//   * 消息 / 工具调用 / 工具结果 / 思考 / 压缩摘要——每条都占一个 event_no。
//   * 内部行号 `row_id` 只给 FTS 当 rowid 用，不对外暴露。

import DatabaseConstructor from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  EventKind,
  EventRecord,
  EventSearchResult,
  IndexStatus,
  KeywordHit,
  SessionWatermark,
} from '../types.js'
import { segmentForFts } from '../search/segment.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>
type SqliteStatement = import('better-sqlite3').Statement<unknown[], unknown>

/** 定位 schema.sql：优先源码目录，构建后在 dist/store/ */
function schemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'schema.sql'),
    join(here, '..', '..', 'src', 'store', 'schema.sql'),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  throw new Error(`schema.sql not found near ${here}`)
}

/** 打开选项。 */
export interface OpenOptions {
  /** :memory: 用于测试 */
  path?: string
}

/** event 表联查正文后的行。 */
interface EventRow {
  row_id: number
  event_no: number
  sessionId: string
  seq: number
  kind: string
  at: string
  turn: number | null
  shadowed: number
  text: string | null
}

/** 记录存储：event / event_text / event_fts / seal / watermark / meta */
export class MemoryStore {
  private readonly db: BetterSqlite3
  private readonly dbPath: string

  private readonly stmtUpsertEvent: SqliteStatement
  private readonly stmtFindEvent: SqliteStatement
  private readonly stmtNextEventNo: SqliteStatement
  private readonly stmtUpsertText: SqliteStatement
  private readonly stmtInsertFts: SqliteStatement
  private readonly stmtDeleteFts: SqliteStatement

  constructor(options: OpenOptions = {}) {
    this.dbPath = options.path ?? ':memory:'
    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true })
    }
    this.db = DatabaseConstructor(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()

    // 幂等写入：同一 (sessionId, seq, kind) 更新内容，event_no 保持不变。
    this.stmtUpsertEvent = this.db.prepare(
      `INSERT INTO event (event_no, sessionId, seq, kind, at, turn, shadowed)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sessionId, seq, kind) DO UPDATE SET
         at = excluded.at, turn = excluded.turn, shadowed = excluded.shadowed`,
    )
    // 按自然键查已有行的内部 id 与会话内编号
    this.stmtFindEvent = this.db.prepare(
      `SELECT row_id, event_no FROM event WHERE sessionId = ? AND seq = ? AND kind = ?`,
    )
    // 该会话下一个可用的 event_no（会话内独立递增）
    this.stmtNextEventNo = this.db.prepare(
      `SELECT IFNULL(MAX(event_no), 0) + 1 AS next FROM event WHERE sessionId = ?`,
    )
    this.stmtUpsertText = this.db.prepare(
      `INSERT INTO event_text (row_id, text) VALUES (?, ?)
       ON CONFLICT (row_id) DO UPDATE SET text = excluded.text`,
    )
    this.stmtInsertFts = this.db.prepare(`INSERT INTO event_fts (rowid, text) VALUES (?, ?)`)
    this.stmtDeleteFts = this.db.prepare(`DELETE FROM event_fts WHERE rowid = ?`)
  }

  /** 读 schema.sql 并执行（唯一权威） */
  private migrate(): void {
    this.db.exec(readFileSync(schemaPath(), 'utf8'))
  }

  close(): void {
    this.db.close()
  }

  /** 暴露底层连接，供同库的 seal 表复用。 */
  get raw(): ReturnType<typeof DatabaseConstructor> {
    return this.db
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /**
   * 写入一个事件，返回它在**本会话内**的编号。
   *
   * 编号规则：会话内从 1 开始递增，与该会话已有的事件数一致。
   * 已存在（同 sessionId+seq+kind）则复用原编号，不新增。
   *
   * @param event - 事件内容（eventNo 字段忽略）。
   * @param shadowed - 是否已被压缩遮蔽。
   * @returns 该事件在会话内的编号。
   */
  insertEvent(event: EventRecord, shadowed: boolean): number {
    // 先查是否已存在（幂等路径）
    const existing = this.stmtFindEvent.get(event.sessionId, event.seq, event.kind) as
      | { row_id: number; event_no: number }
      | undefined

    let rowId: number
    let eventNo: number

    if (existing) {
      eventNo = existing.event_no
      rowId = existing.row_id
      this.stmtUpsertEvent.run(
        eventNo,
        event.sessionId,
        event.seq,
        event.kind,
        event.at,
        event.turn ?? null,
        shadowed ? 1 : 0,
      )
    } else {
      const next = this.stmtNextEventNo.get(event.sessionId) as { next: number }
      eventNo = next.next
      this.stmtUpsertEvent.run(
        eventNo,
        event.sessionId,
        event.seq,
        event.kind,
        event.at,
        event.turn ?? null,
        shadowed ? 1 : 0,
      )
      const row = this.stmtFindEvent.get(event.sessionId, event.seq, event.kind) as
        | { row_id: number; event_no: number }
        | undefined
      if (!row) throw new Error('event insert did not yield a row_id')
      rowId = row.row_id
    }

    // 正文：所有事件都有
    this.stmtUpsertText.run(rowId, event.text)

    // FTS：思考不进关键词索引（决策①）
    this.stmtDeleteFts.run(rowId)
    if (event.kind !== 'reasoning') {
      this.stmtInsertFts.run(rowId, segmentForFts(event.text))
    }
    return eventNo
  }

  /** 批量写入（单事务）。 */
  insertBatch(events: Array<{ event: EventRecord; shadowed: boolean }>): number[] {
    const tx = this.db.transaction((rows: Array<{ event: EventRecord; shadowed: boolean }>) =>
      rows.map(({ event, shadowed }) => this.insertEvent(event, shadowed)),
    )
    return tx(events)
  }

  /** 兼容旧名：写入一条事件。 */
  insertRecord(event: EventRecord, shadowed: boolean): number {
    return this.insertEvent(event, shadowed)
  }

  /** 兼容旧名：写入一条思考事件（自动补 kind='reasoning'）。 */
  insertReasoning(event: Omit<EventRecord, 'kind'> & { kind?: EventKind }): number {
    return this.insertEvent({ ...event, kind: 'reasoning' }, false)
  }

  /** 原生事务 */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /** 按 (sessionId, event_no) 取事件——这是事件的唯一标识。 */
  getEvent(sessionId: string, eventNo: number): EventSearchResult | undefined {
    const row = this.db
      .prepare(
        `SELECT e.*, t.text FROM event e LEFT JOIN event_text t ON t.row_id = e.row_id
         WHERE e.sessionId = ? AND e.event_no = ?`,
      )
      .get(sessionId, eventNo) as EventRow | undefined
    return row ? toResult(row) : undefined
  }

  /** 按 dsh 的自然键取事件。 */
  getEventBySeq(sessionId: string, seq: number, kind: string): EventSearchResult | undefined {
    const row = this.db
      .prepare(
        `SELECT e.*, t.text FROM event e LEFT JOIN event_text t ON t.row_id = e.row_id
         WHERE e.sessionId = ? AND e.seq = ? AND e.kind = ?`,
      )
      .get(sessionId, seq, kind) as EventRow | undefined
    return row ? toResult(row) : undefined
  }

  /** 兼容旧名。 */
  getRecord(sessionId: string, seq: number, kind: string): EventSearchResult | undefined {
    return this.getEventBySeq(sessionId, seq, kind)
  }

  /** 兼容旧名：按内部 row_id 取（FTS 回链用）。 */
  getRecordByRowId(rowId: number): EventSearchResult | undefined {
    const row = this.db
      .prepare(
        `SELECT e.*, t.text FROM event e LEFT JOIN event_text t ON t.row_id = e.row_id
         WHERE e.row_id = ?`,
      )
      .get(rowId) as EventRow | undefined
    return row ? toResult(row) : undefined
  }

  /** 兼容旧名：取思考事件。 */
  getReasoning(sessionId: string, seq: number): EventSearchResult | undefined {
    return this.getEventBySeq(sessionId, seq, 'reasoning')
  }

  /** 某条事件当前是否被压缩遮蔽。 */
  isShadowed(sessionId: string, seq: number): boolean {
    const row = this.db
      .prepare(`SELECT shadowed FROM event WHERE sessionId = ? AND seq = ? LIMIT 1`)
      .get(sessionId, seq) as { shadowed: number } | undefined
    return row?.shadowed === 1
  }

  /** 某会话的全部事件编号（升序）。 */
  listEventNos(sessionId: string): number[] {
    return (this.db
      .prepare(`SELECT event_no FROM event WHERE sessionId = ? ORDER BY event_no ASC`)
      .all(sessionId) as Array<{ event_no: number }>).map(r => r.event_no)
  }

  /** FTS 关键词查询。 */
  searchFts(query: string, limit: number, orderByTime: boolean): KeywordHit[] {
    const order = orderByTime ? 'e.at DESC, e.event_no DESC' : 'rank'
    const rows = this.db
      .prepare(
        `SELECT e.row_id, e.event_no, e.sessionId, e.seq, e.kind, e.at, rank
         FROM event_fts
         JOIN event e ON e.row_id = event_fts.rowid
         WHERE event_fts MATCH ?
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(query, limit) as Array<{
        row_id: number
        event_no: number
        sessionId: string
        seq: number
        kind: string
        at: string
        rank: number
      }>
    return rows.map(row => ({
      rowId: row.row_id,
      eventNo: row.event_no,
      sessionId: row.sessionId,
      seq: row.seq,
      kind: row.kind as EventKind,
      at: row.at,
      rank: row.rank,
    }))
  }

  /** FTS snippet；分词索引文本去空格还原汉字序后返回。 */
  snippet(rowId: number, query: string): string | undefined {
    const row = this.db
      .prepare(`SELECT snippet(event_fts, 0, '[', ']', '…', 24) AS s FROM event_fts WHERE event_fts MATCH ? AND rowid = ?`)
      .get(query, rowId) as { s: string } | undefined
    if (!row) return undefined
    return row.s.replace(/([\u4e00-\u9fff\u3400-\u4dbf]) (?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
  }

  /** 列出事件（HTTP API 用）。 */
  listEvents(sessionId: string | undefined, kind: string | undefined, limit: number, offset: number): EventSearchResult[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (sessionId) { clauses.push('e.sessionId = ?'); params.push(sessionId) }
    if (kind) { clauses.push('e.kind = ?'); params.push(kind) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT e.*, t.text FROM event e LEFT JOIN event_text t ON t.row_id = e.row_id
         ${where} ORDER BY e.sessionId ASC, e.event_no ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as EventRow[]
    return rows.map(toResult)
  }

  /** 兼容旧名。 */
  listRecords(sessionId: string | undefined, kind: string | undefined, limit: number, offset: number): EventSearchResult[] {
    return this.listEvents(sessionId, kind, limit, offset)
  }

  /** 列出思考事件。 */
  listReasoning(sessionId: string | undefined, limit: number): EventSearchResult[] {
    return this.listEvents(sessionId, 'reasoning', limit, 0)
  }

  // -------------------------------------------------------------------------
  // 水位线 / 元信息 / 统计
  // -------------------------------------------------------------------------

  getWatermark(sessionId: string): SessionWatermark | undefined {
    const row = this.db
      .prepare(`SELECT sessionId, lastSeq, indexedAt, eventCount FROM watermark WHERE sessionId = ?`)
      .get(sessionId) as SessionWatermark | undefined
    return row ? { ...row } : undefined
  }

  setWatermark(w: SessionWatermark): void {
    this.db
      .prepare(
        `INSERT INTO watermark (sessionId, lastSeq, last_event_no, indexedAt, eventCount)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sessionId) DO UPDATE SET
           lastSeq = excluded.lastSeq, last_event_no = excluded.last_event_no,
           indexedAt = excluded.indexedAt, eventCount = excluded.eventCount`,
      )
      .run(w.sessionId, w.lastSeq, 0, w.indexedAt, w.eventCount)
  }

  listWatermarks(): SessionWatermark[] {
    return this.db
      .prepare(`SELECT sessionId, lastSeq, indexedAt, eventCount FROM watermark ORDER BY sessionId`)
      .all() as SessionWatermark[]
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(key, value)
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined
    return row?.value
  }

  /** 索引状态（status 命令用）。 */
  status(): IndexStatus {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n
    return {
      sessions: count(`SELECT COUNT(DISTINCT sessionId) AS n FROM event`),
      events: count(`SELECT COUNT(*) AS n FROM event`),
      reasoning: count(`SELECT COUNT(*) AS n FROM event WHERE kind = 'reasoning'`),
      summaries: count(`SELECT COUNT(*) AS n FROM event WHERE kind = 'summary'`),
      shadowed: count(`SELECT COUNT(*) AS n FROM event WHERE shadowed = 1`),
      sealed: count(`SELECT COUNT(*) AS n FROM seal`),
      lastIndexedAt: this.getMeta('lastIndexedAt') ?? null,
    }
  }
}

/** EventRow → EventSearchResult */
function toResult(row: EventRow): EventSearchResult {
  return {
    rowId: row.row_id,
    eventNo: row.event_no,
    sessionId: row.sessionId,
    seq: row.seq,
    kind: row.kind as EventKind,
    at: row.at,
    turn: row.turn ?? undefined,
    text: row.text ?? '',
    shadowed: row.shadowed === 1,
  }
}
