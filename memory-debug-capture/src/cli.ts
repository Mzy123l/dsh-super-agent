/**
 * 命令行入口。
 *
 * - `--selftest`：构造假 messages，验证序列化与落盘链路，**不需要 dsh 运行时**。
 * - 默认模式：跑一次捕获（构造一个假请求并落盘），打印统计。
 */

import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeStepAdditions, subtractAdditions } from './before.js'
import { buildRequestKey, captureRequest } from './capture.js'
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
  check('phase 缺省为 after', parsed.phase, 'after')
  check('requestKey 退化为 sessionId', parsed.requestKey, 'session-selftest')
  check('messages 条数', parsed.messages.length, 4)
  check('totals.chars', parsed.totals.chars, expectedChars)
  check('totals.reasoningChars', parsed.totals.reasoningChars, expectedReasoning)
  check('totals.systemChars', parsed.totals.systemChars, expectedSystem)
  check('顶层键集合', Object.keys(parsed).sort(), [
    'messages', 'model', 'phase', 'provider', 'requestKey', 'runId', 'sessionId',
    'step', 'totals', 'ts', 'turn', 'variant',
  ])
  await rm(dir, { recursive: true, force: true })

  console.log('\n[5] 双栏：before / after 配对')
  // 构造一次请求：记忆机制往上下文里塞了一条 user 消息。
  const history: SourceMessage[] = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
    { role: 'user', content: [{ type: 'text', text: '用户原始问题' }] },
  ]
  const injected: SourceMessage[] = [
    { role: 'user', content: [{ type: 'text', text: '[记忆] 上次你说过项目用 pnpm。' }] },
  ]
  const after: SourceMessage[] = [...history, ...injected]

  const requestKey = buildRequestKey('session-dual', 2, 3)
  check('requestKey 格式', requestKey, 'session-dual#2#3')

  const dualDir = join(tmpdir(), `memory-debug-capture-dual-${process.pid}`)
  const dualWriter = new JsonlWriter({ outDir: dualDir, fileName: 'dual.jsonl' })
  // before：记忆机制介入之前 = 只有历史。
  dualWriter.enqueue(captureRequest(
    { sessionId: 'session-dual', provider: 'workbuddy', model: 'm', messages: history },
    {
      variant: 'on', runId: 'run-dual', phase: 'before', requestKey,
      turn: 2, step: 3, timestamp: '2026-11-15T06:00:00.000Z',
    },
  ))
  // after：介入之后 = 历史 + 注入。
  dualWriter.enqueue(captureRequest(
    { sessionId: 'session-dual', provider: 'workbuddy', model: 'm', messages: after },
    {
      variant: 'on', runId: 'run-dual', phase: 'after', requestKey,
      turn: 2, step: 3, timestamp: '2026-11-15T06:00:01.000Z',
    },
  ))
  await dualWriter.close()

  const dualRaw = await readFile(join(dualDir, 'dual.jsonl'), 'utf8')
  const dualLines = dualRaw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as CaptureRecord)
  check('写出两行', dualLines.length, 2)
  check('第一行是 before', dualLines[0]?.phase, 'before')
  check('第二行是 after', dualLines[1]?.phase, 'after')
  check('两行共用同一个 requestKey', dualLines[0]?.requestKey === dualLines[1]?.requestKey, true)
  check('before 条数', dualLines[0]?.messages.length, 2)
  check('after 条数', dualLines[1]?.messages.length, 3)
  check('before 不含注入内容', dualLines[0]?.messages.some(m => m.text.includes('[记忆]')), false)
  check('after 含注入内容', dualLines[1]?.messages.some(m => m.text.includes('[记忆]')), true)
  check('before 的字符数更少', (dualLines[0]?.totals.chars ?? 0) < (dualLines[1]?.totals.chars ?? 0), true)
  check('两行 turn 一致', dualLines[0]?.turn === dualLines[1]?.turn, true)
  check('两行 step 一致', dualLines[0]?.step === dualLines[1]?.step, true)

  // 生成器按 requestKey 配对：两行能被配成一对。
  const grouped = new Map<string, CaptureRecord[]>()
  for (const line of dualLines) {
    const list = grouped.get(line.requestKey) ?? []
    list.push(line)
    grouped.set(line.requestKey, list)
  }
  const pairs = [...grouped.values()].filter(list => list.some(l => l.phase === 'before') && list.some(l => l.phase === 'after'))
  check('按 requestKey 能配出一对', pairs.length, 1)
  await rm(dualDir, { recursive: true, force: true })

  console.log('\n[6] before 重建：after − 插件注入')
  // 复现真实 dsh 的时序（实测自真实 dsh headless 运行）：
  //   pre-step 时刻的历史 = 上一步结束的上下文
  //   after = 历史 + 系统提示词 + 本轮用户输入 + 插件注入的记忆
  // 期望：before = after − 插件注入
  //       （用户输入与系统提示词都是 dsh 自有的，每步都有，不算注入）
  const baselineHistory: SourceMessage[] = [
    { role: 'user', id: 'm-old', source: { kind: 'user' }, content: [{ type: 'text', text: '上一轮的问题' }] },
  ]
  const systemPrompt: SourceMessage = {
    role: 'system',
    id: 'm-sys',
    source: { kind: 'system-prompt' },
    content: [{ type: 'text', text: 'SYSTEM PROMPT' }],
  }
  const userThisStep: SourceMessage = {
    role: 'user',
    id: 'm-new',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '本轮的问题' }],
  }
  const runtimeContext: SourceMessage = {
    role: 'user',
    id: 'm-rc',
    source: { kind: 'runtime-context' },
    content: [{ type: 'text', text: 'Current runtime context...' }],
  }
  const memoryInjection: SourceMessage = {
    role: 'user',
    id: 'm-mem',
    source: { kind: 'memory-plugin' },
    content: [{ type: 'text', text: '[记忆] 注入内容' }],
  }
  const afterMessages: SourceMessage[] = [
    systemPrompt,
    ...baselineHistory,
    userThisStep,
    runtimeContext,
    memoryInjection,
  ]
  // pre-step 决策里的本步批次
  const stepBatch: SourceMessage[] = [userThisStep, runtimeContext, memoryInjection]

  const additions = computeStepAdditions(afterMessages, baselineHistory, stepBatch)
  check('本步新增 = 1 条（只有插件注入的记忆）', additions.length, 1)
  check('记忆注入被算作本步新增', additions.some(m => m.id === 'm-mem'), true)
  check('dsh 自有的系统提示词不算注入', additions.some(m => m.id === 'm-sys'), false)
  check('用户输入不算注入', additions.some(m => m.id === 'm-new'), false)
  check('运行时上下文不算注入', additions.some(m => m.id === 'm-rc'), false)
  check('历史消息不被算作本步新增', additions.some(m => m.id === 'm-old'), false)

  const rebuilt = subtractAdditions(afterMessages, additions)
  check('重建出的 before = 历史 + 系统提示词 + 用户输入 + 运行时上下文', rebuilt.length, 4)
  check('before 保留历史消息', rebuilt.some(m => m.id === 'm-old'), true)
  check('before 保留系统提示词（它是固定前缀，不是注入）', rebuilt.some(m => m.id === 'm-sys'), true)
  check('before 保留用户输入', rebuilt.some(m => m.id === 'm-new'), true)
  check('before 不含记忆注入', rebuilt.some(m => m.id === 'm-mem'), false)

  console.log('\n[7] 减法不误删同内容的历史消息')
  // 场景：历史里已有一条与本步新增**内容相同**的消息（但 id 不同）。
  const dupHistory: SourceMessage[] = [
    { role: 'user', id: 'm-dup-1', content: [{ type: 'text', text: '重复内容' }] },
  ]
  const dupStep: SourceMessage[] = [
    { role: 'user', id: 'm-dup-2', content: [{ type: 'text', text: '重复内容' }] },
  ]
  const dupAfter: SourceMessage[] = [...dupHistory, ...dupStep]
  const dupAdditions = computeStepAdditions(dupAfter, dupHistory, dupStep)
  check('按 id 区分，只算后出现的那条为新增', dupAdditions.length, 1)
  check('新增的是后出现的那条', dupAdditions[0]?.id, 'm-dup-2')
  const dupRebuilt = subtractAdditions(dupAfter, dupAdditions)
  check('重建后保留历史那条', dupRebuilt.length, 1)
  check('保留的是历史那条（id=m-dup-1）', dupRebuilt[0]?.id, 'm-dup-1')

  console.log('\n[8] 无 id 时退化为内容匹配')
  const noIdHistory: SourceMessage[] = [
    { role: 'user', content: [{ type: 'text', text: '旧' }] },
  ]
  const noIdStep: SourceMessage[] = [
    { role: 'user', content: [{ type: 'text', text: '新' }] },
  ]
  const noIdAfter: SourceMessage[] = [...noIdHistory, ...noIdStep]
  const noIdAdditions = computeStepAdditions(noIdAfter, noIdHistory, noIdStep)
  check('无 id 时也能识别出本步新增', noIdAdditions.length, 1)
  const noIdRebuilt = subtractAdditions(noIdAfter, noIdAdditions)
  check('重建后只剩历史', noIdRebuilt.length, 1)
  check('保留的是旧消息', noIdRebuilt[0]?.content?.[0]?.text, '旧')

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
  console.log(`phase：${record.phase}`)
  console.log(`requestKey：${record.requestKey}`)
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
