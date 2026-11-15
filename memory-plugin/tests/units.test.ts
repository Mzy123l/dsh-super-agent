// 单位提取测试：验证每个独立单元各占一号、工具调用与结果合并。

import { describe, expect, it } from 'vitest'
import { extractUnits, composeToolContent, textOf, blocksOf, shouldIndex } from '../src/ingest/units.js'
import type { ContextMessage } from '../src/types.js'

const AT = '2026-11-15T00:00:00.000Z'

function msg(role: string, content: unknown, extra: Partial<ContextMessage> = {}): ContextMessage {
  return { role, content, ...extra }
}

describe('单位划分', () => {
  it('user 消息一个单位', () => {
    const units = extractUnits([msg('user', [{ type: 'text', text: '帮我看看' }])], AT, 's')
    expect(units).toHaveLength(1)
    expect(units[0]?.kind).toBe('user')
    expect(units[0]?.content).toBe('帮我看看')
  })

  it('system 不产生单位', () => {
    const units = extractUnits([msg('system', [{ type: 'text', text: '你是助手' }])], AT, 's')
    expect(units).toHaveLength(0)
  })

  it('思考、工具调用、正文各成一个单位', () => {
    const units = extractUnits([
      msg('user', [{ type: 'text', text: 'q' }]),
      msg('assistant', [
        { type: 'reasoning', text: '先看日志' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        { type: 'text', text: '结果如下' },
      ]),
    ], AT, 's')

    expect(units.map(u => u.kind)).toEqual(['user', 'thinking', 'tool', 'reply'])
  })

  it('工具调用与结果合并为一个单位', () => {
    const units = extractUnits([
      msg('assistant', [
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      ]),
      msg('tool', [{ type: 'text', text: 'file1 file2' }], { source: { callId: 'c1' } }),
    ], AT, 's')

    expect(units).toHaveLength(1)
    const u = units[0]!
    expect(u.kind).toBe('tool')
    expect(u.content).toContain('<tool-call name="bash">')
    expect(u.content).toContain('{"command":"ls"}')
    expect(u.content).toContain('<tool-result isError="false">')
    expect(u.content).toContain('file1 file2')
  })

  it('没有结果的调用也成单位', () => {
    const units = extractUnits([
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]),
    ], AT, 's')
    expect(units).toHaveLength(1)
    expect(units[0]?.content).toContain('<tool-call')
  })

  it('两个工具调用各成两个单位', () => {
    const units = extractUnits([
      msg('assistant', [
        { type: 'tool-call', id: 'c1', name: 'a', arguments: '1' },
        { type: 'tool-call', id: 'c2', name: 'b', arguments: '2' },
      ]),
      msg('tool', [{ type: 'text', text: 'r1' }], { source: { callId: 'c1' } }),
      msg('tool', [{ type: 'text', text: 'r2' }], { source: { callId: 'c2' } }),
    ], AT, 's')

    expect(units).toHaveLength(2)
    expect(units[0]?.content).toContain('tool-call name="a"')
    expect(units[0]?.content).toContain('r1')
    expect(units[1]?.content).toContain('tool-call name="b"')
    expect(units[1]?.content).toContain('r2')
  })

  it('空思考/空正文不产生单位', () => {
    const units = extractUnits([
      msg('assistant', [
        { type: 'reasoning', text: '   ' },
        { type: 'text', text: '' },
      ]),
    ], AT, 's')
    expect(units).toHaveLength(0)
  })

  it('错误结果标记 isError', () => {
    const units = extractUnits([
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '' }]),
      msg('tool', [{ type: 'text', text: 'boom' }], { source: { callId: 'c1' }, isError: true }),
    ], AT, 's')
    expect(units[0]?.content).toContain('isError="true"')
  })
})

describe('辅助函数', () => {
  it('composeToolContent 生成两种标签', () => {
    const s = composeToolContent('bash', 'args', 'out', false)
    expect(s).toContain('<tool-call name="bash">')
    expect(s).toContain('<tool-result isError="false">')
  })

  it('textOf 拼接多个 text 块', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })

  it('blocksOf 过滤非对象', () => {
    expect(blocksOf([null, 'x', { type: 'text' }])).toHaveLength(1)
  })

  it('shouldIndex 排除 system/developer/tool', () => {
    expect(shouldIndex(msg('system', []))).toBe(false)
    expect(shouldIndex(msg('developer', []))).toBe(false)
    expect(shouldIndex(msg('tool', []))).toBe(false)
    expect(shouldIndex(msg('user', []))).toBe(true)
    expect(shouldIndex(msg('assistant', []))).toBe(true)
  })
})

describe('一次性产物不入库', () => {
  it('提炼指令（memory-summary-prompt）不产生单位', () => {
    const units = extractUnits([
      { role: 'user', content: [{ type: 'text', text: 'Condense unit #1 ...' }], source: { kind: 'memory-summary-prompt' } },
      { role: 'user', content: [{ type: 'text', text: '真正的用户消息' }] },
    ], AT, 's')
    expect(units).toHaveLength(1)
    expect(units[0]?.content).toBe('真正的用户消息')
  })

  it('已用过的提炼回复不产生 reply 单位', () => {
    const consumed = (t: string) => t === 'rejected: A; chosen: B'
    const units = extractUnits([
      { role: 'assistant', content: [{ type: 'text', text: 'rejected: A; chosen: B' }] },
      { role: 'assistant', content: [{ type: 'text', text: '正常工作回复' }] },
    ], AT, 's', consumed)
    expect(units).toHaveLength(1)
    expect(units[0]?.content).toBe('正常工作回复')
  })

  it('未登记为已用时正常入库', () => {
    const units = extractUnits([
      { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
    ], AT, 's', () => false)
    expect(units).toHaveLength(1)
  })
})
