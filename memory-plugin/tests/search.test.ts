// search 模块测试：FTS 查询构造、关键词搜索、RRF 合并、向量回链、统一入口

import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { buildFtsQuery, keywordSearch } from '../src/search/keyword.js'
import { cosine, NoopVectorStore, OpenAICompatVectorStore, resolveVectorHits } from '../src/search/vector.js'
import { mergeSearch, rrfMerge, RRF_K } from '../src/search/merge.js'
import { search, searchReasoning } from '../src/search/index.js'
import type { EmbeddingProvider, MemoryRecordResult } from '../src/types.js'

function record(partial: Partial<MemoryRecordResult> & { seq: number; kind: MemoryRecordResult['kind']; text: string }): MemoryRecordResult {
  return {
    sessionId: 'sess-a',
    at: new Date(1700000000000).toISOString(),
    shadowed: false,
    ...partial,
  }
}

describe('buildFtsQuery', () => {
  it('多词默认 AND 并按字面转义', () => {
    expect(buildFtsQuery('foo bar')).toBe('"foo" AND "bar"')
  })
  it('CJK 词转单字 phrase', () => {
    expect(buildFtsQuery('待办')).toBe('"待 办"')
    expect(buildFtsQuery('日志 时间戳')).toBe('"日 志" AND "时 间 戳"')
  })
  it('混合词拆 runs', () => {
    expect(buildFtsQuery('日志abc')).toBe('("日 志" AND "abc")')
  })
  it('显式 OR 保留', () => {
    expect(buildFtsQuery('待办 OR reminder')).toBe('"待 办" OR "reminder"')
  })
  it('引号转义', () => {
    expect(buildFtsQuery('a"b')).toBe('"a""b"')
  })
  it('悬挂 OR 被清理', () => {
    expect(buildFtsQuery('todo OR')).toBe('"todo"')
    expect(buildFtsQuery('OR')).toBeUndefined()
  })
  it('空查询返回 undefined', () => {
    expect(buildFtsQuery('   ')).toBeUndefined()
  })
})

describe('keywordSearch', () => {
  it('命中并回链 shadowed 标记与 snippet', () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 1, kind: 'user', text: '这个日志时间戳不对，记成待办' }), true)
    store.insertRecord(record({ seq: 2, kind: 'user', text: '无关内容' }), false)
    const results = keywordSearch(store, '待办', { limit: 10 })
    expect(results).toHaveLength(1)
    expect(results[0]?.shadowed).toBe(true)
    expect(results[0]?.text).toContain('待办')
    expect(typeof results[0]?.rank).toBe('number')
    store.close()
  })

  it('--order time 生效', () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 1, kind: 'user', text: 'topic one', at: new Date(1700000000000).toISOString() }), false)
    store.insertRecord(record({ seq: 2, kind: 'user', text: 'topic two', at: new Date(1800000000000).toISOString() }), false)
    const results = keywordSearch(store, 'topic', { order: 'time', limit: 10 })
    expect(results[0]?.seq).toBe(2)
    store.close()
  })

  it('空查询返回空数组', () => {
    const store = new MemoryStore()
    expect(keywordSearch(store, '', {})).toEqual([])
    store.close()
  })
})

describe('向量层', () => {
  it('NoopVectorStore：写入丢弃、检索为空、count=0', async () => {
    const noop = new NoopVectorStore()
    await noop.upsert('r:s:1:user', [1, 2, 3])
    expect(await noop.search([1, 2, 3], 5)).toEqual([])
    expect(noop.count()).toBe(0)
    await noop.clear()
  })

  it('OpenAICompatVectorStore：余弦 top-k 排序正确', async () => {
    const fakeProvider: EmbeddingProvider = {
      async embed(text: string) {
        // 简单词袋 embedding：够测排序语义
        return text.includes('待办') ? [1, 0, 0] : [0, 1, 0]
      },
    }
    const store = new OpenAICompatVectorStore(fakeProvider)
    await store.upsert('r:s:1:user', [1, 0, 0])
    await store.upsert('r:s:2:user', [0, 1, 0])
    await store.upsert('r:s:3:user', [0.9, 0.1, 0])
    expect(store.count()).toBe(3)
    const hits = await store.search([1, 0, 0], 2)
    expect(hits[0]?.id).toBe('r:s:1:user')
    expect(hits[1]?.id).toBe('r:s:3:user')
    await store.clear()
    expect(store.count()).toBe(0)
  })

  it('cosine：正交为 0、平行为 1、零向量为 0、维度不等为 0', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(cosine([2, 0], [5, 0])).toBeCloseTo(1)
    expect(cosine([0, 0], [1, 1])).toBe(0)
    expect(cosine([1], [1, 2])).toBe(0)
  })

  it('OpenAICompatEmbedding.embed：mock 端点返回向量；HTTP 错误抛出', async () => {
    const { OpenAICompatEmbedding } = await import('../src/search/vector.js')
    const originalFetch = globalThis.fetch
    // 成功路径
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })) as typeof fetch
    try {
      const client = new OpenAICompatEmbedding('test-key', 'https://example.test/v1', 'test-model')
      const vec = await client.embed('hello')
      expect(vec).toEqual([0.1, 0.2, 0.3])
      // fromEnv：缺 key/model 返回 undefined
      expect(OpenAICompatEmbedding.fromEnv()).toBeUndefined()
      // HTTP 500 抛错
      globalThis.fetch = (async () => new Response('err', { status: 500 })) as typeof fetch
      await expect(client.embed('hello')).rejects.toThrow(/500/)
      // 响应缺 embedding 抛错
      globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch
      await expect(client.embed('hello')).rejects.toThrow(/no embedding/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('resolveVectorHits：r:/n: 双前缀回链，reasoning 标记 kind=reasoning', () => {
    const store = new MemoryStore()
    store.insertRecord(record({ sessionId: 'sess-a', seq: 5, kind: 'assistant', text: '正文' }), true)
    store.insertReasoning({ sessionId: 'sess-a', seq: 6, at: '2026-01-01T00:00:00.000Z', text: '思考' })
    const hits = resolveVectorHits(store, [
      { id: 'r:sess-a:5:assistant', score: 0.9 },
      { id: 'n:sess-a:6', score: 0.8 },
      { id: 'r:sess-a:99:user', score: 0.7 }, // 记录不存在 → 跳过
      { id: 'garbage', score: 0.6 }, // 非法 id → 跳过
    ])
    expect(hits).toHaveLength(2)
    expect(hits[0]?.kind).toBe('assistant')
    expect(hits[0]?.record?.shadowed).toBe(true)
    expect(hits[1]?.kind).toBe('reasoning')
    expect(hits[1]?.reasoning?.text).toBe('思考')
    store.close()
  })
})

describe('RRF 合并', () => {
  it('单路：顺序与输入一致，分数 = 1/(k+rank)', () => {
    const items = [
      { id: 'a', payload: record({ seq: 1, kind: 'user', text: 'a' }) },
      { id: 'b', payload: record({ seq: 2, kind: 'user', text: 'b' }) },
    ]
    const merged = rrfMerge([items], 10)
    expect(merged[0]?.payload).toMatchObject({ seq: 1 })
    expect(merged[0]?.score).toBeCloseTo(1 / (RRF_K + 1))
    expect(merged[1]?.score).toBeCloseTo(1 / (RRF_K + 2))
  })

  it('双路命中同一文档：分数叠加排最前', () => {
    const kw = [{ id: 'a', payload: record({ seq: 1, kind: 'user', text: 'a' }) }]
    const vec = [{ id: 'a', payload: record({ seq: 1, kind: 'user', text: 'a' }) }, { id: 'b', payload: record({ seq: 2, kind: 'user', text: 'b' }) }]
    const merged = rrfMerge([kw, vec], 10)
    expect(merged[0]?.payload).toMatchObject({ seq: 1 })
    expect(merged[0]?.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1))
    // b 单路第二
    expect(merged[1]?.payload).toMatchObject({ seq: 2 })
  })

  it('reasoning 结果的 kind 标记为 reasoning', () => {
    const items = [{ id: 'n:s:1', payload: { sessionId: 's', seq: 1, at: '', text: '思考' }, isReasoning: true }]
    const merged = rrfMerge([items], 10)
    expect(merged[0]?.kind).toBe('reasoning')
    expect(merged[0]?.isReasoning).toBe(true)
  })

  it('limit 截断', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `x${i}`,
      payload: record({ seq: i, kind: 'user' as const, text: String(i) }),
    }))
    expect(rrfMerge([items], 5)).toHaveLength(5)
  })

  it('mergeSearch：Noop（空向量路）下退化为关键词序', () => {
    const kw = [
      record({ seq: 1, kind: 'user', text: 'a' }),
      record({ seq: 2, kind: 'user', text: 'b' }),
    ]
    const merged = mergeSearch(kw, [], { limit: 10 })
    expect(merged).toHaveLength(2)
    expect(merged[0]?.payload).toMatchObject({ seq: 1 })
  })
})

describe('search 统一入口', () => {
  it('keyword 模式走 FTS；hybrid 无 embedding 时退化 keyword', async () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 1, kind: 'user', text: '记成待办先干完手头的事' }), false)
    const ctx = { store, vectorStore: new NoopVectorStore() }
    const kw = await search(ctx, '待办', { mode: 'keyword' })
    expect(kw).toHaveLength(1)
    const hybrid = await search(ctx, '待办', { mode: 'hybrid' })
    expect(hybrid).toHaveLength(1)
    expect(hybrid[0]?.payload).toMatchObject({ seq: 1, kind: 'user' })
    store.close()
  })

  it('embedding 注入后 hybrid 两路合并（fake 端点）', async () => {
    const store = new MemoryStore()
    store.insertRecord(record({ sessionId: 'sess-a', seq: 1, kind: 'user', text: '日志时间戳不对' }), false)
    store.insertRecord(record({ sessionId: 'sess-a', seq: 2, kind: 'assistant', text: '另一个话题' }), false)
    store.insertReasoning({ sessionId: 'sess-a', seq: 3, at: '2026-01-01T00:00:00.000Z', text: '时间戳相关的思考' })

    const vectorStore = new OpenAICompatVectorStore({
      async embed(text: string) {
        // 待办/时间戳语义 → [1,0]；其他 → [0,1]
        return /待办|时间戳/.test(text) ? [1, 0] : [0, 1]
      },
    })
    for (const id of ['r:sess-a:1:user', 'r:sess-a:2:assistant', 'n:sess-a:3']) {
      await vectorStore.upsert(id, /1:user|n:/.test(id) ? [1, 0] : [0, 1])
    }
    const fakeEmbedding = { embed: async (text: string) => (/待办|时间戳/.test(text) ? [1, 0] : [0, 1]) }

    const results = await search(
      { store, vectorStore, embedding: fakeEmbedding as never },
      '待办',
      { mode: 'hybrid', limit: 10 },
    )
    // 关键词命中 seq1；向量命中 seq1(user) + seq3(reasoning)
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results[0]?.payload).toMatchObject({ seq: 1 })
    // reasoning 命中在结果里且 kind=reasoning
    const reasoningHit = results.find((r) => r.isReasoning)
    expect(reasoningHit).toBeDefined()
    expect((reasoningHit?.payload as { text: string }).text).toContain('时间戳')
    store.close()
  })

  it('embedding 抛错时 hybrid 退化为关键词不失败', async () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 1, kind: 'user', text: '正常内容待办' }), false)
    const broken = { embed: async () => { throw new Error('endpoint down') } }
    const results = await search(
      { store, vectorStore: new OpenAICompatVectorStore(broken as never), embedding: broken as never },
      '待办',
      { mode: 'hybrid' },
    )
    expect(results).toHaveLength(1)
    store.close()
  })

  it('searchReasoning 只返回向量命中的思考', async () => {
    const store = new MemoryStore()
    store.insertReasoning({ sessionId: 'sess-a', seq: 3, at: '2026-01-01T00:00:00.000Z', text: '时间戳相关的思考' })
    const vectorStore = new OpenAICompatVectorStore({ async embed() { return [1, 0] } })
    await vectorStore.upsert('n:sess-a:3', [1, 0])
    const hits = await searchReasoning(
      { store, vectorStore, embedding: { embed: async () => [1, 0] } as never },
      '时间戳',
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.text).toContain('时间戳')
    // 无向量实现 → 空
    expect(await searchReasoning({ store }, '时间戳')).toEqual([])
    store.close()
  })
})
