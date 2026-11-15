// 封存段（segment）测试。
//
// 重点验证用户要求的核心语义：
// 1. 一段 = 一个事件 = 一个会话内编号
// 2. 段内用标签分槽（recent / summary）
// 3. 提炼必须保留否决路径（提示词里明确要求）
// 4. 编号在会话内独立递增

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import DatabaseConstructor from 'better-sqlite3'
import { SegmentStore } from '../src/seal/store.js'
import {
  composeSlottedText,
  isSlottedText,
  decideSummarize,
  buildSummarizePrompt,
  SLOT_TAGS,
  type Segment,
} from '../src/seal/types.js'
import { collectShadowedSeqs, applySegment } from '../src/seal/apply.js'

/** 造一个段。 */
function seg(over: Partial<Omit<Segment, 'eventNo'>> = {}): Omit<Segment, 'eventNo'> {
  return {
    sessionId: 'session-a',
    fromSeq: 10,
    toSeq: 20,
    shadowedSeqs: [10, 11, 12],
    summary: '否决 A：因为鉴权冲突\n否决 B：因为延迟超标\n最终：D',
    recent: '近期的原文内容',
    stage: 'live',
    turn: 3,
    at: '2026-11-15T00:00:00.000Z',
    ...over,
  }
}

describe('槽位组装', () => {
  it('两个槽都输出，各自带标签', () => {
    const text = composeSlottedText([
      { kind: 'recent', text: '原文' },
      { kind: 'summary', text: '总结' },
    ])
    expect(text).toContain(`<${SLOT_TAGS.recent}>`)
    expect(text).toContain('原文')
    expect(text).toContain(`</${SLOT_TAGS.recent}>`)
    expect(text).toContain(`<${SLOT_TAGS.summary}>`)
    expect(text).toContain('总结')
  })

  it('空槽不输出（archived 阶段只有 summary）', () => {
    const text = composeSlottedText([
      { kind: 'recent', text: '' },
      { kind: 'summary', text: '只有总结' },
    ])
    expect(text).not.toContain(SLOT_TAGS.recent)
    expect(text).toContain(SLOT_TAGS.summary)
  })

  it('全空时报错（不能产出空段）', () => {
    expect(() => composeSlottedText([
      { kind: 'recent', text: '  ' },
      { kind: 'summary', text: '' },
    ])).toThrow(/at least one non-empty/)
  })

  it('isSlottedText 能识别已包装的文本', () => {
    const text = composeSlottedText([{ kind: 'summary', text: 'x' }])
    expect(isSlottedText(text)).toBe(true)
    expect(isSlottedText('普通文本')).toBe(false)
  })
})

describe('总结阈值', () => {
  it('很短 → 保持原文', () => {
    expect(decideSummarize(500).kind).toBe('keep-original')
  })

  it('中等 → 可选', () => {
    expect(decideSummarize(2000).kind).toBe('optional')
  })

  it('较长 → 应当总结', () => {
    expect(decideSummarize(10000).kind).toBe('should-summarize')
  })

  it('阈值可覆盖', () => {
    expect(decideSummarize(3000, { keep: 5000 }).kind).toBe('keep-original')
    expect(decideSummarize(3000, { summarize: 2000 }).kind).toBe('should-summarize')
  })
})

describe('提炼提示', () => {
  const prompt = buildSummarizePrompt(50000)

  it('明确要求保留否决路径（用户的核心要求）', () => {
    expect(prompt).toContain('否决')
    expect(prompt).toContain('不是压缩')
  })

  it('给出期望的形态示例', () => {
    expect(prompt).toContain('最终方案')
    expect(prompt).toMatch(/否决方案 A/)
  })

  it('包含长度信息', () => {
    expect(prompt).toContain('50000')
  })
})

describe('SegmentStore', () => {
  let store: SegmentStore
  let db: ReturnType<typeof DatabaseConstructor>
  beforeEach(() => {
    db = DatabaseConstructor(':memory:')
    store = new SegmentStore(db)
  })
  afterEach(() => {
    db.close()
  })

  it('编号从 1 开始递增', () => {
    expect(store.insert(seg({ fromSeq: 1, toSeq: 5 }))).toBe(1)
    expect(store.insert(seg({ fromSeq: 6, toSeq: 9 }))).toBe(2)
  })

  it('编号按会话独立', () => {
    expect(store.insert(seg({ sessionId: 'a', fromSeq: 1, toSeq: 5 }))).toBe(1)
    expect(store.insert(seg({ sessionId: 'b', fromSeq: 1, toSeq: 5 }))).toBe(1)
    expect(store.insert(seg({ sessionId: 'a', fromSeq: 6, toSeq: 9 }))).toBe(2)
  })

  it('能按 (sessionId, eventNo) 读回', () => {
    const no = store.insert(seg())
    const got = store.get('session-a', no)
    expect(got?.summary).toContain('否决 A')
    expect(got?.recent).toBe('近期的原文内容')
    expect(got?.stage).toBe('live')
    expect(got?.shadowedSeqs).toEqual([10, 11, 12])
  })

  it('archive 清空 recent 并改阶段', () => {
    const no = store.insert(seg())
    expect(store.archive('session-a', no)).toBe(true)
    const got = store.get('session-a', no)
    expect(got?.stage).toBe('archived')
    expect(got?.recent).toBe('')
    expect(got?.summary).toContain('否决 A')
  })

  it('findOverlapping 能发现区间重叠', () => {
    store.insert(seg({ fromSeq: 10, toSeq: 20 }))
    expect(store.findOverlapping('session-a', 15, 25)?.eventNo).toBe(1)
    expect(store.findOverlapping('session-a', 1, 10)?.eventNo).toBe(1)
    expect(store.findOverlapping('session-a', 21, 30)).toBeUndefined()
  })

  it('listLive 只返回 live 阶段的段', () => {
    const a = store.insert(seg({ fromSeq: 1, toSeq: 5 }))
    store.insert(seg({ fromSeq: 6, toSeq: 9 }))
    store.archive('session-a', a)
    expect(store.listLive('session-a')).toHaveLength(1)
    expect(store.list('session-a')).toHaveLength(2)
  })

  it('stats 统计 live 与总数', () => {
    const a = store.insert(seg({ fromSeq: 1, toSeq: 5 }))
    store.insert(seg({ fromSeq: 6, toSeq: 9 }))
    store.archive('session-a', a)
    expect(store.stats('session-a')).toEqual({ total: 2, live: 1, sessions: 1 })
  })
})

describe('collectShadowedSeqs', () => {
  it('只取区间内带 surfaceOp 的节点', () => {
    const session = {
      snapshotEvents: () => [
        { seq: 5, surfaceOp: 'append' },
        { seq: 10, surfaceOp: 'append' },
        { seq: 11, surfaceOp: 'append' },
        { seq: 20, surfaceOp: 'append' },
        { seq: 25, surfaceOp: 'append' },
      ],
    }
    expect(collectShadowedSeqs(session, 10, 20)).toEqual([10, 11, 20])
  })

  it('去重并升序', () => {
    const session = {
      snapshotEvents: () => [
        { seq: 12, surfaceOp: 'append' },
        { seq: 10, surfaceOp: 'append' },
        { seq: 11, surfaceOp: 'append' },
        { seq: 11, surfaceOp: 'append' },
      ],
    }
    expect(collectShadowedSeqs(session, 10, 12)).toEqual([10, 11, 12])
  })

  it('区间内无节点时返回 undefined', () => {
    const session = { snapshotEvents: () => [{ seq: 99, surfaceOp: 'append' }] }
    expect(collectShadowedSeqs(session, 10, 20)).toBeUndefined()
  })
})

describe('applySegment', () => {
  it('会话不可达时抛错', () => {
    const fakeCtx = { sessions: { get: () => undefined } } as never
    expect(() => applySegment(fakeCtx, {
      eventNo: 1, ...seg(),
    })).toThrow(/not reachable/)
  })

  it('区间内无可见节点时拒绝', () => {
    const fakeCtx = {
      sessions: { get: () => ({ append: () => {}, snapshotEvents: () => [] }) },
    } as never
    expect(() => applySegment(fakeCtx, { eventNo: 1, ...seg() })).toThrow(/nothing would be shadowed/)
  })

  it('用正确的 surfaceOp + sourceEventSeqs 调用 append', () => {
    const calls: Array<{ type: string; data: unknown; opts: unknown }> = []
    const fakeCtx = {
      sessions: {
        get: () => ({
          append: (type: string, data: unknown, opts: unknown) => { calls.push({ type, data, opts }) },
          snapshotEvents: () => [
            { seq: 10, surfaceOp: 'append' },
            { seq: 11, surfaceOp: 'append' },
            { seq: 12, surfaceOp: 'append' },
          ],
        }),
      },
    } as never

    applySegment(fakeCtx, { eventNo: 1, ...seg() })
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe('user/message')
    expect(calls[0].opts).toMatchObject({
      surfaceOp: { op: 'replace', startSeq: 10, endSeq: 20 },
      sourceEventSeqs: [10, 11, 12],
    })
    // 正文里两槽都在
    const text = (calls[0].data as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain(SLOT_TAGS.recent)
    expect(text).toContain(SLOT_TAGS.summary)
  })

  it('archived 段只输出 summary 槽', () => {
    const calls: Array<{ data: unknown }> = []
    const fakeCtx = {
      sessions: {
        get: () => ({
          append: (_t: string, data: unknown) => { calls.push({ data }) },
          snapshotEvents: () => [{ seq: 10, surfaceOp: 'append' }],
        }),
      },
    } as never

    applySegment(fakeCtx, { eventNo: 1, ...seg({ recent: '', stage: 'archived' }) })
    const text = (calls[0].data as { content: Array<{ text: string }> }).content[0].text
    expect(text).not.toContain(SLOT_TAGS.recent)
    expect(text).toContain(SLOT_TAGS.summary)
  })
})
