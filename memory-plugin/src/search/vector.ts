// 向量检索层（规格 §4.2）
//
// VectorStore / EmbeddingProvider 接口定义在 types.ts（注入式，插件不绑定具体模型）。
// 本文件提供两个理论阶段实现：
// - NoopVectorStore：空实现，向量检索恒返回空（hybrid 自动退化为纯关键词）
// - OpenAICompatVectorStore：任何 OpenAI 兼容 embedding 端点（key 从环境变量读）
//
// reasoning 与 records 的向量以 id 区分：
//   'r:<sessionId>:<seq>:<kind>' —— records 表
//   'n:<sessionId>:<seq>'        —— reasoning 表（决策①：只向量化）

import type { EmbeddingProvider, VectorRecordId, VectorStore } from '../types.js'
import type { MemoryStore } from '../store/sqlite.js'
import type { MemoryRecordResult, ReasoningHit } from '../types.js'

/** 空实现：理论阶段的默认值。写入丢弃，检索返回空。 */
export class NoopVectorStore implements VectorStore {
  async upsert(_id: VectorRecordId, _embedding: number[]): Promise<void> {}
  async search(_embedding: number[], _k: number): Promise<Array<{ id: VectorRecordId; score: number }>> {
    return []
  }
  count(): number {
    return 0
  }
  async clear(): Promise<void> {}
}

/**
 * OpenAI 兼容 embedding 端点实现。
 * 环境变量：MEMORY_EMBEDDING_API_KEY、MEMORY_EMBEDDING_BASE_URL、MEMORY_EMBEDDING_MODEL。
 */
export class OpenAICompatVectorStore implements VectorStore {
  private vectors = new Map<VectorRecordId, number[]>()

  constructor(
    private provider: EmbeddingProvider,
    private maxChars = 2000,
  ) {}

  async upsert(id: VectorRecordId, embedding: number[]): Promise<void> {
    this.vectors.set(id, embedding)
  }

  async search(embedding: number[], k: number): Promise<Array<{ id: VectorRecordId; score: number }>> {
    // 暴力余弦相似度 top-k（理论阶段质量优先；量级大时换 sqlite-vec）
    const scored: Array<{ id: VectorRecordId; score: number }> = []
    for (const [id, vec] of this.vectors) {
      scored.push({ id, score: cosine(embedding, vec ?? []) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  count(): number {
    return this.vectors.size
  }

  async clear(): Promise<void> {
    this.vectors.clear()
  }

  /** 生成文本 embedding（超长截断） */
  async embed(text: string): Promise<number[]> {
    const clipped = text.length > this.maxChars ? text.slice(0, this.maxChars) : text
    return this.provider.embed(clipped)
  }
}

/** 余弦相似度（零向量返回 0） */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number
    const bi = b[i] as number
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** OpenAI 兼容 /v1/embeddings 的 HTTP 实现 */
export class OpenAICompatEmbedding implements EmbeddingProvider {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
  ) {}

  static fromEnv(): OpenAICompatEmbedding | undefined {
    const apiKey = process.env['MEMORY_EMBEDDING_API_KEY']
    const baseUrl = process.env['MEMORY_EMBEDDING_BASE_URL'] ?? 'https://api.openai.com/v1'
    const model = process.env['MEMORY_EMBEDDING_MODEL']
    if (!apiKey || !model) return undefined
    return new OpenAICompatEmbedding(apiKey, baseUrl, model)
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    })
    if (!response.ok) {
      throw new Error(`embedding endpoint returned ${response.status}`)
    }
    const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
    const embedding = json.data?.[0]?.embedding
    if (!Array.isArray(embedding)) {
      throw new Error('embedding endpoint returned no embedding')
    }
    return embedding
  }
}

/** 向量命中的回链结果（kind=reasoning 时标记 'reasoning'，调用方据此区分思考与事实） */
export interface VectorHitResult {
  id: VectorRecordId
  score: number
  kind: 'reasoning' | MemoryRecordResult['kind']
  record?: MemoryRecordResult
  reasoning?: ReasoningHit
}

/**
 * 解析向量 id 并回链正文：
 * - 'r:...' → records 表（带 shadowed 标记）
 * - 'n:...' → reasoning 表，结果 kind 标记为 'reasoning'
 */
export function resolveVectorHits(
  store: MemoryStore,
  hits: Array<{ id: VectorRecordId; score: number }>,
): VectorHitResult[] {
  const results: VectorHitResult[] = []
  for (const hit of hits) {
    if (hit.id.startsWith('n:')) {
      // n:<sessionId>:<seq>
      const rest = hit.id.slice(2)
      const idx = rest.lastIndexOf(':')
      if (idx < 0) continue
      const sessionId = rest.slice(0, idx)
      const seq = Number(rest.slice(idx + 1))
      const reasoning = store.getReasoning(sessionId, seq)
      if (!reasoning) continue
      results.push({
        id: hit.id,
        score: hit.score,
        kind: 'reasoning',
        reasoning: { ...reasoning, score: hit.score },
      })
    } else if (hit.id.startsWith('r:')) {
      // r:<sessionId>:<seq>:<kind>
      const rest = hit.id.slice(2)
      const firstColon = rest.indexOf(':')
      if (firstColon < 0) continue
      const secondColon = rest.indexOf(':', firstColon + 1)
      if (secondColon < 0) continue
      const sessionId = rest.slice(0, firstColon)
      const seq = Number(rest.slice(firstColon + 1, secondColon))
      const kind = rest.slice(secondColon + 1)
      const record = store.getRecord(sessionId, seq, kind)
      if (!record) continue
      results.push({
        id: hit.id,
        score: hit.score,
        kind: record.kind,
        record: { ...record, shadowed: store.isShadowed(sessionId, seq), score: hit.score },
      })
    }
  }
  return results
}
