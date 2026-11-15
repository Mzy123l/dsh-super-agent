// 公共导出。
//
// dsh 加载插件的入口是 package.json 的 main，必须从这里再导出
// apply/inject/name——否则 dsh 报 "plugin.apply is not a function"。

export { name, inject, apply, dispose, syncUnits, renderSession } from './dsh-bundle.js'
export type { Config } from './dsh-bundle.js'

export type {
  UnitKind,
  Unit,
  UnitResult,
  KeywordHit,
  VectorRecordId,
  EmbeddingProvider,
  VectorStore,
  IndexStatus,
  SearchMode,
  SearchOptions,
  ContextMessage,
} from './types.js'

export { MemoryStore, parseTags } from './store/sqlite.js'

export {
  extractUnits,
  shouldIndex,
  kindOf,
  composeToolContent,
  blocksOf,
  textOf,
  labelOf,
} from './ingest/units.js'

export {
  renderUnit,
  renderUnits,
  isRecent,
  unitsNeedingSummary,
  buildSummaryPrompt,
  isNoSummary,
  DEFAULT_WINDOW,
} from './projection/render.js'
export type { RenderOptions } from './projection/render.js'

export { PendingStore } from './summary/pending.js'
export type { PendingSummary } from './summary/pending.js'

export {
  runSummaryStep,
  summaryCoverage,
  SUMMARY_THRESHOLD,
  PENDING_TTL_MS,
} from './summary/flow.js'
export type { SummaryAction, SummaryHost } from './summary/flow.js'

export { search, parseVectorId, vectorId } from './search/index.js'
export type { SearchContext, SearchHit } from './search/index.js'

export { SqliteVectorStore, HashingEmbedding, cosine, tokenize } from './search/vector.js'
export { segmentForFts, buildFtsQuery } from './search/segment.js'
