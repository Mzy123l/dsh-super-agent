// 覆写（§7）：用户推翻自己先前的判断，或承认模型的结论才是对的。
//
// 关键原则：
//   * **只改 L1（summary），L0（content）永不改**
//   * 保留完整覆写记录（旧 summary + 原因 + 是谁推翻的）
//   * 发送视图标 [已覆写]，让模型知道这条被推翻过

import type DatabaseConstructor from 'better-sqlite3'
import type { OverrideRecord } from '../types-modules.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** override_log 表的行。 */
interface OverrideRow {
  override_no: number
  sessionId: string
  target_idx: number
  old_summary: string
  new_summary: string
  reason: string
  by_user: number
  created_at: string
}

/** 已覆写标记（放在发送视图的 summary 前缀）。 */
export const OVERRIDE_MARK = '[已覆写]'

/** 覆写仓储。 */
export class OverrideStore {
  constructor(private readonly db: BetterSqlite3) {}

  /**
   * 覆写某单位的 summary。
   *
   * L0 content 不动；只改 message.summary，并记一条 override_log。
   *
   * @param input - 覆写参数。
   * @returns 覆写记录编号；目标单位不存在时返回 undefined。
   */
  apply(input: {
    sessionId: string
    targetIdx: number
    newSummary: string
    reason: string
    byUser?: boolean
  }): number | undefined {
    const existing = this.db
      .prepare(`SELECT row_id, summary FROM message WHERE sessionId = ? AND idx = ?`)
      .get(input.sessionId, input.targetIdx) as { row_id: number; summary: string } | undefined
    if (!existing) return undefined

    const now = new Date().toISOString()
    const newSummary = input.newSummary.trim()
    // 发送视图里带上覆写标记，模型能看出这条被推翻过
    const stored = newSummary.startsWith(OVERRIDE_MARK)
      ? newSummary
      : `${OVERRIDE_MARK} ${newSummary}`

    this.db
      .prepare(`UPDATE message SET summary = ? WHERE row_id = ?`)
      .run(stored, existing.row_id)

    const info = this.db
      .prepare(
        `INSERT INTO override_log
           (sessionId, target_idx, old_summary, new_summary, reason, by_user, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.targetIdx,
        existing.summary,
        newSummary,
        input.reason,
        input.byUser === false ? 0 : 1,
        now,
      )

    return Number(info.lastInsertRowid)
  }

  /** 某单位的覆写历史（按时间升序）。 */
  historyOf(sessionId: string, targetIdx: number): OverrideRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM override_log WHERE sessionId = ? AND target_idx = ? ORDER BY override_no ASC`,
      )
      .all(sessionId, targetIdx) as OverrideRow[]
    return rows.map(toRecord)
  }

  /** 该会话的全部覆写记录（按时间升序）。 */
  list(sessionId: string): OverrideRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM override_log WHERE sessionId = ? ORDER BY override_no ASC`)
      .all(sessionId) as OverrideRow[]
    return rows.map(toRecord)
  }

  /** 统计。 */
  count(sessionId: string): number {
    return (this.db
      .prepare(`SELECT COUNT(*) AS n FROM override_log WHERE sessionId = ?`)
      .get(sessionId) as { n: number }).n
  }
}

function toRecord(row: OverrideRow): OverrideRecord {
  return {
    overrideNo: row.override_no,
    sessionId: row.sessionId,
    targetIdx: row.target_idx,
    oldSummary: row.old_summary,
    newSummary: row.new_summary,
    reason: row.reason,
    byUser: row.by_user === 1,
    createdAt: row.created_at,
  }
}

/** 把覆写历史渲染成给模型看的文本。 */
export function renderOverrideHistory(records: readonly OverrideRecord[]): string {
  if (records.length === 0) return '（没有覆写记录）'
  return records
    .map(r => {
      const who = r.byUser ? '用户推翻自己' : '用户承认模型对'
      return [
        `#${r.targetIdx}  ${r.createdAt}  ${who}`,
        `  旧：${r.oldSummary || '（空）'}`,
        `  新：${r.newSummary}`,
        `  原因：${r.reason}`,
      ].join('\n')
    })
    .join('\n\n')
}
