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
const raw = await readFile(join(outDir, fileName), 'utf8')
const lines = raw.split('\n').filter(line => line.trim() !== '')
check('写出一行', lines.length, 1)
const record = JSON.parse(lines[0])
check('provider', record.provider, 'fake-provider')
check('model', record.model, 'fake-model')
check('sessionId', record.sessionId, 'session-integration')
check('variant', record.variant, 'on')
check('runId', record.runId, 'run-integration')
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
check('dispose 后文件已落盘', lines.length, 1)

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
const bulkRaw = await readFile(join(bulkOutDir, bulkFile), 'utf8')
const bulkLines = bulkRaw.split('\n').filter(line => line.trim() !== '')
check('200 次请求全部落盘', bulkLines.length, 200)
check('第一行是第 0 条', JSON.parse(bulkLines[0]).messages[0].text, 'msg-0')
check('最后一行是第 199 条', JSON.parse(bulkLines[199]).messages[0].text, 'msg-199')
check('顺序严格递增（无乱序）', bulkLines.every((line, index) => JSON.parse(line).messages[0].text === `msg-${index}`), true)
await rm(bulkOutDir, { recursive: true, force: true })

await rm(outDir, { recursive: true, force: true })

console.log(`\n=== 集成验证结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===`)
process.exitCode = failures === 0 ? 0 : 1
