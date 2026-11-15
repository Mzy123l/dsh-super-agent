// 等待总结的状态（每会话最多一条）。
//
// 串行总结的时序：
//   1. 长单位产生 → 记录 pending（待总结的编号 + 注入的指令文本）
//   2. 模型回复提炼结果 → 收割：挂接 summary、清除 pending、撤掉指令与回复的发送视图
//
// 持久化而非放内存：模型回复可能跨进程重启，重启后要能接着收割。

import type DatabaseConstructor from 'better-sqlite3'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** 等待总结的状态。 */
export interface PendingSummary {
  readonly sessionId: string
  /** 待总结的单位编号 */
  readonly unitIdx: number
  /** 注入的提炼指令原文 */
  readonly promptText: string
  readonly createdAt: string
}

/**
 * 等待状态的仓储。
 *
 * 除 pending 本身外，还记录「提炼回复的文本指纹」：
 * 该回复是一次性产物，收割后不得作为普通 reply 单位入库，
 * 否则它会占编号并按 user 永不衰减的规则永久留存。
 */
export class PendingStore {
  constructor(private readonly db: BetterSqlite3) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summary_reply_fp (
        sessionId TEXT NOT NULL,
        fp        TEXT NOT NULL,
        at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reply_fp ON summary_reply_fp(sessionId, fp);
    `)
  }

  /**
   * 登记一条提炼回复的指纹（收割时调用）。
   *
   * @param sessionId - 会话 id。
   * @param text - 回复原文。
   */
  rememberReply(sessionId: string, text: string): void {
    const fp = fingerprint(text)
    this.db
      .prepare(`INSERT INTO summary_reply_fp (sessionId, fp, at) VALUES (?, ?, ?)`)
      .run(sessionId, fp, new Date().toISOString())
  }

  /**
   * 判断一段文本是否是已用过的提炼回复。
   *
   * @param sessionId - 会话 id。
   * @param text - 待判断的文本。
   */
  isConsumedReply(sessionId: string, text: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM summary_reply_fp WHERE sessionId = ? AND fp = ? LIMIT 1`)
      .get(sessionId, fingerprint(text)) as { hit: number } | undefined
    return row !== undefined
  }

  /** 清理某会话的指纹记录（会话重置时）。 */
  clearReplies(sessionId: string): void {
    this.db.prepare(`DELETE FROM summary_reply_fp WHERE sessionId = ?`).run(sessionId)
  }

  /** 取该会话的等待状态。 */
  get(sessionId: string): PendingSummary | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pending_summary WHERE sessionId = ?`)
      .get(sessionId) as
      | { sessionId: string; unitIdx: number; promptText: string; createdAt: string }
      | undefined
    return row ? { ...row } : undefined
  }

  /** 记录等待（覆盖旧值：同一会话同一时刻只安排一次总结）。 */
  set(p: PendingSummary): void {
    this.db
      .prepare(
        `INSERT INTO pending_summary (sessionId, unitIdx, promptText, createdAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (sessionId) DO UPDATE SET
           unitIdx = excluded.unitIdx, promptText = excluded.promptText, createdAt = excluded.createdAt`,
      )
      .run(p.sessionId, p.unitIdx, p.promptText, p.createdAt)
  }

  /** 清除。 */
  clear(sessionId: string): void {
    this.db.prepare(`DELETE FROM pending_summary WHERE sessionId = ?`).run(sessionId)
  }

  /** 列出全部（诊断）。 */
  list(): PendingSummary[] {
    return this.db.prepare(`SELECT * FROM pending_summary`).all() as PendingSummary[]
  }
}

/** 文本指纹（djb2，够快够稳，只需判等）。 */
function fingerprint(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  }
  return h.toString(36) + ':' + text.length
}
