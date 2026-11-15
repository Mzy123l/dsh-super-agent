/**
 * before 版的重建：从 after（最终上下文）里减去「本步新增的批次」。
 *
 * ## 为什么不能直接用 pre-step 时刻的派生历史
 *
 * dsh 的时序（`dsh-agent-loop/src/agent.ts`）是：
 *
 * ```
 * preStep() :293  claimed = inbox.claim(...)
 *            :300  assembly = systemPrompt.assemble(...)
 *            :302  waterfall('agent/pre-step', { messages: claimed, turn, step })
 *            :367  session.append('step/start', ...)
 *            :459  commits = systemPrompt.project(renderedPrompt, ...)
 *            :466  session.append('system/message', ...)     ← 系统提示词在这里才进日志
 *            :470  session.append('user/message', ...)       ← 本步消息在这里才进日志
 *            :734  boundaryMessages = session.deriveMessages()
 *            :741  request = { messages: boundaryMessages }
 *            :496  llm.stream(request)                      ← after 栏
 * ```
 *
 * 所以在 pre-step 时刻调用 `deriveMessages()`，拿到的是**上一步结束时的历史**：
 * - **不含**本步的系统提示词（它在 pre-step 之后才投影进 surface）；
 * - **不含**本步的用户消息（它在 pre-step 之后才提交）。
 *
 * 直接用它当 before 栏，会把「系统提示词的差异」误报成「记忆机制的注入量」。
 *
 * ## 本模块的做法（实测验证过）
 *
 * **before = after − 本步新增**。
 *
 * 「本步新增」= pre-step 决策里的批次 **加上** 本步新增/替换的系统提示词节点。
 * 系统提示词节点怎么认？它们是 `system` 角色、**不在** pre-step 时刻的历史里、
 * 但**在** after 里——即 after 相对 pre-step 历史**多出来的** system 消息。
 *
 * 匹配优先用**消息身份**（dsh 的 `Message.id`）：pre-step 决策里的消息与
 * `llm/stream` 里的消息是不同对象，但 `id` 相同。没有 `id` 时退化为
 * 「角色 + 正文」的内容匹配。
 *
 * 减法方向是**从后往前**删：本步新增的消息通常在尾部，避免删错同内容的历史消息。
 */

import type { SourceContentBlock, SourceMessage } from './serialize.js'

/**
 * 取一条消息的可见正文（所有 text 块拼接）。
 *
 * @param message - 消息。
 * @returns 可见正文。
 */
export function visibleText(message: SourceMessage): string {
  let text = ''
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * 一条消息的身份键：优先用 `id`，退化到「角色 + 正文」。
 *
 * @param message - 消息。
 * @returns 身份键。
 */
export function identityOf(message: SourceMessage): string {
  const id = message.id
  if (typeof id === 'string' && id.length > 0) return `id:${id}`
  return `ct:${message.role}:${visibleText(message)}`
}

/**
 * dsh 自有的消息来源（不是插件注入）。
 *
 * - `'user'`：用户自己输入的提示词；
 * - `'system-prompt'`：dsh 渲染的系统提示词；
 * - `'runtime-context'`：dsh 注入的运行时上下文快照（`dsh-agent-loop/src/runtime-context.ts`）；
 * - `'model'`：模型自己产出的回复；
 * - `'tool'`：工具结果。
 *
 * 其余的 `kind` 都是**插件声明的注入**（可扩展的联合类型，见
 * `dsh-llm/src/message.ts:105-112` 的 `MessageSourceMap` 与它的注释：
 * 「each producer declares its own `kind` in its own module; there is no
 * shared catch-all `plugin` kind」）：
 * `'agent-instructions'`、`'model-selection'`、`'schedule'`、`'ptc-mode'` ……
 * 以及记忆插件将来会声明的那一个。
 */
const DSH_OWN_SOURCES = new Set(['user', 'system-prompt', 'runtime-context', 'model', 'tool'])

/**
 * 这条消息是不是 **dsh 自己**产出的（而不是插件注入的）。
 *
 * 判据是 `source.kind`：dsh 的几种自有来源在集合里，其余都是插件注入。
 *
 * @param message - 消息。
 * @returns 是 dsh 自有消息时为 true；没有 `source` 信息时为 undefined（不知道）。
 */
export function ownSourceOf(message: SourceMessage): boolean | undefined {
  const kind = message.source?.kind
  if (typeof kind !== 'string') return undefined
  return DSH_OWN_SOURCES.has(kind)
}

/**
 * 计算「本步新增」的消息集合：after 里有、而 pre-step 时刻的历史里没有的，
 * **且**不是 dsh 自有的消息。
 *
 * 为什么排除 dsh 自有的消息：
 * - 用户输入（`kind: 'user'`）：每步都会有一条用户提示词，它**不是**注入；
 *   算进去会让 before/after 的差异里混进「用户自己的问题」；
 * - 系统提示词（`kind: 'system-prompt'`）：每步都有的固定前缀；
 * - 运行时上下文（`kind: 'runtime-context'`）：dsh 自己注入的上下文快照。
 *
 * 剩下的就是**插件注入的内容**（记忆机制、AGENTS.md 等）——正是 before/after
 * 要对比的东西。
 *
 * 没有 `source` 信息时（消息来自手工构造的调用方）：退化为「在 pre-step
 * 决策的批次里就算新增」——这是保守选择（宁可多减一条，也不要漏掉注入）。
 *
 * @param after - 最终上下文（`llm/stream` 的 messages）。
 * @param history - pre-step 时刻的派生历史。
 * @param stepMessages - pre-step 决策里的本步批次（无 source 时的兜底判据）。
 * @returns 本步新增的消息（保持 after 的顺序）。
 */
export function computeStepAdditions(
  after: readonly SourceMessage[],
  history: readonly SourceMessage[],
  stepMessages: readonly SourceMessage[],
): SourceMessage[] {
  const historyKeys = new Set(history.map(identityOf))
  const stepKeys = new Set(stepMessages.map(identityOf))
  const additions: SourceMessage[] = []
  for (const message of after) {
    const key = identityOf(message)
    // 已在 pre-step 历史里 → 不是本步新增（上一轮就有）。
    if (historyKeys.has(key)) continue
    const own = ownSourceOf(message)
    if (own === true) continue
    // dsh 自有的消息（用户输入 / 系统提示词 / 运行时上下文 / 模型回复 / 工具结果）
    // 每步都有，不算注入。
    if (own === false) {
      additions.push(message)
      continue
    }
    // 没有 source 信息：只有在 pre-step 批次里才算新增（保守兜底）。
    if (stepKeys.has(key)) additions.push(message)
  }
  return additions
}

/**
 * 从 after 里减去「本步新增」，得到 before。
 *
 * 减法按**身份**匹配，**从后往前**删：
 * - 本步新增的消息通常在尾部，从后往前删不会误删同内容的历史消息；
 * - 同一条消息在 after 里出现多次时，只删掉与新增批次匹配的那些次。
 *
 * @param after - 最终上下文。
 * @param additions - 本步新增的消息。
 * @returns 记忆机制介入之前的上下文。
 */
export function subtractAdditions(
  after: readonly SourceMessage[],
  additions: readonly SourceMessage[],
): SourceMessage[] {
  // 每个新增身份需要删几次。
  const pending = new Map<string, number>()
  for (const addition of additions) {
    const key = identityOf(addition)
    pending.set(key, (pending.get(key) ?? 0) + 1)
  }
  const result: SourceMessage[] = []
  for (let i = after.length - 1; i >= 0; i--) {
    const message = after[i]!
    const key = identityOf(message)
    const count = pending.get(key) ?? 0
    if (count > 0) {
      pending.set(key, count - 1)
      continue
    }
    result.push(message)
  }
  result.reverse()
  return result
}
