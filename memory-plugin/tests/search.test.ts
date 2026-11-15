// 向量检索测试：验证真的能跑，而非空实现。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { SqliteVectorStore, HashingEmbedding, cosine, tokenize } from '../src/search/vector.js'
import { vectorId, parseVectorId, search } from '../src/search/index.js'

describe('tokenize', () => {
  it('CJK 逐字切分', () => {
    expect(tokenize('待办事项')).toEqual(['待', '办', '事', '项'])
  })

  it('拉丁按词切分并小写', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world'])
  })

  it('混合切分', () => {
    expect(tokenize('日志abc')).toEqual(['日', '志', 'abc'])
  })

  it('标点被跳过', () => {
    expect(tokenize('a,b')).toEqual(['a', 'b'])
  })
})

describe('cosine', () => {
  it('同向为 1', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
  })

  it('正交为 0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('零向量返回 0', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })

  it('长度不等时按较短的算', () => {
    expect(() => cosine([1], [1, 2])).not.toThrow()
  })
})

describe('HashingEmbedding', () => {
  it('输出固定维度且已归一化', async () => {
    const e = new HashingEmbedding(128)
    const v = await e.embed('测试文本')
    expect(v).toHaveLength(128)
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('相同文本产生相同向量', async () => {
    const e = new HashingEmbedding(64)
    const a = await e.embed('一样的话')
    const b = await e.embed('一样的话')
    expect(a).toEqual(b)
  })

  it('词重合度高的文本相似度更高', async () => {
    const e = new HashingEmbedding(512)
    const base = await e.embed('登录超时的排查记录')
    const similar = await e.embed('登录超时怎么排查')
    const different = await e.embed('数据库索引优化方案')
    expect(cosine(base, similar)).toBeGreaterThan(cosine(base, different))
  })

  it('空文本不抛错', async () => {
    const e = new HashingEmbedding(32)
    const v = await e.embed('')
    expect(v).toHaveLength(32)
  })
})

describe('SqliteVectorStore', () => {
  let store: MemoryStore
  let vs: SqliteVectorStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    vs = new SqliteVectorStore(store.raw)
  })
  afterEach(() => { store.close() })

  it('写入后 count 增加', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '内容', at: 'x' })
    expect(vs.count()).toBe(0)
    await vs.upsert(vectorId('s', 0), [1, 0, 0])
    expect(vs.count()).toBe(1)
  })

  it('重复写入同一 id 不增加条数', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '内容', at: 'x' })
    await vs.upsert(vectorId('s', 0), [1, 0, 0])
    await vs.upsert(vectorId('s', 0), [0, 1, 0])
    expect(vs.count()).toBe(1)
  })

  it('检索能返回最相近的', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: 'a', at: 'x' })
    store.appendMessage({ sessionId: 's', role: 'user', text: 'b', at: 'x' })
    await vs.upsert(vectorId('s', 0), [1, 0, 0])
    await vs.upsert(vectorId('s', 1), [0, 1, 0])

    const hits = await vs.search([1, 0, 0], 1)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.id).toBe('s#0')
    expect(hits[0]?.score).toBeCloseTo(1)
  })

  it('维度不匹配的向量被跳过', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: 'a', at: 'x' })
    await vs.upsert(vectorId('s', 0), [1, 0, 0])
    const hits = await vs.search([1, 0], 10)
    expect(hits).toHaveLength(0)
  })

  it('clear 清空全部', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: 'a', at: 'x' })
    await vs.upsert(vectorId('s', 0), [1, 0])
    await vs.clear()
    expect(vs.count()).toBe(0)
  })
})

describe('vectorId', () => {
  it('构造与解析往返一致', () => {
    const id = vectorId('session-abc', 7)
    expect(id).toBe('session-abc#7')
    expect(parseVectorId(id)).toEqual({ sessionId: 'session-abc', idx: 7 })
  })

  it('非法 id 返回 undefined', () => {
    expect(parseVectorId('no-hash')).toBeUndefined()
    expect(parseVectorId('#abc')).toBeUndefined()
    expect(parseVectorId('s#-1')).toBeUndefined()
  })
})

describe('search 整合', () => {
  let store: MemoryStore
  let vs: SqliteVectorStore
  let emb: HashingEmbedding
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    vs = new SqliteVectorStore(store.raw)
    emb = new HashingEmbedding(256)
  })
  afterEach(() => { store.close() })

  it('keyword 模式能命中并返回全量正文', async () => {
    const long = '这是一段很长的内容'.repeat(200)
    store.appendMessage({ sessionId: 's', role: 'user', text: `待办事项：${long}`, at: 'x' })

    const hits = await search({ store }, '待办', { mode: 'keyword' })
    expect(hits.length).toBeGreaterThan(0)
    // 返回全量，不截断
    expect(hits[0]?.text.length).toBeGreaterThan(1000)
    expect(hits[0]?.text).toContain('待办事项')
  })

  it('结果带 idx 与便签', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '关键词内容', at: 'x' })
    store.addTag('s', 0, '已提炼')
    const hits = await search({ store }, '关键词', {})
    expect(hits[0]?.idx).toBe(0)
    expect(hits[0]?.tags).toContain('已提炼')
  })

  it('空查询返回空', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: 'x', at: 'x' })
    expect(await search({ store }, '   ', {})).toHaveLength(0)
  })

  it('hybrid 模式合并向量路', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '登录超时排查', at: 'x' })
    store.appendMessage({ sessionId: 's', role: 'user', text: '数据库优化', at: 'x' })
    // 给两条都写向量
    await vs.upsert(vectorId('s', 0), await emb.embed('登录超时排查'))
    await vs.upsert(vectorId('s', 1), await emb.embed('数据库优化'))

    const hits = await search({ store, vectorStore: vs, embedding: emb }, '登录超时', { mode: 'hybrid' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.idx).toBe(0)
  })

  it('向量路故障时不影响关键词结果', async () => {
    store.appendMessage({ sessionId: 's', role: 'user', text: '关键词命中', at: 'x' })
    const broken = {
      upsert: async () => {},
      search: async () => { throw new Error('boom') },
      count: () => 0,
      clear: async () => {},
    }
    const hits = await search(
      { store, vectorStore: broken, embedding: emb },
      '关键词',
      { mode: 'hybrid' },
    )
    expect(hits.length).toBeGreaterThan(0)
  })

  it('限定会话时只返回该会话', async () => {
    store.appendMessage({ sessionId: 'a', role: 'user', text: '共同词', at: 'x' })
    store.appendMessage({ sessionId: 'b', role: 'user', text: '共同词', at: 'x' })
    const hits = await search({ store }, '共同词', { sessionId: 'a' })
    expect(hits.every(h => h.sessionId === 'a')).toBe(true)
  })
})
