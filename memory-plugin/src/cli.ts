#!/usr/bin/env node
// CLI：手动索引、检索、状态、区间查看。
//
// 注意：**没有自动索引**。索引只能由人显式发起。

import { join } from 'node:path'
import { MemoryStore } from './store/sqlite.js'
import { SegmentStore } from './seal/types.js'
import { search } from './search/index.js'
import { SqliteVectorStore, HashingEmbedding } from './search/vector.js'
import { computeSpans, archiveDue } from './loop/engine.js'
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
  const dataDir = args.flags.get('data') ?? './data'
  return new MemoryStore({ path: join(dataDir, 'memory.sqlite') })
}

function usage(): void {
  console.log(`memory-plugin — DSH 会话记忆插件

用法：
  memory-plugin search "query" [--mode keyword|hybrid] [--limit 8] [--session <id>] [--data <dir>]
  memory-plugin get --session <id> --idx N [--data <dir>]      取某条消息的全量
  memory-plugin spans --session <id> [--keep 20] [--data <dir>] 列出可提炼区间
  memory-plugin archive --session <id> --keep 20 [--data <dir>] 降级滑出窗口的段
  memory-plugin status [--data <dir>]

说明：
  - 索引按会话线性维护，0 = 第一个 user prompt
  - 检索命中返回该条消息的**全量**，不摘要
  - 便签由程序内部维护，只做展示`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.command) {
    usage()
    return args.command ? 1 : 0
  }

  switch (args.command) {
    case 'search': {
      const query = args.positional[0]
      if (!query) {
        console.error('用法：memory-plugin search "query"')
        return 2
      }
      const store = openStore(args)
      const vectorStore = new SqliteVectorStore(store.raw)
      const embedding = new HashingEmbedding()
      const mode: SearchMode = args.flags.get('mode') === 'hybrid' ? 'hybrid' : 'keyword'
      const hits = await search(
        { store, vectorStore, embedding },
        query,
        {
          mode,
          limit: Number(args.flags.get('limit') ?? 8),
          sessionId: args.flags.get('session') ?? undefined,
        },
      )
      if (args.flags.get('json') === 'true') {
        console.log(JSON.stringify(hits, null, 2))
      } else {
        console.log(`命中 ${hits.length} 条：`)
        for (const h of hits) {
          const tags = h.tags.length > 0 ? ` [${h.tags.join(',')}]` : ''
          const flag = h.inContext ? '' : ' (已离开上下文)'
          console.log(`\n#${h.idx} ${h.role}${tags}${flag}`)
          console.log(h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text)
        }
      }
      store.close()
      return 0
    }

    case 'get': {
      const sessionId = args.flags.get('session')
      const idx = Number(args.flags.get('idx') ?? -1)
      if (!sessionId || idx < 0) {
        console.error('用法：memory-plugin get --session <id> --idx N')
        return 2
      }
      const store = openStore(args)
      const msg = store.getMessage(sessionId, idx)
      if (!msg) {
        console.error(`未找到 #${idx}`)
        store.close()
        return 1
      }
      console.log(`#${msg.idx} ${msg.role} · ${msg.at}${msg.inContext ? '' : ' · 已离开上下文'}`)
      if (msg.tags.length > 0) console.log(`便签：${msg.tags.join(', ')}`)
      console.log('')
      console.log(msg.text)
      store.close()
      return 0
    }

    case 'spans': {
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin spans --session <id>')
        return 2
      }
      const store = openStore(args)
      const segments = new SegmentStore(store.raw)
      const keep = Number(args.flags.get('keep') ?? 20)
      const range = store.indexRange(sessionId)
      const spans = computeSpans(store, segments, sessionId)
      console.log(`会话 ${sessionId}`)
      console.log(`索引范围：#${range?.min ?? '-'} … #${range?.max ?? '-'}（共 ${store.count(sessionId)} 条）`)
      console.log(`保留最近 ${keep} 条原文，可提炼区间 ${spans.length} 个：`)
      for (const s of spans) {
        console.log(`  #${s.fromIdx}–#${s.toIdx}  ${s.count} 条  ${s.chars} 字符`)
      }
      store.close()
      return 0
    }

    case 'archive': {
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin archive --session <id> --keep 20')
        return 2
      }
      const store = openStore(args)
      const segments = new SegmentStore(store.raw)
      const keep = Number(args.flags.get('keep') ?? 20)
      const range = store.indexRange(sessionId)
      const n = range ? archiveDue(segments, sessionId, keep, range.max) : 0
      console.log(`已降级 ${n} 个段（会话 ${sessionId}，保留最近 ${keep} 条）`)
      store.close()
      return 0
    }

    case 'status': {
      const store = openStore(args)
      const s = store.status()
      console.log(`sessions        : ${s.sessions}`)
      console.log(`messages        : ${s.messages}`)
      console.log(`in context      : ${s.inContext}`)
      console.log(`segments        : ${s.segments}（live ${s.liveSegments}）`)
      console.log(`last indexed at : ${s.lastIndexedAt ?? '(never)'}`)
      store.close()
      return 0
    }

    default:
      console.error(`未知命令：${args.command}`)
      usage()
      return 2
  }
}

main().then(code => process.exit(code)).catch(error => {
  console.error(error)
  process.exit(1)
})
