// CLI：index / search / status（规格 §5.2）
//
// 用法：
//   memory-plugin index [--sessions <dir>] [--data <dir>] [--session <id>] [--all]
//   memory-plugin search "待办" [--mode hybrid] [--limit 20] [--json] [--order time]
//   memory-plugin status [--data <dir>]

import { MemoryStore } from './store/sqlite.js'
import { SegmentStore } from './seal/store.js'
import { applyArchive } from './seal/lifecycle.js'
import { computeSpans, coveredSeqs } from './seal/spans.js'
import { indexAll, discoverSessionFiles } from './ingest/indexer.js'
import { search } from './search/index.js'
import { NoopVectorStore, OpenAICompatEmbedding, OpenAICompatVectorStore } from './search/vector.js'
import type { IndexerConfig } from './types.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 默认会话目录（只读）：~/.dsh/sessions */
function defaultSessionsDir(): string {
  return join(homedir(), '.dsh', 'sessions')
}

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
      // 布尔 flag（无值或下一个也是 -- 开头）
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

function buildConfig(flags: Map<string, string>): IndexerConfig {
  const dataDir = flags.get('data') ?? join(process.cwd(), 'data')
  const sessionsDir = flags.get('sessions') ?? defaultSessionsDir()
  const config: IndexerConfig = { sessionsDir, dataDir }

  // 向量：环境变量齐全时用 OpenAI 兼容端点，否则 Noop（理论阶段默认）
  const embedding = OpenAICompatEmbedding.fromEnv()
  if (embedding && flags.get('vector') !== 'false') {
    config.embedding = embedding
    config.vectorStore = new OpenAICompatVectorStore(embedding)
  } else {
    config.vectorStore = new NoopVectorStore()
  }
  return config
}

function formatRecord(
  kind: string,
  sessionId: string,
  seq: number,
  at: string,
  turn: number | undefined,
  shadowed: boolean,
  score: number | undefined,
  text: string,
): string {
  const turnPart = turn !== undefined ? ` turn=${turn}` : ''
  const scorePart = score !== undefined ? ` score=${score.toFixed(4)}` : ''
  const flags = [shadowed ? 'shadowed' : '', turnPart, scorePart].filter(Boolean).join('')
  const head = `[${kind}] ${sessionId.slice(0, 8)} seq=${seq} at=${at}${flags ? ' ' + flags : ''}`
  const body = text.replace(/\s+/g, ' ').slice(0, 120)
  return `${head}\n  ${body}`
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  switch (args.command) {
    case 'index': {
      const config = buildConfig(args.flags)
      const specific = args.flags.get('session')
      if (specific) {
        // 单会话索引：定位到该会话文件
        const files = discoverSessionFiles(config.sessionsDir).filter((f) => f.sessionId === specific)
        if (files.length === 0) {
          console.error(`session not found: ${specific}`)
          return 1
        }
        const store = new MemoryStore({ path: join(config.dataDir, 'memory.sqlite') })
        const { report } = await import('./ingest/indexer.js').then(async (m) => {
          const r = {
            sessionsScanned: files.length,
            sessionsIndexed: 0,
            sessionsSkipped: 0,
            recordsWritten: 0,
            reasoningWritten: 0,
            vectorsWritten: 0,
            badFrames: 0,
            parseErrors: 0,
            durationMs: 0,
          }
          for (const file of files) await m.indexSession(store, config.vectorStore!, config, file, r)
          store.setMeta('lastIndexedAt', new Date().toISOString())
          return { report: r }
        })
        console.log(JSON.stringify(report, null, 2))
        store.close()
        return 0
      }
      const { store, report } = await indexAll(config)
      console.log(JSON.stringify(report, null, 2))
      store.close()
      return 0
    }

    case 'search': {
      const query = args.positional[0]
      if (!query) {
        console.error('usage: memory-plugin search "query" [--mode hybrid] [--limit 20] [--json]')
        return 1
      }
      const config = buildConfig(args.flags)
      const store = new MemoryStore({ path: join(config.dataDir, 'memory.sqlite') })
      const mode = args.flags.get('mode') === 'hybrid' ? 'hybrid' : 'keyword'
      const limit = Number(args.flags.get('limit') ?? 20)
      const order = args.flags.get('order') === 'time' ? 'time' : 'rank'
      const results = await search(
        { store, vectorStore: config.vectorStore, embedding: config.embedding as never },
        query,
        { mode, limit, order },
      )
      if (args.flags.get('json') === 'true') {
        console.log(JSON.stringify(results, null, 2))
      } else {
        for (const r of results) {
          if (r.isReasoning) {
            const hit = r.payload as import('./types.js').ReasoningHit
            console.log(
              formatRecord('reasoning', hit.sessionId, hit.seq, hit.at, hit.turn, false, r.score, hit.text),
            )
          } else {
            const rec = r.payload as import('./types.js').MemoryRecordResult
            console.log(
              formatRecord(rec.kind, rec.sessionId, rec.seq, rec.at, rec.turn, rec.shadowed, r.score, rec.text),
            )
          }
          console.log('')
        }
        console.log(`(${results.length} hits, mode=${mode})`)
      }
      store.close()
      return 0
    }

    case 'spans': {
      // 列出某会话可总结的区间（只读）
      const config = buildConfig(args.flags)
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin spans --session <id>')
        return 2
      }
      const store = new MemoryStore({ path: join(config.dataDir, 'memory.sqlite') })
      const segments = new SegmentStore(store.raw)
      const covered = coveredSeqs(segments, sessionId)
      const events = store.listEvents(sessionId, undefined, 100000, 0).map(e => ({
        seq: e.seq,
        turn: e.turn,
        chars: e.text.length,
      }))
      const latestTurn = events.reduce((m, e) => Math.max(m, e.turn ?? 0), 0)
      const keepTurns = Number(args.flags.get('keep') ?? 3)
      const spans = computeSpans(events, covered, latestTurn, keepTurns)
      if (args.flags.get('json') === 'true') {
        console.log(JSON.stringify({ sessionId, latestTurn, keepTurns, spans }, null, 2))
      } else {
        console.log(`session ${sessionId} · latest turn ${latestTurn} · keep ${keepTurns}`)
        console.log(`可总结区间：${spans.length} 个`)
        for (const s of spans) {
          console.log(
            `  turn ${s.fromTurn}  seq ${s.fromSeq}–${s.toSeq}  ${s.eventCount} 条  ${s.chars} 字符  ${s.recommendation}`,
          )
        }
      }
      store.close()
      return 0
    }

    case 'archive': {
      // 把滑出近期窗口的段降级为「只留总结」
      const config = buildConfig(args.flags)
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin archive --session <id> [--keep 3]')
        return 2
      }
      const store = new MemoryStore({ path: join(config.dataDir, 'memory.sqlite') })
      const segments = new SegmentStore(store.raw)
      const latestTurn = Number(args.flags.get('latest') ?? 0)
      const keepTurns = Number(args.flags.get('keep') ?? 3)
      const archived = applyArchive(segments, sessionId, latestTurn, keepTurns)
      console.log(`已降级 ${archived} 个段（session=${sessionId} latestTurn=${latestTurn} keep=${keepTurns}）`)
      store.close()
      return 0
    }

    case 'status': {
      const config = buildConfig(args.flags)
      const store = new MemoryStore({ path: join(config.dataDir, 'memory.sqlite') })
      const vectorStore = config.vectorStore ?? new NoopVectorStore()
      const status = store.status()
      console.log(`sessions indexed : ${status.sessions}`)
      console.log(`events           : ${status.events}`)
      console.log(`reasoning        : ${status.reasoning}`)
      console.log(`sealed segments  : ${status.sealed}`)
      console.log(`summaries        : ${status.summaries}`)
      console.log(`shadowed records : ${status.shadowed}`)
      console.log(`last indexed at  : ${status.lastIndexedAt ?? '(never)'}`)
      store.close()
      return 0
    }

    case 'serve': {
      // HTTP 只读 API（规格 §5.1；默认 127.0.0.1:7800）
      const config = buildConfig(args.flags)
      const store = new MemoryStore({ path: join(config.dataDir, 'memory.sqlite') })
      const { startApiServer } = await import('./api/server.js')
      const server = startApiServer({
        store,
        config,
        vectorStore: config.vectorStore,
        embedding: config.embedding as never,
        port: Number(args.flags.get('port') ?? 7800),
      })
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 7800
      console.log(`memory-plugin API listening on http://127.0.0.1:${port} (read-only + POST /index)`)
      return 0
    }

    default:
      console.log(`memory-plugin — DSH 会话记忆插件（纯理论实现）

用法：
  memory-plugin index [--sessions <dir>] [--data <dir>] [--session <id>] [--all]
  memory-plugin search "query" [--mode keyword|hybrid] [--limit 20] [--order rank|time] [--json]
  memory-plugin status [--data <dir>]
  memory-plugin serve [--port 7800] [--data <dir>]
  memory-plugin spans --session <id> [--keep 3]       列出可总结的区间（只读）
  memory-plugin archive --session <id> --latest N [--keep 3]  降级滑出窗口的段

说明：
  - 会话目录只读；索引数据写入 --data（默认 ./data）
  - 向量化默认关闭（NoopVectorStore）；设置 MEMORY_EMBEDDING_API_KEY/
    MEMORY_EMBEDDING_BASE_URL/MEMORY_EMBEDDING_MODEL 后 hybrid 可用`)
      return args.command ? 1 : 0
  }
}

main().then((code) => {
  process.exitCode = code
})
