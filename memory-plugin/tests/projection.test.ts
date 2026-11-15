// 发送投影测试：验证 #N 标注、summary 分级、折叠区间排除、seq 映射。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { FoldStore } from '../src/fold/store.js'
import {
  projectUnit,
  projectFold,
  planProjection,
  MemoryRenderCache,
  buildReplaceMessage,
} from '../src/projection/apply.js'
import { mapUnitSeqs, type SeqReader } from '../src/projection/seqmap.js'
import { findFoldCandidates, projectedChars, overBudget, FOLD_BUDGET_CHARS } from '../src/fold/trigger.js'
import type { UnitResult } from '../src/types.js'

function addUnit(
  store: MemoryStore,
  content: string,
  kind: 'user' | 'reply' | 'thinking' | 'tool' = 'reply',
  summary = '',
  idx?: number,
): number {
  return store.appendUnit({
    sessionId: 's', kind, summary, content, at: '2026-11-15T00:00:00.000Z', inContext: true, tags: [],
  })
}

/** 造一个假的会话读取器。 */
function fakeReader(events: Array<{ role: string; text: string }>): SeqReader {
  return {
    seq: events.length,
    eventAt(seq: number) {
      const e = events[seq]
      if (!e) return undefined
      return {
        seq,
        type: e.role === 'user' ? 'user/message' : e.role === 'assistant' ? 'assistant/message' : 'tool/result',
        surfaceOp: 'append',
        data: { content: [{ type: 'text', text: e.text }] },
      }
    },
  }
}

describe('单位投影', () => {
  it('user 永不衰减（近程远程都一样）', () => {
    const u = { idx: 0, kind: 'user', summary: '', content: '问题' } as UnitResult
    expect(projectUnit(u, true)).toBe('#0 问题')
    expect(projectUnit(u, false)).toBe('#0 问题')
  })

  it('近程有 summary：summary + content 全发', () => {
    const u = { idx: 1, kind: 'thinking', summary: '要点', content: '详情' } as UnitResult
    const t = projectUnit(u, true)
    expect(t).toContain('#1 <summary>要点</summary>')
    expect(t).toContain('<content>详情</content>')
  })

  it('远程有 summary：只发 summary', () => {
    const u = { idx: 1, kind: 'thinking', summary: '要点', content: '详情' } as UnitResult
    expect(projectUnit(u, false)).toBe('#1 <summary>要点</summary>')
    expect(projectUnit(u, false)).not.toContain('详情')
  })

  it('无 summary：原样发（近程远程一样）', () => {
    const u = { idx: 2, kind: 'reply', summary: '', content: '短' } as UnitResult
    expect(projectUnit(u, true)).toBe('#2 短')
    expect(projectUnit(u, false)).toBe('#2 短')
  })

  it('折叠体渲染带区间与名字', () => {
    const f = { foldNo: 1, sessionId: 's', fromIdx: 0, toIdx: 5, foldSummary: '完成了模块a', trigger: 'task-boundary' as const, name: '模块a', createdAt: 'x' }
    const t = projectFold(f)
    expect(t).toContain('#0~#5')
    expect(t).toContain('模块a')
    expect(t).toContain('完成了模块a')
  })

  it('replace 消息的来源标记是 memory-projection', () => {
    const m = buildReplaceMessage('文本')
    expect(m.source.kind).toBe('memory-projection')
    expect(m.content[0]?.text).toBe('文本')
  })
})

describe('投影计划', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('按窗口决定每单位的形态', () => {
    addUnit(store, '问题', 'user')
    addUnit(store, '旧思考', 'thinking', '旧要点')
    addUnit(store, '新回复', 'reply')
    const units = store.listRange('s', 0, 2)
    const cache = new MemoryRenderCache()
    const plans = planProjection(units, 's', 2, 2, cache)

    expect(plans).toHaveLength(3)
    expect(plans[0]?.text).toContain('#0 问题')
    // #1 在窗口外（latest=2, window=2 → 2-1=1 < 2，其实在窗口内）
    expect(plans[1]?.text).toContain('<summary>旧要点</summary>')
  })

  it('缓存命中时 needsWrite 为 false', () => {
    addUnit(store, '内容')
    const units = store.listRange('s', 0, 0)
    const cache = new MemoryRenderCache()
    const first = planProjection(units, 's', 0, 32, cache)
    expect(first[0]?.needsWrite).toBe(true)
    cache.set('s', 0, first[0]!.text)

    const second = planProjection(units, 's', 0, 32, cache)
    expect(second[0]?.needsWrite).toBe(false)
  })

  it('已折叠区间内的单位被排除', () => {
    for (const t of ['a', 'b', 'c']) addUnit(store, t)
    const units = store.listRange('s', 0, 2)
    const cache = new MemoryRenderCache()
    const plans = planProjection(units, 's', 2, 32, cache, [{ fromIdx: 0, toIdx: 1 }])
    expect(plans).toHaveLength(1)
    expect(plans[0]?.idx).toBe(2)
  })

  it('窗口边界：恰好 32 个单位时第 33 个算远程', () => {
    for (let i = 0; i < 40; i += 1) addUnit(store, `u${i}`, 'reply', `s${i}`)
    const units = store.listRange('s', 0, 39)
    const cache = new MemoryRenderCache()
    const plans = planProjection(units, 's', 39, 32, cache)
    // #7 (39-7=32) 不在窗口内；#8 (39-8=31) 在
    expect(plans[7]?.text).not.toContain('<content>')
    expect(plans[8]?.text).toContain('<content>')
  })
})

describe('seq 映射', () => {
  it('按 role+text 匹配到 seq', () => {
    const reader = fakeReader([
      { role: 'user', text: '问题' },
      { role: 'assistant', text: '回答' },
    ])
    const units = [
      { idx: 0, sessionId: 's', kind: 'user', summary: '', content: '问题', at: 'x', inContext: true, tags: [], rowId: 1 },
    ] as UnitResult[]
    const spans = mapUnitSeqs(reader, units)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.idx).toBe(0)
    expect(spans[0]?.seqs).toEqual([0])
  })

  it('非 surface 事件被跳过', () => {
    const reader: SeqReader = {
      seq: 2,
      eventAt(seq) {
        if (seq === 0) return { seq: 0, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'a' }] } }
        return { seq: 1, type: 'turn/start', data: { turn: 1 } }  // 无 surfaceOp
      },
    }
    const units = [
      { idx: 0, sessionId: 's', kind: 'user', summary: '', content: 'a', at: 'x', inContext: true, tags: [], rowId: 1 },
    ] as UnitResult[]
    expect(mapUnitSeqs(reader, units)).toHaveLength(1)
  })

  it('缓存可复用', () => {
    const reader = fakeReader([{ role: 'user', text: '问题' }])
    const units = [
      { idx: 0, sessionId: 's', kind: 'user', summary: '', content: '问题', at: 'x', inContext: true, tags: [], rowId: 1 },
    ] as UnitResult[]
    const cache = new Map()
    mapUnitSeqs(reader, units, cache)
    expect(cache.size).toBe(1)
  })
})

describe('折叠触发', () => {
  let store: MemoryStore
  let folds: FoldStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    folds = new FoldStore(store.raw)
  })
  afterEach(() => { store.close() })

  it('窗口外的连续单位成为候选', () => {
    for (let i = 0; i < 10; i += 1) addUnit(store, `u${i}`.repeat(100))
    const c = findFoldCandidates(store, folds, 's', 3)
    // latest=9, keep=3 → cutoff=6，0..6 是候选
    expect(c).toHaveLength(1)
    expect(c[0]?.fromIdx).toBe(0)
    expect(c[0]?.toIdx).toBe(6)
  })

  it('已折叠的区间不再成为候选', () => {
    for (let i = 0; i < 10; i += 1) addUnit(store, `u${i}`)
    folds.create({ sessionId: 's', fromIdx: 0, toIdx: 3, foldSummary: 'f', trigger: 'manual', name: 'n', createdAt: 'x' })
    const c = findFoldCandidates(store, folds, 's', 3)
    expect(c[0]?.fromIdx).toBe(4)
  })

  it('全部在窗口内时无候选', () => {
    for (let i = 0; i < 5; i += 1) addUnit(store, `u${i}`)
    expect(findFoldCandidates(store, folds, 's', 32)).toHaveLength(0)
  })

  it('预算判断', () => {
    expect(overBudget(FOLD_BUDGET_CHARS + 1)).toBe(true)
    expect(overBudget(FOLD_BUDGET_CHARS - 1)).toBe(false)
    expect(overBudget(100, 50)).toBe(true)
  })

  it('projectedChars 计入窗口内外差异', () => {
    addUnit(store, 'x'.repeat(1000), 'reply', 's'.repeat(100))
    // 只有 1 个单位，latest=0，keep=32 → 在窗口内 → 1000 + 100
    expect(projectedChars(store, 's', 32)).toBe(1100)
    // keep=0 → 窗口外 → 只有 summary
    expect(projectedChars(store, 's', 0)).toBe(100)
  })
})
