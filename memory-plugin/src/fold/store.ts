// 折叠（L2）：按任务边界把一段连续单位收成一条可展开的摘要。
//
// 设计见 docs/A7-memory-design-final.md §5。
//
// 关键约束：
//   * 折叠摘要从 **L0 原文** 生成，绝不从 L1 summary 再摘要（防漂移铁律）
//   * 折叠体占区间第一个编号，其余编号在发送视图消失但库中保留
//   * 两级取回：先 L1（summary），再 L0（原文），不能一步到位

import type DatabaseConstructor from 'better-sqlite3'
import type { Fold, FoldTrigger } from '../types-modules.js'
import type { UnitResult } from '../types.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** fold 表的行。 */
interface FoldRow {
  fold_no: number
  sessionId: string
  from_idx: number
  to_idx: number
  fold_summary: string
  trigger: string
  name: string
  created_at: string
}

/**
 * 折叠仓储。
 *
 * 折叠不删任何单位——只在 message.folded_into 上打标记，
 * 并写一行 fold 记录。L0 原文永远在 message.content 里。
 */
export class FoldStore {
  constructor(private readonly db: BetterSqlite3) {}

  /**
   * 创建折叠：把 [fromIdx, toIdx] 收成一条折叠体。
   *
   * @param fold - 折叠内容（除 foldNo 外）。
   * @returns 折叠体编号。
   */
  create(fold: Omit<Fold, 'foldNo'>): number {
    const info = this.db
      .prepare(
        `INSERT INTO fold (sessionId, from_idx, to_idx, fold_summary, trigger, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fold.sessionId,
        fold.fromIdx,
        fold.toIdx,
        fold.foldSummary,
        fold.trigger,
        fold.name,
        fold.createdAt,
      )
    const foldNo = Number(info.lastInsertRowid)

    // 标记区间内所有单位已折叠（编号保留，L0 保留）
    this.db
      .prepare(
        `UPDATE message SET folded_into = ?
         WHERE sessionId = ? AND idx >= ? AND idx <= ?`,
      )
      .run(foldNo, fold.sessionId, fold.fromIdx, fold.toIdx)

    return foldNo
  }

  /** 按编号取折叠体。 */
  get(sessionId: string, foldNo: number): Fold | undefined {
    const row = this.db
      .prepare(`SELECT * FROM fold WHERE sessionId = ? AND fold_no = ?`)
      .get(sessionId, foldNo) as FoldRow | undefined
    return row ? toFold(row) : undefined
  }

  /** 该会话的全部折叠体（按起始编号升序）。 */
  list(sessionId: string): Fold[] {
    const rows = this.db
      .prepare(`SELECT * FROM fold WHERE sessionId = ? ORDER BY from_idx ASC`)
      .all(sessionId) as FoldRow[]
    return rows.map(toFold)
  }

  /** 覆盖某个编号的折叠体（若有）。 */
  findByUnit(sessionId: string, idx: number): Fold | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM fold WHERE sessionId = ? AND from_idx <= ? AND to_idx >= ? LIMIT 1`,
      )
      .get(sessionId, idx, idx) as FoldRow | undefined
    return row ? toFold(row) : undefined
  }

  /** 统计。 */
  count(sessionId: string): number {
    return (this.db
      .prepare(`SELECT COUNT(*) AS n FROM fold WHERE sessionId = ?`)
      .get(sessionId) as { n: number }).n
  }
}

function toFold(row: FoldRow): Fold {
  return {
    foldNo: row.fold_no,
    sessionId: row.sessionId,
    fromIdx: row.from_idx,
    toIdx: row.to_idx,
    foldSummary: row.fold_summary,
    trigger: row.trigger as FoldTrigger,
    name: row.name,
    createdAt: row.created_at,
  }
}

// ===========================================================================
// 两级展开
// ===========================================================================

/** 第一级展开结果：区间内每个单位的 L1。 */
export interface ExpandLevel1 {
  level: 1
  fromIdx: number
  toIdx: number
  foldSummary: string
  units: Array<{
    idx: number
    kind: string
    summary: string
    /** 是否有原文可继续展开 */
    hasContent: boolean
  }>
}

/** 第二级展开结果：某个单位的 L0 原文。 */
export interface ExpandLevel2 {
  level: 2
  idx: number
  kind: string
  summary: string
  /** 完整原文 */
  content: string
}

/** 展开结果。 */
export type ExpandResult = ExpandLevel1 | ExpandLevel2

/**
 * 第一级展开：折叠体 → 区间内各单位的 summary（L1）。
 *
 * **不返回原文**。要看原文必须再调一级展开（§5.4 严格两级）。
 *
 * @param units - 区间内的单位（用于取 summary）。
 * @param fold - 折叠体。
 */
export function expandLevel1(units: readonly UnitResult[], fold: Fold): ExpandLevel1 {
  return {
    level: 1,
    fromIdx: fold.fromIdx,
    toIdx: fold.toIdx,
    foldSummary: fold.foldSummary,
    units: units.map(u => ({
      idx: u.idx,
      kind: u.kind,
      summary: u.summary.trim().length > 0 ? u.summary : '（未总结）',
      hasContent: u.content.trim().length > 0,
    })),
  }
}

/**
 * 第二级展开：单个单位 → L0 原文。
 *
 * @param unit - 目标单位。
 */
export function expandLevel2(unit: UnitResult): ExpandLevel2 {
  return {
    level: 2,
    idx: unit.idx,
    kind: unit.kind,
    summary: unit.summary,
    content: unit.content,
  }
}

// ===========================================================================
// 折叠指令
// ===========================================================================

/**
 * 构造折叠指令（整条英文）。
 *
 * 输入给模型的是 **L0 原文**，要求产出一段覆盖整个区间的摘要。
 *
 * @param fromIdx - 区间起始编号。
 * @param toIdx - 区间结束编号。
 * @param chars - 区间总字符数。
 * @param taskName - 这段完成了什么（可选，来自模型的声明）。
 */
export function buildFoldPrompt(fromIdx: number, toIdx: number, chars: number, taskName?: string): string {
  const what = taskName && taskName.trim().length > 0 ? `the task "${taskName.trim()}"` : 'a completed span of work'
  return [
    `Units #${fromIdx} through #${toIdx} (about ${chars} characters) cover ${what}.`,
    `Collapse this whole span into one durable note.`,
    ``,
    `This is extraction, not compression. Keep the reasoning that led to the outcome:`,
    `  rejected option: <what it was> — because <the concrete reason>`,
    `  ...`,
    `  chosen option: <what was settled on>`,
    `Preserve concrete facts (paths, numbers, error names, decisions). Drop repeated trial and error.`,
    ``,
    `State explicitly:`,
    `1. what this span accomplished`,
    `2. what it settled (the final state, so work can continue from it)`,
    `3. anything left open or unfinished`,
    ``,
    `Important: after folding, the individual units are no longer in your context.`,
    `This note is what you will have. Anything you omit is effectively lost until you expand those units again.`,
    ``,
    `Reply with the note only — no preamble, no commentary.`,
  ].join('\n')
}
