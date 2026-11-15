// 端到端验证：编号 → 总结 → 折叠 → 两级展开 → 待办 → 覆写 → 规划

import { mkdirSync, rmSync } from 'node:fs'
import { MemoryStore } from '../dist/store/sqlite.js'
import { FoldStore, expandLevel1, expandLevel2 } from '../dist/fold/store.js'
import { TodoStore, renderTodoList } from '../dist/todo/store.js'
import { OverrideStore } from '../dist/override/store.js'
import { PlanStore, renderPlan, needsPlan } from '../dist/plan/store.js'
import { extractUnits } from '../dist/ingest/units.js'
import { renderUnits } from '../dist/projection/render.js'

const dir = process.argv[2]
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const store = new MemoryStore({ path: `${dir}/memory.sqlite` })
const folds = new FoldStore(store.raw)
const todos = new TodoStore(store.raw)
const overrides = new OverrideStore(store.raw)
const plans = new PlanStore(store.raw)
const S = 'demo'

const t = (x) => [{ type: 'text', text: x }]
const m = (role, content, extra = {}) => ({ role, content, ...extra })

console.log('=== 1. 提取单位 ===')
const ctx = [
  m('system', t('你是助手')),
  m('user', t('帮我修登录超时')),
  m('assistant', [{ type: 'reasoning', text: '先查 token 过期逻辑，可能提前失效' }]),
  m('assistant', [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"grep ttl"}' }]),
  m('tool', t('token.ttl=300'), { source: { callId: 'c1' } }),
  m('assistant', t('把 ttl 改成 600 试试')),
]
const units = extractUnits(ctx, new Date().toISOString(), S)
for (const u of units) store.appendUnit(u)
console.log('单位:', units.length, '范围:', JSON.stringify(store.indexRange(S)))
for (const u of store.listRange(S, 0, 99)) {
  console.log(`  #${u.idx} ${u.kind.padEnd(8)} ${u.content.slice(0, 36).replace(/\n/g, ' ')}`)
}

console.log('\n=== 2. 挂接 summary（模拟模型提炼完成）===')
store.setSummary(S, 1, 'rejected: 改前端 — because 根因在后端；chosen: 查 ttl')
store.setSummary(S, 2, '确认 ttl=300 秒，偏短')
for (const u of store.listRange(S, 0, 99)) {
  console.log(`  #${u.idx} summary=${u.summary ? '有' : '无'}`)
}

console.log('\n=== 3. 发送视图（窗口 2）===')
for (const line of renderUnits(store.listRange(S, 0, 99), { window: 2, latestIdx: 3 })) {
  console.log(line.replace(/\n/g, ' | ').slice(0, 110))
}

console.log('\n=== 4. 折叠 + 两级展开 ===')
const foldNo = folds.create({
  sessionId: S, fromIdx: 0, toIdx: 2,
  foldSummary: '已完成登录超时排查：ttl=300 偏短，定为改 600',
  trigger: 'task-boundary', name: '模块a-登录超时', createdAt: new Date().toISOString(),
})
console.log('折叠体编号:', foldNo)
const l1 = expandLevel1(store.listRange(S, 0, 2), folds.get(S, foldNo))
console.log('一级（summary）:', l1.units.map(u => `#${u.idx}:${u.summary.slice(0, 20)}`).join(' | '))
const l2 = expandLevel2(store.getUnit(S, 1))
console.log('二级（原文）:', l2.content.slice(0, 50))
console.log('L0 未丢:', store.getUnit(S, 1).content.length > 0)

console.log('\n=== 5. 待办 ===')
todos.add({ sessionId: S, title: '把临时脚本清掉', detail: '在 /tmp 下', fromIdx: 3 })
todos.add({ sessionId: S, title: '补 README' })
console.log(renderTodoList(todos.list(S)))
console.log('统计:', JSON.stringify(todos.stats(S)))

console.log('\n=== 6. 覆写 ===')
const before = store.getUnit(S, 1).content
overrides.apply({ sessionId: S, targetIdx: 1, newSummary: '其实 ttl=600 才对', reason: '用户改口', byUser: true })
const after = store.getUnit(S, 1)
console.log('summary:', after.summary)
console.log('L0 未变:', before === after.content)

console.log('\n=== 7. 规划 ===')
console.log('准入（20 分钟需规划）:', needsPlan(20), '|（3 分钟不需要）:', needsPlan(3))
plans.create({
  sessionId: S, name: '初始计划：先查再改', goal: '修好登录超时', estimateMin: 20,
  steps: [
    { id: 'a-1', text: '查 ttl', status: 'done', weight: 1 },
    { id: 'a-2', text: '改配置', status: 'pending', weight: 1 },
  ],
})
plans.setDecision({
  sessionId: S, name: '定方案：改配置不改代码',
  decision: { id: 'd-1', decision: '直接调大 ttl', reason: '改动面最小', status: 'active' },
})
plans.extend({
  sessionId: S, name: '追加模块b：导出功能',
  newSteps: [{ id: 'b-1', text: '设计导出格式', status: 'pending', weight: 1 }],
})
const p = plans.get(S)
console.log(renderPlan(p))
console.log('版本历史:')
for (const v of plans.history(S)) console.log(`  v${v.version}「${v.name}」 ${v.changeKind}`)
console.log('权重检查: a-1=' + p.steps.find(s => s.id === 'a-1').weight
  + ' a-2=' + p.steps.find(s => s.id === 'a-2').weight
  + ' b-1=' + p.steps.find(s => s.id === 'b-1').weight)

console.log('\n=== 8. 回滚 ===')
const r = plans.revert({ sessionId: S, targetVersion: 1, name: '回滚到v1：去掉导出' })
console.log('回滚产生 v' + r.version, '| 版本数:', plans.history(S).length)
console.log('当前步骤:', plans.get(S).steps.map(s => s.id).join(','))

store.close()
console.log('\n全部通过')
