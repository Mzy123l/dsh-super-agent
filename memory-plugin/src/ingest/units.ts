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
 * 不参与编号的来源标记（程序注入的一次性产物）。
 *
 * 这些消息都不是"人说的话"，却都长着 user 的脸。一旦进入编号，就会按
 * 「user 永不衰减」永久占据上下文——这正是实测里 #1–#4 永久赖着的原因。
 *
 *   memory-summary-prompt  提炼指令
 *   memory-plan-view       规划视图
 *   memory-projection      发送投影的替换文本
 *   runtime-context        运行时上下文快照（dsh-agent-loop）
 *   agent-instructions     agent 指令提醒（dsh-agent-instructions）
 *   time-context           时间快照（dsh-time-context）
 */
const ONE_SHOT_SOURCES = new Set([
  'memory-summary-prompt',
  'memory-plan-view',
  'memory-projection',
  'runtime-context',
  'agent-instructions',
  'time-context',
])

/**
 * 不参与编号的文本前缀（框架注入消息）。
 *
 * 按标记排是第一道闸；有些框架消息的 source 未必带上可识别的 kind，
 * 所以再按已知前缀兜一道。这些都是"照着格式生成"的固定开头。
 */
const ONE_SHOT_PREFIXES = [
  '<system-reminder>',
  'Time sampled while preparing',
  'Generate the session title',
]

/** 判断是否为程序注入的一次性产物（按来源标记或文本前缀）。 */
export function isOneShotInjected(message: ContextMessage): boolean {
  const kind = message.source?.kind
  if (typeof kind === 'string' && ONE_SHOT_SOURCES.has(kind)) return true

  const text = textOf(message.content)
  if (text.length === 0) return false
  return ONE_SHOT_PREFIXES.some(p => text.startsWith(p))
}

/**
 * 判断消息是否参与编号（system/developer/tool 消息不单独成单位）。
 *
 * 程序注入的一次性产物一律排除：它们用完即弃，不是对话内容，
 * 不该占编号、更不该按「user 永不衰减」保留。
 */
export function shouldIndex(message: ContextMessage): boolean {
  if (isOneShotInjected(message)) return false
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
 * 判断一条 assistant 消息是否属于「提炼那一轮」。
 *
 * 一次 assistant 消息里会同时含 reasoning 块与 text 块。模型执行提炼任务时，
 * 它的思考（"The user wants me to condense unit #19..."）与提炼结果正文
 * 在**同一条消息**里。若只按正文过滤，思考会漏进编号，于是：
 * 提炼产生单位 → 新单位又长到需要提炼 → 再产生单位，提炼自己喂自己。
 *
 * 所以必须在**整条消息**这一级判断：只要这条消息里有一段正文是已用过的
 * 提炼回复，整条消息（含 reasoning、tool-call）都不入库。
 *
 * @param message - assistant 消息。
 * @param isConsumedReply - 正文指纹判断。
 */
function isSummaryTurnMessage(
  message: ContextMessage,
  isConsumedReply?: (text: string) => boolean,
): boolean {
  if (isConsumedReply === undefined) return false
  for (const block of blocksOf(message.content)) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    if (isConsumedReply(block.text.trim())) return true
  }
  return false
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
 *   命中时**整条 assistant 消息**不入库（含其思考与工具调用）。
 * @param summaryInFlight - 该会话是否正处于「已注入提炼指令、尚未收割」的窗口；
 *   为真时跳过所有 assistant 消息，作为整轮排除的兜底（指纹尚未登记时的保护）。
 * @returns 单位列表（按出现顺序）。
 */
export function extractUnits(
  messages: readonly ContextMessage[],
  at: string,
  sessionId: string,
  isConsumedReply?: (text: string) => boolean,
  summaryInFlight?: boolean,
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

    // 提炼那一轮：整条 assistant 消息都不入库（思考 + 正文 + 工具调用）
    if (summaryInFlight === true) continue
    if (isSummaryTurnMessage(message, isConsumedReply)) continue

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
