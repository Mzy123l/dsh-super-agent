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
import { FoldStore, buildFoldPrompt } from './fold/store.js'
import { TodoStore, renderTodoList } from './todo/store.js'
import { OverrideStore, renderOverrideHistory } from './override/store.js'
import { PlanStore, renderPlan } from './plan/store.js'
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
  memory-plugin fold     --session <id> [--list]       列出或创建折叠
  memory-plugin todo     --session <id> [--add "..."]  待办台账
  memory-plugin override --session <id>                覆写记录
  memory-plugin plan     --session <id> [--history]    规划与版本历史
  memory-plugin compact  --session <id> [--dry-run]    手动折叠（对应 /compact）
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

    case 'fold': {
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin fold --session <id> [--from N --to N --summary "…"] [--list]')
        return 2
      }
      const store = openStore(args)
      const folds = new FoldStore(store.raw)

      if (args.flags.get('list') === 'true' || !args.flags.get('from')) {
        const list = folds.list(sessionId)
        if (list.length === 0) {
          console.log('（没有折叠）')
        } else {
          for (const f of list) {
            console.log(`#${f.fromIdx}~#${f.toIdx} [${f.trigger}] ${f.name}`)
            console.log(`  ${preview(f.foldSummary, 160)}`)
          }
        }
        store.close()
        return 0
      }

      const from = Number(args.flags.get('from'))
      const to = Number(args.flags.get('to') ?? from)
      const summary = args.flags.get('summary') ?? ''
      if (summary.trim().length === 0) {
        // 只预览：不落库
        const units = store.listRange(sessionId, from, to)
        const chars = units.reduce((n, u) => n + u.content.length, 0)
        console.log(`将折叠 #${from}~#${to}（${units.length} 个单位，${chars} 字符）`)
        console.log('折叠指令预览：')
        console.log(buildFoldPrompt(from, to, chars))
        store.close()
        return 0
      }

      const no = folds.create({
        sessionId, fromIdx: from, toIdx: to,
        foldSummary: summary, trigger: 'manual', name: args.flags.get('name') ?? '',
        createdAt: new Date().toISOString(),
      })
      console.log(`已折叠 #${from}~#${to} → 折叠体 ${no}`)
      console.log(`  ${preview(summary, 120)}`)
      store.close()
      return 0
    }

    case 'todo': {
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin todo --session <id> [--add "标题"] [--done N] [--drop N --reason "…"] [--all]')
        return 2
      }
      const store = openStore(args)
      const todos = new TodoStore(store.raw)

      if (args.flags.get('add')) {
        const no = todos.add({ sessionId, title: args.flags.get('add') as string, detail: args.flags.get('detail') ?? '' })
        console.log(`已登记待办 #${no}`)
      }
      if (args.flags.get('done')) {
        const no = Number(args.flags.get('done'))
        console.log(todos.done(sessionId, no) ? `待办 #${no} 已完成` : `没有待办 #${no}`)
      }
      if (args.flags.get('drop')) {
        const no = Number(args.flags.get('drop'))
        console.log(todos.drop(sessionId, no, args.flags.get('reason') ?? '') ? `待办 #${no} 已放弃` : `没有待办 #${no}`)
      }

      const list = todos.list(sessionId, args.flags.get('all') === 'true' ? 'all' : 'open')
      console.log(renderTodoList(list))
      store.close()
      return 0
    }

    case 'override': {
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin override --session <id> [--idx N --summary "…" --reason "…"] [--history]')
        return 2
      }
      const store = openStore(args)
      const overrides = new OverrideStore(store.raw)

      const idx = args.flags.get('idx')
      const summary = args.flags.get('summary')
      if (idx && summary) {
        const no = overrides.apply({
          sessionId,
          targetIdx: Number(idx),
          newSummary: summary,
          reason: args.flags.get('reason') ?? '',
        })
        console.log(no !== undefined ? `已覆写 #${idx}（记录 #${no}）` : `没有单位 #${idx}`)
      }

      console.log(renderOverrideHistory(overrides.list(sessionId)))
      store.close()
      return 0
    }

    case 'plan': {
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin plan --session <id> [--history] [--version N]')
        return 2
      }
      const store = openStore(args)
      const plans = new PlanStore(store.raw)

      if (args.flags.get('history') === 'true') {
        const h = plans.history(sessionId)
        if (h.length === 0) {
          console.log('（没有规划）')
        } else {
          for (const v of h) {
            console.log(`v${v.version}「${v.name}」 ${v.changeKind} — ${v.reason}`)
          }
        }
      } else if (args.flags.get('version')) {
        const v = plans.version(sessionId, Number(args.flags.get('version')))
        console.log(v ? `v${v.version}「${v.name}」\n${v.snapshot}` : '（没有该版本）')
      } else {
        const p = plans.get(sessionId)
        console.log(p ? renderPlan(p) : '（没有规划）')
      }
      store.close()
      return 0
    }

    case 'compact': {
      // 手动折叠：默认折叠最近一段未折叠的单位
      const sessionId = args.flags.get('session')
      if (!sessionId) {
        console.error('用法：memory-plugin compact --session <id> [--from N --to N] [--dry-run] [--keep 32]')
        return 2
      }
      const store = openStore(args)
      const folds = new FoldStore(store.raw)
      const range = store.indexRange(sessionId)
      if (!range) {
        console.log('（该会话没有单位）')
        store.close()
        return 0
      }

      const already = new Set<number>()
      for (const f of folds.list(sessionId)) {
        for (let i = f.fromIdx; i <= f.toIdx; i += 1) already.add(i)
      }

      let from: number
      let to: number
      if (args.flags.get('from')) {
        from = Number(args.flags.get('from'))
        to = Number(args.flags.get('to') ?? from)
      } else {
        // 默认：窗口外的连续未折叠单位
        const keep = Number(args.flags.get('keep') ?? DEFAULT_WINDOW)
        const cutoff = range.max - keep
        const candidates: number[] = []
        for (let i = range.min; i <= cutoff; i += 1) if (!already.has(i)) candidates.push(i)
        if (candidates.length === 0) {
          console.log('（没有可折叠的单位：最近一段仍在窗口内或已折叠）')
          store.close()
          return 0
        }
        from = Math.min(...candidates)
        to = Math.max(...candidates)
      }

      const units = store.listRange(sessionId, from, to)
      const chars = units.reduce((n, u) => n + u.content.length, 0)

      if (args.flags.get('dry-run') === 'true') {
        console.log(`将折叠 #${from}~#${to}（${units.length} 个单位，${chars} 字符）`)
        console.log('折叠指令：')
        console.log(buildFoldPrompt(from, to, chars))
        store.close()
        return 0
      }

      console.log(`折叠需要模型生成摘要。请把以下指令发给模型，然后用 --summary 落库：`)
      console.log('')
      console.log(buildFoldPrompt(from, to, chars))
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
