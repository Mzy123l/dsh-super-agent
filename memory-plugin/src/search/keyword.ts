// FTS5 关键词搜索（规格 §4.1）
//
// - 默认 AND，支持显式 OR；查询串做 FTS5 语法转义与安全化
// - 中文：unicode61 tokenizer 把连续汉字当一个 token，长词命中好、短语命中差
//   （DESIGN.md 诚实标注）。补偿方案见 segment.ts：索引侧逐字分词 + 查询侧单字 phrase，
//   使"待办"能命中"记成待办"。这是字级匹配，不是真正的中文分词——词级语义仍靠向量检索补。

import type { MemoryStore } from '../store/sqlite.js'
import type { MemoryRecordResult, MemoryRecord, SearchOptions } from '../types.js'
import { termToFtsExpression } from './segment.js'

/** FTS 命中的原始行（store.searchFts 返回） */
export interface KeywordHit {
  sessionId: string
  seq: number
  kind: MemoryRecord['kind']
  at: string
  /** FTS rank（越小越相关） */
  rank: number
}

/**
 * 构造 FTS5 MATCH 表达式：
 * - 显式 OR（大写、独立词）保留
 * - 其余空白分词后按 AND 连接
 * - CJK 词转单字 phrase（segment.ts）
 * 空查询返回 undefined（调用方直接返回空结果）。
 */
export function buildFtsQuery(input: string): string | undefined {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return undefined
  const parts: string[] = []
  for (const token of tokens) {
    const isOr = /^OR$/i.test(token)
    if (isOr) {
      // OR 只在两侧都有操作数时保留
      if (parts.length > 0 && parts[parts.length - 1] !== 'OR') {
        parts.push('OR')
      }
      continue
    }
    parts.push(termToFtsExpression(token))
  }
  // 去掉结尾悬挂的 OR
  while (parts.length > 0 && parts[parts.length - 1] === 'OR') parts.pop()
  if (parts.length === 0) return undefined
  // OR 两侧不加 AND，其余相邻词加 AND
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string
    out.push(part)
    if (i < parts.length - 1) {
      const next = parts[i + 1] as string
      out.push(next === 'OR' || part === 'OR' ? ' ' : ' AND ')
    }
  }
  return out.join('').trim()
}

/** 关键词搜索：FTS5 命中 → 回链 records 补全正文与 shadowed 标记 */
export function keywordSearch(
  store: MemoryStore,
  query: string,
  options: SearchOptions = {},
): MemoryRecordResult[] {
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery) return []
  const limit = options.limit ?? 20
  const orderByTime = options.order === 'time'
  const hits = store.searchFts(ftsQuery, limit, orderByTime)

  const results: MemoryRecordResult[] = []
  for (const hit of hits) {
    // 用内部 row_id 回链正文（FTS 的 rowid 就是它）
    const record = store.getRecordByRowId(hit.rowId)
    if (!record) continue
    const snippetText = store.snippet(hit.rowId, ftsQuery)
    results.push({
      ...record,
      rank: hit.rank,
      // snippet：FTS5 snippet，查询词高亮；取不到时退回正文
      text: snippetText ?? record.text,
    })
  }
  return results
}
