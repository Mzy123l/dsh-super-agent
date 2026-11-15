// 消息循环：由插件驱动提炼，不经过工具调用。
//
// ===========================================================================
// 时序
// ===========================================================================
//
//   第 N 轮 pre-step
//     ├─ 有 awaiting + 更新的 assistant 消息 → 收割
//     │    → 落库为段 → 遮蔽区间 → 清 awaiting
//     └─ 无 awaiting + 找到该提炼的区间
//          → 注入提示 → 记 awaiting
//
//   第 N 轮：模型输出提炼结果
//   第 N+1 轮 pre-step：收割
//
// ===========================================================================
// 核心规则（用户要求）
// ===========================================================================
//
//   1. 「近几步全量 + 总结」：仍在近期窗口内的段 → live（原文+总结并存）
//      滑出窗口的段 → archived（只剩总结）
//   2. 索引线性：区间用 fromIdx..toIdx，连续无空洞
//   3. 提示只出现一次：收割时随区间一起被遮蔽

import type { SegmentStore } from '../seal/types.js'
import { buildSummarizePrompt, composeSlottedText, decideSummarize } from '../seal/types.js'
import type { PendingInject, PendingStore } from './store.js'
import type { MemoryStore } from '../store/sqlite.js'

/** awaiting 的最长等待时间。 */
export const PENDING_TTL_MS = 10 * 60 * 1000

/** 一次循环决策的结果。 */
export type LoopAction =
  | { kind: 'injected'; fromIdx: number; toIdx: number; promptText: string }
  | { kind: 'harvested'; segmentNo: number; fromIdx: number; toIdx: number; stage: 'live' | 'archived' }
  | { kind: 'harvest-failed'; reason: string }
  | { kind: 'idle'; reason: string }

/** 一个可提炼的区间。 */
export interface Span {
  readonly fromIdx: number
  readonly toIdx: number
  readonly chars: number
  readonly count: number
}

/** 循环宿主能力。 */
export interface LoopHost {
  readonly store: MemoryStore
  readonly segments: SegmentStore
  readonly pending: PendingStore
  /** 应用段（遮蔽区间 + 写入合并消息） */
  apply(segmentNo: number): void
  /** 保留原文的「近几步」消息数 */
  keepRecent: number
  /** 是否启用自动提炼 */
  autoSummarize: boolean
  warn(message: string): void
}

/**
 * 计算可提炼的区间。
 *
 * 从 0 开始线性扫描，跳过已覆盖的 idx，把**连续的未覆盖 idx** 聚成区间。
 *
 * 注意：这里**不排除**最近 keepRecent 条。
 * 「近几步」的语义是「保留原文」，不是「不提炼」——
 * 近期区间被提炼后仍以 live 阶段保留原文（recent 槽），
 * 只有滑出窗口后才降级为 archived。所以两者都要能成为候选。
 *
 * @param store - 消息存储。
 * @param segments - 段存储（用于排除已覆盖）。
 * @param sessionId - 会话 id。
 * @returns 区间列表（按 fromIdx 升序）。
 */
export function computeSpans(
  store: MemoryStore,
  segments: SegmentStore,
  sessionId: string,
): Span[] {
  const range = store.indexRange(sessionId)
  if (!range) return []

  const covered = segments.coveredIdxs(sessionId)

  const spans: Span[] = []
  let open: { from: number; to: number; chars: number; count: number } | undefined

  for (let i = range.min; i <= range.max; i += 1) {
    if (covered.has(i)) {
      if (open) { spans.push(toSpan(open)); open = undefined }
      continue
    }
    const msg = store.getMessage(sessionId, i)
    if (!msg) continue
    if (open) {
      open.to = i
      open.chars += msg.text.length
      open.count += 1
    } else {
      open = { from: i, to: i, chars: msg.text.length, count: 1 }
    }
  }
  if (open) spans.push(toSpan(open))
  return spans
}

function toSpan(o: { from: number; to: number; chars: number; count: number }): Span {
  return { fromIdx: o.from, toIdx: o.to, chars: o.chars, count: o.count }
}

/**
 * 执行一次循环决策。
 *
 * 顺序：**先收割，后注入**（先注入会覆盖 awaiting，导致上一轮结果收不到）。
 */
export function runLoopStep(
  sessionId: string,
  host: LoopHost,
  lastAssistant: { text: string; at: string } | undefined,
): LoopAction {
  // ---------- 收割 ----------
  const awaiting = host.pending.getAwaiting(sessionId)
  if (awaiting) {
    const harvested = tryHarvest(sessionId, awaiting, host, lastAssistant)
    if (harvested) return harvested

    const age = Date.now() - Date.parse(awaiting.createdAt)
    if (age <= PENDING_TTL_MS) return { kind: 'idle', reason: 'waiting for the summary reply' }

    host.pending.clear(sessionId)
    host.warn(`loop: awaiting expired after ${Math.round(age / 1000)}s`)
    return { kind: 'harvest-failed', reason: 'awaiting expired' }
  }

  // ---------- 注入 ----------
  if (!host.autoSummarize) return { kind: 'idle', reason: 'auto summarize disabled' }

  const spans = computeSpans(host.store, host.segments, sessionId)
  const candidate = spans.find(s => decideSummarize(s.chars).kind === 'should-summarize')
  if (!candidate) return { kind: 'idle', reason: 'no span needs summarizing' }

  const promptText = buildSummarizePrompt(candidate.chars, candidate.fromIdx, candidate.toIdx)
  host.pending.markAwaiting({
    sessionId,
    fromIdx: candidate.fromIdx,
    toIdx: candidate.toIdx,
    promptText,
    createdAt: new Date().toISOString(),
  })

  return { kind: 'injected', fromIdx: candidate.fromIdx, toIdx: candidate.toIdx, promptText }
}

/** 尝试收割。返回 undefined 表示「还没到时候」。 */
function tryHarvest(
  sessionId: string,
  awaiting: PendingInject,
  host: LoopHost,
  lastAssistant: { text: string; at: string } | undefined,
): LoopAction | undefined {
  if (!lastAssistant) return undefined
  // 必须是提示之后的回复
  if (Date.parse(lastAssistant.at) < Date.parse(awaiting.createdAt)) return undefined
  const text = lastAssistant.text.trim()
  if (text.length === 0) return undefined

  try {
    // 判断这段是否仍在近期窗口 → 决定 live 还是 archived
    const range = host.store.indexRange(sessionId)
    const latest = range?.max ?? 0
    const stillRecent = awaiting.toIdx > latest - host.keepRecent

    // live 阶段保留原文（这是「近几步全量」的实现）
    const recentText = stillRecent
      ? host.store
          .listRange(sessionId, awaiting.fromIdx, awaiting.toIdx)
          .map(m => `#${m.idx} ${m.text}`)
          .join('\n\n')
      : ''

    const segmentNo = host.segments.insert({
      sessionId,
      fromIdx: awaiting.fromIdx,
      toIdx: awaiting.toIdx,
      summary: text,
      recent: recentText,
      stage: stillRecent ? 'live' : 'archived',
      at: new Date().toISOString(),
    })

    host.apply(segmentNo)
    host.pending.clear(sessionId)

    return {
      kind: 'harvested',
      segmentNo,
      fromIdx: awaiting.fromIdx,
      toIdx: awaiting.toIdx,
      stage: stillRecent ? 'live' : 'archived',
    }
  } catch (error) {
    host.pending.clear(sessionId)
    host.warn(`loop: harvest failed: ${String(error)}`)
    return { kind: 'harvest-failed', reason: String(error) }
  }
}

/**
 * 窗口滑动：把滑出近期窗口的段降级为 archived。
 *
 * @returns 降级的段数。
 */
export function archiveDue(segments: SegmentStore, sessionId: string, keepRecent: number, latestIdx: number): number {
  let n = 0
  for (const seg of segments.listLive(sessionId)) {
    if (seg.toIdx <= latestIdx - keepRecent) {
      if (segments.archive(seg.segmentNo)) n += 1
    }
  }
  return n
}

/** 把段渲染成可注入的消息正文。 */
export function renderSegment(seg: { recent: string; summary: string }): string {
  return composeSlottedText([
    { kind: 'recent', text: seg.recent },
    { kind: 'summary', text: seg.summary },
  ])
}
