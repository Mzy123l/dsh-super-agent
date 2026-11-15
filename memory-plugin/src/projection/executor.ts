// 把投影计划写入 surface 的执行器。
//
// 只有目标形态与上次不同才写（缓存判断），避免每步重复 append。

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from '../store/sqlite.js'
import type { FoldStore } from '../fold/store.js'
import {
  buildReplaceMessage,
  planProjection,
  projectFold,
  type MemoryRenderCache,
} from './apply.js'
import { mapUnitSeqs, type SeqReader, type SeqSpan } from './seqmap.js'

/** 会话的最小写入接口。 */
export interface SurfaceWriter extends SeqReader {
  append(type: string, data: unknown, opts?: unknown): unknown
}

/** 投影执行结果（诊断用）。 */
export interface ProjectionReport {
  /** 计算了多少个单位 */
  planned: number
  /** 实际写入多少个 */
  written: number
  /** 跳过的标记（缓存命中） */
  cached: number
  /** 拿不到 seq 的单位 */
  unmapped: number
  /** 失败信息 */
  errors: string[]
}

/**
 * 执行一次投影。
 *
 * @param ctx - 插件上下文。
 * @param sessionId - 会话 id。
 * @param session - 会话（需支持 eventAt + append）。
 * @param store - 单位存储。
 * @param window - 近程窗口。
 * @param cache - 渲染缓存。
 * @param folds - 折叠仓储。
 * @returns 执行报告。
 */
export function applyProjection(
  ctx: Context,
  sessionId: string,
  session: SurfaceWriter,
  store: MemoryStore,
  window: number,
  cache: MemoryRenderCache,
  folds: FoldStore,
): ProjectionReport {
  const report: ProjectionReport = { planned: 0, written: 0, cached: 0, unmapped: 0, errors: [] }

  const range = store.indexRange(sessionId)
  if (!range) return report

  const units = store.listRange(sessionId, range.min, range.max)
  const ranges = folds.list(sessionId).map(f => ({ fromIdx: f.fromIdx, toIdx: f.toIdx }))

  const plans = planProjection(units, sessionId, range.max, window, cache, ranges)
  report.planned = plans.length

  // 建立 idx → seq 映射
  const spanCache = new Map<number, SeqSpan>()
  const spans = mapUnitSeqs(session, units, spanCache)
  const spanOf = new Map<number, SeqSpan>()
  for (const s of spans) spanOf.set(s.idx, s)

  for (const plan of plans) {
    if (!plan.needsWrite) {
      report.cached += 1
      continue
    }
    const span = spanOf.get(plan.idx)
    if (!span || span.seqs.length === 0) {
      report.unmapped += 1
      continue
    }

    const startSeq = span.seqs[0] as number
    const endSeq = span.seqs[span.seqs.length - 1] as number
    try {
      session.append(
        'user/message',
        buildReplaceMessage(plan.text),
        {
          surfaceOp: { op: 'replace', startSeq, endSeq },
          sourceEventSeqs: span.seqs,
        },
      )
      cache.set(sessionId, plan.idx, plan.text)
      report.written += 1
    } catch (error) {
      report.errors.push(`#${plan.idx}: ${String(error)}`)
    }
  }

  // 折叠体：写一条展示文本（替换整个区间）
  for (const fold of folds.list(sessionId)) {
    const text = projectFold(fold)
    if (cache.get(sessionId, fold.fromIdx) === text) continue
    const covered = spanOf.get(fold.fromIdx)
    if (!covered || covered.seqs.length === 0) continue
    // 覆盖区间内所有单位的 seq
    const allSeqs: number[] = []
    for (const unit of units) {
      if (unit.idx < fold.fromIdx || unit.idx > fold.toIdx) continue
      const s = spanOf.get(unit.idx)
      if (s) allSeqs.push(...s.seqs)
    }
    if (allSeqs.length === 0) continue
    const sorted = [...new Set(allSeqs)].sort((a, b) => a - b)
    try {
      session.append(
        'user/message',
        buildReplaceMessage(text),
        {
          surfaceOp: { op: 'replace', startSeq: sorted[0], endSeq: sorted[sorted.length - 1] },
          sourceEventSeqs: sorted,
        },
      )
      cache.set(sessionId, fold.fromIdx, text)
      report.written += 1
    } catch (error) {
      report.errors.push(`fold#${fold.fromIdx}: ${String(error)}`)
    }
  }

  if (report.errors.length > 0) {
    ctx.logger.warn('memory-plugin: projection errors: %s', report.errors.slice(0, 3).join('; '))
  }
  return report
}
