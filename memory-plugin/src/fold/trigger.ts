// 折叠触发逻辑：三种自动触发 + 手动。
//
// 任务边界（模型声明）、多任务拆分、预算兜底、手动 /compact。
//
// 本文件只做「判断该不该折叠」，实际折叠由调用方执行（需模型生成摘要）。

import type { MemoryStore } from '../store/sqlite.js'
import type { FoldStore } from '../fold/store.js'
import type { FoldTrigger } from '../types-modules.js'

/** 预算兜底阈值（字符数）：投影后超过就建议折叠。 */
export const FOLD_BUDGET_CHARS = 2_000_000

/** 一个候选折叠区间。 */
export interface FoldCandidate {
  fromIdx: number
  toIdx: number
  chars: number
  units: number
  trigger: FoldTrigger
  reason: string
}

/**
 * 找出可折叠的区间。
 *
 * 规则：
 *  1. 窗口外的连续未折叠单位
 *  2. 排除最近 keep 个单位（那是近程，要保留原文）
 *  3. 已经折叠过的不再折叠
 *
 * @param store - 单位存储。
 * @param folds - 折叠仓储。
 * @param sessionId - 会话 id。
 * @param keep - 保留原文的单位数（窗口大小）。
 * @returns 候选区间（按 fromIdx 升序）。
 */
export function findFoldCandidates(
  store: MemoryStore,
  folds: FoldStore,
  sessionId: string,
  keep: number,
): FoldCandidate[] {
  const range = store.indexRange(sessionId)
  if (!range) return []

  const folded = new Set<number>()
  for (const f of folds.list(sessionId)) {
    for (let i = f.fromIdx; i <= f.toIdx; i += 1) folded.add(i)
  }

  const cutoff = range.max - keep
  const out: FoldCandidate[] = []
  let open: { from: number; to: number; chars: number; units: number } | undefined

  for (let i = range.min; i <= cutoff; i += 1) {
    if (folded.has(i)) {
      if (open) {
        out.push(toCandidate(open, 'task-boundary', '窗口外的连续未折叠区间'))
        open = undefined
      }
      continue
    }
    const unit = store.getUnit(sessionId, i)
    if (!unit) continue
    if (open) {
      open.to = i
      open.chars += unit.content.length
      open.units += 1
    } else {
      open = { from: i, to: i, chars: unit.content.length, units: 1 }
    }
  }
  if (open) out.push(toCandidate(open, 'task-boundary', '窗口外的连续未折叠区间'))
  return out
}

function toCandidate(
  o: { from: number; to: number; chars: number; units: number },
  trigger: FoldTrigger,
  reason: string,
): FoldCandidate {
  return { fromIdx: o.from, toIdx: o.to, chars: o.chars, units: o.units, trigger, reason }
}

/**
 * 判断是否超出预算（兜底触发）。
 *
 * @param totalChars - 当前投影后的总字符数。
 * @param budget - 预算（默认 FOLD_BUDGET_CHARS）。
 */
export function overBudget(totalChars: number, budget: number = FOLD_BUDGET_CHARS): boolean {
  return totalChars > budget
}

/**
 * 计算当前投影后的总字符数（用于预算判断）。
 *
 * @param store - 单位存储。
 * @param sessionId - 会话 id。
 * @param keep - 保留原文的单位数。
 */
export function projectedChars(store: MemoryStore, sessionId: string, keep: number): number {
  const range = store.indexRange(sessionId)
  if (!range) return 0
  const units = store.listRange(sessionId, range.min, range.max)
  let total = 0
  for (const u of units) {
    const recent = range.max - u.idx < keep
    const hasSummary = u.summary.trim().length > 0
    if (u.kind === 'user') total += u.content.length
    else if (recent) total += u.content.length + u.summary.length
    else if (hasSummary) total += u.summary.length
    else total += u.content.length
  }
  return total
}
