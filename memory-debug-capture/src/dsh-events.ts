/**
 * 本插件用到的两个 dsh 事件的**类型声明**。
 *
 * 为什么在这里本地声明：
 * - `llm/stream` 与 `session/event` 这两个事件的类型，在 dsh 里是通过
 *   `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session` 对 cordis 的
 *   `declare module '@deepseek-ai/cordis'` 合并进去的；
 * - 本插件的硬性约束是**运行时不依赖任何 dsh 包**，而把这两个包拉成依赖
 *   会带来版本耦合（现场装的是 0.2.1-rc.5，参考树是 0.2.2-rc.3）。
 *
 * 所以这里用**纯类型**的方式把两个事件补进 cordis 的 `Events`：
 * 运行时零依赖，编译期仍有完整的类型检查。
 *
 * 类型来源（已核实）：
 * - `llm/stream`：`dsh-llm/src/index.ts:76`
 *   `'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`
 * - `session/event`：`dsh-session/src/index.ts:79`
 *   `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`
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

/** `session/event` 的会话形状。 */
export interface SessionLike {
  /** 会话 id。 */
  id: string
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
    /** 已采集的对话请求数。 */
    captured: number
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
