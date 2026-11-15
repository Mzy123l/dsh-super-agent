// 生成合成采集夹具：模拟 capture-builder 的输出，用于离线验证生成器
//
// 用法：node dist/scripts/make-fixture.js <outDir>
//
// 造的场景（**同轮双栏**格式，新格式）：
//   1. step 1：首次请求，只有 system + user（两栏一致）
//   2. step 2：追加 assistant（含 reasoning）+ user
//   3. step 3：记忆机制注入一条记忆消息 → **右栏多一条**（before/after 的核心差异）
//   4. step 4：注入后继续对话，两栏再次一致（但相对上一步都增长）
//   5. step 5：出现压缩（前面的消息消失 → 消失）
//
// 另造一份**旧格式**（无 phase / requestKey）夹具，验证向后兼容。

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SYSTEM = '你是一个命令行助手。回答简洁。'

interface Msg {
  role: string
  text: string
  reasoning?: string
  toolName?: string
}

function mk(role: string, text: string, reasoning?: string, toolName?: string): Msg {
  const m: Msg = { role, text }
  if (reasoning !== undefined) m.reasoning = reasoning
  if (toolName !== undefined) m.toolName = toolName
  return m
}

/** 按 capture-builder 的契约算 totals */
function totals(messages: Msg[]) {
  let chars = 0
  let reasoningChars = 0
  let systemChars = 0
  for (const m of messages) {
    const c = m.text.length
    chars += c
    reasoningChars += (m.reasoning ?? '').length
    if (m.role === 'system') systemChars += c
  }
  return { messages: messages.length, chars, reasoningChars, systemChars }
}

/** 把消息转成采集插件的 message 结构 */
function payload(messages: Msg[]) {
  return messages.map((m) => ({
    role: m.role,
    text: m.text,
    chars: m.text.length,
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning, reasoningChars: m.reasoning.length } : {}),
    ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
  }))
}

/** 新格式的一行（带 phase 与 requestKey） */
function phaseLine(
  phase: 'before' | 'after',
  step: number,
  turn: number,
  messages: Msg[],
  seq: number,
): string {
  const requestKey = `session-demo-0001#${turn}#${step}`
  return JSON.stringify({
    ts: new Date(Date.UTC(2026, 10, 15, 6, 0, seq * 10)).toISOString(),
    sessionId: 'session-demo-0001',
    provider: 'deepseek',
    model: 'deepseek-chat',
    step,
    turn,
    variant: 'on',
    runId: 'run-2026-11-15-dual',
    phase,
    requestKey,
    messages: payload(messages),
    totals: totals(messages),
  })
}

/** 旧格式的一行（无 phase / requestKey，验证向后兼容） */
function legacyLine(
  variant: string,
  step: number,
  turn: number,
  messages: Msg[],
  seq: number,
): string {
  return JSON.stringify({
    ts: new Date(Date.UTC(2026, 10, 15, 6, 0, seq * 10)).toISOString(),
    sessionId: 'session-legacy-0001',
    provider: 'deepseek',
    model: 'deepseek-chat',
    step,
    turn,
    variant,
    runId: `run-2026-11-15-${variant}`,
    messages: payload(messages),
    totals: totals(messages),
  })
}

/**
 * 同轮双栏夹具：每个请求写两行（before + after），共用同一个 requestKey。
 *
 * 差异出现在 step 3：记忆机制往上下文里注入了一条记忆消息。
 */
function dualSide(): string[] {
  const sys = mk('system', SYSTEM)
  const u1 = mk('user', '帮我看看这个仓库的结构，然后写一个 TS 工具把 JSONL 转成 HTML。')
  const a1 = mk('assistant', '好的，我先列一下目录结构。', '用户要做 JSONL→HTML。先看目录，确认技术栈。')
  const u2 = mk('user', '继续，把增量对比做出来。')
  const a2 = mk('assistant', '已经写好生成器了，编译通过。', '增量对比用 LCP 找分界点。')
  const u3 = mk('user', '再补一个汇总表。')
  const a3 = mk('assistant', '汇总表加好了。')
  const memory = mk('user', '[相关记忆] 你在上一轮说要把临时脚本集中放到任务目录，结束时清理。')

  const out: string[] = []
  let seq = 0

  // step 1：两栏一致。
  out.push(phaseLine('before', 1, 1, [sys, u1], seq++))
  out.push(phaseLine('after', 1, 1, [sys, u1], seq++))
  // step 2：两栏一致。
  out.push(phaseLine('before', 2, 1, [sys, u1, a1, u2], seq++))
  out.push(phaseLine('after', 2, 1, [sys, u1, a1, u2], seq++))
  // step 3：记忆机制注入 → 右栏（after）多一条记忆消息。
  out.push(phaseLine('before', 3, 1, [sys, u1, a1, u2, a2], seq++))
  out.push(phaseLine('after', 3, 1, [sys, u1, a1, u2, a2, memory], seq++))
  // step 4：注入后的下一轮，两栏都带着记忆消息（一致）。
  out.push(phaseLine('before', 4, 2, [sys, u1, a1, u2, a2, u3, a3], seq++))
  out.push(phaseLine('after', 4, 2, [sys, u1, a1, u2, a2, memory, u3, a3], seq++))
  // step 5：压缩 → 前面的消息消失。
  out.push(phaseLine('before', 5, 2, [sys, mk('user', '[历史摘要] 前面讨论了 JSONL→HTML 生成器的实现。'), u3, a3], seq++))
  out.push(phaseLine('after', 5, 2, [sys, mk('user', '[历史摘要] 前面讨论了 JSONL→HTML 生成器的实现。'), memory, u3, a3], seq++))
  return out
}

/** 旧格式夹具（A/B 两轮，按 variant 分组） */
function legacySide(): string[] {
  const sys = mk('system', SYSTEM)
  const u1 = mk('user', '旧格式夹具：验证没有 phase 字段时仍能渲染。')
  const a1 = mk('assistant', '收到。', '旧格式走 variant 分流。')
  return [
    legacyLine('off', 1, 1, [sys, u1], 1),
    legacyLine('off', 2, 1, [sys, u1, a1], 2),
    legacyLine('on', 1, 1, [sys, u1], 3),
    legacyLine('on', 2, 1, [sys, u1, a1], 4),
  ]
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? '.tmp/fixtures'
  await mkdir(outDir, { recursive: true })
  // 同轮双栏（一个文件同时含 before 与 after 行）
  await writeFile(join(outDir, 'capture-dual.jsonl'), dualSide().join('\n') + '\n', 'utf8')
  // 旧格式（验证向后兼容）
  await writeFile(join(outDir, 'capture-legacy.jsonl'), legacySide().join('\n') + '\n', 'utf8')
  console.log(`夹具已写入：${outDir}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
