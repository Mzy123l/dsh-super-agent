// MemoryStore 测试：建表、写入、FTS 维护、水位线、计数、列表过滤

import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { buildFtsQuery } from '../src/search/keyword.js'
import type { MemoryRecord, ReasoningRecord } from '../src/types.js'

function record(partial: Partial<MemoryRecord> & { seq: number; kind: MemoryRecord['kind']; text: string }): MemoryRecord {
  return {
    sessionId: 'sess-a',
    at: new Date(1700000000000 + partial.seq! * 1000).toISOString(),
    ...partial,
  }
}

function reasoning(partial: Partial<ReasoningRecord> & { seq: number; text: string }): ReasoningRecord {
  return { sessionId: 'sess-a', at: new Date(1700000000000).toISOString(), ...partial }
}

describe('MemoryStore', () => {
  it('建表：内存库可打开且 schema 可执行两次（IF NOT EXISTS）', () => {
    const store = new MemoryStore()
    store.close()
    const store2 = new MemoryStore()
    store2.close()
  })

  it('写入记录 + FTS，重复写 REPLACE 不重复', () => {
    const store = new MemoryStore()
    const r = record({ seq: 1, kind: 'user', text: '记成待办' })
    store.insertRecord(r, false)
    store.insertRecord(r, false) // 同主键再写一次
    const counts = store.counts()
    expect(counts.records).toBe(1)
    expect(counts.sessions).toBe(1)
    store.close()
  })

  it('getRecord 回链与 isShadowed', () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 5, kind: 'tool-result', text: '结果正文', turn: 3 }), true)
    const got = store.getRecord('sess-a', 5, 'tool-result')
    expect(got?.text).toBe('结果正文')
    expect(got?.turn).toBe(3)
    expect(store.isShadowed('sess-a', 5)).toBe(true)
    expect(store.isShadowed('sess-a', 6)).toBe(false)
    expect(store.getRecord('sess-a', 99, 'user')).toBeUndefined()
    store.close()
  })

  it('insertBatch 事务写入 records + reasoning', () => {
    const store = new MemoryStore()
    store.insertBatch(
      [
        { record: record({ seq: 1, kind: 'user', text: '第一条' }), shadowed: false },
        { record: record({ seq: 2, kind: 'assistant', text: '第二条' }), shadowed: true },
      ],
      [reasoning({ seq: 2, text: '思考原文' })],
    )
    expect(store.counts().records).toBe(2)
    expect(store.counts().reasoning).toBe(1)
    expect(store.counts().shadowed).toBe(1)
    store.close()
  })

  it('searchFts：英文分词 AND 查询 + rank 排序', () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 1, kind: 'user', text: 'fix the timestamp bug please' }), false)
    store.insertRecord(record({ seq: 2, kind: 'assistant', text: 'the timestamp is wrong in log' }), false)
    store.insertRecord(record({ seq: 3, kind: 'user', text: 'unrelated content' }), false)
    const hits = store.searchFts('"timestamp"', 10, false)
    expect(hits).toHaveLength(2)
    expect(hits.every((h) => typeof h.rank === 'number')).toBe(true)
    store.close()
  })

  it('searchFts：中文经 CJK 分词后命中（字级 phrase）', () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 1, kind: 'user', text: '这个日志时间戳不对，记成待办' }), false)
    // 查询侧走 buildFtsQuery 的 CJK 单字 phrase（与 keywordSearch 同路径）
    const query = buildFtsQuery('日志时间戳不对')!
    const hits = store.searchFts(query, 10, false)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.seq).toBe(1)
    store.close()
  })

  it('searchFts：按时间排序', () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 1, kind: 'user', text: 'alpha topic' }), false)
    store.insertRecord(record({ seq: 2, kind: 'user', text: 'beta topic', at: new Date(1799999999999).toISOString() }), false)
    const hits = store.searchFts('"topic"', 10, true)
    expect(hits[0]?.seq).toBe(2)
    store.close()
  })

  it('snippet 返回带高亮标记的上下文（CJK 去空格还原）', () => {
    const store = new MemoryStore()
    store.insertRecord(record({ seq: 1, kind: 'user', text: '前面铺垫很长很长很长，关键句在这里：待办事项要记住，后面还有内容' }), false)
    const query = buildFtsQuery('待办事项')!
    const snippet = store.snippet('sess-a', 1, 'user', query)
    expect(snippet).toBeDefined()
    expect(snippet).toContain('待办事项')
    store.close()
  })

  it('reasoning 写入/读取/列出（决策①：与 FTS 隔离）', () => {
    const store = new MemoryStore()
    store.insertReasoning(reasoning({ seq: 10, text: '独特思考串：ZX量子QW' }))
    store.insertRecord(record({ seq: 11, kind: 'user', text: '普通消息' }), false)
    // reasoning 表里能查到
    expect(store.getReasoning('sess-a', 10)?.text).toContain('ZX量子QW')
    // FTS 搜不到 reasoning 原文
    expect(store.searchFts('"ZX量子QW"', 10, false)).toHaveLength(0)
    // 列表过滤
    expect(store.listReasoning('sess-a')).toHaveLength(1)
    expect(store.listReasoning('sess-b')).toHaveLength(0)
    store.close()
  })

  it('listRecords 按 session/kind/shadowed/q 过滤', () => {
    const store = new MemoryStore()
    store.insertBatch(
      [
        { record: record({ sessionId: 'sess-a', seq: 1, kind: 'user', text: '苹果' }), shadowed: false },
        { record: record({ sessionId: 'sess-a', seq: 2, kind: 'user', text: '香蕉' }), shadowed: true },
        { record: record({ sessionId: 'sess-b', seq: 3, kind: 'summary', text: '摘要苹果' }), shadowed: false },
      ],
      [],
    )
    expect(store.listRecords({ sessionId: 'sess-a' })).toHaveLength(2)
    expect(store.listRecords({ kind: 'summary' })).toHaveLength(1)
    expect(store.listRecords({ shadowed: true })).toHaveLength(1)
    expect(store.listRecords({ q: '苹果' })).toHaveLength(2)
    expect(store.listRecords({ sessionId: 'sess-a', shadowed: true })).toHaveLength(1)
    const paged = store.listRecords({ limit: 1, offset: 1 })
    expect(paged).toHaveLength(1)
    store.close()
  })

  it('水位线与 meta', () => {
    const store = new MemoryStore()
    expect(store.getWatermark('sess-a')).toBeUndefined()
    store.setWatermark({ sessionId: 'sess-a', lastSeq: 42, indexedAt: '2026-01-01T00:00:00.000Z', eventCount: 100 })
    const wm = store.getWatermark('sess-a')
    expect(wm?.lastSeq).toBe(42)
    expect(wm?.eventCount).toBe(100)
    expect(store.listWatermarks()).toHaveLength(1)

    store.setMeta('lastIndexedAt', '2026-01-02T03:04:05.000Z')
    expect(store.lastIndexedAt()).toBe('2026-01-02T03:04:05.000Z')
    store.close()
  })

  it('status 汇总各表计数', () => {
    const store = new MemoryStore()
    store.insertBatch(
      [
        { record: record({ seq: 1, kind: 'user', text: 'a' }), shadowed: false },
        { record: record({ seq: 2, kind: 'summary', text: 's' }), shadowed: false },
        { record: record({ sessionId: 'sess-b', seq: 1, kind: 'user', text: 'b' }), shadowed: true },
      ],
      [reasoning({ seq: 1, text: 'r' })],
    )
    store.setMeta('lastIndexedAt', '2026-06-01T00:00:00.000Z')
    const status = store.status(7)
    expect(status.sessions).toBe(2)
    expect(status.records).toBe(3)
    expect(status.reasoning).toBe(1)
    expect(status.summaries).toBe(1)
    expect(status.shadowed).toBe(1)
    expect(status.vectors).toBe(7)
    expect(status.lastIndexedAt).toBe('2026-06-01T00:00:00.000Z')
    expect(status.watermarks).toHaveLength(0)
    store.close()
  })

  it('文件库：数据目录自动创建并持久化', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'memory-plugin-store-'))
    const dbPath = join(dir, 'nested', 'memory.sqlite')
    const store = new MemoryStore({ path: dbPath })
    store.insertRecord(record({ seq: 1, kind: 'user', text: '持久化' }), false)
    store.close()
    // 重开还能读到
    const store2 = new MemoryStore({ path: dbPath })
    expect(store2.getRecord('sess-a', 1, 'user')?.text).toBe('持久化')
    store2.close()
  })
})
