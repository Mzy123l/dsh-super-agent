// 事件存储测试：编号规则、幂等、FTS、水位线。
//
// 重点验证「每个事件一个编号，且编号在会话内独立递增」。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store/sqlite.js'
import type { EventRecord } from '../src/types.js'
import { keywordSearch } from '../src/search/keyword.js'

/** 造一个事件。 */
function ev(over: Partial<EventRecord> = {}): EventRecord {
  return {
    sessionId: 'session-a',
    seq: 1,
    kind: 'user',
    at: '2026-11-15T00:00:00.000Z',
    text: '默认内容',
    ...over,
  }
}

describe('MemoryStore 事件编号', () => {
  let store: MemoryStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
  })
  afterEach(() => {
    store.close()
  })

  it('同一会话内编号从 1 开始逐条递增', () => {
    expect(store.insertEvent(ev({ seq: 1 }), false)).toBe(1)
    expect(store.insertEvent(ev({ seq: 2 }), false)).toBe(2)
    expect(store.insertEvent(ev({ seq: 3 }), false)).toBe(3)
  })

  it('不同会话各自独立编号，互不影响', () => {
    expect(store.insertEvent(ev({ sessionId: 'a', seq: 1 }), false)).toBe(1)
    expect(store.insertEvent(ev({ sessionId: 'a', seq: 2 }), false)).toBe(2)
    // 会话 b 从 1 重新开始
    expect(store.insertEvent(ev({ sessionId: 'b', seq: 1 }), false)).toBe(1)
    expect(store.insertEvent(ev({ sessionId: 'b', seq: 2 }), false)).toBe(2)
    // 回到 a，继续 3
    expect(store.insertEvent(ev({ sessionId: 'a', seq: 3 }), false)).toBe(3)
  })

  it('同一 (sessionId, seq, kind) 重复写入复用编号，不新增', () => {
    const first = store.insertEvent(ev({ seq: 5, text: '第一次' }), false)
    const second = store.insertEvent(ev({ seq: 5, text: '第二次' }), false)
    expect(second).toBe(first)
    expect(store.getEvent('session-a', first)?.text).toBe('第二次')
  })

  it('同一 seq 的不同 kind 各占一个编号（assistant 正文 + 思考）', () => {
    const a = store.insertEvent(ev({ seq: 7, kind: 'assistant', text: '正文' }), false)
    const b = store.insertEvent(ev({ seq: 7, kind: 'reasoning', text: '思考' }), false)
    expect(a).not.toBe(b)
  })

  it('按 (sessionId, eventNo) 唯一定位事件', () => {
    store.insertEvent(ev({ sessionId: 'a', seq: 1, text: 'A1' }), false)
    store.insertEvent(ev({ sessionId: 'b', seq: 1, text: 'B1' }), false)
    expect(store.getEvent('a', 1)?.text).toBe('A1')
    expect(store.getEvent('b', 1)?.text).toBe('B1')
  })
})

describe('MemoryStore FTS', () => {
  let store: MemoryStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
  })
  afterEach(() => {
    store.close()
  })

  it('能搜到中文（逐字分词补偿）', () => {
    store.insertEvent(ev({ seq: 1, text: '把这件事记成待办，回头再处理' }), false)
    const hits = keywordSearch(store, '待办', { limit: 10 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].eventNo).toBe(1)
  })

  it('思考不进 FTS（决策①）', () => {
    store.insertEvent(ev({ seq: 1, kind: 'reasoning', text: '这是模型内部思考' }), false)
    const hits = keywordSearch(store, '内部思考', { limit: 10 })
    expect(hits).toHaveLength(0)
  })

  it('FTS 命中能回链到事件正文', () => {
    store.insertEvent(ev({ seq: 3, text: '关于登录超时的排查记录' }), false)
    const hits = keywordSearch(store, '登录', { limit: 10 })
    const event = store.getRecordByRowId(hits[0].rowId)
    expect(event?.text).toContain('登录超时')
  })

  it('相同 sessionId+seq 不同 kind 时 FTS 只索引非 reasoning', () => {
    store.insertEvent(ev({ seq: 9, kind: 'assistant', text: '可见回复内容' }), false)
    store.insertEvent(ev({ seq: 9, kind: 'reasoning', text: '不可见思考内容' }), false)
    expect(keywordSearch(store, '可见回复', { limit: 10 })).toHaveLength(1)
    expect(keywordSearch(store, '不可见思考', { limit: 10 })).toHaveLength(0)
  })
})

describe('MemoryStore 水位线与统计', () => {
  let store: MemoryStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
  })
  afterEach(() => {
    store.close()
  })

  it('水位线可写入并读回', () => {
    store.setWatermark({
      sessionId: 'a',
      lastSeq: 42,
      indexedAt: '2026-11-15T00:00:00.000Z',
      eventCount: 100,
    })
    expect(store.getWatermark('a')?.lastSeq).toBe(42)
  })

  it('同一个会话的水位线更新而非新增', () => {
    store.setWatermark({ sessionId: 'a', lastSeq: 1, indexedAt: 'x', eventCount: 1 })
    store.setWatermark({ sessionId: 'a', lastSeq: 9, indexedAt: 'y', eventCount: 2 })
    expect(store.listWatermarks()).toHaveLength(1)
    expect(store.getWatermark('a')?.lastSeq).toBe(9)
  })

  it('status 统计事件与各类子集', () => {
    store.insertEvent(ev({ seq: 1, kind: 'user' }), false)
    store.insertEvent(ev({ seq: 2, kind: 'reasoning' }), false)
    store.insertEvent(ev({ seq: 3, kind: 'summary' }), true)
    const s = store.status()
    expect(s.sessions).toBe(1)
    expect(s.events).toBe(3)
    expect(s.reasoning).toBe(1)
    expect(s.summaries).toBe(1)
    expect(s.shadowed).toBe(1)
  })

  it('列出某会话的事件编号', () => {
    store.insertEvent(ev({ seq: 1 }), false)
    store.insertEvent(ev({ seq: 2 }), false)
    expect(store.listEventNos('session-a')).toEqual([1, 2])
  })
})

describe('MemoryStore 持久化', () => {
  it('文件库能持久化并重开读取', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-store-'))
    try {
      const dbPath = join(dir, 'nested', 'memory.sqlite')
      const store = new MemoryStore({ path: dbPath })
      store.insertEvent(ev({ seq: 1, text: '持久化内容' }), false)
      store.close()

      const reopened = new MemoryStore({ path: dbPath })
      expect(reopened.getEvent('session-a', 1)?.text).toBe('持久化内容')
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
