// 封存段（segment）的领域类型与文本组装。
//
// ===========================================================================
// 概念区分（这是整套设计的地基，不能混）
// ===========================================================================
//
//   **总结（summarize）** —— 主动提炼。保留有效信息，**丢掉噪音但保留否决路径**。
//       例：模型想了 10 万字，否定了 A/B/C 三个方案，最终选 D。
//       好的总结是：
//           否决 A：因为与现有鉴权冲突
//           否决 B：因为延迟超标
//           否决 C：因为改动面太大
//           最终：D
//       而不是只有「最终：D」。**后者是压缩，不是总结。**
//
//   **压缩（compact）** —— 被动腾空间。dsh 自己做，本插件不管。
//
// 本文件只负责「总结」的载体与拼装。
//
// ===========================================================================
// 编号与槽位规则
// ===========================================================================
//
//   一个「段」= 一个事件 = 一个会话内编号（eventNo）。
//   段的内部用标签分槽：
//
//       <recent-slot>   近期原文，全量保留   </recent-slot>
//       <summary-slot>  提炼后的有效信息     </summary-slot>
//
//   段随时间的推移降级：近期 → recent 与 summary 并存；更早 → 只剩 summary。

/** 槽位标签名。 */
export const SLOT_TAGS = {
  /** 近期全量原文 */
  recent: 'recent-slot',
  /** 提炼后的有效信息 */
  summary: 'summary-slot',
} as const

/** 槽位种类。 */
export type SlotKind = keyof typeof SLOT_TAGS

/** 一个槽位。 */
export interface Slot {
  readonly kind: SlotKind
  readonly text: string
}

/**
 * 段的生命周期阶段。
 *
 * - `live`：还在近期窗口内，原文与总结并存。
 * - `archived`：已滑出近期窗口，只剩总结。
 */
export type SegmentStage = 'live' | 'archived'

/** 一个封存段（内存表示）。 */
export interface Segment {
  /** 会话内编号：这是段的唯一标识 */
  readonly eventNo: number
  readonly sessionId: string
  /** 覆盖的 dsh seq 区间（闭区间） */
  readonly fromSeq: number
  readonly toSeq: number
  /** 被遮蔽的每个 surface 节点的 seq（dsh 的 sourceEventSeqs 需要） */
  readonly shadowedSeqs: readonly number[]
  /** 提炼后的有效信息 */
  readonly summary: string
  /** 近期原文（archived 阶段为空串） */
  readonly recent: string
  readonly stage: SegmentStage
  readonly turn: number
  readonly at: string
}

/**
 * 把若干槽位拼成一条消息正文。
 *
 * 空槽位不输出——`archived` 阶段的段只有 summary 一个槽。
 *
 * @param slots - 槽位（顺序即展示顺序）。
 * @returns 带标签的正文；全空时抛错（不能产出空段）。
 */
export function composeSlottedText(slots: readonly Slot[]): string {
  const used = slots.filter(s => s.text.trim().length > 0)
  if (used.length === 0) throw new Error('composeSlottedText requires at least one non-empty slot')
  return used
    .map(({ kind, text }) => `<${SLOT_TAGS[kind]}>\n${text}\n</${SLOT_TAGS[kind]}>`)
    .join('\n\n')
}

/** 判断一段文本是否已是带槽位的合并体（避免重复包装）。 */
export function isSlottedText(text: string): boolean {
  return text.includes(`<${SLOT_TAGS.recent}>`) || text.includes(`<${SLOT_TAGS.summary}>`)
}

/**
 * 判断一段内容「是否值得总结」。
 *
 * 用户要求：原文短 → 可以不总结；原文长 → 应该总结。
 * 阈值由本模块把控（调用方可用环境变量覆盖）。
 *
 * 为什么用字符数而不是 token 数：这里只需要一个稳定的量级判断，
 * 精确 token 计数要依赖 tokenizer，代价远大于收益。
 */
export const SUMMARIZE_THRESHOLD_CHARS = 4000
export const KEEP_ORIGINAL_THRESHOLD_CHARS = 1200

/** 对一段内容的具体处理建议。 */
export type SummarizeDecision =
  /** 太短，原文直接留，不必总结 */
  | { kind: 'keep-original'; reason: string }
  /** 中等长度：可总结也可不总结，由模型自己决定 */
  | { kind: 'optional'; reason: string }
  /** 较长：应当总结 */
  | { kind: 'should-summarize'; reason: string }

/**
 * 根据原文长度给出总结建议。
 *
 * @param chars - 该段原文的字符数。
 * @param thresholds - 可覆盖的阈值（测试与部署调参用）。
 */
export function decideSummarize(
  chars: number,
  thresholds: { keep?: number; summarize?: number } = {},
): SummarizeDecision {
  const keep = thresholds.keep ?? KEEP_ORIGINAL_THRESHOLD_CHARS
  const sum = thresholds.summarize ?? SUMMARIZE_THRESHOLD_CHARS
  if (chars <= keep) {
    return { kind: 'keep-original', reason: `${chars} chars ≤ ${keep}: 原文够短，直接保留` }
  }
  if (chars >= sum) {
    return { kind: 'should-summarize', reason: `${chars} chars ≥ ${sum}: 内容较长，应提炼有效信息` }
  }
  return { kind: 'optional', reason: `${chars} chars 介于 ${keep}–${sum}: 由模型自行决定是否提炼` }
}

/**
 * 构造「请提炼」的 user 提示。
 *
 * **关键要求（用户原话）**：这是提炼，不是压缩。
 * 必须保留**否决路径**——哪些方案被否了、为什么；
 * 不能只留最终结论。
 *
 * **且这条提示只出现一次**：它是触发总结的指令，不应该进入后续上下文。
 * 因此调用方负责在总结完成后让它不再回传（由 dsh 的 surface 遮蔽完成）。
 *
 * @param charCount - 被提炼内容的字符数，用于让模型知道规模。
 * @returns 提示文本。
 */
export function buildSummarizePrompt(charCount: number): string {
  return [
    `你需要提炼下面这段内容的**有效信息**，丢弃噪音。`,
    ``,
    `这不是压缩，是提炼。区别在于：`,
    `- 压缩会把一大段变成"最终方案：X"`,
    `- 提炼必须保留**否决路径**：哪些方案被否定了、为什么被否定`,
    ``,
    `期望的形态：`,
    `  否决方案 A：因为 <具体原因>`,
    `  否决方案 B：因为 <具体原因>`,
    `  ...`,
    `  最终方案：<结论>`,
    ``,
    `要求：`,
    `1. 每一处否决都要保留理由——这些理由往往是后续避免重蹈覆辙的关键`,
    `2. 保留具体的事实性细节（文件路径、数值、错误信息），不要泛化成抽象描述`,
    `3. 不要保留过程性的试错（同样的错误重复 N 次只写一次）`,
    `4. 总长度控制在原文的 10%–20%`,
    ``,
    `待提炼内容共约 ${charCount} 字符。`,
  ].join('\n')
}
