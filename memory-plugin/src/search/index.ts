// 搜索统一入口（规格 §4）
//
// mode='keyword'：只走 FTS。
// mode='hybrid'：关键词 + 向量双路，RRF(k=60) 合并；
//   NoopVectorStore（理论默认）下向量路为空，自动退化为纯关键词。

import type { MemoryStore } from '../store/sqlite.js'
import type {
  MemoryRecordResult,
  ReasoningHit,
  SearchMode,
  SearchOptions,
  VectorStore,
} from '../types.js'
import { keywordSearch } from './keyword.js'
import { resolveVectorHits } from './vector.js'
import { mergeSearch, type RrfResult } from './merge.js'
import { OpenAICompatEmbedding } from './vector.js'

/** 搜索上下文：注入式向量存储（缺省 Noop） */
export interface SearchContext {
  store: MemoryStore
  vectorStore?: VectorStore
  embedding?: OpenAICompatEmbedding
}

/** 统一搜索：返回合并后的结果列表（含 reasoning 命中） */
export async function search(
  ctx: SearchContext,
  query: string,
  options: SearchOptions = {},
): Promise<RrfResult[]> {
  const mode: SearchMode = options.mode ?? 'keyword'
  const limit = options.limit ?? 20
  const keywordResults = keywordSearch(ctx.store, query, { ...options, limit })

  if (mode === 'keyword' || !ctx.vectorStore || !ctx.embedding) {
    // 纯关键词：包一层 RRF 结构保持返回类型一致（单路积分即 FTS 名次序）
    return mergeSearch(keywordResults, [], { ...options, limit })
  }

  // 向量路：查询文本 → embedding → top-k → 回链正文
  let vectorResults: Array<{
    payload: MemoryRecordResult | ReasoningHit
    isReasoning: boolean
    vectorId: string
  }> = []
  try {
    const queryEmbedding = await ctx.embedding.embed(query)
    const k = Math.max(limit, 50)
    const hits = await ctx.vectorStore.search(queryEmbedding, k)
    const resolved = resolveVectorHits(ctx.store, hits)
    vectorResults = resolved
      .filter((hit) => hit.record || hit.reasoning)
      .map((hit) => ({
        payload: (hit.record ?? hit.reasoning) as MemoryRecordResult | ReasoningHit,
        isReasoning: hit.kind === 'reasoning',
        vectorId: hit.id,
      }))
  } catch {
    // embedding 端点故障：退化到纯关键词，不让搜索整体失败
    vectorResults = []
  }

  return mergeSearch(keywordResults, vectorResults, { ...options, limit })
}

/** reasoning 专用检索：仅向量命中（规格 §5.1 /search reasoning 语义） */
export async function searchReasoning(
  ctx: SearchContext,
  query: string,
  options: SearchOptions = {},
): Promise<ReasoningHit[]> {
  if (!ctx.vectorStore || !ctx.embedding) return []
  try {
    const queryEmbedding = await ctx.embedding.embed(query)
    const hits = await ctx.vectorStore.search(queryEmbedding, options.limit ?? 20)
    const resolved = resolveVectorHits(ctx.store, hits)
    return resolved
      .filter((hit): hit is typeof hit & { reasoning: ReasoningHit } => hit.reasoning !== undefined)
      .map((hit) => hit.reasoning)
  } catch {
    return []
  }
}
