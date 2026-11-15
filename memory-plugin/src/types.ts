// 公共类型。
//
// 编号单位：每个独立单元一个会话内线性编号（idx，从 0 开始）。

/** 单位类型。 */
export type UnitKind = 'user' | 'thinking' | 'tool' | 'reply'

/** 一个编号单位。 */
export interface Unit {
  /** 会话内线性编号，0 = 第一个 user prompt */
  idx: number
  sessionId: string
  kind: UnitKind
  /** 模型提炼结果；空串 = 未总结 */
  summary: string
  /** 完整原文，永不删 */
  content: string
  /** 首次进入上下文的时刻（ISO 8601） */
  at: string
  /** 是否仍在 dsh 上下文里 */
  inContext?: boolean
  /** 便签（程序内部维护） */
  tags?: string[]
}

/** 带内部行号的单位（检索结果用）。 */
export interface UnitResult extends Unit {
  rowId: number
  idx: number
  inContext: boolean
  tags: string[]
  rank?: number
  score?: number
}

/** 关键词命中。 */
export interface KeywordHit {
  rowId: number
  sessionId: string
  idx: number
  kind: UnitKind
  at: string
  rank: number
}

/** 向量 id：`<sessionId>#<idx>` */
export type VectorRecordId = string

/** 嵌入提供者。 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

/** 向量存储。 */
export interface VectorStore {
  upsert(id: VectorRecordId, embedding: number[]): Promise<void>
  search(embedding: number[], k: number): Promise<Array<{ id: VectorRecordId; score: number }>>
  count(): number
  clear(): Promise<void>
}

/** 索引状态。 */
export interface IndexStatus {
  sessions: number
  units: number
  inContext: number
  withSummary: number
  lastIndexedAt: string | null
}

/** 搜索模式。 */
export type SearchMode = 'keyword' | 'hybrid'

/** 搜索选项。 */
export interface SearchOptions {
  mode?: SearchMode
  limit?: number
  sessionId?: string
}

/** 上下文里的一条消息（dsh 形状，取需要的字段）。 */
export interface ContextMessage {
  role?: string
  content?: unknown
  source?: { kind?: string; callId?: string }
  toolCallId?: string
  isError?: boolean
}
