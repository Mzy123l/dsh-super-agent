/**
 * 本插件用到的三个 dsh 事件的**类型声明**。
 *
 * 为什么在这里本地声明：
 * - `llm/stream`、`session/event`、`agent/pre-step` 这三个事件的类型，在 dsh 里是通过
 *   `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-agent` 对 cordis 的
 *   `declare module '@deepseek-ai/cordis'` 合并进去的；
 * - 本插件的硬性约束是**运行时不依赖任何 dsh 包**，而把这些包拉成依赖
 *   会带来版本耦合（现场装的是 0.2.1-rc.5，参考树是 0.2.2-rc.3）。
 *
 * 所以这里用**纯类型**的方式把三个事件补进 cordis 的 `Events`：
 * 运行时零依赖，编译期仍有完整的类型检查。
 *
 * 类型来源（已核实）：
 * - `llm/stream`：`dsh-llm/src/index.ts:76`
 *   `'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`
 * - `session/event`：`dsh-session/src/index.ts:79`
 *   `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`
 * - `agent/pre-step`：`dsh-agent/src/runtime-types.ts:351`
 *   `'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal; modelSelection: Readonly<ModelSelection> }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>`
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SourceMessage } from './serialize.js'

/** `llm/stream` 的请求选项（对应 dsh 的 GenerateOptions 的关键字段）。 */
export interface LlmStreamOptions {
  /** 会话 id；非对话请求可能没有。 */
  sessionId?: string | undefined
  /** 提供方路由名。 */
  provider: string
  /** 模型 id。 */
  model: string
  /** 这次请求发给模型的完整消息（已 deep-frozen，只读）。 */
  messages: readonly SourceMessage[]
  /** 辅助调用用途；普通对话请求为 undefined。 */
  purpose?: string | undefined
}

/** `llm/stream` 的下游链。 */
export type LlmStreamNext = () => AsyncIterable<unknown>

/** `session/event` 的事件形状（只取本插件关心的字段）。 */
export interface SessionEventLike {
  /** 事件类型。 */
  type: string
  /** 事件数据。 */
  data?: unknown
}

/**
 * `session` 的最小结构。
 *
 * 本插件只用到两样东西：**会话 id**（配对用）与**派生历史**
 * （`deriveMessages()`，用于重建 before 版完整上下文）。
 */
export interface SessionLike {
  /** 会话 id。 */
  id: string
  /**
   * 当前派生历史：模型可见的完整上下文（`dsh-session/src/index.ts:1079`）。
   *
   * 它是**缓存的尾部增长**快照：每次调用返回新数组，但共享深冻结的 Message 对象。
   * 在 `agent/pre-step` 时刻调用它，得到的是**本步消息提交之前**的历史——
   * 正是 before 版要的语义。
   */
  deriveMessages?: () => readonly SourceMessage[]
}

/**
 * `agent` 的最小结构：只需要它指向的 session。
 *
 * dsh 的 `Agent.session` 是 `readonly session: Session`
 * （`dsh-agent/src/runtime-types.ts:195`）。
 */
export interface AgentLike {
  /** 该 agent 驱动的会话。 */
  session: SessionLike
}

/** `agent/pre-step` 的 payload（本插件只关心的字段）。 */
export interface PreStepPayload {
  /** 发起本步的 agent。 */
  agent: AgentLike
  /** 本步从 inbox 领取的消息批次（**不是**完整历史）。 */
  messages: readonly SourceMessage[]
  /** 轮号（从 1 起）。 */
  turn: number
  /** 步号（每轮内从 1 起）。 */
  step: number
}

/**
 * `agent/pre-step` 的决定（对应 dsh 的 `PreStepDecision`）。
 *
 * `enter` 分支的 `messages` 是**本步即将进入的消息批次**——其它 pre-step
 * 监听器（记忆注入、AGENTS.md 注入等）对上下文的改动都体现在这里。
 */
export type PreStepDecision =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    /** 本步将进入的消息批次（保持最终顺序）。 */
    messages: readonly SourceMessage[]
    /** 是否开一条新的消息序列。 */
    startsRequestSeries?: true
  }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 每一次模型调用都会经过这个 waterfall；`options.messages` 就是那次请求
     * 发给模型的完整上下文。监听器必须调用并返回 `next()`。
     */
    'llm/stream'(options: LlmStreamOptions, next: LlmStreamNext): AsyncIterable<unknown>
    /** 会话事件流；本插件只读 `turn/start` 与 `step/start` 来定位轮/步。 */
    'session/event'(session: SessionLike, event: SessionEventLike): void
    /**
     * 每一步开始前运行（在系统提示词组装之后、请求派发之前）。
     *
     * 监听器**必须**调用 `next()` 并返回它的结果，否则这一步被短路。
     */
    'agent/pre-step'(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  }

  interface Context {
    /** 采集器暴露的观测面（统计与手动 flush）。 */
    memoryDebugCapture: MemoryDebugCaptureService
  }
}

/** 采集器暴露的观测面。 */
export interface MemoryDebugCaptureService {
  /** 当前统计。 */
  stats: () => {
    /** 已采集的对话请求数（after 行）。 */
    captured: number
    /** 已采集的 before 行数（与 captured 配对）。 */
    beforeCaptured: number
    /** 跳过的辅助调用数。 */
    skipped: number
    /** 队列中待写的行数。 */
    pending: number
    /** 已写入磁盘的行数。 */
    written: number
    /** 输出文件路径。 */
    file: string
  }
  /** 手动排空队列。 */
  flush: () => Promise<void>
}

/** 让本文件在 index.ts 里被引用（类型合并需要文件进入编译程序）。 */
export type DshEventsDeclared = Context
