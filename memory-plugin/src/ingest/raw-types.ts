// dsh 会话日志的原始事件类型（按需建模：只声明提取用到的字段，其余透传为 unknown）

/** 内容块（user/assistant 消息与工具结果共用） */
export interface RawContentBlock {
  type: string
  text?: string
  /** tool-call 块 */
  id?: string
  name?: string
  arguments?: string
}

/** 原始事件（type/seq/time 为公共字段，data 按 type 分形状） */
export interface RawEvent {
  type: string
  seq: number
  /** epoch 毫秒 */
  time?: number
  data?: RawEventData
  surfaceOp?: string
}

/** 事件 data 的宽松形状（各类型按需取字段） */
export interface RawEventData {
  // user/message 与 assistant/message 的 content（数组）
  content?: RawContentBlock[]
  // assistant/message：嵌套 message 对象（含 reasoning/text/tool-call 块）
  message?: {
    role?: string
    content?: RawContentBlock[]
    source?: { kind?: string }
  }
  // user/message 的 source.kind（注入消息识别用）
  source?: { kind?: string }
  // assistant/message、tool/*：轮次与步号
  turn?: number | null
  step?: number
  // tool/call
  callId?: string
  name?: string
  arguments?: string
  // tool/result
  isError?: boolean
  // compaction/summary
  compactionId?: string
  summary?: RawContentBlock[]
  // compaction/summary 与 compaction/prune 共有
  shadowedRange?: { start: number; end: number }
  shadowedSeqs?: number[]
  shadowedTokenCount?: number
}

/** 读出来的一个会话日志 */
export interface SessionLog {
  sessionId: string
  filePath: string
  events: RawEvent[]
  frameCount: number
  badFrames: number
  parseErrors: number
}
