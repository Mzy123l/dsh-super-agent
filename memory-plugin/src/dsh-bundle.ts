// dsh bundle 适配层：把记忆插件挂到 DSH 上。
//
// 职责边界（重要）：
// - 核心（store / ingest / search）不依赖 dsh，保持可独立测试与 CLI 使用；
// - 本文件只做"dsh 侧适配"：注册插件、暴露检索工具、维护索引副本。
//
// 四条用户决策（见 docs/9O-memory-plugin-spec.md）：
// ① reasoning 只进向量，不进 FTS —— 在 core 的 extractor 里落实，此处无逻辑；
// ② 不用 dsh 内置 session-query，自建存储复制数据 —— 本插件读自己的副本；
// ③ 搜索全量（含被压缩遮蔽的事件）—— core 的 extractor 落实；
// ④ 不做轮末自动触发 —— 本文件**不注入任何上下文**，只在模型显式调用检索工具时返回。

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from './store/sqlite.js'
import { discoverSessionFiles, indexAll, indexSession, type IndexReport } from './ingest/indexer.js'
import { search } from './search/index.js'
import { NoopVectorStore } from './search/vector.js'
import type { IndexerConfig, SearchMode } from './types.js'
import { SealStore } from './seal/store.js'
import { createSealTool } from './seal/tool.js'
import { applySeal } from './seal/apply.js'

/** Cordis 插件名。 */
export const name = 'memory-plugin'

/** 依赖的服务。 */
export const inject = ['tools']

/**
 * 插件配置。
 *
 * 注意：cordis 的 `ctx.config` 需要在 `inject` 里声明 `'config'` 才能访问，
 * 而声明后插件会等待配置服务就绪——为避免这种耦合，配置一律走环境变量。
 */
export interface Config {
  /** DSH 的会话日志根目录（通常 $DSH_HOME/sessions）。 */
  sessionsDir: string
  /** 本插件自己的数据目录（索引副本；绝不写回 DSH 的目录）。 */
  dataDir: string
  /** 检索返回的最大条数。 */
  maxResults?: number
  /** 「近几步」保留原文的轮次数；更早的才允许封存。 */
  keepTurns?: number
}

const DEFAULT_MAX_RESULTS = 8
const DEFAULT_KEEP_TURNS = 3

/** 从环境变量读配置（不触碰 ctx.config，避免 inject 依赖）。 */
function resolveConfig(): Config {
  const home = process.env.DSH_HOME ?? `${process.env.HOME ?? '.'}/.dsh`
  const max = Number(process.env.MEMORY_MAX_RESULTS ?? DEFAULT_MAX_RESULTS)
  const keep = Number(process.env.MEMORY_KEEP_TURNS ?? DEFAULT_KEEP_TURNS)
  return {
    sessionsDir: process.env.MEMORY_SESSIONS_DIR ?? `${home}/sessions`,
    dataDir: process.env.MEMORY_DATA_DIR ?? './data',
    maxResults: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_RESULTS,
    keepTurns: Number.isFinite(keep) && keep >= 0 ? keep : DEFAULT_KEEP_TURNS,
  }
}

/**
 * 注册记忆检索工具与索引服务。
 *
 * 工具 `memory_search` 让模型**主动**检索历史（决策④：系统不主动提醒）。
 * 索引在会话结束时增量更新——这是"被动维护"，不属于"触发"：
 * 模型不会因为索引更新而多看到任何东西。
 */
export function apply(ctx: Context): void {
  const config = resolveConfig()
  const store = new MemoryStore({ path: `${config.dataDir}/memory.sqlite` })
  const vectorStore = new NoopVectorStore()
  const indexerConfig: IndexerConfig = {
    sessionsDir: config.sessionsDir,
    dataDir: config.dataDir,
    vectorStore,
  }

  // ---- L2 层：封存（近几步全量 + 总结，再前面的只有总结）----
  // 复用同一个 SQLite 连接：封存段与检索记录同库不同表。
  const sealStore = new SealStore(store.raw)

  /** 各会话的最新轮次（由 session/event 维护）。 */
  const latestTurns = new Map<string, number>()

  // 这个监听器**不是触发**：它只把轮次号记进一个内存 Map，
  // 供 `memory_seal` 写入 segment.turn 时读取。
  // 它不索引、不注入上下文、不发消息、不调用任何工具。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start') return
    const sid = (session as unknown as { id?: string }).id
    const turn = (event as unknown as { data?: { turn?: number } }).data?.turn
    if (typeof sid === 'string' && typeof turn === 'number') {
      latestTurns.set(sid, Math.max(latestTurns.get(sid) ?? 0, turn))
    }
  }, { global: true })

  ctx.tools.register(createSealTool({
    store: sealStore,
    latestTurn: (sessionId) => latestTurns.get(sessionId) ?? 0,
    keepTurns: config.keepTurns ?? DEFAULT_KEEP_TURNS,
    appendToSession: (sessionId, segment) => {
      applySeal(ctx, segment as Parameters<typeof applySeal>[1])
    },
    warn: (message) => ctx.logger.warn('memory-plugin: %s', message),
  }, ctx))

  /** 空的索引报告（增量索引时复用同一个 report 累加）。 */
  const emptyReport = (): IndexReport => ({
    sessionsScanned: 0,
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    recordsWritten: 0,
    reasoningWritten: 0,
    vectorsWritten: 0,
    badFrames: 0,
    parseErrors: 0,
    durationMs: 0,
  })

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      'Search the full history of past sessions for text that may have been compacted out of the current context. '
      + 'Use it when you need something the user mentioned earlier, especially a deferred task, a constraint, or a decision. '
      + 'Returns matching excerpts with their session, sequence number and role.',
    parameters: {
      query: { type: 'string', description: 'Text to search for. Keywords work best; natural language also works in hybrid mode.' },
      mode: { type: 'string', description: '"keyword" (default), "vector", or "hybrid" (needs an embedding endpoint configured).' },
      limit: { type: 'number', description: 'Maximum number of results (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string' },
                seq: { type: 'number' },
                kind: { type: 'string' },
                at: { type: 'string' },
                turn: { type: 'number' },
                shadowed: { type: 'boolean' },
                excerpt: { type: 'string' },
              },
            },
          },
          total: { type: 'number', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { query?: string; mode?: string; limit?: number }) {
      const limit = typeof args.limit === 'number' ? args.limit : config.maxResults
      const mode: SearchMode = args.mode === 'hybrid' ? 'hybrid' : 'keyword'
      const hits = await search({ store, vectorStore }, String(args.query ?? ''), { mode, limit })
      return {
        results: hits.map(hit => {
          const payload = hit.payload as {
            sessionId?: string
            seq?: number
            kind?: string
            at?: string
            turn?: number
            shadowed?: boolean
            excerpt?: string
          }
          return {
            sessionId: payload.sessionId,
            seq: payload.seq,
            kind: payload.kind ?? hit.kind,
            at: payload.at,
            turn: payload.turn,
            shadowed: payload.shadowed,
            excerpt: payload.excerpt,
          }
        }),
        total: hits.length,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'memory_search', rawInput: args }),
  }))

  // 注意：**这里没有自动索引**。
  //
  // 用户明确要求「不做程序化触发」——包括不在会话结束时、不在每轮结束时、
  // 不在任何事件上自动跑索引。索引只能由人显式发起（CLI 或面板按钮）。
  //
  // 因此 `agent/disposed` 上不挂任何监听器。
  // 索引入口见下方 `ctx.provide('memory', ...)`，它只暴露函数、不自己调用。

  // 提供手动索引入口（面板/CLI 复用）。
  // 必须用 ctx.provide：cordis 的 ctx 是代理，直接赋值未声明的属性会抛
  // "cannot set property ... without provide"，导致整个插件激活失败。
  ctx.provide('memory', {
    /** 显式全量索引——只由人/CLI 调用，插件自己不触发。 */
    indexAll: () => indexAll(indexerConfig, store),
    /** 显式索引单个会话——同样只由人调用。 */
    indexSession: async (id: string) => {
      const files = discoverSessionFiles(config.sessionsDir).filter(f => f.sessionId === id)
      for (const file of files) {
        await indexSession(store, vectorStore, indexerConfig, file, emptyReport())
      }
    },
    /** 封存段仓储（读取已封存的历史总结）。 */
    seals: sealStore,
    store,
  })
}

/** 释放资源：关闭数据库。 */
export function dispose(ctx: Context): void {
  const memory = (ctx as unknown as { memory?: { store?: MemoryStore } }).memory
  memory?.store?.close()
}
