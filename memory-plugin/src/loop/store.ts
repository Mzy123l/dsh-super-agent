// 等待提炼的状态（每会话最多一条）。
//
// 持久化而非放内存：模型回复可能跨进程重启，重启后要能接着收割。

import type DatabaseConstructor from 'better-sqlite3'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** 等待提炼的状态。 */
export interface PendingInject {
  readonly sessionId: string
  /** 待提炼的索引区间 */
  readonly fromIdx: number
  readonly toIdx: number
  readonly promptText: string
  readonly createdAt: string
}

/** 待注入状态仓储。 */
export class PendingStore {
  constructor(private readonly db: BetterSqlite3) {}

  getAwaiting(sessionId: string): PendingInject | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pending_inject WHERE sessionId = ?`)
      .get(sessionId) as
      | { sessionId: string; from_idx: number; to_idx: number; promptText: string; createdAt: string }
      | undefined
    if (!row) return undefined
    return {
      sessionId: row.sessionId,
      fromIdx: row.from_idx,
      toIdx: row.to_idx,
      promptText: row.promptText,
      createdAt: row.createdAt,
    }
  }

  markAwaiting(p: PendingInject): void {
    this.db
      .prepare(
        `INSERT INTO pending_inject (sessionId, from_idx, to_idx, promptText, createdAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sessionId) DO UPDATE SET
           from_idx = excluded.from_idx, to_idx = excluded.to_idx,
           promptText = excluded.promptText, createdAt = excluded.createdAt`,
      )
      .run(p.sessionId, p.fromIdx, p.toIdx, p.promptText, p.createdAt)
  }

  clear(sessionId: string): void {
    this.db.prepare(`DELETE FROM pending_inject WHERE sessionId = ?`).run(sessionId)
  }

  list(): PendingInject[] {
    const rows = this.db.prepare(`SELECT * FROM pending_inject`).all() as Array<{
      sessionId: string
      from_idx: number
      to_idx: number
      promptText: string
      createdAt: string
    }>
    return rows.map(r => ({
      sessionId: r.sessionId,
      fromIdx: r.from_idx,
      toIdx: r.to_idx,
      promptText: r.promptText,
      createdAt: r.createdAt,
    }))
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM pending_inject`).get() as { n: number }).n
  }
}
