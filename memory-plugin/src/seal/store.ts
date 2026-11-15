// 封存段的持久化存储。
//
// 用独立表存 SealedSegment，不改动现有 records/reasoning 表的结构。
// 这层是「模型自总结替换」的记忆本体：即使上下文被压缩，总结永远在。

import type DatabaseConstructor from 'better-sqlite3'
import type { SealedSegment } from './types.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** 封存段表的建表语句（幂等）。 */
const CREATE_SEALED = `
CREATE TABLE IF NOT EXISTS sealed_segment (
  id         TEXT PRIMARY KEY,
  sessionId  TEXT NOT NULL,
  fromSeq    INTEGER NOT NULL,
  toSeq      INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sealed_session ON sealed_segment(sessionId, turn);
`

/** 一条已封存段的存储行。 */
interface SealedRow {
  id: string
  sessionId: string
  fromSeq: number
  toSeq: number
  summary: string
  reason: string
  turn: number
  at: string
}

/**
 * 封存段的仓储：只增不改（符合「只追加」原则）。
 *
 * 同一 sessionId + 区间重复封存会被拒绝——封存是破坏性操作，
 * 不能因为重试或并发而二次遮蔽同一段历史。
 */
export class SealStore {
  constructor(private readonly db: BetterSqlite3) {
    this.db.exec(CREATE_SEALED)
  }

  /** 该会话已封存的所有段，按 turn 升序。 */
  list(sessionId: string): SealedSegment[] {
    const rows = this.db
      .prepare('SELECT * FROM sealed_segment WHERE sessionId = ? ORDER BY turn ASC, fromSeq ASC')
      .all(sessionId) as SealedRow[]
    return rows.map(toSegment)
  }

  /** 按 id 取一段。 */
  get(id: string): SealedSegment | undefined {
    const row = this.db.prepare('SELECT * FROM sealed_segment WHERE id = ?').get(id) as SealedRow | undefined
    return row ? toSegment(row) : undefined
  }

  /** 找一个与给定区间重叠的已封存段（用于防重复封存）。 */
  findOverlapping(sessionId: string, fromSeq: number, toSeq: number): SealedSegment | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM sealed_segment
         WHERE sessionId = ? AND NOT (toSeq < ? OR fromSeq > ?)
         LIMIT 1`,
      )
      .get(sessionId, fromSeq, toSeq) as SealedRow | undefined
    return row ? toSegment(row) : undefined
  }

  /** 插入一段。区间重叠时抛出——调用方应先 `findOverlapping` 检查。 */
  insert(segment: SealedSegment): void {
    this.db
      .prepare(
        `INSERT INTO sealed_segment (id, sessionId, fromSeq, toSeq, summary, reason, turn, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        segment.id,
        segment.sessionId,
        segment.fromSeq,
        segment.toSeq,
        segment.summary,
        segment.reason,
        segment.turn,
        segment.at,
      )
  }

  /** 该会话最近一次封存的 turn；没有则 undefined。 */
  lastSealedTurn(sessionId: string): number | undefined {
    const row = this.db
      .prepare('SELECT MAX(turn) AS t FROM sealed_segment WHERE sessionId = ?')
      .get(sessionId) as { t: number | null } | undefined
    return row?.t ?? undefined
  }

  /** 统计（用于健康检查与验收）。 */
  stats(sessionId?: string): { count: number; sessions: number } {
    if (sessionId !== undefined) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM sealed_segment WHERE sessionId = ?').get(sessionId) as { c: number }
      return { count: row.c, sessions: 1 }
    }
    const row = this.db.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT sessionId) AS s FROM sealed_segment').get() as { c: number; s: number }
    return { count: row.c, sessions: row.s }
  }
}

function toSegment(row: SealedRow): SealedSegment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    fromSeq: row.fromSeq,
    toSeq: row.toSeq,
    summary: row.summary,
    reason: row.reason,
    turn: row.turn,
    at: row.at,
  }
}
