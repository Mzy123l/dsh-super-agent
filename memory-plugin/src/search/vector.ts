// 向量检索：本地实现，向量存 SQLite。
//
// 用户要求「剩下没做的全部做了」——原来的 NoopVectorStore 是空实现，
// 这里补一个能真跑的：余弦相似度 + 暴力扫描。
//
// 为什么暴力扫描而不是 ANN：
// 单个会话的消息量是几百到几千条，暴力扫描足够快（几十毫秒），
// 引入 HNSW 之类会带来索引维护复杂度，收益不成比例。

import type DatabaseConstructor from 'better-sqlite3'
import type { EmbeddingProvider, VectorRecordId, VectorStore } from '../types.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** 一条存储的向量。 */
interface VectorRow {
  row_id: number
  dims: number
  vec: string
}

/**
 * 基于 SQLite 的本地向量存储。
 *
 * 写入时按 `message.row_id` 关联；检索时拉出全部向量暴力算余弦相似度。
 */
export class SqliteVectorStore implements VectorStore {
  constructor(private readonly db: BetterSqlite3) {}

  /**
   * 写入一条向量。
   *
   * @param id - `<sessionId>#<idx>` 形式。
   * @param embedding - 向量。
   */
  async upsert(id: VectorRecordId, embedding: number[]): Promise<void> {
    const rowId = this.resolveRowId(id)
    if (rowId === undefined) return
    this.db
      .prepare(
        `INSERT INTO message_vector (row_id, dims, vec) VALUES (?, ?, ?)
         ON CONFLICT (row_id) DO UPDATE SET dims = excluded.dims, vec = excluded.vec`,
      )
      .run(rowId, embedding.length, JSON.stringify(embedding))
  }

  /**
   * 检索 top-k。
   *
   * @param embedding - 查询向量。
   * @param k - 返回条数。
   * @returns 按相似度降序的命中。
   */
  async search(embedding: number[], k: number): Promise<Array<{ id: VectorRecordId; score: number }>> {
    const rows = this.db.prepare(`SELECT row_id, dims, vec FROM message_vector`).all() as VectorRow[]
    if (rows.length === 0) return []

    const scored: Array<{ id: VectorRecordId; score: number }> = []
    for (const row of rows) {
      if (row.dims !== embedding.length) continue
      const vec = safeParse(row.vec)
      if (!vec) continue
      const score = cosine(embedding, vec)
      const id = this.resolveId(row.row_id)
      if (id === undefined) continue
      scored.push({ id, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  /** 已存向量条数。 */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM message_vector`).get() as { n: number }).n
  }

  /** 清空。 */
  async clear(): Promise<void> {
    this.db.prepare(`DELETE FROM message_vector`).run()
  }

  /** `<sessionId>#<idx>` → message.row_id */
  private resolveRowId(id: VectorRecordId): number | undefined {
    const hash = id.lastIndexOf('#')
    if (hash <= 0) return undefined
    const sessionId = id.slice(0, hash)
    const idx = Number(id.slice(hash + 1))
    if (!Number.isInteger(idx)) return undefined
    const row = this.db
      .prepare(`SELECT row_id FROM message WHERE sessionId = ? AND idx = ?`)
      .get(sessionId, idx) as { row_id: number } | undefined
    return row?.row_id
  }

  /** message.row_id → `<sessionId>#<idx>` */
  private resolveId(rowId: number): VectorRecordId | undefined {
    const row = this.db
      .prepare(`SELECT sessionId, idx FROM message WHERE row_id = ?`)
      .get(rowId) as { sessionId: string; idx: number } | undefined
    return row ? `${row.sessionId}#${row.idx}` : undefined
  }
}

/** 余弦相似度。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 安全解析 JSON 数组。 */
function safeParse(raw: string): number[] | undefined {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) && v.every(n => typeof n === 'number') ? (v as number[]) : undefined
  } catch {
    return undefined
  }
}

/**
 * 哈希式本地 embedding（无需外部服务）。
 *
 * 这是**兜底实现**：把文本切成 token，用 token 的哈希映射到一个固定维度的
 * 稀疏向量上。它捕捉的是「词重合」而不是语义，但比 Noop 强——
 * 至少思考内容能被搜到了。
 *
 * 需要真语义相似度时，注入 OpenAICompatEmbedding 覆盖它。
 */
export class HashingEmbedding implements EmbeddingProvider {
  private readonly dims: number

  constructor(dims = 512) {
    this.dims = dims
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dims).fill(0)
    const tokens = tokenize(text)
    for (const token of tokens) {
      const h = hash(token)
      const slot = h % this.dims
      // 用符号散列减少碰撞偏置
      vec[slot] = (vec[slot] as number) + (h & 1 ? 1 : -1)
    }
    // L2 归一化
    let norm = 0
    for (const v of vec) norm += v * v
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm)
      for (let i = 0; i < vec.length; i += 1) vec[i] = (vec[i] as number) * inv
    }
    return vec
  }
}

/** 切 token：CJK 逐字，拉丁按词。 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  let latin = ''
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) {
      if (latin) { out.push(latin); latin = '' }
      out.push(ch)
    } else if (/[a-zA-Z0-9_]/.test(ch)) {
      latin += ch.toLowerCase()
    } else {
      if (latin) { out.push(latin); latin = '' }
    }
  }
  if (latin) out.push(latin)
  return out
}

/** FNV-1a 32 位哈希。 */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
