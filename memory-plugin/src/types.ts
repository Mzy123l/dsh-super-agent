// 全部公共类型定义

/** 可索引记录的种类 */
export type RecordKind =
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  | 'summary'

/** 一次工具调用或一条消息的可索引记录 */
export interface MemoryRecord {
  /** 原日志中的事件 seq */
  seq: number
  /** 会话 id（从目录名提取） */
  sessionId: string
  kind: RecordKind
  /** ISO 时间 */
  at: string
  /** 可检索正文（按规格 §3 规则提取） */
  text: string
  /** 所在轮次（事件带 turn 时归属） */
  turn?: number
}

/** 用户决策①：reasoning 不进 FTS，只向量化 */
export interface ReasoningRecord {
  seq: number
  sessionId: string
  at: string
  turn?: number
  /** 思考原文（只进向量库，绝不进 FTS） */
  text: string
  /** 若有 self-gist / turn-summary 可关联（理论预留） */
  summary?: string
}

/** 带检索元数据的一条结果（records 或 reasoning） */
export interface MemoryRecordResult extends MemoryRecord {
  /** 该记录的原始事件当前是否已被压缩遮蔽 */
  shadowed: boolean
  /** FTS rank 分数（关键词路径） */
  rank?: number
  /** RRF 合并分数（混合路径） */
  score?: number
}

/** reasoning 命中的结果（kind 恒为 'reasoning'，供调用方区分"思考"与"事实"） */
export interface ReasoningHit {
  seq: number
  sessionId: string
  at: string
  turn?: number
  text: string
  score?: number
}

/** 向量检索记录 id 约定：'r:<sessionId>:<seq>:<kind>' 或 'n:<sessionId>:<seq>' */
export type VectorRecordId = string

/** 嵌入向量提供者（注入式，插件不绑定具体模型） */
export interface EmbeddingProvider {
  /** 生成一段文本的 embedding */
  embed(text: string): Promise<number[]>
}

/** 向量存储接口（注入式） */
export interface VectorStore {
  /** 写入或更新一条向量 */
  upsert(id: VectorRecordId, embedding: number[]): Promise<void>
  /** 按向量检索 top-k，返回记录 id */
  search(embedding: number[], k: number): Promise<Array<{ id: VectorRecordId; score: number }>>
  /** 已存向量条数 */
  count(): number
  /** 清空（重建索引用） */
  clear(): Promise<void>
}

/** 提取管线产出：records + reasoning + 一次性元数据 */
export interface ExtractResult {
  records: MemoryRecord[]
  reasoning: ReasoningRecord[]
  /** 本文件涉及的全部 shadowed seq（来自 compaction/summary 与 compaction/prune） */
  shadowedSeqs: Set<number>
  /** 本文件的轮次起点：seq -> turn（来自 turn/start） */
  turnStarts: Map<number, number>
  /** 最后一条事件的 seq（增量索引用水位线） */
  lastSeq: number
  /** 事件总数（含解析失败的行） */
  eventCount: number
  /** JSON 解析失败的行数 */
  parseErrors: number
}

/** 读取一个会话文件的产出 */
export interface SessionIngest extends ExtractResult {
  sessionId: string
  filePath: string
  /** zstd 帧数 */
  frameCount: number
  /** 解压失败的帧数（实时写入可能出现坏帧/残帧） */
  badFrames: number
}

/** 会话级索引水位线（增量索引用） */
export interface SessionWatermark {
  sessionId: string
  lastSeq: number
  indexedAt: string
  eventCount: number
}

/** 索引状态统计 */
export interface IndexStatus {
  sessions: number
  records: number
  reasoning: number
  vectors: number
  summaries: number
  shadowed: number
  lastIndexedAt: string | null
  watermarks: SessionWatermark[]
}

/** 搜索模式 */
export type SearchMode = 'keyword' | 'hybrid'

/** 搜索选项 */
export interface SearchOptions {
  mode?: SearchMode
  limit?: number
  /** 'rank'（默认，按 FTS rank / RRF 分）或 'time'（按时间倒序） */
  order?: 'rank' | 'time'
}

/** 索引器配置 */
export interface IndexerConfig {
  /** 会话日志根目录（只读） */
  sessionsDir: string
  /** 插件数据目录（索引写入处，默认 ./data） */
  dataDir: string
  /** 向量存储（可选，Noop 时跳过向量化） */
  vectorStore?: VectorStore
  /** embedding 提供者（与 vectorStore 配套） */
  embedding?: EmbeddingProvider
  /** 单条文本向量化长度上限（字符） */
  embedMaxChars?: number
}
