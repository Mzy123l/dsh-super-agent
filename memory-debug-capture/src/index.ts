/**
 * memory-debug-capture：DSH 调试采集插件。
 *
 * **捕获点**：`llm/stream` waterfall。这是 9Q 调研确认的**唯一全覆盖**捕获点——
 * 它拿到 `options.messages`，即那次请求发给模型的**完整上下文**（与适配器输入
 * 同一份对象，已 deep-frozen，只读），且覆盖每一次模型调用（含重试）。
 *
 * 官方先例：`@deepseek-ai/dsh-session-checkpoint-policy/src/index.ts:64`。
 *
 * **只读 dsh**：本插件不 import 任何 `@deepseek-ai/dsh-*` 包，运行时不依赖 dsh
 * 包，只用 `ctx` 上暴露的事件与服务；`@deepseek-ai/cordis` 仅用于 `import type`。
 *
 * **不改变模型行为**：只旁路观测，不注入上下文、不改请求、不拦截。
 */

import type { Context } from '@deepseek-ai/cordis'
import { captureRequest, isConversationRequest, type CaptureRequest } from './capture.js'
import type { SourceMessage } from './serialize.js'
import type { CaptureRecord } from './types.js'
import { JsonlWriter } from './writer.js'
// 引入这个文件是为了把 `llm/stream` 与 `session/event` 的类型合并进 cordis 的 Events。
import type { LlmStreamNext, LlmStreamOptions, SessionEventLike, SessionLike } from './dsh-events.js'

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
 * 采集器：挂 `llm/stream`，把每次请求的上下文推进写队列。
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
  /** 已采集的行数。 */
  private captured = 0
  /** 跳过的辅助调用数。 */
  private skipped = 0

  constructor(config: ReturnType<typeof resolveConfig>, writer: JsonlWriter) {
    this.config = config
    this.writer = writer
  }

  /** 已采集的行数。 */
  get count(): number {
    return this.captured
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
   * 处理一次模型请求。
   *
   * @param request - `llm/stream` 的请求选项。
   */
  handle(request: CaptureRequest): void {
    // 辅助调用（compaction 摘要 / session-title）不是对话上下文，跳过。
    if (!isConversationRequest(request)) {
      this.skipped += 1
      return
    }
    const record = captureRequest(request, {
      variant: this.config.variant,
      runId: this.config.runId,
      maxChars: this.config.maxChars,
    })
    const position = request.sessionId === undefined
      ? undefined
      : this.positions.get(request.sessionId)
    if (position !== undefined) {
      record.turn = position.turn
      record.step = position.step
    }
    this.captured += 1
    // 只推进队列，不做磁盘 I/O —— 不阻塞模型请求。
    this.writer.enqueue(record)
  }

  /** 排空队列并把内容刷到磁盘。 */
  async flush(): Promise<void> {
    await this.writer.flush()
  }
}

/**
 * 插件入口：挂 `llm/stream` 捕获 + 写文件。
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

  // 捕获点：`llm/stream` waterfall。
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
      skipped: collector.skippedCount,
      pending: writer.pending,
      written: writer.count,
      file: writer.filePath,
    }),
    flush: () => collector.flush(),
  })
}

export { captureRequest, isConversationRequest } from './capture.js'
export { computeTotals, serializeMessage, serializeMessages } from './serialize.js'
export { JsonlWriter } from './writer.js'
export type { CaptureRecord, CaptureTotals, CapturedMessage, CaptureRole } from './types.js'
