// 规划准入：只问时间，不问"要不要规划"。
//
// 设计见 docs/A7-memory-design-final.md §8.3。
//
// ===========================================================================
// 为什么需要三步，而不是一句提示
// ===========================================================================
//
// 如果只是把"这活要几分钟？"追加到用户消息后面，模型会在**同一条回复**里
// 既回答时间又直接开干——那这个机制就失效了。所以必须让模型在某一步里
// **看不到原任务**，只能回答时间。
//
// 时序（A1 方案）：
//   1. 暂扣：pre-step 拿到 claim 到的用户消息，先扣在插件里
//   2. 问询：enter 只送一条"预估几分钟"的提示，模型这一步无从开工
//   3. 收割 + 还原：拿到分钟数后，用 inject 把原消息放回 next-step
//
// ===========================================================================
// 为什么气泡不滞后
// ===========================================================================
//
// 气泡读的是 session 的 `user/message` append 事件；暂扣发生在 pre-step 的
// `enter` 替换上，两者是**独立的链**。
//
// 关键：`agent/inbox/claimed` 之前，消息已经作为 pending 渲染在气泡里
// （dsh-client-ui-chat 的 inbox 节点）。也就是说用户消息一发出，气泡就有了；
// 我们扣的是"模型看不看得到"，不是"界面显不显示"。
//
// ===========================================================================
// 为什么用 inject 而不是 steer
// ===========================================================================
//
//   steer   → 投递到 next-step 并**唤醒驱动**：会多跑一步，无谓地打断
//   inject  → 投递到 next-step 但**不唤醒**：问答那一步结束后模型本来就要
//             继续跑，下一个 step 边界自然带走它。零额外轮次。
//
// 因此选 inject。

import type { PlanStore } from './store.js'
import { PLAN_TIME_THRESHOLD_MIN, needsPlan } from './store.js'

/** 一次准入流程的状态。 */
export type IntakePhase =
  /** 没有在等时间评估 */
  | { kind: 'idle' }
  /** 已问出"要几分钟"，等模型回答 */
  | { kind: 'awaiting'; promptText: string; heldMessageId: string; askedAt: number; attempts: number }
  /** 已收割到时间，原消息已放回 */
  | { kind: 'released'; estimateMin: number | undefined; needsPlan: boolean }

/** 一个问题/答案的判定结果。 */
export type IntakeAction =
  /** 不做事 */
  | { kind: 'skip'; reason: string }
  /** 本次 pre-step 要暂扣原消息、只送问句 */
  | { kind: 'ask'; promptText: string; heldMessageId: string }
  /** 已拿到答案：放回原消息 */
  | { kind: 'release'; estimateMin: number | undefined; needsPlan: boolean; heldMessageId: string }

/** awaiting 的最长等待时间（避免永久卡住）。 */
export const INTAKE_TTL_MS = 10 * 60 * 1000

/** 最多重问几次；超过就放弃评估、直接放行原消息。 */
export const INTAKE_MAX_ATTEMPTS = 3

/**
 * 问句原文（整条英文，与提炼指令一致）。
 *
 * 只问时间；不问"是否需要规划"（那等于把架构决策交给模型，
 * 而模型被问"要不要规划"时会倾向说"不用"），也不问步数。
 */
export function buildIntakePrompt(): string {
  return [
    'Before starting, estimate how long this task will take.',
    '',
    `Reply with ONE integer: your estimate in minutes. Nothing else — no preamble, no plan, no code.`,
    '',
    `If the task needs no work at all (a pure question, a greeting), reply with: 0`,
  ].join('\n')
}

/**
 * 从模型回复里解析分钟数。
 *
 * 容错：允许 "5"、"约 5 分钟"、"5 minutes"、"about 5 min" 这类形态。
 *
 * @param reply - 模型回复原文。
 * @returns 分钟数；无法解析时 undefined。
 */
export function parseEstimate(reply: string): number | undefined {
  const t = reply.trim()
  if (t.length === 0) return undefined
  // 取第一个出现的数字
  const m = t.match(/\d+(?:\.\d+)?/)
  if (m === null) return undefined
  const n = Number(m[0])
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** 判断回复是否像"在认真报时间"（而不是又开始长篇大论）。 */
export function looksLikeEstimate(reply: string): boolean {
  const t = reply.trim()
  if (t.length === 0) return false
  // 短回复且含数字，认为有效
  if (t.length <= 40 && /\d/.test(t)) return true
  // 长回复里只有数字也算（模型可能带一个单位词）
  return /^\s*(?:约|about|roughly|around)?\s*\d+(?:\.\d+)?\s*(?:分钟|minutes?|mins?|m)?\s*$/i.test(t)
}

/** 准入决策所需的宿主能力。 */
export interface IntakeHost {
  /** 该会话当前的准入状态。 */
  get(sessionId: string): IntakePhase
  /** 记录状态。 */
  set(sessionId: string, phase: IntakePhase): void
  /** 清除。 */
  clear(sessionId: string): void
  /** 该会话最新一条 assistant 可见文本。 */
  lastAssistantText(sessionId: string): string | undefined
  /** 该会话最新一条 assistant 产出时刻（epoch ms）。 */
  lastAssistantAtMs(sessionId: string): number | undefined
  /** 是否已经有活跃规划（有则不重复问）。 */
  plans: Pick<PlanStore, 'get'>
  /** 诊断输出。 */
  warn(message: string): void
}

/**
 * 执行一次准入决策（在 pre-step 里调用）。
 *
 * 顺序：**先收割，后提问**——与总结流程同样的理由：
 * 有 awaiting 时必须先处理，否则新的提问会覆盖掉上一轮的等待。
 *
 * @param sessionId - 会话 id。
 * @param host - 宿主能力。
 * @returns 本次要做什么。
 */
export function runIntakeStep(sessionId: string, host: IntakeHost): IntakeAction {
  const phase = host.get(sessionId)

  // ---------- 收割 ----------
  if (phase.kind === 'awaiting') {
    const reply = host.lastAssistantText(sessionId)
    const at = host.lastAssistantAtMs(sessionId)

    // 回复必须晚于提问时刻，否则收的是更早的历史
    if (reply !== undefined && at !== undefined && at >= phase.askedAt) {
      const trimmed = reply.trim()
      if (trimmed.length === 0) return { kind: 'skip', reason: 'empty reply' }

      // 只在回复确实"像在报时间"时才收割。
      // 否则模型可能在问句那一步就长篇大论（甚至开始干活），
      // 把正文里的某个数字误当成时间评估。
      if (!looksLikeEstimate(trimmed)) {
        // 模型答非所问。再问一次（计数），超过上限就放弃评估、放行原消息，
        // 绝不能因为模型不配合就把用户的消息一直扣着。
        if (phase.attempts >= INTAKE_MAX_ATTEMPTS) {
          host.warn(`intake: gave up after ${phase.attempts} attempts, releasing held message`)
          host.clear(sessionId)
          return {
            kind: 'release',
            estimateMin: undefined,
            needsPlan: needsPlan(undefined),
            heldMessageId: phase.heldMessageId,
          }
        }
        host.set(sessionId, { ...phase, askedAt: Date.now(), attempts: phase.attempts + 1 })
        return {
          kind: 'ask',
          promptText: buildIntakePrompt(),
          heldMessageId: phase.heldMessageId,
        }
      }

      const estimate = parseEstimate(trimmed)
      const decision = needsPlan(estimate)
      host.set(sessionId, { kind: 'released', estimateMin: estimate, needsPlan: decision })
      return {
        kind: 'release',
        estimateMin: estimate,
        needsPlan: decision,
        heldMessageId: phase.heldMessageId,
      }
    }

    // 超时：放弃等待，原消息放回（不能永久扣着用户的消息）
    const age = Date.now() - phase.askedAt
    if (age > INTAKE_TTL_MS) {
      host.warn(`intake: pending expired after ${Math.round(age / 1000)}s, releasing held message`)
      host.clear(sessionId)
      return {
        kind: 'release',
        estimateMin: undefined,
        needsPlan: needsPlan(undefined),
        heldMessageId: phase.heldMessageId,
      }
    }
    return { kind: 'skip', reason: 'waiting for the time estimate' }
  }

  // ---------- 判断要不要问 ----------
  // 已有活跃规划 → 不再打断（问一次就够）
  const plan = host.plans.get(sessionId)
  if (plan !== undefined && plan.status === 'active') {
    return { kind: 'skip', reason: 'an active plan already governs this session' }
  }

  return { kind: 'skip', reason: 'no new user input to gate' }
}

/**
 * 判断一条用户消息是否值得触发准入提问。
 *
 * 排除程序注入（那些不是"人说的话"），其余都问。
 *
 * @param sourceKind - 消息的 source.kind。
 * @param text - 消息正文。
 */
export function shouldGate(sourceKind: string | undefined, text: string): boolean {
  if (text.trim().length === 0) return false
  if (sourceKind !== undefined && sourceKind !== 'user') return false
  return true
}

/** 组装问句并对齐到 pre-step 的 enter 决策（替换而非追加）。 */
export function askAction(heldMessageId: string): Extract<IntakeAction, { kind: 'ask' }> {
  return { kind: 'ask', promptText: buildIntakePrompt(), heldMessageId }
}

/** 阈值与判定再导出，便于测试与调用方。 */
export { PLAN_TIME_THRESHOLD_MIN, needsPlan }
