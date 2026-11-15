# DESIGN.md — memory-debug-capture

## 1. 设计目标：同一轮内的「介入前 vs 介入后」

用户要看的**不是**两轮 A/B 对比，而是**同一个请求**送出去之前与之后的上下文：

| 相位 | 捕获点 | 拿什么 |
|---|---|---|
| `before` | `agent/pre-step` | 记忆机制介入**之前**的完整上下文 |
| `after` | `llm/stream` | 介入**之后**真正发给模型的上下文 |

两栏用 `requestKey`（`sessionId#turn#step`）配对，落盘成**两行**（而不是一行两栏）：

- **行内结构与旧格式完全一致**（`messages` / `totals` / `reasoning` / `chars` 语义不变），
  只多了 `phase` 与 `requestKey` 两个顶层键；
- 生成器只需按 `requestKey` 配对，**改动最小**；
- **单栏也能独立渲染**（不依赖另一栏就能看完整内容，不是只有 diff）。

## 2. 为什么选这两个捕获点

[`docs/9Q-debug-capture.md`](../docs/9Q-debug-capture.md) 逐个评估了所有可能的捕获点：

| 候选 | 结论 |
|---|---|
| **`llm/stream` waterfall** | ✅ **after 栏采用**。`options.messages` = 那次请求发给模型的完整上下文 |
| **`agent/pre-step` waterfall** | ✅ **before 栏采用**。配合 `session.deriveMessages()` 能拿到完整上下文（见 §3） |
| `ctx.deepseekLlmApiExtensions` | ❌ 只覆盖 DeepSeek 官方 API，且会往线上请求体加字段 |
| `session.deriveMessages()` 事后重建 | ❌ 只是**当前**派生历史；compaction 会遮蔽旧节点，事后无法精确重建"某次请求当时" |
| `agent/request` | ❌ 已弃用，且 payload 只有 `{ agent, turn, step, signal }` |
| `request/context` / `request/header` | ❌ 会话事件，**都不含 messages** |

`llm/stream` 的三个关键性质（`dsh-llm/src/index.ts:76` 的文档保证）：

1. **`options.messages` 就是适配器输入的完整请求**——「Ordered conversation messages, exactly as the provider sees them」。
2. **已 deep-frozen**（`markAgentLoopRequest`），监听器**只读不改**——这正是调试采集需要的性质：不可能误改模型上下文。
3. **覆盖每一次模型调用**（含重试、title、compaction）——`ctx.llm.stream()` 与 `preparedCall.stream()` 都经过它。

官方先例写法见 `dsh-session-checkpoint-policy/src/index.ts:64-68`（本插件的捕获点写法与之同构）。

## 3. before 栏的完整上下文从哪来（核心）

### 3.1 问题

`agent/pre-step` 的 `payload.messages` **只含本步新领到的消息**（不是完整历史）：

```ts
// dsh-agent-loop/src/agent.ts:293
const claimed = this.inbox.claim(target, position.turn)
// :303 传给 waterfall
```

所以不能直接拿它当 before 栏。

### 3.2 方案 A（采用）：会话派生历史

`payload.agent.session.deriveMessages()`（`dsh-session/src/index.ts:1079`）返回
**模型可见的完整派生历史**。它是缓存的尾部增长快照，每次返回新数组但共享深冻结的 Message。

**关键在时序**（`dsh-agent-loop/src/agent.ts`）：

```
preStep()  :293  claimed = inbox.claim(...)
            :300  assembly = systemPrompt.assemble(...)
            :302  decision = waterfall('agent/pre-step', { messages: claimed, turn, step, ... })
                   ↓  ←←← 本插件在这里读 deriveMessages()
            :367  session.append('step/start', { turn, step })
            :470  for (const message of decision.messages) session.append('user/message', ...)
            :485  request = buildRequest(...)   // :734 const boundaryMessages = session.deriveMessages()
            :496  stream = llm.stream(request)  // → llm/stream waterfall
```

pre-step 运行时，**本步的消息还没进日志**，所以 `deriveMessages()` 返回的就是
「记忆机制介入之前」的完整上下文。

> 这比「用 after 减去本步新增」更准确：减法需要按内容匹配（同一段文本可能出现多次，
> 会删错历史消息），而派生历史是**结构上精确**的。

### 3.3 兜底

`deriveMessages()` 拿不到时（会话对象没有这个方法），退化为「本步新增批次」——
语义是下界（before ⊆ after）。此时 before 栏只显示本步新增，不含历史。

### 3.4 为什么不用 foldSurface / deriveEventMessage

`foldSurface` + `deriveEventMessage`（`dsh-session/src/index.ts:34`）是官方给
**外部重建器**用的日志投影入口。理论上可以按 seq 截止重建 before 栏，但：

1. 需要 `import` `@deepseek-ai/dsh-session` → 破坏「运行时不依赖 dsh 包」的约束；
2. 需要自己跟踪 seq 边界，逻辑更复杂；
3. `deriveMessages()` 已经提供了**同一个**投影结果（`Session.deriveMessages()`
   内部就是 `deriveEventMessage` 逐节点投影，见 `dsh-session/src/index.ts:1088-1097`），
   直接用它更简单且不会与官方投影产生分歧。

## 4. 捕获点的确切 API 用法

### 4.1 after 栏：`llm/stream`

```ts
ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
  // options.messages = 那次请求发给模型的完整上下文（已 deep-frozen，只读）
  collector.handle({ ... })   // 只做内存序列化 + 推进队列
  return next()               // ⚠️ 必须返回 next()，否则短路模型调用
}, { global: true })
```

### 4.2 before 栏：`agent/pre-step`

```ts
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()   // ⚠️ 必须调用 next()，否则这一步被短路
  collector.observePreStep(payload, decision)
  return decision
}, { global: true, prepend: true })
```

三条硬约束：

- **必须调用并返回 `next()`**。waterfall 里不调用 `next()` 就等于否决整条链。
- **`decision.messages` 只读**。它是本步的消息批次（user 角色），插件只读不改。
- **`{ global: true }`**。`agent/pre-step` 是 **agent 作用域**事件，会话作用域里的
  监听器受 scope 过滤约束（`dsh-scope/src/index.ts:170-185`），只有 `global` 监听器
  才能在所有作用域收到。

### 4.3 监听器顺序：**必须用 `prepend`（最外层）**

cordis 的 waterfall **按注册顺序从外到内**（`cordis/src/events.ts:246-261`）：

```ts
waterfall(...args) {
  const inner = args.pop()
  const dispatch = () => {
    const callback = callbacks.shift()   // 先注册的先取出 → 先注册的在**外层**
    if (!callback) return inner()
    ...
  }
  return dispatch()
}
```

**只有最外层的监听器，`await next()` 之后拿到的才是最终决定。**

所以本插件用 `{ prepend: true }` 把自己放到**最外层**：

- `decision.messages` = 记忆机制、AGENTS.md 等注入**之后**的最终批次；
- `session.deriveMessages()` = 内层监听器（含 compaction）跑完后的历史。

如果不 prepend，本插件会排在**最内层**，`await next()` 拿到的还是**尚未**被
其它监听器改写的决定——注入就看不见了。

> **实测验证**（真实 dsh headless 运行）：
> - 第一版（**不** prepend）：before/after 两栏**完全一致**，注入看不见。
> - 改成 prepend 后：before 3 条 / 3072 字符，after 4 条 / 3100 字符，
>   差异**恰好**是那一条注入消息。
>
> 这也是集成验证第 6 段专门测的行为（`scripts/integration-check.mjs`）。

### 4.4 配对键以 pre-step 的 (turn, step) 为准

`step/start` 事件在 pre-step **之后**才提交（`agent.ts:367` vs `agent.ts:302`），
所以从会话事件推导出的 step 号在 `llm/stream` 时可能已经是**下一步**的值。

因此插件：
1. 以 pre-step payload 的 `turn`/`step` 生成 `requestKey` 并记下 before 快照；
2. `llm/stream` 时，先按会话事件推导的键精确匹配；匹配不上则回退到
   「该会话最近一个**未消费**的 before 快照」（`latestUnusedBefore`）；
3. 重试请求**不重复写** before 行（重试复用同一份已渲染结果，
   见 `dsh-agent-loop/README.zh.md:120`），after 行照常写。

> 这一条是集成验证**实测发现**的：最初实现用会话事件的 step 配对，
> 结果 before 行永远配不上（键差一），集成测试直接报红。

### 4.5 轮/步从哪来

`llm/stream` 的 `options` 里**没有** turn/step（见 `GenerateOptions` 的字段清单）。
轮/步来自**会话事件**：

```ts
ctx.on('session/event', (session, event) => {
  // 'turn/start' → { turn }
  // 'step/start' → { turn, step }
}, { global: true })
```

## 5. 分层

```
index.ts     插件装配：挂事件、管生命周期、暴露观测面
  ↓
capture.ts   请求 → 快照（跳过辅助调用）+ requestKey 生成
  ↓
before.ts    after − 插件注入 → before（纯函数）
  ↓
serialize.ts Message[] → CapturedMessage[]（纯函数）
  ↓
writer.ts    队列 → JSONL 文件
```

`capture.ts` / `before.ts` / `serialize.ts` / `writer.ts` **不 import 任何 dsh 包**，
只消费自己声明的最小结构（`CaptureRequest` / `SourceMessage`）。这带来两个好处：

1. `--selftest` 不需要 dsh 运行时就能跑；
2. 以后 dsh 的 `Message` 类型变了，只要那个最小结构还对，这几层不用动。

## 6. 为什么 `src/dsh-events.ts` 存在

三个事件的类型在 dsh 里是通过**声明合并**加进 cordis 的 `Events` 的：

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

代价：如果 dsh 改了事件签名，本插件不会自动报错，只会运行时行为不对。
对这个"只读观测"的插件来说，这个代价可以接受——而且实测已验证行为正确。

## 7. 写文件：异步、不阻塞、退出前排空

### 7.1 不阻塞模型请求

`enqueue()` 只做两件事：`JSON.stringify` + `push` 进数组。**没有任何磁盘 I/O**。
磁盘写入由一个后台消费者（`drain()`）串行完成。

### 7.2 顺序保证

队列是 FIFO，**单消费者**按入队顺序写。所以：

- **同一 session 的行严格按捕获顺序落盘**（实测：200 次请求，`msg-0` … `msg-199` 完全有序）；
- 同一个请求的 before 行**紧邻**其 after 行（写 before 时先入队）。

### 7.3 退出前排空

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

### 7.4 写失败不炸模型

写失败会被记进 `lastError` 并通过 `onError` 回调上报（`ctx.logger.warn`），**不会**抛到模型请求路径上。
写失败时该行**留在队首**，停止本轮消费，避免顺序错乱。

### 7.5 文件锁

用 `createWriteStream(path, { flags: 'a' })`（追加语义）。多个进程/多次运行写同一个文件时
不会互相截断。本插件**不**实现跨进程文件锁——同一时刻只有一个 dsh 进程在采集。

## 8. 截断策略

`MEMORY_DEBUG_MAX_CHARS` 作用于**单条消息的 `text`**（不是整个请求）：

- 超限 → `text` 裁到上限，`chars` 是**裁剪后**长度，额外写 `truncated: true` 与 `originalChars`；
- `reasoning` **同样受上限约束**，规则对称（`reasoningChars` 是裁剪后的长度）；
- 默认**不截断**（上限为 `undefined` 或非正数时）。

**为什么默认不截断**：要 diff 的是"记忆机制往上下文里塞了什么"，截断会破坏 diff。
实测上下文可能上百 KB，JSONL 单行会很大，但这是采集端的自觉取舍——需要控体积时用环境变量开截断。

## 9. 与记忆插件（9O 规格）的关系

本插件是**采集端**，与 `memory-plugin`（被测端）是两个独立的东西：

| | memory-debug-capture（本插件） | memory-plugin（9O 规格） |
|---|---|---|
| 角色 | **采集端**：观测模型看到了什么 | **被测端**：往模型上下文里注入记忆 |
| 挂载点 | `agent/pre-step` + `llm/stream`（只读观测） | `tools/post-execute` → `additionalContexts` |
| 数据流 | 模型请求 → JSONL（两栏） | 会话日志 → 索引 → 检索 |
| 对模型的影响 | **零**（不改请求、不注入） | 改变模型看到的上下文 |

**本次改造不实现记忆注入**——那是 `memory-plugin` 的事。
采集端只需要知道「记忆机制在哪一步介入」，以便把 before/after 配对正确。
本插件用**简单做法**：before = pre-step 时刻，after = llm/stream 时刻，
两者按 `(turn, step)` 配对。任何在 pre-step 与 llm/stream 之间对 messages 的修改，
都会体现为 before/after 的差异——**差异本身就是答案**，不依赖具体是哪个插件注入的。

## 10. 已知限制

1. **`toolName` 是 best-effort**：依赖 tool-call 块与 tool-result 消息在**同一个请求**里。
   若工具调用发生在更早的、被 compaction 遮蔽的轮次里，反查不到，`toolName` 键直接不出现。
2. **图片/文件不折进 `text`**：`image` / `file` 块是引用不是文本，折进去会丢掉引用语义且无法还原。
   `chars` 只统计文本块。
3. **`step` 不是全局单调**：它在每轮内重置，`(turn, step)` 才是唯一标识。
4. **辅助调用不落盘**：`purpose` 为 `compaction` / `session-title` 的请求被跳过。
5. **类型不与 dsh 联动**：`src/dsh-events.ts` 是本地声明（见 §6）。
6. **`options.purpose` 的判定依赖字面量**：dsh 新增 purpose 时，本插件仍会把它当成"普通对话"落盘
   （因为判定条件是 `purpose === undefined`）——这是**安全侧**的失败方式：多落而不是漏落。
7. **重试只写一条 before 行**：同一步的重试复用同一份已渲染结果（`dsh-agent-loop/README.zh.md:120`），
   所以 before 只写一次，after 每次都写。配对时按 `requestKey` 归到同一对里。
8. **系统提示词的重算不计入注入**：系统提示词在 pre-step 之后才投影进 surface，
   若某步重算了它，after 栏会多出一条 system 消息——但它**不算**注入
   （`source.kind === 'system-prompt'` 属于 dsh 自有来源），before/after 不会有假的差异。
9. **`source.kind` 的判定依赖 dsh 的约定**：dsh 自有来源清单
   （`'user'` / `'system-prompt'` / `'runtime-context'` / `'model'` / `'tool'`）
   写在本插件里。dsh 新增一种自有来源时，本插件会把它误判成「插件注入」
   ——这是**安全侧**的失败方式：多算一条差异，而不是漏掉真正的注入。

## 11. 验证（实测）

### 11.1 单元自检（`npm run selftest`）

覆盖：序列化规则、聚合统计、截断、落盘键集合、**before/after 配对**、
**before 重建（after − 插件注入）**、**减法不误删同内容的历史消息**、
**无 id 时退化为内容匹配**。

### 11.2 集成验证（`npm run integration`）

用**真实的** `@deepseek-ai/cordis` + `@deepseek-ai/dsh-llm`：

| 段 | 验证内容 |
|---|---|
| 1 | waterfall 透传：模型调用没被短路 |
| 2 | 落盘内容符合契约 |
| 3 | dispose 前排空 |
| 4 | 200 次请求全部落盘且严格有序 |
| 5 | 双栏采集：before/after 配对、requestKey 一致 |
| 6 | **prepend 顺序**：拿到其它监听器改完之后的批次 |

### 11.3 真实 dsh 端到端（WSL）

**环境**：WSL 里 `/home/assistant/.npm-global/bin/dsh`，profile `web` 与 `headless`。

**限制**：**没有模型凭据**（`~/.dsh/.credentials.yaml` 里只有 browser-session grant，
没有 `DEEPSEEK_API_KEY`），所以真实模型请求跑不通：

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

但**凭据检查发生在请求派发时**，`agent/pre-step` 已经跑完——所以采集链路
仍然被真实 dsh 完整走了一遍：

**验证 1：插件确实被加载**（`dsh --profile headless --dump-config` 里能看到
`dsh-memory-debug-capture`，启动日志无任何插件报错）。

**验证 2：无注入时 before == after**（真实 dsh headless 运行）：

```
line 0: phase=before requestKey=session-58ec...#1#1 step=1 turn=1 msgs=3 chars=3072
line 1: phase=after  requestKey=session-58ec...#1#1 step=1 turn=1 msgs=3 chars=3072
```

**验证 3：挂上模拟记忆注入插件后，差异恰好是那条注入**
（用一个测试插件在 `agent/pre-step` 里注入 `source.kind: 'test-memory-inject'` 的消息）：

```
requestKey 一致: True
before: 3 条 / 3072 字符
after : 4 条 / 3100 字符
注入  : +1 条 / +28 字符
--- 只在 after 里（= 记忆机制注入的内容）---
  [user] [记忆注入测试] 上次你说过项目用 pnpm 管理依赖。
--- 只在 before 里（= 介入后消失的内容）---
（空）
```

**没验证到的**：真实模型请求返回后的上下文（没有凭据）、
以及与真实 `memory-plugin` 的联动（该插件尚未实现挂载点，见 9O 规格）。

**用户可自行复现的端到端命令**：

```bash
# WSL 里
cd ~/dsh-plugins/memory-debug-capture && ./node_modules/.bin/tsc -p tsconfig.json
dsh plugin --profile headless add "link:$HOME/dsh-plugins/memory-debug-capture"
MEMORY_DEBUG_OUT=/tmp/captures MEMORY_DEBUG_RUN_ID=e2e \
  dsh --profile headless "回复一个字：好"
cat /tmp/captures/capture-e2e.jsonl
```
