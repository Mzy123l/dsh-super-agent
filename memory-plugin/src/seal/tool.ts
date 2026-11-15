// `memory_seal` 工具：模型主动封存一段对话，并留下自己的总结。
//
// 这是「近几步全量 + 总结」里**总结**的产生点。
//
// 为什么是工具而不是自动触发：
// - 用户明确要求「不做自动触发」
// - 只有模型自己知道「这一段是不是真的结束了、有没有值得留下的结论」
//
// 封存动作有两步（必须原子，否则会丢总结或丢历史）：
// 1. 把 SealedSegment 写进自己的 SQLite（总结永远留存）
// 2. 向会话 append 一条 `surfaceOp: replace` 事件（把旧历史换成总结）

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SealStore } from './store.js'
import type { SealedSegment } from './types.js'

/** 工具执行所需的上下文能力（收窄接口，便于单测）。 */
export interface SealToolHost {
  /** 封存段仓储。 */
  readonly store: SealStore
  /** 取会话的 append 能力；拿不到时返回 undefined。 */
  appendToSession(sessionId: string, event: unknown): void
  /** 该会话当前最新轮次（用于写进 segment）。 */
  latestTurn(sessionId: string): number
  /** 保留原文的轮次数。 */
  keepTurns: number
  /** 诊断日志。 */
  warn(message: string): void
}

/** 工具参数。 */
interface SealArgs {
  summary?: string
  reason?: string
  from_seq?: number
  to_seq?: number
}

/**
 * 创建 `memory_seal` 工具定义。
 *
 * 参数里的 `from_seq` / `to_seq` 允许模型显式指定要封存的事件范围；
 * 不指定时，封存「当前轮次之前、且尚未封存」的全部范围。
 */
export function createSealTool(host: SealToolHost, ctx: Context) {
  return defineTool({
    name: 'memory_seal',
    description:
      'Seal a finished span of this conversation, replacing it with your own summary. '
      + 'Later turns will see the summary instead of the original messages, which keeps the context small '
      + 'while preserving what matters. Call it when a topic is genuinely done and you have a conclusion worth keeping. '
      + 'Do not seal work that is still in progress.',
    parameters: {
      summary: {
        type: 'string',
        description:
          'What this span accomplished: the conclusion, the decisions made, what remains open. '
          + 'Write it so that a future reader who never saw the original messages can continue the work.',
      },
      reason: {
        type: 'string',
        description: 'Why this span can be sealed now, e.g. "the fix is verified" or "the user moved to another topic".',
      },
      from_seq: {
        type: 'number',
        description: 'First event seq to seal. Omit to seal everything before the current turn that is not sealed yet.',
      },
      to_seq: {
        type: 'number',
        description: 'Last event seq to seal. Omit together with from_seq to use the automatic range.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sealed: { type: 'boolean', required: true },
          segmentId: { type: 'string' },
          fromSeq: { type: 'number' },
          toSeq: { type: 'number' },
          summaryChars: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: SealArgs, exec: { agent?: { session?: { id?: string } } }) {
      const sessionId = exec.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { sealed: false, error: 'no calling session' }
      }

      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (summary.length === 0) {
        // 空总结会让历史直接消失，必须拒绝。
        return { sealed: false, error: 'summary must not be empty' }
      }

      const fromSeq = typeof args.from_seq === 'number' ? args.from_seq : undefined
      const toSeq = typeof args.to_seq === 'number' ? args.to_seq : undefined
      if ((fromSeq === undefined) !== (toSeq === undefined)) {
        return { sealed: false, error: 'from_seq and to_seq must be given together' }
      }

      try {
        const turn = host.latestTurn(sessionId)

        // 区间未显式给出时，拒绝而不是猜——猜错会遮蔽掉不该封存的内容。
        if (fromSeq === undefined || toSeq === undefined) {
          return {
            sealed: false,
            error:
              'explicit from_seq and to_seq are required; '
              + 'read the session log or use the automatic range reported by the plugin',
          }
        }
        if (toSeq < fromSeq) {
          return { sealed: false, error: 'to_seq must not be less than from_seq' }
        }

        // 防重复：同一区间被封存两次会让历史被二次遮蔽，无法回滚。
        const overlapping = host.store.findOverlapping(sessionId, fromSeq, toSeq)
        if (overlapping) {
          return { sealed: false, error: `range overlaps already sealed segment ${overlapping.id}` }
        }

        const segment: SealedSegment = {
          id: `seal-${randomUUID()}`,
          sessionId,
          fromSeq,
          toSeq,
          summary,
          reason,
          turn,
          at: new Date().toISOString(),
        }

        // 先落库：总结是唯一不可再生的东西，先保证它活着。
        host.store.insert(segment)

        // 再替换 surface。失败时总结仍在库里，可以在下一轮重试替换。
        try {
          host.appendToSession(sessionId, segment)
        } catch (error) {
          host.warn(`memory_seal: surface replace failed for ${segment.id}: ${String(error)}`)
          return {
            sealed: false,
            segmentId: segment.id,
            error: `summary stored but history replacement failed: ${String(error)}`,
          }
        }

        return {
          sealed: true,
          segmentId: segment.id,
          fromSeq,
          toSeq,
          summaryChars: summary.length,
        }
      } catch (error) {
        host.warn(`memory_seal failed: ${String(error)}`)
        return { sealed: false, error: String(error) }
      }
    },
    presentCall: (args: SealArgs) => ({
      card: 'generic',
      title: 'memory_seal',
      rawInput: args,
    }),
  })
}
