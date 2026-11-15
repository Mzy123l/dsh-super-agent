#!/usr/bin/env node
// CLI：查看编号单位、发送视图、检索、总结覆盖。
//
// 没有自动索引：所有命令都是人显式调用。

import { join } from 'node:path'
import { MemoryStore } from './store/sqlite.js'
import { PendingStore } from './summary/pending.js'
import { search } from './search/index.js'
import { SqliteVectorStore, HashingEmbedding } from './search/vector.js'
import { renderUnits, DEFAULT_WINDOW } from './projection/render.js'
import { summaryCoverage } from './summary/flow.js'
import type { SearchMode } from './types.js'

interface CliArgs {
  command: string
  flags: Map<string, string>
  positional: string[]
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>()
  const positional: string[] = []
  let command = ''
  let i = 0
  while (i < argv.length) {
    const arg = argv[i] as string
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags.set(name, 'true')
        i += 1
      } else {
        flags.set(name, next)
        i += 2
      }
    } else if (!command) {
      command = arg
      i += 1
    } else {
      positional.push(arg)
      i += 1
    }
  }
  return { command, flags, positional }
}

function openStore(args: CliArgs): MemoryStore {
  return new MemoryStore({ path: join(args.flags.get('data') ?? './data', 'memory.sqlite') })
}

function usage(): void {
  console.log(`memory-plugin — DSH 会话记忆插件

用法：
  memory-plugin units --session <id> [--data <dir>]        列出编号单位
  memory-plugin unit  --session <id> --idx N [--data <dir>] 取某单位全量
  memory-plugin view  --session <id> [--window 20]         查看发送视图
  memory-plugin search "query" [--mode keyword|hybrid] [--limit 8] [--session <id>]
  memory-plugin status [--data <dir>]

说明：
  - 编号会话内线性，0 = 第一个 user prompt
  - 近程 summary+content 全发；远程只发 summary
  - 检索命中返回单位全量，不截断`)
}

function preview(text: string, n = 80): string {
  const one = text.replace(/\s+/g, ' ')
  return one.length > n ? `${one.slice(0, n)}…` : one
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command) {
    usage()
    return 0
  }

  switch (args.command) {
    case 'units': {
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin units --session <id>')
        return 2
      }
      const store = openStore(args)
      const range = store.indexRange(sessionId)
      if (!range) {
        console.log('（该会话没有单位）')
        store.close()
        return 0
      }
      const units = store.listRange(sessionId, range.min, range.max)
      const c = summaryCoverage(store, sessionId)
      console.log(`会话 ${sessionId} · 编号 #${range.min}–#${range.max} · 共 ${units.length} 个单位（已总结 ${c.summarized}）`)
      for (const u of units) {
        const s = u.summary.trim().length > 0 ? ` [summary ${u.summary.length}字]` : ''
        const ctx = u.inContext ? '' : ' [不在上下文]'
        console.log(`  #${u.idx} ${u.kind.padEnd(8)} ${u.content.length}字${s}${ctx}  ${preview(u.content, 50)}`)
      }
      store.close()
      return 0
    }

    case 'unit': {
      const sessionId = args.flags.get('session')
      const idx = Number(args.flags.get('idx') ?? -1)
      if (!sessionId || idx < 0) {
        console.error('用法：memory-plugin unit --session <id> --idx N')
        return 2
      }
      const store = openStore(args)
      const u = store.getUnit(sessionId, idx)
      if (!u) {
        console.error(`未找到 #${idx}`)
        store.close()
        return 1
      }
      console.log(`#${u.idx} ${u.kind} · ${u.at}${u.inContext ? '' : ' · 不在上下文'}`)
      if (u.tags.length > 0) console.log(`便签：${u.tags.join(', ')}`)
      if (u.summary.trim().length > 0) {
        console.log(`\n--- summary ---\n${u.summary}`)
      }
      console.log(`\n--- content ---\n${u.content}`)
      store.close()
      return 0
    }

    case 'view': {
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin view --session <id>')
        return 2
      }
      const store = openStore(args)
      const range = store.indexRange(sessionId)
      if (!range) {
        console.log('（该会话没有单位）')
        store.close()
        return 0
      }
      const window = Number(args.flags.get('window') ?? DEFAULT_WINDOW)
      const units = store.listRange(sessionId, range.min, range.max)
      const rendered = renderUnits(units, { window, latestIdx: range.max })
      console.log(`发送视图（窗口 ${window} 个单位，最新 #${range.max}）：`)
      console.log('')
      for (const text of rendered) console.log(text, '\n')
      store.close()
      return 0
    }

    case 'search': {
      const query = args.positional[0]
      if (!query) {
        console.error('用法：memory-plugin search "query"')
        return 2
      }
      const store = openStore(args)
      const hits = await search(
        { store, vectorStore: new SqliteVectorStore(store.raw), embedding: new HashingEmbedding() },
        query,
        {
          mode: (args.flags.get('mode') === 'hybrid' ? 'hybrid' : 'keyword') as SearchMode,
          limit: Number(args.flags.get('limit') ?? 8),
          sessionId: args.flags.get('session') ?? undefined,
        },
      )
      console.log(`命中 ${hits.length} 条：`)
      for (const h of hits) {
        console.log(`\n#${h.idx} ${h.kind}${h.inContext ? '' : ' · 不在上下文'}`)
        if (h.summary.trim().length > 0) console.log(`summary: ${preview(h.summary, 200)}`)
        console.log(preview(h.content, 400))
      }
      store.close()
      return 0
    }

    case 'status': {
      const store = openStore(args)
      const s = store.status()
      console.log(`sessions        : ${s.sessions}`)
      console.log(`units           : ${s.units}`)
      console.log(`in context      : ${s.inContext}`)
      console.log(`with summary    : ${s.withSummary}`)
      console.log(`last indexed at : ${s.lastIndexedAt ?? '(never)'}`)
      const pending = new PendingStore(store.raw).list()
      console.log(`pending summary : ${pending.length}`)
      store.close()
      return 0
    }

    default:
      console.error(`未知命令：${args.command}`)
      usage()
      return 2
  }
}

main().then(code => process.exit(code)).catch((error) => {
  console.error(error)
  process.exit(1)
})
