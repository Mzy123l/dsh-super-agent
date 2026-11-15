// 从「实际传给模型的上下文」提取消息，并按会话线性分配索引。
//
// ===========================================================================
// 为什么不再从会话日志提取
// ===========================================================================
//
// 旧做法是解析 zstd 日志、按事件类型拆成 kind。
// 用户要求改为：**索引的对象就是实际作为上下文传给模型的那批消息**。
//
// 好处：索引与模型看到的完全一致，不会出现「日志里有但模型没见过」
// 或「模型见过但日志里没有」的偏差。
//
// ===========================================================================
// 索引分配规则（线性、完整、无空洞）
// ===========================================================================
//
//   每个会话独立一套：0, 1, 2, 3 … 连续递增。
//   第 0 条 = 该会话的**第一个 user prompt**（不是 system）。
//   system 消息不占索引（它是固定的框架，模型不需要查它）。
//
//   幂等：同一会话内同角色同正文 → 复用原编号。
//   遮蔽：从上下文消失的消息编号保留，只把 in_context 置 0。

import type { MemoryStore } from '../store/sqlite.js'
import type { MessageRecord, Role } from '../types.js'

/** 上下文里的一条消息（dsh 的形状）。 */
export interface ContextMessage {
  role?: string
  content?: unknown
  source?: { kind?: string }
}

/**
 * 从一条 dsh 上下文消息里取出可见文本。
 *
 * 只取 text 块——思考块（reasoning）也是 text 内容，
 * 但用户要求「不区分类型」，所以一并纳入。
 *
 * @param message - dsh 的消息对象。
 * @returns 拼接后的正文；无文本时返回空串。
 */
export function visibleText(message: ContextMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: unknown }
      if (typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('\n').trim()
}

/** 判断一条上下文消息是否应当被索引。 */
export function shouldIndex(message: ContextMessage): boolean {
  // system 与 developer 是框架内容，不占索引
  if (message.role === 'system' || message.role === 'developer') return false
  return visibleText(message).length > 0
}

/**
 * 把一个会话的完整上下文同步进库。
 *
 * 按顺序遍历，逐条分配索引（库内已有则复用）。
 * 不在本次上下文里的历史消息，其 in_context 会被置 0。
 *
 * @param store - 存储。
 * @param sessionId - 会话 id。
 * @param messages - 当前实际传给模型的完整消息列表。
 * @param at - 记录时刻（ISO 8601）。
 * @returns 本次涉及的消息数与索引范围。
 */
export function syncContext(
  store: MemoryStore,
  sessionId: string,
  messages: readonly ContextMessage[],
  at: string,
): { indexed: number; added: number; range?: { min: number; max: number } } {
  const seen: number[] = []
  let added = 0

  for (const message of messages) {
    if (!shouldIndex(message)) continue
    const text = visibleText(message)
    const role = normalizeRole(message.role)
    const before = store.count(sessionId)
    const idx = store.appendMessage({
      sessionId,
      role,
      text,
      at,
      inContext: true,
      tags: [],
    } satisfies Omit<MessageRecord, 'idx'>)
    if (store.count(sessionId) > before) added += 1
    seen.push(idx)
  }

  // 本次上下文没出现的消息 → 标记为已离开上下文（编号保留）
  if (seen.length > 0) {
    const maxIdx = Math.max(...seen)
    const inThisPass = new Set(seen)
    for (let i = 0; i <= maxIdx; i += 1) {
      if (!inThisPass.has(i)) store.markOutOfContext(sessionId, i, i)
    }
  }

  return {
    indexed: seen.length,
    added,
    range: store.indexRange(sessionId),
  }
}

/** 归一化角色。 */
export function normalizeRole(role: string | undefined): Role {
  switch (role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'tool': return 'tool'
    default: return 'system'
  }
}

/**
 * 给上下文消息加上 `#N` 索引标记。
 *
 * 这是「索引作为 token 传给模型」的落地：每条消息的正文前缀 `#N`，
 * 模型读到上下文就能看到编号，检索结果也用同一编号回指。
 *
 * **就地修改**传入的消息对象（dsh 的 messages 数组元素在 pre-step 阶段
 * 尚未被冻结；llm/stream 阶段是冻结的，所以标注必须在 pre-step 完成）。
 *
 * @param messages - dsh 上下文消息数组（就地修改）。
 * @param store - 用于查每条消息的索引。
 * @param sessionId - 会话 id。
 * @returns 被标注的消息数。
 */
export function labelInPlace(
  messages: ContextMessage[],
  store: MemoryStore,
  sessionId: string,
): number {
  let labeled = 0
  for (const message of messages) {
    if (!shouldIndex(message)) continue
    const text = visibleText(message)
    if (text.length === 0) continue
    const role = normalizeRole(message.role)
    const idx = findIdx(store, sessionId, role, text)
    if (idx === undefined) continue

    // 把第一个 text 块的正文改成 `#N 原文`（只标注一次，幂等）
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string; prefixed?: boolean }
        if (b.type === 'text' && typeof b.text === 'string' && !b.prefixed) {
          b.text = `#${idx} ${b.text}`
          b.prefixed = true
          labeled += 1
          break
        }
      }
    }
  }
  return labeled
}

/** 在库里查某条消息的索引。 */
function findIdx(store: MemoryStore, sessionId: string, role: Role, text: string): number | undefined {
  const row = store.raw
    .prepare(`SELECT idx FROM message WHERE sessionId = ? AND role = ? AND text = ? LIMIT 1`)
    .get(sessionId, role, text) as { idx: number } | undefined
  return row?.idx
}
