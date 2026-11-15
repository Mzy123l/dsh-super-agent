// 待注入状态（awaiting）的持久化。
//
// 为什么需要持久化而不是放内存：模型回复可能跨进程重启，
// 重启后要能接着收割，否则提示注入了却没收到结果，历史就会卡住。

import type DatabaseConstructor from 'better-sqlite3'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** 等待提炼结果的状态。 */
export interface PendingInject {
  readonly sessionId: string
  /** 待提炼区间的起止 seq */
  readonly fromSeq: number
  readonly toSeq: number
  /** 区间所在轮次 */
  readonly turn: number
  /** 注入的提示原文（用于诊断） */
  readonly promptText: string
  readonly createdAt: string
}

/** 建表（幂等）。 */
const CREATE_PENDING = `
CREATE TABLE IF NOT EXISTS pending_inject (
  sessionId   TEXT PRIMARY KEY,
  fromSeq     INTEGER NOT NULL,
  toSeq       INTEGER NOT NULL,
  turn        INTEGER NOT NULL,
  promptText  TEXT NOT NULL,
  createdAt   TEXT NOT NULL
);
`

/** 待注入状态仓储：每个会话最多一条（同一时刻只安排一次提炼）。 */
export class PendingStore {
  constructor(private readonly db: BetterSqlite3) {
    this.db.exec(CREATE_PENDING)
  }

  /** 读取该会话的等待状态。 */
  getAwaiting(sessionId: string): PendingInject | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pending_inject WHERE sessionId = ?`)
      .get(sessionId) as
      | { sessionId: string; fromSeq: number; toSeq: number; turn: number; promptText: string; createdAt: string }
      | undefined
    return row ? { ...row } : undefined
  }

  /** 标记为等待吸收。覆盖旧值（同一会话只保留最新一次安排）。 */
  markAwaiting(p: PendingInject): void {
    this.db
      .prepare(
        `INSERT INTO pending_inject (sessionId, fromSeq, toSeq, turn, promptText, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (sessionId) DO UPDATE SET
           fromSeq = excluded.fromSeq, toSeq = excluded.toSeq, turn = excluded.turn,
           promptText = excluded.promptText, createdAt = excluded.createdAt`,
      )
      .run(p.sessionId, p.fromSeq, p.toSeq, p.turn, p.promptText, p.createdAt)
  }

  /** 清除该会话的等待状态。 */
  clear(sessionId: string): void {
    this.db.prepare(`DELETE FROM pending_inject WHERE sessionId = ?`).run(sessionId)
  }

  /** 列出全部等待（诊断用）。 */
  list(): PendingInject[] {
    return this.db.prepare(`SELECT * FROM pending_inject ORDER BY createdAt ASC`).all() as PendingInject[]
  }

  /** 统计。 */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM pending_inject`).get() as { n: number }).n
  }
}
