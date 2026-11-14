// log-reader + extractor 测试：解压正确性、坏帧容错、四条决策的提取语义

import { describe, expect, it } from 'vitest'
import { readSessionLog, scanZstdFrames } from '../src/ingest/log-reader.js'
import { extractFromEvents, TEXT_SLICE } from '../src/ingest/extractor.js'
import {
  assistantMessage,
  compactionSummary,
  makeSessionTree,
  makeTempRoot,
  makeZstdFrameContainer,
  toolCall,
  toolResult,
  turnStart,
  userMessage,
  type FakeEvent,
} from './helpers.js'

const SID = '11111111-2222-3333-4444-555555555555'

describe('scanZstdFrames', () => {
  it('定位拼接帧边界', () => {
    const buf = makeZstdFrameContainer(['abc', 'defgh', 'x'])
    const scan = scanZstdFrames(buf)
    expect(scan.frames).toHaveLength(3)
    expect(scan.tornStart).toBeUndefined()
    // 帧区间首尾相接、覆盖全文件
    expect(scan.frames[0]?.start).toBe(0)
    expect(scan.frames[2]?.end).toBe(buf.length)
    expect(scan.frames[1]?.start).toBe(scan.frames[0]?.end)
  })

  it('残帧（截断）返回 tornStart', () => {
    const buf = makeZstdFrameContainer(['complete-frame'])
    const torn = buf.subarray(0, buf.length - 8)
    const scan = scanZstdFrames(torn)
    expect(scan.frames).toHaveLength(0)
    expect(scan.tornStart).toBe(0)
  })

  it('非 zstd 数据抛错', () => {
    expect(() => scanZstdFrames(Buffer.from('not zstd at all, plain bytes'))).toThrow(/magic/)
  })
})

describe('readSessionLog', () => {
  it('逐帧解压并按行解析事件', () => {
    const root = makeTempRoot()
    const events: FakeEvent[] = [userMessage(1, '你好'), assistantMessage(2, '回复', '思考内容')]
    makeSessionTree(root, SID, events)
    const log = readSessionLog(root + `/--C--test--cwd--/session-${SID}/session.v4.jsonl.zstd`, SID)
    expect(log.frameCount).toBe(1)
    expect(log.badFrames).toBe(0)
    expect(log.parseErrors).toBe(0)
    expect(log.events).toHaveLength(2)
    expect(log.events[0]?.type).toBe('user/message')
  })

  it('残尾帧（实时写入中断）跳过不抛出，完整帧内容可读', async () => {
    const good = makeZstdFrameContainer([JSON.stringify(userMessage(1, 'ok'))])
    // 残帧：最后一帧被写到一半（实时追加场景）
    const partialFrame = makeZstdFrameContainer([JSON.stringify(userMessage(2, 'tail'))]).subarray(0, 20)
    const root = makeTempRoot()
    const dir = makeSessionTree(root, SID, [])
    const { writeFileSync } = await import('node:fs')
    writeFileSync(dir + '/session.v4.jsonl.zstd', Buffer.concat([good, partialFrame]))

    const log = readSessionLog(dir + '/session.v4.jsonl.zstd', SID)
    // 完整帧正常解出；残帧被结构性扫描排除，绝不抛出
    const types = log.events.map((e) => e.type)
    expect(types).toContain('user/message')
    expect(log.frameCount).toBe(1)
  })
})

describe('extractFromEvents', () => {
  it('user/message 提取为 kind=user 记录', () => {
    const result = extractFromEvents(SID, [userMessage(9, '把日志时间戳修一下，记成待办', 1700000100000)])
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      seq: 9,
      sessionId: SID,
      kind: 'user',
      at: new Date(1700000100000).toISOString(),
      text: '把日志时间戳修一下，记成待办',
    })
  })

  it('决策①：reasoning 只进 reasoning，绝不进 records', () => {
    const result = extractFromEvents(SID, [
      assistantMessage(20, '可见回复', '这段思考包含独特 token：量子驼峰旋转门', 2),
    ])
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.kind).toBe('assistant')
    expect(result.records[0]?.text).not.toContain('量子驼峰旋转门')
    expect(result.reasoning).toHaveLength(1)
    expect(result.reasoning[0]?.text).toContain('量子驼峰旋转门')
    expect(result.reasoning[0]?.turn).toBe(2)
  })

  it('tool/call：工具名 + 参数摘要（500 字符截断）', () => {
    const longArgs = JSON.stringify({ command: 'x'.repeat(2000) })
    const result = extractFromEvents(SID, [toolCall(30, 'pwsh', longArgs)])
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.kind).toBe('tool-call')
    expect(result.records[0]?.text.startsWith('pwsh ')).toBe(true)
    expect(result.records[0]?.text.length).toBeLessThanOrEqual(500 + 'pwsh '.length)
  })

  it('tool/result：prune 标记识别', () => {
    const pruned = toolResult(40, '头部内容\n\n[... tool result middle pruned ...]\n\n尾部内容')
    const normal = toolResult(41, '正常完整结果')
    const result = extractFromEvents(SID, [pruned, normal])
    expect(result.records[0]?.text).toContain('compaction/prune 裁剪')
    expect(result.records[1]?.text).not.toContain('compaction/prune 裁剪')
  })

  it('决策③：shadowedSeqs 被收集（summary 与 prune 都算）', () => {
    const result = extractFromEvents(SID, [
      compactionSummary(100, [12, 13, 14], '摘要正文'),
    ])
    expect(result.shadowedSeqs.has(12)).toBe(true)
    expect(result.shadowedSeqs.has(14)).toBe(true)
    // 摘要本身照常索引（kind=summary）
    expect(result.records.some((r) => r.kind === 'summary' && r.text === '摘要正文')).toBe(true)
  })

  it('turn/start 归属：user/message 借 turnStarts 拿到轮次', () => {
    const events: FakeEvent[] = [
      turnStart(1, 1),
      userMessage(2, '第一轮的话'),
      turnStart(50, 2),
      userMessage(51, '第二轮的话'),
    ]
    const result = extractFromEvents(SID, events)
    expect(result.records[0]?.turn).toBe(1)
    expect(result.records[1]?.turn).toBe(2)
  })

  it('assistant/message 自带 turn 字段优先', () => {
    const result = extractFromEvents(SID, [assistantMessage(60, '回复', undefined, 7)])
    expect(result.records[0]?.turn).toBe(7)
  })

  it('长文本截断到 TEXT_SLICE', () => {
    const result = extractFromEvents(SID, [userMessage(70, '长'.repeat(TEXT_SLICE + 500))])
    expect(result.records[0]?.text.length).toBe(TEXT_SLICE)
  })

  it('坏行计数：解析失败的事件计入 parseErrors', () => {
    const result = extractFromEvents(SID, [
      { type: 'user/message', seq: 1 } as FakeEvent,
      null as unknown as FakeEvent,
      { seq: 3 } as FakeEvent,
    ])
    expect(result.eventCount).toBe(3)
    expect(result.parseErrors).toBe(2)
    expect(result.lastSeq).toBe(3)
  })

  it('图片内容：无文本时给占位（tool-result）', () => {
    const result = extractFromEvents(SID, [
      { type: 'tool/result', seq: 80, data: { message: { role: 'tool', content: [{ type: 'image' }] } } } as FakeEvent,
    ])
    expect(result.records[0]?.text).toBe('（未索引内容）')
  })
})
