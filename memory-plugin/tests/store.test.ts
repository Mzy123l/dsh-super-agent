// 存储与索引测试：验证「会话内线性编号」是核心不变量。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store/sqlite.js'
import { buildFtsQuery, segmentForFts } from '../src/search/segment.js'

describe('线性索引', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('第一条消息 idx = 0', () => {
    const idx = store.appendMessage({
      sessionId: 's', role: 'user', text: '第一个 prompt', at: '2026-01-01T00:00:00Z',
    })
    expect(idx).toBe(0)
  })

  it('严格线性递增，无空洞', () => {
    const idxs = ['a', 'b', 'c', 'd'].map((t, i) =>
      store.appendMessage({ sessionId: 's', role: i % 2 ? 'assistant' : 'user', text: t, at: 'x' }))
    expect(idxs).toEqual([0, 1, 2, 3])
  })

  it('不同会话各自从 0 开始', () => {
    expect(store.appendMessage({ sessionId: 'a', role: 'user', text: 'a0', at: 'x' })).toBe(0)
    expect(store.appendMessage({ sessionId: 'a', role: 'user', text: 'a1', at: 'x' })).toBe(1)
    expect(store.appendMessage({ sessionId: 'b', role: 'user', text: 'b0', at: 'x' })).toBe(0)
    expect(store.appendMessage({ sessionId: 'b', role: 'user', text: 'b1', at: 'x' })).toBe(1)
    // 回到 a 继续
    expect(store.appendMessage({ sessionId: 'a', role: 'user', text: 'a2', at: 'x' })).toBe(2)
  })

  it('同会话同角色同正文重复写入复用编号', () => {
    const first = store.appendMessage({ sessionId: 's', role: 'user', text: '重复内容', at: 'x' })
    const second = store.appendMessage({ sessionId: 's', role: 'user', text: '重复内容', at: 'y' })
    expect(second).toBe(first)
    expect(store.count('s')).toBe(1)
  })

  it('同正文不同角色各占一个编号', () => {
    const a = store.appendMessage({ sessionId: 's', role: 'user', text: '同样的话', at: 'x' })
    const b = store.appendMessage({ sessionId: 's', role: 'assistant', text: '同样的话', at: 'x' })
    expect(a).not.toBe(b)
  })

  it('索引范围正确反映最小与最大', () => {
    for (const t of ['x', 'y', 'z']) store.appendMessage({ sessionId: 's', role: 'user', text: t, at: 'x' })
    expect(store.indexRange('s')).toEqual({ min: 0, max: 2 })
  })

  it('空会话无索引范围', () => {
    expect(store.indexRange('nope')).toBeUndefined()
  })
})

describe('上下文状态与便签', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('markOutOfContext 只改状态，编号保留', () => {
    for (const t of ['a', 'b', 'c']) store.appendMessage({ sessionId: 's', role: 'user', text: t, at: 'x' })
    store.markOutOfContext('s', 0, 1)
    expect(store.getMessage('s', 0)?.inContext).toBe(false)
    expect(store.getMessage('s', 1)?.inContext).toBe(false)
    expect(store.getMessage('s', 2)?.inContext).toBe(true)
    // 编号没变
    expect(store.getMessage('s', 0)?.idx).toBe(0)
  })

  it('addTag 追加便签且去重', () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '内容', at: 'x' })
    store.addTag('s', 0, '已提炼')
    store.addTag('s', 0, '已提炼')
    expect(store.getMessage('s', 0)?.tags).toEqual(['已提炼'])
  })

  it('便签不影响正文', () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '原文', at: 'x' })
    store.addTag('s', 0, '标签')
    expect(store.getMessage('s', 0)?.text).toBe('原文')
  })
})

describe('检索', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('中文能搜到（逐字分词）', () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '把这件事记成待办，回头再处理', at: 'x' })
    const hits = store.searchFts(buildFtsQuery('待办'), 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.idx).toBe(0)
  })

  it('思考内容也进 FTS（不再区分类型）', () => {
    store.appendMessage({ sessionId: 's', role: 'assistant', text: '我在想这个方案是否可行', at: 'x' })
    const hits = store.searchFts(buildFtsQuery('方案'), 10)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('限定会话时只返回该会话', () => {
    store.appendMessage({ sessionId: 'a', role: 'user', text: '共同关键词', at: 'x' })
    store.appendMessage({ sessionId: 'b', role: 'user', text: '共同关键词', at: 'x' })
    const hits = store.searchFts(buildFtsQuery('共同关键词'), 10, 'a')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe('a')
  })

  it('已离开上下文的消息仍可检索', () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '重要信息', at: 'x' })
    store.markOutOfContext('s', 0, 0)
    const hits = store.searchFts(buildFtsQuery('重要信息'), 10)
    expect(hits).toHaveLength(1)
  })
})

describe('持久化', () => {
  it('文件库重开后数据与编号都在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'))
    try {
      const p = join(dir, 'nested', 'm.sqlite')
      const s1 = new MemoryStore({ path: p })
      s1.appendMessage({ sessionId: 's', role: 'user', text: '持久化', at: 'x' })
      s1.close()

      const s2 = new MemoryStore({ path: p })
      expect(s2.getMessage('s', 0)?.text).toBe('持久化')
      expect(s2.indexRange('s')).toEqual({ min: 0, max: 0 })
      s2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
