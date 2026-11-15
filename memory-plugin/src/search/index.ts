// 检索：命中返回单位的**全量**（不摘要、不截断）。
//
// 全量搜索：不管单位是否已老化（既定决策）。
// 便签只读展示，模型不能按便签检索。

import type { MemoryStore } from '../store/sqlite.js'
import type { EmbeddingProvider, SearchMode, SearchOptions, UnitKind, VectorStore } from '../types.js'
import { buildFtsQuery } from './segment.js'

/** 搜索上下文。 */
export interface SearchContext {
  store: MemoryStore
  vectorStore?: VectorStore
  embedding?: EmbeddingProvider
}

/** 一条检索结果。 */
export interface SearchHit {
  sessionId: string
  /** 会话内编号，模型用它指代该单位 */
  idx: number
  kind: UnitKind
  /** 该单位的总结（空 = 未总结） */
  summary: string
  /** **全量正文** */
  content: string
  /** 是否仍在近程窗口内（粗判：in_context） */
  inContext: boolean
  tags: string[]
  score: number
}

/**
 * 执行检索。
 *
 * @param ctx - 搜索上下文。
 * @param query - 查询文本。
 * @param options - 模式、条数、会话。
 * @returns 结果（按分数降序）。
 */
export async function search(
  ctx: SearchContext,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = options.limit ?? 8
  const mode: SearchMode = options.mode ?? 'keyword'
  const q = query.trim()
  if (q.length === 0) return []

  const hits = new Map<string, SearchHit>()

  // 关键词路
  const ftsQuery = buildFtsQuery(q)
  if (ftsQuery) {
    const rows = ctx.store.searchFts(ftsQuery, Math.max(limit * 3, 20), options.sessionId)
    rows.forEach((row, i) => {
      const unit = ctx.store.getByRowId(row.rowId)
      if (!unit) return
      hits.set(`${unit.sessionId}#${unit.idx}`, toHit(unit, 1 / (60 + i + 1)))
    })
  }

  // 向量路
  if (mode === 'hybrid' && ctx.vectorStore && ctx.embedding) {
    try {
      const emb = await ctx.embedding.embed(q)
      // 取更大候选集：向量表全库共享，按会话过滤后可能所剩无几。
      // 若只取 limit*3，别的会话占满名额会让本会话一条都拿不到。
      const vecHits = await ctx.vectorStore.search(emb, Math.max(limit * 10, 100))
      vecHits.forEach((vh, i) => {
        const parsed = parseVectorId(vh.id)
        if (!parsed) return
        // 向量表是全库共享的（message_vector 只按 row_id 存），
        // 所以必须在这里按会话过滤，否则会串到别的会话的数据。
        if (options.sessionId !== undefined && parsed.sessionId !== options.sessionId) return
        const unit = ctx.store.getUnit(parsed.sessionId, parsed.idx)
        if (!unit) return
        const key = `${unit.sessionId}#${unit.idx}`
        const contribution = 1 / (60 + i + 1)
        const prev = hits.get(key)
        if (prev) prev.score += contribution
        else hits.set(key, toHit(unit, contribution))
      })
    } catch {
      // 向量路故障不影响关键词结果
    }
  }

  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

function toHit(u: {
  sessionId: string
  idx: number
  kind: UnitKind
  summary: string
  content: string
  inContext: boolean
  tags: string[]
}, score: number): SearchHit {
  return {
    sessionId: u.sessionId,
    idx: u.idx,
    kind: u.kind,
    summary: u.summary,
    content: u.content,
    inContext: u.inContext,
    tags: u.tags,
    score,
  }
}

/** 解析向量 id `<sessionId>#<idx>`。 */
export function parseVectorId(id: string): { sessionId: string; idx: number } | undefined {
  const hash = id.lastIndexOf('#')
  if (hash <= 0) return undefined
  const idx = Number(id.slice(hash + 1))
  if (!Number.isInteger(idx) || idx < 0) return undefined
  return { sessionId: id.slice(0, hash), idx }
}

/** 构造向量 id。 */
export function vectorId(sessionId: string, idx: number): string {
  return `${sessionId}#${idx}`
}
