// 生命周期与区间工具测试。
//
// 验证：
// 1. 段滑出近期窗口后自动降级（archive）
// 2. 可总结区间能正确计算（排除已覆盖、排除近期）

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import DatabaseConstructor from 'better-sqlite3'
import { SegmentStore } from '../src/seal/store.js'
import { planArchive, applyArchive } from '../src/seal/lifecycle.js'
import { computeSpans, coveredSeqs, type SpanEvent } from '../src/seal/spans.js'
import type { Segment } from '../src/seal/types.js'

/** 造一个段。 */
function seg(eventNo: number, turn: number, over: Partial<Segment> = {}): Segment {
  return {
    eventNo,
    sessionId: 's',
    fromSeq: turn * 10,
    toSeq: turn * 10 + 5,
    shadowedSeqs: [turn * 10, turn * 10 + 1],
    summary: `第 ${turn} 轮的总结`,
    recent: `第 ${turn} 轮的原文`,
    stage: 'live',
    turn,
    at: '2026-11-15T00:00:00.000Z',
    ...over,
  }
}

describe('planArchive', () => {
  it('滑出近期窗口的段被标记为待降级', () => {
    // 最新 10 轮，保留 3 轮 → 第 7 轮及以前降级
    const plan = planArchive([seg(1, 5), seg(2, 7), seg(3, 8), seg(4, 9)], 10, 3)
    expect(plan.toArchive.map(s => s.turn)).toEqual([5, 7])
    expect(plan.stayLive.map(s => s.turn)).toEqual([8, 9])
  })

  it('窗口边界：turn 恰好等于 cutoff 时降级', () => {
    // latest=10, keep=3 → cutoff=7；turn 7 降级，turn 8 保留
    const plan = planArchive([seg(1, 7), seg(2, 8)], 10, 3)
    expect(plan.toArchive.map(s => s.turn)).toEqual([7])
    expect(plan.stayLive.map(s => s.turn)).toEqual([8])
  })

  it('keepTurns=0 时所有段都可降级', () => {
    const plan = planArchive([seg(1, 1), seg(2, 2)], 2, 0)
    expect(plan.toArchive).toHaveLength(2)
  })

  it('空输入返回空计划', () => {
    const plan = planArchive([], 5, 3)
    expect(plan.toArchive).toHaveLength(0)
    expect(plan.stayLive).toHaveLength(0)
  })
})

describe('applyArchive', () => {
  let store: SegmentStore
  let db: ReturnType<typeof DatabaseConstructor>
  beforeEach(() => {
    db = DatabaseConstructor(':memory:')
    store = new SegmentStore(db)
  })
  afterEach(() => {
    db.close()
  })

  it('真的把段改成 archived 并清空 recent', () => {
    store.insert({ sessionId: 's', fromSeq: 50, toSeq: 55, shadowedSeqs: [50], summary: '旧总结', recent: '旧原文', stage: 'live', turn: 5, at: 'x' })
    store.insert({ sessionId: 's', fromSeq: 90, toSeq: 95, shadowedSeqs: [90], summary: '新总结', recent: '新原文', stage: 'live', turn: 9, at: 'x' })

    const archived = applyArchive(store, 's', 10, 3)
    expect(archived).toBe(1)

    const list = store.list('s')
    const old = list.find(s => s.turn === 5)
    const recent = list.find(s => s.turn === 9)
    expect(old?.stage).toBe('archived')
    expect(old?.recent).toBe('')
    expect(recent?.stage).toBe('live')
    expect(recent?.recent).toBe('新原文')
  })

  it('没有 live 段时返回 0', () => {
    expect(applyArchive(store, 's', 10, 3)).toBe(0)
  })
})

describe('computeSpans', () => {
  /** 造事件：turn 从 1 到 n，每轮 2 个事件。 */
  function events(n: number): SpanEvent[] {
    const out: SpanEvent[] = []
    let seq = 0
    for (let turn = 1; turn <= n; turn += 1) {
      for (let i = 0; i < 2; i += 1) {
        out.push({ seq: seq++, turn, chars: 500 })
      }
    }
    return out
  }

  it('只返回滑出近期窗口的轮次', () => {
    // 10 轮，保留 3 → cutoff=7，只有 turn ≤7 可总结
    const spans = computeSpans(events(10), new Set(), 10, 3)
    expect(spans.every(s => s.toTurn <= 7)).toBe(true)
    expect(spans).toHaveLength(7)
  })

  it('排除已被段覆盖的 seq', () => {
    const evs = events(10)
    // 覆盖 turn 1 的两个 seq（seq 0,1）
    const spans = computeSpans(evs, new Set([0, 1]), 10, 3)
    expect(spans.find(s => s.fromTurn === 1)).toBeUndefined()
  })

  it('每个区间带正确的 seq 范围与字符数', () => {
    const spans = computeSpans(events(5), new Set(), 5, 1)
    const first = spans[0]
    expect(first.fromSeq).toBe(0)
    expect(first.toSeq).toBe(1)
    expect(first.eventCount).toBe(2)
    expect(first.chars).toBe(1000)
  })

  it('按轮次升序返回', () => {
    const spans = computeSpans(events(6), new Set(), 6, 1)
    const turns = spans.map(s => s.fromTurn)
    expect(turns).toEqual([...turns].sort((a, b) => a - b))
  })

  it('无 turn 的事件被跳过', () => {
    const spans = computeSpans([{ seq: 1, chars: 100 }], new Set(), 5, 3)
    expect(spans).toHaveLength(0)
  })

  it('给出基于长度的建议', () => {
    const spans = computeSpans([{ seq: 1, turn: 1, chars: 5000 }], new Set(), 5, 3)
    expect(spans[0].recommendation).toContain('should-summarize')
  })
})

describe('coveredSeqs', () => {
  let store: SegmentStore
  let db: ReturnType<typeof DatabaseConstructor>
  beforeEach(() => {
    db = DatabaseConstructor(':memory:')
    store = new SegmentStore(db)
  })
  afterEach(() => {
    db.close()
  })

  it('用 shadowedSeqs 时精确返回', () => {
    store.insert({ sessionId: 's', fromSeq: 10, toSeq: 20, shadowedSeqs: [10, 12, 15], summary: 'x', recent: '', stage: 'live', turn: 2, at: 'x' })
    expect([...coveredSeqs(store, 's')].sort((a, b) => a - b)).toEqual([10, 12, 15])
  })

  it('shadowedSeqs 为空时退回区间', () => {
    store.insert({ sessionId: 's', fromSeq: 1, toSeq: 3, shadowedSeqs: [], summary: 'x', recent: '', stage: 'live', turn: 1, at: 'x' })
    expect([...coveredSeqs(store, 's')].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })
})
