// 封存段的持久化。
//
// 编号规则与 event 表一致：**段编号在会话内独立递增**，
// 唯一定位一段需要 (sessionId, event_no)。

import type DatabaseConstructor from 'better-sqlite3'
import type { Segment, SegmentStage } from './types.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** 建表（幂等）。 */
const CREATE_SEGMENT = `
CREATE TABLE IF NOT EXISTS segment (
  row_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_no      INTEGER NOT NULL,
  sessionId     TEXT    NOT NULL,
  fromSeq       INTEGER NOT NULL,
  toSeq         INTEGER NOT NULL,
  shadowedSeqs  TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  recent        TEXT    NOT NULL DEFAULT '',
  stage         TEXT    NOT NULL DEFAULT 'live',
  turn          INTEGER NOT NULL,
  at            TEXT    NOT NULL,
  UNIQUE (sessionId, event_no)
);
CREATE INDEX IF NOT EXISTS idx_segment_session ON segment(sessionId, event_no);
`

/** segment 表的一行。 */
interface SegmentRow {
  row_id: number
  event_no: number
  sessionId: string
  fromSeq: number
  toSeq: number
  shadowedSeqs: string
  summary: string
  recent: string
  stage: string
  turn: number
  at: string
}

/**
 * 封存段仓储：只增不改（除阶段降级）。
 *
 * 同一个会话内的段编号从 1 开始递增，与事件的编号体系保持一致。
 */
export class SegmentStore {
  constructor(private readonly db: BetterSqlite3) {
    this.db.exec(CREATE_SEGMENT)
  }

  /** 该会话下一个段编号。 */
  nextEventNo(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT IFNULL(MAX(event_no), 0) + 1 AS next FROM segment WHERE sessionId = ?`)
      .get(sessionId) as { next: number }
    return row.next
  }

  /** 插入一段，返回分配到的编号。 */
  insert(segment: Omit<Segment, 'eventNo'>): number {
    const eventNo = this.nextEventNo(segment.sessionId)
    this.db
      .prepare(
        `INSERT INTO segment
           (event_no, sessionId, fromSeq, toSeq, shadowedSeqs, summary, recent, stage, turn, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventNo,
        segment.sessionId,
        segment.fromSeq,
        segment.toSeq,
        JSON.stringify(segment.shadowedSeqs),
        segment.summary,
        segment.recent,
        segment.stage,
        segment.turn,
        segment.at,
      )
    return eventNo
  }

  /** 按 (sessionId, eventNo) 取一段。 */
  get(sessionId: string, eventNo: number): Segment | undefined {
    const row = this.db
      .prepare(`SELECT * FROM segment WHERE sessionId = ? AND event_no = ?`)
      .get(sessionId, eventNo) as SegmentRow | undefined
    return row ? toSegment(row) : undefined
  }

  /** 该会话的全部段，按编号升序。 */
  list(sessionId: string): Segment[] {
    const rows = this.db
      .prepare(`SELECT * FROM segment WHERE sessionId = ? ORDER BY event_no ASC`)
      .all(sessionId) as SegmentRow[]
    return rows.map(toSegment)
  }

  /** 找到与给定 seq 区间重叠的段（防重复封存）。 */
  findOverlapping(sessionId: string, fromSeq: number, toSeq: number): Segment | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM segment
         WHERE sessionId = ? AND NOT (toSeq < ? OR fromSeq > ?)
         LIMIT 1`,
      )
      .get(sessionId, fromSeq, toSeq) as SegmentRow | undefined
    return row ? toSegment(row) : undefined
  }

  /**
   * 把段降级为 archived：清空 recent，只保留 summary。
   *
   * 这是「近期 → 更早」的唯一状态转换。编号不变，内容变少。
   */
  archive(sessionId: string, eventNo: number): boolean {
    const info = this.db
      .prepare(`UPDATE segment SET stage = 'archived', recent = '' WHERE sessionId = ? AND event_no = ?`)
      .run(sessionId, eventNo)
    return info.changes > 0
  }

  /** 该会话处于 live 阶段的段（原文与总结并存）。 */
  listLive(sessionId: string): Segment[] {
    const rows = this.db
      .prepare(`SELECT * FROM segment WHERE sessionId = ? AND stage = 'live' ORDER BY event_no ASC`)
      .all(sessionId) as SegmentRow[]
    return rows.map(toSegment)
  }

  /** 统计。 */
  stats(sessionId?: string): { total: number; live: number; sessions: number } {
    if (sessionId !== undefined) {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS t, SUM(stage = 'live') AS l FROM segment WHERE sessionId = ?`)
        .get(sessionId) as { t: number; l: number | null }
      return { total: row.t, live: row.l ?? 0, sessions: 1 }
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS t, SUM(stage = 'live') AS l, COUNT(DISTINCT sessionId) AS s FROM segment`)
      .get() as { t: number; l: number | null; s: number }
    return { total: row.t, live: row.l ?? 0, sessions: row.s }
  }
}

/** SegmentRow → Segment */
function toSegment(row: SegmentRow): Segment {
  return {
    eventNo: row.event_no,
    sessionId: row.sessionId,
    fromSeq: row.fromSeq,
    toSeq: row.toSeq,
    shadowedSeqs: parseSeqArray(row.shadowedSeqs),
    summary: row.summary,
    recent: row.recent,
    stage: row.stage as SegmentStage,
    turn: row.turn,
    at: row.at,
  }
}

/** 安全解析 seq 数组。 */
function parseSeqArray(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(n => typeof n === 'number') : []
  } catch {
    return []
  }
}
