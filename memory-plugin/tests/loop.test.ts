// 消息循环测试。
//
// 这是之前完全缺失的部分：engine.ts 写出来了，但从没被测试验证过。
//
// 验证三件事：
// 1. 注入：找到该提炼的区间 → 记 awaiting → 返回 injected
// 2. 收割：有更新的 assistant 消息 → 落库为段 → 清 awaiting → 返回 harvested
// 3. 边界：过期、空回复、无候选区间

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import DatabaseConstructor from 'better-sqlite3'
import { SegmentStore } from '../src/seal/store.js'
import { PendingStore } from '../src/loop/store.js'
import { runLoopStep, PENDING_TTL_MS, type AssistantSnapshot, type LoopHost } from '../src/loop/engine.js'
import type { Segment } from '../src/seal/types.js'
import type { SpanEvent } from '../src/seal/spans.js'

/** 造事件：每轮 2 个事件，每个 5000 字符（都超过 should-summarize 阈值）。 */
function makeEvents(turns: number, charsPerEvent = 5000): SpanEvent[] {
  const out: SpanEvent[] = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    for (let i = 0; i < 2; i += 1) {
      out.push({ seq: seq++, turn, chars: charsPerEvent })
    }
  }
  return out
}

describe('runLoopStep', () => {
  let db: ReturnType<typeof DatabaseConstructor>
  let segments: SegmentStore
  let pending: PendingStore
  let applied: Segment[]
  let warnings: string[]

  /** 造一个 host，默认 10 轮、保留 3 轮。 */
  function host(over: Partial<LoopHost> = {}): LoopHost {
    return {
      segments,
      pending,
      latestTurn: () => 10,
      eventsOf: () => makeEvents(10),
      lastAssistant: () => undefined,
      apply: (segment) => { applied.push(segment) },
      keepTurns: 3,
      autoSummarize: true,
      warn: (m) => { warnings.push(m) },
      ...over,
    }
  }

  beforeEach(() => {
    db = DatabaseConstructor(':memory:')
    segments = new SegmentStore(db)
    pending = new PendingStore(db)
    applied = []
    warnings = []
  })

  afterEach(() => {
    db.close()
  })

  it('没有 awaiting 且找到长区间 → 注入', () => {
    const action = runLoopStep('s', host())
    expect(action.kind).toBe('injected')
    if (action.kind !== 'injected') return
    // 10 轮保留 3 → cutoff=7，第一个候选是 turn 1
    expect(action.fromSeq).toBe(0)
    expect(action.toSeq).toBe(1)
    expect(action.promptText).toContain('提炼')
    // awaiting 已记下
    expect(pending.getAwaiting('s')?.fromSeq).toBe(0)
  })

  it('区间都很短时不注入', () => {
    const action = runLoopStep('s', host({ eventsOf: () => makeEvents(10, 100) }))
    expect(action.kind).toBe('idle')
    expect(pending.getAwaiting('s')).toBeUndefined()
  })

  it('autoSummarize 关闭时不注入', () => {
    const action = runLoopStep('s', host({ autoSummarize: false }))
    expect(action.kind).toBe('idle')
    expect(action).toMatchObject({ reason: 'auto summarize disabled' })
  })

  it('没有轮次时不注入', () => {
    const action = runLoopStep('s', host({ latestTurn: () => 0 }))
    expect(action.kind).toBe('idle')
  })

  it('有 awaiting 但没有新回复 → 保持等待', () => {
    // 先注入一次
    runLoopStep('s', host())
    // 再跑：没有 assistant 消息
    const action = runLoopStep('s', host())
    expect(action.kind).toBe('idle')
    expect(action).toMatchObject({ reason: 'waiting for the summary reply' })
    // awaiting 未被清除
    expect(pending.getAwaiting('s')).toBeDefined()
  })

  it('有 awaiting 且有新回复 → 收割并落库', () => {
    runLoopStep('s', host())
    const awaiting = pending.getAwaiting('s')!
    const reply: AssistantSnapshot = {
      text: '否决 A：因为鉴权冲突\n否决 B：因为延迟\n最终：D',
      seq: 100,
      at: new Date(Date.parse(awaiting.createdAt) + 1000).toISOString(),
    }
    const action = runLoopStep('s', host({ lastAssistant: () => reply }))

    expect(action.kind).toBe('harvested')
    if (action.kind !== 'harvested') return
    // 段已落库
    const stored = segments.get('s', action.segmentNo)
    expect(stored?.summary).toContain('否决 A')
    expect(stored?.summary).toContain('最终：D')
    // apply 被调用
    expect(applied).toHaveLength(1)
    expect(applied[0]?.summary).toContain('否决 A')
    // awaiting 已清
    expect(pending.getAwaiting('s')).toBeUndefined()
  })

  it('收割的遮蔽范围覆盖提示位置（用 assistant seq 做上界）', () => {
    runLoopStep('s', host())
    const awaiting = pending.getAwaiting('s')!
    const reply: AssistantSnapshot = {
      text: '提炼结果',
      seq: 200,
      at: new Date(Date.parse(awaiting.createdAt) + 1000).toISOString(),
    }
    const action = runLoopStep('s', host({ lastAssistant: () => reply }))
    if (action.kind !== 'harvested') throw new Error('expected harvested')
    // toSeq 应取 max(区间末尾, assistant seq) = 200
    expect(action.toSeq).toBe(200)
  })

  it('assistant 回复早于 awaiting 时不算数（收的是历史消息）', () => {
    runLoopStep('s', host())
    const awaiting = pending.getAwaiting('s')!
    const stale: AssistantSnapshot = {
      text: '这是很早以前的消息',
      seq: 5,
      at: new Date(Date.parse(awaiting.createdAt) - 60000).toISOString(),
    }
    const action = runLoopStep('s', host({ lastAssistant: () => stale }))
    expect(action.kind).toBe('idle')
    expect(pending.getAwaiting('s')).toBeDefined()
  })

  it('空回复不算数', () => {
    runLoopStep('s', host())
    const awaiting = pending.getAwaiting('s')!
    const empty: AssistantSnapshot = {
      text: '   ',
      seq: 100,
      at: new Date(Date.parse(awaiting.createdAt) + 1000).toISOString(),
    }
    const action = runLoopStep('s', host({ lastAssistant: () => empty }))
    expect(action.kind).toBe('idle')
  })

  it('awaiting 超时后放弃', () => {
    runLoopStep('s', host())
    const awaiting = pending.getAwaiting('s')!
    // 把 createdAt 改到很久以前
    pending.markAwaiting({
      ...awaiting,
      createdAt: new Date(Date.now() - PENDING_TTL_MS - 1000).toISOString(),
    })
    const action = runLoopStep('s', host())
    expect(action.kind).toBe('harvest-failed')
    expect(pending.getAwaiting('s')).toBeUndefined()
  })

  it('收割时 apply 抛错 → 记录失败并清 awaiting', () => {
    runLoopStep('s', host())
    const awaiting = pending.getAwaiting('s')!
    const reply: AssistantSnapshot = {
      text: '提炼结果',
      seq: 100,
      at: new Date(Date.parse(awaiting.createdAt) + 1000).toISOString(),
    }
    const action = runLoopStep('s', host({
      lastAssistant: () => reply,
      apply: () => { throw new Error('surface unreachable') },
    }))
    expect(action.kind).toBe('harvest-failed')
    expect(pending.getAwaiting('s')).toBeUndefined()
    expect(warnings.some(w => w.includes('harvest failed'))).toBe(true)
  })

  it('已覆盖的区间不会再次注入', () => {
    // 先造一个覆盖 turn 1 的段
    segments.insert({
      sessionId: 's',
      fromSeq: 0,
      toSeq: 1,
      shadowedSeqs: [0, 1],
      summary: '已有总结',
      recent: '',
      stage: 'archived',
      turn: 1,
      at: 'x',
    })
    const action = runLoopStep('s', host())
    expect(action.kind).toBe('injected')
    if (action.kind !== 'injected') return
    // 不应再选 turn 1
    expect(action.fromSeq).not.toBe(0)
  })

  it('注入后的提示文本包含「不是压缩」', () => {
    const action = runLoopStep('s', host())
    if (action.kind !== 'injected') throw new Error('expected injected')
    expect(action.promptText).toContain('不是压缩')
    expect(action.promptText).toContain('否决')
  })
})
