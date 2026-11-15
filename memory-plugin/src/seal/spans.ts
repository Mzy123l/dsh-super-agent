// 让模型知道「哪一段可以总结」——解决它拿不到 seq 的问题。
//
// ===========================================================================
// 问题
// ===========================================================================
//
// `memory_summarize` 要求显式传 from_seq / to_seq，但模型不知道当前会话
// 有哪些 seq 可用。让它猜区间会导致：
//   - 猜错 → 遮蔽掉不该总结的内容（不可逆）
//   - 猜漏 → 总结不完整
//
// ===========================================================================
// 解法
// ===========================================================================
//
// 提供一个只读工具 `memory_spans`，列出当前会话**可总结的区间**：
//   - 已滑出近期窗口（也就是「可以总结」的候选）
//   - 尚未被任何段覆盖
//   - 附带每段的字符数估计与建议
//
// 模型据此挑一个区间，再调 `memory_summarize`。
// 这样它永远不需要猜 seq。

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SegmentStore } from './store.js'
import { decideSummarize } from './types.js'

/** 一个可总结的区间。 */
export interface Span {
  /** 起始 seq（含） */
  readonly fromSeq: number
  /** 结束 seq（含） */
  readonly toSeq: number
  /** 事件条数 */
  readonly eventCount: number
  /** 字符数估计 */
  readonly chars: number
  /** 所在轮次范围 */
  readonly fromTurn: number
  readonly toTurn: number
  /** 长度建议 */
  readonly recommendation: string
}

/** 用于计算区间的事件摘要。 */
export interface SpanEvent {
  readonly seq: number
  readonly turn?: number
  readonly chars: number
}

/** 工具宿主能力。 */
export interface SpanHost {
  readonly store: SegmentStore
  /** 该会话当前最新轮次。 */
  latestTurn(sessionId: string): number
  /** 该会话当前可见的事件（按 seq 升序）。 */
  eventsOf(sessionId: string): readonly SpanEvent[]
  /** 保留原文的轮次数。 */
  keepTurns: number
}

/**
 * 计算当前可总结的区间。
 *
 * 规则：
 * 1. 只取已滑出近期窗口的事件（turn ≤ latestTurn - keepTurns）
 * 2. 排除已被段覆盖的 seq
 * 3. 按轮次分组，每个轮次一个区间
 *
 * @param events - 该会话所有事件（按 seq 升序）。
 * @param covered - 已被段覆盖的 seq 集合。
 * @param latestTurn - 最新轮次。
 * @param keepTurns - 近期窗口大小。
 * @returns 可总结的区间列表（按轮次升序）。
 */
export function computeSpans(
  events: readonly SpanEvent[],
  covered: ReadonlySet<number>,
  latestTurn: number,
  keepTurns: number,
): Span[] {
  const cutoff = latestTurn - keepTurns
  // 按轮次聚合
  const byTurn = new Map<number, SpanEvent[]>()
  for (const ev of events) {
    if (covered.has(ev.seq)) continue
    const turn = ev.turn
    if (turn === undefined) continue
    // 只有滑出近期窗口的才可总结
    if (turn > cutoff) continue
    const list = byTurn.get(turn)
    if (list) list.push(ev)
    else byTurn.set(turn, [ev])
  }

  const spans: Span[] = []
  for (const [turn, list] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const seqs = list.map(e => e.seq)
    const chars = list.reduce((n, e) => n + e.chars, 0)
    const decision = decideSummarize(chars)
    spans.push({
      fromSeq: Math.min(...seqs),
      toSeq: Math.max(...seqs),
      eventCount: list.length,
      chars,
      fromTurn: turn,
      toTurn: turn,
      recommendation: `${decision.kind}: ${decision.reason}`,
    })
  }
  return spans
}

/**
 * 创建 `memory_spans` 工具：列出可总结的区间。
 *
 * 只读，不改任何状态。
 */
export function createSpansTool(host: SpanHost) {
  return defineTool({
    name: 'memory_spans',
    description:
      'List the spans of this conversation that can be summarized: spans that have already scrolled out of the '
      + 'recent window and are not covered by an existing summary. Each span reports its seq range, size and a '
      + 'length-based recommendation. Use this to pick from_seq/to_seq before calling memory_summarize, '
      + 'instead of guessing.',
    parameters: {
      limit: { type: 'number', description: 'Maximum spans to return (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          spans: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fromSeq: { type: 'number' },
                toSeq: { type: 'number' },
                eventCount: { type: 'number' },
                chars: { type: 'number' },
                fromTurn: { type: 'number' },
                toTurn: { type: 'number' },
                recommendation: { type: 'string' },
              },
            },
          },
          latestTurn: { type: 'number', required: true },
          keepTurns: { type: 'number', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { limit?: number }, exec: { agent?: { session?: { id?: string } } }) {
      const sessionId = exec.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { spans: [], latestTurn: 0, keepTurns: host.keepTurns }
      }
      const latestTurn = host.latestTurn(sessionId)
      const covered = coveredSeqs(host.store, sessionId)
      const spans = computeSpans(host.eventsOf(sessionId), covered, latestTurn, host.keepTurns)
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20
      return {
        spans: spans.slice(0, limit),
        latestTurn,
        keepTurns: host.keepTurns,
      }
    },
    presentCall: (args: { limit?: number }) => ({ card: 'generic', title: 'memory_spans', rawInput: args }),
  })
}

/** 收集某会话已被段覆盖的所有 seq。 */
export function coveredSeqs(store: SegmentStore, sessionId: string): Set<number> {
  const covered = new Set<number>()
  for (const seg of store.list(sessionId)) {
    if (seg.shadowedSeqs.length > 0) {
      for (const seq of seg.shadowedSeqs) covered.add(seq)
    } else {
      // shadowedSeqs 可能为空（写入时未填），退回用区间
      for (let s = seg.fromSeq; s <= seg.toSeq; s += 1) covered.add(s)
    }
  }
  return covered
}

/** 供 dsh-bundle 使用的上下文类型别名。 */
export type SpansContext = Context
