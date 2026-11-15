/**
 * 落盘 JSONL 的行格式定义。
 *
 * 契约（与 bubble-builder 对齐，见 README「落盘格式」）：
 * - 顶层键固定为 ts / sessionId / provider / model / step / turn / variant / runId / messages / totals；
 * - 每条 message 必有 role / text / chars，reasoning / reasoningChars / toolName / truncated / originalChars 为可选键；
 * - messages 保留原始顺序，不重排。
 *
 * 本文件**不 import 任何 dsh 包**：类型是本插件自己定义的最小结构，
 * 这样 serialize / capture / writer 三层都可以独立测试与复用。
 */

/** 一次模型请求的消息角色集合（与 dsh 的 MessageRoleMap 一致）。 */
export type CaptureRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

/** 采集到的单条消息快照。 */
export interface CapturedMessage {
  /** 消息角色。 */
  role: CaptureRole
  /** 可见文本（所有 text 内容块拼接后的结果）。 */
  text: string
  /** `text.length`；截断后是**截断后**的长度。 */
  chars: number
  /** 思考文本；仅当该消息含 reasoning 块时出现。 */
  reasoning?: string
  /** `reasoning.length`；与 `reasoning` 同时出现。 */
  reasoningChars?: number
  /** 工具名；仅 role==="tool" 且能反查到时出现。 */
  toolName?: string
  /** 文本被截断时为 true。 */
  truncated?: true
  /** 截断前的真实字符数；与 `truncated` 同时出现。 */
  originalChars?: number
}

/** 一次请求的聚合统计。 */
export interface CaptureTotals {
  /** 消息条数。 */
  messages: number
  /** 所有消息 `text.length` 之和（**不含** reasoning）。 */
  chars: number
  /** 所有消息 `reasoning.length` 之和（与 `chars` **互斥**）。 */
  reasoningChars: number
  /** role==="system" 的消息 `text.length` 之和（是 `chars` 的**子集**）。 */
  systemChars: number
}

/** 落盘 JSONL 的一行。 */
export interface CaptureRecord {
  /** 捕获时刻（ISO 8601，UTC，毫秒精度）。 */
  ts: string
  /** 会话 id；无法确定时为空串。 */
  sessionId: string
  /** 提供方路由名。 */
  provider: string
  /** 模型 id。 */
  model: string
  /** 步号（从 1 起）；未知时为 0。 */
  step: number
  /** 轮号（从 1 起）；未知时为 0。 */
  turn: number
  /** A/B 变体标记：`on` 或 `off`。 */
  variant: string
  /** 本轮 run 的标识。 */
  runId: string
  /** 消息快照，**保持原始顺序**。 */
  messages: CapturedMessage[]
  /** 聚合统计。 */
  totals: CaptureTotals
}
