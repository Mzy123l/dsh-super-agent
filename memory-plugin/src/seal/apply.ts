// 把封存段应用到会话表面。
//
// 这是「总结」真正生效的地方：把一段历史替换成一个带槽位的事件。
//
// ===========================================================================
// 两条硬性约束
// ===========================================================================
//
// 1. **replace 必须完整列出被遮蔽的节点**
//    实测报错：`surface replace: sourceEventSeqs must include every shadowed surface node`
//    → 必须从会话真实 surface 读，不能凭区间猜。
//
// 2. **「请提炼」这条 user prompt 只出现一次，不回传**
//    用户原话：「这个 user prompt 不回传，只出现一次，不要上下文中全是这一条信息」
//    → 触发提炼的那条提示，在提炼完成后必须被遮蔽掉，不能留在历史里。

import type { Context } from '@deepseek-ai/cordis'
import type { Segment } from './types.js'
import { composeSlottedText } from './types.js'

/** 会话里用得到的部分能力（收窄，不依赖 dsh 类型）。 */
interface SessionLike {
  id?: string
  append?: (type: string, data: unknown, opts?: unknown) => unknown
  snapshotEvents?: () => Array<{ seq: number; type?: string; surfaceOp?: unknown }>
  ownEvents?: () => Array<{ seq: number; type?: string; surfaceOp?: unknown }>
  events?: Array<{ seq: number; type?: string; surfaceOp?: unknown }>
}

/** sessions 服务的最小形状。 */
interface SessionsLike {
  get?: (id: string) => SessionLike | undefined
}

/**
 * 取出某 seq 区间内、当前仍可见的 surface 节点 seq。
 *
 * dsh 要求 `sourceEventSeqs` 完整列出被遮蔽的每个节点，所以必须读真实 surface。
 *
 * @returns 升序去重的 seq 列表；区间内没有可见节点时返回 undefined。
 */
export function collectShadowedSeqs(
  session: SessionLike,
  fromSeq: number,
  toSeq: number,
): number[] | undefined {
  let all: Array<{ seq: number; surfaceOp?: unknown }> | undefined
  if (typeof session.snapshotEvents === 'function') all = session.snapshotEvents()
  else if (typeof session.ownEvents === 'function') all = session.ownEvents()
  else if (Array.isArray(session.events)) all = session.events
  if (!Array.isArray(all)) return undefined

  const seqs = all
    .filter(e => typeof e?.seq === 'number' && e.seq >= fromSeq && e.seq <= toSeq && e.surfaceOp !== undefined)
    .map(e => e.seq)

  const unique = [...new Set(seqs)].sort((a, b) => a - b)
  return unique.length > 0 ? unique : undefined
}

/** 构造用于替换的那个事件（带槽位）。 */
function buildSegmentEvent(segment: Segment) {
  const slots = [
    // recent 为空（archived 阶段）时不输出该槽
    { kind: 'recent' as const, text: segment.recent },
    { kind: 'summary' as const, text: segment.summary },
  ]
  const text = composeSlottedText(slots)
  return {
    type: 'user/message' as const,
    data: {
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      // 自定义 source.kind：让采集插件与模型都能识别这是记忆合并体
      source: { kind: 'memory-slot' },
    },
  }
}

/**
 * 把一段封存应用到会话。
 *
 * @param ctx - 插件上下文（取 sessions 服务）。
 * @param segment - 段内容。若是 archived 阶段，则只带 summary 槽。
 * @throws 拿不到会话、区间内无可见节点、或 append 抛错时。
 *         抛错时段的记录仍留在库里，可在下一轮重试。
 */
export function applySegment(ctx: Context, segment: Segment): void {
  const sessions = (ctx as unknown as { sessions?: SessionsLike }).sessions
  const session = sessions?.get?.(segment.sessionId)
  if (!session || typeof session.append !== 'function') {
    throw new Error(`session ${segment.sessionId} is not reachable for sealing`)
  }

  const shadowed = collectShadowedSeqs(session, segment.fromSeq, segment.toSeq)
  if (!shadowed || shadowed.length === 0) {
    throw new Error(
      `no surface nodes in seq ${segment.fromSeq}–${segment.toSeq} of session ${segment.sessionId}; `
      + 'nothing would be shadowed, so the seal is refused',
    )
  }

  const { type, data } = buildSegmentEvent(segment)
  session.append(type, data, {
    surfaceOp: { op: 'replace', startSeq: segment.fromSeq, endSeq: segment.toSeq },
    sourceEventSeqs: shadowed,
  })
}

/**
 * 遮蔽一条「已经用过的提示」。
 *
 * 用户要求：触发提炼的 user prompt 只出现一次，不回传。
 * 做法：在提炼完成后，用一条空内容的 replace 事件把那条提示的 seq 遮蔽掉。
 *
 * @param ctx - 插件上下文。
 * @param sessionId - 会话 id。
 * @param promptSeq - 那条提示的 seq。
 * @throws 当会话不可达或该 seq 无可见节点时。
 */
export function hidePromptAfterUse(ctx: Context, sessionId: string, promptSeq: number): void {
  const sessions = (ctx as unknown as { sessions?: SessionsLike }).sessions
  const session = sessions?.get?.(sessionId)
  if (!session || typeof session.append !== 'function') {
    throw new Error(`session ${sessionId} is not reachable to hide prompt`)
  }

  const visible = collectShadowedSeqs(session, promptSeq, promptSeq)
  if (!visible) {
    // 已经被遮蔽过——不重复处理，静默返回。
    return
  }

  // 用一条极简占位替换，模型不会再看到长篇提示。
  session.append(
    'user/message',
    {
      role: 'user',
      content: [{ type: 'text', text: '（已完成的提炼指令，不再显示）' }],
      source: { kind: 'memory-prompt-hidden' },
    },
    {
      surfaceOp: { op: 'replace', startSeq: promptSeq, endSeq: promptSeq },
      sourceEventSeqs: visible,
    },
  )
}
