// 发送投影引擎：把编号单位的状态变化写进 surface。
//
// ===========================================================================
// 为什么必须写 surface
// ===========================================================================
//
// `llm/stream` 拿到的 messages 被 deepFreeze + Object.freeze（agent-loop 里做的），
// 无法修改；`pre-step` 的 decision.messages 只含**本步进入**的消息，改不了历史。
//
// 所以唯一能改变「模型看到的历史」的通道是 surface：
//   session.append(type, data, { surfaceOp: { op:'replace', startSeq, endSeq }, sourceEventSeqs })
// dsh 自家压缩也走这条路。
//
// ===========================================================================
// 投影做什么
// ===========================================================================
//
// 对每个已编号单位，按当前状态决定它在发送视图里的形态：
//   近程 + 有 summary → `#N <summary>…</summary>` + content
//   远程 + 有 summary → `#N <summary>…</summary>`
//   无 summary        → `#N` + content
//   user 单位          → `#N` + content（永不衰减）
//
// 只有当目标形态与上次写入的不同时才 append（避免每步都写）。

import type { UnitResult } from '../types.js'
import type { Fold } from '../types-modules.js'
import { isRecent } from '../projection/render.js'

/** 一个单位在发送视图中的目标形态。 */
export interface ProjectionPlan {
  /** 单位编号 */
  idx: number
  /** 目标的发送文本 */
  text: string
  /** 是否需要写入（与上次不同） */
  needsWrite: boolean
}

/** 已渲染内容的缓存（避免重复写入 surface）。 */
export interface RenderCache {
  get(sessionId: string, idx: number): string | undefined
  set(sessionId: string, idx: number, text: string): void
  clear(sessionId: string): void
}

/** 内存实现的渲染缓存。 */
export class MemoryRenderCache implements RenderCache {
  private readonly map = new Map<string, Map<number, string>>()

  get(sessionId: string, idx: number): string | undefined {
    return this.map.get(sessionId)?.get(idx)
  }

  set(sessionId: string, idx: number, text: string): void {
    let m = this.map.get(sessionId)
    if (!m) {
      m = new Map()
      this.map.set(sessionId, m)
    }
    m.set(idx, text)
  }

  clear(sessionId: string): void {
    this.map.delete(sessionId)
  }
}

/**
 * 计算一个单位的发送文本。
 *
 * @param unit - 编号单位。
 * @param recent - 是否在近程窗口内。
 */
export function projectUnit(unit: UnitResult, recent: boolean): string {
  const head = `#${unit.idx}`

  // user 永不衰减
  if (unit.kind === 'user') return `${head} ${unit.content}`

  const hasSummary = unit.summary.trim().length > 0

  if (recent) {
    return hasSummary
      ? `${head} <summary>${unit.summary}</summary>\n<content>${unit.content}</content>`
      : `${head} ${unit.content}`
  }

  // 远程
  return hasSummary ? `${head} <summary>${unit.summary}</summary>` : `${head} ${unit.content}`
}

/**
 * 为一个会话的所有单位计算投影计划。
 *
 * @param units - 该会话的单位（按编号升序）。
 * @param sessionId - 会话 id。
 * @param latestIdx - 最新编号。
 * @param window - 近程窗口大小。
 * @param cache - 渲染缓存（用于判断是否需要写入）。
 * @param foldedRanges - 已折叠的区间（折叠体本身单独渲染，区间内单位不渲染）。
 */
export function planProjection(
  units: readonly UnitResult[],
  sessionId: string,
  latestIdx: number,
  window: number,
  cache: RenderCache,
  foldedRanges: ReadonlyArray<{ fromIdx: number; toIdx: number }> = [],
): ProjectionPlan[] {
  const folded = new Set<number>()
  for (const r of foldedRanges) {
    for (let i = r.fromIdx; i <= r.toIdx; i += 1) folded.add(i)
  }

  const plans: ProjectionPlan[] = []
  for (const unit of units) {
    // 已折叠的单位不单独渲染（由折叠体代表）
    if (folded.has(unit.idx)) continue

    const recent = isRecent(unit.idx, latestIdx, window)
    const text = projectUnit(unit, recent)
    const previous = cache.get(sessionId, unit.idx)
    plans.push({ idx: unit.idx, text, needsWrite: previous !== text })
  }
  return plans
}

/**
 * 渲染折叠体在发送视图中的文本。
 *
 * @param fold - 折叠体。
 */
export function projectFold(fold: Fold): string {
  return `#${fold.fromIdx}~#${fold.toIdx} [${fold.name || '已折叠'}] ${fold.foldSummary}`
}

/**
 * 构造一条 surface replace 事件的数据。
 *
 * 用 user/message 承载——它是 surface-eligible 且不会触发 assistant 特定的协调逻辑。
 *
 * @param text - 要展示的文本。
 */
export function buildReplaceMessage(text: string): {
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: string }
} {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    // 程序内部标记：这类消息不属于对话内容，不应被重新提取成单位
    source: { kind: 'memory-projection' },
  }
}
