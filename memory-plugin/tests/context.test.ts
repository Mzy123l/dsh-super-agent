// 上下文同步测试：验证「索引只来自实际传给模型的消息」。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { buildFtsQuery } from '../src/search/segment.js'
import { syncContext, visibleText, shouldIndex, normalizeRole, type ContextMessage } from '../src/ingest/context-sync.js'

/** 造一条 dsh 形状的消息。 */
function msg(role: string, text: string): ContextMessage {
  return { role, content: [{ type: 'text', text }] }
}

describe('visibleText', () => {
  it('拼接所有 text 块', () => {
    expect(visibleText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('字符串内容直接返回', () => {
    expect(visibleText({ content: 'plain' })).toBe('plain')
  })

  it('无内容返回空串', () => {
    expect(visibleText({})).toBe('')
  })
})

describe('shouldIndex', () => {
  it('system 不索引', () => {
    expect(shouldIndex(msg('system', '你是助手'))).toBe(false)
  })

  it('developer 不索引', () => {
    expect(shouldIndex(msg('developer', '规则'))).toBe(false)
  })

  it('user 索引', () => {
    expect(shouldIndex(msg('user', '你好'))).toBe(true)
  })

  it('assistant 索引', () => {
    expect(shouldIndex(msg('assistant', '回复'))).toBe(true)
  })

  it('空内容不索引', () => {
    expect(shouldIndex(msg('user', ''))).toBe(false)
  })
})

describe('normalizeRole', () => {
  it('保留已知角色', () => {
    expect(normalizeRole('user')).toBe('user')
    expect(normalizeRole('assistant')).toBe('assistant')
    expect(normalizeRole('tool')).toBe('tool')
  })

  it('未知角色归为 system', () => {
    expect(normalizeRole('weird')).toBe('system')
  })
})

describe('syncContext', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('跳过 system，第一个 user 拿到 idx=0', () => {
    const r = syncContext(store, 's', [
      msg('system', '你是助手'),
      msg('user', '第一个问题'),
      msg('assistant', '回答'),
    ], 'x')

    expect(r.indexed).toBe(2)
    expect(store.getMessage('s', 0)?.text).toBe('第一个问题')
    expect(store.getMessage('s', 0)?.role).toBe('user')
    expect(store.getMessage('s', 1)?.text).toBe('回答')
  })

  it('多轮上下文索引连续递增', () => {
    syncContext(store, 's', [msg('user', 'q1')], 'x')
    syncContext(store, 's', [msg('user', 'q1'), msg('assistant', 'a1')], 'x')
    syncContext(store, 's', [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')], 'x')

    expect(store.indexRange('s')).toEqual({ min: 0, max: 2 })
    expect(store.getMessage('s', 2)?.text).toBe('q2')
  })

  it('重复同步不产生新编号', () => {
    const ctx = [msg('user', 'q1'), msg('assistant', 'a1')]
    syncContext(store, 's', ctx, 'x')
    syncContext(store, 's', ctx, 'y')
    expect(store.count('s')).toBe(2)
  })

  it('从上下文消失的消息标记为已离开，编号保留', () => {
    syncContext(store, 's', [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')], 'x')
    // 下一轮 q1 不在上下文了
    syncContext(store, 's', [msg('assistant', 'a1'), msg('user', 'q2')], 'y')

    expect(store.getMessage('s', 0)?.inContext).toBe(false)
    expect(store.getMessage('s', 1)?.inContext).toBe(true)
    // 编号仍在
    expect(store.getMessage('s', 0)?.idx).toBe(0)
  })

  it('已离开上下文的内容仍可检索（关键需求）', () => {
    syncContext(store, 's', [msg('user', '这是很重要的待办')], 'x')
    syncContext(store, 's', [msg('user', '别的内容')], 'y')

    expect(store.getMessage('s', 0)?.inContext).toBe(false)
    const hits = store.searchFts(buildFtsQuery('待办'), 10)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.idx).toBe(0)
  })

  it('返回的 range 反映最新范围', () => {
    const r = syncContext(store, 's', [msg('user', 'a'), msg('user', 'b'), msg('user', 'c')], 'x')
    expect(r.range).toEqual({ min: 0, max: 2 })
  })
})
