// 测试公共工具：造假的 zstd 帧容器与会话事件
//
// 单测不读真实 ~/.dsh（真实数据只用于 CLI 验收），这里用 Node zlib 造
// 拼接 zstd 帧（DSH 追加写一帧/次的格式，带 checksum），小而可控。

import { constants, zstdCompressSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一个最小的会话事件（与真实日志同形状） */
export type FakeEvent = Record<string, unknown> & { type: string; seq: number; time?: number; data?: Record<string, unknown> }

/** 拼接 zstd 帧：每个 batch 一个帧，首尾相接（带 checksum，与 DSH 落盘格式一致） */
export function makeZstdFrameContainer(batches: string[]): Buffer {
  return Buffer.concat(
    batches.map((b) =>
      zstdCompressSync(Buffer.from(b, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
    ),
  )
}

/** 事件数组 → JSONL 文本 */
export function eventsToText(events: FakeEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n')
}

/** 造一个临时会话目录：<root>/<cwd-dir>/session-<id>/session.v4.jsonl.zstd */
export function makeSessionTree(root: string, sessionId: string, events: FakeEvent[]): string {
  const dir = join(root, '--C--test--cwd--', `session-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), makeZstdFrameContainer([eventsToText(events)]))
  return dir
}

/** 建临时根目录 */
export function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'memory-plugin-test-'))
}

// ---- 常用事件工厂 ----

export function userMessage(seq: number, text: string, time = 1700000000000): FakeEvent {
  return {
    type: 'user/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
    surfaceOp: 'append',
  }
}

export function assistantMessage(
  seq: number,
  visibleText: string,
  reasoningText?: string,
  turn = 1,
  time = 1700000000000,
): FakeEvent {
  const content: Array<Record<string, unknown>> = []
  if (reasoningText) content.push({ type: 'reasoning', text: reasoningText })
  content.push({ type: 'text', text: visibleText })
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step: 1, message: { role: 'assistant', content } },
  }
}

export function toolCall(seq: number, name: string, args: string, turn = 1, time = 1700000000000): FakeEvent {
  return { type: 'tool/call', seq, time, data: { turn, step: 1, callId: `call-${seq}`, name, arguments: args } }
}

export function toolResult(seq: number, text: string, turn = 1, time = 1700000000000): FakeEvent {
  return {
    type: 'tool/result',
    seq,
    time,
    data: { turn, step: 1, message: { role: 'tool', content: [{ type: 'text', text }] } },
  }
}

export function compactionSummary(seq: number, shadowedSeqs: number[], summaryText: string, time = 1700000000000): FakeEvent {
  return {
    type: 'compaction/summary',
    seq,
    time,
    data: {
      compactionId: 'c-1',
      summary: [{ type: 'text', text: summaryText }],
      shadowedSeqs,
      shadowedRange: { start: 10, end: 20 },
      shadowedTokenCount: 1000,
    },
  }
}

export function turnStart(seq: number, turn: number, time = 1700000000000): FakeEvent {
  return { type: 'turn/start', seq, time, data: { turn } }
}
