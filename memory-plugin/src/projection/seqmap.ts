// 单位编号 → 真实 seq 的映射。
//
// 投影要写 surface replace，需要知道每个单位对应哪些 seq。
// 用 eventAt(seq) 逐条读（未废弃的接口），按内容匹配。
//
// 缓存：同一会话内已解析的映射复用，避免每步重扫。

import type { UnitResult } from '../types.js'

/** 会话的最小读取接口（eventAt 未废弃）。 */
export interface SeqReader {
  /** 当前事件总数（seq 上界） */
  readonly seq?: number
  eventAt(seq: number): unknown
}

/** 一个单位对应的 seq 范围。 */
export interface SeqSpan {
  readonly idx: number
  /** 该单位覆盖的 seq（升序、去重） */
  readonly seqs: number[]
}

/** 从事件里取出可见文本（用于匹配）。 */
function eventText(event: unknown): string {
  const e = event as {
    type?: string
    data?: {
      content?: Array<{ type?: string; text?: string }>
      message?: { content?: Array<{ type?: string; text?: string }> }
    }
  }
  const blocks = e.data?.content ?? e.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
    .trim()
}

/** 从事件里取出角色。 */
function eventRole(event: unknown): string | undefined {
  const e = event as { type?: string; data?: { role?: string } }
  if (e.type === 'user/message') return 'user'
  if (e.type === 'assistant/message') return 'assistant'
  if (e.type === 'tool/result') return 'tool'
  return e.data?.role
}

/** 判断事件是否进入 surface。 */
function isSurfaceEvent(event: unknown): boolean {
  const e = event as { surfaceOp?: unknown }
  return e.surfaceOp !== undefined
}

/**
 * 建立「单位编号 → seq 列表」映射。
 *
 * 逐条读事件，按 (role, text) 与单位匹配。
 *
 * @param reader - 会话读取接口。
 * @param units - 该会话的单位。
 * @param cache - 已解析的映射（可复用）。
 * @returns 每个单位的 seq 范围。
 */
export function mapUnitSeqs(
  reader: SeqReader,
  units: readonly UnitResult[],
  cache?: Map<number, SeqSpan>,
): SeqSpan[] {
  const upper = typeof reader.seq === 'number' ? reader.seq : 0
  const byKey = new Map<string, number[]>()

  for (let seq = 0; seq < upper; seq += 1) {
    let event: unknown
    try {
      event = reader.eventAt(seq)
    } catch {
      continue
    }
    if (!event || !isSurfaceEvent(event)) continue
    const role = eventRole(event)
    const text = eventText(event)
    if (!role || text.length === 0) continue
    const key = `${role}:${text}`
    const list = byKey.get(key)
    if (list) list.push(seq)
    else byKey.set(key, [seq])
  }

  const spans: SeqSpan[] = []
  for (const unit of units) {
    const cached = cache?.get(unit.idx)
    if (cached) {
      spans.push(cached)
      continue
    }
    // 单位内容可能含标签（tool 单位），按前缀匹配
    const probe = unit.content.slice(0, 120)
    let found: number[] | undefined
    for (const [key, seqs] of byKey) {
      const text = key.slice(key.indexOf(':') + 1)
      if (text.includes(probe) || probe.includes(text.slice(0, 80))) {
        found = seqs
        break
      }
    }
    if (found && found.length > 0) {
      const span: SeqSpan = { idx: unit.idx, seqs: found }
      spans.push(span)
      cache?.set(unit.idx, span)
    }
  }
  return spans
}
