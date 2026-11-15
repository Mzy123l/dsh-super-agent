// CJK 文本的 FTS 预处理
//
// FTS5 unicode61 tokenizer 把连续汉字串当作单个 token（"记成待办"是一个词），
// 用户查询"待办"无法命中——这正是规格 §4.1 说的"中文分词质量有限"。
//
// 处理：索引时把每个 CJK 字符用空格分隔，使其成为单字 token；
// 查询侧把 CJK 串转成单字 phrase（"待 办"），phrase 相邻性等价于子串匹配
// （跨标点的子串不会命中，符合直觉）。非 CJK 文本保持原样走 unicode61。

/** 判断一个字符是否 CJK（汉字扩展 A/B 区 + 基本区） */
function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df)
  )
}

/** 含 CJK 的字符串判断 */
export function hasCjk(text: string): boolean {
  for (const ch of text) {
    if (isCjkChar(ch)) return true
  }
  return false
}

/**
 * 索引侧：把文本里的 CJK 字符逐字用空格分隔（ latin 原样）。
 * "记成待办 ok" → "记 成 待 办 ok"
 */
export function segmentForFts(text: string): string {
  let out = ''
  let prevCjk = false
  for (const ch of text) {
    const cjk = isCjkChar(ch)
    if (cjk && out && !prevCjk && out.endsWith(' ') === false) out += ' '
    else if (cjk && prevCjk) out += ' '
    out += ch
    prevCjk = cjk
  }
  return out
}

/**
 * 查询侧：一个查询词 → FTS5 表达式。
 * CJK 词转单字 phrase："待办" → '"待 办"'；
 * 混合词拆 runs："日志abc" → '("日 志" AND "abc")'；
 * 纯 latin 保持 quoted word。
 */
export function termToFtsExpression(term: string): string {
  if (!hasCjk(term)) return `"${term.replace(/"/g, '""')}"`
  // 拆 CJK / 非 CJK runs
  const parts: string[] = []
  let current = ''
  let currentCjk = isCjkChar(term[0] ?? '')
  for (const ch of term) {
    const cjk = isCjkChar(ch)
    if (cjk !== currentCjk && current) {
      parts.push(current)
      current = ''
    }
    current += ch
    currentCjk = cjk
  }
  if (current) parts.push(current)
  // 各 run：CJK → 单字 phrase；非 CJK → quoted word
  const expressions = parts.map((part) => {
    if (isCjkChar(part[0] ?? '')) {
      const chars = [...part].join(' ')
      return `"${chars}"`
    }
    return `"${part.replace(/"/g, '""')}"`
  })
  if (expressions.length === 1) return expressions[0] as string
  return `(${expressions.join(' AND ')})`
}

/**
 * 查询侧：整段查询 → FTS5 表达式。
 *
 * 按空白切词，每个词各转一个表达式，词间用 AND 连接。
 * 全为空时返回空串（调用方据此跳过检索）。
 *
 * @param query - 用户查询文本。
 * @returns FTS5 MATCH 表达式；无有效词时为空串。
 */
export function buildFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(t => t.length > 0)
  if (terms.length === 0) return ''
  const expressions = terms.map(termToFtsExpression)
  return expressions.length === 1 ? expressions[0] as string : `(${expressions.join(' AND ')})`
}
