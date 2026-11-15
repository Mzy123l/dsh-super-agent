// 采集行读取与双栏配对的单元测试（零依赖，用 node:test）
//
// 运行：node --test dist/tests/

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeLine, parsePhase, parseRequestKey } from '../lib/reader.js'
import { buildPayload } from '../lib/model.js'
import type { CaptureLine } from '../lib/types.js'

/**
 * 造一行采集记录。
 *
 * **不传 totals**：`normalizeLine` 会按 `messages` 推导出 totals，
 * 这样测试才能反映真实采集文件的情况（真实文件的 totals 与 messages 一致）。
 */
function line(raw: Partial<CaptureLine> & { messages?: unknown[] }): CaptureLine {
  return normalizeLine(
    {
      ts: '2026-11-15T06:00:00.000Z',
      sessionId: 's1',
      provider: 'p',
      model: 'm',
      step: 1,
      turn: 1,
      variant: 'on',
      runId: 'r1',
      messages: [],
      ...raw,
    },
    [],
    'test',
    0,
  )!
}

// ── phase 解析 ───────────────────────────────────────────────────────────

test('phase 为 before 时原样保留', () => {
  assert.equal(parsePhase('before'), 'before')
})

test('phase 缺失时按 after 处理（向后兼容）', () => {
  assert.equal(parsePhase(undefined), 'after')
  assert.equal(parsePhase(null), 'after')
  assert.equal(parsePhase(''), 'after')
})

test('phase 非法值按 after 处理', () => {
  assert.equal(parsePhase('weird'), 'after')
  assert.equal(parsePhase(123), 'after')
})

test('旧采集文件（无 phase 字段）读出后是 after', () => {
  const parsed = line({} as Partial<CaptureLine>)
  assert.equal(parsed.phase, 'after')
})

// ── requestKey 解析 ──────────────────────────────────────────────────────

test('requestKey 存在时原样保留', () => {
  assert.equal(parseRequestKey('abc#1#2', 's1', 1, 2), 'abc#1#2')
})

test('requestKey 缺失时按 sessionId#turn#step 兜底', () => {
  assert.equal(parseRequestKey(undefined, 's1', 3, 4), 's1#3#4')
  assert.equal(parseRequestKey('', 's1', 3, 4), 's1#3#4')
})

test('requestKey 缺失且 turn/step 未知时退化为 sessionId', () => {
  assert.equal(parseRequestKey(undefined, 's1', 0, 0), 's1')
})

test('requestKey 兜底推导与采集插件的格式一致', () => {
  const parsed = line({ sessionId: 's9', turn: 2, step: 5 } as Partial<CaptureLine>)
  assert.equal(parsed.requestKey, 's9#2#5')
})

// ── 双栏配对 ─────────────────────────────────────────────────────────────

/** 造一条带正文的采集行 */
function msg(role: string, text: string): unknown {
  return { role, text, chars: text.length }
}

test('出现 before 行时自动切到 phase 模式', () => {
  const lines = [
    line({ phase: 'before', requestKey: 's1#1#1', messages: [msg('system', 'S')] }),
    line({ phase: 'after', requestKey: 's1#1#1', messages: [msg('system', 'S'), msg('user', 'M')] }),
  ]
  const payload = buildPayload(lines, { maxChars: 0, maxOps: 50, previewChars: 100, title: 't' })
  assert.equal(payload.summary.mode, 'phase')
  assert.equal(payload.pairs.length, 1)
})

test('没有 before 行时保持 variant 模式（向后兼容）', () => {
  const lines = [
    line({ phase: 'after', variant: 'off', sessionId: 's1', messages: [msg('user', 'a')] }),
    line({ phase: 'after', variant: 'on', sessionId: 's1', messages: [msg('user', 'b')] }),
  ]
  const payload = buildPayload(lines, { maxChars: 0, maxOps: 50, previewChars: 100, title: 't' })
  assert.equal(payload.summary.mode, 'variant')
})

test('phase 模式按 requestKey 把 before/after 配成对', () => {
  const lines = [
    line({ phase: 'before', requestKey: 's1#1#1', step: 1, messages: [msg('system', 'S')] }),
    line({ phase: 'after', requestKey: 's1#1#1', step: 1, messages: [msg('system', 'S'), msg('user', 'M')] }),
    line({ phase: 'before', requestKey: 's1#1#2', step: 2, messages: [msg('system', 'S'), msg('user', 'M')] }),
    line({ phase: 'after', requestKey: 's1#1#2', step: 2, messages: [msg('system', 'S'), msg('user', 'M')] }),
  ]
  const payload = buildPayload(lines, { maxChars: 0, maxOps: 50, previewChars: 100, title: 't' })
  const pair = payload.pairs[0]!
  assert.equal(pair.mode, 'phase')
  assert.equal(pair.rows.length, 2, '两个请求 → 两行')
  // 第一行有差异（after 多一条 user），第二行一致。
  assert.equal(pair.rows[0]?.diff, true)
  assert.equal(pair.rows[1]?.diff, false)
})

test('phase 模式的注入量为正（右栏 - 左栏）', () => {
  const lines = [
    line({ phase: 'before', requestKey: 's1#1#1', messages: [msg('system', 'S')] }),
    line({ phase: 'after', requestKey: 's1#1#1', messages: [msg('system', 'S'), msg('user', 'MEM')] }),
  ]
  const payload = buildPayload(lines, { maxChars: 0, maxOps: 50, previewChars: 100, title: 't' })
  assert.ok(payload.summary.savedChars > 0, '注入量应为正')
  assert.equal(payload.summary.savedChars, 'MEM'.length)
  assert.equal(payload.summary.savedMessages, 1)
})

test('phase 模式下左栏是 before、右栏是 after', () => {
  const lines = [
    line({ phase: 'before', requestKey: 's1#1#1', messages: [msg('system', 'S')] }),
    line({ phase: 'after', requestKey: 's1#1#1', messages: [msg('system', 'S'), msg('user', 'M')] }),
  ]
  const payload = buildPayload(lines, { maxChars: 0, maxOps: 50, previewChars: 100, title: 't' })
  const pair = payload.pairs[0]!
  assert.equal(pair.off.key, 'before')
  assert.equal(pair.on.key, 'after')
  assert.equal(pair.off.steps[0]?.totals[0], 1, '左栏 1 条')
  assert.equal(pair.on.steps[0]?.totals[0], 2, '右栏 2 条')
})

test('variant 模式的节省量口径不变（右 - 左）', () => {
  const lines = [
    line({ phase: 'after', variant: 'off', sessionId: 's1', messages: [msg('user', 'aaaa')] }),
    line({ phase: 'after', variant: 'on', sessionId: 's1', messages: [msg('user', 'bb')] }),
  ]
  const payload = buildPayload(lines, { maxChars: 0, maxOps: 50, previewChars: 100, title: 't' })
  assert.equal(payload.summary.mode, 'variant')
  assert.equal(payload.summary.savedChars, 2, 'off 4 字符 - on 2 字符 = 2')
})

test('只有一侧存在的请求仍能配成对（另一侧为空）', () => {
  const lines = [
    line({ phase: 'before', requestKey: 's1#1#1', messages: [msg('system', 'S')] }),
    line({ phase: 'after', requestKey: 's1#1#2', step: 2, messages: [msg('system', 'S')] }),
  ]
  const payload = buildPayload(lines, { maxChars: 0, maxOps: 50, previewChars: 100, title: 't' })
  const pair = payload.pairs[0]!
  assert.equal(pair.rows.length, 2)
  assert.equal(pair.rows[0]?.hasOff, true)
  assert.equal(pair.rows[0]?.hasOn, false)
})
