// 规划准入测试：三档决策、时间解析、暂扣/还原时序。

import { describe, expect, it } from 'vitest'
import {
  INTAKE_TTL_MS,
  buildIntakePrompt,
  looksLikeEstimate,
  needsPlan,
  parseEstimate,
  runIntakeStep,
  shouldGate,
  type IntakeHost,
  type IntakePhase,
} from '../src/plan/intake.js'
import { MemoryStore } from '../src/store/sqlite.js'
import { PlanStore } from '../src/plan/store.js'

/** 造一个准入宿主。 */
function host(over: Partial<IntakeHost> & { phase?: IntakePhase } = {}): IntakeHost & { phase: IntakePhase } {
  const store = new MemoryStore({ path: ':memory:' })
  const plans = new PlanStore(store.raw)
  const state = { phase: over.phase ?? ({ kind: 'idle' } as IntakePhase) }
  return {
    get phase() { return state.phase },
    get: () => state.phase,
    set: (_sid, p) => { state.phase = p },
    clear: () => { state.phase = { kind: 'idle' } },
    lastAssistantText: () => over.lastAssistantText?.(''),
    lastAssistantAtMs: () => over.lastAssistantAtMs?.(undefined as never),
    plans,
    warn: () => {},
  } as IntakeHost & { phase: IntakePhase }
}

describe('问句与时间解析', () => {
  it('问句只问时间，不问要不要规划、不问步数', () => {
    const p = buildIntakePrompt()
    expect(p).toContain('estimate')
    expect(p).toContain('minutes')
    expect(p.toLowerCase()).not.toContain('how many steps')
    expect(p.toLowerCase()).not.toContain('do you need a plan')
  })

  it('问句要求只回一个整数', () => {
    expect(buildIntakePrompt()).toContain('ONE integer')
  })

  it('解析纯数字', () => {
    expect(parseEstimate('5')).toBe(5)
    expect(parseEstimate('  12  ')).toBe(12)
  })

  it('解析带单位的回复', () => {
    expect(parseEstimate('约 8 分钟')).toBe(8)
    expect(parseEstimate('about 30 min')).toBe(30)
    expect(parseEstimate('2 minutes')).toBe(2)
  })

  it('解析 0', () => {
    expect(parseEstimate('0')).toBe(0)
  })

  it('无法解析时返回 undefined', () => {
    expect(parseEstimate('不知道')).toBeUndefined()
    expect(parseEstimate('')).toBeUndefined()
  })

  it('looksLikeEstimate 识别短数字回复', () => {
    expect(looksLikeEstimate('5')).toBe(true)
    expect(looksLikeEstimate('约 5 分钟')).toBe(true)
    expect(looksLikeEstimate('这是一段很长的解释，远超四十个字符长度限制的回复内容')).toBe(false)
  })
})

describe('准入阈值：只问时间', () => {
  it('小于 5 分钟不建规划', () => {
    expect(needsPlan(4)).toBe(false)
    expect(needsPlan(0)).toBe(false)
  })

  it('大于等于 5 分钟建规划', () => {
    expect(needsPlan(5)).toBe(true)
    expect(needsPlan(60)).toBe(true)
  })

  it('没给时间按需要规划处理（宁可多规划）', () => {
    expect(needsPlan(undefined)).toBe(true)
  })
})

describe('哪些消息触发准入', () => {
  it('普通用户消息触发', () => {
    expect(shouldGate('user', '帮我看看这个 bug')).toBe(true)
    expect(shouldGate(undefined, '帮我看看这个 bug')).toBe(true)
  })

  it('程序注入不触发', () => {
    expect(shouldGate('memory-summary-prompt', 'Condense unit #1')).toBe(false)
    expect(shouldGate('memory-projection', '#1 <summary>x</summary>')).toBe(false)
    expect(shouldGate('runtime-context', '<system-reminder>x</system-reminder>')).toBe(false)
  })

  it('空消息不触发', () => {
    expect(shouldGate('user', '   ')).toBe(false)
  })
})

describe('准入流程时序', () => {
  it('idle 且无活跃规划时不主动提问（由调用方决定何时问）', () => {
    const h = host()
    const action = runIntakeStep('s', h)
    expect(action.kind).toBe('skip')
  })

  it('awaiting 时收割到时间 → release', () => {
    const now = Date.now()
    const h = host({
      phase: { kind: 'awaiting', promptText: 'q', heldMessageId: 'm1', askedAt: now - 5000, attempts: 0 },
      lastAssistantText: () => '8',
      lastAssistantAtMs: () => now - 1000,
    })
    const action = runIntakeStep('s', h)
    expect(action.kind).toBe('release')
    if (action.kind === 'release') {
      expect(action.estimateMin).toBe(8)
      expect(action.needsPlan).toBe(true)
      expect(action.heldMessageId).toBe('m1')
    }
  })

  it('回复早于提问时刻 → 不收割（避免收历史）', () => {
    const now = Date.now()
    const h = host({
      phase: { kind: 'awaiting', promptText: 'q', heldMessageId: 'm1', askedAt: now - 1000, attempts: 0 },
      lastAssistantText: () => '8',
      lastAssistantAtMs: () => now - 5000,
    })
    expect(runIntakeStep('s', h).kind).toBe('skip')
  })

  it('超时后强制释放（不能永久扣着用户消息）', () => {
    const askedAt = Date.now() - INTAKE_TTL_MS - 1000
    const h = host({
      phase: { kind: 'awaiting', promptText: 'q', heldMessageId: 'm1', askedAt, attempts: 0 },
      lastAssistantText: () => undefined,
      lastAssistantAtMs: () => undefined,
    })
    const action = runIntakeStep('s', h)
    expect(action.kind).toBe('release')
    if (action.kind === 'release') expect(action.estimateMin).toBeUndefined()
  })

  it('答非所问时重问一次（仍扣着消息）', () => {
    const now = Date.now()
    const h = host({
      phase: { kind: 'awaiting', promptText: 'q', heldMessageId: 'm1', askedAt: now - 1000, attempts: 0 },
      lastAssistantText: () => '好的，我先看看你的代码，这是一段很长的分析文字，完全不像在报时间',
      lastAssistantAtMs: () => now - 500,
    })
    const action = runIntakeStep('s', h)
    expect(action.kind).toBe('ask')
  })

  it('重试超过上限后放弃评估、放行原消息', () => {
    const now = Date.now()
    const h = host({
      phase: { kind: 'awaiting', promptText: 'q', heldMessageId: 'm1', askedAt: now - 1000, attempts: 3 },
      lastAssistantText: () => '又是长篇大论，完全不像在报时间的一句很长的回复内容',
      lastAssistantAtMs: () => now - 500,
    })
    const action = runIntakeStep('s', h)
    expect(action.kind).toBe('release')
    if (action.kind === 'release') expect(action.estimateMin).toBeUndefined()
  })

  it('已有活跃规划时不再打断', () => {
    const store = new MemoryStore({ path: ':memory:' })
    const plans = new PlanStore(store.raw)
    plans.create({ sessionId: 's', name: '初版计划', goal: 'g', steps: [] })
    const h: IntakeHost = {
      get: () => ({ kind: 'idle' }),
      set: () => {},
      clear: () => {},
      lastAssistantText: () => undefined,
      lastAssistantAtMs: () => undefined,
      plans,
      warn: () => {},
    }
    expect(runIntakeStep('s', h).kind).toBe('skip')
  })
})
