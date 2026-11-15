// 真实验证：pre-step 钩子是否被 dsh 调用、注入是否生效。
//
// 不依赖模型 API：构造一个 Session，手动触发 pre-step 的监听链。
// 如果这套机制在真实 cordis 环境里跑不通，这里会暴露。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

console.log('=== 检查 dsh-llm 的 createUserMessage ===')
try {
  const llm = require('@deepseek-ai/dsh-llm')
  console.log('导出含 createUserMessage:', typeof llm.createUserMessage === 'function')
  const msg = llm.createUserMessage({
    content: [{ type: 'text', text: '测试注入' }],
    source: { kind: 'user' },
  })
  console.log('消息结构:', JSON.stringify({
    hasId: typeof msg.id === 'string',
    role: msg.role,
    contentLen: msg.content?.length,
  }))
} catch (error) {
  console.error('加载 dsh-llm 失败:', error.message)
  process.exit(2)
}

console.log('')
console.log('=== 检查 PreStepDecision 结构要求 ===')
try {
  const session = require('@deepseek-ai/dsh-session')
  console.log('Session 可用:', typeof session.Session === 'function')
  console.log('需要 confirmation: pre-step 返回 { kind: "enter", messages } 或 { kind: "reject" }')
} catch (error) {
  console.error('加载 dsh-session 失败:', error.message)
}

console.log('')
console.log('=== 检查我们的 dist 产物 ===')
try {
  const engine = await import('../dist/loop/engine.js')
  console.log('runLoopStep 可用:', typeof engine.runLoopStep === 'function')
  const store = await import('../dist/loop/store.js')
  console.log('PendingStore 可用:', typeof store.PendingStore === 'function')
} catch (error) {
  console.error('加载插件产物失败:', error.message)
  process.exit(3)
}

console.log('')
console.log('全部依赖可解析')
