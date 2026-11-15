// 把封存段应用到会话 surface：这是「再前面的只有总结」的执行点。
//
// 关键机制：`session.append(type, data, { surfaceOp })`。
// 一条 `surfaceOp: { op:'replace', startSeq, endSeq }` 的事件会**遮蔽**该区间，
// 模型之后只看到新事件的内容；旧事件仍留在日志里，可回放、可检索。
//
// 依据：`dsh-session/lib/types/surface.js:190` `isReplaceOp`
//   —— replace 恰好 3 个键 `{op, startSeq, endSeq}`，两个 seq 必须是非负安全整数。
//
// 我们不使用 dsh 官方的 compaction 包：这里的替换由本插件自己发起。

import type { Context } from '@deepseek-ai/cordis'
import type { SealedSegment } from './types.js'
import { buildSealEvent } from './types.js'

/** 从会话对象里能拿到的能力（收窄，避免依赖 dsh 类型）。 */
interface SessionLike {
  id?: string
  append?: (type: string, data: unknown, opts?: unknown) => unknown
  snapshotEvents?: () => Array<{ seq: number; surfaceOp?: unknown }>
  ownEvents?: () => Array<{ seq: number; surfaceOp?: unknown }>
  events?: Array<{ seq: number; surfaceOp?: unknown }>
}

/** session 服务的最小形状。 */
interface SessionsLike {
  get?: (id: string) => SessionLike | undefined
}

/**
 * 取会话的 append 能力。
 *
 * dsh 的 `ctx.sessions.get(id)` 返回 Session 实例，其 `append` 是公开方法
 * （`dsh-session/README.zh.md`：`session.append(type, data, opts?)` 提交一个类型化事件）。
 *
 * @returns 成功时返回一个只做 append 的闭包；拿不到会话时返回 undefined。
 */
export function resolveAppender(
  ctx: Context,
  sessionId: string,
): ((type: string, data: unknown, opts?: unknown) => unknown) | undefined {
  const sessions = (ctx as unknown as { sessions?: SessionsLike }).sessions
  const session = sessions?.get?.(sessionId)
  if (!session || typeof session.append !== 'function') return undefined
  return session.append.bind(session)
}

/**
 * 把一段封存应用到会话。
 *
 * 语义：向会话追加一条 user 消息，内容是模型写的总结，并声明它**替换**了
 * `[fromSeq, toSeq]` 这段历史。
 *
 * 注意：这里不删除任何日志，只改变模型可见的 surface——这正是 dsh
 * 「Model-visible means logged」的要求：日志仍可完整回放。
 *
 * @param ctx - 插件上下文（用于取 sessions 服务）。
 * @param segment - 已落库的封存段。
 * @throws 当拿不到会话或 append 抛错时——调用方负责把总结保留在库里。
 */
/**
 * 从会话里取出「某个 seq 区间内、当前仍然可见的 surface 节点 seq」。
 *
 * dsh 的 replace 要求 `sourceEventSeqs` **完整列出被遮蔽的每个节点**
 * （实测报错：`surface replace: sourceEventSeqs must include every shadowed surface node`）。
 * 所以不能凭 `[fromSeq, toSeq]` 猜，必须从会话的真实 surface 里读。
 *
 * 优先用 `session.snapshotEvents()`；不可用时退回 `session.ownEvents()` 再过滤。
 *
 * @returns 升序的 seq 列表；拿不到时返回 undefined。
 */
export function collectShadowedSeqs(
  session: SessionLike,
  fromSeq: number,
  toSeq: number,
): number[] | undefined {
  const s = session as unknown as {
    snapshotEvents?: () => Array<{ seq: number; surfaceOp?: unknown }>
    ownEvents?: () => Array<{ seq: number; surfaceOp?: unknown }>
    events?: Array<{ seq: number; surfaceOp?: unknown }>
  }

  let all: Array<{ seq: number; surfaceOp?: unknown }> | undefined
  if (typeof s.snapshotEvents === 'function') all = s.snapshotEvents()
  else if (typeof s.ownEvents === 'function') all = s.ownEvents()
  else if (Array.isArray(s.events)) all = s.events
  if (!Array.isArray(all)) return undefined

  // 只取「进入过 surface 的事件」（带 surfaceOp），且落在区间内、不在替换事件之后。
  const seqs = all
    .filter(e => typeof e?.seq === 'number' && e.seq >= fromSeq && e.seq <= toSeq && e.surfaceOp !== undefined)
    .map(e => e.seq)
  return seqs.length > 0 ? [...new Set(seqs)].sort((a, b) => a - b) : undefined
}

/**
 * 把一段封存应用到会话。
 *
 * 语义：向会话追加一条 user 消息，内容是模型写的总结，并声明它**替换**了
 * `[fromSeq, toSeq]` 这段历史。
 *
 * 注意：这里不删除任何日志，只改变模型可见的 surface——这正是 dsh
 * 「Model-visible means logged」的要求：日志仍可完整回放。
 *
 * @param ctx - 插件上下文（用于取 sessions 服务）。
 * @param segment - 已落库的封存段。
 * @throws 当拿不到会话、拿不到被遮蔽节点、或 append 抛错时——
 *         调用方负责把总结保留在库里（总结是唯一不可再生的东西）。
 */
export function applySeal(ctx: Context, segment: SealedSegment): void {
  const sessions = (ctx as unknown as { sessions?: SessionsLike }).sessions
  const session = sessions?.get?.(segment.sessionId)
  if (!session || typeof session.append !== 'function') {
    throw new Error(`session ${segment.sessionId} is not reachable for sealing`)
  }

  // dsh 要求精确列出被遮蔽的节点：不能猜，必须读真实 surface。
  const shadowed = collectShadowedSeqs(session, segment.fromSeq, segment.toSeq)
  if (!shadowed || shadowed.length === 0) {
    throw new Error(
      `no surface nodes found in seq ${segment.fromSeq}–${segment.toSeq} of session ${segment.sessionId}; `
      + 'nothing would be shadowed, so the seal is refused',
    )
  }

  const text = formatSealSummary(segment)
  const [type, data, opts] = buildSealEvent(text, segment.fromSeq, segment.toSeq, shadowed)
  session.append(type, data, opts)
}

/**
 * 构造封存总结的展示文本。
 *
 * 加一段机器可读的头部，让模型知道「这是一段已被封存的历史」，
 * 而不是用户刚刚说的话。这也让采集插件能识别它。
 */
export function formatSealSummary(segment: Pick<SealedSegment, 'summary' | 'reason' | 'fromSeq' | 'toSeq' | 'turn'>): string {
  const head = `[sealed segment · turns up to ${segment.turn} · seq ${segment.fromSeq}–${segment.toSeq}]`
  const why = segment.reason ? `\nsealed because: ${segment.reason}` : ''
  return `${head}${why}\n\n${segment.summary}`
}
