// 契约对齐验证：用 capture-builder 的**真实序列化代码**产出 JSONL，
// 再喂给生成器，确认两端字段完全兼容。
//
// 用法：node dist/scripts/contract-check.js <outDir>
// 依赖：../memory-debug-capture/dist/serialize.js（capture-builder 的产物）

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const OUT_DIR = resolve(process.argv[2] ?? '../.tmp/contract')

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  // 动态载入 capture 插件的序列化器（跨包引用，用文件 URL）
  const captureDist = resolve('../memory-debug-capture/dist/serialize.js')
  const mod = (await import(pathToFileURL(captureDist).href)) as {
    serializeMessages: (msgs: unknown[], opts?: { maxChars?: number }) => unknown[]
    computeTotals: (msgs: unknown[]) => unknown
  }

  type Src = { role: string, content?: Array<{ type: string, text?: string, id?: string, name?: string }>, toolCallId?: string }
  const txt = (s: string) => ({ type: 'text', text: s })
  const rea = (s: string) => ({ type: 'reasoning', text: s })

  const sys = (extra = ''): Src => ({ role: 'system', content: [txt('你是一个命令行助手。回答简洁。' + extra)] })
  const usr = (s: string): Src => ({ role: 'user', content: [txt(s)] })
  const asst = (s: string, r?: string): Src => ({
    role: 'assistant',
    content: r ? [txt(s), rea(r)] : [txt(s)],
  })

  /** 用真实序列化器造一行 */
  function line(variant: string, step: number, turn: number, messages: Src[], seq: number): string {
    const snap = mod.serializeMessages(messages, { maxChars: 20000 })
    return JSON.stringify({
      ts: new Date(Date.UTC(2026, 10, 15, 6, 0, seq * 10)).toISOString(),
      sessionId: 'session-contract-0001',
      provider: 'deepseek',
      model: 'deepseek-chat',
      step,
      turn,
      variant,
      runId: `run-contract-${variant}`,
      messages: snap,
      totals: mod.computeTotals(snap),
    })
  }

  // 不启用插件：4 步
  const offLines = [
    line('off', 1, 1, [sys(), usr('帮我把 JSONL 转成 HTML。')], 1),
    line('off', 2, 1, [sys(), usr('帮我把 JSONL 转成 HTML。'), asst('好的。', '先看目录。')], 2),
    line('off', 3, 1, [sys(), usr('帮我把 JSONL 转成 HTML。'), asst('好的。'), usr('继续。')], 3),
    line('off', 4, 2, [sys(), usr('帮我把 JSONL 转成 HTML。'), asst('好的。'), usr('继续。'), asst('做完了。')], 4),
  ]

  // 启用插件：5 步（多了记忆注入，且第 2 步的 reasoning 缺失、第 3 步补上 → 增长）
  const mem = '[相关记忆] 用户偏好中文回复；要求临时脚本放到任务目录。'
  const onLines = [
    line('on', 1, 1, [sys('\n\n[记忆] 用户偏好：中文回复。'), usr('帮我把 JSONL 转成 HTML。')], 1),
    line('on', 2, 1, [sys('\n\n[记忆] 用户偏好：中文回复。'), usr('帮我把 JSONL 转成 HTML。'), asst('好的。'), usr('继续。')], 2),
    line(
      'on',
      3,
      1,
      [
        sys('\n\n[记忆] 用户偏好：中文回复。'),
        usr('帮我把 JSONL 转成 HTML。'),
        asst('好的。', '先看目录。'),
        usr('继续。'),
        usr(mem),
      ],
      3,
    ),
    line(
      'on',
      4,
      2,
      [
        sys('\n\n[记忆] 用户偏好：中文回复。'),
        usr('帮我把 JSONL 转成 HTML。'),
        asst('好的。', '先看目录。'),
        usr('继续。'),
        usr(mem),
        asst('做完了。'),
      ],
      4,
    ),
    line(
      'on',
      5,
      3,
      [sys('\n\n[记忆] 用户偏好：中文回复。'), usr('最后验证一下。'), asst('验证通过。')],
      5,
    ),
  ]

  await writeFile(join(OUT_DIR, 'capture-off.jsonl'), offLines.join('\n') + '\n', 'utf8')
  await writeFile(join(OUT_DIR, 'capture-on.jsonl'), onLines.join('\n') + '\n', 'utf8')
  console.log(`契约夹具已写入：${OUT_DIR}`)
  console.log(`  off ${offLines.length} 行 / on ${onLines.length} 行（由 capture 插件的真实序列化器产出）`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
