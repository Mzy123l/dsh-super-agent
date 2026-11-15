// 消息循环：由插件驱动「提炼」，不经过模型主动调工具。
//
// ===========================================================================
// 时序（这一版想清楚了）
// ===========================================================================
//
//   第 N 轮 pre-step
//     ├─ 若存在 awaiting 且已有更新的 assistant 消息
//     │    → 收割：把那条 assistant 文本当作提炼结果
//     │    → 落库为段 + append(replace) 遮蔽 [区间, 提示]
//     │    → 清除 awaiting
//     │
//     └─ 否则若没有 awaiting 且找到该提炼的区间
//          → 注入提炼提示（插入本步消息）
//          → 记 awaiting
//
//   第 N 轮模型推理 → 输出提炼结果（自然语言）
//
//   第 N+1 轮 pre-step → 收割
//
// **关键**：收割依赖「上一轮模型的输出」，所以 pre-step 里必须能读到
// 最后一条 assistant 消息。这由 session/event 监听器维护。

import type { PendingInject, PendingStore } from './store.js'
import type { SegmentStore } from '../seal/store.js'
import type { Segment } from '../seal/types.js'
import { decideSummarize, buildSummarizePrompt } from '../seal/types.js'
import { applySegment } from '../seal/apply.js'
import { applyArchive } from '../seal/lifecycle.js'
import { computeSpans, coveredSeqs, type SpanEvent } from '../seal/spans.js'

/** 一次循环决策的结果。 */
export type LoopAction =
  | { kind: 'injected'; fromSeq: number; toSeq: number; promptText: string }
  | { kind: 'harvested'; segmentNo: number; fromSeq: number; toSeq: number }
  | { kind: 'harvest-failed'; reason: string }
  | { kind: 'idle'; reason: string }

/** 一条 assistant 消息的摘要。 */
export interface AssistantSnapshot {
  readonly text: string
  readonly seq: number
  /** 记录时刻（ISO），用于判断是否晚于 awaiting */
  readonly at: string
}

/** 循环所需的宿主能力。 */
export interface LoopHost {
  readonly segments: SegmentStore
  readonly pending: PendingStore
  latestTurn(sessionId: string): number
  eventsOf(sessionId: string): readonly SpanEvent[]
  /** 该会话最后一条 assistant 消息；没有则 undefined。 */
  lastAssistant(sessionId: string): AssistantSnapshot | undefined
  /** 把段应用到会话表面（append replace）。 */
  apply(segment: Segment): void
  keepTurns: number
  autoSummarize: boolean
  warn(message: string): void
}

/**
 * 执行一次循环决策。
 *
 * 顺序：**先收割，后注入**。因为收割依赖上一轮的结果，
 * 先注入新的会把 awaiting 覆盖掉，导致上一轮的提炼结果永远收不到。
 */
export function runLoopStep(sessionId: string, host: LoopHost): LoopAction {
  // ---------- 收割 ----------
  const awaiting = host.pending.getAwaiting(sessionId)
  if (awaiting) {
    const harvested = tryHarvest(sessionId, awaiting, host)
    if (harvested) return harvested
    // 拿不到结果且未过期：保持等待，不注入新的
    const age = Date.now() - Date.parse(awaiting.createdAt)
    if (age <= PENDING_TTL_MS) {
      return { kind: 'idle', reason: 'waiting for the summary reply' }
    }
    // 过期：放弃这次安排
    host.pending.clear(sessionId)
    host.warn(`loop: awaiting expired after ${Math.round(age / 1000)}s`)
    return { kind: 'harvest-failed', reason: 'awaiting expired without a usable reply' }
  }

  // ---------- 注入 ----------
  if (!host.autoSummarize) return { kind: 'idle', reason: 'auto summarize disabled' }

  const latestTurn = host.latestTurn(sessionId)
  if (latestTurn === 0) return { kind: 'idle', reason: 'no turns yet' }

  const covered = coveredSeqs(host.segments, sessionId)
  const spans = computeSpans(host.eventsOf(sessionId), covered, latestTurn, host.keepTurns)
  // 只挑「确实该提炼」的区间；短的保持原文
  const candidate = spans.find(s => decideSummarize(s.chars).kind === 'should-summarize')
  if (!candidate) return { kind: 'idle', reason: 'no span needs summarizing' }

  const promptText = buildSummarizePrompt(candidate.chars)
  host.pending.markAwaiting({
    sessionId,
    fromSeq: candidate.fromSeq,
    toSeq: candidate.toSeq,
    turn: candidate.toTurn,
    promptText,
    createdAt: new Date().toISOString(),
  })

  return { kind: 'injected', fromSeq: candidate.fromSeq, toSeq: candidate.toSeq, promptText }
}

/** awaiting 的最长等待时间：超过就放弃本次安排。 */
export const PENDING_TTL_MS = 10 * 60 * 1000

/**
 * 尝试收割：判断是否有「晚于提示的 assistant 消息」可用作提炼结果。
 *
 * @returns 成功或失败的动作；返回 undefined 表示「还没到时候」。
 */
function tryHarvest(sessionId: string, awaiting: PendingInject, host: LoopHost): LoopAction | undefined {
  const last = host.lastAssistant(sessionId)
  if (!last) return undefined

  // 必须是提示之后产生的回复，否则收的是更早的历史消息
  if (Date.parse(last.at) < Date.parse(awaiting.createdAt)) return undefined
  const text = last.text.trim()
  if (text.length === 0) return undefined

  try {
    const segment: Omit<Segment, 'eventNo'> = {
      sessionId,
      // 遮蔽范围要覆盖「被提炼的区间」以及「注入的提示」。
      // 提示的 seq 在注入时未知（它是新追加的消息），
      // 所以用它之后的 assistant seq 作为上界更稳妥。
      fromSeq: awaiting.fromSeq,
      toSeq: Math.max(awaiting.toSeq, last.seq),
      shadowedSeqs: [],
      summary: text,
      // 近期段：保留原文由 apply 时的区间决定；这里先不塞 recent
      recent: '',
      stage: 'archived',
      turn: awaiting.turn,
      at: new Date().toISOString(),
    }
    const eventNo = host.segments.insert(segment)
    const stored = host.segments.get(sessionId, eventNo)
    if (!stored) throw new Error('segment vanished after insert')

    host.apply(stored)
    host.pending.clear(sessionId)

    try {
      applyArchive(host.segments, sessionId, host.latestTurn(sessionId), host.keepTurns)
    } catch (error) {
      host.warn(`loop: archive pass failed: ${String(error)}`)
    }

    return { kind: 'harvested', segmentNo: eventNo, fromSeq: stored.fromSeq, toSeq: stored.toSeq }
  } catch (error) {
    host.pending.clear(sessionId)
    host.warn(`loop: harvest failed: ${String(error)}`)
    return { kind: 'harvest-failed', reason: String(error) }
  }
}
