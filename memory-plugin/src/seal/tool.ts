// `memory_summarize` 工具：让模型对一段历史做**提炼**。
//
// ===========================================================================
// 这不是压缩
// ===========================================================================
//
// 用户原话：
//   「你需要提炼出那一段的有效信息，丢弃噪音，注意不是压缩，而是提炼出有效信息，
//     比如模型思考了一大坨几十万字，其中否定了很多方案，得出了最终方案，
//     我期望的结果是：
//       否决方案：xxx 因为：xxx
//       ...
//       最终方案：xxx
//     这样，而不是直接变成最终方案 xxx」
//
// 所以提炼的产出必须**保留否决路径**。
//
// ===========================================================================
// 什么时候用
// ===========================================================================
//
// 由模型自己判断（不做程序化触发）。长度只作为建议：
//   - 很短 → 建议不总结，原文直接留
//   - 中等 → 由模型自己决定
//   - 较长 → 建议总结
//
// 提示词只出现一次，提炼后被遮蔽（见 apply.ts 的 hidePromptAfterUse）。

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SegmentStore } from './store.js'
import type { Segment } from './types.js'
import { decideSummarize, buildSummarizePrompt } from './types.js'
import { applySegment } from './apply.js'

/** 工具需要的宿主能力（收窄，便于单测）。 */
export interface SummarizeHost {
  readonly store: SegmentStore
  /** 该会话当前最新轮次。 */
  latestTurn(sessionId: string): number
  /** 把段应用到会话表面。 */
  apply(ctx: Context, segment: Segment): void
  /** 诊断日志。 */
  warn(message: string): void
}

/** 工具参数。 */
interface SummarizeArgs {
  /** 提炼后的有效信息（保留否决路径） */
  summary?: string
  /** 从哪个 seq 开始 */
  from_seq?: number
  /** 到哪个 seq 结束 */
  to_seq?: number
  /** 该段原文（近期阶段随 summary 一起保留；省略则只留总结） */
  recent_text?: string
}

/**
 * 创建 `memory_summarize` 工具。
 *
 * 两阶段使用：
 * 1. 不带 summary 调用 → 返回「请提炼」的提示与长度建议（模型据此产出总结）
 * 2. 带上 summary 调用 → 落库并替换历史
 */
export function createSummarizeTool(host: SummarizeHost, ctx: Context) {
  return defineTool({
    name: 'memory_summarize',
    description:
      'Summarize a span of this conversation into its essential information. '
      + 'This is NOT compression: you must keep the rejected paths (what was ruled out and why), '
      + 'not just the final answer. Call it when a span is done and worth compacting into a durable note. '
      + 'Call it once without `summary` to get the extraction guidance and a length-based recommendation, '
      + 'then call it again with `summary` to apply.',
    parameters: {
      summary: {
        type: 'string',
        description:
          'The extracted essential information. Must keep rejected alternatives with their reasons, '
          + 'followed by the final decision. Omit on the first call to get the guidance.',
      },
      from_seq: { type: 'number', description: 'First event seq of the span to summarize.' },
      to_seq: { type: 'number', description: 'Last event seq of the span to summarize.' },
      recent_text: {
        type: 'string',
        description:
          'The verbatim text of the span. Keep it when the span is recent so both original and summary are visible. '
          + 'Omit for older spans that should keep only the summary.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          phase: { type: 'string', required: true },
          guidance: { type: 'string' },
          recommendation: { type: 'string' },
          segmentNo: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: SummarizeArgs, exec: { agent?: { session?: { id?: string } } }) {
      const sessionId = exec.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, phase: 'error', error: 'no calling session' }
      }

      const fromSeq = typeof args.from_seq === 'number' ? args.from_seq : undefined
      const toSeq = typeof args.to_seq === 'number' ? args.to_seq : undefined
      if (fromSeq === undefined || toSeq === undefined) {
        // 不给区间就不知道要总结哪一段——拒绝而不是猜。
        return { ok: false, phase: 'error', error: 'from_seq and to_seq are required' }
      }
      if (toSeq < fromSeq) {
        return { ok: false, phase: 'error', error: 'to_seq must not be less than from_seq' }
      }

      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''

      // ---------- 第一阶段：只给指导，不落库 ----------
      if (summary.length === 0) {
        // 估算该段字符数：优先用调用方给的 recent_text，否则按事件数粗估。
        const charsHint = typeof args.recent_text === 'string' ? args.recent_text.length : (toSeq - fromSeq + 1) * 200
        const decision = decideSummarize(charsHint)
        return {
          ok: true,
          phase: 'guidance',
          guidance: buildSummarizePrompt(charsHint),
          recommendation: `${decision.kind}: ${decision.reason}`,
        }
      }

      // ---------- 第二阶段：落库并应用 ----------
      try {
        const overlap = host.store.findOverlapping(sessionId, fromSeq, toSeq)
        if (overlap) {
          return {
            ok: false,
            phase: 'error',
            error: `range overlaps existing segment #${overlap.eventNo}`,
          }
        }

        const recent = typeof args.recent_text === 'string' ? args.recent_text : ''
        const stage = recent.trim().length > 0 ? 'live' : 'archived'

        const eventNo = host.store.insert({
          sessionId,
          fromSeq,
          toSeq,
          shadowedSeqs: [], // 应用时由 collectShadowedSeqs 从真实 surface 补齐
          summary,
          recent,
          stage,
          turn: host.latestTurn(sessionId),
          at: new Date().toISOString(),
        })

        const segment = host.store.get(sessionId, eventNo)
        if (!segment) {
          return { ok: false, phase: 'error', error: 'segment vanished after insert' }
        }

        try {
          host.apply(ctx, segment)
        } catch (error) {
          // 段已落库：总结是唯一不可再生的东西，先保住它。
          host.warn(`memory_summarize: apply failed for segment #${eventNo}: ${String(error)}`)
          return {
            ok: false,
            phase: 'stored-not-applied',
            segmentNo: eventNo,
            error: `summary stored but history replacement failed: ${String(error)}`,
          }
        }

        return { ok: true, phase: 'applied', segmentNo: eventNo }
      } catch (error) {
        host.warn(`memory_summarize failed: ${String(error)}`)
        return { ok: false, phase: 'error', error: String(error) }
      }
    },
    presentCall: (args: SummarizeArgs) => ({
      card: 'generic',
      title: 'memory_summarize',
      rawInput: args,
    }),
  })
}
