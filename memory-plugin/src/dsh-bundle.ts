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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * 声明自定义的消息来源种类。
 *
 * dsh 的 `MessageSourceMap` 是闭合联合类型，插件要注入带自有来源的消息，
 * 必须像官方 `dsh-agent-instructions` 那样用模块增强扩展它。
 * 否则 `createUserMessage` 会拒绝这个 source.kind。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-loop-prompt': { kind: 'memory-loop-prompt' }
  }
}
import { MemoryStore } from './store/sqlite.js'
import { discoverSessionFiles, indexAll, indexSession, type IndexReport } from './ingest/indexer.js'
import { search } from './search/index.js'
import { NoopVectorStore } from './search/vector.js'
import type { IndexerConfig, SearchMode } from './types.js'
import { SegmentStore } from './seal/store.js'
import { applySegment } from './seal/apply.js'
import { applyArchive } from './seal/lifecycle.js'
import type { SpanEvent } from './seal/spans.js'
import { runLoopStep, type AssistantSnapshot } from './loop/engine.js'
import { PendingStore } from './loop/store.js'

/** 哪些事件类型算「有内容的」，需要计入区间统计。 */
function isContentEvent(type: string | undefined): boolean {
  return type === 'user/message'
    || type === 'assistant/message'
    || type === 'reasoning'
    || type === 'tool/call'
    || type === 'tool/result'
    || type === 'compaction/summary'
}

/** 从 assistant 事件里取出可见文本（不含 reasoning）。 */
function extractAssistantText(event: { data?: unknown }): string {
  const data = event.data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined
  const blocks = data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
    .trim()
}

/** 粗估一个事件的字符数（用于长度建议，不做精确 token 计数）。 */
function estimateChars(event: { data?: unknown }): number {
  try {
    const raw = JSON.stringify(event.data ?? {})
    return raw.length
  } catch {
    return 0
  }
}

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
  /** 是否允许循环自动安排提炼（默认 true）。 */
  autoSummarize?: boolean
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
  const segmentStore = new SegmentStore(store.raw)

  /** 各会话的最新轮次（由 session/event 维护）。 */
  const latestTurns = new Map<string, number>()

  /** 各会话的可见事件缓存（供 memory_spans 计算区间）。 */
  const eventCache = new Map<string, SpanEvent[]>()

  // 这个监听器**不是触发**：它只维护内存里的轮次号与事件摘要，
  // 供 `memory_summarize` / `memory_spans` 读取。
  // 它不索引、不注入上下文、不发消息、不调用任何工具。
  ctx.on('session/event', (session, event) => {
    const sid = (session as unknown as { id?: string }).id
    if (typeof sid !== 'string') return

    type Ev = { type?: string; seq?: number; time?: number; data?: { turn?: number } }
    const ev = event as unknown as Ev

    if (ev.type === 'turn/start') {
      const turn = ev.data?.turn
      if (typeof turn === 'number') {
        latestTurns.set(sid, Math.max(latestTurns.get(sid) ?? 0, turn))
      }
      return
    }

    // 记录事件摘要：seq + turn + 粗估字符数，供区间计算用。
    if (typeof ev.seq === 'number' && isContentEvent(ev.type)) {
      const turn = ev.data?.turn ?? latestTurns.get(sid)
      const list = eventCache.get(sid) ?? []
      list.push({ seq: ev.seq, turn, chars: estimateChars(ev) })
      eventCache.set(sid, list)
    }

    // 记录最近一条 assistant 的**可见文本**——收割提炼结果时要读它。
    // 这是上一版的死代码缺口：只读不写，导致收割永远拿不到内容。
    if (ev.type === 'assistant/message' && typeof ev.seq === 'number') {
      const text = extractAssistantText(ev)
      if (text.length > 0) {
        lastAssistant.set(sid, {
          text,
          seq: ev.seq,
          at: new Date(ev.time ?? Date.now()).toISOString(),
        })
      }
    }
  }, { global: true })

  // ---- 总结循环：由插件在 pre-step 里驱动，不经过工具调用 ----
  const pendingStore = new PendingStore(store.raw)

  /** 各会话最近一条 assistant 回复（供收割用）。 */
  const lastAssistant = new Map<string, AssistantSnapshot>()

  /**
   * pre-step 钩子：每个模型步骤开始前运行。
   *
   * 契约（照官方 dsh-agent-instructions 的用法）：
   *   `(payload, next)` → `await next()` 拿最终 decision → 修改 → 原样返回。
   *
   * 用户要求：「不要让模型自己调 memory_spans / memory_summarize，
   * 按照我说的改变消息循环机制」。
   */
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    // 先让后续监听器跑完，拿到最终决定
    const decision = await next()
    signal.throwIfAborted()

    try {
      const sessionId = (agent.session as { id?: string }).id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return decision

      const action = runLoopStep(sessionId, {
        segments: segmentStore,
        pending: pendingStore,
        latestTurn: (sid) => latestTurns.get(sid) ?? 0,
        eventsOf: (sid) => eventCache.get(sid) ?? [],
        lastAssistant: (sid) => lastAssistant.get(sid),
        apply: (segment) => applySegment(ctx, segment),
        keepTurns: config.keepTurns ?? DEFAULT_KEEP_TURNS,
        autoSummarize: config.autoSummarize ?? true,
        warn: (message) => ctx.logger.warn('memory-plugin: %s', message),
      })

      if (action.kind !== 'injected') return decision
      if (decision.kind === 'reject') return decision

      // 注入：把提炼提示插在本步最后一条已领取消息之后
      // （照官方 dsh-agent-instructions 的做法）
      const prompt = createUserMessage({
        content: [{ type: 'text', text: action.promptText }],
        source: { kind: 'memory-loop-prompt' },
      })
      const lastClaimedIndex = decision.messages.findLastIndex(m => messages.includes(m))
      const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, prompt)
      return { ...decision, messages: entered }
    } catch (error) {
      // 循环失败绝不影响正常对话
      ctx.logger.warn('memory-plugin: loop step failed: %s', String(error))
      return decision
    }
  }, { global: true, prepend: true })

  // 注意：不再注册 memory_spans / memory_summarize 工具。
  // 用户要求改由 pre-step 的消息循环驱动（见上方 pre-step 钩子）。

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
    segments: segmentStore,
    store,
  })
}

/** 释放资源：关闭数据库。 */
export function dispose(ctx: Context): void {
  const memory = (ctx as unknown as { memory?: { store?: MemoryStore } }).memory
  memory?.store?.close()
}
