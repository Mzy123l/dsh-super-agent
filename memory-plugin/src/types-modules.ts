// 折叠（L2）、待办、覆写、规划的类型定义。
//
// 设计见 docs/A7-memory-design-final.md §5/§6/§7/§8。

import type { UnitKind } from './types.js'

// ===========================================================================
// 折叠（§5）
// ===========================================================================

/** 折叠触发方式。 */
export type FoldTrigger = 'task-boundary' | 'multi-task' | 'budget' | 'manual'

/** 一个折叠体。 */
export interface Fold {
  foldNo: number
  sessionId: string
  /** 覆盖的单位编号区间（闭区间） */
  fromIdx: number
  toIdx: number
  /** 折叠摘要（L2，从 L0 生成） */
  foldSummary: string
  trigger: FoldTrigger
  name: string
  createdAt: string
}

// ===========================================================================
// 待办（§6）
// ===========================================================================

/** 待办状态。 */
export type TodoStatus = 'open' | 'done' | 'dropped'

/** 一个待办项。 */
export interface Todo {
  todoNo: number
  sessionId: string
  title: string
  detail: string
  status: TodoStatus
  /** 来源单位编号 */
  fromIdx?: number
  dropReason: string
  createdAt: string
  updatedAt: string
}

// ===========================================================================
// 覆写（§7）
// ===========================================================================

/** 一条覆写记录。 */
export interface OverrideRecord {
  overrideNo: number
  sessionId: string
  targetIdx: number
  oldSummary: string
  newSummary: string
  reason: string
  /** true = 用户推翻自己；false = 用户承认模型对 */
  byUser: boolean
  createdAt: string
}

// ===========================================================================
// 规划（§8）
// ===========================================================================

/** 步骤状态。 */
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'dropped'

/** 规划中的一个步骤。 */
export interface PlanStep {
  id: string
  text: string
  status: StepStatus
  /** 权重：追加任务时前面的削弱、后面的增强（§8.7） */
  weight: number
  note?: string
}

/** 一条架构决策（§8.6）。 */
export interface PlanDecision {
  id: string
  decision: string
  reason: string
  /** active | superseded */
  status: 'active' | 'superseded'
  supersededBy?: string
}

/** 规划状态。 */
export type PlanStatus = 'active' | 'done' | 'abandoned'

/** 当前规划快照。 */
export interface Plan {
  sessionId: string
  version: number
  /** 版本名（强制，1-60 字符） */
  name: string
  goal: string
  /** 模型自估完成时间（分钟） */
  estimateMin?: number
  steps: PlanStep[]
  decisions: PlanDecision[]
  status: PlanStatus
  createdAt: string
  updatedAt: string
}

/** 变更类型。 */
export type PlanChangeKind = 'init' | 'extend' | 'revise' | 'rebuild' | 'revert' | 'step-update'

/** 一个规划版本（历史记录）。 */
export interface PlanVersion {
  planNo: number
  sessionId: string
  version: number
  name: string
  /** 该版完整快照（JSON） */
  snapshot: string
  changeKind: PlanChangeKind
  reason: string
  createdAt: string
}

/** 规划快照的序列化形态（存进 plan_version.snapshot）。 */
export interface PlanSnapshot {
  goal: string
  estimateMin?: number
  steps: PlanStep[]
  decisions: PlanDecision[]
}

// ===========================================================================
// 发送投影辅助
// ===========================================================================

/** 折叠体在发送视图中的展示形态。 */
export interface FoldView {
  fromIdx: number
  toIdx: number
  summary: string
}

/** 一个可发送条目：普通单位或折叠体。 */
export type Renderable =
  | { kind: 'unit'; idx: number; unitKind: UnitKind; summary: string; content: string }
  | { kind: 'fold'; fromIdx: number; toIdx: number; summary: string }
