// 向量索引：把单位写入向量表，供混合检索使用。
//
// ===========================================================================
// 为什么需要这个模块
// ===========================================================================
//
// 此前 `SqliteVectorStore.upsert()` 与 `embedding.embed()` 只有定义、没有调用点，
// `message_vector` 表永远是 0 行——`mode: 'hybrid'` 实际等价于纯关键词检索。
// 这里把写入侧接上。
//
// ===========================================================================
// 索引哪些单位
// ===========================================================================
//
// 与关键词索引**刻意不同**：
//
//   关键词索引：thinking 只在近程窗口内收录（窗口外思考量大，会淹没结果）
//   向量索引：  **所有单位都收录**，包括窗口外的 thinking
//
// 理由正是"思考内容太多，不该进关键词索引"的另一面——
// 既然不希望它们污染关键词结果，那它们就该有另一条能被找回的通道。
// 向量检索正是这条通道：语义相近即可命中，不靠字面匹配。
//
// ===========================================================================
// 什么时候算
// ===========================================================================
//
// 嵌入计算有成本，不能每次同步都全量重算。用**内容指纹**判断：
// 单位正文 + summary 拼起来算一个短码，存在 `message_vector` 已有的
// `dims`/`vec` 之外——不，不能存别处，这会脏表。
//
// 所以改用内存缓存记录"已算过的指纹"。进程重启后缓存清空，
// 会重算一次全量（可接受：几百到几千条，哈希实现足够快）。

import type { MemoryStore } from '../store/sqlite.js'
import type { EmbeddingProvider, VectorStore } from '../types.js'
import { vectorId } from './index.js'
import type { UnitResult } from '../types.js'

/** 索引文本：正文 + summary（summary 是提纯后的关键信息，权重高但合并即可）。 */
export function vectorTextOf(unit: Pick<UnitResult, 'content' | 'summary'>): string {
  const parts: string[] = []
  if (unit.summary.trim().length > 0) parts.push(unit.summary.trim())
  if (unit.content.trim().length > 0) parts.push(unit.content.trim())
  return parts.join('\n')
}

/** 用 djb2 算内容指纹（只需判等，不需要抗碰撞强度）。 */
export function fingerprintText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  }
  return `${h.toString(36)}:${text.length}`
}

/** 一次同步的结果（诊断用）。 */
export interface VectorSyncReport {
  /** 检查了多少单位 */
  scanned: number
  /** 实际算了多少次嵌入 */
  embedded: number
  /** 因指纹未变而跳过 */
  skipped: number
  /** 嵌入或写入失败 */
  failed: number
}

/**
 * 把某会话的单位同步进向量表。
 *
 * 只对「指纹变了或从没算过」的单位重算嵌入，其余跳过。
 *
 * @param store - 单位存储。
 * @param vectorStore - 向量存储。
 * @param embedding - 嵌入提供者。
 * @param sessionId - 会话 id。
 * @param seen - 已算过的指纹缓存（`<sessionId>#<idx>` → 指纹）。
 * @returns 本次同步报告。
 */
export async function syncVectors(
  store: MemoryStore,
  vectorStore: VectorStore,
  embedding: EmbeddingProvider,
  sessionId: string,
  seen: Map<string, string>,
): Promise<VectorSyncReport> {
  const report: VectorSyncReport = { scanned: 0, embedded: 0, skipped: 0, failed: 0 }
  const range = store.indexRange(sessionId)
  if (!range) return report

  const units = store.listRange(sessionId, range.min, range.max)
  for (const unit of units) {
    report.scanned += 1
    const text = vectorTextOf(unit)
    if (text.length === 0) {
      report.skipped += 1
      continue
    }

    const key = vectorId(sessionId, unit.idx)
    const fp = fingerprintText(text)
    if (seen.get(key) === fp) {
      report.skipped += 1
      continue
    }

    try {
      const vec = await embedding.embed(text)
      await vectorStore.upsert(key, vec)
      seen.set(key, fp)
      report.embedded += 1
    } catch {
      // 单条失败不影响其余；下次同步指纹仍未登记，会重试
      report.failed += 1
    }
  }

  return report
}

/**
 * 清掉某会话的指纹缓存（例如 override 改了 summary 后强制重算）。
 *
 * @param seen - 指纹缓存。
 * @param sessionId - 会话 id。
 * @param idx - 可选：只清某一个单位。
 */
export function forgetVectors(
  seen: Map<string, string>,
  sessionId: string,
  idx?: number,
): void {
  if (idx !== undefined) {
    seen.delete(vectorId(sessionId, idx))
    return
  }
  const prefix = `${sessionId}#`
  for (const key of [...seen.keys()]) {
    if (key.startsWith(prefix)) seen.delete(key)
  }
}
