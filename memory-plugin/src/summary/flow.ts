// 总结流程：串行、即时。
//
// 时序（见 docs/A7-memory-design-final.md §2.2）：
//   模型产出长单位
//     → 下一步 pre-step：注入提炼指令（user 消息，引用 #N）
//     → 模型回复提炼结果
//     → 程序收下：summary 挂到单位
//     → 撤掉指令与回复的发送视图（日志保留）
//     → 工作继续
//
// 关键约束：
//   * 长单位（≥阈值）必须总结；短单位可选（模型可回「无」）。
//   * 总结完成后**发送视图不变**（summary 与 content 并存）——总结不省空间。
//   * 模型从不写 <summary> 标签（标签由渲染层加）。

import type { MemoryStore } from '../store/sqlite.js'
import type { Unit } from '../types.js'
import type { PendingStore, PendingSummary } from './pending.js'
import { buildSummaryPrompt, isNoSummary, summaryDecision, unitsNeedingSummary } from '../projection/render.js'

/** 长单位阈值（字符数）。 */
export const SUMMARY_THRESHOLD = 4000

/** awaiting 的最长等待时间。 */
export const PENDING_TTL_MS = 10 * 60 * 1000

/** 一次流程决策的结果。 */
export type SummaryAction =
  /** 注入了提炼指令 */
  | { kind: 'inject'; unitIdx: number; promptText: string }
  /** 收割了提炼结果 */
  | { kind: 'harvested'; unitIdx: number; summary: string; skipped: boolean }
  /** 收割失败 */
  | { kind: 'failed'; reason: string }
  /** 无事可做 */
  | { kind: 'idle'; reason: string }

/** 流程宿主能力。 */
export interface SummaryHost {
  readonly store: MemoryStore
  readonly pending: PendingStore
  /** 该会话最新一条 assistant 可见文本（供收割）。 */
  lastAssistantText(sessionId: string): string | undefined
  /** 该会话最新一条 assistant 消息产出时刻（ISO）。 */
  lastAssistantAt(sessionId: string): string | undefined
  /** 长单位阈值。 */
  threshold?: number
  warn(message: string): void
}

/**
 * 执行一次总结流程决策。
 *
 * 顺序：**先收割，后注入**——
 * 有 pending 时必须先处理它，否则注入新的会覆盖掉上一轮的待办。
 *
 * @param sessionId - 会话 id。
 * @param host - 宿主能力。
 * @returns 本次做了什么。
 */
export function runSummaryStep(sessionId: string, host: SummaryHost): SummaryAction {
  // ---------- 收割 ----------
  const awaiting = host.pending.get(sessionId)
  if (awaiting) {
    const harvested = tryHarvest(sessionId, awaiting, host)
    if (harvested) return harvested

    const age = Date.now() - Date.parse(awaiting.createdAt)
    if (age <= PENDING_TTL_MS) return { kind: 'idle', reason: 'waiting for the summary reply' }

    host.pending.clear(sessionId)
    host.warn(`summary: pending expired after ${Math.round(age / 1000)}s`)
    return { kind: 'failed', reason: 'pending expired without a reply' }
  }

  // ---------- 注入 ----------
  const range = host.store.indexRange(sessionId)
  if (!range) return { kind: 'idle', reason: 'no units yet' }

  const units = host.store.listRange(sessionId, range.min, range.max)
  const threshold = host.threshold ?? SUMMARY_THRESHOLD
  const candidates = unitsNeedingSummary(units as Unit[], threshold)
  if (candidates.length === 0) return { kind: 'idle', reason: 'no unit needs a summary' }

  // 一次只安排一个：串行、可预测。
  // 长单位优先——`should-summarize` 必须做，`optional` 是顺手做，
  // 先清掉硬性债务，避免长单位被一串"可选"单位无限押后。
  const target = pickNext(candidates, threshold)
  const decision = summaryDecision(target.content.length, threshold)
  const promptText = buildSummaryPrompt(target.idx, target.kind, decision)
  host.pending.set({
    sessionId,
    unitIdx: target.idx,
    promptText,
    createdAt: new Date().toISOString(),
  })

  return { kind: 'inject', unitIdx: target.idx, promptText }
}

/**
 * 从候选里挑下一个要总结的单位。
 *
 * 规则：`should-summarize` 档按编号升序优先；没有硬性候选时才轮到 `optional`，
 * 同样按编号升序（最早的先做，保持时序感）。
 *
 * @param candidates - 候选单位（编号升序）。
 * @param threshold - 长单位阈值。
 */
function pickNext(candidates: readonly Unit[], threshold: number): Unit {
  const hard = candidates.filter(u => summaryDecision(u.content.length, threshold) === 'should-summarize')
  if (hard.length > 0) return hard[0] as Unit
  return candidates[0] as Unit
}

/**
 * 尝试收割模型回复作为 summary。
 *
 * 三个条件必须同时满足：
 *   1. 有 assistant 回复
 *   2. 回复晚于 pending 的创建时刻（否则收的是更早的历史）
 *   3. 回复非空
 *
 * @returns 收割动作；返回 undefined 表示「还没到时候」。
 */
function tryHarvest(sessionId: string, awaiting: PendingSummary, host: SummaryHost): SummaryAction | undefined {
  const text = host.lastAssistantText(sessionId)
  if (text === undefined) return undefined

  const at = host.lastAssistantAt(sessionId)
  if (at !== undefined && Date.parse(at) < Date.parse(awaiting.createdAt)) return undefined

  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined

  // 模型回「无」表示该单位不值得提炼（短单位可选的实现方式）
  const skipped = isNoSummary(trimmed)
  const summary = skipped ? '' : trimmed

  try {
    if (!skipped) host.store.setSummary(sessionId, awaiting.unitIdx, summary)
    // 登记回复指纹：这条回复是一次性产物，不得作为普通 reply 单位入库
    host.pending.rememberReply(sessionId, trimmed)
    host.pending.clear(sessionId)
    return { kind: 'harvested', unitIdx: awaiting.unitIdx, summary, skipped }
  } catch (error) {
    host.pending.clear(sessionId)
    host.warn(`summary: harvest failed: ${String(error)}`)
    return { kind: 'failed', reason: String(error) }
  }
}

/** 统计某会话的总结覆盖率（诊断用）。 */
export function summaryCoverage(store: MemoryStore, sessionId: string): { total: number; summarized: number } {
  const range = store.indexRange(sessionId)
  if (!range) return { total: 0, summarized: 0 }
  const units = store.listRange(sessionId, range.min, range.max)
  return {
    total: units.length,
    summarized: units.filter(u => u.summary.trim().length > 0).length,
  }
}
