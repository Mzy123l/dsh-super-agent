// 发送投影：把编号单位渲染成实际发送给模型的文本。
//
// 两级展示（与压缩无关）：
//   近程（窗口内）：#N <summary>…</summary> + content
//   远程（窗口外）：#N <summary>…</summary>
//   未总结单位：原样保留（内容短，地位与 summary 等同）
//   user 单位：永不衰减，纯文本全发
//
// 这是纯函数：不调模型、不写库、不生成文本。

import type { Unit } from '../types.js'

/** 默认近程窗口（单位数量，完全不用 token）。 */
export const DEFAULT_WINDOW = 20

/** 渲染选项。 */
export interface RenderOptions {
  /** 近程窗口大小（单位数量） */
  window?: number
  /** 当前最新编号（用于计算窗口边界）；不给则用列表最大值 */
  latestIdx?: number
}

/**
 * 判断某单位是否在近程窗口内。
 *
 * @param idx - 单位编号。
 * @param latestIdx - 最新编号。
 * @param window - 窗口大小。
 */
export function isRecent(idx: number, latestIdx: number, window: number): boolean {
  return latestIdx - idx < window
}

/**
 * 渲染单个单位的发送文本。
 *
 * 格式按单位类型取最优（用户要求：不是所有东西统一规格）：
 *   - user：纯文本，永不衰减
 *   - thinking/reply：近程 `#N <summary>…</summary>\n<content>…</content>`；
 *                     远程 `#N <summary>…</summary>`
 *   - tool：结构标签本身即内容，近程保留完整工具块，远程只留 summary
 *   - 未总结单位：原样保留正文（地位等同于 summary）
 *
 * @param unit - 编号单位。
 * @param recent - 是否在近程窗口内。
 */
export function renderUnit(unit: Unit, recent: boolean): string {
  const head = `#${unit.idx}`

  // user 永不衰减
  if (unit.kind === 'user') return `${head} ${unit.content}`

  const hasSummary = unit.summary.trim().length > 0

  // 近程：summary + content 全发
  if (recent) {
    if (!hasSummary) return `${head} ${unit.content}`
    return `${head} <summary>${unit.summary}</summary>\n<content>${unit.content}</content>`
  }

  // 远程：有 summary 只发 summary
  if (hasSummary) return `${head} <summary>${unit.summary}</summary>`

  // 远程 + 未总结：原样保留（内容短）
  return `${head} ${unit.content}`
}

/**
 * 渲染一批单位的发送文本。
 *
 * @param units - 按编号升序的单位列表。
 * @param options - 窗口选项。
 * @returns 每个单位的发送文本（与输入同序）。
 */
export function renderUnits(units: readonly Unit[], options: RenderOptions = {}): string[] {
  const window = options.window ?? DEFAULT_WINDOW
  const latest = options.latestIdx ?? units.reduce((m, u) => Math.max(m, u.idx), 0)
  return units.map(u => renderUnit(u, isRecent(u.idx, latest, window)))
}

/**
 * 找出需要总结的单位（长单位必须，短单位可选）。
 *
 * @param units - 单位列表。
 * @param threshold - 长单位阈值（字符数）。
 * @returns 需要总结的单位（长单位优先，按编号升序）。
 */
export function unitsNeedingSummary(units: readonly Unit[], threshold: number): Unit[] {
  return units.filter(u => u.summary.trim().length === 0 && u.content.length >= threshold)
}

/**
 * 构造提炼指令。
 *
 * 整条用英文（用户要求：不用逐词翻译，直接写成英文）。
 *
 * 必须包含的要点：
 *   - 这是提炼，不是压缩：保留否决路径与否决理由，再给最终结论
 *   - **总结是后续取回这段上下文的唯一途径**，务必认真填写，
 *     否则关键信息会在以后丢失（用户新增要求）
 *   - 简短无价值的内容直接回 none（短单位可选的实现方式）
 *   - 只输出提炼结果
 *
 * @param idx - 目标单位编号。
 * @param kind - 单位类型。
 */
export function buildSummaryPrompt(idx: number, kind: string): string {
  const what = kind === 'thinking' ? 'reasoning trace' : kind === 'tool' ? 'tool call and its output' : 'reply'
  return [
    `Condense unit #${idx} (a ${what}) into its essential information and drop the noise.`,
    ``,
    `This is extraction, not compression. A compression would collapse everything into a bare conclusion,`,
    `and that is not what is wanted. Keep the reasoning that led to the outcome:`,
    `  rejected option: <what it was> — because <the concrete reason>`,
    `  ...`,
    `  chosen option: <what was settled on>`,
    `Preserve concrete facts (paths, numbers, error messages, names). Drop repeated trial and error.`,
    `Aim for roughly 10-20% of the original length.`,
    ``,
    `Important: this summary is the only way this span will be readable to you later.`,
    `Older units are dropped from the context and only the summary you write now survives;`,
    `whatever you leave out here is effectively lost. Write it carefully and completely enough`,
    `that you could resume the work from the summary alone.`,
    ``,
    `If the unit is short and holds nothing worth keeping, reply with exactly: none`,
    `Otherwise reply with the extraction only — no preamble, no commentary, no restating this instruction.`,
  ].join('\n')
}

/** 判断模型回复是否表示「不值得提炼」。 */
export function isNoSummary(reply: string): boolean {
  const t = reply.trim().toLowerCase()
  return t === 'none' || t === '无' || t === '無' || t === 'n/a' || t.length === 0
}
