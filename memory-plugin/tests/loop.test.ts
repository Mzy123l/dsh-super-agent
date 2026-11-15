// 循环测试：验证注入、收割、live/archived 阶段。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import DatabaseConstructor from 'better-sqlite3'
import { MemoryStore } from '../src/store/sqlite.js'
import { SegmentStore, composeSlottedText, decideSummarize, buildSummarizePrompt, SLOT_TAGS } from '../src/seal/types.js'
import { PendingStore } from '../src/loop/store.js'
import { runLoopStep, computeSpans, archiveDue, PENDING_TTL_MS, type LoopHost } from '../src/loop/engine.js'

describe('槽位', () => {
  it('两槽都输出', () => {
    const t = composeSlottedText([{ kind: 'recent', text: '原文' }, { kind: 'summary', text: '总结' }])
    expect(t).toContain(`<${SLOT_TAGS.recent}>`)
    expect(t).toContain(`<${SLOT_TAGS.summary}>`)
  })

  it('空槽跳过（archived 只有总结）', () => {
    const t = composeSlottedText([{ kind: 'recent', text: '' }, { kind: 'summary', text: '只有总结' }])
    expect(t).not.toContain(SLOT_TAGS.recent)
    expect(t).toContain(SLOT_TAGS.summary)
  })

  it('全空抛错', () => {
    expect(() => composeSlottedText([{ kind: 'recent', text: ' ' }, { kind: 'summary', text: '' }])).toThrow()
  })
})

describe('提炼决策', () => {
  it('短 → keep-original', () => expect(decideSummarize(500).kind).toBe('keep-original'))
  it('中 → optional', () => expect(decideSummarize(2000).kind).toBe('optional'))
  it('长 → should-summarize', () => expect(decideSummarize(10000).kind).toBe('should-summarize'))

  it('提示里包含否决要求与索引引用', () => {
    const p = buildSummarizePrompt(50000, 3, 9)
    expect(p).toContain('否决')
    expect(p).toContain('不是压缩')
    expect(p).toContain('#3')
    expect(p).toContain('#9')
  })
})

describe('computeSpans', () => {
  let store: MemoryStore
  let segments: SegmentStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    segments = new SegmentStore(store.raw)
  })
  afterEach(() => { store.close() })

  /** 灌 n 条消息。 */
  function fill(n: number, len = 5000): void {
    for (let i = 0; i < n; i += 1) {
      store.appendMessage({ sessionId: 's', role: 'user', text: `m${i}`.padEnd(len, 'x'), at: 'x' })
    }
  }

  it('全部未覆盖时整段成一个区间', () => {
    fill(10)
    const spans = computeSpans(store, segments, 's')
    // 不再排除近期：0..9 全部可提炼，合成一个区间
    expect(spans).toHaveLength(1)
    expect(spans[0]?.fromIdx).toBe(0)
    expect(spans[0]?.toIdx).toBe(9)
  })

  it('排除已覆盖的 idx，两侧各成一个区间', () => {
    fill(10)
    segments.insert({ sessionId: 's', fromIdx: 3, toIdx: 5, summary: 'x', recent: '', stage: 'archived', at: 'x' })
    const spans = computeSpans(store, segments, 's')
    expect(spans).toHaveLength(2)
    expect(spans[0]?.toIdx).toBe(2)
    expect(spans[1]?.fromIdx).toBe(6)
  })

  it('全部被覆盖时无区间', () => {
    fill(5)
    segments.insert({ sessionId: 's', fromIdx: 0, toIdx: 4, summary: 'x', recent: '', stage: 'archived', at: 'x' })
    const spans = computeSpans(store, segments, 's')
    expect(spans).toHaveLength(0)
  })
})

describe('runLoopStep', () => {
  let store: MemoryStore
  let segments: SegmentStore
  let pending: PendingStore
  let applied: number[]

  function host(over: Partial<LoopHost> = {}): LoopHost {
    return {
      store,
      segments,
      pending,
      apply: (n) => { applied.push(n) },
      keepRecent: 3,
      autoSummarize: true,
      warn: () => {},
      ...over,
    }
  }

  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    segments = new SegmentStore(store.raw)
    pending = new PendingStore(store.raw)
    applied = []
    for (let i = 0; i < 10; i += 1) {
      store.appendMessage({ sessionId: 's', role: 'user', text: `m${i}`.padEnd(5000, 'x'), at: 'x' })
    }
  })
  afterEach(() => { store.close() })

  it('无 awaiting 且找到长区间 → 注入', () => {
    const a = runLoopStep('s', host(), undefined)
    expect(a.kind).toBe('injected')
    if (a.kind !== 'injected') return
    expect(a.fromIdx).toBe(0)
    expect(pending.getAwaiting('s')).toBeDefined()
  })

  it('autoSummarize 关闭 → 不注入', () => {
    const a = runLoopStep('s', host({ autoSummarize: false }), undefined)
    expect(a.kind).toBe('idle')
  })

  it('有 awaiting 但无新回复 → 保持等待', () => {
    runLoopStep('s', host(), undefined)
    const a = runLoopStep('s', host(), undefined)
    expect(a.kind).toBe('idle')
    expect(pending.getAwaiting('s')).toBeDefined()
  })

  it('有 awaiting 且有新回复 → 收割并落库', () => {
    runLoopStep('s', host(), undefined)
    const aw = pending.getAwaiting('s')!
    const a = runLoopStep('s', host(), {
      text: '否决 A：因为冲突\n最终：D',
      at: new Date(Date.parse(aw.createdAt) + 1000).toISOString(),
    })
    expect(a.kind).toBe('harvested')
    if (a.kind !== 'harvested') return
    expect(applied).toHaveLength(1)
    expect(segments.get(a.segmentNo)?.summary).toContain('否决 A')
    expect(pending.getAwaiting('s')).toBeUndefined()
  })

  it('近期段保留原文（live）', () => {
    // keepRecent 适中：能找到区间，且收割时该区间仍在窗口内
    const h = host({ keepRecent: 3 })
    runLoopStep('s', h, undefined)
    const aw = pending.getAwaiting('s')!
    const a = runLoopStep('s', h, {
      text: '总结内容',
      at: new Date(Date.parse(aw.createdAt) + 1000).toISOString(),
    })
    if (a.kind !== 'harvested') throw new Error('expected harvested')
    expect(a.stage).toBe('live')
    const seg = segments.get(a.segmentNo)!
    expect(seg.recent.length).toBeGreaterThan(0)
    expect(seg.recent).toContain('#0')
  })

  it('滑出窗口的段只留总结（archived）', () => {
    // keepRecent 很小 → 区间已滑出
    const h = host({ keepRecent: 0 })
    runLoopStep('s', h, undefined)
    const aw = pending.getAwaiting('s')!
    const a = runLoopStep('s', h, {
      text: '总结内容',
      at: new Date(Date.parse(aw.createdAt) + 1000).toISOString(),
    })
    if (a.kind !== 'harvested') throw new Error('expected harvested')
    expect(a.stage).toBe('archived')
    expect(segments.get(a.segmentNo)?.recent).toBe('')
  })

  it('回复早于提示时不算数', () => {
    runLoopStep('s', host(), undefined)
    const aw = pending.getAwaiting('s')!
    const a = runLoopStep('s', host(), {
      text: '旧消息',
      at: new Date(Date.parse(aw.createdAt) - 60000).toISOString(),
    })
    expect(a.kind).toBe('idle')
  })

  it('空回复不算数', () => {
    runLoopStep('s', host(), undefined)
    const aw = pending.getAwaiting('s')!
    const a = runLoopStep('s', host(), {
      text: '   ',
      at: new Date(Date.parse(aw.createdAt) + 1000).toISOString(),
    })
    expect(a.kind).toBe('idle')
  })

  it('超时后放弃', () => {
    runLoopStep('s', host(), undefined)
    const aw = pending.getAwaiting('s')!
    pending.markAwaiting({ ...aw, createdAt: new Date(Date.now() - PENDING_TTL_MS - 1000).toISOString() })
    const a = runLoopStep('s', host(), undefined)
    expect(a.kind).toBe('harvest-failed')
    expect(pending.getAwaiting('s')).toBeUndefined()
  })
})

describe('archiveDue', () => {
  let store: MemoryStore
  let segments: SegmentStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    segments = new SegmentStore(store.raw)
  })
  afterEach(() => { store.close() })

  it('滑出窗口的 live 段被降级', () => {
    segments.insert({ sessionId: 's', fromIdx: 0, toIdx: 5, summary: 's1', recent: 'r1', stage: 'live', at: 'x' })
    segments.insert({ sessionId: 's', fromIdx: 90, toIdx: 95, summary: 's2', recent: 'r2', stage: 'live', at: 'x' })
    const n = archiveDue(segments, 's', 10, 99)
    expect(n).toBe(1)
    expect(segments.get(1)?.stage).toBe('archived')
    expect(segments.get(1)?.recent).toBe('')
    expect(segments.get(2)?.stage).toBe('live')
  })

  it('没有 live 段返回 0', () => {
    expect(archiveDue(segments, 's', 10, 99)).toBe(0)
  })
})
