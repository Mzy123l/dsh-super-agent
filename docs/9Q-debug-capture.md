# dsh 调试与上下文捕获能力

日期：2026-11-15。目标：找到**捕获每次请求上下文并导出**的官方／半官方机制。

> **版本校正**：任务书写 `0.2.1-rc.5`，本机安装树实测为 **`0.2.2-rc.3`**（`@deepseek-ai/*/package.json`）。以下结论全部基于 `0.2.2-rc.3` 的 `src/*.ts`。

## 1. 直接结论（有没有现成办法导出每次请求的完整上下文）

**有官方 seam，但没有"开关即导出"的现成功能——必须自己写一个约 30 行插件。**

| 捕获点 | 拿到什么 | 精确度 | 通用性 |
|---|---|---|---|
| **`llm/stream` waterfall** | `GenerateOptions`：完整 `messages[]`、`tools[]`、`toolHistory`、config | 适配器**输入**的完整请求 | 所有 provider ✅ |
| **`ctx.deepseekLlmApiExtensions`** | `request.body`：已序列化的 DeepSeek Messages **线上请求体** | **字节级最终请求** | 仅 DeepSeek 官方 API |
| **`session.deriveMessages()`** | 派生历史 `Message[]` | 与 `llm/stream` 同源，需自己调 | 所有 provider ✅ |

**没有任何 session 事件直接存着"那次请求发出的 messages"**（`request/header` / `request/context` 都不含，见 §4）。messages 必须投影或实时拦截。

## 2. 调试开关清单

| 开关 / 能力 | 存在？ | 证据 |
|---|---|---|
| `--debug` / `DEBUG=*` | **未找到** | `grep "DSH_[A-Z_]*(DEBUG\|LOG\|VERBOSE\|TRACE)"` 全仓仅命中 `DSH_DIALOG_TITLE`（`dsh-host-directory-picker-native/src/win32-dialog-host.ts:25`） |
| `logLevel` 配置项 | **未找到** | 无任何包声明该 schema。日志走 cordis `ctx.logger`（`cordis/src/logger.ts`），只有 `.info/.warn/.error/.debug`，级别由 exporter 决定，**无配置入口** |
| `dsh-cmdline` | 只做 commander 转发 | `dsh/src/args.ts` 只解析 `--profile/--patch/--dump-config/--dump-default-config/--dump-config-schema/--from-default-profile` |
| `dsh-web-app` flag | 有，与调试无关 | `dsh-web-app/src/startup.ts:64-70`：`--host/--no-open/--port/--public-url/--trusted-host/--tls-cert/--tls-key` |
| `dsh-host-webserver` / `dsh-app-boot` | 无调试开关 | `dsh-app-boot/src/index.ts:1231` 只把 `ctx.logger` 挂给 diagnostics exporter |
| `dsh-experimental-inspector` | **有**，非上下文导出 | README.zh.md:1-2：Chrome DevTools 检查（Console/Sources/Network/Elements），能抓 Host fetch（`captureFetch: true`）→ 可见 LLM HTTP 请求体；但需 Chrome + 调试端口，且「fetch 采集包含密钥等敏感信息」 |
| `dsh-experimental-session-inspector` | **有**，只读日志 UI | README.zh.md:13：「注册 `session-inspector-log` 页面」「本插件不需要调试参数，不接受配置，也不改变 Session 数据」。看得到原始事件 JSON，**看不到 messages 数组**（那是投影产物） |
| `dsh-logs` | **包不存在** | `node_modules/@deepseek-ai/dsh-logs` 不存在；`~/.dsh/logs/` 只有 `dsh-builtin-browser-host.log` |
| `dsh-session-log-export` | 导**会话**不导请求 | README.zh.md:12「Web 界面导出会话的完整历史」，产出 `dsh-session-<id>.zip`（含 `session.vN.jsonl`）+ Markdown；Markdown **明确省略** system/developer 消息、请求头与上下文（:34） |

**结论**：调试开关这条线基本是空的。真调试能力在 Inspector（CDP），上下文导出必须自己写插件。

## 3. 请求级捕获点（逐个评估可行性，附代码位置）

### 3.1 ✅ `llm/stream` waterfall —— 首选

```ts
// dsh-llm/src/index.ts:76
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

- **拿到**：`options` = `GenerateOptions`，其中 `messages: RequestMessage[]`（`dsh-llm/src/types.ts:576`，注释：「Ordered conversation messages, **exactly as the provider sees them**」），外加 `tools` / `toolHistory` / `provider` / `model` / `reasoningEffort` / `maxTokens` / `sessionId`。
- **文档保证**（`dsh-llm/src/index.ts:68-73`）：「the full request. A LOOP-built request carries the process-local `markAgentLoopRequest` identity and arrives **deep-frozen** (mutation throws): its content is a **pure function of the session log** …, so listeners **read it, never rewrite it**.」
- **覆盖范围**：`ctx.llm.stream()` 与 `preparedCall.stream()` **都**经过它（`dsh-agent-loop/src/agent.ts:496` → `dsh-llm/src/index.ts:1193-1198`）。**每次**模型调用（含重试、title、compaction）都被覆盖。
- **官方使用者**：`dsh-session-checkpoint-policy/src/index.ts:64-68`、`dsh-session-title/src/index.ts:360-363`（后者用 `{ global: true, prepend: true }`）。
- **限制**：请求 deep-frozen **不能改**（正合 debug 需求）；图片在适配器才投影为 base64（`dsh-llm-deepseek/src/images.ts`），此处是 `ImageAttachmentRef` 引用。

### 3.2 ✅ `ctx.deepseekLlmApiExtensions` —— 字节级最终请求（仅 DeepSeek）

`DeepSeekLlmApiExtensionRequest`（`dsh-deepseek-llm-api-extensions/src/types.ts:19-28`）含 `readonly body: Readonly<Record<string, DeepSeekLlmApiJson>>`（已序列化的基础请求体）+ `sessionId` / `purpose` / `signal`。README.zh.md:30：「每个提供方都会看到**确切的已序列化 Messages 请求体**」。调用点：`dsh-llm-deepseek/src/adapter.ts:119-134` → `serialize()` 产出 `body` → `prepareRequestExtensions(body, ...)` → `fetch(..., body: extensions.payload)`（:143）。用法：`ctx.deepseekLlmApiExtensions.register('my_field', { prepare(request) { return { value: {...} } } })`。**限制**：README.zh.md:49「**仅限 DeepSeek 官方请求**——该注册表刻意不提供提供方无关的路由，也不集成 pi-ai 适配器」；且会**往线上请求体加字段**，字段名须 declaration-merge。

### 3.3 ⚠️ `agent/pre-step` waterfall —— **不能**拿到完整上下文

签名（`dsh-agent/src/runtime-types.ts:351`）：`'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal; modelSelection: Readonly<ModelSelection> }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>`

- **`payload.messages` 不是完整历史**，只是**本轮从 inbox 领取的消息**：`dsh-agent-loop/src/agent.ts:293` `const claimed = this.inbox.claim(target, position.turn)` → `:303` 传入 waterfall。README.zh.md:343：「`payload.messages` - messages removed from the inbox for this step」。
- **时序**：pre-step 在 `step/start` 之前、`system/message` 与 `user/message` 提交之前（`dsh-agent-loop/src/agent.ts:459-483`），此时**还没有**完整派生历史。
- **可间接拿到**：`payload.agent.session` → `Session.deriveMessages()`（`dsh-agent/src/runtime-types.ts:195`），但那是**上一步结束时**的历史。
- **改 system prompt**：确实不能。`PreStepDecision` 只有 `{ kind:'reject' }` 或 `{ kind:'enter'; messages: UserMessage[]; startsRequestSeries? }`（`dsh-agent/src/runtime-types.ts:139-146`），`messages` 是 user 角色。
- **可用作**：注入记忆上下文。范例 `dsh-agent-instructions/src/index.ts:330-356`。

### 3.4 ❌ `agent/request` waterfall —— 已弃用且信息最少

`dsh-agent/src/runtime-types.ts:374`，payload 只有 `{ agent, turn, step, signal }`，**无 messages**。README.zh.md:363：`@deprecated`「Retained for existing listeners; do not add new listeners.」

### 3.5 ❌ `dsh-http-proxy` —— 是出站代理，不是抓包

README.zh.md:28：「无需挂载，也无需配置」，启动器在第一个插件加载前装好策略。README.zh.md:97：「本包只承担传输策略：它改变字节如何抵达网络，**不注册任何提示词、schema 或结果文本**」。它只装 undici 全局 dispatcher，**不记录请求体**。

### 3.6 ❌ `dsh-session-log-deepseek` 的 `dsh_session_log` —— 是日志不是请求

README.zh.md:41：「对 `Session.events` 取快照，并发送水位之后能放进 `maxBytes` 的最长连续事件段」——**会话事件流**（user/message、assistant/message、tool/result 等），**不含**每次请求的 messages 快照。

## 4. `request/context` 事件的实际内容（重点）

**不含 messages，也不是"完整上下文快照"。只有 4 个字段。**

```ts
// dsh-agent-loop/src/agent.ts:717-729
const requestContext: RequestContext = {
  provider: config.provider,
  model: config.model,
  ...contextWindow === undefined ? {} : { contextWindow },
  ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
}
if (previousContext?.provider !== requestContext.provider
  || previousContext.model !== requestContext.model
  || previousContext.contextWindow !== requestContext.contextWindow
  || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
  session.append('request/context', requestContext)
}
```

- **写入条件**：**仅在这 4 项任一变化时**追加（快照式对比）→ **不是每轮一条**。`dsh-session/README.zh.md:135` 同义。
- 它**不是** `SurfaceEventType`，**不产生任何 LLM 消息**（`dsh/docs/subsystems/session.zh.md:212`）。
- **消费方**：`dsh-token-meter` 取 `contextWindow`（`dsh-token-meter/src/usage-projection.ts:175`）；`dsh-web-search-deepseek` 判断是否走账号鉴权（`src/index.ts:90`）。

**`request/header` 同样不含 messages**——它是 `EpochHeader` = `config` + `adapterDefaults` 标记 + 组装后的 `tools` schema。README.zh.md:185：「渲染后的系统提示词不属于请求头：它是**派生历史**」。

> **要点**：**没有任何一条 session 事件**直接存着"那次请求发出的 messages 数组"。

## 5. 从本地日志重建某次请求上下文的方法（可行性 + 限制）

**可行性：✅ 可行，有官方支持。** `dsh-agent-loop/src/agent.ts:734-748` 构建请求时就是 `const boundaryMessages = session.deriveMessages()` → `messages: boundaryMessages`。`dsh-session/src/index.ts:1079-1100` 该投影是**缓存的、冻结的**（每次返回新数组但共享深冻结 `Message`）。`dsh-session/src/index.ts:1108` 的 `deriveEventMessage(event)` 是**公开的逐节点纯函数**，注释（`dsh/docs/subsystems/session.zh.md:700`）：「公开暴露以便**外部重建器**能以完全相同的规则投影日志前缀，不会与缓存产生分歧」→ 官方给外部重建器的入口；`dsh-session/src/index.ts:34-35` 导出 `deriveEventMessage` / `foldSurface` / `foldRequestHeader` / `canonicalHeader`。`dsh-session/README.zh.md:135`：「`foldRequestHeader(events)` … **使每个对话请求都成为日志的纯函数**」。

**重建步骤**：① 读 `session.v4.jsonl.zstd`（`~/.dsh/sessions/<project>/<session-id>/`）——**zstd 帧格式需用后端读**（`dsh-session-persistence-jsonl/README.zh.md:166`）；更省事：`ctx.sessionQuery.readSession(id)`（`dsh-session-query/README.zh.md:35`「经过回放校验的完整原始事件日志，且不会让该会话变为实时」）或 `dsh-session-log-export` 的 `/export` 拿 ZIP。② `foldSurface(events)` → surface 节点序列。③ 逐节点 `deriveEventMessage(event)` → `Message[]`。④ `foldRequestHeader(events)` → `EpochHeader`。⑤ 组合 `{ ...header.config, messages, tools: header.tools }` = 该请求。

**限制（务必记录）**：

| 限制 | 证据 |
|---|---|
| **只能重建"当前"状态，不能重建"某次请求当时"** | `deriveMessages()` 是尾部增长缓存（`dsh-session/src/index.ts:1088-1099`）；compaction 的 `surfaceOp:'replace'` **删掉**被遮蔽节点（`dsh-session/src/surface.ts:418-432`）。历史请求的原始 messages **无法事后精确重建** |
| **同序列多步共享同一 header** | `request/header` 只在 loop 边界／变更／显式开序列时写（`dsh-agent-loop/src/agent.ts:681-697`），第 2、3 步沿用最新快照 |
| **消息级有损** | 空内容 `assistant/message`（max-tokens 截断）**不进入** transcript（`dsh/docs/subsystems/session.zh.md:703`）；Markdown 导出省略 system/developer 消息与注入上下文（`dsh-session-log-export/README.zh.md:34`） |
| **图片/FileBlock 是引用非字节** | 适配器发送时才投影成 base64/file_id（`dsh-llm-deepseek/src/images.ts`） |
| **工具增删走 `developer/message`** | `dsh-agent-loop/src/agent.ts:698-711`，带 `headerSeq` 引用，不是普通 message |
| **重试不重跑 pre-step** | `dsh-agent-loop/README.zh.md:120`：「重试复用同一份已渲染组装结果，不重复组装、`agent/pre-step` 或用户消息准入」→ 重试请求与首投 messages 相同 |

**结论**：日志重建适合**事后审计**（"这会话现在发给模型的是什么"），**不适合** A/B 实测里的"逐轮精确快照"——compaction 会抹掉历史。

## 6. 插件挂载点用法（post-execute / pre-step 的确切签名与限制）

**6.1 `tools/post-execute` —— 注入上下文用，但拿不到请求上下文。** 签名（`dsh-tools/src/events.ts:41`）：`'tools/post-execute'(this: Scoped<ToolsService>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>`。返回格式（`dsh-tools/src/contracts.ts:386-389`）：

```ts
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; info?: ToolErrorInfo; additionalContexts?: UserMessage[] }
```

`additionalContexts?: UserMessage[]` —— **每轮工具执行后**追加到 inbox 的 `next-step` 边界，成为下一轮 user 消息（`dsh-agent-loop/src/agent.ts:600-602`：`for (const context of result.additionalContexts) this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])`）。**约束**（`dsh-tools/src/pipeline.ts:510-518`）：`'tools/post-execute accept decision cannot replace both value and content'`；`'tools/post-execute cannot replace the value of a failed result'`。**重要**：`additionalContexts` 是 **user 角色**注入，**不是 system**；要注入 system 级内容需走 `dsh-system-prompt` 的 assemble waterfall 或 `dsh-agent-instructions` 那套。范例：`dsh-repeat-tool-reminder/src/index.ts:220`、`dsh-tool-fs-search/src/grep.ts:346`、`dsh-spill-policy/src/index.ts:134`。

**6.2 `agent/pre-step` —— 改写"进入本步的消息"。** 签名见 §3.3；`PreStepDecision`（`dsh-agent/src/runtime-types.ts:139-146`）= `{ kind:'reject' }` | `{ kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true }`。改写范例（`dsh-agent-instructions/src/index.ts:348-355`）：

```ts
const lastClaimedIndex = decision.messages.findLastIndex(m => messages.includes(m))
const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
return { ...decision, messages: entered }
```

**不能改 system prompt**（只能换 `UserMessage[]`；系统提示词走 `system/message` surface 节点，由 `dsh-system-prompt` 装配决定）。**`startsRequestSeries: true`** 强制开**新消息序列**（`dsh-agent-loop/src/agent.ts:458`）→ **对 A/B 对比有用**。

**6.3 `ctx.sessions` / `ctx.agents` API。**

| API | 位置 | 说明 |
|---|---|---|
| `ctx.sessions.get(id)` / `.list()` | `dsh-session/src/index.ts:1455, 1463` | 取 live session / 全部（创建顺序） |
| `ctx.sessions.fork(source, boundary?, childId?)` | `dsh-session/src/index.ts:1483` | fork（boundary = 含的 seq） |
| `session.deriveMessages()` | `dsh-session/src/index.ts:1079` | **当前**派生历史 |
| `session.deriveEventMessage(event)` | `dsh-session/src/index.ts:1108` | 逐事件投影（外部重建器入口） |
| `session.requestHeader()` / `requestContext()` | `dsh-session/src/index.ts:1007, 1028` | 最新 header/context 折叠 |
| `session.surface` | `dsh-session/src/index.ts:562` | `SessionSurface { nodes, replaceGeneration, contentGeneration }`（`dsh-session/src/surface.ts:245-252`） |
| `ctx.agents.get(id)` / `.list()` | `dsh-agent/src/index.ts:580, 588` | agent 枚举 |
| `agent.session` | `dsh-agent/src/runtime-types.ts:195` | agent → session |
| `agent.inbox.nextTurn` / `nextStep` | `dsh-agent/src/runtime-types.ts:77-79` | 待投递消息 |
| `ctx.sessionQuery.readSession(id)` | `dsh-session-query/README.zh.md:35` | 读**持久化**会话完整日志 |

## 7. 建议的实测方案

**方案 A（推荐）：写 `ctx-capture` 插件挂 `llm/stream`。** 理由：唯一 provider-neutral、覆盖每次模型调用（含重试）、`messages` 与适配器输入**同一份对象**、请求已 deep-frozen 不会被误改、注册只需 `ctx.on('llm/stream', ...)`。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export function apply(ctx: Context): void {
  let n = 0
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    void writeSnapshot(++n, options)   // 写 JSONL 到工作目录
    return next()                      // ⚠️ 必须返回 next()，否则短路模型调用
  })
}
```

快照内容：`{ n, provider, model, sessionId, reasoningEffort, maxTokens, messages, tools, toolHistory }`；`messages` 已 deep-frozen，`JSON.stringify` 即可。A/B 要点：① 文件名带 `sessionId` + 序号，天然分成"启用记忆插件"与"未启用"两栏；② `messages[0]` 通常是 system-role 消息（承载渲染后的 system prompt），记忆注入内容会出现在这里或某条 user 消息里，**直接 diff 即可**；③ ⚠️ 过滤非对话调用——`options.purpose === undefined` 才是普通对话（`dsh-llm/src/types.ts:600-605`），title/compaction 调用会混进来。

**方案 B（补充）：`agent/pre-step` + `session.deriveMessages()`。** 额外记一份"上一轮结束时的完整历史"，用于对比 compaction 前后。**不能**替代 A（本轮将发的 messages 拿不到），但能验证"记忆注入是否真进了 surface"。

**方案 C（校验用，仅 DeepSeek 官方）：`ctx.deepseekLlmApiExtensions`。** 注册字段（如 `dsh_debug_capture`），在 `prepare(request)` 里存 `request.body`。拿到**字节级最终请求体**（图片已 base64、FileBlock 已换成句柄文本）。代价：污染线上请求 + 需 declaration-merge。

**不推荐**：❌ `dsh-http-proxy`（不记录请求体）；❌ Inspector `captureFetch`（能抓真实 HTTP body，但要开 DevTools 面板手动导出且泄露密钥，A/B 自动化成本高）；❌ 纯靠 `session.v4.jsonl.zstd` 事后重建（compaction 抹历史，做不了逐轮精确快照）。

**交付 HTML 的衔接**：快照落盘 JSONL（每行一个请求）→ 离线脚本按 `sessionId` 分组、按序号配对 → 生成左右两栏气泡 + 增量 diff（比较 `messages` 数组逐条 diff）。这样**不依赖 DSH 内部 API 稳定性**，也不受 compaction 影响。
