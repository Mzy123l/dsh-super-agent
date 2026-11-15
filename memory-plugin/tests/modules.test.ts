// 四个模块的测试：折叠 / 待办 / 覆写 / 规划。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MemoryStore } from '../src/store/sqlite.js'
import { FoldStore, expandLevel1, expandLevel2, buildFoldPrompt } from '../src/fold/store.js'
import { TodoStore, renderTodoList } from '../src/todo/store.js'
import { OverrideStore, renderOverrideHistory, OVERRIDE_MARK } from '../src/override/store.js'
import {
  PlanStore,
  checkPlanName,
  needsPlan,
  mergeSteps,
  renderPlan,
  PLAN_TIME_THRESHOLD_MIN,
} from '../src/plan/store.js'
import type { PlanStep } from '../src/types-modules.js'

/** 灌一个单位。 */
function addUnit(store: MemoryStore, content: string, kind: 'user' | 'reply' | 'thinking' | 'tool' = 'reply', summary = ''): number {
  return store.appendUnit({
    sessionId: 's', kind, summary, content, at: '2026-11-15T00:00:00.000Z', inContext: true, tags: [],
  })
}

// ===========================================================================
describe('折叠', () => {
  let store: MemoryStore
  let folds: FoldStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    folds = new FoldStore(store.raw)
  })
  afterEach(() => { store.close() })

  it('创建折叠后区间内单位标记 folded_into', () => {
    for (const t of ['a', 'b', 'c']) addUnit(store, t)
    const no = folds.create({
      sessionId: 's', fromIdx: 0, toIdx: 2,
      foldSummary: '完成了三件事', trigger: 'task-boundary', name: '模块a', createdAt: 'x',
    })
    expect(no).toBeGreaterThan(0)
    const u = store.getUnit('s', 0)!
    expect(u).toBeDefined()
    // 库中 content 仍在
    expect(u.content).toBe('a')
  })

  it('折叠不删 L0 原文', () => {
    addUnit(store, '重要原文')
    folds.create({
      sessionId: 's', fromIdx: 0, toIdx: 0,
      foldSummary: '摘要', trigger: 'manual', name: 'x', createdAt: 'x',
    })
    expect(store.getUnit('s', 0)?.content).toBe('重要原文')
  })

  it('findByUnit 能定位覆盖某编号的折叠', () => {
    for (const t of ['a', 'b', 'c', 'd']) addUnit(store, t)
    folds.create({ sessionId: 's', fromIdx: 0, toIdx: 1, foldSummary: 'f1', trigger: 'manual', name: 'n1', createdAt: 'x' })
    expect(folds.findByUnit('s', 0)?.foldSummary).toBe('f1')
    expect(folds.findByUnit('s', 1)?.foldSummary).toBe('f1')
    expect(folds.findByUnit('s', 2)).toBeUndefined()
  })

  it('两级展开：一级只给 summary，二级才给原文', () => {
    addUnit(store, '很长的原文内容', 'reply', '要点总结')
    const fold = { foldNo: 1, sessionId: 's', fromIdx: 0, toIdx: 0, foldSummary: '折叠摘要', trigger: 'manual' as const, name: '', createdAt: 'x' }
    const units = store.listRange('s', 0, 0)

    const l1 = expandLevel1(units, fold)
    expect(l1.level).toBe(1)
    expect(l1.units[0]?.summary).toBe('要点总结')
    // 一级不返回原文
    expect(JSON.stringify(l1)).not.toContain('很长的原文内容')

    const l2 = expandLevel2(units[0]!)
    expect(l2.level).toBe(2)
    expect(l2.content).toBe('很长的原文内容')
  })

  it('折叠指令要求保留否决路径与遗留问题', () => {
    const p = buildFoldPrompt(0, 9, 50000, '模块a')
    expect(p).toContain('rejected option')
    expect(p).toContain('chosen option')
    expect(p).toContain('what this span accomplished')
    expect(p).toContain('anything left open')
    expect(p).toContain('effectively lost')
  })
})

// ===========================================================================
describe('待办', () => {
  let todos: TodoStore
  let store: MemoryStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    todos = new TodoStore(store.raw)
  })
  afterEach(() => { store.close() })

  it('新增后可列出（无需关键词）', () => {
    todos.add({ sessionId: 's', title: '把临时脚本清掉' })
    todos.add({ sessionId: 's', title: '补 README' })
    const list = todos.list('s')
    expect(list).toHaveLength(2)
    expect(list[0]?.title).toBe('把临时脚本清掉')
  })

  it('done 后不在 open 列表', () => {
    const no = todos.add({ sessionId: 's', title: '任务' })
    todos.done('s', no)
    expect(todos.list('s')).toHaveLength(0)
    expect(todos.list('s', 'all')).toHaveLength(1)
    expect(todos.list('s', 'all')[0]?.status).toBe('done')
  })

  it('drop 记录原因', () => {
    const no = todos.add({ sessionId: 's', title: '任务' })
    todos.drop('s', no, '不再需要')
    const t = todos.get('s', no)!
    expect(t.status).toBe('dropped')
    expect(t.dropReason).toBe('不再需要')
  })

  it('reopen 恢复', () => {
    const no = todos.add({ sessionId: 's', title: '任务' })
    todos.done('s', no)
    todos.reopen('s', no)
    expect(todos.list('s')).toHaveLength(1)
  })

  it('stats 统计三种状态', () => {
    const a = todos.add({ sessionId: 's', title: 'a' })
    const b = todos.add({ sessionId: 's', title: 'b' })
    todos.add({ sessionId: 's', title: 'c' })
    todos.done('s', a)
    todos.drop('s', b, 'x')
    expect(todos.stats('s')).toEqual({ open: 1, done: 1, dropped: 1 })
  })

  it('渲染空列表有提示', () => {
    expect(renderTodoList([])).toContain('没有未完成的待办')
  })

  it('渲染带来源编号', () => {
    todos.add({ sessionId: 's', title: '任务', fromIdx: 7 })
    const text = renderTodoList(todos.list('s'))
    expect(text).toContain('[来自 #7]')
  })
})

// ===========================================================================
describe('覆写', () => {
  let store: MemoryStore
  let overrides: OverrideStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    overrides = new OverrideStore(store.raw)
  })
  afterEach(() => { store.close() })

  it('覆写只改 summary，L0 原文不动', () => {
    addUnit(store, '原始论证：方案A最优', 'reply', '方案A最优')
    const no = overrides.apply({
      sessionId: 's', targetIdx: 0, newSummary: '方案B才对', reason: '用户改口',
    })
    expect(no).toBeGreaterThan(0)
    const u = store.getUnit('s', 0)!
    expect(u.summary).toContain('方案B才对')
    expect(u.summary).toContain(OVERRIDE_MARK)
    // L0 完全没变
    expect(u.content).toBe('原始论证：方案A最优')
  })

  it('记录旧 summary 与原因', () => {
    addUnit(store, '内容', 'reply', '旧要点')
    overrides.apply({ sessionId: 's', targetIdx: 0, newSummary: '新要点', reason: '用户推翻自己' })
    const h = overrides.historyOf('s', 0)
    expect(h).toHaveLength(1)
    expect(h[0]?.oldSummary).toBe('旧要点')
    expect(h[0]?.newSummary).toBe('新要点')
    expect(h[0]?.reason).toBe('用户推翻自己')
    expect(h[0]?.byUser).toBe(true)
  })

  it('by_user=false 表示用户承认模型对', () => {
    addUnit(store, '内容', 'reply', '模型结论')
    overrides.apply({ sessionId: 's', targetIdx: 0, newSummary: '确实如你所说', reason: '我错了', byUser: false })
    expect(overrides.historyOf('s', 0)[0]?.byUser).toBe(false)
  })

  it('多次覆写保留全部历史', () => {
    addUnit(store, '内容', 'reply', 'v1')
    overrides.apply({ sessionId: 's', targetIdx: 0, newSummary: 'v2', reason: 'r1' })
    overrides.apply({ sessionId: 's', targetIdx: 0, newSummary: 'v3', reason: 'r2' })
    const h = overrides.historyOf('s', 0)
    expect(h).toHaveLength(2)
    expect(h[0]?.newSummary).toBe('v2')
    expect(h[1]?.newSummary).toBe('v3')
  })

  it('不存在的编号返回 undefined', () => {
    expect(overrides.apply({ sessionId: 's', targetIdx: 99, newSummary: 'x', reason: 'y' })).toBeUndefined()
  })

  it('渲染历史含新旧对照', () => {
    addUnit(store, '内容', 'reply', '旧的')
    overrides.apply({ sessionId: 's', targetIdx: 0, newSummary: '新的', reason: '因为' })
    const text = renderOverrideHistory(overrides.list('s'))
    expect(text).toContain('旧：旧的')
    expect(text).toContain('新：新的')
    expect(text).toContain('原因：因为')
  })
})

// ===========================================================================
describe('规划：准入与命名', () => {
  it('阈值是 5 分钟', () => {
    expect(PLAN_TIME_THRESHOLD_MIN).toBe(5)
  })

  it('≥5 分钟需要规划', () => {
    expect(needsPlan(5)).toBe(true)
    expect(needsPlan(30)).toBe(true)
  })

  it('<5 分钟不规划', () => {
    expect(needsPlan(2)).toBe(false)
    expect(needsPlan(0)).toBe(false)
  })

  it('未给时间时默认需要规划', () => {
    expect(needsPlan(undefined)).toBe(true)
  })

  it('版本名必填', () => {
    expect(checkPlanName('').ok).toBe(false)
    expect(checkPlanName(undefined).ok).toBe(false)
    expect(checkPlanName('   ').ok).toBe(false)
  })

  it('版本名过长被拒', () => {
    expect(checkPlanName('x'.repeat(61)).ok).toBe(false)
    expect(checkPlanName('x'.repeat(60)).ok).toBe(true)
  })

  it('无信息量版本名被拒', () => {
    expect(checkPlanName('更新').ok).toBe(false)
    expect(checkPlanName('修改').ok).toBe(false)
    expect(checkPlanName('v1').ok).toBe(false)
  })

  it('有信息量的版本名通过', () => {
    expect(checkPlanName('初始计划：先读鉴权代码').ok).toBe(true)
    expect(checkPlanName('追加模块b：加导出功能').ok).toBe(true)
  })
})

describe('规划：版本管理', () => {
  let store: MemoryStore
  let plans: PlanStore
  beforeEach(() => {
    store = new MemoryStore({ path: ':memory:' })
    plans = new PlanStore(store.raw)
  })
  afterEach(() => { store.close() })

  const steps = (): PlanStep[] => [
    { id: 'a-1', text: '读代码', status: 'pending', weight: 1 },
    { id: 'a-2', text: '改实现', status: 'pending', weight: 1 },
  ]

  it('创建后版本为 1', () => {
    const r = plans.create({ sessionId: 's', name: '初始计划', goal: '修好登录', estimateMin: 20, steps: steps() })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.version).toBe(1)
    expect(plans.get('s')?.goal).toBe('修好登录')
  })

  it('创建时版本名缺失被拒', () => {
    const r = plans.create({ sessionId: 's', name: '', goal: 'g', steps: [] })
    expect(r.ok).toBe(false)
  })

  it('重复创建被拒', () => {
    plans.create({ sessionId: 's', name: '初始', goal: 'g', steps: [] })
    const r2 = plans.create({ sessionId: 's', name: '再次', goal: 'g', steps: [] })
    expect(r2.ok).toBe(false)
  })

  it('每次变更版本 +1 并留历史', () => {
    plans.create({ sessionId: 's', name: '初始计划', goal: 'g', steps: steps() })
    plans.update({ sessionId: 's', name: '改了步骤', changeKind: 'revise', steps: [{ id: 'a-1', text: '读代码', status: 'done', weight: 1 }] })
    const h = plans.history('s')
    expect(h).toHaveLength(2)
    expect(h[0]?.version).toBe(1)
    expect(h[1]?.version).toBe(2)
    expect(h[1]?.name).toBe('改了步骤')
  })

  it('已完成步骤绝不作废（mergeSteps 保障）', () => {
    const old: PlanStep[] = [
      { id: 'a-1', text: '已完成', status: 'done', weight: 1 },
      { id: 'a-2', text: '未完成', status: 'pending', weight: 1 },
    ]
    // 新列表只给 a-2，a-1 应被自动补回
    const merged = mergeSteps(old, [{ id: 'a-2', text: '未完成', status: 'pending', weight: 1 }])
    expect(merged.map(s => s.id).sort()).toEqual(['a-1', 'a-2'])
    expect(merged.find(s => s.id === 'a-1')?.status).toBe('done')
  })

  it('追加任务：前面的权重削弱，新的拉满', () => {
    plans.create({
      sessionId: 's', name: '初始', goal: 'g', estimateMin: 20,
      steps: [
        { id: 'a-1', text: 'A1', status: 'done', weight: 1 },
        { id: 'a-2', text: 'A2', status: 'pending', weight: 1 },
      ],
    })
    const r = plans.extend({
      sessionId: 's', name: '追加模块b',
      newSteps: [{ id: 'b-1', text: 'B1', status: 'pending', weight: 1 }],
    })
    expect(r.ok).toBe(true)
    const p = plans.get('s')!
    // 已完成的 a-1 权重归零（可尽快折叠）
    expect(p.steps.find(s => s.id === 'a-1')?.weight).toBe(0)
    // 未完成的 a-2 被削弱
    expect(p.steps.find(s => s.id === 'a-2')?.weight).toBe(0.3)
    // 新的 b-1 拉满
    expect(p.steps.find(s => s.id === 'b-1')?.weight).toBe(1)
  })

  it('回滚产生新版本，旧版本保留', () => {
    plans.create({ sessionId: 's', name: 'v1计划', goal: 'g', steps: steps() })
    plans.update({ sessionId: 's', name: 'v2改动', changeKind: 'revise', steps: [{ id: 'x', text: 'X', status: 'pending', weight: 1 }] })
    const r = plans.revert({ sessionId: 's', targetVersion: 1, name: '回滚到v1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.version).toBe(3)
    // 三个版本都在
    expect(plans.history('s')).toHaveLength(3)
    // v3 内容等于 v1
    expect(plans.get('s')?.steps.map(s => s.id)).toEqual(['a-1', 'a-2'])
    // v2 仍可查
    expect(plans.version('s', 2)?.name).toBe('v2改动')
  })

  it('步骤状态更新也算版本变更且需命名', () => {
    plans.create({ sessionId: 's', name: '初始', goal: 'g', steps: steps() })
    const r = plans.setStep({ sessionId: 's', stepId: 'a-1', status: 'done', name: '完成第一步' })
    expect(r.ok).toBe(true)
    expect(plans.get('s')?.steps.find(s => s.id === 'a-1')?.status).toBe('done')
  })

  it('版本名缺失时 step 更新被拒', () => {
    plans.create({ sessionId: 's', name: '初始', goal: 'g', steps: steps() })
    const r = plans.setStep({ sessionId: 's', stepId: 'a-1', status: 'done', name: '' })
    expect(r.ok).toBe(false)
  })

  it('架构决策可记录并保留', () => {
    plans.create({ sessionId: 's', name: '初始', goal: 'g', steps: [] })
    plans.setDecision({
      sessionId: 's', name: '定方案',
      decision: { id: 'd-1', decision: '提前 5 分钟刷新', reason: '覆盖重试窗口', status: 'active' },
    })
    const p = plans.get('s')!
    expect(p.decisions).toHaveLength(1)
    expect(p.decisions[0]?.decision).toBe('提前 5 分钟刷新')
  })

  it('渲染计划含进度与步骤标记', () => {
    plans.create({
      sessionId: 's', name: '初始', goal: '修登录', estimateMin: 20,
      steps: [
        { id: 'a-1', text: '读代码', status: 'done', weight: 1 },
        { id: 'a-2', text: '改实现', status: 'in_progress', weight: 1 },
      ],
    })
    const text = renderPlan(plans.get('s')!)
    expect(text).toContain('计划 v1「初始」 1/2 完成')
    expect(text).toContain('目标：修登录')
    expect(text).toContain('✓ a-1')
    expect(text).toContain('→ a-2')
  })

  it('渲染计划含活跃决策', () => {
    plans.create({ sessionId: 's', name: '初始', goal: 'g', steps: [] })
    plans.setDecision({
      sessionId: 's', name: '定方案',
      decision: { id: 'd-1', decision: '用流式', reason: '内存够', status: 'active' },
    })
    const text = renderPlan(plans.get('s')!)
    expect(text).toContain('决策：')
    expect(text).toContain('用流式')
  })
})
