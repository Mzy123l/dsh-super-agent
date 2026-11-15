// 检索：模型按关键词查，命中后返回该条消息的**全量**。
//
// 用户要求：「模型要查找，就返回这一条的全量」——
// 所以这里不做摘要、不截断正文。
//
// 便签（tags）是程序内部维护的，只随结果展示，模型不能按它检索。

import type { MemoryStore } from '../store/sqlite.js'
import type { MessageResult, SearchMode, SearchOptions, VectorStore, EmbeddingProvider } from '../types.js'
import { buildFtsQuery } from './segment.js'
import { segmentForFts } from './segment.js'

/** 搜索上下文。 */
export interface SearchContext {
  store: MemoryStore
  vectorStore?: VectorStore
  embedding?: EmbeddingProvider
}

/** 一条检索结果。 */
export interface SearchHit {
  /** 会话 id */
  sessionId: string
  /** 会话内索引：模型用它指代这条消息 */
  idx: number
  /** 角色 */
  role: string
  /** 是否仍在上下文里 */
  inContext: boolean
  /** 便签（程序内部维护，只读展示） */
  tags: string[]
  /** **全量正文** */
  text: string
  /** 相关度分数 */
  score: number
}

/**
 * 执行检索。
 *
 * keyword 模式走 FTS；hybrid 模式加向量路，RRF 合并。
 * 命中后取该条消息的全量正文返回。
 *
 * @param ctx - 搜索上下文。
 * @param query - 查询文本。
 * @param options - 选项（模式、条数、限定会话）。
 * @returns 结果列表（按分数降序）。
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

  // ---- 关键词路 ----
  const ftsQuery = buildFtsQuery(q)
  if (ftsQuery) {
    const rows = ctx.store.searchFts(ftsQuery, Math.max(limit * 3, 20), options.sessionId)
    rows.forEach((row, i) => {
      const msg = ctx.store.getByRowId(row.rowId)
      if (!msg) return
      const key = `${msg.sessionId}#${msg.idx}`
      hits.set(key, toHit(msg, 1 / (60 + i + 1)))
    })
  }

  // ---- 向量路（仅在 hybrid 且真实现了向量时）----
  if (mode === 'hybrid' && ctx.vectorStore && ctx.embedding) {
    try {
      const emb = await ctx.embedding.embed(q)
      const vecHits = await ctx.vectorStore.search(emb, Math.max(limit * 3, 20))
      vecHits.forEach((vh, i) => {
        const parsed = parseVectorId(vh.id)
        if (!parsed) return
        const msg = ctx.store.getMessage(parsed.sessionId, parsed.idx)
        if (!msg) return
        const key = `${msg.sessionId}#${msg.idx}`
        const contribution = 1 / (60 + i + 1)
        const prev = hits.get(key)
        if (prev) prev.score += contribution
        else hits.set(key, toHit(msg, contribution))
      })
    } catch {
      // 向量路故障不影响关键词结果
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** MessageResult → SearchHit（全量正文，不截断）。 */
function toHit(msg: MessageResult, score: number): SearchHit {
  return {
    sessionId: msg.sessionId,
    idx: msg.idx,
    role: msg.role,
    inContext: msg.inContext,
    tags: msg.tags,
    text: msg.text,
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

export { segmentForFts }
