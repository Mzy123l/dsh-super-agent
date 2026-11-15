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
import { applyProjection } from './projection/executor.js'
import { MemoryRenderCache } from './projection/apply.js'
import type { SeqReader } from './projection/seqmap.js'
import type { SurfaceWriter } from './projection/executor.js'
import { search } from './search/index.js'
import { SqliteVectorStore, HashingEmbedding } from './search/vector.js'
import { vectorId } from './search/index.js'
import type { ContextMessage, Unit, UnitResult } from './types.js'

// 四个模块
import { FoldStore, expandLevel1, expandLevel2 } from './fold/store.js'
import type { Fold } from './types-modules.js'
import { TodoStore, renderTodoList } from './todo/store.js'
import { OverrideStore, renderOverrideHistory } from './override/store.js'
import { PlanStore, checkPlanName, renderPlan } from './plan/store.js'
import type { PlanStep } from './types-modules.js'

/** 从 JSON 字符串解析步骤数组（容错）。 */
function parseSteps(raw: string | undefined): PlanStep[] {
  if (raw === undefined || raw.trim().length === 0) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((s): s is PlanStep =>
      s !== null && typeof s === 'object' && typeof s.id === 'string' && typeof s.text === 'string',
    ).map(s => ({
      id: s.id,
      text: s.text,
      status: s.status ?? 'pending',
      weight: typeof s.weight === 'number' ? s.weight : 1.0,
      ...(typeof s.note === 'string' ? { note: s.note } : {}),
    }))
  } catch {
    return []
  }
}

/** 声明自定义消息来源。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-summary-prompt': { kind: 'memory-summary-prompt' }
    'memory-plan-view': { kind: 'memory-plan-view' }
    'memory-projection': { kind: 'memory-projection' }
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

  // 四个模块的仓储（共用同一 SQLite 连接）
  const folds = new FoldStore(store.raw)
  const todos = new TodoStore(store.raw)
  const overrides = new OverrideStore(store.raw)
  const plans = new PlanStore(store.raw)
  /** 已写入 surface 的渲染缓存（避免重复 append） */
  const renderCache = new MemoryRenderCache()

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
        syncUnits(
          store, sid, msgs, lastUnits,
          (t) => pending.isConsumedReply(sid, t),
          pending.get(sid) !== undefined,
        )
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

      // 2) 发送投影：把单位状态写进 surface（#N / summary / 窗口取舍）
      const sessions = (ctx as unknown as { sessions?: { get?: (id: string) => unknown } }).sessions
      const session = sessions?.get?.(sessionId) as SurfaceWriter | undefined
      if (session && typeof session.eventAt === 'function') {
        applyProjection(ctx, sessionId, session, store, config.window, renderCache, folds)
      }

      // 3) 规划注入：当前计划以紧凑视图进入发送上下文
      const plan = plans.get(sessionId)
      if (plan && plan.status === 'active' && plan.steps.length > 0) {
        const planText = renderPlan(plan)
        const planMsg = createUserMessage({
          content: [{ type: 'text', text: planText }],
          source: { kind: 'memory-plan-view' },
        })
        const at = decision.messages.findLastIndex(m => messages.includes(m))
        return { ...decision, messages: decision.messages.toSpliced(at + 1, 0, planMsg) }
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
  // memory_expand：严格两级展开
  // -------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'memory_expand',
    description:
      'Expand a folded span. Two levels only: call with from/to to get the per-unit summaries (level 1); '
      + 'then call with a single idx to read that unit\'s full original text (level 2). '
      + 'You cannot jump straight to full text — read the summaries first and decide where to dig.',
    parameters: {
      from: { type: 'number', description: 'First unit index of the fold (level 1).' },
      to: { type: 'number', description: 'Last unit index of the fold (level 1).' },
      idx: { type: 'number', description: 'Single unit index to read in full (level 2).' },
      session: { type: 'string', description: 'Session id; defaults to the current session.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          level: { type: 'number', required: true },
          fromIdx: { type: 'number' },
          toIdx: { type: 'number' },
          foldSummary: { type: 'string' },
          units: { type: 'string' },
          idx: { type: 'number' },
          kind: { type: 'string' },
          summary: { type: 'string' },
          content: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args: { from?: number; to?: number; idx?: number; session?: string }, exec: { agent?: { session?: { id?: string } } }) {
      const sessionId = args.session ?? exec.agent?.session?.id
      if (typeof sessionId !== 'string') return { level: 1, error: 'no session' }

      // 第二级：单个单位的原文
      if (typeof args.idx === 'number' && args.from === undefined) {
        const unit = store.getUnit(sessionId, args.idx)
        if (!unit) return { level: 2, error: `no unit #${args.idx}` }
        return expandLevel2(unit)
      }

      // 第一级：折叠体 → 各单位 summary
      if (typeof args.from === 'number' && typeof args.to === 'number') {
        const fold = folds.findByUnit(sessionId, args.from)
        const units = store.listRange(sessionId, args.from, args.to)
        if (units.length === 0) return { level: 1, error: `no units in #${args.from}–#${args.to}` }
        const view: Fold = fold ?? {
          foldNo: 0, sessionId, fromIdx: args.from, toIdx: args.to,
          foldSummary: '（未折叠区间）', trigger: 'manual', name: '', createdAt: '',
        }
        const base = expandLevel1(units, view)
        return { ...base, units: JSON.stringify(base.units) }
      }
      return { level: 1, error: 'give from+to for level 1, or idx for level 2' }
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: 'memory_expand', rawInput: args }),
  }))

  // -------------------------------------------------------------------------
  // memory_todo：待办台账
  // -------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'memory_todo',
    description:
      'Manage the deferred-task ledger. Use action "list" when the user asks what is still left to do '
      + '(no keyword needed — it returns every open item). Use "add" when the user says to defer something, '
      + '"done" when finished, "drop" when abandoned.',
    parameters: {
      action: { type: 'string', description: 'list | add | done | drop | reopen' },
      title: { type: 'string', description: 'For add: one-line what to do later.' },
      detail: { type: 'string', description: 'For add: why, constraints, acceptance criteria.' },
      no: { type: 'number', description: 'For done/drop/reopen: the todo number.' },
      reason: { type: 'string', description: 'For drop: why it is abandoned.' },
      all: { type: 'boolean', description: 'For list: include done and dropped.' },
      session: { type: 'string', description: 'Session id; defaults to current.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rendered: { type: 'string' },
          items: { type: 'string' },
          open: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args: { action?: string; title?: string; detail?: string; no?: number; reason?: string; all?: boolean; session?: string }, exec: { agent?: { session?: { id?: string } } }) {
      const sessionId = args.session ?? exec.agent?.session?.id
      if (typeof sessionId !== 'string') return { ok: false, error: 'no session' }
      const action = args.action ?? 'list'

      if (action === 'list') {
        const items = todos.list(sessionId, args.all === true ? 'all' : 'open')
        const stats = todos.stats(sessionId)
        return { ok: true, rendered: renderTodoList(items), items: JSON.stringify(items), open: stats.open }
      }

      if (action === 'add') {
        const title = (args.title ?? '').trim()
        if (title.length === 0) return { ok: false, error: 'title is required' }
        const no = todos.add({ sessionId, title, detail: args.detail ?? '', fromIdx: undefined })
        return { ok: true, rendered: `已登记待办 #${no}：${title}`, open: todos.stats(sessionId).open }
      }

      const no = args.no
      if (typeof no !== 'number') return { ok: false, error: 'no is required' }

      if (action === 'done') {
        const ok = todos.done(sessionId, no)
        return ok ? { ok: true, rendered: `待办 #${no} 已完成`, open: todos.stats(sessionId).open } : { ok: false, error: `no todo #${no}` }
      }
      if (action === 'drop') {
        const ok = todos.drop(sessionId, no, args.reason ?? '')
        return ok ? { ok: true, rendered: `待办 #${no} 已放弃` } : { ok: false, error: `no todo #${no}` }
      }
      if (action === 'reopen') {
        const ok = todos.reopen(sessionId, no)
        return ok ? { ok: true, rendered: `待办 #${no} 已恢复` } : { ok: false, error: `no todo #${no}` }
      }

      return { ok: false, error: `unknown action ${action}` }
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: 'memory_todo', rawInput: args }),
  }))

  // -------------------------------------------------------------------------
  // memory_override：覆写 summary（L0 不动）
  // -------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'memory_override',
    description:
      'Override the summary of a unit when the user contradicts an earlier conclusion — either correcting '
      + 'themselves or admitting the model was right. Only the summary changes; the original text is kept intact. '
      + 'Use action "history" to see past overrides.',
    parameters: {
      action: { type: 'string', description: 'apply | history' },
      idx: { type: 'number', description: 'Target unit index.' },
      summary: { type: 'string', description: 'For apply: the corrected summary.' },
      reason: { type: 'string', description: 'For apply: why it is overridden.' },
      by_user: { type: 'boolean', description: 'For apply: true if the user overrode themselves; false if the user admitted the model was right.' },
      session: { type: 'string', description: 'Session id; defaults to current.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rendered: { type: 'string' },
          records: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args: { action?: string; idx?: number; summary?: string; reason?: string; by_user?: boolean; session?: string }, exec: { agent?: { session?: { id?: string } } }) {
      const sessionId = args.session ?? exec.agent?.session?.id
      if (typeof sessionId !== 'string') return { ok: false, error: 'no session' }
      const action = args.action ?? 'apply'

      if (action === 'history') {
        const records = args.idx !== undefined
          ? overrides.historyOf(sessionId, args.idx)
          : overrides.list(sessionId)
        return { ok: true, rendered: renderOverrideHistory(records), records: JSON.stringify(records) }
      }

      if (typeof args.idx !== 'number') return { ok: false, error: 'idx is required' }
      const summary = (args.summary ?? '').trim()
      if (summary.length === 0) return { ok: false, error: 'summary is required' }

      const no = overrides.apply({
        sessionId,
        targetIdx: args.idx,
        newSummary: summary,
        reason: args.reason ?? '',
        byUser: args.by_user,
      })
      if (no === undefined) return { ok: false, error: `no unit #${args.idx}` }
      return { ok: true, rendered: `已覆写 #${args.idx} 的 summary（记录 #${no}），原文未改动` }
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: 'memory_override', rawInput: args }),
  }))

  // -------------------------------------------------------------------------
  // memory_plan：规划（每次写操作必须带版本名）
  // -------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'memory_plan',
    description:
      'Manage the plan: WHAT the goal is and HOW you intend to achieve it (architecture, order, dependencies). '
      + 'This is not the todo ledger. '
      + 'Every write action REQUIRES a `name` (1-60 chars) describing what changed in this version, like a commit message. '
      + 'Actions: create | update | extend | step | decision | history | show | revert. '
      + 'Completed steps are never discarded — every change produces a new version.',
    parameters: {
      action: { type: 'string', description: 'create | update | extend | step | decision | history | show | revert' },
      name: { type: 'string', description: 'Version name (REQUIRED for every write). 1-60 chars describing this change.' },
      goal: { type: 'string', description: 'For create: what counts as success.' },
      estimate_min: { type: 'number', description: 'For create: your estimate of minutes to finish.' },
      steps: { type: 'string', description: 'For create/update/extend: JSON array of {id,text,status,weight}.' },
      step_id: { type: 'string', description: 'For step: which step id.' },
      status: { type: 'string', description: 'For step: pending|in_progress|done|blocked|dropped.' },
      note: { type: 'string', description: 'For step: optional note.' },
      decision: { type: 'string', description: 'For decision: what was decided.' },
      decision_reason: { type: 'string', description: 'For decision: why.' },
      decision_id: { type: 'string', description: 'For decision: id (reuse to supersede).' },
      version: { type: 'number', description: 'For show/revert: target version.' },
      reason: { type: 'string', description: 'Why this change happened.' },
      session: { type: 'string', description: 'Session id; defaults to current.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          version: { type: 'number' },
          rendered: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: unknown) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args: {
      action?: string; name?: string; goal?: string; estimate_min?: number; steps?: string
      step_id?: string; status?: string; note?: string
      decision?: string; decision_reason?: string; decision_id?: string
      version?: number; reason?: string; session?: string
    }, exec: { agent?: { session?: { id?: string } } }) {
      const sessionId = args.session ?? exec.agent?.session?.id
      if (typeof sessionId !== 'string') return { ok: false, error: 'no session' }
      const action = args.action ?? 'show'

      if (action === 'history') {
        const h = plans.history(sessionId)
        if (h.length === 0) return { ok: true, rendered: '（没有规划）' }
        const lines = h.map(v => `v${v.version}「${v.name}」 ${v.changeKind} — ${v.reason}`)
        return { ok: true, rendered: lines.join('\n') }
      }

      if (action === 'show') {
        if (typeof args.version === 'number') {
          const v = plans.version(sessionId, args.version)
          if (!v) return { ok: false, error: `no version ${args.version}` }
          return { ok: true, version: v.version, rendered: `v${v.version}「${v.name}」\n${v.snapshot}` }
        }
        const p = plans.get(sessionId)
        if (!p) return { ok: true, rendered: '（没有规划）' }
        return { ok: true, version: p.version, rendered: renderPlan(p) }
      }

      // 以下都是写操作：先校验版本名
      const nameCheck = checkPlanName(args.name)
      if (!nameCheck.ok) return { ok: false, error: nameCheck.error }

      if (action === 'create') {
        const goal = (args.goal ?? '').trim()
        if (goal.length === 0) return { ok: false, error: 'goal is required' }
        const steps = parseSteps(args.steps)
        const r = plans.create({
          sessionId,
          name: args.name as string,
          goal,
          estimateMin: args.estimate_min,
          steps,
        })
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, version: r.version, rendered: `已创建计划 v${r.version}「${args.name}」` }
      }

      if (action === 'extend') {
        const steps = parseSteps(args.steps)
        if (steps.length === 0) return { ok: false, error: 'steps is required for extend' }
        const r = plans.extend({
          sessionId,
          name: args.name as string,
          reason: args.reason,
          newSteps: steps,
        })
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, version: r.version, rendered: `已扩展计划到 v${r.version}（前面削弱、新步骤拉满）` }
      }

      if (action === 'step') {
        if (typeof args.step_id !== 'string') return { ok: false, error: 'step_id is required' }
        const r = plans.setStep({
          sessionId,
          stepId: args.step_id,
          status: (args.status ?? 'done') as PlanStep['status'],
          name: args.name as string,
          note: args.note,
        })
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, version: r.version, rendered: `步骤 ${args.step_id} → ${args.status}（v${r.version}）` }
      }

      if (action === 'decision') {
        if (typeof args.decision_id !== 'string') return { ok: false, error: 'decision_id is required' }
        const r = plans.setDecision({
          sessionId,
          name: args.name as string,
          decision: {
            id: args.decision_id,
            decision: args.decision ?? '',
            reason: args.decision_reason ?? '',
            status: 'active',
          },
        })
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, version: r.version, rendered: `已记录决策 ${args.decision_id}（v${r.version}）` }
      }

      if (action === 'revert') {
        if (typeof args.version !== 'number') return { ok: false, error: 'version is required for revert' }
        const r = plans.revert({
          sessionId,
          targetVersion: args.version,
          name: args.name as string,
          reason: args.reason,
        })
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, version: r.version, rendered: `已回滚到 v${args.version}，产生 v${r.version}（旧版本保留）` }
      }

      if (action === 'update') {
        const r = plans.update({
          sessionId,
          name: args.name as string,
          reason: args.reason,
          changeKind: 'revise',
          steps: args.steps !== undefined ? parseSteps(args.steps) : undefined,
          goal: args.goal,
          estimateMin: args.estimate_min,
        })
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, version: r.version, rendered: `计划更新到 v${r.version}「${args.name}」` }
      }

      return { ok: false, error: `unknown action ${action}` }
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: 'memory_plan', rawInput: args }),
  }))

  // -------------------------------------------------------------------------
  // 只读观测面
  // -------------------------------------------------------------------------
  ctx.provide('memory', {
    /** 手动同步某会话的当前上下文（无自动触发）。 */
    sync: (sessionId: string) => {
      const msgs = currentContext.get(sessionId)
      return msgs
        ? syncUnits(
            store, sessionId, msgs, lastUnits,
            (t) => pending.isConsumedReply(sessionId, t),
            pending.get(sessionId) !== undefined,
          )
        : undefined
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
  summaryInFlight?: boolean,
  window?: number,
): number[] {
  const at = new Date().toISOString()
  const units = extractUnits(messages, at, sessionId, isConsumedReply, summaryInFlight)
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

  // 近程窗口内的单位全量进关键词索引；滑出窗口的主动降级
  store.refreshIndexTiers(sessionId, window ?? DEFAULT_WINDOW)

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
