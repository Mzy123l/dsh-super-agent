// 事件 → 可索引记录。四条用户决策的落实点：
// ① reasoning 只进 reasoning 表（供向量化），绝不进 FTS；
// ③ 搜索全量：直接遍历原始事件流（不读 surface 投影），每条记录带 shadowed 标记；
// 摘要（compaction/summary）照常索引——它只是历史的一部分；
// ④ 本模块无任何主动注入逻辑——只做被动提取。

import type {
  ExtractResult,
  MemoryRecord,
  ReasoningRecord,
  RecordKind,
} from '../types.js'
import type { RawContentBlock, RawEvent } from './raw-types.js'

/** tool-call 参数摘要截断长度（规格 §3：JSON.stringify(args).slice(0, 500)） */
const TOOL_ARGS_SLICE = 500
/** 可索引正文上限（超长截断，防止 FTS 与向量库被单条巨型结果撑爆） */
export const TEXT_SLICE = 4000

/** ISO 时间格式化（epoch ms → ISO；缺时间用空串） */
function isoTime(timeMs?: number): string {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return ''
  return new Date(timeMs).toISOString()
}

/** 拼接内容块里的可见 text */
function joinText(blocks?: RawContentBlock[]): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** 截断正文 */
function clip(text: string, max = TEXT_SLICE): string {
  return text.length > max ? text.slice(0, max) : text
}

/** 空白正文的占位（图片/二进制等不可索引内容） */
const EMPTY_PLACEHOLDER = '（未索引内容）'

/**
 * 提取核心：把一个会话的全部原始事件转为 records + reasoning。
 *
 * 全量遍历事件（决策③），不读 surface 投影。shadowed 信息来自
 * compaction/summary 与 compaction/prune 事件的 shadowedSeqs 字段：
 * 一个 seq 一旦被压缩事件声明遮蔽，即视为 shadowed（98 文档：遮蔽的是
 * surface 节点，这里以"seq 是否出现在 shadowedSeqs"为口径）。
 */
export function extractFromEvents(sessionId: string, events: RawEvent[]): ExtractResult {
  const records: MemoryRecord[] = []
  const reasoning: ReasoningRecord[] = []
  const shadowedSeqs = new Set<number>()
  const turnStarts = new Map<number, number>()
  let lastSeq = 0
  let eventCount = 0
  let parseErrors = 0

  for (const ev of events) {
    eventCount += 1
    if (typeof ev?.seq === 'number' && ev.seq > lastSeq) lastSeq = ev.seq
    if (!ev || typeof ev.type !== 'string') {
      parseErrors += 1
      continue
    }
    const data = ev.data ?? {}
    const at = isoTime(ev.time)
    const turn = typeof data.turn === 'number' ? data.turn : undefined

    // 收集压缩遮蔽信息（决策③：被遮蔽的事件照常索引，只补标记）
    if (ev.type === 'compaction/summary' || ev.type === 'compaction/prune') {
      for (const s of data.shadowedSeqs ?? []) shadowedSeqs.add(s)
    }

    // turn/start：seq → turn 归属表（user/message 等无 turn 字段的事件借此归属轮次）
    if (ev.type === 'turn/start' && typeof data.turn === 'number') {
      turnStarts.set(ev.seq, data.turn)
    }

    switch (ev.type) {
      // ---- 用户/注入消息：可见文本进 FTS + 向量 ----
      case 'user/message': {
        const text = joinText(data.content)
        if (!text) break
        const kind: RecordKind = 'user'
        records.push({
          seq: ev.seq,
          sessionId,
          kind,
          at,
          text: clip(text),
          turn: turn ?? resolveTurn(turnStarts, ev.seq),
        })
        break
      }

      // ---- 助手消息：可见文本进 FTS + 向量；reasoning 只进 reasoning（决策①）----
      case 'assistant/message': {
        const blocks = data.message?.content
        if (!Array.isArray(blocks)) break
        const visible = joinText(blocks)
        if (visible) {
          records.push({
            seq: ev.seq,
            sessionId,
            kind: 'assistant',
            at,
            text: clip(visible),
            turn: turn ?? resolveTurn(turnStarts, ev.seq),
          })
        }
        // 决策①：reasoning 块单独收集，绝不进 records/FTS
        const think = blocks
          .filter((b) => b.type === 'reasoning' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
        if (think) {
          reasoning.push({
            seq: ev.seq,
            sessionId,
            at,
            turn: turn ?? resolveTurn(turnStarts, ev.seq),
            text: clip(think, TEXT_SLICE),
          })
        }
        break
      }

      // ---- 工具调用：工具名 + 参数摘要，只进 FTS（参数无语义价值，不向量化）----
      case 'tool/call': {
        const argsSummary = clip(
          typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? ''),
          TOOL_ARGS_SLICE,
        )
        records.push({
          seq: ev.seq,
          sessionId,
          kind: 'tool-call',
          at,
          text: clip(`${data.name ?? 'unknown-tool'} ${argsSummary}`),
          turn: turn ?? resolveTurn(turnStarts, ev.seq),
        })
        break
      }

      // ---- 工具结果：进 FTS + 向量；prune 状态按替换文本里的标记识别 ----
      case 'tool/result': {
        const text = joinText(data.message?.content)
        // 98 文档：59/59 次 prune 的替换文本都含该标记
        const pruned = text.includes('[... tool result middle pruned ...]')
        const body = text
          ? (pruned ? `${text}\n（本条曾被 compaction/prune 裁剪，中间内容不在日志中）` : text)
          : EMPTY_PLACEHOLDER
        records.push({
          seq: ev.seq,
          sessionId,
          kind: 'tool-result',
          at,
          text: clip(body),
          turn: turn ?? resolveTurn(turnStarts, ev.seq),
        })
        break
      }

      // ---- 压缩摘要：kind=summary，照常索引（"发生过压缩"的事实，可检索）----
      case 'compaction/summary': {
        const text = joinText(data.summary) || joinText(data.content)
        records.push({
          seq: ev.seq,
          sessionId,
          kind: 'summary',
          at,
          text: clip(text || EMPTY_PLACEHOLDER),
          turn: turn ?? resolveTurn(turnStarts, ev.seq),
        })
        break
      }

      // ---- 图片/二进制/其他类型：跳过正文提取 ----
      default:
        break
    }
  }

  return { records, reasoning, shadowedSeqs, turnStarts, lastSeq, eventCount, parseErrors }
}

/**
 * 归属轮次：无自带 turn 的事件（如 user/message）按"其之前最近一个 turn/start 的 seq"
 * 归属。turnStarts 按 seq 升序构建，这里二分查找。
 */
function resolveTurn(turnStarts: Map<number, number>, seq: number): number | undefined {
  let best: number | undefined
  for (const [startSeq, turn] of turnStarts) {
    if (startSeq <= seq) best = turn
    else break
  }
  return best
}
