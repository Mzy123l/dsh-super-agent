// 从「实际传给模型的上下文」提取编号单位。
//
// 单位划分（见 docs/A7-memory-design-final.md §1）：
//   user 消息          → 一号（kind='user'）
//   assistant 思考块    → 一号（kind='thinking'）
//   一次工具调用+结果   → 合并一号（kind='tool'）
//   assistant 正文      → 一号（kind='reply'）
//   system / developer → 不占编号
//
// 工具单位内部用标签区分调用与结果：
//   <tool-call name="bash">参数</tool-call>
//   <tool-result isError="false">输出</tool-result>

import type { ContextMessage, Unit, UnitKind } from '../types.js'

/** 内容块的最小形状。 */
interface Block {
  type?: string
  text?: unknown
  id?: string
  name?: string
  arguments?: string
}

/** 取出内容里的块数组。 */
export function blocksOf(content: unknown): Block[] {
  if (!Array.isArray(content)) return []
  return content.filter((b): b is Block => b !== null && typeof b === 'object')
}

/** 拼接内容里的全部 text 块。 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  return blocksOf(content)
    .filter(b => typeof b.text === 'string')
    .map(b => (b.text as string).trim())
    .filter(t => t.length > 0)
    .join('\n')
}

/**
 * 判断消息是否参与编号（system/developer/tool 消息不单独成单位）。
 *
 * 提炼指令（source.kind = 'memory-summary-prompt'）也排除：
 * 它是程序注入的一次性 user 消息，用完即弃，不是对话内容，
 * 不该占编号、不该按「user 永不衰减」保留。
 */
export function shouldIndex(message: ContextMessage): boolean {
  if (message.source?.kind === 'memory-summary-prompt') return false
  return message.role !== 'system' && message.role !== 'developer' && message.role !== 'tool'
}

/** 归一化单位类型。 */
export function kindOf(message: ContextMessage): UnitKind {
  return message.role === 'user' ? 'user' : 'reply'
}

/**
 * 构造工具单位的正文。
 *
 * @param name - 工具名。
 * @param args - 调用参数（原始 JSON 字符串）。
 * @param result - 结果正文。
 * @param isError - 结果是否失败。
 */
export function composeToolContent(name: string, args: string, result: string, isError: boolean): string {
  return [
    `<tool-call name="${name}">`,
    args,
    `</tool-call>`,
    `<tool-result isError="${isError ? 'true' : 'false'}">`,
    result,
    `</tool-result>`,
  ].join('\n')
}

/**
 * 把一批上下文消息拆成编号单位（未分配 idx）。
 *
 * 工具调用按 callId 与其结果合并；没有结果的调用也独立成单位。
 *
 * @param messages - 实际发送给模型的消息。
 * @param at - 记录时刻。
 * @param sessionId - 会话 id。
 * @param isConsumedReply - 判断某段 assistant 文本是否是已用过的提炼回复；
 *   提供时这类消息不入库（它们是一次性产物，不该占编号）。
 * @returns 单位列表（按出现顺序）。
 */
export function extractUnits(
  messages: readonly ContextMessage[],
  at: string,
  sessionId: string,
  isConsumedReply?: (text: string) => boolean,
): Array<Omit<Unit, 'idx'>> {
  const units: Array<Omit<Unit, 'idx'>> = []

  // 收集工具结果，按 callId 归组
  const resultOf = new Map<string, { text: string; isError: boolean }>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const callId = message.source?.callId ?? message.toolCallId
    if (typeof callId !== 'string') continue
    resultOf.set(callId, {
      text: textOf(message.content),
      isError: message.isError === true,
    })
  }

  for (const message of messages) {
    if (!shouldIndex(message)) continue

    // user 消息：整条一个单位
    if (message.role === 'user') {
      const text = textOf(message.content)
      if (text.length === 0) continue
      units.push({ sessionId, kind: 'user', summary: '', content: text, at, inContext: true, tags: [] })
      continue
    }

    // assistant：思考 / 工具调用 / 正文各自成单位
    for (const block of blocksOf(message.content)) {
      if (block.type === 'reasoning' && typeof block.text === 'string') {
        const text = block.text.trim()
        if (text.length === 0) continue
        units.push({ sessionId, kind: 'thinking', summary: '', content: text, at, inContext: true, tags: [] })
        continue
      }
      if (block.type === 'tool-call' && typeof block.id === 'string') {
        const result = resultOf.get(block.id)
        units.push({
          sessionId,
          kind: 'tool',
          summary: '',
          content: composeToolContent(
            block.name ?? 'unknown',
            block.arguments ?? '',
            result?.text ?? '',
            result?.isError ?? false,
          ),
          at,
          inContext: true,
          tags: [],
        })
        continue
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim()
        if (text.length === 0) continue
        // 已用过的提炼回复不入库：它是一次性产物，不该占编号
        if (isConsumedReply?.(text) === true) continue
        units.push({ sessionId, kind: 'reply', summary: '', content: text, at, inContext: true, tags: [] })
      }
    }
  }

  return units
}

/** 关闭标签到「单位类型」的映射（用于发送投影）。 */
export function labelOf(kind: UnitKind): string {
  switch (kind) {
    case 'thinking': return '思考'
    case 'tool': return '工具调用'
    case 'reply': return '回复'
    default: return '用户'
  }
}
