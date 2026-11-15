// 全部公共类型定义

/**
 * 事件载体种类。
 *
 * 每一种载体都是「一个事件」，各自占用一个全局唯一的 `eventNo`。
 * 注意：一条 assistant 消息会产生**两个**事件——正文一个、思考一个。
 */
export type EventKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'summary'

/** 兼容旧名（检索侧仍按 kind 分类） */
export type RecordKind = EventKind

/**
 * 一个事件的完整描述（对应 event 表的一行）。
 *
 * **编号规则**：`eventNo` 是**会话内**的编号，从 1 开始独立递增。
 * 会话 A 的 #1 与会话 B 的 #1 是不同事件；
 * 唯一定位一个事件需要 (sessionId, eventNo) 这一对。
 *
 * `seq` 是 dsh 日志里的事件序号，只作为普通列保留。
 */
export interface EventRecord {
  /** 会话内编号（写入后由数据库分配） */
  eventNo?: number
  /** dsh 会话内的事件序号 */
  seq: number
  sessionId: string
  kind: EventKind
  /** ISO 时间 */
  at: string
  /** 可检索正文（reasoning 事件也用它，但不进 FTS） */
  text: string
  /** 所在轮次 */
  turn?: number
}

/** 兼容别名：检索侧沿用 MemoryRecord 这个名字 */
export type MemoryRecord = EventRecord

/** 兼容别名：思考事件与普通事件同构，只是不进 FTS */
export type ReasoningRecord = EventRecord

/** 带检索元数据的一条结果 */
export interface EventSearchResult extends EventRecord {
  /** 数据库内部行号（仅供 FTS 关联，不对外做语义） */
  rowId: number
  /** 会话内编号（必填，来自数据库） */
  eventNo: number
  /** 该事件当前是否已被压缩遮蔽 */
  shadowed: boolean
  /** FTS rank 分数（关键词路径） */
  rank?: number
  /** RRF 合并分数（混合路径） */
  score?: number
}

/** 兼容别名 */
export type MemoryRecordResult = EventSearchResult

/** 关键词命中的轻量结果（FTS 路径用） */
export interface KeywordHit {
  /** 数据库内部行号（FTS rowid） */
  rowId: number
  /** 会话内编号 */
  eventNo: number
  sessionId: string
  seq: number
  kind: EventKind
  at: string
  /** FTS rank 分数（越小越相关，SQLite 约定） */
  rank: number
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

/** 索引状态统计（status 命令用） */
export interface IndexStatus {
  /** 已索引的会话数 */
  sessions: number
  /** 事件总数（每个事件都有独立编号） */
  events: number
  /** 其中：思考事件数 */
  reasoning: number
  /** 其中：压缩摘要事件数 */
  summaries: number
  /** 其中：被压缩遮蔽的事件数 */
  shadowed: number
  /** 已封存段数（seal） */
  sealed: number
  /** 最近一次索引时间（ISO），从未索引为 null */
  lastIndexedAt: string | null
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
