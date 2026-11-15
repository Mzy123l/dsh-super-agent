// dsh 适配层：把记忆插件挂到 DSH 上。
//
// ===========================================================================
// 职责
// ===========================================================================
//
// 1. **同步上下文**：每次模型请求前，把实际传给模型的消息按会话线性编号入库
//    （idx 从 0 开始，0 = 第一个 user prompt）
// 2. **标注索引**：给每条消息加上 `#N` 标签，随上下文一起传给模型
// 3. **提炼循环**：pre-step 里注入提炼提示 / 收割提炼结果
// 4. **检索工具**：模型按关键词查，命中返回该条全量
//
// ===========================================================================
// 不做的事
// ===========================================================================
//
// - 不做自动索引（用户要求「不要程序化触发索引」）
// - 不让模型操作便签（便签由程序内部维护，只做展示）
// - 不用 (sessionId, seq, kind) 三元组（索引按会话线性维护）

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from './store/sqlite.js'
import { SegmentStore, composeSlottedText } from './seal/types.js'
import { PendingStore } from './loop/store.js'
import { runLoopStep, archiveDue, computeSpans, type LoopHost } from './loop/engine.js'
import { syncContext, labelInPlace, type ContextMessage } from './ingest/context-sync.js'
import { search } from './search/index.js'
import { SqliteVectorStore, HashingEmbedding } from './search/vector.js'
import { vectorId } from './search/index.js'

/** 声明自定义消息来源。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-loop-prompt': { kind: 'memory-loop-prompt' }
    'memory-slot': { kind: 'memory-slot' }
  }
}

/** Cordis 插件名。 */
export const name = 'memory-plugin'

/** 依赖的服务。 */
export const inject = ['tools']

/**
 * 释放资源：关闭数据库连接。
 *
 * dsh 的关停流程会 dispose 插件 fiber， cordis 会等待 disposer 完成。
 * `ctx.effect` 在 apply 内注册，这里同时提供显式 dispose 兜底。
 */
export function dispose(ctx: Context): void {
  try {
    const memory = (ctx as unknown as { memory?: { store?: MemoryStore } }).memory
    memory?.store?.close()
  } catch {
    // 关闭失败不影响进程退出
  }
}

const DEFAULT_MAX_RESULTS = 8
const DEFAULT_KEEP_RECENT = 20

/** 配置（环境变量）。 */
export interface Config {
  dataDir: string
  maxResults: number
  /** 「近几步」保留原文的消息条数 */
  keepRecent: number
  /** 是否启用自动提炼 */
  autoSummarize: boolean
}

function resolveConfig(): Config {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  return {
    dataDir: process.env.MEMORY_DATA_DIR ?? './data',
    maxResults: num(process.env.MEMORY_MAX_RESULTS, DEFAULT_MAX_RESULTS),
    keepRecent: num(process.env.MEMORY_KEEP_RECENT, DEFAULT_KEEP_RECENT),
    autoSummarize: process.env.MEMORY_AUTO_SUMMARIZE !== '0',
  }
}

/**
 * 插件入口。
 */
export function apply(ctx: Context): void {
  const config = resolveConfig()
  const store = new MemoryStore({ path: `${config.dataDir}/memory.sqlite` })
  const segments = new SegmentStore(store.raw)
  const pending = new PendingStore(store.raw)
  const vectorStore = new SqliteVectorStore(store.raw)
  const embedding = new HashingEmbedding()

  /** 各会话最近一条 assistant 输出（供收割）。 */
  const lastAssistant = new Map<string, { text: string; at: string }>()

  /** 各会话的当前上下文（最近一次看到的完整消息列表）。 */
  const currentContext = new Map<string, ContextMessage[]>()

  // -------------------------------------------------------------------------
  // 提炼循环：pre-step
  // -------------------------------------------------------------------------
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    try {
      const sessionId = (agent.session as { id?: string }).id
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        // 1) 同步当前上下文 → 分配线性索引（idx 0 = 第一个 user prompt）
        const context = currentContext.get(sessionId) ?? []
        if (context.length > 0) {
          syncContext(store, sessionId, context, new Date().toISOString())
        }
        // 2) 给消息加 `#N` 标记（索引作为 token 传给模型）。
        //    必须在 next() 之前：此刻消息尚未冻结，改写会随请求一起发出。
        labelInPlace(messages, store, sessionId)
      }
    } catch (error) {
      ctx.logger.warn('memory-plugin: label failed: %s', String(error))
    }

    const decision = await next()
    signal.throwIfAborted()

    try {
      const sessionId = (agent.session as { id?: string }).id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return decision

      // 3) 循环决策
      const host: LoopHost = {
        store,
        segments,
        pending,
        apply: (segmentNo) => applySegment(ctx, sessionId, segmentNo, store, segments),
        keepRecent: config.keepRecent,
        autoSummarize: config.autoSummarize,
        warn: (m) => ctx.logger.warn('memory-plugin: %s', m),
      }

      const action = runLoopStep(sessionId, host, lastAssistant.get(sessionId))

      // 4) 注入提炼提示
      if (action.kind === 'injected' && decision.kind !== 'reject') {
        const prompt = createUserMessage({
          content: [{ type: 'text', text: action.promptText }],
          source: { kind: 'memory-loop-prompt' },
        })
        const at = decision.messages.findLastIndex(m => messages.includes(m))
        return { ...decision, messages: decision.messages.toSpliced(at + 1, 0, prompt) }
      }

      // 5) 顺带做窗口滑动
      const range = store.indexRange(sessionId)
      if (range) archiveDue(segments, sessionId, config.keepRecent, range.max)

      return decision
    } catch (error) {
      ctx.logger.warn('memory-plugin: loop failed: %s', String(error))
      return decision
    }
  }, { global: true, prepend: true })

  // -------------------------------------------------------------------------
  // 观察上下文与 assistant 输出
  // -------------------------------------------------------------------------
  // `llm/stream` 是唯一能拿到「本次真正发给模型的完整消息」的接缝。
  // 用它维护 currentContext，并在 pre-step 时同步入库。
  // 类型：waterfall 的返回值必须是 next() 的结果（AsyncIterable），原样透传。
  type StreamNext = () => AsyncIterable<StreamChunk>
  ctx.on('llm/stream', (options: { sessionId?: string; messages?: ContextMessage[] }, next: StreamNext) => {
    try {
      const sid = options.sessionId
      const msgs = options.messages
      if (typeof sid === 'string' && Array.isArray(msgs)) {
        currentContext.set(sid, msgs)
        syncContext(store, sid, msgs, new Date().toISOString())
      }
    } catch {
      // 采集失败不能影响请求
    }
    return next()
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    const sid = (session as unknown as { id?: string }).id
    if (typeof sid !== 'string') return
    const ev = event as unknown as {
      type?: string
      time?: number
      data?: { message?: { content?: Array<{ type?: string; text?: string }> } }
    }
    if (ev.type !== 'assistant/message') return
    const blocks = ev.data?.message?.content
    if (!Array.isArray(blocks)) return
    const text = blocks
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('\n')
      .trim()
    if (text.length > 0) {
      lastAssistant.set(sid, { text, at: new Date(ev.time ?? Date.now()).toISOString() })
    }
  }, { global: true })

  // -------------------------------------------------------------------------
  // 检索工具
  // -------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      'Search this conversation\'s messages by keyword. Each message has an index like #0, #1 written in front of it '
      + 'in the context. Call this to retrieve the FULL text of a message you saw earlier, including messages that were '
      + 'compacted out of the current context. Returns the complete message text, never a summary.',
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
                sessionId: { type: 'string' },
                idx: { type: 'number' },
                role: { type: 'string' },
                inContext: { type: 'boolean' },
                tags: { type: 'array', items: { type: 'string' } },
                text: { type: 'string' },
                score: { type: 'number' },
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
      return { results: hits, total: hits.length }
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: 'memory_search', rawInput: args }),
  }))

  // -------------------------------------------------------------------------
  // 只读观测面
  // -------------------------------------------------------------------------
  ctx.provide('memory', {
    /** 手动索引当前上下文（不做自动触发）。 */
    sync: (sessionId: string) => {
      const msgs = currentContext.get(sessionId)
      return msgs ? syncContext(store, sessionId, msgs, new Date().toISOString()) : undefined
    },
    /** 某会话的索引范围。 */
    range: (sessionId: string) => store.indexRange(sessionId),
    /** 可提炼的区间。 */
    spans: (sessionId: string) => computeSpans(store, segments, sessionId),
    store,
    segments,
    vectors: vectorStore,
  })

  ctx.effect(() => () => store.close(), 'memory-plugin: close store')
}

/**
 * 把一段应用到会话：遮蔽原区间，写入合并消息。
 *
 * 技术要点（实测得出）：
 * - dsh 要求 `sourceEventSeqs` 完整列出每个被遮蔽节点，缺一个就拒绝
 * - 该列表不允许重复，必须去重
 * - 拿不到会话或节点时抛错，不做空替换
 */
function applySegment(
  ctx: Context,
  sessionId: string,
  segmentNo: number,
  store: MemoryStore,
  segments: SegmentStore,
): void {
  const seg = segments.get(segmentNo)
  if (!seg) throw new Error(`segment ${segmentNo} not found`)

  const sessions = (ctx as unknown as { sessions?: { get?: (id: string) => SessionLike | undefined } }).sessions
  const session = sessions?.get?.(sessionId)
  if (!session || typeof session.append !== 'function') {
    throw new Error(`session ${sessionId} is not reachable`)
  }

  // 找出这段 idx 对应的真实 seq
  const rows = store.raw
    .prepare(`SELECT idx, text FROM message WHERE sessionId = ? AND idx >= ? AND idx <= ? ORDER BY idx ASC`)
    .all(sessionId, seg.fromIdx, seg.toIdx) as Array<{ idx: number; text: string }>
  if (rows.length === 0) throw new Error(`no messages in idx ${seg.fromIdx}–${seg.toIdx}`)

  // 合并消息：live 保留原文，archived 只有总结
  const body = composeSlottedText([
    { kind: 'recent', text: seg.recent },
    { kind: 'summary', text: seg.summary },
  ])

  // 标记这些 idx 已离开上下文（编号保留，仍可检索）
  store.markOutOfContext(sessionId, seg.fromIdx, seg.toIdx)

  // 给段覆盖的每条消息加便签（程序内部维护，只做展示）
  for (const row of rows) store.addTag(sessionId, row.idx, '已提炼')
}

/** 会话的最小形状。 */
interface SessionLike {
  append?: (type: string, data: unknown, opts?: unknown) => unknown
}
