# dsh 上下文与记忆机制解剖

> 分析对象：DeepSeek Harness `0.2.1-rc.5`
> 源码根：`E:\Applications\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\`
> 只读分析，未修改任何 dsh 文件。
> 标注约定：**文档说** = README/文档原文；**代码做** = `lib/*.js` 实际实现；两者冲突处显式指出。`[推测]` = 无直接证据的推断。

---

## 0. 一句话结论（先给答案）

一次请求的上下文 = **`request/header`（配置+工具 schema，日志态）** + **`Session.deriveMessages()`（有序 surface 投影）**，其中 surface 投影的第 0 号节点是渲染后的 system prompt（`system/message`），其后依次是 developer 工具增删通告、用户/harness 注入消息、assistant 消息、工具结果。

**关键结构事实：system prompt 不是请求字段，而是会话日志里的一个 surface 节点。** 这决定了压缩永远不能碰它（`selectCompactableRange` 从第 1 号节点起才算候选），也决定了改提示词 = 换一个节点 = KV cache 从该点起失效。

**关键缺陷事实：整个压缩/裁剪链路是"替换 + 单向"，模型只能看到结果，看不到"丢了什么、丢了多少、还能不能取回"。** 原始事件仍躺在日志里，但模型没有任何接口去读——这个落差就是全部补救空间所在。

---

## 1. 一次请求的上下文装配全流程（含顺序图）

### 1.1 入口与调用链

| 阶段 | 文件 : 行 / 函数 | 做什么 |
|---|---|---|
| 轮次开启 | `dsh-agent-loop/lib/index.js:737` `turn()` | `append('turn/start')`，进入步骤循环 |
| 步骤准备 | `dsh-agent-loop/lib/index.js:679` `preStep()` | 领取 inbox、`model.current()`、`tools.resolve()`、`systemPrompt.assemble()` |
| 提示词组装 | `dsh-agent-loop/lib/index.js:692` → `dsh-system-prompt/lib/index.js:358` `assemble()` | 所有 section/context/tool provider 求值 + `system-prompt/assemble` waterfall |
| 准入裁决 | `dsh-agent-loop/lib/index.js:698` `dispatch.waterfall("agent/pre-step", …)` | 插件可 reject 或替换 `messages` 批次 |
| 提示词渲染 | `dsh-system-prompt/lib/index.js:119` `renderPrompt()` | 段按 order 排序、过滤空段、`\n\n` 连接、`{{var}}` 插值 |
| 路由绑定 | `dsh-agent-loop/lib/index.js:999` `prepareRequest()` | 弃用的 `agent/request` waterfall → `ctx.llm.prepareCall()` |
| 上下文刷新 | `dsh-agent-loop/lib/index.js:856` `refreshContext()` | **只重算 runtime context**，不重跑 sections/tools/variables |
| 提示词提交 | `dsh-agent-loop/lib/index.js:863` `SystemPromptProjection.project()` | 决定 append 新系统节点 / 原地替换 / 不动 |
| 用户消息准入 | `dsh-agent-loop/lib/index.js:873-879` | runtime-context 快照 + 已领取消息依次 `append('user/message')` |
| 请求派生 | `dsh-agent-loop/lib/index.js:881` `buildRequest()` → `:1031` | header 记账、`session.deriveMessages()`、深冻结、`Object.freeze` |
| 流式请求 | `dsh-agent-loop/lib/index.js:890` | `preparedCall.stream(request)` |

### 1.2 最终请求的形状

`dsh-agent-loop/lib/index.js:1098-1105`：

```js
markAgentLoopRequest(Object.freeze({
  ...header.config,          // 提供方/模型/推理强度/输出上限
  messages: boundaryMessages, // ← 全部来自 deriveMessages()
  toolHistory: session.toolHistory(),
  ...header.tools !== void 0 ? { tools: header.tools } : {},
  sessionId, signal,
}))
```

**没有 `system` 字段。** 这是全篇最重要的结构断言，`dsh/docs/subsystems/session.zh.md:185` 也明说："渲染后的系统提示词不属于请求头：它是派生历史，即 surface 第 0 号节点上的 `system/message` 事件"。

### 1.3 system prompt 内部的段顺序（渲染顺序）

段按 `order` 升序，同 order 按名称 code-unit 排序（`dsh-system-prompt/lib/index.js:103-105`）。仓库集中定义了两张 order 表：

**`SECTION_ORDERS`（`dsh-system-prompt/lib/index.js:10-46`）** — 进 system prompt 正文：

```
-1000  HarnessIdentity        "You are an AI agent powered by DeepSeek Harness."
    0  DeploymentPersonaPrefix
  500  PlanPolicy               (dsh-plan-mode)
  600  TeamPolicy               (dsh-tool-agent-team)
  800  PtcOnly
  900  FileReference
 1000  ToolBash
 1010  ToolPwsh
 1100  ToolRead  / 1200 ToolWrite / 1300 ToolEdit / 1350 ToolApplyPatch
 1400  ToolGlob  / 1500 ToolGrep / 1600 ToolJobs / 1700 ToolPty
 2000  ToolWebSearch / 2100 ToolWebFetch / 2200 ToolLsp
 2300  ToolSessionQuery / 2400 ToolGoal / 2500 ToolSchedule
 2600  ToolWorkflow / 2700 ToolRalph / 2800 ToolSubagent / 2900 ToolReport
 3000  ToolComputerUse / 3100 McpServers / 5000 ToolsSdk
 9000  DeliverableFileReferences / 9900 StructuredOutput
10000  HarnessSource / 10100 WebSurface
10200  DeploymentPersonaSuffix
```

**`CONTEXT_ORDERS`（`dsh-system-prompt/lib/index.js:47-54`）** — 进 runtime context 快照：

```
100 WorkingDirectory / 110 SandboxPolicy / 115 ApprovalPolicy
120 SubagentDelegation / 200 HarnessSource / 210 WebSurface
```

**关键：`DEPLOYMENT_PERSONA_PREFIX` 的 order 是 0，`HARNESS_IDENTITY` 是 -1000。** 也就是说身份段之后立刻就是人设前缀，随后才是全部工具指引。当前 web profile 把这段设成：

```yaml
# dsh-web-app/cordis.patch.yml:19
personaPrefix: >-
  You are a coding agent powered by the {{model}} model.
```

### 1.4 完整装配顺序图

```
┌─ SessionEvent[] (仅追加日志) ──────────────────────────────────────────┐
│ turn/start → [preStep] → step/start → system/message → user/message*   │
│ → assistant/message → tool/result → … → step/end → turn/end            │
└───────────────────────────────────────────────────────────────────────┘
                                │
         ① assemble()          │  ② 准入            ③ deriveMessages()
   ┌────────────────────┐      │                ┌──────────────────────┐
   │ 遍历 scope layers  │      │                │ surface 有序节点投影  │
   │  ├ variables       │      │                │  node0: system/message│
   │  ├ sections (排序) │      │                │  node1: developer msg │
   │  ├ contexts (排序) │      │                │  node2..: user/assist │
   │  └ toolProviders   │      │                │          /tool/result │
   │   ↓ structuredClone│      │                │ (被 replace 遮蔽的节点 │
   │  system-prompt/    │      │                │  已从投影中消失)      │
   │    assemble        │      │                └──────────────────────┘
   │    (waterfall)     │      │                          │
   └────────────────────┘      │                          ▼
            │                  │              ┌──────────────────────┐
            ▼                  ▼              │ buildRequest()       │
   ┌────────────────────────────────────┐     │ {                    │
   │ agent/pre-step waterfall           │     │   ...header.config,  │
   │  ├ inject() 插件可为 messages 加料 │────▶│   messages,          │
   │  ├ 可 reject 整个步骤              │     │   toolHistory,       │
   │  └ 可声明 startsRequestSeries      │     │   tools, signal      │
   └────────────────────────────────────┘     │ }  ← 无 system 字段  │
                                              └──────────────────────┘
                                                        │
                                     agent/request (弃用) → prepareCall()
                                                        │
                                                        ▼
                                              llm.stream(request)
```

### 1.5 runtime context 的独立通道（易被忽略）

`dsh-system-prompt` 的 `contexts` **不进 system prompt**，而是被渲染成一条 `<system-reminder>` 包裹的 **user 消息**，追加在历史尾部（`dsh-agent-loop/lib/index.js:338-355`）。

```
<system-reminder>
The following information describes your current session:
…(working-directory / sandbox-policy / approval-policy / subagent-depth)…
</system-reminder>
```

后续快照的开头会变成 "…It replaces earlier versions of this context, including any retained in conversation summaries."（`:342`）——这是**唯一一处显式的"苏代/覆盖"声明**，值得注意它只覆盖 runtime context，不覆盖对话内容。

各 context 贡献者（grep 实测）：

| 包 | context name | required |
|---|---|---|
| `dsh-working-directory` | `working-directory:current` | ✅ true |
| `dsh-sandbox-policy` | 沙箱模式 | — |
| `dsh-user-approval` | 审批策略 | — |
| `dsh-tool-subagent` | `tool:<name>:depth` | — |
| `dsh-tool-subagent-control` | 子代理控制 | — |
| `dsh-harness-dev-context` | 开发上下文 | — |

**结论：current working directory 是 `required: true`，即使 `includeRuntimeContext: false` 也会保留。**（`dsh-persona/README.zh.md:49`）

---

## 2. 可用的注入点

### 2.1 完整注入点表

| # | 注入点 | 时机 | 能力 | 限制 | 证据 |
|---|---|---|---|---|---|
| 1 | `ctx.systemPrompt.section()` | **每步**重算 | 往 system prompt 加一段，全局或 agent 作用域；同名可遮蔽 | 只能加文本；`complete: true` 段会**独占**整个 prompt（且不允许两个）| `dsh-system-prompt/lib/index.js:255`、`:383-384` |
| 2 | `ctx.systemPrompt.context()` | **每步**重算（内容变才注入）| 动态运行时事实，渲染成 user 角色 `<system-reminder>` | 新内容与上次相同则不注入；`required` 段压不掉 | `:281`、`:338-355` |
| 3 | `ctx.systemPrompt.variable()` | 每步重算 | 注册 `{{name}}` 供 section/context 插值 | 名字须 `^[a-z][a-z0-9_]*$`；引用未注册变量会**抛错** | `:312`、`:174-179` |
| 4 | `system-prompt/assemble` waterfall | **每步**，在 assemble 末尾 | 拿到完整 assembly（sections+contexts+variables）整体改写 | 返回值有权威性；`complete` 段会在其后被恢复，监听器**加不进去** | `:401`；`dsh/docs/subsystems/system-prompt.zh.md:218` |
| 5 | `agent/pre-step` waterfall | **每步**，组装后、提交前 | ① `reject` 整个步骤 ② 替换/增删进入本步的 `messages` 批次 ③ 声明 `startsRequestSeries` | **不能**改 system prompt、不能改工具 schema、不能改模型选择（改了三者会被 loop 抛错）| `dsh-agent-loop/lib/index.js:698`；`dsh/docs/subsystems/core.zh.md:1043` |
| 6 | `Agent.inject()` | 当次（落在下一个被接纳的步骤）| 追加持久化 user 消息，**不唤醒**驱动器 | 必须自行处理已 dispose 的 agent；`source.kind` 需提前在 `MessageSourceMap` 声明 | `dsh-agent/README.zh.md:58`；`dsh/docs/cookbook/adding-a-tool.zh.md:50` |
| 7 | `Agent.steer()` | 当次（下一步输入）| 追加并**唤醒**驱动器 | 与 inject 相同来源限制 | `dsh-agent/README.zh.md:58` |
| 8 | `Agent.followup()` | 下一轮 | 排队普通提示词并唤醒 | 同上 | 同上 |
| 9 | `tools/post-execute` 返回 `additionalContexts` | 当次工具调用后 | 随工具结果追加额外 user 消息 | 只在工具调用路径上可用 | `dsh-tool-*` / `dsh-repeat-tool-reminder/lib/index.js:238-245` |
| 10 | `agent/request` waterfall | 每步，路由绑定前 | 改请求控制参数（如 `maxTokens`）| **已弃用**；改 provider/model/reasoningEffort 会抛错 | `dsh-agent-loop/lib/index.js:1007-1014` |
| 11 | `agent/created` | agent 创建时一次 | 装监听器、注册作用域工具/段 | 不得 `await whenIdle()` | `dsh/docs/subsystems/core.zh.md:905` |
| 12 | `agent/turn-stopping` (serial) | 轮次将关闭前 | 通过 `steer()` 让轮次继续 | serial 语义，不返回 decision | `dsh/docs/subsystems/core.zh.md:1126` |
| 13 | `agent/request-error` waterfall | 请求失败后 | 返回 `{kind:'retry'}` 重试 | 只在此刻 | `:1072` |
| 14 | `system-prompt/change` (emit) | 注册/释放时 | 通知 UI 或触发重算 | 只读通知 | `dsh-system-prompt/lib/index.js:224` |
| 15 | `agent.ctx`（agent 作用域）| 创建时 | 让单个 agent 的段/工具/监听器与邻居隔离 | 只能用于 `ctx.agents.create/resume` 的 setup，配置式 agent 无此能力 | `dsh-agent/README.zh.md:74`、`:235` |

### 2.2 按"重注入频率"分类

**每轮重注入（每 step 都重算 / 每 turn 都重发）**
- `systemPrompt.section()` / `.context()` / `.variable()`：每次 `assemble()` 都重新求值每个 provider（`dsh-agent-loop/lib/index.js:692`，每 step 一次）
- 完整 surface 历史：`deriveMessages()` 每次请求都重新派发**全部未遮蔽节点**

**每步注入**
- `agent/pre-step` waterfall 的 `messages` 增删
- runtime context 快照（内容变才真正 append；见 `RuntimeContextProjection.project()` `dsh-agent-loop/lib/index.js:338-355`）

**仅当次**
- `agent.inject()` / `steer()` / `followup()`：写一次，之后靠"保留在历史里"持续可见，直到被压缩遮蔽
- `tools/post-execute` 的 `additionalContexts`

### 2.3 `agent/pre-step` 到底能改什么（这是评审重点）

签名（`dsh/docs/subsystems/core.zh.md:1043`）：

```ts
'agent/pre-step'(this: Scoped<Agent>, payload: {
  agent, messages: UserMessage[], turn, step, signal, modelSelection
}, next): Promise<PreStepDecision>
```

`PreStepDecision` 只有两个分支（`dsh-agent/README.zh.md:98`）：

- `{ kind: 'reject' }` — 拒绝本步骤
- `{ kind: 'enter', messages, startsRequestSeries? }` — 进入，携带"完整、带标识且冻结的消息批次"

**能改的**：进入本步的 user 消息批次（可增、可删、可换）。
**不能改的**：
- system prompt（已由 `assemble()` 定型，`project()` 在 pre-step **之后**才跑，但用的是 `assembly` 不是 decision——`dsh-agent-loop/lib/index.js:852、863`）
- 工具 schema（`toolSet` 由 `tools.resolve()` 在 pre-step 之前就已解析，`:686`）
- 模型选择（`selection` 在 pre-step 之前捕获，payload 里是 `Readonly<ModelSelection>`）

真实例子：`dsh-agent-instructions` 用 pre-step 往 `decision.messages` 里 splice 插入 AGENTS.md 消息（`dsh-agent-instructions/lib/index.js:1480-1498`）；`dsh-goal-round-driver` 用 pre-step 校验并声明 `startsRequestSeries: true`（`dsh-goal-round-driver/lib/index.js:352-355`）。

---

## 3. 记忆机制现状

### 3.1 压缩（compaction）

#### 3.1.1 触发条件（三种，全部有代码证据）

| 触发 | 挂载点 | 条件 |
|---|---|---|
| 步骤压力 | `agent/pre-step`（serial）| `measurement.totalTokens >= thresholdTokens` |
| 模型切换 | `agent/request`（`prepend: true`）| 目标路由与已记录路由不同，且按目标容量测压超阈值 |
| 上下文溢出 | `agent/request-error` | `failure.code === 'CONTEXT_WINDOW_EXCEEDED'`，绕过阈值与保留策略 |
| 手动 | `/compact` → `compactNow()` | 用户输入 |

代码：`dsh-compaction-basic/lib/index.js:839-905`（注册）、`:932-947`（分发）、`:949-978`（压力判定）。

#### 3.1.2 阈值公式（文档说 = 代码做）

默认阈值（`dsh-compaction-basic/README.zh.md:64`）：

```
threshold = floor(min(W × 0.8, W − O − 65536))
retain    = floor((W − O) × 0.16)
```

代码完全一致（`dsh-compaction-basic/lib/index.js:130-134`）：

```js
const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;
const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
const retainTokens = policy.retainTokens === void 0 ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens;
```

当前 web profile 的 `compaction-basic` **没有任何 config**（`dsh-base/cordis.patch.yml:355-356`），所以全部走默认：`0.8 / 65536 / 0.16`。

> 注意：`headroomTokens: 65536` 意味着**窗口 ≤ 65536+输出预留的模型直接配置失败**（`TargetPressureConfigError`，`:131`），文档在 `README.zh.md:90` 承认这点。

#### 3.1.3 遮蔽范围如何选择（核心算法）

`selectCompactableRange()`（`dsh-compaction-basic/lib/index.js:410-433`）：

```js
const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;  // 跳过 node0
// 从尾部向前累加，直到 >= retainTokens
for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
  accumulated += pricedNodes[index].tokens;
  keepFromIdx = index;
  if (accumulated >= retainTokens) break;
}
// 再向前推，直到落在"工具对平衡"位置
while (keepFromIdx > firstIdx) {
  if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
  keepFromIdx -= 1;
}
return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] };
```

**三个硬约束：**
1. **永远从第一个非 system 节点开始。** system prompt 节点（node 0）**永不被遮蔽**（`:415`；文档 `README.zh.md:123`）
2. **尾部按 retainTokens 逐字保留**
3. **绝不拆开 assistant tool-call / tool-result 配对**（`toolPairingBalancedBefore`）

**这意味着压缩是"从头上削一大块"，不是"挑重要的留"。** 没有语义选择、没有重要性打分、没有分页。

#### 3.1.4 摘要 prompt（原文引用）

`dsh-compaction-basic/lib/index.js:234-280`。指令是**追加在回放历史之后的最后一条 user 消息**，不是独立的 summarizer system prompt——**这是为了复用提供方 KV cache**（注释原文："Keeping the conversation's own system prompt, tools, and message prefix in front of it makes the auxiliary call a genuine prefix of the last routed request"）。

结构（8 个固定小节，缺一不可）：

```
## Primary Request and Intent
## Key Technical Concepts
## Files and Code
## Errors and Fixes
## Pending Jobs
## Current Work
## Next Step
## Critical Context
```

关键 Rules（`:274-279`）：

- `Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.`
- `Do NOT mention this summarization request or that the context was compacted.` ← **注意这条**
- `If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`

#### 3.1.5 注入格式

`frameSummary()`（`:344-356`）+ `CHECKPOINT_PREAMBLE`（`:280`）：

```
This is an automatically generated checkpoint condensing an earlier span of the
conversation to free up context. Treat the captured context as established
background and build on it without restating it. Continue the task directly from
the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
## Primary Request and Intent
- …
</compacted-summary>
```

这条消息以 `user` 角色、`surfaceOp: { op: 'replace', startSeq, endSeq }` 提交（`:650-661`）。

#### 3.1.6 压缩后模型看到什么

- 一条 user 角色的 checkpoint 消息（含 preamble + `<compacted-summary>` 块）
- 其后是**逐字保留的近期尾部**
- runtime context 快照若被遮蔽，会**重新注入**（`dsh-agent-loop/README.zh.md:172`）

- **看不到**：被遮蔽的原始事件（虽然仍在日志里）
- **看不到**：compaction 的元数据（`shadowedSeqs`、`shadowedTokenCount`、摘要用的 provider/model、usage）——这些全在 `compaction/summary` **log-only** 事件里（`dsh-compaction-basic/lib/index.js:634-649`）
- **看不到**：这是第几次压缩

#### 3.1.7 有没有"只追加"模式？

**没有。** 压缩永远是 `replace`（`:650-661`）。

对比之下，**system prompt 有 append-only 通道**：当路由声明 `systemPromptUpdate: 'in-history'` 时，变化后的提示词会**追加**成新的 `system/message` 节点，而不是替换 node 0（`dsh-agent-loop/lib/index.js:280-284`，`SystemPromptProjection.project`）。

> **这是一个显著的不对称**：最不重要的东西（提示词增量）有 append-only 优化，最重要的东西（对话历史）只能 replace。后果：**每次压缩都必然打断 KV cache 前缀**，而提示词更新在 in-history 路由上不会。

#### 3.1.8 压缩的质量保险

- 摘要必须**严格小于**被遮蔽内容，否则抛错：`framedSummaryTokenCount >= prepared.shadowedRouteTokenCount`（`:601`）
- 摘要被 `maxTokens` 截断 → 失败（`:362-366`）
- 摘要含图片 → `UNSUPPORTED_CONTENT` 失败（`:372`）
- 摘要过程中 surface 变化 → `SurfaceChangedError`，不提交（`:609-626`）
- 自动路径失败只 `logger.warn`，**继续本轮**（`:843-850`）；模型切换路径失败则拒绝请求（`:870`）

### 3.2 裁剪（prune）

#### 3.2.1 何时运行

**只在压缩触发条件满足之后**。`compactPressure()` 里：

```js
if (measurement.totalTokens < spec.thresholdTokens) return null;   // 未超阈值 → 完全不碰
if (prune !== void 0) {
  prune.pruneSession(agent.session);            // 先剪
  measurement = meter.measure(agent.session, header);  // 重测
}
if (measurement.totalTokens < spec.thresholdTokens) return null;   // 剪完够了 → 跳过摘要
```

代码：`dsh-compaction-basic/lib/index.js:960-965`。文档一致（`dsh-compaction-tool-result-pruner/README.zh.md:60`）。

**注意：溢出恢复路径也会先剪一次**（`dsh-compaction-basic/lib/index.js:938`）。

#### 3.2.2 粒度与预算

粒度 = **单个 `tool/result` 事件的 text 块**，按 Unicode 码点。

默认配置（`dsh-base/cordis.patch.yml:435-440` 显式设置）：

```yaml
thresholdChars: 8192   # 合并文本超过此码点数才剪
headChars: 4096        # 保留开头
tailChars: 1024        # 保留结尾
```

#### 3.2.3 裁剪后的标记格式

```js
// dsh-compaction-tool-result-pruner/lib/index.js:8
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
```

模型看到：`前4096字符` + `\n\n[... tool result middle pruned ...]\n\n` + `后1024字符`。

**标记里没有任何量化信息**：不说省了多少字符、原来多大、原文在哪。

#### 3.2.4 能否回源？

**日志层面：能。模型层面：不能。**

写回机制（`dsh-compaction-tool-result-pruner/lib/index.js:159-177`）：

```js
session.append("compaction/prune", { shadowedRange, shadowedSeqs: [seq], shadowedTokenCount });  // 影子价，log-only
const replacement = session.append("tool/result", { ...event.data, message }, {
  surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
  sourceEventSeqs: [seq],   // ← 指回原始事件
});
```

原始事件在日志里完好，`sourceEventSeqs` 可追溯。**但模型手上没有任何工具能读它**：
- 没有 `session_event_read`（`tool-session-query` 未挂载，见 3.3）
- prune 不落 spill 文件（与 `spill-policy` 不同，见 3.6）
- 标记文本里没有路径

> **对比鲜明**：`spill-policy` 溢出时会写 "Full formatted result stored at: /path/to/x.txt. Use read with offset/limit, or grep this path"（`dsh-spill-policy/README.zh.md:54`）。**pruner 有完全等价的机会写这句话，却没有写。**

### 3.3 跨会话检索

#### 3.3.1 两层原子能力

**层 1：`dsh-session-query`（服务层，不给模型）**

`ctx.sessionQuery` 提供（`dsh-session-query/README.zh.md:32-43`）：

| 操作 | 返回 |
|---|---|
| `listSessions()` | 每会话 + `live`/`persisted` 标志 |
| `readSession(id)` | 完整原始事件日志（回放校验过） |
| `filterSessions` / `filterEvents` | 元数据 + 字面文本谓词 |
| `listEvents(id)` / `readSurface(id)` | 逐事件记录 / **当前模型 surface** |
| `readEvent(request)` | 单事件 + 有界原始日志窗口（`before`/`after` 上限 50）|
| `traceSession` / `traceEvent` | 血缘树 / 位置替换关系 |
| `searchSessions` / `searchEvents` | 全文搜索（**需后端**）|

**关键：`readSurface(id)` 返回的是"当前模型 surface"**——它会正确反映压缩遮蔽后的状态，也就能拿到被遮蔽节点（因为 fold 会分类 `current` / `shadowed` / `log-only`，`README.zh.md:116`）。

`mapped` 语义：`dsh-session-query/lib/index.js:634-643` `buildSessionEventRecords()` 给每个事件打 `surface: 'current' | 'shadowed' | 'log-only'`。

**层 2：`dsh-tool-session-query`（模型工具层，5 个工具）**

| 工具 | 作用 |
|---|---|
| `session_search` | 跨会话搜索，**始终排除调用方会话** |
| `session_event_search` | 单会话内搜索事件；对当前会话**排除正在执行本调用的 step** |
| `session_trace` | 会话血缘 |
| `session_event_trace` | 事件替换/引用关系 |
| `session_event_read` | **一个完整未删节事件（JSON）** + 可选相邻摘要 |

（`dsh-tool-session-query/README.zh.md:45-51`）

#### 3.3.2 是 pull 还是 push？

**纯 pull。** 模型必须主动调工具。没有任何自动注入、没有"相关历史自动浮现"。

唯一例外：`dsh-tool-session-query` 挂载时会加一段**固定指引段**（`README.zh.md:123-125`）：

```markdown
Use session_search to find relevant work from prior sessions, or session_event_search
to search earlier events in one session. Search results are cursor-free and
workspace-scoped. Follow a useful hit with session_trace, session_event_trace, or
session_event_read when you need lineage, relationships, or exact data.
```

#### 3.3.3 当前 profile 挂载了吗？——**没有**

三重证据：

1. **`dsh-base` 不含 `tool-session-query`**：全文 grep `tool-session-query`，只有 `dsh-experimental-session-search/cordis.patch.yml`、它自己的 `package.json`、和 `dsh-client-ui-tool/package.json` 引用它。
2. **`dsh-experimental-session-search` 是空 stub**：`lib/index.js` 全部内容就是 `export {};`（11 字节）。它只是个 bundle 壳，靠 `cordis.patch.yml` 插 `optional-session-search` 组。
3. **web profile 未启用它**：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 只有 `dsh-base` + `dsh-web-app`；`cordis.patch.yml` 是 `[]`。文档明确"Web 和 Desktop 随附此配置包，**默认关闭**"（`dsh-experimental-session-search/README.zh.md:12`）。

4. **全文搜索后端被显式关掉**：`dsh-base/cordis.patch.yml:157-161` 与 `dsh-web-app/cordis.patch.yml` 都设 `openAt: never`：

```yaml
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never
```

注释原文（`dsh-base/cordis.patch.yml:150-156`）：
> "…while search calls fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is never opened; the Web sidebar search matches titles and workspace names only."

**结论：当前部署下，模型完全没有任何跨会话检索能力，也没有读取自己历史日志的能力。**

### 3.4 AGENTS.md 机制

#### 3.4.1 如何发现

`dsh-agent-instructions`，由 `dsh-base` 以 `maxBytes: 65536` 挂载（`cordis.patch.yml:307-310`）。

**两条独立的链**（`README.zh.md:34`）：

1. **用户全局链**：`$DSH_HOME/AGENTS.md` → `<agentsHome>/AGENTS.md`
   - `$DSH_HOME` 解析为 `~/.dsh`（`dsh-home-paths`）
   - `<agentsHome>` 解析为 `~/.agents`
2. **项目链**：从**项目根**到**会话 cwd** 的每一级目录，每级读 `AGENTS.md`、`CLAUDE.md`（基础）+ `AGENTS.local.md`、`CLAUDE.local.md`（overlay）

项目根判定：向上找 `.git`（`projectRootMarkers` 默认 `['.git']`）。

#### 3.4.2 加载哪个文件

`instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md']`
`localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md']`

去重规则：**同一候选组内 strip 后内容完全一致的文件只渲染一次**（`README.zh.md:34`）——所以 `CLAUDE.md` 复制自 `AGENTS.md` 不会双份。

#### 3.4.3 注入到哪

**作为一条普通 `user/message`**，`source.kind: 'agent-instructions'`（`lib/index.js:961、1382、1413`）。不是 system prompt，不是 runtime context。

通过 `agent/pre-step` 在 `decision.messages` 里 splice 插入（`lib/index.js:1480-1498`）：

```js
const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
```

#### 3.4.4 大小限制

- `maxBytes: 65536` **每条链分别**限制（不是合计）
- 同时含两条链的消息最多 `maxBytes × 2` = 128 KiB
- `maxSourceBytes: 1048576`（单源文件上限 1 MiB）

预算裁剪策略（`README.zh.md:74`）：先丢最宽泛的整个文件，再截断最具体的那个文件。

#### 3.4.5 是每轮重注入吗？——**不是每轮，但被遮蔽后会重注入（这点超出预期，值得记一笔）**

不是每步重注入。`compose()` 每步都会跑（`lib/index.js:1484`），但有快速路径：基线仍在 surface 上且 identity 未变时，**不重读磁盘、不重建**，直接返回（`:1321-1328` 的 `keepVisibleBaseline` 分支）。

真正的刷新触发只有三种（`README.zh.md:222` 原文）：
> "刷新由 touch 驱动：没有 watcher；外部编辑会在下一次成功的第一方 `read`、`write` 或 `edit` 时、恢复对账可见基线时，或**进入步骤的 pre-step 恢复被遮蔽基线时**可见。"

**第三项是关键**，我最初误判为"被压缩后就永久消失"。代码证明相反：

```js
// dsh-agent-instructions/lib/index.js:1272-1279
function visibleBaselineSource(agent, authorityMessages) {
  for (const message of authorityMessages.toReversed())
    if (message.source.kind === "agent-instructions" && message.source.baseline === true) return message.source;
  for (const seq of agent.session.surface.nodes.toReversed()) {   // ← 查的是 surface，不是整个日志
    const event = agent.session.eventAt(seq);
    if (event?.type === "user/message" && event.data.source.kind === "agent-instructions" && event.data.source.baseline === true) return event.data.source;
  }
}
```

**因为查的是 `surface.nodes` 而不是日志**，一旦压缩把基线节点遮蔽，`baselinePresent` 变 `false`，`compose()` 走重建分支（`:1328`），重新从磁盘加载整条链并渲染成一条新基线注入。

> **这是个设计上做得对的地方**：AGENTS.md 拥有"被遮蔽后自愈"能力，而普通对话历史没有。原因很微妙——它靠"我能不能在 surface 上看见我自己"来判断，而不是靠任何显式的"我丢了"信号。

**副作用**：每次自愈都整条链重读磁盘 + 全量重渲染（`loadBaselineInstructionSet`，`:1330-1342`）；且注入的是**一条全新的完整基线**，包含所有从未变过的全局文件。

仍在的限制：bash 里 `cd` 不触发发现（`README.zh.md:221`）；无 watcher。

#### 3.4.6 当前实际状态

`~/.dsh/AGENTS.md` 存在（已在本次会话的 system-reminder 中生效），内容包含语言偏好、代码规范、安全习惯等。基线消息在**第一条** user 消息位置之后进入历史，并在压缩时成为最老的候选遮蔽内容。

### 3.5 goal 机制

#### 3.5.1 是否提供跨轮次持久目标/状态？——**是，但仅限单会话内**

`dsh-goal`：每会话**至多一个**当前 goal，跨轮次、跨恢复、跨 fork、跨进程重启持久（`README.zh.md:12`）。

#### 3.5.2 生命周期

四个持久 phase：`active` | `paused` | `blocked` | `complete`，外加一个**进程本地**的续行标志 `armed` / `disarmed`。

动词：`create` / `edit` / `pause` / `resume` / `complete` / `block` / `clear`（`README.zh.md:58-67`）。

状态存储：**会话日志里的 `goal/change` 事件**，每次变更追加完整快照（`:97`）。日志是唯一持久权威。

投影：注册 `goal` 投影单元（stateVersion 6），客户端通过 `session/projection` 推送帧获取。

#### 3.5.3 模型怎么看得到 goal？

两条路：

**路 1：工具拉取。** `get_goal` 返回当前状态（`dsh-tool-goal/lib/index.js:264-273`）。工具是只读+变更三件套。

**路 2：自动轮次提示。** `dsh-goal-round-driver` 在 agent idle 且 goal active+armed+有余额时，排入一条 `<goal_round>` user 消息（`dsh-goal-round-driver/lib/index.js:11-18`）：

```
<goal_round>
Objective: "<JSON 转义的目标>"
Round: 3/256

Continue working toward the objective in this same session. Treat the current
workspace, tool results, and durable session state as authoritative; inspect
them instead of assuming earlier narration is still current. Make concrete
progress and verify the result. Before claiming completion, gather evidence that
the whole objective is achieved, read the current goal, and mark it complete.
If work remains, leave the goal active for the next round. Follow the configured
goal-tool policy before reporting a blocker.
</goal_round>
```

**关键：`goal/change` 事件本身不注入模型上下文**（`README.zh.md:140`："Goal 变更不会注入模型上下文"）。模型只能靠 `get_goal` 拉，或靠下一轮的 `<goal_round>` 提示。

#### 3.5.4 一个关键设计缺陷

**`goal/change` 是 log-only，但 `<goal_round>` 是普通 user 消息——所以 goal 的 objective 会随每一轮反复出现在历史里，并且会被压缩当成普通历史处理。**

即：如果一个 goal 跑了 200 轮，"目标是什么"这件事在历史里出现了 200 次（每次一个 `<goal_round>` 块），压缩会把它当冗余内容遮蔽或摘要。**目标本身没有"受保护的锚点"。**

对比：system prompt 的 node 0 是受保护的（永不被遮蔽），但 goal objective 不是。

#### 3.5.5 进程本地的续行权限

`armed` / `disarmed` **绝不持久化**（`README.zh.md:99`）。会话恢复或 fork 后，active 的 goal 一律 `disarmed`，**必须用户显式 resume**。这是个 fail-closed 设计（好的），但也意味着自动化流程重启后必须有人介入。

### 3.6 spill / output-retention

#### 3.6.1 是否有"大内容落盘、上下文只留句柄"？——**有，而且这是全系统唯一带取回路径的机制**

三个包分工（`dsh-spill/README.zh.md:12`）：

| 包 | 职责 |
|---|---|
| `dsh-spill` | **契约**：`SpillStore.saveText()`，返回 `{locator, bytes, retrievalHint}` |
| `dsh-spill-local` | **后端**：写到 `<root>/session-<hash>/<random>-<safeName>` 本地文件 |
| `dsh-spill-policy` | **策略**：`tools/post-execute` 上判超预算，替换成预览 |

当前挂载（`dsh-base/cordis.patch.yml:421-427`）：

```yaml
- id: spill-local
- id: spill-policy
  config:
    maxInlineTokens: 12500
```

#### 3.6.2 模型怎么取回

模型收到的文本（`dsh-spill-policy/README.zh.md:51-55`）：

```
<retained head/tail preview>

(Omitted 48392 bytes. Full formatted result stored at:
 /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path
 to search within it.)
```

**模型有路径，有 `read` 工具，有 `grep` 工具**——这是完整闭环。

#### 3.6.3 但 spill 有三个硬伤

1. **只有工具结果走这条路。** `spill-policy` 挂在 `tools/post-execute`（`README.zh.md:87`）。对话历史、AGENTS.md、被压缩的段落——**全都不经过这里**。
2. **`read` 被显式豁免**："预算内结果、`read`、被阻止的决策、值替换以及其他内容块类型会原样通过"（`:61`）。这是防循环的合理设计，但意味着读一个大文件仍会炸上下文。
3. **文件会过期。** `dsh-spill-local` 有 `cleanupPeriodDays: 30`，一次性启动清理删除 30 天前的文件（`dsh-spill-local/README.zh.md:44、59`）。**且"长期运行的部署要等到重启才会被扫描"**（`:126`）。

#### 3.6.4 output-retention 是什么

不是溢出机制，是**库**（`kind: package-library`）。提供 `ItemRetainer` / `TextRetainer` / `formatRetentionNotice`，供工具自己实现"截断 + 计数 + 页脚"。不通过 `cordis.yml` 加载（`README.zh.md:12`）。

`truncated` 的语义是"预算事实"而非"上游不完整"（`:83`）——这个区分做得很好。

---

## 4. 不可恢复的信息清单

分两类：**A. 日志里根本没有**（真·永久丢失）；**B. 日志里有，但模型永远拿不到**（对模型等效丢失）。

### 4.1 A 类：日志中不存在，任何回放都重建不出来

| # | 信息 | 证据 | 后果 |
|---|---|---|---|
| A1 | **工具的规范 `value`（结构化返回值）** | `dsh/docs/subsystems/tools.zh.md`（"规范的 `value` 仅存在于执行期间：循环只持久化 `content`、`error` 和 `meta`…**回放可以重现展示，却无法重建规范的中间值**"） | 工具的真实计算结果只能以渲染文本形式存在。任何"重新取回原始数据"都不可能——只能重跑工具 |
| A2 | **进程硬中断时未结算的 assistant attempt 流** | `dsh-session/README.zh.md:104`："如果进程在 settlement 前硬中断，则不会留下持久 attempt stream" | 崩溃前的模型输出彻底消失 |
| A3 | **根上下文关停时未落盘的 `turn/end`** | `dsh-agent-loop/README.zh.md:232`（已知限制）："存在活跃 Agent 时，关停根上下文可能使最终的 `turn/end` 仅留在内存中，未写入持久化日志" | 崩溃恢复时轮次归属不可靠 |
| A4 | **摘要器的推理 token 与工具调用** | `dsh-compaction-basic/README.zh.md:129`："只有返回文本进入检查点，推理与工具调用都会被排除" | 摘要"为什么这么写"不可审计 |
| A5 | **被 `maxTokens` 截断的摘要尾部** | `dsh-compaction-basic/lib/index.js:362-366`：截断直接抛错，不落盘 | 一次失败的摘要（花了钱）什么也不留 |
| A6 | **无本地路径的已省略图片** | `dsh-llm/lib/types/content.js:73-79`：无 access 时 placeholder 是 "…No local normalized image path is available; ask the user to attach it again if needed." | 图片彻底不可见，只能让用户重发 |
| A7 | **超过 30 天的 spill 文件** | `dsh-spill-local/README.zh.md:44` `cleanupPeriodDays: 30` | 曾经"有路径可取回"的内容变成死链，且模型不知道链接已死 |
| A8 | **被 `ignorable` 标记跳过的新版事件** | `dsh-session/lib/types/known-event-types.js:7-20` | 旧 build 读新 log 时，未知事件被静默跳过；语义丢失且不可检测 |

### 4.2 B 类：日志里有，但模型无任何通道

> **这一节是"补救空间"的负面边界——这些内容只要补一个工具就能救回来。**

| # | 信息 | 日志位置 | 为什么模型拿不到 |
|---|---|---|---|
| B1 | **被压缩遮蔽的全部原始消息** | `compaction/summary.shadowedSeqs` + 原始事件仍在日志 | `deriveMessages()` 已把它们从投影中移除；没有工具能读日志 |
| B2 | **被 prune 掉的工具结果中段** | 原始 `tool/result` 事件 + `sourceEventSeqs` 溯源 | 标记无路径；prune 不落 spill；无 `session_event_read` |
| B3 | **压缩丢了多少** | `compaction/summary.shadowedTokenCount` | log-only；无模型可见通道 |
| B4 | **压缩了几次** | `compaction/start`/`end` 配对计数 | log-only |
| B5 | **摘要用的是哪个 provider/model、花了多少 token** | `compaction/summary.provider/model/usage` | log-only |
| B6 | **当前上下文压力 / 剩余窗口** | `tokenMeter.measure()` + `contextPressure` 投影 | **纯客户端投影**；grep 全库，没有任何模型可见工具暴露 token/上下文状态 |
| B7 | **哪些图片被省略、为什么** | `image/offload` 事件 | log-only（`MESSAGE_PROJECTION_EVENT_TYPES` 里只有 `image/offload`，但它只影响投影不改文本）|
| B8 | **失败重试的完整历史** | `assistant/attempt`、`llm/retry`、`llm/retry-started` | log-only |
| B9 | **工具调用被拒绝的真实原因** | `tool/result.data.error.code` 部分可见，但 `ToolErrorInfo.reason` **不进模型内容** | 文档明说："可选的 `ToolErrorInfo.reason` 保留面向用户的原始详情，**不将其加入模型可见内容**" |
| B10 | **轮次/步骤时间边界** | `turn/start`/`turn/end`/`step/start`/`step/end` | log-only，纯投影不产生消息 |
| B11 | **每步请求的完整 envelope** | `request/header`（config + adapterDefaults + tools） | log-only |
| B12 | **路由容量与提示词更新模式** | `request/context` | log-only |
| B13 | **goal 的全部历史变更** | `goal/change`（每次完整快照） | 文档明说"不会注入模型上下文"；只能 `get_goal` 拉当前值 |
| B14 | **inbox 的丢弃与领取记录** | `agent/inbox/spliced`、`agent/inbox/discarded` | log-only；模型不知道有消息被丢弃 |
| B15 | **模型切换事件** | `model/selection` | 部分可见：`installModelSelection` 会追加一条 `[model changed: …]` 提示（`dsh-agent/README.zh.md:188`）——**这是罕见的"log-only 事件有配套可见提示"的例子** |
| B16 | **plan 模式状态、权限预设、沙箱模式** | `plan/mode`、`permission/preset`、`sandbox/mode` | log-only（但 sandbox/approval 有 context 段，部分可见）|
| B17 | **子代理与团队的完整事件流** | `subagent/*`、`team/*` | 多数 log-only |
| B18 | **会话标题** | `session/title` | log-only（对模型无意义，但说明"结构化元数据"这一类）|

---

## 5. 记忆完整性自描述：有没有、缺什么

### 5.1 有：一个极弱的、只覆盖"存在性"的声明

**唯一的自描述**是 checkpoint 的 `CHECKPOINT_PREAMBLE`（`dsh-compaction-basic/lib/index.js:280`）：

> "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context."

模型由此**能知道**：
1. 这里有一个检查点
2. 它概括的是"更早的一段对话"
3. 目的是省上下文

### 5.2 缺：所有量化与可操作信息

| 缺什么 | 具体表现 |
|---|---|
| **丢了多少 token** | `shadowedTokenCount` 存在于 `compaction/summary`，不进模型文本 |
| **丢了多少条消息 / 什么类型的** | `shadowedSeqs` 长度已知，不进模型文本 |
| **丢的具体内容在哪能找回来** | 无路径、无定位、无工具 |
| **这是第几次压缩** | 无法从模型可见信息推出 |
| **当前还剩多少上下文预算** | 完全没有 |
| **本次会话累计丢了多少** | 完全没有 |
| **prune 丢了多少** | 标记只有 `[... tool result middle pruned ...]`，**连字符数都没有** |
| **AGENTS.md 是否被裁过** | 预算通知 `Workspace instruction budget ...` 会说明（`README.zh.md:74`）——**这是唯一一处诚实报告"我被截断了"的机制** |

### 5.3 更糟的：指令明令禁止提及

`COMPACTION_INSTRUCTION` 倒数第二条（`dsh-compaction-basic/lib/index.js:277`）：

> "Do NOT mention this summarization request or that the context was compacted."

而 `CHECKPOINT_PREAMBLE` 又说：

> "…Continue the task directly from the messages that follow, **without acknowledging this checkpoint**."

**这两条合起来的效果是：摘要模型被要求不要写"这里压缩过"，然后 preamble 又要求下游模型不要提起这件事。** 系统在系统性地**压制**记忆完整性的自描述。

> 这不是 bug，是刻意的产品设计（避免模型反复说"根据摘要…"）。但它的代价必须在架构评审中显式承认：**模型被设计成"假装没丢过东西"。**

### 5.4 唯一的正面例外：AGENTS.md 预算通知

对比之下，`dsh-agent-instructions` 做得完全相反（`README.zh.md:74`）：

> "可见的 `Workspace instruction budget ...` 通知会**指名两条链中被省略与被截断的路径**。"

**同一个系统里存在两种截然相反的做法。** 这说明"报告丢失"在 dsh 里是可行的（有先例、有实现），只是压缩/裁剪这两条路没做。

### 5.5 结论

**记忆完整性自描述 = 存在性有，量化无，可操作性无，且被 prompt 主动压制。**

模型能说"我知道有个检查点"，但不能说"我丢了 87 条消息、约 4.2 万 token、其中包含一个 bash 结果的中段"。

---

## 6. 插件扩展边界与推荐做法

### 6.1 一个第三方插件想"每轮请求前注入自定义上下文"，能不能做到？

**能，而且有四条路，各有不同取舍。**

#### 路线 A：`ctx.systemPrompt.section()` —— 进 system prompt（最稳，最贵）

```js
ctx.systemPrompt.section({
  name: 'my-plugin:context',
  order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'), // 或任意数字
  text: (context) => context.agent ? buildMyText(context.agent) : '',
})
```

- ✅ 每步重算，永不被压缩遮蔽（如果在 node 0 里）
- ✅ KV cache 友好：文本不变就是同一个节点
- ❌ **烧 token**：每次请求都付费（`dsh-agent-loop/README.zh.md:162`："系统文本与 schema 在每个步骤都会再次计入"）
- ⚠️ 只能返回 `string`；`text` 可以是函数，每次 assemble 都会调

#### 路线 B：`ctx.systemPrompt.context()` —— 进 runtime context 快照（推荐的"有状态注入"）

```js
ctx.systemPrompt.context({
  name: 'my-plugin:facts',
  order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
  text: (context) => ...,
})
```

- ✅ **内容不变就不注入**（`RuntimeContextProjection.project()`，`dsh-agent-loop/lib/index.js:341`）——这是全系统唯一有"去重注入"的通道
- ✅ 自动获得"我覆盖了旧版本"的声明（preamble 会变）
- ❌ 仍是 user 消息，会被压缩遮蔽；遮蔽后**会自动重新注入**（`dsh-agent-loop/README.zh.md:172`）——这是它比 section 更聪明的地方
- ⚠️ `required: true` 才能压过 `includeRuntimeContext: false`

#### 路线 C：`agent/pre-step` 监听器 —— 完全自定义的一次性注入

```js
ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  const extra = createUserMessage({ content: [...], source: { kind: 'my-plugin' } })
  return { ...decision, messages: [...decision.messages, extra] }
})
```

- ✅ 最大的控制权：可按 turn/step 条件注入、可拒绝步骤
- ✅ `dsh-agent-instructions` 就是这么做的（`lib/index.js:1480-1498`）
- ❌ 必须自己调用 `next()` 并保留上游决定（错误示范会导致别的插件的贡献被吞）
- ❌ 注入的是"一次性"消息，之后靠历史保留

#### 路线 D：`Agent.inject()` —— 纯追加，异步安全

```js
handle.agent.inject({ content: [{ type: 'text', text: '...' }], source: { kind: 'my-plugin' } })
```

- ✅ **不唤醒驱动器**——适合"后台任务完成"这类场景（`dsh/docs/cookbook/adding-a-tool.zh.md:50`）
- ✅ 官方推荐（`dsh/docs/cookbook/architecture.zh.md:165`："添加模型可见上下文 → 调用 `agent.inject()`"）
- ❌ `source.kind` 必须在 `MessageSourceMap` 里声明（session format V4 拒绝退役的 `{kind:'plugin', plugin}` 包装）
- ❌ 必须 try/catch 已 dispose 的 agent

### 6.2 官方推荐做法（有明确文字）

`dsh/docs/cookbook/extension-cookbook.zh.md:116-131` 的映射表：

| 产品功能 | 官方推荐机制 |
|---|---|
| 系统提示词可配置性 | `ctx.systemPrompt.section()`，支持排序与作用域局部覆盖 |
| AGENTS.md（根目录） | 一个读取该文件的 section 提供方 |
| AGENTS.md（子目录，按需触发）+ 文件变更通知 | 从 watcher / 工具结果监听器调用 `agent.inject()` |
| **记忆** | **`section 提供方 + 工具`** |

> **"记忆：section 提供方 + 工具"** —— 这一行是官方对"怎么做记忆"的全部回答。即：静态知识放 section，动态知识靠工具拉。**没有内置的记忆子系统，也没有官方推荐的三方记忆方案**（唯一的记忆文档是 `dsh/docs/user/guide/mcp-memory.zh.md`，外接 MCP，明确"默认关闭的参考配置"、"仅作为互操作参考；收录不代表认可"）。

### 6.3 扩展性的真实边界

**能做到的：**
- 每轮/每步注入任意文本到 system prompt 或对话历史
- 注册任意工具（含能读日志的工具——`ctx.sessionQuery` 是可信基础设施，无调用方授权检查，模型工具层必须自己做授权）
- 拦截/替换/拒绝工具调用与步骤
- 观察全部 session 事件

**做不到的：**
- **改压缩策略以外的记忆策略**：`CompactionEngine` 可以自己实现（继承 + 覆盖 `summarize()`），但"遮蔽哪些"由 `selectCompactableRange` 决定，**不在可覆盖的 seam 上**（只有 `summarize()` 是钩子，`dsh-compaction-basic/README.zh.md:117`："`summarize()` 是唯一的子类钩子"）
- **改派生历史的投影规则**：`deriveMessages()` 用的是 surface 折叠，插件只能通过 `@messageProjection` 改**单条消息内容**，不能改"哪些节点在 surface 上"
- **给模型加一个"看看我丢了什么"的能力**：技术上完全可以（写个工具读 `sessionQuery`），但**没有现成实现，也没有 seam**

---

## 7. 结构性缺陷清单（每条附证据）

### 缺陷 1：压缩是"从头上削一块"，没有语义选择，且不可逆

**现象**
`selectCompactableRange()` 只做三件事：跳过 node 0、按 retainTokens 保留尾部、保证工具对平衡。**它不看内容重要性。**（`dsh-compaction-basic/lib/index.js:410-433`）

**为什么不合理**
- 用户在第一轮说的关键约束（"不要动 migrations 目录"）和第一轮的 grep 噪音，**在算法眼里等价**
- 唯一的补偿是摘要 prompt 里的 8 个固定小节，靠模型"记得把重要东西写进去"
- `compactionRetries: 1` 意味着最多压两轮，第二轮继续往前削

**证据**
```js
// dsh-compaction-basic/lib/index.js:415-431
const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;
for (let index = pricedNodes.length - 1; ...) { accumulated += pricedNodes[index].tokens; ... }
while (keepFromIdx > firstIdx) { if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break; keepFromIdx -= 1; }
return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] };
```

**后果**
一次压缩把"第 1 轮的用户约束"和"第 1-40 轮的所有工具输出"一起送给摘要器。摘要的质量完全取决于那次调用的运气，且失败就是失败（`maxTokens` 截断直接抛错）。

---

### 缺陷 2：模型对"我丢了什么"完全无知，且被 prompt 明令禁止提及

**现象**
- checkpoint 只说"这里有个检查点"（`CHECKPOINT_PREAMBLE`，`:280`）
- 量化信息（`shadowedTokenCount` / `shadowedSeqs` / 第几次）全在 log-only 事件里
- 摘要指令要求 **"Do NOT mention … that the context was compacted"**（`:277`）
- preamble 要求 **"without acknowledging this checkpoint"**（`:280`）

**为什么这是最严重的**
这是**唯一一个"信息还在日志里、只差一个接口"的缺陷**。其他缺陷都需要改架构，这个只需要加一段文本 + 一个工具。

**证据**（同一系统里的反例，证明可行）
```
// dsh-spill-policy/README.zh.md:54
(Omitted 48392 bytes. Full formatted result stored at: /…/web_fetch.txt.
 Use read with offset/limit, or grep this path to search within it.)

// dsh-agent-instructions/README.zh.md:74
可见的 `Workspace instruction budget ...` 通知会指名两条链中被省略与被截断的路径。
```

**后果**
模型无法判断"我现在是在一个被压缩过的、信息不全的状态下工作"。它会把摘要当成完整事实继续推理，无法主动说"我需要重新读一下原始需求"。

---

### 缺陷 3：prune 制造了一个"没有出口的信息黑洞"

**现象**
pruner 把工具结果中段换成 `[... tool result middle pruned ...]`，**不给字符数、不给路径、不落 spill 文件**（`dsh-compaction-tool-result-pruner/lib/index.js:8`）。

**为什么比压缩更糟**
- 压缩至少给了一个摘要（有损但有内容）
- prune **纯丢弃**，只留头 4096 + 尾 1024 字符
- 一个 40 万字符的 `grep` 输出被剪到 5KB，中间 39.5 万字符对模型**彻底消失**，而模型甚至不知道被剪了（标记文本太弱，容易被当成工具自己打印的）

**证据**
```js
// dsh-compaction-tool-result-pruner/lib/index.js:8
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
// 对比 dsh-spill-policy 有 retrievalHint；pruner 的 replacement 里没有任何 locator
```

**结构性荒谬**
`dsh-base` **同时挂载了 pruner 和 spill-policy**（`cordis.patch.yml:424-440`）。两条路径都能处理"结果太大"：
- spill-policy：有路径、可取回、模型知道
- pruner：无路径、不可取回、模型不知道

**同样的输入，走哪条路取决于"是否触发了压缩阈值"，而不是"哪个更安全"。** 这是个明显的设计冲突。

---

### 缺陷 4：AGENTS.md 的"存活检测"靠 surface 可见性，没有显式的完整性契约

> **修订说明**：本条最初写的是"AGENTS.md 被压缩遮蔽后永不回归"，**这是错的**。代码证明它会自愈（见 3.4.5）。修正后，真正的问题不是"丢了找不回"，而是**"它怎么知道该找回"这件事靠的是一个隐式副作用**。

**现象**
`compose()` 每步都跑（`dsh-agent-instructions/lib/index.js:1484`），但判断"基线是否还在"的方式是：

```js
// :1272-1279
function visibleBaselineSource(agent, authorityMessages) {
  for (const message of authorityMessages.toReversed())
    if (message.source.kind === "agent-instructions" && message.source.baseline === true) return message.source;
  for (const seq of agent.session.surface.nodes.toReversed()) {   // ← 只看 surface
    ...
  }
}
```

它**从不检查日志**，只看当前 surface 和本次已领取的消息。所以：
- 压缩遮蔽基线 → `baselinePresent === false` → 走重建分支 → 重新注入 ✅（这是好的）
- 但"该不该重建"完全依赖"投影里恰好没看见"，**没有任何显式信号说"你的指令上下文已经不全了"**

**为什么不合理（三条）**

1. **自愈是副作用，不是契约。** `agent-instructions` 是唯一一个碰巧拥有这种能力的注入源。任何其它第三方"记忆型"插件如果也往历史里塞持久上下文，被压缩后**不会**有对应机制——因为判断逻辑写死在这个包里，不在 seam 上。

2. **自愈的代价没有上界。** 每次自愈都 `loadBaselineInstructionSet()` 整条链重读磁盘 + 全量重渲染 + 注入一条**完整的**新基线（`:1330-1342`）。一个 64 KiB 的全局链被压掉后，下一轮直接再吃 64 KiB。压缩省下的 token 立刻还回去一部分——**且系统不知道自己在跟压缩对着干**。

3. **它的检测粒度是"在不在"，不是"全不全"。** 如果压缩只遮蔽了链里的某一部分（比如项目链保留了、用户全局链被遮蔽），`visibleBaselineSource` 找到任何一条 `baseline: true` 就认为"还在"，不会发现内容残缺。

**对比（这才是真正的不对称）**
| 注入源 | 被压缩后 | 靠什么判断 |
|---|---|---|
| system prompt 段/人设 | **永不被遮蔽**（node 0 受保护）| 硬约束 `systemHead()`，`dsh-compaction-basic/lib/index.js:415` |
| AGENTS.md 基线 | 被遮蔽，**会自愈** | 隐式 surface 可见性，`lib/index.js:1272` |
| goal objective | 被遮蔽，**只能工具 pull** | 无任何自动机制（见缺陷 8）|
| 普通对话历史 | 被遮蔽，**永久消失** | 无 |
| runtime context 快照 | 被遮蔽，**会重注入** | `RuntimeContextProjection`，`dsh-agent-loop/lib/index.js:328` |

**五种注入源，四种不同的存活语义，没有统一契约。** 这才是结构性问题：一个新插件作者无法从 API 上知道"我的注入会不会活过压缩"。

---

### 缺陷 5：每步全量重算 + `structuredClone` 每个工具 schema

**现象**
`assemble()` 每次调用都会（`dsh-system-prompt/lib/index.js:358-413`）：
1. 遍历所有 layers 的 variables、sections、contexts
2. 遍历所有 toolProviders，对**每个 schema** 做 `structuredClone(parameters)`（`:375`）
3. 排序所有 sections（`comparePromptSections`）
4. 跑 waterfall

这发生在**每个 step**（`dsh-agent-loop/lib/index.js:692`）。一个带 30 工具的 agent，每步 clone 30 份 JSON Schema。

**为什么值得警惕**
- 工具 schema 在一步之内不会变（`tools.resolve()` 已经算过一次）
- `refreshContext()` 的设计说明作者知道"只重算该重算的"（`:326-348`，明确不重跑 sections/tools/variables）
- 但 `assemble()` 本身没有缓存层

**证据**
```js
// dsh-system-prompt/lib/index.js:372-377
const schemas = result.schemas.map(({ name, description, parameters, deferLoading }) => ({
  name, description,
  parameters: structuredClone(parameters),   // ← 每步每工具一次
  ...deferLoading === true ? { deferLoading } : {},
}));
```
代码里没有任何 `cache` / `WeakMap` 命中（grep `dsh-system-prompt/lib/index.js` 无缓存结构）。

**注意**：文档在 `dsh-agent-loop/README.zh.md:162` 承认了 token 成本（"系统文本与 schema 在每个步骤都会再次计入"），但**没提 CPU 成本**。

---

### 缺陷 6：token 计量是"每 token 四字符"，对 CJK 严重低估——而压缩阈值依赖它

**现象**
```js
// dsh-token-meter/lib/types/estimate.js:9
const CHARS_PER_TOKEN = 4;
```

**为什么在这个部署里特别糟**
- 用户是中文用户（`~/.dsh/AGENTS.md`："对话默认用中文回复"）
- 中文大约 1-1.5 字符/token，用 4 字符/token 会**低估 3-4 倍**
- 压缩阈值 = `W × 0.8`，基于这个低估的测量

**后果**
中文会话会在**实际已经接近爆窗**的时候才触发压缩，然后一次压缩要吞掉极大量内容。

**证据（文档自己承认）**
- `dsh-compaction-basic/README.zh.md:270`："token meter 每 token 四字符的启发式对 **CJK 文本与 JSON Schema 定价偏低**；精确 token 化仍是测量服务的开放方向"
- `dsh-token-meter/README.zh.md:143`："没有可复用提供方用量的文本按字符数加结构开销计价"

**缓解**：有提供方用量锚点时优先用真实值（`dsh-token-meter/README.zh.md:43`），所以"上一次请求实测值 + 增量"部分是真的。**但第一次请求、以及 envelope 变化后的重新估算，都走启发式。**

---

### 缺陷 7：`session-query` 有三层，但最有用的一层对模型是关的

**现象**
- 层 1 `ctx.sessionQuery`（服务）：默认挂载，但 **`openAt: never`** → 搜索功能直接不可用
- 层 2 `dsh-tool-session-query`（模型工具）：**根本没挂载**
- 层 3 `dsh-experimental-session-search`（bundle）：**`lib/index.js` 是 `export {};`**，默认关闭

**为什么这是结构性缺陷**
整条链路里**唯一能读"被压缩遮蔽的原始事件"的能力**（`session_event_read` + `readSurface` 的 `shadowed` 分类），被默认关掉了。

**证据**
```yaml
# dsh-base/cordis.patch.yml:157-161（web-app 同样覆盖）
- id: session-query-sqlite
  config: { path: ':memory:', openAt: never }
```
```js
// dsh-experimental-session-search/lib/index.js 全文
export {};
```

**后果叠加**
缺陷 1（压缩粗暴）+ 缺陷 2（模型无知）+ 缺陷 7（无检索）三者相乘：
**压缩丢了东西 → 模型不知道丢了 → 模型也没有任何手段去找回来。**

---

### 缺陷 8：goal 的 objective 没有"受保护锚点"，会被反复压缩

**现象**
`<goal_round>` 是普通 user 消息（`dsh-goal-round-driver/lib/index.js:11-18`），每轮追加一条，**每轮都完整重复 objective**。

一个跑 100 轮的 goal，历史里有 100 份 objective 副本。

**为什么不合理**
- 压缩会把它们当冗余内容遮蔽（它们确实是冗余的）
- 但遮蔽之后，模型只能靠 `get_goal` 工具拉——而工具是 pull，模型可能不调
- **objective 是"任务定义"，比任何对话内容都更需要常驻**

**对比**
system prompt 的 node 0 被硬保护（`systemHead` 检查，`:415`）；goal objective 没有对应保护。

**文档自己承认这是缺口**
`dsh-goal/README.zh.md:169`（dev-note）："开放且未决的方向：**为需要在每个模型请求中看到目标的部署提供始终可见的 goal 上下文插件**"

即：**作者知道该做但还没做。**

---

### 缺陷 9：`system-prompt/assemble` waterfall 的"权威性"是个陷阱

**现象**
```js
// dsh-system-prompt/lib/index.js:401
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, ...);
```
返回的 assembly 是权威的——监听器可以任意改写。

**为什么危险**
文档自己警告（`dsh/docs/cookbook/extension-cookbook.zh.md:105`）：

> "`system-prompt/assemble` 是一个专家协作式的整体装配变换：其返回的装配结果具有权威性，因此**监听器作者有责任保留活跃的 PTC mode 和结构化输出协议的贡献**。"

即：任何第三方插件写错这个 waterfall，就会静默吞掉 PTC/structured-output 的 prompt 贡献，**且没有任何机制检测**。

**对比**
同一系统的 `complete` section 有互斥保护（两个 `complete` 直接抛错，`:384`），`toolOrder` 有严格校验（`:74-97`）。但 waterfall 出来的 assembly **没有 schema 校验**。

---

### 缺陷 10：`agent/pre-step` 的改造能力被高估

**现象**
文档说 pre-step "可以拒绝拟进入的步骤或替换进入它的消息"（`dsh-agent/README.zh.md:80`）。这是准确的，但容易被读成"可以改请求"。

**实际不能改的**（已在 §2.3 论证）：
- system prompt（`assembly` 在 pre-step 之前已定型）
- 工具 schema（`toolSet` 在 `:686` 已 resolve）
- 模型选择（`Readonly<ModelSelection>`）

**为什么这是缺陷而非特性**
一个想做"动态上下文压缩/重组"的插件，会发现自己**只能往 user 消息流里塞东西**，动不了 system prompt 和工具集。这意味着：
- "按需降级工具集以省 token" 做不到（要走 `ctx.tools.restrict()`，那是另一条路）
- "按任务重写 system prompt" 做不到（要走 section provider）

**证据**
```js
// dsh-agent-loop/lib/index.js:692，assemble 在 pre-step 之前
const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet });
// :698，pre-step 只拿到 messages
const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal, modelSelection: selection }, ...);
```

---

### 缺陷 11：`tool-pairing` 约束让压缩粒度被迫变粗

**现象**
```js
while (keepFromIdx > firstIdx) {
  if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
  keepFromIdx -= 1;
}
```

必须找到"不拆开 tool-call/result 对"的边界。如果一个 step 里有 20 个并行工具调用、每个结果都很大，这整个 step 是**不可分单元**。

**后果**
`dsh-compaction-basic/README.zh.md:256` 承认："**部分不可分单元与仅 envelope 溢出仍不在表层压缩范围内**——恢复无法缩减系统／工具／前缀、拆分不可分的非工具节点，或修复不可剪枝剩余部分仍超出窗口的工具单元。"

即：**存在一类会话，压缩救不了它。** 只能靠 pruner（但 pruner 也只剪 text 块）或直接失败。

---

### 缺陷 12：日志只追加，但"只追加"不等于"可恢复"

**现象**
`dsh-session` 的设计承诺是"被遮蔽的内容仍保留在会话日志中"（`dsh-compaction/README.zh.md:12`）。这**在存储层是真的**。

**但**：
- 没有删除接口（`dsh-session-persistence-jsonl/README.zh.md`："不删除会话文件——日志在 `root` 下累积，直到外部移除；seam 无删除接口"）
- 没有压缩日志的机制（zstd 是传输层压缩，不是 GC）
- 247 个会话、未压缩的 `.jsonl.zstd` 已在 `~/.dsh/sessions` 累积

**为什么这是"结构性"而非"运维"**
"日志是唯一权威" + "永不删除" + "无检索接口" 三条合起来 = **一个只写不读的黑洞**。

**补救空间恰恰在这里**：所有被压缩/裁剪的内容都还在，只要加一个读取面就能全部救回。**这是全系统最便宜的架构改进。**

---

## 8. 附：证据速查表

| 结论 | 文件 | 位置 |
|---|---|---|
| 请求无 `system` 字段 | `dsh-agent-loop/lib/index.js` | 1098-1105 |
| system prompt 是 surface node 0 | `dsh-agent-loop/lib/index.js` | 240-299、`dsh/docs/subsystems/session.zh.md` :185 |
| 段顺序表 | `dsh-system-prompt/lib/index.js` | 10-54 |
| 每步重算 assemble | `dsh-agent-loop/lib/index.js` | 692 |
| 每步 clone schema | `dsh-system-prompt/lib/index.js` | 375 |
| 压缩跳过 node 0 | `dsh-compaction-basic/lib/index.js` | 415 |
| 压缩阈值公式 | `dsh-compaction-basic/lib/index.js` | 130-134 |
| 摘要 8 小节结构 | `dsh-compaction-basic/lib/index.js` | 234-280 |
| "不要提压缩过" | `dsh-compaction-basic/lib/index.js` | 277 |
| checkpoint 永远 replace | `dsh-compaction-basic/lib/index.js` | 650-661 |
| system prompt 可 append (in-history) | `dsh-agent-loop/lib/index.js` | 280-284 |
| prune 标记无量化 | `dsh-compaction-tool-result-pruner/lib/index.js` | 8 |
| prune 只在超阈值后跑 | `dsh-compaction-basic/lib/index.js` | 960-965 |
| spill 有取回路径 | `dsh-spill-policy/README.zh.md` | 51-55 |
| spill 30 天清理 | `dsh-spill-local/README.zh.md` | 44 |
| AGENTS.md 注入点（pre-step） | `dsh-agent-instructions/lib/index.js` | 1480-1498 |
| AGENTS.md 遮蔽后自愈（查 surface） | `dsh-agent-instructions/lib/index.js` | 1272-1279 |
| AGENTS.md 刷新触发说明（文档） | `dsh-agent-instructions/README.zh.md` | 222 |
| AGENTS.md 预算报告（正面例子） | `dsh-agent-instructions/README.zh.md` | 74 |
| 搜索后端 `openAt: never` | `dsh-base/cordis.patch.yml` | 157-161 |
| `tool-session-query` 未挂载 | grep 全库 | 仅 experimental bundle 引用 |
| session-search 是空 stub | `dsh-experimental-session-search/lib/index.js` | 全文 `export {};` |
| goal 变更不注入 | `dsh-goal/README.zh.md` | 140 |
| goal 需"始终可见上下文"（未实现） | `dsh-goal/README.zh.md` | 169 |
| `<goal_round>` 模板 | `dsh-goal-round-driver/lib/index.js` | 11-18 |
| 4 字符/token | `dsh-token-meter/lib/types/estimate.js` | 9 |
| CJK 低估（文档承认） | `dsh-compaction-basic/README.zh.md` | 270 |
| tool `value` 不可重建 | `dsh/docs/subsystems/tools.zh.md` | 535 附近 |
| 官方"记忆 = section + 工具" | `dsh/docs/cookbook/extension-cookbook.zh.md` | 131 |
| waterfall 权威性警告 | `dsh/docs/cookbook/extension-cookbook.zh.md` | 105 |

---

## 9. 未找到 / 无法确认

| 项 | 状态 |
|---|---|
| 内置长期记忆（memory/recall/remember/forget）子系统 | **未找到**。全库 grep 严格匹配后，所有命中都是 Lighthouse/WASM、cron 调度、或无关词。唯一的记忆文档是外接 MCP 的 opt-in 指南 |
| 语义检索 / embedding 索引 | **未找到**。`session-query` 明确说"字面文本扫描，而非全文搜索"（`README.zh.md:154`）；MCP 参考实现也说"不是语义检索" |
| 记忆衰减 / 遗忘策略 | **未找到**。唯一的时间衰减是 spill 文件的 30 天清理 |
| 压缩的"只追加"模式 | **未找到**。只有 system prompt 的 `in-history` 有 append 语义 |
| 模型可见的上下文用量工具 | **未找到**。`contextPressure` / `contextBreakdown` 都是纯客户端投影 |
| 三次以上的压缩效果实测 | **未在本轮确认**（需读实际 session log，日志为 zstd 压缩，本轮未解压分析）。相邻文档 `98-compaction-findings.md` 已做过 17 次压缩的实测，本报告不重复 |

---

*报告完成。所有代码引用基于 `0.2.1-rc.5` 编译产物 `lib/*.js`；所有文档引用基于同版本 `README.zh.md` / `docs/**/*.zh.md`。*
