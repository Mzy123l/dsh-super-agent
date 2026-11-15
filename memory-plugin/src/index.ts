// 公共导出。
//
// 核心模块不依赖 dsh，可独立测试与 CLI 使用；
// dsh 适配（apply/inject/name）在 dsh-bundle.ts，
// 必须从这里再导出——dsh 加载插件的入口是 package.json 的 main 字段。

export { name, inject, apply, dispose, Config } from './dsh-bundle.js'

export type {
  Role,
  MessageRecord,
  MessageResult,
  KeywordHit,
  VectorRecordId,
  EmbeddingProvider,
  VectorStore,
  IndexStatus,
  SearchMode,
  SearchOptions,
  IndexerConfig,
  SessionFile,
  IndexReport,
  Segment,
} from './types.js'

export { MemoryStore, parseTags } from './store/sqlite.js'

export {
  SegmentStore,
  composeSlottedText,
  isSlottedText,
  decideSummarize,
  buildSummarizePrompt,
  SLOT_TAGS,
  KEEP_ORIGINAL_THRESHOLD_CHARS,
  SUMMARIZE_THRESHOLD_CHARS,
} from './seal/types.js'
export type { Slot, SlotKind, SummarizeDecision } from './seal/types.js'

export {
  syncContext,
  visibleText,
  shouldIndex,
  normalizeRole,
  labelInPlace,
} from './ingest/context-sync.js'
export type { ContextMessage } from './ingest/context-sync.js'

export { search, parseVectorId, vectorId } from './search/index.js'
export type { SearchContext, SearchHit } from './search/index.js'

export {
  SqliteVectorStore,
  HashingEmbedding,
  cosine,
  tokenize,
} from './search/vector.js'

export { segmentForFts, buildFtsQuery } from './search/segment.js'

export { PendingStore } from './loop/store.js'
export type { PendingInject } from './loop/store.js'

export {
  runLoopStep,
  computeSpans,
  archiveDue,
  renderSegment,
  PENDING_TTL_MS,
} from './loop/engine.js'
export type { LoopAction, LoopHost, Span } from './loop/engine.js'
