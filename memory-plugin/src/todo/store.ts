// 待办台账（§6）。
//
// 待办 = 现在不做、留到以后的挂起项。**不是规划步骤**。
//
// 核心价值：用户只记得"有待办"，不知道剩下什么。
// `list` 不需要关键词——直接返回所有 open 项。

import type DatabaseConstructor from 'better-sqlite3'
import type { Todo, TodoStatus } from '../types-modules.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** todo 表的行。 */
interface TodoRow {
  todo_no: number
  sessionId: string
  title: string
  detail: string
  status: string
  from_idx: number | null
  drop_reason: string
  created_at: string
  updated_at: string
}

/** 待办仓储。 */
export class TodoStore {
  constructor(private readonly db: BetterSqlite3) {}

  /**
   * 新增待办。
   *
   * @returns 待办编号。
   */
  add(input: {
    sessionId: string
    title: string
    detail?: string
    fromIdx?: number
  }): number {
    const now = new Date().toISOString()
    const info = this.db
      .prepare(
        `INSERT INTO todo (sessionId, title, detail, status, from_idx, drop_reason, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, '', ?, ?)`,
      )
      .run(
        input.sessionId,
        input.title,
        input.detail ?? '',
        input.fromIdx ?? null,
        now,
        now,
      )
    return Number(info.lastInsertRowid)
  }

  /** 按编号取。 */
  get(sessionId: string, todoNo: number): Todo | undefined {
    const row = this.db
      .prepare(`SELECT * FROM todo WHERE sessionId = ? AND todo_no = ?`)
      .get(sessionId, todoNo) as TodoRow | undefined
    return row ? toTodo(row) : undefined
  }

  /**
   * 列出待办。
   *
   * @param sessionId - 会话。
   * @param filter - 'open' 只列未完成；'all' 列全部。
   */
  list(sessionId: string, filter: 'open' | 'all' = 'open'): Todo[] {
    const rows = filter === 'open'
      ? this.db
          .prepare(`SELECT * FROM todo WHERE sessionId = ? AND status = 'open' ORDER BY todo_no ASC`)
          .all(sessionId) as TodoRow[]
      : this.db
          .prepare(`SELECT * FROM todo WHERE sessionId = ? ORDER BY todo_no ASC`)
          .all(sessionId) as TodoRow[]
    return rows.map(toTodo)
  }

  /** 标记完成。 */
  done(sessionId: string, todoNo: number): boolean {
    return this.setStatus(sessionId, todoNo, 'done', '')
  }

  /** 放弃（带原因）。 */
  drop(sessionId: string, todoNo: number, reason: string): boolean {
    return this.setStatus(sessionId, todoNo, 'dropped', reason)
  }

  /** 恢复为 open。 */
  reopen(sessionId: string, todoNo: number): boolean {
    return this.setStatus(sessionId, todoNo, 'open', '')
  }

  /** 改状态。 */
  private setStatus(sessionId: string, todoNo: number, status: TodoStatus, reason: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE todo SET status = ?, drop_reason = ?, updated_at = ?
         WHERE sessionId = ? AND todo_no = ?`,
      )
      .run(status, reason, new Date().toISOString(), sessionId, todoNo)
    return info.changes > 0
  }

  /** 统计。 */
  stats(sessionId: string): { open: number; done: number; dropped: number } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM todo WHERE sessionId = ? GROUP BY status`)
      .all(sessionId) as Array<{ status: string; n: number }>
    const out = { open: 0, done: 0, dropped: 0 }
    for (const r of rows) {
      if (r.status === 'open') out.open = r.n
      else if (r.status === 'done') out.done = r.n
      else if (r.status === 'dropped') out.dropped = r.n
    }
    return out
  }
}

function toTodo(row: TodoRow): Todo {
  return {
    todoNo: row.todo_no,
    sessionId: row.sessionId,
    title: row.title,
    detail: row.detail,
    status: row.status as TodoStatus,
    fromIdx: row.from_idx ?? undefined,
    dropReason: row.drop_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 把待办列表渲染成给模型看的紧凑视图。 */
export function renderTodoList(todos: readonly Todo[]): string {
  if (todos.length === 0) return '（没有未完成的待办）'
  return todos
    .map(t => {
      const src = t.fromIdx !== undefined ? ` [来自 #${t.fromIdx}]` : ''
      const detail = t.detail.trim().length > 0 ? `\n  ${t.detail.replace(/\n/g, '\n  ')}` : ''
      return `- #${t.todoNo} ${t.title}${src}${detail}`
    })
    .join('\n')
}
