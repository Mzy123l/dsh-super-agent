// 向量索引测试：写入、指纹跳过、会话隔离。

import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { SqliteVectorStore, HashingEmbedding } from '../src/search/vector.js'
import { search } from '../src/search/index.js'
import { syncVectors, forgetVectors, vectorTextOf, fingerprintText } from '../src/search/sync.js'
import type { UnitKind } from '../src/types.js'

const AT = '2026-11-15T00:00:00.000Z'

function seed(store: MemoryStore, sessionId: string, content: string, kind: UnitKind = 'reply'): void {
  store.appendUnit({ sessionId, kind, summary: '', content, at: AT, inContext: true, tags: [] })
}

describe('向量索引文本', () => {
  it('正文与 summary 合并', () => {
    expect(vectorTextOf({ content: '正文', summary: '摘要' })).toBe('摘要\n正文')
  })

  it('只有正文时就是正文', () => {
    expect(vectorTextOf({ content: '正文', summary: '' })).toBe('正文')
  })

  it('指纹随内容变化', () => {
    expect(fingerprintText('a')).not.toBe(fingerprintText('b'))
    expect(fingerprintText('a')).toBe(fingerprintText('a'))
  })
})

describe('向量同步', () => {
  it('把所有单位写进向量表', async () => {
    const store = new MemoryStore({ path: ':memory:' })
    const vs = new SqliteVectorStore(store.raw)
    const emb = new HashingEmbedding()
    seed(store, 's', '第一条内容')
    seed(store, 's', '第二条内容')

    const report = await syncVectors(store, vs, emb, 's', new Map())
    expect(report.scanned).toBe(2)
    expect(report.embedded).toBe(2)
    expect(vs.count()).toBe(2)
    store.close()
  })

  it('指纹未变时跳过重算', async () => {
    const store = new MemoryStore({ path: ':memory:' })
    const vs = new SqliteVectorStore(store.raw)
    const emb = new HashingEmbedding()
    const seen = new Map<string, string>()
    seed(store, 's', '内容')

    await syncVectors(store, vs, emb, 's', seen)
    const second = await syncVectors(store, vs, emb, 's', seen)
    expect(second.embedded).toBe(0)
    expect(second.skipped).toBe(1)
    store.close()
  })

  it('summary 变更后重算', async () => {
    const store = new MemoryStore({ path: ':memory:' })
    const vs = new SqliteVectorStore(store.raw)
    const emb = new HashingEmbedding()
    const seen = new Map<string, string>()
    seed(store, 's', '内容')
    await syncVectors(store, vs, emb, 's', seen)

    store.setSummary('s', 0, '新的摘要')
    forgetVectors(seen, 's', 0)
    const third = await syncVectors(store, vs, emb, 's', seen)
    expect(third.embedded).toBe(1)
    store.close()
  })

  it('thinking 也进向量表（与关键词索引策略相反）', async () => {
    const store = new MemoryStore({ path: ':memory:' })
    const vs = new SqliteVectorStore(store.raw)
    const emb = new HashingEmbedding()
    seed(store, 's', '思考内容', 'thinking')

    await syncVectors(store, vs, emb, 's', new Map())
    expect(vs.count()).toBe(1)
    store.close()
  })
})

describe('向量检索的会话隔离', () => {
  it('限定会话时不返回其他会话的结果', async () => {
    const store = new MemoryStore({ path: ':memory:' })
    const vs = new SqliteVectorStore(store.raw)
    const emb = new HashingEmbedding()
    const seenA = new Map<string, string>()
    const seenB = new Map<string, string>()
    seed(store, 'A', '苹果香蕉水果相关内容')
    seed(store, 'B', '苹果香蕉水果相关内容')

    await syncVectors(store, vs, emb, 'A', seenA)
    await syncVectors(store, vs, emb, 'B', seenB)

    const hits = await search({ store, vectorStore: vs, embedding: emb }, '苹果香蕉', {
      mode: 'hybrid', sessionId: 'A', limit: 10,
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(h => h.sessionId === 'A')).toBe(true)
    store.close()
  })

  it('不限定会话时两边的都能返回', async () => {
    const store = new MemoryStore({ path: ':memory:' })
    const vs = new SqliteVectorStore(store.raw)
    const emb = new HashingEmbedding()
    seed(store, 'A', '苹果香蕉水果')
    seed(store, 'B', '苹果香蕉水果')
    await syncVectors(store, vs, emb, 'A', new Map())
    await syncVectors(store, vs, emb, 'B', new Map())

    const hits = await search({ store, vectorStore: vs, embedding: emb }, '苹果香蕉', {
      mode: 'hybrid', limit: 10,
    })
    const sessions = new Set(hits.map(h => h.sessionId))
    expect(sessions.size).toBe(2)
    store.close()
  })
})
