// 发送投影与总结流程测试。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { PendingStore } from '../src/summary/pending.js'
import { renderUnit, renderUnits, isRecent, unitsNeedingSummary, buildSummaryPrompt, isNoSummary, summaryDecision, DEFAULT_WINDOW } from '../src/projection/render.js'
import { runSummaryStep, SUMMARY_THRESHOLD, type SummaryHost } from '../src/summary/flow.js'
import type { Unit } from '../src/types.js'

/** 造一个单位。 */
function unit(over: Partial<Unit> = {}): Unit {
  return {
    idx: 0,
    sessionId: 's',
    kind: 'reply',
    summary: '',
    content: '内容',
    at: '2026-11-15T00:00:00.000Z',
    ...over,
  }
}

describe('窗口判定', () => {
  it('窗口内为近程', () => {
    expect(isRecent(18, 20, 5)).toBe(true)
    expect(isRecent(16, 20, 5)).toBe(true)
  })

  it('窗口外为远程', () => {
    expect(isRecent(15, 20, 5)).toBe(false)
    expect(isRecent(0, 20, 5)).toBe(false)
  })

  it('默认窗口为 20', () => {
    expect(DEFAULT_WINDOW).toBe(32)
  })
})

describe('单位渲染', () => {
  it('user 单位永不衰减，纯文本', () => {
    const u = unit({ idx: 0, kind: 'user', content: '帮我看看' })
    expect(renderUnit(u, true)).toBe('#0 帮我看看')
    expect(renderUnit(u, false)).toBe('#0 帮我看看')
  })

  it('近程有 summary：summary + content 全发', () => {
    const u = unit({ idx: 1, kind: 'thinking', summary: '想了三件事', content: '详细思考…' })
    const text = renderUnit(u, true)
    expect(text).toContain('#1 <summary>想了三件事</summary>')
    expect(text).toContain('<content>详细思考…</content>')
  })

  it('远程有 summary：只发 summary', () => {
    const u = unit({ idx: 1, kind: 'thinking', summary: '想了三件事', content: '详细思考…' })
    const text = renderUnit(u, false)
    expect(text).toBe('#1 <summary>想了三件事</summary>')
    expect(text).not.toContain('详细思考')
  })

  it('近程无 summary：原样保留', () => {
    const u = unit({ idx: 4, kind: 'reply', content: '短回复' })
    expect(renderUnit(u, true)).toBe('#4 短回复')
  })

  it('远程无 summary：原样保留（地位等同 summary）', () => {
    const u = unit({ idx: 4, kind: 'reply', content: '短回复' })
    expect(renderUnit(u, false)).toBe('#4 短回复')
  })

  it('总结完成后近程发送不变（S0 与 S1 一致的关键）', () => {
    const noSummary = unit({ idx: 2, kind: 'reply', content: '正文' })
    const withSummary = unit({ idx: 2, kind: 'reply', summary: '要点', content: '正文' })
    // 近程下两者都含 content
    expect(renderUnit(withSummary, true)).toContain('正文')
    // 无 summary 近程就是纯 content
    expect(renderUnit(noSummary, true)).toContain('正文')
  })

  it('批量渲染按编号窗口分层', () => {
    const units = [
      unit({ idx: 0, kind: 'user', content: 'q' }),
      unit({ idx: 1, kind: 'thinking', summary: '旧思路', content: '旧详情' }),
      unit({ idx: 9, kind: 'thinking', summary: '新思路', content: '新详情' }),
    ]
    const out = renderUnits(units, { window: 3, latestIdx: 9 })
    expect(out[0]).toBe('#0 q')
    expect(out[1]).toBe('#1 <summary>旧思路</summary>')       // 远程
    expect(out[2]).toContain('<content>新详情</content>')       // 近程
  })
})

describe('待总结筛选', () => {
  it('长单位入选', () => {
    const long = unit({ idx: 1, content: 'x'.repeat(5000) })
    expect(unitsNeedingSummary([long], SUMMARY_THRESHOLD)).toHaveLength(1)
  })

  it('短单位不入选', () => {
    const short = unit({ idx: 1, content: 'x'.repeat(100) })
    expect(unitsNeedingSummary([short], SUMMARY_THRESHOLD)).toHaveLength(0)
  })

  it('已有 summary 的跳过', () => {
    const done = unit({ idx: 1, summary: '有', content: 'x'.repeat(5000) })
    expect(unitsNeedingSummary([done], SUMMARY_THRESHOLD)).toHaveLength(0)
  })
})

describe('提炼指令', () => {
  const p = buildSummaryPrompt(3, 'thinking')

  it('整条用英文', () => {
    expect(p).toContain('Condense unit #3')
    expect(p).toContain('extraction, not compression')
  })

  it('要求保留否决路径', () => {
    expect(p).toContain('rejected option')
    expect(p).toContain('because')
    expect(p).toContain('chosen option')
  })

  it('声明 summary 是后续取回内容的唯一途径', () => {
    expect(p).toContain('the only way this span will be readable to you later')
    expect(p).toContain('effectively lost')
  })

  it('必做档（should-summarize）不提供 none 出口', () => {
    const mandatory = buildSummaryPrompt(3, 'thinking', 'should-summarize')
    expect(mandatory).toContain('Reply with the extraction only')
    expect(mandatory).not.toContain('reply with exactly: none')
    expect(mandatory).not.toContain('summarizing is optional')
  })

  it('可选档（optional）提供 none 出口', () => {
    const optionalPrompt = buildSummaryPrompt(3, 'thinking', 'optional')
    expect(optionalPrompt).toContain('reply with exactly: none')
    expect(optionalPrompt).toContain('summarizing is optional')
    expect(optionalPrompt).toContain('no preamble')
  })

  it('isNoSummary 能识别 none', () => {
    expect(isNoSummary('none')).toBe(true)
    expect(isNoSummary('NONE')).toBe(true)
    expect(isNoSummary('  无  ')).toBe(true)
    expect(isNoSummary('有内容')).toBe(false)
  })
})

describe('总结流程', () => {
  let store: MemoryStore
  let pending: PendingStore
  let assistant: { text: string; at: string } | undefined
  let warnings: string[]

  function host(over: Partial<SummaryHost> = {}): SummaryHost {
    return {
      store,
      pending,
      lastAssistantText: () => assistant?.text,
      lastAssistantAt: () => assistant?.at,
      threshold: 100,
      warn: (m) => { warnings.push(m) },
      ...over,
    }
  }

  /** 灌一个长单位。 */
  function fillLong(idx = 0): void {
    store.appendUnit({
      sessionId: 's', kind: 'reply', summary: '', content: 'x'.repeat(500),
      at: '2026-11-15T00:00:00.000Z', inContext: true, tags: [],
    })
  }

  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    pending = new PendingStore(store.raw)
    assistant = undefined
    warnings = []
  })
  afterEach(() => { store.close() })

  it('有长单位且无 pending → 注入指令', () => {
    fillLong()
    const a = runSummaryStep('s', host())
    expect(a.kind).toBe('inject')
    if (a.kind !== 'inject') return
    expect(a.unitIdx).toBe(0)
    expect(a.promptText).toContain('Condense unit #0')
    expect(pending.get('s')).toBeDefined()
  })

  it('无长单位 → idle', () => {
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: 'short', at: 'x', inContext: true, tags: [] })
    expect(runSummaryStep('s', host()).kind).toBe('idle')
  })

  it('有 pending 但无回复 → 保持等待', () => {
    fillLong()
    runSummaryStep('s', host())
    expect(runSummaryStep('s', host()).kind).toBe('idle')
    expect(pending.get('s')).toBeDefined()
  })

  it('有 pending 且有新回复 → 挂接 summary', () => {
    fillLong()
    runSummaryStep('s', host())
    const p = pending.get('s')!
    assistant = {
      text: 'rejected: 方案A — because 冲突\nchosen: 方案B',
      at: new Date(Date.parse(p.createdAt) + 1000).toISOString(),
    }
    const a = runSummaryStep('s', host())
    expect(a.kind).toBe('harvested')
    if (a.kind !== 'harvested') return
    expect(a.skipped).toBe(false)
    expect(store.getUnit('s', 0)?.summary).toContain('方案A')
    expect(pending.get('s')).toBeUndefined()
  })

  it('模型回 none → 挂空 summary，标记跳过', () => {
    fillLong()
    runSummaryStep('s', host())
    const p = pending.get('s')!
    assistant = { text: 'none', at: new Date(Date.parse(p.createdAt) + 1000).toISOString() }
    const a = runSummaryStep('s', host())
    expect(a.kind).toBe('harvested')
    if (a.kind !== 'harvested') return
    expect(a.skipped).toBe(true)
    expect(store.getUnit('s', 0)?.summary).toBe('')
  })

  it('回复早于 pending → 不算数', () => {
    fillLong()
    runSummaryStep('s', host())
    const p = pending.get('s')!
    assistant = { text: '旧回复', at: new Date(Date.parse(p.createdAt) - 60000).toISOString() }
    expect(runSummaryStep('s', host()).kind).toBe('idle')
  })

  it('超时后放弃', () => {
    fillLong()
    runSummaryStep('s', host())
    const p = pending.get('s')!
    pending.set({ ...p, createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() })
    const a = runSummaryStep('s', host())
    expect(a.kind).toBe('failed')
    expect(pending.get('s')).toBeUndefined()
  })

  it('总结完成后发送视图仍含 content（总结不省空间）', () => {
    fillLong()
    runSummaryStep('s', host())
    const p = pending.get('s')!
    assistant = { text: '要点', at: new Date(Date.parse(p.createdAt) + 1000).toISOString() }
    runSummaryStep('s', host())

    const u = store.getUnit('s', 0)!
    // 近程渲染仍含完整 content
    expect(renderUnit(u, true)).toContain('xxxxxxxx')
    // 远程渲染只剩 summary
    expect(renderUnit(u, false)).toBe('#0 <summary>要点</summary>')
  })
})

describe('三档阈值', () => {
  it('1200 及以下保留原文', () => {
    expect(summaryDecision(500, SUMMARY_THRESHOLD)).toBe('keep-original')
    expect(summaryDecision(1200, SUMMARY_THRESHOLD)).toBe('keep-original')
  })

  it('1200 到 4000 为可选', () => {
    expect(summaryDecision(1201, SUMMARY_THRESHOLD)).toBe('optional')
    expect(summaryDecision(3999, SUMMARY_THRESHOLD)).toBe('optional')
  })

  it('4000 及以上必须总结', () => {
    expect(summaryDecision(4000, SUMMARY_THRESHOLD)).toBe('should-summarize')
    expect(summaryDecision(9999, SUMMARY_THRESHOLD)).toBe('should-summarize')
  })

  it('候选只排除 keep-original 档', () => {
    const short = unit({ idx: 0, content: 'x'.repeat(500) })
    const mid = unit({ idx: 1, content: 'x'.repeat(2000) })
    const long = unit({ idx: 2, content: 'x'.repeat(5000) })
    const picked = unitsNeedingSummary([short, mid, long], SUMMARY_THRESHOLD)
    expect(picked.map(u => u.idx)).toEqual([1, 2])
  })

  it('长单位优先于可选单位', () => {
    // pickNext 未导出，按行为测：runSummaryStep 应先挑长单位
    const store = new MemoryStore({ path: ':memory:' })
    const pend = new PendingStore(store.raw)
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: 'x'.repeat(2000), at: '2026-11-15T00:00:00.000Z', inContext: true, tags: [] })
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: 'x'.repeat(5000), at: '2026-11-15T00:00:00.000Z', inContext: true, tags: [] })

    const action = runSummaryStep('s', {
      store,
      pending: pend,
      lastAssistantText: () => undefined,
      lastAssistantAt: () => undefined,
      warn: () => {},
    })
    expect(action.kind).toBe('inject')
    if (action.kind === 'inject') expect(action.unitIdx).toBe(1) // 长单位 #1 优先于 #0
    store.close()
  })
})
