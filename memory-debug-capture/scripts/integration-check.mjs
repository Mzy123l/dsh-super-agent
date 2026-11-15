/**
 * 端到端集成验证（开发期脚本，不进 dist）。
 *
 * 它用**真实的** `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-llm` 跑一遍
 * `llm/stream` waterfall，验证：
 * 1. 本插件的 `apply()` 能挂上 waterfall，并且**没有**破坏模型调用（`next()` 被正确调用）；
 * 2. 捕获到的 messages 与真实请求一致；
 * 3. 落盘的 JSONL 行内容符合契约；
 * 4. 进程退出（dispose）前队列被排空。
 *
 * 第 5 段额外验证**双栏采集**：`agent/pre-step` 的 waterfall 语义
 * （cordis 的 waterfall 按注册顺序从外到内）与 before/after 的配对。
 *
 * 用法：node scripts/integration-check.mjs
 */

import { rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const dshRoot = process.env.DSH_INSTALL ?? 'E:/Applications/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai'

// require.resolve 返回的是 Windows 路径；ESM 动态 import 需要 file:// URL。
const resolveUrl = (specifier) => pathToFileURL(require.resolve(specifier, { paths: [dshRoot] })).href

const { Context } = await import(resolveUrl('@deepseek-ai/cordis'))
const { LlmRuntime, LlmAdapter } = await import(resolveUrl('@deepseek-ai/dsh-llm'))
const { apply } = await import('../dist/index.js')

const outDir = join(tmpdir(), `mdc-integration-${process.pid}`)
const fileName = 'integration.jsonl'
let failures = 0

function check(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}\n       actual:   ${JSON.stringify(actual)}\n       expected: ${JSON.stringify(expected)}`)
  }
}

/** 读回落盘文件的所有行（JSON 解析后）。 */
async function readRecords(dir, file) {
  const raw = await readFile(join(dir, file), 'utf8')
  return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

// ── 组装真实运行时 ────────────────────────────────────────────────────────
const ctx = new Context()
await ctx.plugin(LlmRuntime)

// 假适配器：记录它收到的完整请求，并回一个最小流。
const seen = []
class FakeAdapter extends LlmAdapter {
  async *stream(options) {
    seen.push(options)
    yield { type: 'text-delta', index: 0, delta: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['fake-provider'], new FakeAdapter())

// 挂上本插件（真实 apply）。
apply(ctx, { outDir, fileName, variant: 'on', runId: 'run-integration' })

// ── 发一次真实请求 ────────────────────────────────────────────────────────
const messages = [
  { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
  { role: 'user', content: [{ type: 'text', text: 'USER PROMPT' }] },
]

console.log('=== 集成验证（真实 cordis + 真实 dsh-llm）===\n')

console.log('[1] waterfall 透传')
const stream = ctx.llm.stream({
  provider: 'fake-provider',
  model: 'fake-model',
  messages,
  sessionId: 'session-integration',
})
const chunks = []
for await (const chunk of stream) chunks.push(chunk)
check('模型调用未被短路（收到 chunk）', chunks.length, 2)
check('适配器收到了完整 messages', seen[0]?.messages?.length, 2)

console.log('\n[2] 落盘内容')
await ctx.fiber.dispose()
const records = await readRecords(outDir, fileName)
check('写出一行', records.length, 1)
const record = records[0]
check('provider', record.provider, 'fake-provider')
check('model', record.model, 'fake-model')
check('sessionId', record.sessionId, 'session-integration')
check('variant', record.variant, 'on')
check('runId', record.runId, 'run-integration')
check('phase 缺省为 after', record.phase, 'after')
check('requestKey 存在', typeof record.requestKey, 'string')
check('messages 条数', record.messages.length, 2)
check('messages 顺序', record.messages.map(m => m.role), ['system', 'user'])
check('system 文本', record.messages[0].text, 'SYSTEM PROMPT')
check('user 文本', record.messages[1].text, 'USER PROMPT')
check('totals.messages', record.totals.messages, 2)
check('totals.chars', record.totals.chars, 'SYSTEM PROMPT'.length + 'USER PROMPT'.length)
check('totals.systemChars', record.totals.systemChars, 'SYSTEM PROMPT'.length)
check('totals.reasoningChars', record.totals.reasoningChars, 0)

console.log('\n[3] dispose 前排空')
// 上面 flush 发生在 dispose 之后仍然读到了内容，说明 dispose 的 effect 排空了队列。
check('dispose 后文件已落盘', records.length, 1)

console.log('\n[4] 大量请求的 dispose 排空')
// 连发 200 次请求后立刻 dispose：dispose 的 effect 必须把队列全部写完。
const bulkOutDir = join(tmpdir(), `mdc-bulk-${process.pid}`)
const bulkFile = 'bulk.jsonl'
const bulkCtx = new Context()
await bulkCtx.plugin(LlmRuntime)
bulkCtx.llm.registerAdapter(['fake-provider'], new FakeAdapter())
apply(bulkCtx, { outDir: bulkOutDir, fileName: bulkFile, variant: 'off', runId: 'run-bulk' })
for (let i = 0; i < 200; i += 1) {
  const s = bulkCtx.llm.stream({
    provider: 'fake-provider',
    model: 'fake-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: `msg-${i}` }] }],
    sessionId: 'session-bulk',
  })
  // eslint-disable-next-line no-empty
  for await (const _chunk of s) { /* drain */ }
}
await bulkCtx.fiber.dispose()
const bulkRecords = await readRecords(bulkOutDir, bulkFile)
check('200 次请求全部落盘', bulkRecords.length, 200)
check('第一行是第 0 条', bulkRecords[0].messages[0].text, 'msg-0')
check('最后一行是第 199 条', bulkRecords[199].messages[0].text, 'msg-199')
check('顺序严格递增（无乱序）', bulkRecords.every((r, index) => r.messages[0].text === `msg-${index}`), true)
await rm(bulkOutDir, { recursive: true, force: true })

// ── 第 5 段：双栏采集（before / after） ─────────────────────────────────────
//
// 用**真实的 cordis waterfall** 模拟 dsh 的 pre-step → llm/stream 时序：
//   1. 挂一个「记忆注入」pre-step 监听器；
//   2. 挂本插件的 pre-step 监听器（prepend → 排在最外层）；
//   3. 触发 pre-step waterfall；
//   4. 触发 llm/stream waterfall。
//
// 校验：before 栏不含注入内容，after 栏含注入内容，两栏共用同一个 requestKey。
console.log('\n[5] 双栏采集：before / after')
const dualOutDir = join(tmpdir(), `mdc-dual-${process.pid}`)
const dualFile = 'dual.jsonl'
const dualCtx = new Context()
await dualCtx.plugin(LlmRuntime)
dualCtx.llm.registerAdapter(['fake-provider'], new FakeAdapter())

const HISTORY = [
  { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
  { role: 'user', content: [{ type: 'text', text: '原始问题' }] },
]
const INJECTED = { role: 'user', content: [{ type: 'text', text: '[记忆] 上次提到 pnpm' }] }

// 模拟 dsh 的会话：deriveMessages() 返回当前派生历史（pre-step 时刻不含本步新增）。
let derived = HISTORY.slice()
const fakeSession = {
  id: 'session-dual',
  deriveMessages: () => derived.slice(),
}

// 「记忆注入」监听器：普通注册 → 排在内层。
dualCtx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  // 模拟记忆机制：往本步批次里追加一条注入消息。
  return { ...decision, messages: [...decision.messages, INJECTED] }
}, { global: true })

// 本插件：prepend → 排在最外层 → 拿到的是注入之后的结果。
apply(dualCtx, { outDir: dualOutDir, fileName: dualFile, variant: 'on', runId: 'run-dual' })

// 触发一次 pre-step waterfall。
const decision = await dualCtx.waterfall('agent/pre-step', {
  agent: { session: fakeSession },
  messages: [],
  turn: 1,
  step: 1,
}, async () => ({ kind: 'enter', messages: HISTORY.slice() }))
check('pre-step 决策被注入器改写（多一条）', decision.messages.length, 3)

// 触发一次 llm/stream waterfall（发出去的上下文 = 派生历史 + 本步批次）。
const finalMessages = [...derived, ...decision.messages]
const s = dualCtx.llm.stream({
  provider: 'fake-provider',
  model: 'fake-model',
  messages: finalMessages,
  sessionId: 'session-dual',
})
// eslint-disable-next-line no-empty
for await (const _chunk of s) { /* drain */ }
await dualCtx.fiber.dispose()

const dualRecords = await readRecords(dualOutDir, dualFile)
check('写出两行（before + after）', dualRecords.length, 2)
const beforeRow = dualRecords.find(r => r.phase === 'before')
const afterRow = dualRecords.find(r => r.phase === 'after')
check('存在 before 行', beforeRow !== undefined, true)
check('存在 after 行', afterRow !== undefined, true)
check('两行共用 requestKey', beforeRow?.requestKey === afterRow?.requestKey, true)
check('requestKey 形如 session#turn#step', beforeRow?.requestKey, 'session-dual#1#1')
check('before 不含注入内容', beforeRow?.messages.some(m => m.text.includes('[记忆]')), false)
check('after 含注入内容', afterRow?.messages.some(m => m.text.includes('[记忆]')), true)
check('before 条数少于 after', (beforeRow?.messages.length ?? 0) < (afterRow?.messages.length ?? 0), true)
check('before 的字符数少于 after', (beforeRow?.totals.chars ?? 0) < (afterRow?.totals.chars ?? 0), true)
await rm(dualOutDir, { recursive: true, force: true })

// ── 第 6 段：prepend 顺序 ─────────────────────────────────────────────────
//
// 关键：只有**最外层**的 pre-step 监听器才能拿到「所有其它监听器改完之后」的
// 决定。本插件用 prepend 把自己放到最外层，所以它看到的批次里**含**注入。
console.log('\n[6] prepend：拿到其它监听器改完之后的批次')
const orderOutDir = join(tmpdir(), `mdc-order-${process.pid}`)
const orderFile = 'order.jsonl'
const orderCtx = new Context()
await orderCtx.plugin(LlmRuntime)
orderCtx.llm.registerAdapter(['fake-provider'], new FakeAdapter())

// 内层监听器：注入一条消息。
orderCtx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  return { ...decision, messages: [...decision.messages, INJECTED] }
}, { global: true })

// 本插件（prepend → 最外层）。
apply(orderCtx, { outDir: orderOutDir, fileName: orderFile, variant: 'on', runId: 'run-order' })

const orderSession = { id: 'session-order', deriveMessages: () => HISTORY.slice() }
const orderDecision = await orderCtx.waterfall('agent/pre-step', {
  agent: { session: orderSession },
  messages: [],
  turn: 1,
  step: 1,
}, async () => ({ kind: 'enter', messages: HISTORY.slice() }))
check('内层监听器确实改写了批次', orderDecision.messages.length, 3)

const orderStream = orderCtx.llm.stream({
  provider: 'fake-provider',
  model: 'fake-model',
  messages: [...HISTORY, ...orderDecision.messages],
  sessionId: 'session-order',
})
// eslint-disable-next-line no-empty
for await (const _chunk of orderStream) { /* drain */ }
await orderCtx.fiber.dispose()

const orderRecords = await readRecords(orderOutDir, orderFile)
const orderBefore = orderRecords.find(r => r.phase === 'before')
const orderAfter = orderRecords.find(r => r.phase === 'after')
check('before 行存在（说明插件作为最外层监听器跑到了）', orderBefore !== undefined, true)
check('after 行存在', orderAfter !== undefined, true)
// before = after − 本步新增：本步新增含注入，所以 before 里没有注入。
check('before 不含注入内容', orderBefore?.messages.some(m => m.text.includes('[记忆]')), false)
check('after 含注入内容', orderAfter?.messages.some(m => m.text.includes('[记忆]')), true)
// before 仍保留历史（含系统提示词，它是固定前缀不是注入）。
check('before 保留历史消息', orderBefore?.messages.some(m => m.text.includes('原始问题')), true)
await rm(orderOutDir, { recursive: true, force: true })

await rm(outDir, { recursive: true, force: true })

console.log(`\n=== 集成验证结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===`)
process.exitCode = failures === 0 ? 0 : 1
