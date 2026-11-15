/**
 * 捕获逻辑：从 `llm/stream` waterfall 拿到的请求选项里，提取结构化快照。
 *
 * 本层**不 import 任何 dsh 包**：它只消费自己声明的最小请求结构
 * （见 `CaptureRequest`），因此可以被 `--selftest` 独立验证。
 */

import { computeTotals, serializeMessages, type SourceMessage } from './serialize.js'
import type { CaptureRecord } from './types.js'

/** 捕获点看到的最小请求结构（对应 dsh 的 GenerateOptions 关键字段）。 */
export interface CaptureRequest {
  /** 会话 id；非对话请求可能没有。 */
  sessionId?: string | undefined
  /** 提供方路由名。 */
  provider: string
  /** 模型 id。 */
  model: string
  /** 这次请求发给模型的完整消息（已 deep-frozen，只读）。 */
  messages: readonly SourceMessage[]
  /** 辅助调用用途；普通对话请求为 undefined。 */
  purpose?: string | undefined
}

/** 捕获时需要的外部事实。 */
export interface CaptureContext {
  /** 变体标记：`on` 或 `off`。 */
  variant: string
  /** 本轮 run 的标识。 */
  runId: string
  /** 单条消息文本的字符上限；`undefined` 或 0 表示不截断。 */
  maxChars?: number | undefined
  /** 捕获时刻（ISO 8601）。 */
  timestamp?: string
}

/**
 * 提取一次请求的快照。
 *
 * @param request - `llm/stream` 拿到的请求选项。
 * @param context - 变体 / runId / 截断上限 / 时间戳。
 * @returns 落盘用的一行记录。
 */
export function captureRequest(request: CaptureRequest, context: CaptureContext): CaptureRecord {
  const messages = serializeMessages(request.messages, { maxChars: context.maxChars })
  return {
    ts: context.timestamp ?? new Date().toISOString(),
    sessionId: request.sessionId ?? '',
    provider: request.provider,
    model: request.model,
    // step / turn 由上层（index.ts）从会话事件里补齐；这里保持 0（未知）。
    step: 0,
    turn: 0,
    variant: context.variant,
    runId: context.runId,
    messages,
    totals: computeTotals(messages),
  }
}

/**
 * 判断这次请求是否是**普通对话请求**。
 *
 * dsh 用 `options.purpose` 区分辅助调用（`compaction` 摘要、`session-title` 标题生成）。
 * 那些调用的 messages 不是用户对话上下文，混进 A/B 数据会污染统计，所以跳过。
 *
 * @param request - 请求选项。
 * @returns 是普通对话请求时为 true。
 */
export function isConversationRequest(request: CaptureRequest): boolean {
  return request.purpose === undefined
}
