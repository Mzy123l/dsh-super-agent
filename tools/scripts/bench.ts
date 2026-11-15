// 性能压测：生成大规模 JSONL，跑生成器，记录耗时 / 内存 / 产物大小
//
// 用法：node dist/scripts/bench.js [每步最终消息数] [步数] [输出目录]
//   每步最终消息数 = 上下文累积到多少条消息（默认 20000）
//   步数           = 每侧请求次数（默认 60）
//
// 场景模拟真实 A/B：
//   - 左侧（off）：每步追加 3 条消息
//   - 右侧（on）：每步追加 3 条 + 1 条记忆注入消息
//   - 每隔 8 步做一次「压缩」：把前面大部分消息替换成一条摘要
//
// 「百万级消息」= 所有步骤的消息**总份数**（JSONL 里 message 对象的个数），
// 不是单步的消息条数 —— 后者才是真实上下文长度。

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const FINAL_MESSAGES = Number(process.argv[2] ?? 20_000)
const STEPS = Number(process.argv[3] ?? 60)
const OUT_DIR = resolve(process.argv[4] ?? '../.tmp/bench')

/** 造一段有区分度的正文（带序号，避免内容池完全去重） */
function body(tag: string, seq: number): string {
  return `${tag}：第 ${seq} 条上下文消息，用于性能压测。`.padEnd(180, '。')
}

interface Msg {
  role: string
  text: string
  reasoning?: string
}

function totals(messages: Msg[]) {
  let chars = 0
  let reasoningChars = 0
  let systemChars = 0
  for (const m of messages) {
    chars += m.text.length
    reasoningChars += (m.reasoning ?? '').length
    if (m.role === 'system') systemChars += m.text.length
  }
  return { messages: messages.length, chars, reasoningChars, systemChars }
}

function makeLine(variant: string, step: number, turn: number, messages: Msg[], seq: number): string {
  return JSON.stringify({
    ts: new Date(Date.UTC(2026, 10, 15, 6, 0, seq)).toISOString(),
    sessionId: 'session-bench-0001',
    provider: 'deepseek',
    model: 'deepseek-chat',
    step,
    turn,
    variant,
    runId: `run-bench-${variant}`,
    messages: messages.map((m) => ({
      role: m.role,
      text: m.text,
      chars: m.text.length,
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning, reasoningChars: m.reasoning.length } : {}),
    })),
    totals: totals(messages),
  })
}

/** 生成一侧的 JSONL（流式写盘，不在内存里堆整份文件） */
async function writeSide(path: string, variant: string, injectMemory: boolean): Promise<number> {
  const perStep = 3
  const steps = STEPS
  let messages: Msg[] = [{ role: 'system', text: body('系统提示词', 0) }]
  let buf: string[] = []
  let seq = 0
  let messageObjects = 0

  for (let step = 1; step <= steps; step++) {
    const turn = Math.ceil(step / 5)
    // 每步补齐到目标条数（模拟上下文持续增长）
    const target = Math.min(FINAL_MESSAGES, Math.ceil((FINAL_MESSAGES / steps) * step))
    while (messages.length < target) {
      const i = messages.length % 3
      const role = i === 0 ? 'user' : i === 1 ? 'assistant' : 'tool'
      const reasoning =
        role === 'assistant' ? `思考 ${step}-${messages.length}：先确认上下文规模，再决定是否压缩。`.repeat(20) : undefined
      messages.push({ role, text: body(role, seq), ...(reasoning !== undefined ? { reasoning } : {}) })
      seq++
    }
    if (injectMemory) {
      messages.push({ role: 'user', text: `[相关记忆] 第 ${step} 步注入：用户偏好中文回复。`.padEnd(120, '。') })
    }
    // 每 8 步压缩一次
    if (step % 8 === 0 && messages.length > 40) {
      const keep = messages.slice(0, 1)
      keep.push({
        role: 'user',
        text: `[历史摘要] 第 ${step} 步压缩：前面共 ${messages.length - 1} 条消息。`.padEnd(200, '。'),
      })
      messages = keep.concat(messages.slice(messages.length - 12))
    }
    messageObjects += messages.length
    buf.push(makeLine(variant, step, turn, messages, seq))
    if (buf.length >= 50) {
      await writeFile(path, buf.join('\n') + '\n', { flag: 'a' })
      buf = []
    }
  }
  if (buf.length > 0) {
    await writeFile(path, buf.join('\n') + '\n', { flag: 'a' })
  }
  return messageObjects
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  const offPath = join(OUT_DIR, 'bench-off.jsonl')
  const onPath = join(OUT_DIR, 'bench-on.jsonl')
  await writeFile(offPath, '', 'utf8')
  await writeFile(onPath, '', 'utf8')

  console.log(`场景：每侧 ${STEPS} 步，上下文累积到 ${FINAL_MESSAGES} 条消息`)
  const t0 = performance.now()
  const offObjs = await writeSide(offPath, 'off', false)
  const onObjs = await writeSide(onPath, 'on', true)
  const genMs = performance.now() - t0
  const totalObjects = offObjs + onObjs
  console.log(`夹具生成：${genMs.toFixed(0)} ms，message 对象共 ${totalObjects.toLocaleString('en-US')} 个`)

  // 跑生成器（记录峰值内存）
  const { execFile } = await import('node:child_process')
  const { statSync } = await import('node:fs')
  const outHtml = join(OUT_DIR, 'bench.html')
  const runStart = performance.now()
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [
        '--max-old-space-size=4096',
        join(resolve('.'), 'dist/gen-memory-debug.js'),
        '--on',
        onPath,
        '--off',
        offPath,
        '--out',
        outHtml,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, so, se) => {
        if (err) reject(new Error(`${err.message}\n${se}`))
        else resolvePromise(so)
      },
    )
  })
  const runMs = performance.now() - runStart

  const jsonlBytes = statSync(offPath).size + statSync(onPath).size
  const htmlBytes = statSync(outHtml).size

  console.log('\n--- 生成器输出 ---')
  console.log(stdout.trim())
  console.log('\n--- 性能汇总 ---')
  console.log(`  message 对象总数    : ${totalObjects.toLocaleString('en-US')}`)
  console.log(`  夹具 JSONL 大小     : ${(jsonlBytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  HTML 产物大小       : ${(htmlBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  生成耗时(含读+算+写): ${runMs.toFixed(0)} ms`)
  console.log(`  吞吐                : ${((jsonlBytes / 1024 / 1024) / (runMs / 1000)).toFixed(1)} MB/s`)
  console.log(`  每万条 message 耗时 : ${((runMs / totalObjects) * 10000).toFixed(1)} ms`)

  const report = {
    finalMessages: FINAL_MESSAGES,
    steps: STEPS,
    totalMessageObjects: totalObjects,
    jsonlBytes,
    htmlBytes,
    runMs,
    genMs,
  }
  await writeFile(join(OUT_DIR, 'bench.json'), JSON.stringify(report, null, 2), 'utf8')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
