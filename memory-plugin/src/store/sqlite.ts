// SQLite 存储层（better-sqlite3，FTS5 内置）。
// schema.sql 是唯一权威建表语句；本模块只做读写与 FTS 维护。

import DatabaseConstructor from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  IndexStatus,
  MemoryRecord,
  ReasoningRecord,
  SessionWatermark,
} from '../types.js'
import type { KeywordHit } from '../search/keyword.js'
import { segmentForFts } from '../search/segment.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>
type SqliteStatement = import('better-sqlite3').Statement<unknown[], unknown>

/** 定位 schema.sql：优先源码目录，构建后在 dist/store/ */
function schemaPath(): string {
  // 本文件构建后在 dist/store/sqlite.js，schema.sql 同目录
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'schema.sql'), join(here, '../../src/store/schema.sql')]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('schema.sql not found next to store module')
}

export interface OpenOptions {
  /** :memory: 用于测试 */
  path?: string
}

/** 记录存储：records / reasoning / records_fts / watermarks / meta */
export class MemoryStore {
  private db: BetterSqlite3
  private dbPath: string
  private insertRecordStmt: SqliteStatement
  private insertFtsStmt: SqliteStatement
  private insertReasoningStmt: SqliteStatement
  private deleteFtsByRowidStmt: SqliteStatement
  private insertFtsMapStmt: SqliteStatement
  private getFtsMapStmt: SqliteStatement
  private deleteFtsMapStmt: SqliteStatement

  constructor(options: OpenOptions = {}) {
    this.dbPath = options.path ?? ':memory:'
    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true })
    }
    this.db = DatabaseConstructor(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
    // 预编译语句（写库热路径；better-sqlite3 的 prepare 开销在 8 万+ 记录时不可忽视）
    this.insertRecordStmt = this.db.prepare(
      `INSERT OR REPLACE INTO records (sessionId, seq, kind, at, turn, text, shadowed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    this.insertFtsStmt = this.db.prepare(
      `INSERT INTO records_fts (text, sessionId, seq, kind, at) VALUES (?, ?, ?, ?, ?)`,
    )
    this.insertReasoningStmt = this.db.prepare(
      `INSERT OR REPLACE INTO reasoning (sessionId, seq, at, turn, text) VALUES (?, ?, ?, ?, ?)`,
    )
    this.deleteFtsByRowidStmt = this.db.prepare(`DELETE FROM records_fts WHERE rowid = ?`)
    this.insertFtsMapStmt = this.db.prepare(
      `INSERT OR REPLACE INTO fts_map (sessionId, seq, kind, ftsRowid) VALUES (?, ?, ?, ?)`,
    )
    this.getFtsMapStmt = this.db.prepare(
      `SELECT ftsRowid FROM fts_map WHERE sessionId = ? AND seq = ? AND kind = ?`,
    )
    this.deleteFtsMapStmt = this.db.prepare(
      `DELETE FROM fts_map WHERE sessionId = ? AND seq = ? AND kind = ?`,
    )
  }

  /** 读 schema.sql 并执行（唯一权威） */
  private migrate(): void {
    const sql = readFileSync(schemaPath(), 'utf8')
    this.db.exec(sql)
  }

  close(): void {
    this.db.close()
  }

  /** 单条写入记录 + FTS（事务外由调用方包批） */
  insertRecord(record: MemoryRecord, shadowed: boolean): void {
    this.insertRecordStmt.run(
      record.sessionId,
      record.seq,
      record.kind,
      record.at,
      record.turn ?? null,
      record.text,
      shadowed ? 1 : 0,
    )
    this.insertFts(record)
  }

  // 预编译语句已在构造函数中初始化（见上）

  /**
   * FTS 索引维护（规格 §2.3：records_fts 只含可检索正文）。
   * 替换走 rowid 精确删除（fts_map 映射），绝不按 UNINDEXED 列 DELETE——
   * 那是 FTS 全表扫描，8 万+ 记录时 O(n²)（实测教训，见 schema.sql 注释）。
   */
  private insertFts(record: MemoryRecord): void {
    const existing = this.getFtsMapStmt.get(record.sessionId, record.seq, record.kind) as
      | { ftsRowid: number }
      | undefined
    if (existing) {
      this.deleteFtsByRowidStmt.run(existing.ftsRowid)
    }
    // CJK 预处理：汉字逐字分词（unicode61 局限的补偿，见 segment.ts）
    const info = this.insertFtsStmt.run(
      segmentForFts(record.text),
      record.sessionId,
      record.seq,
      record.kind,
      record.at,
    )
    this.insertFtsMapStmt.run(record.sessionId, record.seq, record.kind, Number(info.lastInsertRowid))
  }

  insertReasoning(record: ReasoningRecord): void {
    this.insertReasoningStmt.run(
      record.sessionId,
      record.seq,
      record.at,
      record.turn ?? null,
      record.text,
    )
  }

  /** 查询某 seq 当前是否被压缩遮蔽（决策③标记；以 records 表落库值为准） */
  isShadowed(sessionId: string, seq: number): boolean {
    const row = this.db
      .prepare(`SELECT shadowed FROM records WHERE sessionId = ? AND seq = ? LIMIT 1`)
      .get(sessionId, seq) as { shadowed: number } | undefined
    return row?.shadowed === 1
  }

  /** 批量写入（单事务，索引速度关键路径） */
  insertBatch(
    records: Array<{ record: MemoryRecord; shadowed: boolean }>,
    reasoning: ReasoningRecord[],
  ): void {
    const tx = this.db.transaction(() => {
      for (const { record, shadowed } of records) this.insertRecord(record, shadowed)
      for (const r of reasoning) this.insertReasoning(r)
    })
    tx()
  }

  /** 原生事务（indexer 对单会话整批落库用） */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /** 按 (sessionId, seq, kind) 取正文（向量回链用） */
  getRecord(sessionId: string, seq: number, kind: string): MemoryRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT sessionId, seq, kind, at, turn, text, shadowed FROM records
         WHERE sessionId = ? AND seq = ? AND kind = ?`,
      )
      .get(sessionId, seq, kind) as
      | { sessionId: string; seq: number; kind: string; at: string; turn: number | null; text: string; shadowed: number }
      | undefined
    if (!row) return undefined
    return {
      sessionId: row.sessionId,
      seq: row.seq,
      kind: row.kind as MemoryRecord['kind'],
      at: row.at,
      turn: row.turn ?? undefined,
      text: row.text,
    }
  }

  /** FTS 关键词查询（keyword.ts 的落地） */
  searchFts(query: string, limit: number, orderByTime: boolean): KeywordHit[] {
    const order = orderByTime ? 'at DESC, rowid DESC' : 'rank'
    const stmt = this.db.prepare(
      `SELECT sessionId, seq, kind, at, rank FROM records_fts
       WHERE records_fts MATCH ?
       ORDER BY ${order}
       LIMIT ?`,
    )
    const rows = stmt.all(query, limit) as Array<{
      sessionId: string
      seq: number
      kind: string
      at: string
      rank: number
    }>
    return rows.map((row) => ({
      sessionId: row.sessionId,
      seq: row.seq,
      kind: row.kind as MemoryRecord['kind'],
      at: row.at,
      rank: row.rank,
    }))
  }

  /** FTS snippet（±80 字上下文）；分词索引文本去空格还原汉字序后返回 */
  snippet(sessionId: string, seq: number, kind: string, query: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT snippet(records_fts, 0, '[', ']', '…', 24) AS s
         FROM records_fts
         WHERE records_fts MATCH ? AND sessionId = ? AND seq = ? AND kind = ?`,
      )
      .get(query, sessionId, seq, kind) as { s: string } | undefined
    if (!row) return undefined
    // CJK 逐字分词引入的空格去掉，还接近原文；latin 词间空格保留
    return row.s.replace(/([\u4e00-\u9fff\u3400-\u4dbf]) (?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
  }

  /** reasoning 全量取（向量检索回链用） */
  getReasoning(sessionId: string, seq: number): ReasoningRecord | undefined {
    const row = this.db
      .prepare(`SELECT sessionId, seq, at, turn, text FROM reasoning WHERE sessionId = ? AND seq = ?`)
      .get(sessionId, seq) as
      | { sessionId: string; seq: number; at: string; turn: number | null; text: string }
      | undefined
    if (!row) return undefined
    return {
      sessionId: row.sessionId,
      seq: row.seq,
      at: row.at,
      turn: row.turn ?? undefined,
      text: row.text,
    }
  }

  /** reasoning 按 sessionId 过滤列出（HTTP API 用） */
  listReasoning(sessionId?: string, limit = 100): ReasoningRecord[] {
    const rows = (
      sessionId
        ? this.db
            .prepare(`SELECT sessionId, seq, at, turn, text FROM reasoning WHERE sessionId = ? ORDER BY seq DESC LIMIT ?`)
            .all(sessionId, limit)
        : this.db
            .prepare(`SELECT sessionId, seq, at, turn, text FROM reasoning ORDER BY seq DESC LIMIT ?`)
            .all(limit)
    ) as Array<{ sessionId: string; seq: number; at: string; turn: number | null; text: string }>
    return rows.map((row) => ({
      sessionId: row.sessionId,
      seq: row.seq,
      at: row.at,
      turn: row.turn ?? undefined,
      text: row.text,
    }))
  }

  /** 分页列表（HTTP API /records 用） */
  listRecords(opts: {
    sessionId?: string
    kind?: string
    q?: string
    shadowed?: boolean
    limit?: number
    offset?: number
  }): Array<MemoryRecord & { shadowed: boolean }> {
    const where: string[] = []
    const params: unknown[] = []
    if (opts.sessionId) {
      where.push('sessionId = ?')
      params.push(opts.sessionId)
    }
    if (opts.kind) {
      where.push('kind = ?')
      params.push(opts.kind)
    }
    if (opts.shadowed !== undefined) {
      where.push('shadowed = ?')
      params.push(opts.shadowed ? 1 : 0)
    }
    if (opts.q) {
      where.push('text LIKE ?')
      params.push(`%${opts.q}%`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT sessionId, seq, kind, at, turn, text, shadowed FROM records
         ${whereSql} ORDER BY sessionId, seq LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit ?? 50, opts.offset ?? 0) as Array<{
      sessionId: string
      seq: number
      kind: string
      at: string
      turn: number | null
      text: string
      shadowed: number
    }>
    return rows.map((row) => ({
      sessionId: row.sessionId,
      seq: row.seq,
      kind: row.kind as MemoryRecord['kind'],
      at: row.at,
      turn: row.turn ?? undefined,
      text: row.text,
      shadowed: row.shadowed === 1,
    }))
  }

  /** 会话水位线（增量索引） */
  getWatermark(sessionId: string): SessionWatermark | undefined {
    const row = this.db
      .prepare(`SELECT sessionId, lastSeq, indexedAt, eventCount FROM watermarks WHERE sessionId = ?`)
      .get(sessionId) as SessionWatermark | undefined
    return row
  }

  setWatermark(watermark: SessionWatermark): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO watermarks (sessionId, lastSeq, indexedAt, eventCount) VALUES (?, ?, ?, ?)`,
      )
      .run(watermark.sessionId, watermark.lastSeq, watermark.indexedAt, watermark.eventCount)
  }

  listWatermarks(): SessionWatermark[] {
    return this.db
      .prepare(`SELECT sessionId, lastSeq, indexedAt, eventCount FROM watermarks ORDER BY sessionId`)
      .all() as SessionWatermark[]
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value)
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  /** 各表计数（status 用） */
  counts(): {
    sessions: number
    records: number
    reasoning: number
    summaries: number
    shadowed: number
  } {
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number }
      return row.n
    }
    return {
      sessions: count(`SELECT COUNT(DISTINCT sessionId) AS n FROM records`),
      records: count(`SELECT COUNT(*) AS n FROM records`),
      reasoning: count(`SELECT COUNT(*) AS n FROM reasoning`),
      summaries: count(`SELECT COUNT(*) AS n FROM records WHERE kind = 'summary'`),
      shadowed: count(`SELECT COUNT(*) AS n FROM records WHERE shadowed = 1`),
    }
  }

  lastIndexedAt(): string | null {
    return this.getMeta('lastIndexedAt') ?? null
  }

  status(vectors: number): IndexStatus {
    const counts = this.counts()
    return {
      ...counts,
      vectors,
      lastIndexedAt: this.lastIndexedAt(),
      watermarks: this.listWatermarks(),
    }
  }
}
