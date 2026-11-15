# DESIGN.md — memory-debug-capture

## 1. 为什么是这个捕获点

[`docs/9Q-debug-capture.md`](../docs/9Q-debug-capture.md) 逐个评估了所有可能的捕获点，结论是
**`llm/stream` waterfall 是唯一全覆盖的那一个**：

| 候选 | 结论 |
|---|---|
| **`llm/stream` waterfall** | ✅ **本插件采用**。`options.messages` = 那次请求发给模型的完整上下文 |
| `ctx.deepseekLlmApiExtensions` | ❌ 只覆盖 DeepSeek 官方 API，且会往线上请求体加字段 |
| `session.deriveMessages()` | ❌ 只是**当前**派生历史；compaction 会遮蔽旧节点，事后无法精确重建"某次请求当时" |
| `agent/pre-step` | ❌ `payload.messages` 只是本轮从 inbox 领取的消息，不是完整上下文 |
| `agent/request` | ❌ 已弃用，且 payload 只有 `{ agent, turn, step, signal }` |
| `request/context` / `request/header` | ❌ 会话事件，**都不含 messages** |

`llm/stream` 的三个关键性质（`dsh-llm/src/index.ts:76` 的文档保证）：

1. **`options.messages` 就是适配器输入的完整请求**——「Ordered conversation messages, exactly as the provider sees them」。
2. **已 deep-frozen**（`markAgentLoopRequest`），监听器**只读不改**——这正是调试采集需要的性质：不可能误改模型上下文。
3. **覆盖每一次模型调用**（含重试、title、compaction）——`ctx.llm.stream()` 与 `preparedCall.stream()` 都经过它。

官方先例写法见 `dsh-session-checkpoint-policy/src/index.ts:64-68`（本插件的捕获点写法与之同构）。

## 2. 捕获点的确切 API 用法

```ts
ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
  // options.messages = 那次请求发给模型的完整上下文（已 deep-frozen，只读）
  // options.sessionId / options.provider / options.model 可用
  collector.handle({ ... })   // 只做内存序列化 + 推进队列
  return next()               // ⚠️ 必须返回 next()，否则短路模型调用
}, { global: true })
```

三条硬约束：

- **必须调用并返回 `next()`**。waterfall 里不调用 `next()` 就等于否决整条链，模型根本不会被调用。
- **`options.messages` 只读**。它是 deep-frozen 的，插件只能读。
- **`{ global: true }`**。`llm/stream` 是 `LlmRuntime` 上的服务事件；会话作用域里的监听器受
  `Context.filter` 约束（`cordis/src/events.ts:168`），只有 `global` 监听器能在所有作用域收到。
  官方 `dsh-session-title` 也用 `{ global: true, prepend: true }`（`dsh-session-title/src/index.ts:360-363`）。

### 轮/步从哪来

`llm/stream` 的 `options` 里**没有** turn/step（见 `GenerateOptions` 的字段清单：
`provider` / `model` / `reasoningEffort` / `messages` / `system` / `tools` / `toolHistory` /
`temperature` / `maxTokens` / `stop` / `signal` / `sessionId` / `purpose`）。

所以 turn/step 来自**会话事件**：

```ts
ctx.on('session/event', (session, event) => {
  // 'turn/start' → { turn }
  // 'step/start' → { turn, step }
}, { global: true })
```

`step/start` 事件在 `dsh-agent-loop/src/agent.ts:367` 提交，**早于**该步的模型调用
（`buildRequest()` 在 `agent.ts:734` 才取 `deriveMessages()`），所以在 `llm/stream` 触发时
**当前步的编号一定是已知的**。

## 3. 分层

```
index.ts     插件装配：挂事件、管生命周期、暴露观测面
  ↓
capture.ts   请求 → 快照（跳过辅助调用）
  ↓
serialize.ts Message[] → CapturedMessage[]（纯函数）
  ↓
writer.ts    队列 → JSONL 文件
```

`capture.ts` / `serialize.ts` / `writer.ts` **不 import 任何 dsh 包**，只消费自己声明的最小结构
（`CaptureRequest` / `SourceMessage`）。这带来两个好处：

1. `--selftest` 不需要 dsh 运行时就能跑；
2. 以后 dsh 的 `Message` 类型变了，只要那个最小结构还对，这三层不用动。

## 4. 为什么 `src/dsh-events.ts` 存在

`llm/stream` 与 `session/event` 的类型在 dsh 里是通过**声明合并**加进 cordis 的 `Events` 的：

```ts
// dsh-llm/src/index.ts:58
declare module '@deepseek-ai/cordis' {
  interface Events {
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  }
}
```

这要求 `import type ... from '@deepseek-ai/dsh-llm'`——而那会把 `@deepseek-ai/dsh-llm` 变成
**类型依赖**（现场装的是 `0.2.1-rc.5`，参考树是 `0.2.2-rc.3`，两者的 `GenerateOptions` 已有差异：
`0.2.1-rc.5` 的 `purpose` 是 `'compaction' | 'session-title'` 的封闭联合，`0.2.2-rc.3` 是可扩展的
`LlmRequestPurposeMap`）。

本插件的硬性约束是**运行时不依赖 dsh 包**。所以取舍是：

- **类型**在 `src/dsh-events.ts` 里**本地声明**（只用 `import type` 引 cordis），
  编译期仍有完整类型检查；
- **运行时**零 dsh 依赖。

代价：如果 dsh 改了 `llm/stream` 的签名，本插件不会自动报错，只会运行时行为不对。
对这个"只读观测"的插件来说，这个代价可以接受——而且实测已验证行为正确。

## 5. 写文件：异步、不阻塞、退出前排空

### 5.1 不阻塞模型请求

`enqueue()` 只做两件事：`JSON.stringify` + `push` 进数组。**没有任何磁盘 I/O**。
磁盘写入由一个后台消费者（`drain()`）串行完成。

### 5.2 顺序保证

队列是 FIFO，**单消费者**按入队顺序写。所以：

- **同一 session 的行严格按捕获顺序落盘**（实测：200 次请求，`msg-0` … `msg-199` 完全有序）；
- 多个 session 交错时，全局顺序也是捕获顺序。

### 5.3 退出前排空

```ts
ctx.effect(() => async () => {
  await writer.close()
}, 'memory-debug-capture: flush on dispose')
```

`ctx.effect` 的 disposer 是异步的，cordis 的 fiber 卸载会 **await** 它
（`cordis/src/fiber.ts:720-725`：`await Promise.all(this._disposables.clear().map(...))`），
而 dsh 的关停流程 dispose 根 fiber（`dsh/src/profile-boot.ts:296-303` 的 `dispose()`）。
所以队列会在进程退出前排空。

实测：连发 200 次请求后立刻 `await ctx.fiber.dispose()`，文件里完整出现 200 行且严格有序。

### 5.4 写失败不炸模型

写失败会被记进 `lastError` 并通过 `onError` 回调上报（`ctx.logger.warn`），**不会**抛到模型请求路径上。
写失败时该行**留在队首**，停止本轮消费，避免顺序错乱。

### 5.5 文件锁

用 `createWriteStream(path, { flags: 'a' })`（追加语义）。多个进程/多次运行写同一个文件时
不会互相截断。本插件**不**实现跨进程文件锁——同一时刻只有一个 dsh 进程在采集。

## 6. 截断策略

`MEMORY_DEBUG_MAX_CHARS` 作用于**单条消息的 `text`**（不是整个请求）：

- 超限 → `text` 裁到上限，`chars` 是**裁剪后**长度，额外写 `truncated: true` 与 `originalChars`；
- `reasoning` **同样受上限约束**，规则对称（`reasoningChars` 是裁剪后的长度）；
- 默认**不截断**（上限为 `undefined` 或非正数时）。

**为什么默认不截断**：A/B 实测要 diff 的是"记忆插件往上下文里塞了什么"，截断会破坏 diff。
实测上下文可能上百 KB，JSONL 单行会很大，但这是采集端的自觉取舍——需要控体积时用环境变量开截断。

## 7. 与记忆插件（9O 规格）的关系

本插件是**采集端**，与 `memory-plugin`（被测端）是两个独立的东西：

| | memory-debug-capture（本插件） | memory-plugin（9O 规格） |
|---|---|---|
| 角色 | **采集端**：观测模型看到了什么 | **被测端**：往模型上下文里注入记忆 |
| 挂载点 | `llm/stream`（只读观测） | `tools/post-execute` → `additionalContexts` |
| 数据流 | 模型请求 → JSONL | 会话日志 → 索引 → 检索 |
| 对模型的影响 | **零**（不改请求、不注入） | 改变模型看到的上下文 |

A/B 实验的两轮：`variant=on`（挂 memory-plugin）与 `variant=off`（不挂），其余条件相同，
用 `(runId, variant)` 分组后逐行 diff `messages`。

## 8. 已知限制

1. **`toolName` 是 best-effort**：依赖 tool-call 块与 tool-result 消息在**同一个请求**里。
   若工具调用发生在更早的、被 compaction 遮蔽的轮次里，反查不到，`toolName` 键直接不出现。
2. **图片/文件不折进 `text`**：`image` / `file` 块是引用不是文本，折进去会丢掉引用语义且无法还原。
   `chars` 只统计文本块。
3. **`step` 不是全局单调**：它在每轮内重置，`(turn, step)` 才是唯一标识。
4. **辅助调用不落盘**：`purpose` 为 `compaction` / `session-title` 的请求被跳过。
5. **类型不与 dsh 联动**：`src/dsh-events.ts` 是本地声明（见 §4）。
6. **`options.purpose` 的判定依赖字面量**：dsh 新增 purpose 时，本插件仍会把它当成"普通对话"落盘
   （因为判定条件是 `purpose === undefined`）——这是**安全侧**的失败方式：多落而不是漏落。
