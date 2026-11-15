// 单位提取测试：验证每个独立单元各占一号、工具调用与结果合并。

import { describe, expect, it } from 'vitest'
import { extractUnits, composeToolContent, textOf, blocksOf, shouldIndex, isOneShotInjected } from '../src/ingest/units.js'
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

describe('框架注入消息不占编号', () => {
  it('system-reminder 包裹的 runtime-context 不入库', () => {
    const units = extractUnits([
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>\n上下文\n</system-reminder>' }], source: { kind: 'runtime-context' } },
      { role: 'user', content: [{ type: 'text', text: '人话' }] },
    ], AT, 's')
    expect(units).toHaveLength(1)
    expect(units[0]?.content).toBe('人话')
  })

  it('agent-instructions 不入库', () => {
    const units = extractUnits([
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>指令</system-reminder>' }], source: { kind: 'agent-instructions' } },
    ], AT, 's')
    expect(units).toHaveLength(0)
  })

  it('按前缀排除 Time sampled / Generate the session title', () => {
    const units = extractUnits([
      { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-15T21:46:11+08:00' }] },
      { role: 'user', content: [{ type: 'text', text: 'Generate the session title from this JSON array of human messages' }] },
      { role: 'user', content: [{ type: 'text', text: '真的问题' }] },
    ], AT, 's')
    expect(units).toHaveLength(1)
    expect(units[0]?.content).toBe('真的问题')
  })

  it('只裸 <system-reminder> 开头（无 source 标记）也能排掉', () => {
    const units = extractUnits([
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>\n随便什么\n</system-reminder>' }] },
    ], AT, 's')
    expect(units).toHaveLength(0)
  })

  it('memory-projection 投影文本不入库', () => {
    const units = extractUnits([
      { role: 'user', content: [{ type: 'text', text: '#3 <summary>摘要</summary>' }], source: { kind: 'memory-projection' } },
    ], AT, 's')
    expect(units).toHaveLength(0)
  })

  it('isOneShotInjected 判定', () => {
    expect(isOneShotInjected({ role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] })).toBe(true)
    expect(isOneShotInjected({ role: 'user', content: [{ type: 'text', text: '正常提问' }] })).toBe(false)
  })
})

describe('提炼轮不产生新单位（链式污染）', () => {
  it('同一条 assistant 消息的思考随正文一起跳过', () => {
    const consumed = (t: string) => t.includes('rejected option')
    const units = extractUnits([
      { role: 'user', content: [{ type: 'text', text: '详细一点' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'The task: condense unit #11 into its essential information...' },
          { type: 'text', text: 'rejected option: A — because X\nchosen option: B' },
        ],
      },
    ], AT, 's', consumed)
    expect(units).toHaveLength(1)
    expect(units[0]?.kind).toBe('user')
    expect(units.filter(u => u.kind === 'thinking')).toHaveLength(0)
  })

  it('提炼轮的思考里有工具调用也一并跳过', () => {
    const consumed = (t: string) => t.includes('chosen option')
    const units = extractUnits([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先读文件' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
          { type: 'text', text: 'chosen option: B' },
        ],
      },
    ], AT, 's', consumed)
    expect(units).toHaveLength(0)
  })

  it('summaryInFlight 时整轮 assistant 跳过（指纹未登记也安全）', () => {
    const units = extractUnits([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '提炼中的思考' }, { type: 'text', text: '提炼结果' }] },
    ], AT, 's', undefined, true)
    expect(units).toHaveLength(1)
    expect(units[0]?.kind).toBe('user')
  })

  it('正常 assistant 消息仍会入库', () => {
    const units = extractUnits([
      { role: 'assistant', content: [{ type: 'reasoning', text: '正常思考' }, { type: 'text', text: '正常回复' }] },
    ], AT, 's', () => false)
    expect(units).toHaveLength(2)
  })
})
