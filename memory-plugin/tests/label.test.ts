// 索引标注测试：验证 `#N` 作为 token 写进消息正文。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { syncContext, labelInPlace, type ContextMessage } from '../src/ingest/context-sync.js'

function msg(role: string, text: string): ContextMessage {
  return { role, content: [{ type: 'text', text }] }
}

/** 取消息的第一个 text 块。 */
function firstText(m: ContextMessage): string {
  const c = m.content
  if (!Array.isArray(c)) return ''
  for (const b of c) {
    if (b && typeof b === 'object') {
      const t = b as { type?: string; text?: string }
      if (t.type === 'text') return t.text ?? ''
    }
  }
  return ''
}

describe('labelInPlace', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore({ path: ':memory:' }) })
  afterEach(() => { store.close() })

  it('给每条消息正文加 #N 前缀', () => {
    const messages = [
      msg('system', '你是助手'),
      msg('user', '第一个问题'),
      msg('assistant', '回答'),
      msg('user', '第二个问题'),
    ]
    syncContext(store, 's', messages, 'x')
    const n = labelInPlace(messages, store, 's')

    // system 不标注
    expect(firstText(messages[0]!)).toBe('你是助手')
    // user 第一个 → #0
    expect(firstText(messages[1]!)).toBe('#0 第一个问题')
    expect(firstText(messages[2]!)).toBe('#1 回答')
    expect(firstText(messages[3]!)).toBe('#2 第二个问题')
    expect(n).toBe(3)
  })

  it('重复标注是幂等的（prefixed 标记）', () => {
    const messages = [msg('user', '内容')]
    syncContext(store, 's', messages, 'x')
    labelInPlace(messages, store, 's')
    const once = firstText(messages[0]!)
    labelInPlace(messages, store, 's')
    expect(firstText(messages[0]!)).toBe(once)
    expect(firstText(messages[0]!)).toBe('#0 内容')
  })

  it('编号与库里一致（多轮后编号稳定）', () => {
    // 第一轮
    const r1 = [msg('user', 'q1'), msg('assistant', 'a1')]
    syncContext(store, 's', r1, 'x')
    labelInPlace(r1, store, 's')
    expect(firstText(r1[0]!)).toBe('#0 q1')

    // 第二轮新增
    const r2 = [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')]
    syncContext(store, 's', r2, 'x')
    labelInPlace(r2, store, 's')
    // 旧消息编号不变
    expect(firstText(r2[0]!)).toBe('#0 q1')
    expect(firstText(r2[1]!)).toBe('#1 a1')
    // 新消息接着递增
    expect(firstText(r2[2]!)).toBe('#2 q2')
  })

  it('system 消息不占编号也不标注', () => {
    const messages = [msg('system', '框架'), msg('user', '内容')]
    syncContext(store, 's', messages, 'x')
    labelInPlace(messages, store, 's')
    expect(firstText(messages[0]!)).toBe('框架')
    expect(firstText(messages[1]!)).toBe('#0 内容')
  })
})
