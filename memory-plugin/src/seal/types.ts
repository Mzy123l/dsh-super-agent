// 提炼段：把一段历史换成一条带槽位的消息。
//
// 用户要求「近几步全量 + 总结」——所以段的内容按阶段变化：
//   live      <recent-slot> 原文 </recent-slot> + <summary-slot> 总结 </summary-slot>
//   archived  <summary-slot> 总结 </summary-slot>
//
// 段的覆盖范围用**索引区间**（from_idx … to_idx），不是 seq。
// 索引是会话内线性的，所以区间是连续的，不会漏。

import type DatabaseConstructor from 'better-sqlite3'
import type { Segment } from '../types.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** 槽位标签。 */
export const SLOT_TAGS = {
  recent: 'recent-slot',
  summary: 'summary-slot',
} as const

/** 槽位种类。 */
export type SlotKind = keyof typeof SLOT_TAGS

/** 一个槽位。 */
export interface Slot {
  readonly kind: SlotKind
  readonly text: string
}

/**
 * 把槽位拼成一条正文。
 *
 * 空槽跳过；全空抛错（不允许产出空段）。
 */
export function composeSlottedText(slots: readonly Slot[]): string {
  const used = slots.filter(s => s.text.trim().length > 0)
  if (used.length === 0) throw new Error('composeSlottedText requires at least one non-empty slot')
  return used.map(({ kind, text }) => `<${SLOT_TAGS[kind]}>\n${text}\n</${SLOT_TAGS[kind]}>`).join('\n\n')
}

/** 是否已是带槽位的合并体。 */
export function isSlottedText(text: string): boolean {
  return text.includes(`<${SLOT_TAGS.recent}>`) || text.includes(`<${SLOT_TAGS.summary}>`)
}

/** 长度阈值：≤keep 保持原文；≥summarize 应提炼。 */
export const KEEP_ORIGINAL_THRESHOLD_CHARS = 1200
export const SUMMARIZE_THRESHOLD_CHARS = 4000

/** 提炼决策。 */
export type SummarizeDecision =
  | { kind: 'keep-original'; reason: string }
  | { kind: 'optional'; reason: string }
  | { kind: 'should-summarize'; reason: string }

/** 按字符数给出决策。 */
export function decideSummarize(
  chars: number,
  thresholds: { keep?: number; summarize?: number } = {},
): SummarizeDecision {
  const keep = thresholds.keep ?? KEEP_ORIGINAL_THRESHOLD_CHARS
  const sum = thresholds.summarize ?? SUMMARIZE_THRESHOLD_CHARS
  if (chars <= keep) return { kind: 'keep-original', reason: `${chars} ≤ ${keep}：原文够短，直接保留` }
  if (chars >= sum) return { kind: 'should-summarize', reason: `${chars} ≥ ${sum}：内容较长，应提炼` }
  return { kind: 'optional', reason: `${chars} 介于 ${keep}–${sum}：由循环决定` }
}

/**
 * 构造「请提炼」的提示。
 *
 * 关键要求：这是提炼，不是压缩——必须保留否决路径。
 */
export function buildSummarizePrompt(chars: number, fromIdx: number, toIdx: number): string {
  return [
    `请提炼下面这段内容的**有效信息**，丢弃噪音。`,
    ``,
    `这不是压缩，是提炼。区别在于：`,
    `- 压缩会把一大段变成"最终方案：X"`,
    `- 提炼必须保留**否决路径**：哪些方案被否定了、为什么被否定`,
    ``,
    `期望的形态：`,
    `  否决方案 A：因为 <具体原因>`,
    `  否决方案 B：因为 <具体原因>`,
    `  ...`,
    `  最终方案：<结论>`,
    ``,
    `要求：`,
    `1. 每一处否决都要保留理由`,
    `2. 保留具体的事实性细节（文件路径、数值、错误信息）`,
    `3. 不要保留过程性的试错（同样的错误重复 N 次只写一次）`,
    `4. 总长度控制在原文的 10%–20%`,
    ``,
    `待提炼内容：#${fromIdx} 至 #${toIdx}，共约 ${chars} 字符。`,
  ].join('\n')
}

/** 段仓储。 */
export class SegmentStore {
  constructor(private readonly db: BetterSqlite3) {}

  /** 插入一段，返回段号。 */
  insert(seg: Omit<Segment, 'segmentNo'>): number {
    const info = this.db
      .prepare(
        `INSERT INTO segment (sessionId, from_idx, to_idx, summary, recent, stage, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(seg.sessionId, seg.fromIdx, seg.toIdx, seg.summary, seg.recent, seg.stage, seg.at)
    return Number(info.lastInsertRowid)
  }

  /** 按段号取。 */
  get(segmentNo: number): Segment | undefined {
    const row = this.db.prepare(`SELECT * FROM segment WHERE segment_no = ?`).get(segmentNo) as SegmentRow | undefined
    return row ? toSegment(row) : undefined
  }

  /** 该会话的全部段（按 from_idx 升序）。 */
  list(sessionId: string): Segment[] {
    const rows = this.db
      .prepare(`SELECT * FROM segment WHERE sessionId = ? ORDER BY from_idx ASC`)
      .all(sessionId) as SegmentRow[]
    return rows.map(toSegment)
  }

  /** live 阶段的段。 */
  listLive(sessionId: string): Segment[] {
    const rows = this.db
      .prepare(`SELECT * FROM segment WHERE sessionId = ? AND stage = 'live' ORDER BY from_idx ASC`)
      .all(sessionId) as SegmentRow[]
    return rows.map(toSegment)
  }

  /** 找与给定 idx 区间重叠的段。 */
  findOverlapping(sessionId: string, fromIdx: number, toIdx: number): Segment | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM segment WHERE sessionId = ? AND NOT (to_idx < ? OR from_idx > ?) LIMIT 1`,
      )
      .get(sessionId, fromIdx, toIdx) as SegmentRow | undefined
    return row ? toSegment(row) : undefined
  }

  /** 已被段覆盖的 idx 集合。 */
  coveredIdxs(sessionId: string): Set<number> {
    const covered = new Set<number>()
    for (const seg of this.list(sessionId)) {
      for (let i = seg.fromIdx; i <= seg.toIdx; i += 1) covered.add(i)
    }
    return covered
  }

  /** 降级为 archived（清空 recent，保留 summary）。 */
  archive(segmentNo: number): boolean {
    return this.db.prepare(`UPDATE segment SET stage = 'archived', recent = '' WHERE segment_no = ?`).run(segmentNo).changes > 0
  }

  /** 统计。 */
  stats(sessionId?: string): { total: number; live: number } {
    const row = sessionId
      ? this.db.prepare(`SELECT COUNT(*) AS t, SUM(stage='live') AS l FROM segment WHERE sessionId = ?`).get(sessionId) as { t: number; l: number | null }
      : this.db.prepare(`SELECT COUNT(*) AS t, SUM(stage='live') AS l FROM segment`).get() as { t: number; l: number | null }
    return { total: row.t, live: row.l ?? 0 }
  }
}

interface SegmentRow {
  segment_no: number
  sessionId: string
  from_idx: number
  to_idx: number
  summary: string
  recent: string
  stage: string
  at: string
}

function toSegment(row: SegmentRow): Segment {
  return {
    segmentNo: row.segment_no,
    sessionId: row.sessionId,
    fromIdx: row.from_idx,
    toIdx: row.to_idx,
    summary: row.summary,
    recent: row.recent,
    stage: row.stage === 'live' ? 'live' : 'archived',
    at: row.at,
  }
}
