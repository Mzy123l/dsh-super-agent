// 全部公共类型定义。
//
// 索引模型：每条消息在**会话内**有一个线性递增的索引 idx（从 0 开始）。
// 索引会作为 token（`#0` `#1` …）标在消息里，随上下文一起传给模型。

/** 消息角色。 */
export type Role = 'user' | 'assistant' | 'tool' | 'system'

/** 一条消息的完整描述（对应 message 表的一行）。 */
export interface MessageRecord {
  /** 会话内索引：0 = 该会话第一个 user prompt，之后线性递增 */
  idx: number
  sessionId: string
  role: Role
  /** 完整正文（检索时原样返回，不摘要、不截断） */
  text: string
  /** 首次进入上下文的时刻（ISO 8601） */
  at: string
  /** 是否仍在上下文里（false = 已被压缩遮蔽，但仍可检索） */
  inContext?: boolean
  /** 便签：程序内部维护的展示标记，模型只读 */
  tags?: string[]
}

/** 带内部行号的消息（检索结果用）。 */
export interface MessageResult extends MessageRecord {
  /** 数据库内部行号（仅供 FTS 关联，不对外做语义） */
  rowId: number
  /** 索引（必填） */
  idx: number
  /** 上下文状态（必填） */
  inContext: boolean
  /** 便签（必填） */
  tags: string[]
  /** FTS rank 分数 */
  rank?: number
  /** RRF 合并分数 */
  score?: number
}

/** 关键词命中的轻量结果。 */
export interface KeywordHit {
  rowId: number
  sessionId: string
  idx: number
  role: Role
  at: string
  rank: number
}

/** 向量检索记录 id 约定：`<sessionId>#<idx>` */
export type VectorRecordId = string

/** 嵌入向量提供者（注入式）。 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

/** 向量存储接口（注入式）。 */
export interface VectorStore {
  upsert(id: VectorRecordId, embedding: number[]): Promise<void>
  search(embedding: number[], k: number): Promise<Array<{ id: VectorRecordId; score: number }>>
  count(): number
  clear(): Promise<void>
}

/** 索引状态统计。 */
export interface IndexStatus {
  /** 有消息的会话数 */
  sessions: number
  /** 消息总数 */
  messages: number
  /** 其中仍在上下文里的 */
  inContext: number
  /** 提炼段总数 */
  segments: number
  /** 其中 live 阶段（原文与总结并存）的 */
  liveSegments: number
  /** 最近一次索引时间 */
  lastIndexedAt: string | null
}

/** 搜索模式 */
export type SearchMode = 'keyword' | 'hybrid'

/** 搜索选项 */
export interface SearchOptions {
  mode?: SearchMode
  limit?: number
  /** 限定会话（不给则跨会话） */
  sessionId?: string
}

/** 索引器配置 */
export interface IndexerConfig {
  /** 会话日志根目录（只读数据源） */
  sessionsDir: string
  /** 插件数据目录 */
  dataDir: string
  vectorStore?: VectorStore
  embedding?: EmbeddingProvider
}

/** 一个会话文件。 */
export interface SessionFile {
  sessionId: string
  path: string
  /** 文件修改时间（毫秒），用于增量判断 */
  mtimeMs: number
  sizeBytes: number
}

/** 索引报告的累加器。 */
export interface IndexReport {
  sessionsScanned: number
  sessionsIndexed: number
  sessionsSkipped: number
  messagesWritten: number
  vectorsWritten: number
  badFrames: number
  parseErrors: number
  durationMs: number
}

/** 一个提炼段。 */
export interface Segment {
  segmentNo: number
  sessionId: string
  fromIdx: number
  toIdx: number
  summary: string
  recent: string
  stage: 'live' | 'archived'
  at: string
}
