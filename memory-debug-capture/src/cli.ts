/**
 * 命令行入口。
 *
 * - `--selftest`：构造假 messages，验证序列化与落盘链路，**不需要 dsh 运行时**。
 * - 默认模式：跑一次捕获（构造一个假请求并落盘），打印统计。
 */

import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureRequest } from './capture.js'
import type { SourceMessage } from './serialize.js'
import { computeTotals, serializeMessages } from './serialize.js'
import { JsonlWriter } from './writer.js'
import type { CaptureRecord } from './types.js'

/** 自检用的假消息：覆盖 system / user / assistant+reasoning / tool+toolName 四种形态。 */
function fakeMessages(): SourceMessage[] {
  return [
    {
      role: 'system',
      content: [{ type: 'text', text: 'You are a coding agent powered by the test model.' }],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: '请实现 memory-debug-capture 插件。' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先读调研文档，确认捕获点是 llm/stream waterfall。' },
        { type: 'text', text: '好的，我先看文档。' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"docs/9Q-debug-capture.md"}' },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: '# dsh 调试与上下文捕获能力\n...' }],
    },
  ]
}

/** 断言失败计数。 */
let failures = 0

/**
 * 断言两个值相等。
 *
 * @param label - 断言标签。
 * @param actual - 实际值。
 * @param expected - 期望值。
 */
function check(label: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}\n       actual:   ${JSON.stringify(actual)}\n       expected: ${JSON.stringify(expected)}`)
  }
}

/**
 * 跑自检：验证序列化规则与落盘链路。
 *
 * @returns 退出码（0 全部通过）。
 */
export async function selftest(): Promise<number> {
  console.log('=== memory-debug-capture 自检 ===\n')

  const messages = fakeMessages()
  const serialized = serializeMessages(messages)

  console.log('[1] 序列化：角色与字段')
  check('消息条数', serialized.length, 4)
  check('role 顺序', serialized.map(m => m.role), ['system', 'user', 'assistant', 'tool'])
  check('每条都有 text/chars', serialized.every(m => typeof m.text === 'string' && typeof m.chars === 'number'), true)
  check('system 文本', serialized[0]?.text, 'You are a coding agent powered by the test model.')
  check('user 文本', serialized[1]?.text, '请实现 memory-debug-capture 插件。')
  check('assistant 可见文本不含 reasoning', serialized[2]?.text, '好的，我先看文档。')
  check('assistant 有 reasoning 字段', typeof serialized[2]?.reasoning, 'string')
  check('assistant 有 reasoningChars 字段', typeof serialized[2]?.reasoningChars, 'number')
  check('tool 通过 toolCallId 反查到工具名', serialized[3]?.toolName, 'read')
  check('无 reasoning 的消息不带 reasoning 键', Object.hasOwn(serialized[1] as object, 'reasoning'), false)
  check('无 reasoning 的消息不带 reasoningChars 键', Object.hasOwn(serialized[1] as object, 'reasoningChars'), false)

  console.log('\n[2] 聚合统计')
  const totals = computeTotals(serialized)
  const expectedChars = serialized.reduce((sum, m) => sum + m.chars, 0)
  const expectedReasoning = serialized.reduce((sum, m) => sum + (m.reasoningChars ?? 0), 0)
  const expectedSystem = serialized.filter(m => m.role === 'system').reduce((sum, m) => sum + m.chars, 0)
  check('totals.messages', totals.messages, 4)
  check('totals.chars = 所有 text 之和', totals.chars, expectedChars)
  check('totals.reasoningChars = 所有 reasoning 之和', totals.reasoningChars, expectedReasoning)
  check('totals.systemChars = system 子集', totals.systemChars, expectedSystem)
  check('reasoningChars 不重复计入 chars', totals.chars, serialized.reduce((sum, m) => sum + m.chars, 0))

  console.log('\n[3] 截断')
  // 上限取 20：system(48) 与 user(27) 超限被截断，assistant 可见文本(9) 不超限。
  const truncated = serializeMessages(messages, { maxChars: 20 })
  check('超限消息被截断', truncated[0]?.text, 'You are a coding age')
  check('truncated 标记', truncated[0]?.truncated, true)
  check('originalChars 保留真实长度', truncated[0]?.originalChars, 'You are a coding agent powered by the test model.'.length)
  check('chars 是截断后长度', truncated[0]?.chars, 20)
  check('未超限的消息不带 truncated 键', Object.hasOwn(truncated[2] as object, 'truncated'), false)
  check('未超限的消息不带 originalChars 键', Object.hasOwn(truncated[2] as object, 'originalChars'), false)
  check('未超限的消息文本原样保留', truncated[2]?.text, '好的，我先看文档。')
  check('未设上限时不截断', serializeMessages(messages)[0]?.truncated, undefined)

  console.log('\n[4] 落盘一行')
  const dir = join(tmpdir(), `memory-debug-capture-selftest-${process.pid}`)
  const writer = new JsonlWriter({ outDir: dir, fileName: 'selftest.jsonl' })
  const record: CaptureRecord = captureRequest(
    {
      sessionId: 'session-selftest',
      provider: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      messages,
    },
    { variant: 'on', runId: 'run-selftest', maxChars: undefined, timestamp: '2026-11-15T06:00:00.000Z' },
  )
  writer.enqueue(record)
  await writer.close()

  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(join(dir, 'selftest.jsonl'), 'utf8')
  const lines = raw.split('\n').filter(line => line.trim() !== '')
  check('写出一行', lines.length, 1)
  const parsed = JSON.parse(lines[0] as string) as CaptureRecord
  check('ts 可控', parsed.ts, '2026-11-15T06:00:00.000Z')
  check('sessionId', parsed.sessionId, 'session-selftest')
  check('provider', parsed.provider, 'workbuddy')
  check('model', parsed.model, 'deepseek-v4.1-flash')
  check('variant', parsed.variant, 'on')
  check('runId', parsed.runId, 'run-selftest')
  check('step 未知时为 0', parsed.step, 0)
  check('turn 未知时为 0', parsed.turn, 0)
  check('messages 条数', parsed.messages.length, 4)
  check('totals.chars', parsed.totals.chars, expectedChars)
  check('totals.reasoningChars', parsed.totals.reasoningChars, expectedReasoning)
  check('totals.systemChars', parsed.totals.systemChars, expectedSystem)
  check('顶层键集合', Object.keys(parsed).sort(), [
    'messages', 'model', 'provider', 'runId', 'sessionId', 'step', 'totals', 'ts', 'turn', 'variant',
  ])
  await rm(dir, { recursive: true, force: true })

  console.log(`\n=== 自检结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===`)
  return failures === 0 ? 0 : 1
}

/**
 * 默认模式：跑一次捕获并打印统计。
 *
 * @returns 退出码。
 */
export async function runOnce(): Promise<number> {
  const outDir = process.env['MEMORY_DEBUG_OUT'] ?? './captures/'
  const variant = process.env['MEMORY_DEBUG_VARIANT'] ?? 'off'
  const runId = process.env['MEMORY_DEBUG_RUN_ID'] ?? 'run-unknown'
  const maxCharsRaw = process.env['MEMORY_DEBUG_MAX_CHARS']
  const maxChars = maxCharsRaw === undefined ? undefined : Number.parseInt(maxCharsRaw, 10)

  const writer = new JsonlWriter({
    outDir,
    fileName: `capture-${runId.replace(/[^A-Za-z0-9._-]+/g, '_')}.jsonl`,
  })
  const record = captureRequest(
    {
      sessionId: 'session-manual',
      provider: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      messages: fakeMessages(),
    },
    { variant, runId, maxChars: maxChars !== undefined && Number.isFinite(maxChars) ? maxChars : undefined },
  )
  writer.enqueue(record)
  await writer.close()

  console.log('=== memory-debug-capture 单次捕获 ===')
  console.log(`输出文件：${writer.filePath}`)
  console.log(`行数：${writer.count}`)
  console.log(`variant：${record.variant}`)
  console.log(`runId：${record.runId}`)
  console.log(`totals：${JSON.stringify(record.totals)}`)
  return 0
}

/** 进程入口。 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const code = args.includes('--selftest') ? await selftest() : await runOnce()
  process.exitCode = code
}

await main()
