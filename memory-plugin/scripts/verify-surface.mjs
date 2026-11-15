// 真实验证：surfaceOp replace 是否真的让旧消息从模型可见历史中消失。
//
// 不依赖模型 API：只用 dsh 的 Session 层（append + deriveMessages）。
// 判断依据（三条断言）：
//   1. append 3 条消息后，deriveMessages 得到 3 条
//   2. 用 replace 遮蔽前 2 条后，deriveMessages 得到 2 条（1 总结 + 1 原文）
//   3. 日志里事件数增加（旧事件没被删）——Model-visible means logged
//
// 跑法：node scripts/verify-surface.mjs

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mod = require('@deepseek-ai/dsh-session')

/** 从模块里找可用的 Session 构造函数与仓储。 */
const SessionCtor = mod.Session
const SessionStore = mod.SessionStore

if (typeof SessionCtor !== 'function') {
  console.error('未找到 Session 构造函数')
  process.exit(2)
}

console.log('Session 构造参数个数:', SessionCtor.length)
console.log('SessionStore 是否可用:', typeof SessionStore === 'function')

/** 打印一个对象的方法名，便于找出可用的 API。 */
function methods(obj) {
  const out = new Set()
  let p = obj
  while (p && p !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k !== 'constructor' && typeof obj[k] === 'function') out.add(k)
    }
    p = Object.getPrototypeOf(p)
  }
  return [...out].sort()
}

/** 构造一条 user 消息事件的数据。 */
function userMsg(text, kind = 'user') {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind } }
}

try {
  // 尝试用 SessionStore 建一个内存会话；不同版本构造参数可能不同，逐个试。
  let session
  const candidates = [
    () => new SessionCtor({ id: 'verify-session', storage: new SessionStore({ path: ':memory:' }) }),
    () => new SessionCtor('verify-session'),
    () => new SessionCtor({ id: 'verify-session' }),
  ]
  for (const make of candidates) {
    try {
      session = make()
      if (session && typeof session.append === 'function') break
    } catch {
      // 试下一个
    }
  }

  if (!session || typeof session.append !== 'function') {
    console.error('无法构造可 append 的 Session；可用构造方式需要进一步探查')
    console.error('Session 静态成员:', Object.getOwnPropertyNames(SessionCtor).join(', '))
    process.exit(3)
  }

  console.log('Session 方法:', methods(session).slice(0, 25).join(', '))

  // 三条消息
  const e1 = session.append('user/message', userMsg('第一句：请帮我查登录超时'), { surfaceOp: 'append' })
  const e2 = session.append('user/message', userMsg('第二句：日志里 token 提前 5 分钟过期'), { surfaceOp: 'append' })
  const e3 = session.append('user/message', userMsg('第三句：好，按这个思路修'), { surfaceOp: 'append' })
  console.log('append 后 seq:', e1?.seq, e2?.seq, e3?.seq)

  const before = session.deriveMessages()
  console.log('[断言1] 初始可见消息数 =', before.length, '（期望 3）')

  // 用 replace 遮蔽前两条。
  // 关键：dsh 要求 sourceEventSeqs 完整列出被遮蔽的每个节点，否则拒绝提交。
  const seal = session.append(
    'user/message',
    userMsg('[sealed segment] 已修好登录超时，原因是 token 提前 5 分钟过期。', 'memory-seal'),
    {
      surfaceOp: { op: 'replace', startSeq: e1.seq, endSeq: e2.seq },
      sourceEventSeqs: [e1.seq, e2.seq],
    },
  )
  console.log('replace 事件 seq:', seal?.seq)

  const after = session.deriveMessages()
  console.log('[断言2] 遮蔽后可见消息数 =', after.length, '（期望 2）')
  console.log('  可见内容:', after.map(m => {
    const c = Array.isArray(m.content) ? m.content : []
    const t = c.find(b => b.type === 'text')
    return t ? String(t.text).slice(0, 40) : '(无文本)'
  }))

  const events = typeof session.events !== 'undefined' ? session.events : undefined
  const logCount = events ? events.length : '(不可直接读)'
  console.log('[断言3] 日志事件数 =', logCount, '（应 >= 4，说明旧事件未删）')

  const pass1 = before.length === 3
  const pass2 = after.length === 2
  console.log('')
  console.log('结论: 断言1 =', pass1 ? 'PASS' : 'FAIL', '| 断言2 =', pass2 ? 'PASS' : 'FAIL')
  process.exit(pass1 && pass2 ? 0 : 1)
} catch (error) {
  console.error('验证失败:', error?.message ?? error)
  console.error(error?.stack?.split('\n').slice(0, 5).join('\n'))
  process.exit(1)
}
