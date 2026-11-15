// dsh 适配层：把记忆插件挂到 DSH 上。
//
// 职责（见 docs/A7-memory-design-final.md）：
// 1. 同步单位：从 llm/stream 拿实际发送消息 → 提取单位 → 线性编号入库
// 2. 总结：pre-step 检测长单位 → 注入英文提炼指令 → 收割模型回复 → 挂接 summary
// 3. 发送投影：近程 summary+content，远程只发 summary（不改库）
// 4. 检索：memory_search 返回单位全量
//
// 不做：自动索引触发、总结类工具、压缩（后续单独设计）、dsh 自带压缩。

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from './store/sqlite.js'
import { PendingStore } from './summary/pending.js'
import { runSummaryStep, SUMMARY_THRESHOLD, type SummaryHost } from './summary/flow.js'
import { extractUnits } from './ingest/units.js'
import { renderUnits, DEFAULT_WINDOW, type RenderOptions } from './projection/render.js'
import { search } from './search/index.js'
import { SqliteVectorStore, HashingEmbedding } from './search/vector.js'
import { vectorId } from './search/index.js'
import type { ContextMessage, Unit } from './types.js'

/** 声明自定义消息来源。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-summary-prompt': { kind: 'memory-summary-prompt' }
  }
}

/** Cordis 插件名。 */
export const name = 'memory-plugin'

/** 依赖的服务。 */
export const inject = ['tools']

const DEFAULT_MAX_RESULTS = 8

/** 配置。 */
export interface Config {
  dataDir: string
  maxResults: number
  /** 近程窗口（单位数量，完全不用 token） */
  window: number
  /** 长单位阈值（字符数） */
  threshold: number
  /** 是否启用自动总结 */
  autoSummary: boolean
}

function resolveConfig(): Config {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  return {
    dataDir: process.env.MEMORY_DATA_DIR ?? './data',
    maxResults: num(process.env.MEMORY_MAX_RESULTS, DEFAULT_MAX_RESULTS),
    window: num(process.env.MEMORY_WINDOW, DEFAULT_WINDOW),
    threshold: num(process.env.MEMORY_SUMMARY_THRESHOLD, SUMMARY_THRESHOLD),
    autoSummary: process.env.MEMORY_AUTO_SUMMARY !== '0',
  }
}

/** 释放资源。 */
export function dispose(ctx: Context): void {
  try {
    ((ctx as unknown as { memory?: { store?: MemoryStore } }).memory)?.store?.close()
  } catch {
    // 关闭失败不影响退出
  }
}

/**
 * 插件入口。
 */
export function apply(ctx: Context): void {
  const config = resolveConfig()
  const store = new MemoryStore({ path: `${config.dataDir}/memory.sqlite` })
  const pending = new PendingStore(store.raw)
  const vectorStore = new SqliteVectorStore(store.raw)
  const embedding = new HashingEmbedding()

  /** 各会话最近一条 assistant 可见文本与时刻（供收割）。 */
  const lastAssistant = new Map<string, { text: string; at: string }>()

  /** 各会话最近一次看到的完整上下文（llm/stream 捕获）。 */
  const currentContext = new Map<string, ContextMessage[]>()

  /** 该会话最近产出的单位（用于注入指令时引用编号）。 */
  const lastUnits = new Map<string, number[]>()

  // -------------------------------------------------------------------------
  // 观察：llm/stream 拿到实际发送消息 → 提取单位 → 入库编号
  // -------------------------------------------------------------------------
  type StreamNext = () => AsyncIterable<StreamChunk>
  ctx.on('llm/stream', (options: { sessionId?: string; messages?: ContextMessage[] }, next: StreamNext) => {
    try {
      const sid = options.sessionId
      const msgs = options.messages
      if (typeof sid === 'string' && Array.isArray(msgs)) {
        currentContext.set(sid, msgs)
        syncUnits(store, sid, msgs, lastUnits, (t) => pending.isConsumedReply(sid, t))
      }
    } catch (error) {
      ctx.logger.warn('memory-plugin: sync failed: %s', String(error))
    }
    return next()
  }, { global: true })

  // -------------------------------------------------------------------------
  // 观察：assistant 输出（供总结收割）
  // -------------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const sid = (session as unknown as { id?: string }).id
    if (typeof sid !== 'string') return
    const ev = event as unknown as {
      type?: string
      time?: number
      data?: { message?: { content?: Array<{ type?: string; text?: string }> } }
    }
    if (ev.type !== 'assistant/message') return
    const content = ev.data?.message?.content
    if (!Array.isArray(content)) return
    const text = content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('\n')
      .trim()
    if (text.length === 0) return
    lastAssistant.set(sid, { text, at: new Date(ev.time ?? Date.now()).toISOString() })
  }, { global: true })

  // -------------------------------------------------------------------------
  // 总结流程 + 发送投影：pre-step
  // -------------------------------------------------------------------------
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    signal.throwIfAborted()

    try {
      const sessionId = (agent.session as { id?: string }).id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return decision
      if (decision.kind === 'reject') return decision

      // 1) 总结流程：先收割上一轮回复，再决定是否注入新指令
      if (config.autoSummary) {
        const host: SummaryHost = {
          store,
          pending,
          lastAssistantText: (sid) => lastAssistant.get(sid)?.text,
          lastAssistantAt: (sid) => lastAssistant.get(sid)?.at,
          threshold: config.threshold,
          warn: (m) => ctx.logger.warn('memory-plugin: %s', m),
        }
        const action = runSummaryStep(sessionId, host)

        if (action.kind === 'inject') {
          // 注入英文提炼指令（只出现一次）
          const prompt = createUserMessage({
            content: [{ type: 'text', text: action.promptText }],
            source: { kind: 'memory-summary-prompt' },
          })
          const at = decision.messages.findLastIndex(m => messages.includes(m))
          return { ...decision, messages: decision.messages.toSpliced(at + 1, 0, prompt) }
        }
      }

      return decision
    } catch (error) {
      ctx.logger.warn('memory-plugin: pre-step failed: %s', String(error))
      return decision
    }
  }, { global: true, prepend: true })

  // -------------------------------------------------------------------------
  // 检索工具
  // -------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      'Search this conversation by keyword and get the FULL text of the matching units back. '
      + 'Each unit in your context is labelled #0, #1, #2 and so on. Older units are shown only as their '
      + 'summary; call this to read the complete original content of any unit, including units that are '
      + 'no longer in the context. Returns complete text, never a truncated version.',
    parameters: {
      query: { type: 'string', description: 'Text to search for. Keywords work best.' },
      limit: { type: 'number', description: 'Maximum results (default 8).' },
      session: { type: 'string', description: 'Limit to one session id. Omit to search the current session.' },
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
                idx: { type: 'number' },
                kind: { type: 'string' },
                summary: { type: 'string' },
                content: { type: 'string' },
                inContext: { type: 'boolean' },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          total: { type: 'number', required: true },
        },
      },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args: { query?: string; limit?: number; session?: string }, exec: { agent?: { session?: { id?: string } } }) {
      const sessionId = args.session ?? exec.agent?.session?.id
      const hits = await search(
        { store, vectorStore, embedding },
        String(args.query ?? ''),
        { limit: typeof args.limit === 'number' ? args.limit : config.maxResults, sessionId },
      )
      return {
        results: hits.map(h => ({
          idx: h.idx,
          kind: h.kind,
          summary: h.summary,
          content: h.content,
          inContext: h.inContext,
          tags: h.tags,
        })),
        total: hits.length,
      }
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: 'memory_search', rawInput: args }),
  }))

  // -------------------------------------------------------------------------
  // 只读观测面
  // -------------------------------------------------------------------------
  ctx.provide('memory', {
    /** 手动同步某会话的当前上下文（无自动触发）。 */
    sync: (sessionId: string) => {
      const msgs = currentContext.get(sessionId)
      return msgs ? syncUnits(store, sessionId, msgs, lastUnits, (t) => pending.isConsumedReply(sessionId, t)) : undefined
    },
    /** 某会话的编号范围。 */
    range: (sessionId: string) => store.indexRange(sessionId),
    /** 渲染某会话的发送视图（诊断）。 */
    render: (sessionId: string, opts: RenderOptions = {}) => {
      const range = store.indexRange(sessionId)
      if (!range) return []
      return renderUnits(store.listRange(sessionId, range.min, range.max), {
        window: opts.window ?? config.window,
        latestIdx: range.max,
      })
    },
    /** 最近产出的单位编号。 */
    lastUnits: (sessionId: string) => lastUnits.get(sessionId) ?? [],
    store,
    vectors: vectorStore,
  })

  ctx.effect(() => () => store.close(), 'memory-plugin: close store')
}

/**
 * 同步单位到库：提取 → 追加（幂等复用编号）。
 *
 * @returns 本次的单位编号列表。
 */
export function syncUnits(
  store: MemoryStore,
  sessionId: string,
  messages: readonly ContextMessage[],
  cache?: Map<string, number[]>,
  isConsumedReply?: (text: string) => boolean,
): number[] {
  const at = new Date().toISOString()
  const units = extractUnits(messages, at, sessionId, isConsumedReply)
  const idxs: number[] = []

  for (const unit of units) {
    const idx = store.appendUnit(unit)
    idxs.push(idx)
  }

  // 本次没出现的编号 → 标记已离开上下文（编号保留）
  if (idxs.length > 0) {
    const maxIdx = Math.max(...idxs)
    const present = new Set(idxs)
    for (let i = 0; i <= maxIdx; i += 1) {
      if (!present.has(i)) store.markOutOfContext(sessionId, i)
    }
  }

  cache?.set(sessionId, idxs)
  store.setMeta('lastIndexedAt', at)
  return idxs
}

/** 供外部使用：渲染某会话的发送文本。 */
export function renderSession(store: MemoryStore, sessionId: string, window: number): string[] {
  const range = store.indexRange(sessionId)
  if (!range) return []
  const units = store.listRange(sessionId, range.min, range.max) as Unit[]
  return renderUnits(units, { window, latestIdx: range.max })
}

export { vectorId }
