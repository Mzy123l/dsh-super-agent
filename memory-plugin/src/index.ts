// 公共 API 导出（规格 §1：index.ts 导出全部公共 API）

// 类型
export type {
  MemoryRecord,
  MemoryRecordResult,
  ReasoningRecord,
  ReasoningHit,
  RecordKind,
  EmbeddingProvider,
  VectorStore,
  VectorRecordId,
  ExtractResult,
  SessionWatermark,
  IndexStatus,
  SearchMode,
  SearchOptions,
  IndexerConfig,
} from './types.js'

// 存储
export { MemoryStore } from './store/sqlite.js'

// 提取/读取
export { readSessionLog, scanZstdFrames } from './ingest/log-reader.js'
export { extractFromEvents, TEXT_SLICE } from './ingest/extractor.js'
export { discoverSessionFiles, indexAll, indexSession, type IndexReport } from './ingest/indexer.js'

// 搜索
export { keywordSearch, buildFtsQuery } from './search/keyword.js'
export { NoopVectorStore, OpenAICompatVectorStore, OpenAICompatEmbedding, cosine, resolveVectorHits } from './search/vector.js'
export { rrfMerge, mergeSearch, RRF_K } from './search/merge.js'
export { search, searchReasoning, type SearchContext } from './search/index.js'

// API
export { startApiServer, type ApiServerOptions } from './api/server.js'
