/**
 * 把 dsh 的请求消息转成可读的 JSON 快照。
 *
 * 本层是**纯函数**，不 import 任何 dsh 包：它只认识自己定义的最小消息结构
 * （见 types.ts），因此可以在没有 dsh 运行时的情况下被 `--selftest` 独立验证。
 *
 * 两条关键规则：
 * 1. **保留原始顺序**：不做任何重排、合并或去重。
 * 2. **reasoning 不是独立的一条消息**：它与可见文本同属一条 assistant 消息，
 *    拆成 `reasoning` / `reasoningChars` 两个字段。
 */

import type { CaptureRole, CapturedMessage, CaptureTotals } from './types.js'

/** 序列化时认识的最小消息结构（与 dsh 的 RequestMessage 对齐，但不依赖 dsh 包）。 */
export interface SourceContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
}

/** 序列化时认识的最小消息结构。 */
export interface SourceMessage {
  role: string
  content?: readonly SourceContentBlock[]
  toolCallId?: string
}

/** 序列化选项。 */
export interface SerializeOptions {
  /** 单条消息**文本**的字符上限；超限则截断。`undefined` 或 0 表示不截断。 */
  maxChars?: number | undefined
}

/** dsh 的角色集合；未知角色一律降级为 `user`（保底，不丢消息）。 */
const KNOWN_ROLES = new Set<CaptureRole>(['system', 'developer', 'user', 'assistant', 'tool'])

/** 把任意角色字符串收敛到已知集合内。 */
function normalizeRole(role: string): CaptureRole {
  return KNOWN_ROLES.has(role as CaptureRole) ? (role as CaptureRole) : 'user'
}

/**
 * 按上限裁剪文本。
 *
 * @param text - 原始文本。
 * @param maxChars - 上限；`undefined` 或非正数表示不截断。
 * @returns 裁剪结果与截断标记。
 */
export function truncateText(
  text: string,
  maxChars: number | undefined,
): { text: string, truncated: boolean, originalChars: number } {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) {
    return { text, truncated: false, originalChars: text.length }
  }
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length }
  }
  return { text: text.slice(0, maxChars), truncated: true, originalChars: text.length }
}

/**
 * 建立 toolCallId → 工具名的映射。
 *
 * dsh 的 `tool` 角色消息（ToolResultMessage）**只带 toolCallId，不带工具名**；
 * 工具名在**前一条 assistant 消息**的 `tool-call` 内容块里（`{ id, name, arguments }`）。
 * 所以这里扫一遍全部消息建立反查表。
 *
 * @param messages - 原始消息数组。
 * @returns toolCallId 到工具名的映射。
 */
export function buildToolNameIndex(messages: readonly SourceMessage[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call') continue
      const id = block.id
      const name = block.name
      if (typeof id !== 'string' || id.length === 0) continue
      if (typeof name !== 'string' || name.length === 0) continue
      // 后出现的同名 id 覆盖先出现的（与 provider 语义一致：最新一次调用为准）。
      index.set(id, name)
    }
  }
  return index
}

/**
 * 把一条消息转成快照。
 *
 * @param message - 原始消息。
 * @param toolNames - toolCallId 到工具名的映射。
 * @param maxChars - 文本字符上限。
 * @returns 消息快照。
 */
export function serializeMessage(
  message: SourceMessage,
  toolNames: Map<string, string>,
  maxChars: number | undefined,
): CapturedMessage {
  const role = normalizeRole(message.role)

  // 可见文本：拼接所有 text 块。图片/文件块不是文本，不折进 text（那会丢掉引用语义）。
  let visible = ''
  // 思考文本：拼接所有 reasoning 块。
  let reasoning = ''
  for (const block of message.content ?? []) {
    if (typeof block.text !== 'string') continue
    if (block.type === 'text') visible += block.text
    else if (block.type === 'reasoning') reasoning += block.text
  }

  const truncatedText = truncateText(visible, maxChars)
  const captured: CapturedMessage = {
    role,
    text: truncatedText.text,
    chars: truncatedText.text.length,
  }

  // reasoning 只在确实存在时出现（无 reasoning 的消息不带这两个键）。
  if (reasoning.length > 0) {
    const truncatedReasoning = truncateText(reasoning, maxChars)
    captured.reasoning = truncatedReasoning.text
    captured.reasoningChars = truncatedReasoning.text.length
  }

  // toolName 是 best-effort：取不到就不写这个键，而不是写空串。
  if (role === 'tool' && typeof message.toolCallId === 'string') {
    const name = toolNames.get(message.toolCallId)
    if (name !== undefined) captured.toolName = name
  }

  if (truncatedText.truncated) {
    captured.truncated = true
    captured.originalChars = truncatedText.originalChars
  }

  return captured
}

/**
 * 把整个消息数组转成快照数组，**保持原始顺序**。
 *
 * @param messages - 原始消息数组。
 * @param options - 序列化选项。
 * @returns 消息快照数组。
 */
export function serializeMessages(
  messages: readonly SourceMessage[],
  options: SerializeOptions = {},
): CapturedMessage[] {
  const toolNames = buildToolNameIndex(messages)
  return messages.map(message => serializeMessage(message, toolNames, options.maxChars))
}

/**
 * 聚合统计。
 *
 * - `chars` = 所有 `text.length` 之和（不含 reasoning）
 * - `reasoningChars` = 所有 `reasoning.length` 之和（与 `chars` 互斥）
 * - `systemChars` = role==="system" 的 `text.length` 之和（是 `chars` 的子集）
 *
 * @param messages - 消息快照。
 * @returns 聚合统计。
 */
export function computeTotals(messages: readonly CapturedMessage[]): CaptureTotals {
  let chars = 0
  let reasoningChars = 0
  let systemChars = 0
  for (const message of messages) {
    chars += message.chars
    reasoningChars += message.reasoningChars ?? 0
    if (message.role === 'system') systemChars += message.chars
  }
  return { messages: messages.length, chars, reasoningChars, systemChars }
}
