// 存储与检索测试：验证线性编号、summary 挂接、FTS 规则。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { buildFtsQuery } from '../src/search/segment.js'
import { search, vectorId, parseVectorId } from '../src/search/index.js'
import { SqliteVectorStore, HashingEmbedding, cosine, tokenize } from '../src/search/vector.js'

describe('线性编号', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  const u = (content: string, kind: 'user' | 'reply' = 'user', sessionId = 's') =>
    ({ sessionId, kind, summary: '', content, at: 'x', inContext: true, tags: [] })

  it('第一个单位编号为 0', () => {
    expect(store.appendUnit(u('第一个问题'))).toBe(0)
  })

  it('连续递增无空洞', () => {
    expect([store.appendUnit(u('a')), store.appendUnit(u('b')), store.appendUnit(u('c'))]).toEqual([0, 1, 2])
  })

  it('不同会话各自从 0 开始', () => {
    expect(store.appendUnit(u('a', 'user', 'a'))).toBe(0)
    expect(store.appendUnit(u('a', 'user', 'a2')).toString()).toBeDefined()
    expect(store.appendUnit(u('b', 'user', 'b'))).toBe(0)
    expect(store.appendUnit(u('c', 'user', 'a'))).toBe(1)
  })

  it('同会话同 kind 同内容重复写入复用编号', () => {
    const first = store.appendUnit(u('重复'))
    const second = store.appendUnit(u('重复'))
    expect(second).toBe(first)
    expect(store.count('s')).toBe(1)
  })

  it('同内容不同 kind 各占编号', () => {
    expect(store.appendUnit(u('同样的话', 'user'))).toBe(0)
    expect(store.appendUnit(u('同样的话', 'reply'))).toBe(1)
  })

  it('索引范围正确', () => {
    for (const t of ['a', 'b', 'c']) store.appendUnit(u(t))
    expect(store.indexRange('s')).toEqual({ min: 0, max: 2 })
  })

  it('空会话无范围', () => {
    expect(store.indexRange('nope')).toBeUndefined()
  })
})

describe('summary 挂接', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('挂接 summary 后编号不变、内容不变', () => {
    const idx = store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: '原文', at: 'x', inContext: true, tags: [] })
    expect(store.setSummary('s', idx, '要点')).toBe(true)
    const u = store.getUnit('s', idx)!
    expect(u.idx).toBe(idx)
    expect(u.summary).toBe('要点')
    expect(u.content).toBe('原文')
  })

  it('不存在的编号返回 false', () => {
    expect(store.setSummary('s', 99, 'x')).toBe(false)
  })

  it('status 统计已总结数量', () => {
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: 'a', at: 'x', inContext: true, tags: [] })
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: 'b', at: 'x', inContext: true, tags: [] })
    store.setSummary('s', 0, '要点')
    expect(store.status().withSummary).toBe(1)
  })
})

describe('FTS 规则', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('普通内容可搜', () => {
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: '登录超时的排查记录', at: 'x', inContext: true, tags: [] })
    expect(store.searchFts(buildFtsQuery('登录'), 10).length).toBeGreaterThan(0)
  })

  it('thinking 的 content 不进 FTS（既定决策）', () => {
    store.appendUnit({ sessionId: 's', kind: 'thinking', summary: '', content: '我在想这个方案是否可行', at: 'x', inContext: true, tags: [] })
    expect(store.searchFts(buildFtsQuery('方案'), 10)).toHaveLength(0)
  })

  it('thinking 的 summary 进 FTS', () => {
    store.appendUnit({ sessionId: 's', kind: 'thinking', summary: '', content: '内部细节', at: 'x', inContext: true, tags: [] })
    store.setSummary('s', 0, '讨论了方案可行性')
    expect(store.searchFts(buildFtsQuery('可行性'), 10).length).toBeGreaterThan(0)
  })

  it('挂接 summary 后该单位可被 summary 关键词命中', () => {
    store.appendUnit({ sessionId: 's', kind: 'tool', summary: '', content: '<tool-call name="bash">ls</tool-call>', at: 'x', inContext: true, tags: [] })
    expect(store.searchFts(buildFtsQuery('文件列表'), 10)).toHaveLength(0)
    store.setSummary('s', 0, '列出了文件列表')
    expect(store.searchFts(buildFtsQuery('文件列表'), 10).length).toBeGreaterThan(0)
  })

  it('限定会话过滤', () => {
    store.appendUnit({ sessionId: 'a', kind: 'reply', summary: '', content: '共同词', at: 'x', inContext: true, tags: [] })
    store.appendUnit({ sessionId: 'b', kind: 'reply', summary: '', content: '共同词', at: 'x', inContext: true, tags: [] })
    const hits = store.searchFts(buildFtsQuery('共同词'), 10, 'a')
    expect(hits.every(h => h.sessionId === 'a')).toBe(true)
  })

  it('已离开上下文的单位仍可搜', () => {
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: '重要信息', at: 'x', inContext: true, tags: [] })
    store.markOutOfContext('s', 0)
    expect(store.searchFts(buildFtsQuery('重要信息'), 10).length).toBeGreaterThan(0)
  })
})

describe('便签', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('追加便签并去重', () => {
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: 'x', at: 'x', inContext: true, tags: [] })
    store.addTag('s', 0, '已老化')
    store.addTag('s', 0, '已老化')
    expect(store.getUnit('s', 0)?.tags).toEqual(['已老化'])
  })

  it('便签不影响正文', () => {
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: '原文', at: 'x', inContext: true, tags: [] })
    store.addTag('s', 0, 'tag')
    expect(store.getUnit('s', 0)?.content).toBe('原文')
  })
})

describe('向量', () => {
  it('tokenize 逐字切 CJK', () => {
    expect(tokenize('待办')).toEqual(['待', '办'])
  })

  it('cosine 同向为 1', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
  })

  it('HashingEmbedding 归一化', async () => {
    const e = new HashingEmbedding(64)
    const v = await e.embed('测试')
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 5)
  })

  it('SqliteVectorStore 写入与检索', async () => {
    const store = new MemoryStore({ path: ':memory:' })
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: 'a', at: 'x', inContext: true, tags: [] })
    const vs = new SqliteVectorStore(store.raw)
    await vs.upsert(vectorId('s', 0), [1, 0, 0])
    const hits = await vs.search([1, 0, 0], 1)
    expect(hits[0]?.id).toBe('s#0')
    store.close()
  })

  it('vectorId 往返', () => {
    expect(parseVectorId(vectorId('s', 3))).toEqual({ sessionId: 's', idx: 3 })
    expect(parseVectorId('bad')).toBeUndefined()
  })
})

describe('search 整合', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('命中返回全量 content', async () => {
    const long = '详细内容'.repeat(500)
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: `待办事项：${long}`, at: 'x', inContext: true, tags: [] })
    const hits = await search({ store }, '待办', {})
    expect(hits[0]?.content.length).toBeGreaterThan(2000)
    expect(hits[0]?.content).toContain('待办事项')
  })

  it('结果带 idx/kind/summary/tags', async () => {
    store.appendUnit({ sessionId: 's', kind: 'thinking', summary: '', content: 'x', at: 'x', inContext: true, tags: [] })
    store.setSummary('s', 0, '关键词要点')
    store.addTag('s', 0, '已老化')
    const hits = await search({ store }, '关键词', {})
    expect(hits[0]?.idx).toBe(0)
    expect(hits[0]?.kind).toBe('thinking')
    expect(hits[0]?.summary).toBe('关键词要点')
    expect(hits[0]?.tags).toContain('已老化')
  })

  it('空查询返回空', async () => {
    store.appendUnit({ sessionId: 's', kind: 'reply', summary: '', content: 'x', at: 'x', inContext: true, tags: [] })
    expect(await search({ store }, '  ', {})).toHaveLength(0)
  })

  it('限定会话', async () => {
    store.appendUnit({ sessionId: 'a', kind: 'reply', summary: '', content: '共同', at: 'x', inContext: true, tags: [] })
    store.appendUnit({ sessionId: 'b', kind: 'reply', summary: '', content: '共同', at: 'x', inContext: true, tags: [] })
    const hits = await search({ store }, '共同', { sessionId: 'a' })
    expect(hits.every(h => h.sessionId === 'a')).toBe(true)
  })
})
