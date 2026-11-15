// 收紧收割：判断一段 assistant 回复是否真的在回答提炼指令。
//
// ===========================================================================
// 为什么需要这个
// ===========================================================================
//
// 实测暴露的串位 bug：旧收割逻辑只看「pending 之后最新的一条 assistant 消息」，
// 任何一句话都会被当成摘要收走。证据：
//
//   #2  <system-reminder> A skill is a reusable…   ← 摘要「逐文件把换行符统一为 LF」
//   #8  find ... *memory* | head -50               ← 摘要「diff 从 2103 行降到 456 行」
//
// 三条零重合。根因是模型在提炼轮中说了一句过程性的话（「我先查一下…」），
// 那句被当成摘要挂到了不相干的单位上，而真正的提炼回复反而没被采用。
//
// ===========================================================================
// 三道校验
// ===========================================================================
//
//   1. 长度上限：摘要超过原文 40% → 没收敛，拒绝
//   2. 过程性开场：以「我先/现在把/开始改…」开头 → 是在干活，不是提炼，拒绝
//   3. 实词重合：与原文的实词重合率 < 15% → 串位，拒绝
//
// 三道都过才算合法摘要。任一失败 → 拒收，**保留 pending 等下一轮**。

/** 校验结果。 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean }

/** 中文过程性开场（模型在汇报工作，不是在提炼）。 */
const PROCESS_OPENERS = [
  '我先',
  '我再',
  '我现在',
  '现在把',
  '现在让',
  '现在改',
  '开始改',
  '开始实现',
  '让我先',
  '让我看',
  '我来',
  '我先把',
  '我确认',
  '我查',
  '我先查',
  '先查',
  '先确认',
  '先看',
  '接下来我',
  '然后我',
]

/** 英文过程性开场。 */
const PROCESS_OPENERS_EN = [
  'let me ',
  'i will ',
  "i'll ",
  'now let',
  'now i',
  'first let',
  'first, let',
  'the task:',
  'the user wants',
  'i should ',
  'i need to ',
]

/** 摘要长度上限（相对原文的比例）。 */
export const SUMMARY_MAX_RATIO = 0.6

/** 实词重合率下限。 */
export const SUMMARY_MIN_OVERLAP = 0.15

/** 停用词（不参与重合度计算）。 */
const STOP_WORDS = new Set([
  'tool', 'call', 'name', 'bash', 'echo', 'true', 'false', 'json',
  'command', 'description', 'result', 'error', 'content', 'text',
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'been',
  'code', 'file', 'files', 'line', 'lines', 'true', 'none', 'null',
])

/**
 * 抽取实词（用于重合度比较）。
 *
 * 英文取长度 ≥ 4 的标识符/单词；中文取连续 2 字以上的片段。
 *
 * @param text - 原文或摘要。
 */
export function extractTerms(text: string): string[] {
  const out = new Set<string>()

  // 英文/标识符
  for (const m of text.matchAll(/[a-zA-Z_][a-zA-Z0-9_-]{3,}/g)) {
    const w = m[0].toLowerCase()
    if (!STOP_WORDS.has(w)) out.add(w)
  }

  // 中文双字词（粗略切分：每两个连续汉字）
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjk) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const w = run.slice(i, i + 2)
      if (!STOP_WORDS.has(w)) out.add(w)
    }
  }

  return [...out]
}

/**
 * 计算摘要与原文的实词重合率。
 *
 * @param summary - 摘要文本。
 * @param content - 单位原文。
 * @returns 0–1 的重合率；原文无可比实词时返回 1（不误杀）。
 */
export function termOverlap(summary: string, content: string): number {
  const contentTerms = extractTerms(content)
  if (contentTerms.length === 0) return 1
  const summaryTerms = new Set(extractTerms(summary))
  let hit = 0
  for (const t of contentTerms) {
    if (summaryTerms.has(t)) hit += 1
  }
  return hit / contentTerms.length
}

/** 判断是否以过程性语句开头。 */
export function startsWithProcessOpener(text: string): boolean {
  const head = text.trim().slice(0, 40).toLowerCase()
  if (PROCESS_OPENERS.some(p => head.startsWith(p))) return true
  if (PROCESS_OPENERS_EN.some(p => head.startsWith(p))) return true
  return false
}

/**
 * 校验一段回复是否是合法的提炼结果。
 *
 * @param summary - 模型回复（已 trim）。
 * @param content - 被提炼单位的原文。
 * @returns 校验结果；失败时带是否可重试。
 */
export function validateSummary(summary: string, content: string): ValidationResult {
  const s = summary.trim()
  if (s.length === 0) {
    return { ok: false, reason: '空回复', retryable: true }
  }

  // 过程性开场：模型还在干活，不是提炼结果
  if (startsWithProcessOpener(s)) {
    return {
      ok: false,
      reason: `以过程性语句开头（"${s.slice(0, 20)}…"），不是提炼结果`,
      retryable: true,
    }
  }

  // 长度上限：超过原文 40% 说明没收敛
  const ratio = content.length > 0 ? s.length / content.length : 0
  if (content.length > 0 && ratio > SUMMARY_MAX_RATIO) {
    return {
      ok: false,
      reason: `摘要长度 ${s.length} 占原文 ${content.length} 的 ${(ratio * 100).toFixed(0)}%，超过 ${(SUMMARY_MAX_RATIO * 100).toFixed(0)}% 上限，未收敛`,
      retryable: true,
    }
  }

  // 实词重合：串位的直接判据
  const overlap = termOverlap(s, content)
  if (overlap < SUMMARY_MIN_OVERLAP) {
    return {
      ok: false,
      reason: `与原文实词重合仅 ${(overlap * 100).toFixed(0)}%（低于 ${(SUMMARY_MIN_OVERLAP * 100).toFixed(0)}%），疑似串位`,
      retryable: true,
    }
  }

  return { ok: true }
}
