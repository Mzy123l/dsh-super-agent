// 生成合成采集夹具：模拟 capture-builder 的输出，用于离线验证生成器
//
// 用法：node dist/make-fixture.js <outDir>
//
// 造的场景（两侧都要覆盖）：
//   1. step 1：首次请求，只有 system + user
//   2. step 2：追加 assistant（含 reasoning）+ user
//   3. step 3：assistant 消息**补上 reasoning**（同一条变长 → 增长）
//   4. step 4：插件侧注入记忆消息（两侧结构不同 → LCP 不同）
//   5. step 5：出现压缩（前面的消息消失 → 消失）
//   6. step 6：两侧步数不同（右侧多一步）

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SYSTEM_OFF = '你是一个命令行助手。回答简洁。'
const SYSTEM_ON = '你是一个命令行助手。回答简洁。\n\n[记忆] 用户偏好：中文回复；曾要求把临时脚本放到任务目录。'

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

function line(
  variant: string,
  step: number,
  turn: number,
  messages: Msg[],
  seq: number,
): string {
  return JSON.stringify({
    ts: new Date(Date.UTC(2026, 10, 15, 6, 0, seq * 10)).toISOString(),
    sessionId: 'session-demo-0001',
    provider: 'deepseek',
    model: 'deepseek-chat',
    step,
    turn,
    variant,
    runId: `run-2026-11-15-${variant}`,
    messages: messages.map((m) => ({
      role: m.role,
      text: m.text,
      chars: m.text.length,
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning, reasoningChars: m.reasoning.length } : {}),
      ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
    })),
    totals: totals(messages),
  })
}

/** 不启用插件一侧的 5 步 */
function offSide(): string[] {
  const sys = mk('system', SYSTEM_OFF)
  const u1 = mk('user', '帮我看看这个仓库的结构，然后写一个 TS 工具把 JSONL 转成 HTML。')
  const a1 = mk('assistant', '好的，我先列一下目录结构。', '用户要做 JSONL→HTML。先看目录，确认技术栈。')
  const u2 = mk('user', '继续，把增量对比做出来。')
  const a2 = mk('assistant', '已经写好生成器了，编译通过。', '增量对比用 LCP 找分界点。')
  const u3 = mk('user', '再补一个汇总表。')
  const a3 = mk('assistant', '汇总表加好了。')

  return [
    line('off', 1, 1, [sys, u1], 1),
    line('off', 2, 1, [sys, u1, a1, u2], 2),
    line('off', 3, 1, [sys, u1, a1, u2, a2], 3),
    line('off', 4, 2, [sys, u1, a1, u2, a2, u3, a3], 4),
    // 第 5 步：压缩掉了前 4 条
    line('off', 5, 2, [sys, mk('user', '[历史摘要] 前面讨论了 JSONL→HTML 生成器的实现。'), u3, a3], 5),
  ]
}

/** 启用插件一侧的 6 步（比左侧多一步，且结构有差异） */
function onSide(): string[] {
  const sys = mk('system', SYSTEM_ON)
  const u1 = mk('user', '帮我看看这个仓库的结构，然后写一个 TS 工具把 JSONL 转成 HTML。')
  const a1 = mk('assistant', '好的，我先列一下目录结构。', '用户要做 JSONL→HTML。先看目录，确认技术栈。')
  const u2 = mk('user', '继续，把增量对比做出来。')
  const a2 = mk('assistant', '已经写好生成器了，编译通过。', '增量对比用 LCP 找分界点。')
  const u3 = mk('user', '再补一个汇总表。')
  const a3 = mk('assistant', '汇总表加好了。')
  const a4 = mk('assistant', '另外我检查了浏览器控制台，没有报错。')

  return [
    line('on', 1, 1, [sys, u1], 1),
    // 第 2 步：assistant 的 reasoning 尚未写入（同一场景的更早时刻）
    line('on', 2, 1, [sys, u1, mk('assistant', '好的，我先列一下目录结构。'), u2], 2),
    // 第 3 步：reasoning 补上了 → 同一条消息「增长」
    line('on', 3, 1, [sys, u1, a1, u2, a2], 3),
    // 第 4 步：注入记忆消息（左侧没有）
    line(
      'on',
      4,
      2,
      [sys, u1, a1, u2, a2, u3, a3, mk('user', '[相关记忆] 你在上一轮说要把临时脚本集中放到任务目录，结束时清理。')],
      4,
    ),
    // 第 5 步：压缩
    line(
      'on',
      5,
      2,
      [
        sys,
        mk('user', '[历史摘要] 前面讨论了 JSONL→HTML 生成器的实现。'),
        u3,
        a3,
        mk('user', '[相关记忆] 你在上一轮说要把临时脚本集中放到任务目录，结束时清理。'),
      ],
      5,
    ),
    // 第 6 步：只有右侧有
    line('on', 6, 3, [sys, mk('user', '最后跑一遍验证。'), a4], 6),
  ]
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? '.tmp/fixtures'
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'capture-off.jsonl'), offSide().join('\n') + '\n', 'utf8')
  await writeFile(join(outDir, 'capture-on.jsonl'), onSide().join('\n') + '\n', 'utf8')
  console.log(`夹具已写入：${outDir}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
