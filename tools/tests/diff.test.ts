// diff 引擎的单元测试（零依赖，用 node:test）
//
// 运行：node --test dist/tests/

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffSteps } from '../lib/diff.js'
import { OpKind, type MsgRow } from '../lib/types.js'

/** 造一条消息：role 用数字，pid 用数字模拟内容身份 */
function m(role: number, pid: number, rpid = -1, chars = 10, rchars = 0): MsgRow {
  return { role, pid, rpid, chars, rchars, tool: -1 }
}

test('首次请求：全部标记为新增', () => {
  const cur = [m(0, 1), m(1, 2), m(2, 3)]
  const r = diffSteps([], cur)
  assert.equal(r.lcp, 0)
  assert.equal(r.suf, 0)
  assert.equal(r.counts[OpKind.Added], 3)
  assert.equal(r.ops.length, 3)
  assert.ok(r.ops.every((o) => o.kind === OpKind.Added))
  assert.equal(r.accent, OpKind.Added)
})

test('尾部追加：LCP 吃掉公共前缀，其余为新增', () => {
  const prev = [m(0, 1), m(1, 2)]
  const cur = [m(0, 1), m(1, 2), m(2, 3)]
  const r = diffSteps(prev, cur)
  assert.equal(r.lcp, 2)
  assert.equal(r.suf, 0)
  assert.equal(r.counts[OpKind.Added], 1)
  assert.equal(r.counts[OpKind.Unchanged], 2)
  assert.equal(r.ops.length, 1)
  assert.equal(r.ops[0]?.kind, OpKind.Added)
  assert.equal(r.ops[0]?.curIndex, 2)
})

test('LCP 在第一条就分叉：只分叉第一条', () => {
  const prev = [m(0, 1), m(1, 2)]
  const cur = [m(0, 9), m(1, 2)]
  const r = diffSteps(prev, cur)
  assert.equal(r.lcp, 0)
  // 第 2 条是公共后缀
  assert.equal(r.suf, 1)
  // 第 1 条：同 role、不同 pid → 变化
  const kinds = r.ops.map((o) => o.kind)
  assert.ok(kinds.includes(OpKind.Changed), `期望有变化，实际 ${JSON.stringify(kinds)}`)
})

test('同一条消息补上 reasoning → 判为增长', () => {
  const prev = [m(0, 1), m(2, 5, -1, 13, 0)]
  const cur = [m(0, 1), m(2, 5, 7, 13, 42)]
  const r = diffSteps(prev, cur)
  assert.equal(r.lcp, 1, 'system 前缀应保持未变')
  const op = r.ops.find((o) => o.kind === OpKind.Grown)
  assert.ok(op, '应识别出增长的操作')
  assert.equal(op.delta, 42, '增量应等于 reasoning 的字符数')
  assert.equal(r.counts[OpKind.Grown], 1)
  assert.equal(r.accent, OpKind.Grown)
})

test('消息被删除 → 判为消失', () => {
  const prev = [m(0, 1), m(1, 2), m(2, 3)]
  const cur = [m(0, 1), m(2, 3)]
  const r = diffSteps(prev, cur)
  assert.equal(r.lcp, 1)
  assert.equal(r.suf, 1, '末尾 system 之后的 assistant 也相同')
  const removed = r.ops.filter((o) => o.kind === OpKind.Removed)
  assert.equal(removed.length, 1)
  assert.equal(removed[0]?.oldIndex, 1)
  assert.equal(r.accent, OpKind.Removed)
})

test('压缩：前 N 条全消失，只剩摘要', () => {
  const prev = [m(0, 1), m(1, 2), m(2, 3), m(1, 4)]
  const cur = [m(0, 1), m(1, 99)]
  const r = diffSteps(prev, cur)
  assert.equal(r.counts[OpKind.Removed], 2, 'user 与 assistant 应判为消失')
  assert.ok(r.ops.some((o) => o.kind === OpKind.Removed))
})

test('中间插入：公共前缀与公共后缀都被识别', () => {
  const prev = [m(0, 1), m(1, 2), m(2, 3)]
  const cur = [m(0, 1), m(1, 2), m(3, 8), m(2, 3)]
  const r = diffSteps(prev, cur)
  assert.equal(r.lcp, 2)
  assert.equal(r.suf, 1)
  assert.equal(r.counts[OpKind.Added], 1)
  assert.equal(r.counts[OpKind.Unchanged], 3)
})

test('内容被改写（同长度）→ 判为变化', () => {
  const prev = [m(0, 1), m(1, 2)]
  const cur = [m(0, 1), m(1, 77)]
  const r = diffSteps(prev, cur)
  assert.equal(r.lcp, 1)
  const op = r.ops.find((o) => o.kind === OpKind.Changed)
  assert.ok(op, '应识别出变化')
  assert.equal(op.delta, 0, '等长改写的增量为 0')
})

test('操作按 curIndex 排序，消失项插在原位', () => {
  const prev = [m(0, 1), m(1, 2), m(2, 3)]
  const cur = [m(0, 1), m(2, 3)]
  const r = diffSteps(prev, cur)
  const order = r.ops.map((o) => (o.curIndex >= 0 ? o.curIndex : o.oldIndex))
  const sorted = [...order].sort((a, b) => a - b)
  assert.deepEqual(order, sorted)
})

test('脏区过大时退化为线性路径，仍不崩', () => {
  // 构造 600×600 的脏区（超过 LCS_MAX=400 的阈值）
  const prev: MsgRow[] = []
  const cur: MsgRow[] = []
  for (let i = 0; i < 600; i++) {
    prev.push(m(1, 1000 + i))
    cur.push(m(1, 2000 + i))
  }
  const r = diffSteps(prev, cur)
  assert.ok(r.ops.length > 0)
  assert.equal(r.counts[OpKind.Changed] + r.counts[OpKind.Added], 600)
})

test('两侧 LCP 长度不同时能被上层检测出来', () => {
  const off = diffSteps([m(0, 1)], [m(0, 1), m(1, 2)])
  const on = diffSteps([m(0, 1)], [m(0, 1), m(1, 3)])
  assert.equal(off.lcp, 1)
  assert.equal(on.lcp, 1)
  // 内容不同但 LCP 长度相同 —— 差异体现在 ops 上
  assert.notDeepEqual(
    off.ops.map((o) => o.newPid),
    on.ops.map((o) => o.newPid),
  )
})

test('空的当前步 → 全部消失', () => {
  const r = diffSteps([m(0, 1), m(1, 2)], [])
  assert.equal(r.counts[OpKind.Removed], 2)
  assert.equal(r.accent, OpKind.Removed)
})
