// 段的生命周期管理：什么时候从 live 降级为 archived。
//
// ===========================================================================
// 规则（「近几步全量 + 总结，再前面的只有总结」的滑动窗口）
// ===========================================================================
//
//   live 阶段的段：<recent-slot> 原文 + <summary-slot> 总结 并存
//   archived 阶段：只留 <summary-slot>
//
//   一段从 live 变 archived 的条件：它已经滑出「近期窗口」。
//   近期窗口按**轮次**算：最新轮次往前数 keepTurns 轮内是「近期」。
//
// 注意：这不是「程序化触发索引」。降级是数据库里的一次状态更新，
// 不发起索引、不注入上下文、不发消息——它只改变**下次被读取时的形态**。

import type { SegmentStore } from './store.js'
import type { Segment } from './types.js'

/** 降级决策。 */
export interface ArchivePlan {
  /** 应当降级的段。 */
  readonly toArchive: readonly Segment[]
  /** 保持 live 的段。 */
  readonly stayLive: readonly Segment[]
}

/**
 * 计算某个会话当前应当如何降级。
 *
 * @param segments - 该会话的所有 live 段（按 eventNo 升序）。
 * @param latestTurn - 当前最新轮次。
 * @param keepTurns - 近期窗口大小（保留几轮的原文）。
 * @returns 降级计划。
 */
export function planArchive(
  segments: readonly Segment[],
  latestTurn: number,
  keepTurns: number,
): ArchivePlan {
  const cutoff = latestTurn - keepTurns
  const toArchive: Segment[] = []
  const stayLive: Segment[] = []
  for (const seg of segments) {
    // 段所在轮次 ≤ 截止轮次 → 已滑出近期窗口
    if (seg.turn <= cutoff) toArchive.push(seg)
    else stayLive.push(seg)
  }
  return { toArchive, stayLive }
}

/**
 * 执行降级：把滑出窗口的段从 live 改为 archived。
 *
 * 只改数据库状态，不触碰会话表面——已经写入历史的 recent 内容不会因此消失，
 * 降级影响的是**下一次读取该段时**呈现的形态。
 *
 * @returns 实际降级的段数。
 */
export function applyArchive(
  store: SegmentStore,
  sessionId: string,
  latestTurn: number,
  keepTurns: number,
): number {
  const live = store.listLive(sessionId)
  if (live.length === 0) return 0
  const plan = planArchive(live, latestTurn, keepTurns)
  let archived = 0
  for (const seg of plan.toArchive) {
    if (store.archive(sessionId, seg.eventNo)) archived += 1
  }
  return archived
}
