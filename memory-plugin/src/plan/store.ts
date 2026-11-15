// 规划模块（§8）。
//
// 三个概念分清：
//   goal   = 什么算成功
//   规划    = 怎么干（架构、顺序、依赖），可覆写、可重建、可削弱
//   待办    = 现在不做、留到以后（在 todo/store.ts，不在这里）
//
// 关键规则：
//   * 准入只问时间，不问"是否需要规划"、不问步数
//   * 每个版本强制命名（1-60 字符），缺失拒绝写操作
//   * 任何变更 version+1，已完成步骤绝不作废
//   * 追加任务：前面的权重削弱，后面的权重拉满
//   * 版本历史永不覆盖，回滚也是追加

import type DatabaseConstructor from 'better-sqlite3'
import type {
  Plan,
  PlanChangeKind,
  PlanDecision,
  PlanSnapshot,
  PlanStatus,
  PlanStep,
  PlanVersion,
} from '../types-modules.js'

type BetterSqlite3 = ReturnType<typeof DatabaseConstructor>

/** 规划准入时间阈值（分钟）：≥ 该值建规划。 */
export const PLAN_TIME_THRESHOLD_MIN = 5

/** 版本名长度限制。 */
export const PLAN_NAME_MIN = 1
export const PLAN_NAME_MAX = 60

/** 无信息量的版本名（拒绝）。 */
const LOW_INFO_NAMES = new Set(['更新', '修改', '调整', '计划', '调整计划', '变更', 'v1', 'v2', 'v3', 'update', 'change'])

/** plan 表的行。 */
interface PlanRow {
  sessionId: string
  version: number
  name: string
  goal: string
  estimate_min: number | null
  steps: string
  decisions: string
  status: string
  created_at: string
  updated_at: string
}

/** plan_version 表的行。 */
interface PlanVersionRow {
  plan_no: number
  sessionId: string
  version: number
  name: string
  snapshot: string
  change_kind: string
  reason: string
  created_at: string
}

/** 版本名校验结果。 */
export type NameCheck = { ok: true } | { ok: false; error: string }

/**
 * 校验版本名。
 *
 * 强制必填：1–60 字符，不能是纯空白或无信息量的词。
 *
 * @param name - 版本名。
 */
export function checkPlanName(name: string | undefined): NameCheck {
  const n = (name ?? '').trim()
  if (n.length < PLAN_NAME_MIN) return { ok: false, error: '版本名必填（1–60 字符）' }
  if (n.length > PLAN_NAME_MAX) return { ok: false, error: `版本名过长（${n.length} > ${PLAN_NAME_MAX}）` }
  if (LOW_INFO_NAMES.has(n.toLowerCase())) {
    return { ok: false, error: `版本名「${n}」没有信息量，请描述本次变更做了什么` }
  }
  return { ok: true }
}

/**
 * 根据自估时间判断是否需要建规划。
 *
 * **只问时间，不问"是否需要规划"、不问步数。**
 *
 * @param estimateMin - 模型自估完成时间（分钟）；未给时按需要规划处理。
 */
export function needsPlan(estimateMin: number | undefined): boolean {
  if (estimateMin === undefined) return true
  return estimateMin >= PLAN_TIME_THRESHOLD_MIN
}

/** 规划仓储。 */
export class PlanStore {
  constructor(private readonly db: BetterSqlite3) {}

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /** 取当前计划。 */
  get(sessionId: string): Plan | undefined {
    const row = this.db.prepare(`SELECT * FROM plan WHERE sessionId = ?`).get(sessionId) as PlanRow | undefined
    return row ? toPlan(row) : undefined
  }

  /** 版本历史（按版本升序）。 */
  history(sessionId: string): PlanVersion[] {
    const rows = this.db
      .prepare(`SELECT * FROM plan_version WHERE sessionId = ? ORDER BY version ASC`)
      .all(sessionId) as PlanVersionRow[]
    return rows.map(toVersion)
  }

  /** 取某一版。 */
  version(sessionId: string, version: number): PlanVersion | undefined {
    const row = this.db
      .prepare(`SELECT * FROM plan_version WHERE sessionId = ? AND version = ?`)
      .get(sessionId, version) as PlanVersionRow | undefined
    return row ? toVersion(row) : undefined
  }

  // -------------------------------------------------------------------------
  // 写入（全部要求版本名）
  // -------------------------------------------------------------------------

  /**
   * 创建初始计划。
   *
   * @returns 新版本号；校验失败时返回错误。
   */
  create(input: {
    sessionId: string
    name: string
    goal: string
    estimateMin?: number
    steps: PlanStep[]
    decisions?: PlanDecision[]
  }): { ok: true; version: number } | { ok: false; error: string } {
    const check = checkPlanName(input.name)
    if (!check.ok) return check
    if (this.get(input.sessionId)) return { ok: false, error: '该会话已有计划，请用 update/replan' }

    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO plan (sessionId, version, name, goal, estimate_min, steps, decisions, status, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        input.sessionId,
        input.name.trim(),
        input.goal,
        input.estimateMin ?? null,
        JSON.stringify(input.steps),
        JSON.stringify(input.decisions ?? []),
        now,
        now,
      )

    this.writeVersion(input.sessionId, 1, input.name, {
      goal: input.goal,
      estimateMin: input.estimateMin,
      steps: input.steps,
      decisions: input.decisions ?? [],
    }, 'init', input.name.trim())

    return { ok: true, version: 1 }
  }

  /**
   * 更新计划（扩展/修订/重建）。
   *
   * 已完成步骤**绝不作废**：调用方传入的 steps 里若缺了已完成的步骤，
   * 会自动补回（保留记录）。
   *
   * @returns 新版本号。
   */
  update(input: {
    sessionId: string
    name: string
    reason?: string
    changeKind: PlanChangeKind
    steps?: PlanStep[]
    decisions?: PlanDecision[]
    goal?: string
    estimateMin?: number
    status?: PlanStatus
  }): { ok: true; version: number } | { ok: false; error: string } {
    const check = checkPlanName(input.name)
    if (!check.ok) return check

    const current = this.get(input.sessionId)
    if (!current) return { ok: false, error: '该会话还没有计划，请先 create' }

    const steps = mergeSteps(current.steps, input.steps ?? current.steps)
    const decisions = input.decisions ?? current.decisions
    const goal = input.goal ?? current.goal
    const version = current.version + 1
    const now = new Date().toISOString()

    this.db
      .prepare(
        `UPDATE plan SET version = ?, name = ?, goal = ?, estimate_min = ?,
           steps = ?, decisions = ?, status = ?, updated_at = ?
         WHERE sessionId = ?`,
      )
      .run(
        version,
        input.name.trim(),
        goal,
        input.estimateMin ?? current.estimateMin ?? null,
        JSON.stringify(steps),
        JSON.stringify(decisions),
        input.status ?? current.status,
        now,
        input.sessionId,
      )

    this.writeVersion(
      input.sessionId,
      version,
      input.name,
      { goal, estimateMin: input.estimateMin ?? current.estimateMin, steps, decisions },
      input.changeKind,
      input.reason ?? input.name.trim(),
    )

    return { ok: true, version }
  }

  /**
   * 追加任务：前面的权重削弱，新的拉满（§8.7）。
   *
   * @param newSteps - 新任务步骤（权重会被设为 1.0）。
   * @param weakenTo - 已有未完成步骤削弱到的权重（默认 0.3）。
   */
  extend(input: {
    sessionId: string
    name: string
    reason?: string
    newSteps: PlanStep[]
    weakenTo?: number
  }): { ok: true; version: number } | { ok: false; error: string } {
    const current = this.get(input.sessionId)
    if (!current) return { ok: false, error: '该会话还没有计划' }

    const weakenTo = input.weakenTo ?? 0.3
    const weakened = current.steps.map(s => {
      if (s.status === 'done') return { ...s, weight: 0 }        // 已完成：归零，可尽快折叠
      if (s.status === 'dropped') return s
      return { ...s, weight: Math.min(s.weight, weakenTo) }       // 未完成：降级
    })
    const added = input.newSteps.map(s => ({ ...s, weight: 1.0 }))

    return this.update({
      sessionId: input.sessionId,
      name: input.name,
      reason: input.reason ?? `追加 ${added.length} 个步骤`,
      changeKind: 'extend',
      steps: [...weakened, ...added],
    })
  }

  /**
   * 回滚到某版：**产生新版本**，旧版本全部保留。
   *
   * @param targetVersion - 目标版本号。
   * @param name - 新版本名（强制）。
   */
  revert(input: {
    sessionId: string
    targetVersion: number
    name: string
    reason?: string
  }): { ok: true; version: number } | { ok: false; error: string } {
    const check = checkPlanName(input.name)
    if (!check.ok) return check

    const target = this.version(input.sessionId, input.targetVersion)
    if (!target) return { ok: false, error: `没有版本 ${input.targetVersion}` }
    const current = this.get(input.sessionId)
    if (!current) return { ok: false, error: '该会话还没有计划' }

    let snap: PlanSnapshot
    try {
      snap = JSON.parse(target.snapshot) as PlanSnapshot
    } catch {
      return { ok: false, error: '目标版本快照损坏' }
    }

    const version = current.version + 1
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE plan SET version = ?, name = ?, goal = ?, estimate_min = ?,
           steps = ?, decisions = ?, status = 'active', updated_at = ?
         WHERE sessionId = ?`,
      )
      .run(
        version,
        input.name.trim(),
        snap.goal,
        snap.estimateMin ?? null,
        JSON.stringify(snap.steps),
        JSON.stringify(snap.decisions),
        now,
        input.sessionId,
      )

    this.writeVersion(
      input.sessionId,
      version,
      input.name,
      snap,
      'revert',
      input.reason ?? `回滚到 v${input.targetVersion}`,
    )

    return { ok: true, version }
  }

  /**
   * 更新单个步骤状态（也算一次版本变更，需版本名）。
   */
  setStep(input: {
    sessionId: string
    stepId: string
    status: PlanStep['status']
    name: string
    note?: string
  }): { ok: true; version: number } | { ok: false; error: string } {
    const current = this.get(input.sessionId)
    if (!current) return { ok: false, error: '该会话还没有计划' }

    const idx = current.steps.findIndex(s => s.id === input.stepId)
    if (idx < 0) return { ok: false, error: `没有步骤 ${input.stepId}` }

    const steps = current.steps.map((s, i) =>
      i === idx
        ? { ...s, status: input.status, ...(input.note !== undefined ? { note: input.note } : {}) }
        : s,
    )

    return this.update({
      sessionId: input.sessionId,
      name: input.name,
      reason: `步骤 ${input.stepId} → ${input.status}`,
      changeKind: 'step-update',
      steps,
    })
  }

  /**
   * 新增/更新架构决策（§8.6）。
   *
   * 被推翻的决策标 superseded，不删除。
   */
  setDecision(input: {
    sessionId: string
    decision: PlanDecision
    name: string
  }): { ok: true; version: number } | { ok: false; error: string } {
    const current = this.get(input.sessionId)
    if (!current) return { ok: false, error: '该会话还没有计划' }

    const others = current.decisions.filter(d => d.id !== input.decision.id)
    return this.update({
      sessionId: input.sessionId,
      name: input.name,
      reason: `决策 ${input.decision.id}`,
      changeKind: 'revise',
      decisions: [...others, input.decision],
    })
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 写一行版本历史。 */
  private writeVersion(
    sessionId: string,
    version: number,
    name: string,
    snapshot: PlanSnapshot,
    changeKind: PlanChangeKind,
    reason: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO plan_version (sessionId, version, name, snapshot, change_kind, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        version,
        name.trim(),
        JSON.stringify(snapshot),
        changeKind,
        reason,
        new Date().toISOString(),
      )
  }
}

/**
 * 合并步骤：**已完成的步骤绝不作废**。
 *
 * 若调用方传入的新步骤列表里缺了旧列表中已完成的步骤，自动补回。
 * 这是「任何变更都不作废已完成工作」的代码保障。
 *
 * @param oldSteps - 当前计划的步骤。
 * @param newSteps - 调用方提供的新步骤列表。
 */
export function mergeSteps(oldSteps: readonly PlanStep[], newSteps: readonly PlanStep[]): PlanStep[] {
  const newIds = new Set(newSteps.map(s => s.id))
  const preserved = oldSteps.filter(
    s => !newIds.has(s.id) && (s.status === 'done' || s.status === 'dropped'),
  )
  return [...newSteps, ...preserved]
}

function toPlan(row: PlanRow): Plan {
  return {
    sessionId: row.sessionId,
    version: row.version,
    name: row.name,
    goal: row.goal,
    estimateMin: row.estimate_min ?? undefined,
    steps: safeParse<PlanStep[]>(row.steps, []),
    decisions: safeParse<PlanDecision[]>(row.decisions, []),
    status: row.status as PlanStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toVersion(row: PlanVersionRow): PlanVersion {
  return {
    planNo: row.plan_no,
    sessionId: row.sessionId,
    version: row.version,
    name: row.name,
    snapshot: row.snapshot,
    changeKind: row.change_kind as PlanChangeKind,
    reason: row.reason,
    createdAt: row.created_at,
  }
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 把计划渲染成给模型看的紧凑视图（pre-step 注入用）。 */
export function renderPlan(plan: Plan): string {
  const done = plan.steps.filter(s => s.status === 'done').length
  const head = `计划 v${plan.version}「${plan.name}」 ${done}/${plan.steps.length} 完成`
  const goal = `目标：${plan.goal}`
  const steps = plan.steps
    .map(s => {
      const mark = s.status === 'done' ? '✓'
        : s.status === 'in_progress' ? '→'
        : s.status === 'blocked' ? '!'
        : s.status === 'dropped' ? '×'
        : '·'
      const w = s.weight !== 1 ? ` (w=${s.weight})` : ''
      return `  ${mark} ${s.id} ${s.text}${w}`
    })
    .join('\n')
  const decisions = plan.decisions.filter(d => d.status === 'active')
  const dec = decisions.length > 0
    ? `\n决策：\n${decisions.map(d => `  · ${d.decision}（因为 ${d.reason}）`).join('\n')}`
    : ''
  return [head, goal, steps + dec].join('\n')
}
