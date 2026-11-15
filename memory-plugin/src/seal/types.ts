// 段封存（sealing）：记忆架构的 L2 层。
//
// 核心思想（来自用户）：**近几步全量 + 总结，再前面的只有总结**。
// 本条文件负责「把一段已经完成的对话，替换成模型自己写的总结」。
//
// 不用 dsh 官方的 compaction 机制：
// - 不用 ctx.compaction seam
// - 不用 dsh-compaction-basic
// 只用 `session.append()` 的公开 surface 语义（surfaceOp: replace）。

import type { Context } from '@deepseek-ai/cordis'

/** 一个已被封存的对话段。 */
export interface SealedSegment {
  /** 段 id（稳定，用作去重与引用）。 */
  readonly id: string
  /** 所属会话。 */
  readonly sessionId: string
  /** 覆盖的事件 seq 范围（闭区间）。 */
  readonly fromSeq: number
  readonly toSeq: number
  /** 模型自己写的总结。 */
  readonly summary: string
  /** 封存理由（为什么会封存这一段）。 */
  readonly reason: string
  /** 封存时的轮次。 */
  readonly turn: number
  /** 封存时刻（ISO 8601）。 */
  readonly at: string
}

/**
 * 构造一条「替换历史区间」的 surface 事件。
 *
 * 依据 `dsh-session/lib/types/surface.js:190` 的 `isReplaceOp`：
 * replace 的形状被严格校验为恰好 3 个键 `{op:'replace', startSeq, endSeq}`。
 *
 * **额外约束（实测发现）**：`assertSourceEventReferences` 要求
 * `sourceEventSeqs` **必须完整列出被遮蔽的每一个 surface 节点的 seq**，
 * 缺一个就抛 `surface replace: sourceEventSeqs must include every shadowed surface node`。
 * 所以本函数要求调用方传入精确的 seq 集合。
 *
 * 语义：这条新事件**遮蔽** `[startSeq, endSeq]` 区间内的 surface 节点，
 * 模型之后看到的是这条新事件的内容，而旧区间在日志中仍然保留（可回放）。
 *
 * @param summary - 模型写的总结文本，将作为一条 user 消息进入历史。
 * @param fromSeq - 被替换区间的起始 seq（含）。
 * @param toSeq - 被替换区间的结束 seq（含）。
 * @param shadowedSeqs - 被遮蔽的每一个 surface 节点的 seq（必须完整，按升序）。
 * @returns 可直接交给 `session.append()` 的 `[type, data, opts]` 元组。
 */
export function buildSealEvent(
  summary: string,
  fromSeq: number,
  toSeq: number,
  shadowedSeqs: readonly number[],
): [
  'user/message',
  { role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: string } },
  { surfaceOp: { op: 'replace'; startSeq: number; endSeq: number }; sourceEventSeqs: number[] },
] {
  if (shadowedSeqs.length === 0) {
    throw new Error('seal requires at least one shadowed surface node')
  }
  return [
    'user/message',
    {
      role: 'user',
      content: [{ type: 'text', text: summary }],
      // source.kind 用自定义标记：让采集插件能识别「这条是封存总结，不是用户真的说的」
      source: { kind: 'memory-seal' },
    },
    {
      surfaceOp: { op: 'replace', startSeq: fromSeq, endSeq: toSeq },
      // dsh 强制要求：必须完整列出被遮蔽的节点，否则拒绝提交。
      // 去重并升序：sourceEventSeqs 不允许重复（assertSourceEventReferences 会抛错）。
      sourceEventSeqs: [...new Set(shadowedSeqs)].sort((a, b) => a - b),
    },
  ]
}

/**
 * 判断一段历史是否「可以封存」。
 *
 * 规则（保守，避免封存掉还在用的内容）：
 * - 至少跨 2 个轮次（单轮还没结束就封存没意义）
 * - 距最新事件至少 N 轮（保证「近几步」是原文）
 * - 未被封存过（避免重复替换）
 *
 * @param candidate - 候选区间。
 * @param latestTurn - 当前最新轮次。
 * @param keepTurns - 保留原文的轮次数（「近几步」）。
 * @returns 是否应当封存。
 */
export function shouldSeal(
  candidate: { turn: number },
  latestTurn: number,
  keepTurns: number,
): boolean {
  return latestTurn - candidate.turn >= keepTurns
}

/** 封存失败的原因（便于诊断，不做静默降级）。 */
export type SealFailure =
  | { kind: 'no-session' }
  | { kind: 'empty-range' }
  | { kind: 'already-sealed'; existingId: string }
  | { kind: 'append-failed'; message: string }

/** 封存结果。 */
export type SealResult =
  | { ok: true; segment: SealedSegment }
  | { ok: false; failure: SealFailure }
