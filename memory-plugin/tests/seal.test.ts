// 封存（seal）的单元测试。
//
// 验证三件事：
// 1. buildSealEvent 产出的 surfaceOp 形状符合 dsh 的 `isReplaceOp` 严格校验
// 2. SealStore 的防重复封存真的生效
// 3. applySeal 在拿不到会话时明确失败（不静默降级）

import { describe, expect, it, beforeEach } from 'vitest'
import DatabaseConstructor from 'better-sqlite3'
import { SealStore } from '../src/seal/store.js'
import { buildSealEvent, shouldSeal } from '../src/seal/types.js'
import { applySeal, formatSealSummary } from '../src/seal/apply.js'
import type { SealedSegment } from '../src/seal/types.js'

/** 造一个内存库。 */
function memoryDb() {
  return DatabaseConstructor(':memory:')
}

/** 造一条封存段。 */
function segment(over: Partial<SealedSegment> = {}): SealedSegment {
  return {
    id: 'seal-test-1',
    sessionId: 'session-a',
    fromSeq: 10,
    toSeq: 20,
    summary: '修好了登录超时；结论是 token 刷新要提前 5 分钟。',
    reason: '修复已验证',
    turn: 3,
    at: '2026-11-15T00:00:00.000Z',
    ...over,
  }
}

describe('buildSealEvent', () => {
  it('产出的 surfaceOp 恰好三个键，符合 isReplaceOp 的严格校验', () => {
    const [type, data, opts] = buildSealEvent('总结', 10, 20, [10, 11, 12])
    expect(type).toBe('user/message')
    expect(data.role).toBe('user')
    // dsh 的 isReplaceOp 要求 Object.keys(op).length === 3
    expect(Object.keys(opts.surfaceOp).sort()).toEqual(['endSeq', 'op', 'startSeq'])
    expect(opts.surfaceOp.op).toBe('replace')
    expect(opts.surfaceOp.startSeq).toBe(10)
    expect(opts.surfaceOp.endSeq).toBe(20)
  })

  it('sourceEventSeqs 必须带上，且按升序去重（dsh 强制要求）', () => {
    const [, , opts] = buildSealEvent('x', 10, 20, [12, 10, 11, 11])
    expect(opts.sourceEventSeqs).toEqual([10, 11, 12])
  })

  it('没有遮蔽节点时拒绝构造（否则 replace 会被 dsh 拒绝）', () => {
    expect(() => buildSealEvent('x', 10, 20, [])).toThrow(/at least one shadowed/)
  })

  it('source.kind 用自定义标记，便于识别这不是用户真的说的话', () => {
    const [, data] = buildSealEvent('x', 1, 2, [1])
    expect(data.source.kind).toBe('memory-seal')
  })

  it('总结文本原样进入 content', () => {
    const [, data] = buildSealEvent('这是总结', 1, 2, [1])
    expect(data.content[0].text).toBe('这是总结')
  })
})

describe('SealStore', () => {
  let store: SealStore
  beforeEach(() => {
    store = new SealStore(memoryDb())
  })

  it('插入后能读回，字段完整', () => {
    store.insert(segment())
    const got = store.get('seal-test-1')
    expect(got?.summary).toContain('登录超时')
    expect(got?.fromSeq).toBe(10)
    expect(got?.turn).toBe(3)
  })

  it('list 按 turn 升序返回该会话的全部段', () => {
    store.insert(segment({ id: 'a', turn: 5, fromSeq: 50, toSeq: 60 }))
    store.insert(segment({ id: 'b', turn: 2, fromSeq: 20, toSeq: 30 }))
    const list = store.list('session-a')
    expect(list.map(s => s.id)).toEqual(['b', 'a'])
  })

  it('不返回其它会话的段', () => {
    store.insert(segment({ id: 'a', sessionId: 'session-a' }))
    store.insert(segment({ id: 'b', sessionId: 'session-b' }))
    expect(store.list('session-a').map(s => s.id)).toEqual(['a'])
  })

  it('findOverlapping 能发现区间重叠（含边界相接）', () => {
    store.insert(segment({ fromSeq: 10, toSeq: 20 }))
    expect(store.findOverlapping('session-a', 15, 25)?.id).toBe('seal-test-1')
    expect(store.findOverlapping('session-a', 1, 10)?.id).toBe('seal-test-1')
    expect(store.findOverlapping('session-a', 21, 30)).toBeUndefined()
  })

  it('lastSealedTurn 返回最大 turn', () => {
    store.insert(segment({ id: 'a', turn: 2, fromSeq: 1, toSeq: 5 }))
    store.insert(segment({ id: 'b', turn: 7, fromSeq: 6, toSeq: 9 }))
    expect(store.lastSealedTurn('session-a')).toBe(7)
  })

  it('stats 统计段数与会话数', () => {
    store.insert(segment({ id: 'a', sessionId: 's1', fromSeq: 1, toSeq: 5 }))
    store.insert(segment({ id: 'b', sessionId: 's2', fromSeq: 1, toSeq: 5 }))
    expect(store.stats()).toEqual({ count: 2, sessions: 2 })
  })
})

describe('shouldSeal', () => {
  it('只有超过 keepTurns 才允许封存', () => {
    expect(shouldSeal({ turn: 3 }, 10, 5)).toBe(true)
    expect(shouldSeal({ turn: 6 }, 10, 5)).toBe(false)
    expect(shouldSeal({ turn: 5 }, 10, 5)).toBe(true)
  })
})

describe('formatSealSummary', () => {
  it('带机器可读头部，模型能识别这是封存段', () => {
    const text = formatSealSummary({
      summary: '结论是 A',
      reason: '已验证',
      fromSeq: 10,
      toSeq: 20,
      turn: 3,
    })
    expect(text).toContain('[sealed segment')
    expect(text).toContain('seq 10–20')
    expect(text).toContain('sealed because: 已验证')
    expect(text).toContain('结论是 A')
  })
})

describe('applySeal', () => {
  it('拿不到会话时抛错，不静默成功', () => {
    const fakeCtx = { sessions: { get: () => undefined } } as never
    expect(() => applySeal(fakeCtx, segment())).toThrow(/not reachable/)
  })

  it('区间内没有 surface 节点时拒绝，不做空替换', () => {
    const fakeCtx = {
      sessions: {
        get: () => ({
          append: () => {},
          snapshotEvents: () => [],
        }),
      },
    } as never
    expect(() => applySeal(fakeCtx, segment())).toThrow(/nothing would be shadowed/)
  })

  it('会话可达时用正确的 surfaceOp + sourceEventSeqs 调用 append', () => {
    const calls: Array<{ type: string; opts: unknown }> = []
    const fakeCtx = {
      sessions: {
        get: () => ({
          append: (type: string, _data: unknown, opts: unknown) => {
            calls.push({ type, opts })
          },
          // 只列出落在 [fromSeq, toSeq] 内、且带 surfaceOp 的节点
          snapshotEvents: () => [
            { seq: 5, surfaceOp: 'append' },
            { seq: 10, surfaceOp: 'append' },
            { seq: 11, surfaceOp: 'append' },
            { seq: 20, surfaceOp: 'append' },
            { seq: 25, surfaceOp: 'append' },
          ],
        }),
      },
    } as never
    applySeal(fakeCtx, segment())
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe('user/message')
    expect(calls[0].opts).toMatchObject({
      surfaceOp: { op: 'replace', startSeq: 10, endSeq: 20 },
      sourceEventSeqs: [10, 11, 20],
    })
  })
})
