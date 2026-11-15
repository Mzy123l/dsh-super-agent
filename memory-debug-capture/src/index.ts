/**
 * memory-debug-capture：DSH 调试采集插件。
 *
 * **捕获点（同一请求抓两次）**：
 *
 * | 相位 | 时机 | 拿什么 |
 * | --- | --- | --- |
 * | `before` | `agent/pre-step`（**最外层**监听器） | 此刻将要进入本步的完整上下文 |
 * | `after` | `llm/stream` | 最终发出的 messages |
 *
 * 两栏来自**同一个请求**（同一个 `(sessionId, turn, step)`），用 `requestKey` 配对。
 * 「记忆机制介入前 vs 介入后」的差异，就体现在这两栏之间。
 *
 * **before 版的算法**：**after − 本步新增**（见 `before.ts`）。
 *
 * 为什么不用「pre-step 时刻的派生历史」直接当 before：dsh 的系统提示词是在
 * pre-step **之后**才投影进 surface 的（`agent.ts:459-467`），所以那一刻的
 * 派生历史里**没有**本步的系统提示词。直接用它会让 before/after 的差异
 * 变成「系统提示词的噪声」，而不是记忆机制真正注入的东西。
 *
 * 「本步新增」= after 里有、而 pre-step 时刻的历史里没有的消息，并且
 * **不是** dsh 自有的系统提示词（`source.kind === 'system-prompt'`）。
 * 消息身份用 dsh 的 `Message.id` 匹配，所以不会误删同内容的历史消息。
 *
 * **只读 dsh**：本插件不 import 任何 `@deepseek-ai/dsh-*` 包，运行时不依赖 dsh
 * 包，只用 `ctx` 上暴露的事件与服务；`@deepseek-ai/cordis` 仅用于 `import type`。
 *
 * **不改变模型行为**：只旁路观测，不注入上下文、不改请求、不拦截。
 */

import type { Context } from '@deepseek-ai/cordis'
import { computeStepAdditions, subtractAdditions } from './before.js'
import {
  buildRequestKey,
  captureRequest,
  isConversationRequest,
  type CaptureRequest,
} from './capture.js'
import type { SourceMessage } from './serialize.js'
import type { CaptureRecord } from './types.js'
import { JsonlWriter } from './writer.js'
// 引入这个文件是为了把 `llm/stream`、`session/event`、`agent/pre-step` 的类型合并进 cordis 的 Events。
import type {
  LlmStreamNext,
  LlmStreamOptions,
  PreStepDecision,
  PreStepPayload,
  SessionEventLike,
  SessionLike,
} from './dsh-events.js'

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'memory-debug-capture'

/** 插件配置；全部可由环境变量覆盖。 */
export interface Config {
  /** 输出目录；默认 `./captures/`。 */
  outDir?: string
  /** A/B 变体标记：`on` 或 `off`；默认 `off`。 */
  variant?: string
  /** 本轮 run 的标识；默认 `run-unknown`。 */
  runId?: string
  /** 单条消息文本的字符上限；`undefined` / 0 表示不截断。 */
  maxChars?: number
  /** 输出文件名；默认 `capture-<runId>.jsonl`。 */
  fileName?: string
}

/** 环境变量名。 */
const ENV = {
  outDir: 'MEMORY_DEBUG_OUT',
  variant: 'MEMORY_DEBUG_VARIANT',
  runId: 'MEMORY_DEBUG_RUN_ID',
  maxChars: 'MEMORY_DEBUG_MAX_CHARS',
} as const

/** 合法变体值。 */
const VARIANTS = new Set(['on', 'off'])

/**
 * 解析变体标记：只接受 `on` / `off`（大小写不敏感），其它一律 `off`。
 *
 * @param value - 原始值。
 * @returns 归一化后的变体。
 */
export function normalizeVariant(value: string | undefined): string {
  if (value === undefined) return 'off'
  const lowered = value.trim().toLowerCase()
  return VARIANTS.has(lowered) ? lowered : 'off'
}

/**
 * 解析正整数上限；非法值返回 undefined（不截断）。
 *
 * @param value - 原始值。
 * @returns 上限或 undefined。
 */
export function parseMaxChars(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

/**
 * 合并插件配置与环境变量。**环境变量优先**（A/B 实测靠环境变量切换）。
 *
 * @param config - 插件配置。
 * @param env - 环境变量（默认 `process.env`）。
 * @returns 生效配置。
 */
export function resolveConfig(config: Config, env: NodeJS.ProcessEnv = process.env): Required<Omit<Config, 'maxChars'>> & { maxChars?: number } {
  const runId = env[ENV.runId] ?? config.runId ?? 'run-unknown'
  return {
    outDir: env[ENV.outDir] ?? config.outDir ?? './captures/',
    variant: normalizeVariant(env[ENV.variant] ?? config.variant),
    runId,
    maxChars: parseMaxChars(env[ENV.maxChars]) ?? config.maxChars,
    fileName: config.fileName ?? `capture-${sanitizeFileName(runId)}.jsonl`,
  }
}

/** 把 runId 里的路径分隔符换掉，保证能当文件名用。 */
function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_')
}

/** 每个会话的当前轮/步。 */
interface SessionPosition {
  turn: number
  step: number
}

/**
 * 一个请求的 before 版上下文快照（来自 `agent/pre-step`）。
 */
interface BeforeSnapshot {
  /** 配对键。 */
  requestKey: string
  /** 轮号。 */
  turn: number
  /** 步号。 */
  step: number
  /**
   * pre-step 时刻的派生历史（**不含**本步的消息，也不含本步的系统提示词）。
   *
   * 它是 before 版的**基线**：用来判断 after 里的哪些消息是「本步新增」。
   */
  history: readonly SourceMessage[]
  /** 本步将进入的消息批次（用于识别本步新增）。 */
  stepMessages: readonly SourceMessage[]
  /** 是否已经为这个 step 写过 before 行（重试时不再重复写）。 */
  consumed: boolean
}

/**
 * 采集器：挂 `agent/pre-step` 与 `llm/stream` 两个 waterfall，
 * 把同一请求的 before / after 两栏推进写队列。
 *
 * 与官方先例的差别只有一处：官方先例是**同步**返回 `next()`；本插件额外把
 * 序列化放进微任务里，保证不占用请求路径的时间，但**顺序仍然严格**——
 * 微任务队列是 FIFO，且 `enqueue()` 在微任务里同步执行。
 */
export class CaptureCollector {
  /** 写器。 */
  private readonly writer: JsonlWriter
  /** 生效配置。 */
  private readonly config: ReturnType<typeof resolveConfig>
  /** 每个会话的当前轮/步（由会话事件维护）。 */
  private readonly positions = new Map<string, SessionPosition>()
  /** 每个会话最近一次 pre-step 的 before 快照（按配对键索引）。 */
  private readonly befores = new Map<string, BeforeSnapshot>()
  /** 已采集的 after 行数。 */
  private captured = 0
  /** 已采集的 before 行数。 */
  private beforeCaptured = 0
  /** 跳过的辅助调用数。 */
  private skipped = 0

  constructor(config: ReturnType<typeof resolveConfig>, writer: JsonlWriter) {
    this.config = config
    this.writer = writer
  }

  /** 已采集的 after 行数。 */
  get count(): number {
    return this.captured
  }

  /** 已采集的 before 行数。 */
  get beforeCount(): number {
    return this.beforeCaptured
  }

  /** 跳过的辅助调用数。 */
  get skippedCount(): number {
    return this.skipped
  }

  /** 写器（外部读取统计用）。 */
  get output(): JsonlWriter {
    return this.writer
  }

  /**
   * 记录会话事件里的轮/步边界。
   *
   * `turn/start` 打开一轮，`step/start` 打开一步。dsh 的步号**在每轮内重置**，
   * 所以 `(turn, step)` 才是全局唯一的步标识。
   *
   * @param sessionId - 会话 id。
   * @param event - 会话事件。
   */
  observeSessionEvent(sessionId: string, event: { type: string, data?: unknown }): void {
    if (event.type !== 'turn/start' && event.type !== 'step/start') return
    const data = event.data as { turn?: number, step?: number } | undefined
    if (data === undefined || typeof data.turn !== 'number') return
    const current = this.positions.get(sessionId)
    if (event.type === 'turn/start') {
      this.positions.set(sessionId, { turn: data.turn, step: current?.step ?? 0 })
      return
    }
    if (typeof data.step !== 'number') return
    this.positions.set(sessionId, { turn: data.turn, step: data.step })
  }

  /**
   * 处理 `agent/pre-step`：记住「记忆机制介入之前」的基线上下文。
   *
   * 时序（已核实，dsh-agent-loop/src/agent.ts）：
   * `preStep()` → waterfall `agent/pre-step` → 提交 system/message 与 user/message
   * → `step/start` → `buildRequest()` → `llm/stream`。
   *
   * 所以在 pre-step 里调用 `session.deriveMessages()` 得到的**不含本步的消息**，
   * 也不含本步新投影的系统提示词——它是 before 版的**基线**。
   * 真正的 before 栏在 `handle()` 里用「after − 本步新增」算出来（见 `before.ts`）。
   *
   * **配对键以本处的 `(turn, step)` 为准**：`step/start` 事件在 pre-step **之后**
   * 才提交，所以从会话事件拿到的 step 号在 llm/stream 时可能已经是**下一步**的。
   * pre-step 的 payload 里带着本步自己的 turn/step，是唯一可靠的来源。
   *
   * @param payload - pre-step 的 payload。
   * @param decision - 下游监听器链走完后的决定。
   */
  observePreStep(payload: PreStepPayload, decision: PreStepDecision): void {
    if (decision.kind === 'reject') return
    const sessionId = payload.agent.session.id
    // 基线：会话当前的派生历史。
    const derive = payload.agent.session.deriveMessages
    const history = typeof derive === 'function' ? derive.call(payload.agent.session) : undefined
    const requestKey = buildRequestKey(sessionId, payload.turn, payload.step)
    this.befores.set(requestKey, {
      requestKey,
      turn: payload.turn,
      step: payload.step,
      history: history ?? [],
      stepMessages: decision.messages,
      consumed: false,
    })
  }

  /**
   * 处理一次模型请求：写 after 行，并配对写出对应的 before 行。
   *
   * @param request - `llm/stream` 的请求选项。
   */
  handle(request: CaptureRequest): void {
    // 辅助调用（compaction 摘要 / session-title）不是对话上下文，跳过。
    if (!isConversationRequest(request)) {
      this.skipped += 1
      return
    }
    const sessionId = request.sessionId ?? ''
    // 会话事件给出的轮/步（可能已经推进到下一步，作为兜底）。
    const position = sessionId === '' ? undefined : this.positions.get(sessionId)
    const fallbackKey = buildRequestKey(sessionId, position?.turn ?? 0, position?.step ?? 0)

    // 配对：优先用 pre-step 记下的键（权威），否则退回会话事件推导的键。
    const before = this.befores.get(fallbackKey) ?? this.latestUnusedBefore(sessionId)
    const requestKey = before?.requestKey ?? fallbackKey
    const turn = before?.turn ?? position?.turn ?? 0
    const step = before?.step ?? position?.step ?? 0

    const record = captureRequest(request, {
      variant: this.config.variant,
      runId: this.config.runId,
      maxChars: this.config.maxChars,
      phase: 'after',
      requestKey,
      turn,
      step,
    })
    this.captured += 1

    // before 行：与 after 同一 requestKey。
    if (before !== undefined && !before.consumed) {
      before.consumed = true
      // **before = after − 插件注入**。
      // 「插件注入」= after 里有、而 pre-step 时刻的历史里没有的，
      // 且 source.kind 不是 dsh 自有来源的消息（见 before.ts）。
      const additions = computeStepAdditions(request.messages, before.history, before.stepMessages)
      const beforeMessages = subtractAdditions(request.messages, additions)
      const beforeRecord = captureRequest(
        {
          sessionId,
          provider: request.provider,
          model: request.model,
          messages: beforeMessages,
        },
        {
          variant: this.config.variant,
          runId: this.config.runId,
          maxChars: this.config.maxChars,
          phase: 'before',
          requestKey,
          turn: before.turn,
          step: before.step,
        },
      )
      this.beforeCaptured += 1
      // 先写 before，再写 after：同一请求的两栏相邻，便于人工翻看。
      this.writer.enqueue(beforeRecord)
    }
    // 只推进队列，不做磁盘 I/O —— 不阻塞模型请求。
    this.writer.enqueue(record)
  }

  /**
   * 找出该会话最近一个**尚未消费**的 before 快照。
   *
   * 兜底路径：`step/start` 在 pre-step 之后才提交，所以从会话事件推导出的键
   * 可能对不上 pre-step 的键。此时按「最近一个未消费的」配对——同一个 step
   * 的重试会复用同一个 pre-step 快照，但只有第一次请求会写 before 行
   * （重试的 messages 与首投相同，见 dsh-agent-loop/README.zh.md:120）。
   *
   * @param sessionId - 会话 id。
   * @returns 未消费的快照，或 undefined。
   */
  private latestUnusedBefore(sessionId: string): BeforeSnapshot | undefined {
    let latest: BeforeSnapshot | undefined
    for (const snapshot of this.befores.values()) {
      if (snapshot.consumed) continue
      if (!snapshot.requestKey.startsWith(`${sessionId}#`)) continue
      if (latest === undefined || snapshot.step > latest.step) latest = snapshot
    }
    return latest
  }

  /** 排空队列并把内容刷到磁盘。 */
  async flush(): Promise<void> {
    await this.writer.flush()
  }
}

/**
 * 插件入口：挂 `agent/pre-step` + `llm/stream` 捕获 + 写文件。
 *
 * @param ctx - Cordis 插件上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const writer = new JsonlWriter({
    outDir: resolved.outDir,
    fileName: resolved.fileName,
    onError: error => {
      ctx.logger.warn('memory-debug-capture: 写入失败：%s', String(error))
    },
  })
  const collector = new CaptureCollector(resolved, writer)

  // 捕获点 1：`agent/pre-step` —— 记忆机制介入**之前**的上下文。
  //
  // - 必须调用并返回 `next()`，否则这一步被短路；
  // - **`{ prepend: true }`**：cordis 的 waterfall 里，监听器**按注册顺序从外到内**
  //   排列（cordis/src/events.ts:246-261：`callbacks.shift()` 逐个取出，
  //   先注册的在外层）。只有**最外层**的监听器 `await next()` 之后，
  //   拿到的才是**所有其它监听器都改完之后**的最终决定。
  //   本插件用 `prepend` 把自己放到最外层，于是：
  //     - `decision.messages` = 记忆机制、AGENTS.md 等注入**之后**的最终批次；
  //     - `session.deriveMessages()` = 内层监听器（含 compaction）跑完后的历史。
  //   如果不 prepend，本插件会排在最内层，拿到的是**尚未**被其它监听器改写的
  //   决定，注入就看不见了。
  // - `{ global: true }`：pre-step 是 agent 作用域事件，只有 global 监听器
  //   才能在所有作用域收到（scope 过滤见 dsh-scope/src/index.ts:170-185）。
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
    const decision = await next()
    try {
      collector.observePreStep(payload, decision)
    } catch (error) {
      // 采集失败绝不能影响模型请求。
      ctx.logger.warn('memory-debug-capture: pre-step 捕获失败：%s', String(error))
    }
    return decision
  }, { global: true, prepend: true })

  // 捕获点 2：`llm/stream` waterfall —— 最终发出的上下文。
  // - 必须调用并返回 `next()`，否则会短路模型调用；
  // - `options.messages` 就是那次请求发给模型的完整上下文（已 deep-frozen，只读）。
  ctx.on('llm/stream', (options: LlmStreamOptions, next: LlmStreamNext) => {
    const request = options
    try {
      collector.handle({
        sessionId: request.sessionId,
        provider: request.provider,
        model: request.model,
        messages: request.messages,
        purpose: request.purpose,
      })
    } catch (error) {
      // 采集失败绝不能影响模型请求。
      ctx.logger.warn('memory-debug-capture: 捕获失败：%s', String(error))
    }
    return next()
  }, { global: true })

  // 轮/步边界来自会话事件：`turn/start` 与 `step/start`。
  ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    try {
      if (typeof session.id !== 'string' || session.id.length === 0) return
      collector.observeSessionEvent(session.id, event)
    } catch {
      // 事件形状异常不影响采集。
    }
  }, { global: true })

  // 进程退出前排空队列：dsh 的关停流程会 dispose 根 fiber，
  // effect 的 disposer 是异步的，dsh 会 await 它。
  ctx.effect(() => async () => {
    await writer.close()
  }, 'memory-debug-capture: flush on dispose')

  // 暴露给宿主/自检用的观测面。
  // 注意：Cordis 的 ctx 是代理，给未声明的属性赋值会抛 "cannot set property ... without provide"，
  // 所以必须用 ctx.provide（它会随 fiber 卸载自动注销）。
  ctx.provide('memoryDebugCapture', {
    stats: () => ({
      captured: collector.count,
      beforeCaptured: collector.beforeCount,
      skipped: collector.skippedCount,
      pending: writer.pending,
      written: writer.count,
      file: writer.filePath,
    }),
    flush: () => collector.flush(),
  })
}

export { buildRequestKey, captureRequest, isConversationRequest } from './capture.js'
export { computeStepAdditions, identityOf, subtractAdditions, visibleText } from './before.js'
export { computeTotals, serializeMessage, serializeMessages } from './serialize.js'
export { JsonlWriter } from './writer.js'
export type { CaptureRecord, CaptureTotals, CapturedMessage, CaptureRole, CapturePhase } from './types.js'
