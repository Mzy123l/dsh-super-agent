// 双路合并：RRF（Reciprocal Rank Fusion，k=60，规格 §4.3）
//
// score(doc) = Σ 1 / (k + rank_i)，rank 从 1 起。
// 关键词路径与向量路径各按名次贡献分数，同一条记录两路都命中时分数叠加——
// 这是 RRF 的设计意图：双路一致命中的文档排最前。

import type { MemoryRecordResult, ReasoningHit, SearchOptions } from '../types.js'

/** RRF 常数 k（规格固定 60） */
export const RRF_K = 60

/** RRF 合并输入：一路结果（按相关性已排序） */
export interface RrfInputItem {
  id: string
  /** 该路自己的分数（仅调试展示用；RRF 只看名次） */
  score?: number
  payload: MemoryRecordResult | ReasoningHit
  /** 是否来自 reasoning 路径（kind 标记为 'reasoning'） */
  isReasoning?: boolean
}

/** RRF 合并输出 */
export interface RrfResult {
  payload: MemoryRecordResult | ReasoningHit
  kind: string
  score: number
  isReasoning: boolean
}

/**
 * 对多路已排序结果做 RRF 合并，返回按 RRF 分数倒序的列表。
 * id 相同视为同一文档（分数叠加）；payload 取第一次出现的。
 */
export function rrfMerge(inputs: RrfInputItem[][], limit: number): RrfResult[] {
  const scores = new Map<string, number>()
  const payloads = new Map<string, RrfResult>()

  for (const list of inputs) {
    list.forEach((item, index) => {
      const contribution = 1 / (RRF_K + index + 1)
      const total = (scores.get(item.id) ?? 0) + contribution
      scores.set(item.id, total)

      const existing = payloads.get(item.id)
      if (existing) {
        existing.score = total
      } else {
        payloads.set(item.id, {
          payload: item.payload,
          kind: item.isReasoning ? 'reasoning' : String((item.payload as MemoryRecordResult).kind),
          score: total,
          isReasoning: item.isReasoning ?? false,
        })
      }
    })
  }

  return [...payloads.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * 混合搜索的组合语义（规格 §4.3）：
 * hybrid = RRF(关键词路, 向量路)；NoopVectorStore 下向量路为空，
 * 结果自动退化为纯关键词排序（RRF 只对单路名次积分，顺序与 FTS rank 一致）。
 */
export function mergeSearch(
  keywordResults: MemoryRecordResult[],
  vectorResults: Array<{
    payload: MemoryRecordResult | ReasoningHit
    isReasoning: boolean
    vectorId: string
  }>,
  options: SearchOptions = {},
): RrfResult[] {
  const limit = options.limit ?? 20

  const keywordItems: RrfInputItem[] = keywordResults.map((r) => ({
    id: `r:${r.sessionId}:${r.seq}:${r.kind}`,
    score: r.rank,
    payload: r,
  }))
  const vectorItems: RrfInputItem[] = vectorResults.map((r) => ({
    id: r.vectorId,
    payload: r.payload,
    isReasoning: r.isReasoning,
  }))

  return rrfMerge([keywordItems, vectorItems], limit)
}
