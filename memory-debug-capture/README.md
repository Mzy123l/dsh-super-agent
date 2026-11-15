# memory-debug-capture

**DSH 调试采集插件**：挂 `llm/stream` waterfall，把**每一次模型请求发给模型的完整上下文**落盘为 JSONL。

这是记忆插件 A/B 实测的**采集端**——它不改变模型行为，只旁路观测。

> 调研依据：[`docs/9Q-debug-capture.md`](../docs/9Q-debug-capture.md)。核心结论：`llm/stream` waterfall 是**唯一全覆盖**的捕获点（provider 无关、覆盖重试、`messages` 与适配器输入同一份对象、请求已 deep-frozen 不会被误改）。

---

## 1. 快速开始

```bash
npm install          # 只装 devDependencies（typescript + @types/node + cordis 类型）
npm run build        # tsc 编译到 dist/
npm run selftest     # 自检：构造假 messages 验证序列化与落盘（不需要 dsh 运行时）
npm start            # 跑一次捕获并打印统计
npm run verify       # build + selftest + 集成验证（真实 cordis + 真实 dsh-llm）
```

## 2. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MEMORY_DEBUG_OUT` | `./captures/` | 输出目录 |
| `MEMORY_DEBUG_VARIANT` | `off` | A/B 变体标记，只接受 `on` / `off`（大小写不敏感），其它值一律降级为 `off` |
| `MEMORY_DEBUG_RUN_ID` | `run-unknown` | 本轮 run 的标识（用于区分 A/B 两轮） |
| `MEMORY_DEBUG_MAX_CHARS` | 不截断 | 单条消息**文本**的字符上限；超限则截断并标 `truncated` + `originalChars` |

**环境变量优先于插件配置**，这样 A/B 实测只需改环境变量重启。

## 3. 落盘格式

每行一个 JSON 对象（JSONL）。输出文件默认是 `<MEMORY_DEBUG_OUT>/capture-<runId>.jsonl`。

```json
{
  "ts": "2026-11-15T06:00:00.000Z",
  "sessionId": "abc-123",
  "provider": "workbuddy",
  "model": "deepseek-v4.1-flash",
  "step": 3,
  "turn": 1,
  "variant": "on",
  "runId": "run-2026-11-15-01",
  "messages": [
    { "role": "system", "text": "...", "chars": 1234 },
    { "role": "user", "text": "...", "chars": 56 },
    { "role": "assistant", "text": "...", "reasoning": "...", "chars": 78, "reasoningChars": 900 },
    { "role": "tool", "toolName": "bash", "text": "...", "chars": 33333 }
  ],
  "totals": { "messages": 12, "chars": 48123, "reasoningChars": 90210, "systemChars": 2273 }
}
```

### 3.1 顶层字段

| 键 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `ts` | string | ✅ | 捕获时刻，ISO 8601（UTC，毫秒精度） |
| `sessionId` | string | ✅ | 会话 id；未知时为 `""` |
| `provider` | string | ✅ | 提供方路由名 |
| `model` | string | ✅ | 模型 id |
| `step` | number | ✅ | 步号（从 1 起）；未知时 `0` |
| `turn` | number | ✅ | 轮号（从 1 起）；未知时 `0` |
| `variant` | string | ✅ | `"on"` / `"off"` |
| `runId` | string | ✅ | 本轮 run 标识 |
| `messages` | array | ✅ | 消息快照，**保持原始顺序** |
| `totals` | object | ✅ | 聚合统计，见 §3.3 |

**没有额外顶层键**：不输出 `purpose`、不输出 `tools` 数量。辅助调用（`purpose` 为 `compaction` / `session-title`）**不落盘**。

### 3.2 `messages[]` 每条

| 键 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `role` | string | ✅ | `system` / `developer` / `user` / `assistant` / `tool` |
| `text` | string | ✅ | 所有 `text` 内容块拼接后的文本 |
| `chars` | number | ✅ | `text.length` |
| `reasoning` | string | ❌ | 仅当该消息含 `reasoning` 块时出现 |
| `reasoningChars` | number | ❌ | 与 `reasoning` 同时出现 |
| `toolName` | string | ❌ | 仅 `role==="tool"` 且能反查到时出现 |
| `truncated` | `true` | ❌ | 文本被截断时出现 |
| `originalChars` | number | ❌ | 截断前的真实长度 |

**reasoning 不是独立的一条 message**：它与可见文本同属一条 assistant 消息，拆成两个字段。

**`toolName` 是 best-effort**：dsh 的 tool 角色消息只带 `toolCallId`，工具名在**前一条 assistant 消息**的 `tool-call` 块里（`{ id, name, arguments }`）。本插件扫全量消息建立 `toolCallId → 工具名` 反查表；取不到时**不写这个键**（而不是写空串）。

### 3.3 `totals` 语义

- `messages` = 消息条数
- `chars` = 所有消息 `text.length` 之和（**不含** reasoning）
- `reasoningChars` = 所有消息 `reasoning.length` 之和（与 `chars` **互斥**）
- `systemChars` = `role==="system"` 的 `text.length` 之和（是 `chars` 的**子集**）

⚠️ `chars` + `reasoningChars` 才是总可见量；`systemChars` 是子集，**不要**再加进总量。

### 3.4 step / turn 的语义

- `turn` 从 1 起单调递增。
- `step` **在每轮内重置**（dsh 的 `phase.step = 0`，见 `dsh-agent-loop/src/agent.ts:437`）。所以 **`(turn, step)` 才是全局唯一的步标识**，`step` 单独不单调。
- 排序建议：用 `ts`（ISO 字符串，字典序 == 时间序）做主键，`(turn, step)` 做次键。

## 4. 挂载到 WSL web profile（实测步骤）

### 4.1 安装

```bash
# 在 WSL 里
export npm_config_registry="https://registry.npmjs.org"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"

dsh plugin --profile web add "link:/mnt/c/Users/Assistant/projects/dsh-super-agent/memory-debug-capture"
```

**实测结果**：`dsh plugin` 会转发给 pnpm，pnpm 建立 `node_modules/dsh-memory-debug-capture` 符号链接，并**自动把该 bundle 加进 profile 的 `dsh.profile.bundles`**：

```json
{
  "dependencies": {
    "dsh-memory-debug-capture": "link:/mnt/c/Users/Assistant/projects/dsh-super-agent/memory-debug-capture"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-memory-debug-capture"] } }
}
```

> **注意**：`link:` 协议是 **pnpm 的**协议，**不是** Node ESM 的。`import('link:/path')` 会报
> `ERR_UNSUPPORTED_ESM_URL_SCHEME`。它能工作的原因是 pnpm 把它落成 `node_modules/` 下的**符号链接**，
> 而 dsh 的 Loader 走的是普通包名解析（`dsh-memory-debug-capture`），符号链接由 Node 正常跟随。
>
> 另一种等效写法（不需要 pnpm）：在 profile 的 `cordis.patch.yml` 里直接插入一行：
> ```yaml
> - insert:
>     - id: memory-debug-capture
>       name: 'dsh-memory-debug-capture'
> ```
> 但这样 dsh 仍然需要在 `node_modules` 里能解析到 `dsh-memory-debug-capture`，
> 所以 `link:` 安装（或 `file:` 安装）仍然是必要的一步。

### 4.2 验证挂载

```bash
dsh --profile web --dump-config | grep -A3 memory-debug
# == dsh-memory-debug-capture
# - id: memory-debug-capture
#   name: dsh-memory-debug-capture
```

### 4.3 启动采集

```bash
# A/B 两轮：只改 variant 与 runId
MEMORY_DEBUG_OUT=/mnt/c/Users/Assistant/projects/dsh-super-agent/captures \
MEMORY_DEBUG_VARIANT=on \
MEMORY_DEBUG_RUN_ID=run-2026-11-15-on \
dsh --profile web --port 8080 --no-open

MEMORY_DEBUG_OUT=/mnt/c/Users/Assistant/projects/dsh-super-agent/captures \
MEMORY_DEBUG_VARIANT=off \
MEMORY_DEBUG_RUN_ID=run-2026-11-15-off \
dsh --profile web --port 8080 --no-open
```

输出落在 `MEMORY_DEBUG_OUT/capture-<runId>.jsonl`。

## 5. 设计约束

- **只读 dsh**：不改 dsh 源码。
- **运行时不依赖 dsh 包**：`package.json` 的 `dependencies` 为空；`@deepseek-ai/cordis` 只作为
  **可选 peer + devDependency**，代码里只 `import type`。两个用到的 dsh 事件
  （`llm/stream` / `session/event`）在 `src/dsh-events.ts` 里**本地声明**类型，
  避免把 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session` 拉成依赖（现场装的是
  `0.2.1-rc.5`，参考树是 `0.2.2-rc.3`，版本耦合不划算）。
- **不阻塞模型请求**：捕获只做内存序列化 + 推进队列，磁盘 I/O 在后台消费者里做。
- **退出前排空**：插件用 `ctx.effect` 注册 dispose 钩子，dsh 的关停流程会 await 它。

详见 [DESIGN.md](./DESIGN.md)。

## 6. 目录结构

```
memory-debug-capture/
├── package.json          # bundle：dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 插入插件
├── tsconfig.json
├── README.md
├── DESIGN.md
├── scripts/
│   └── integration-check.mjs   # 端到端验证（真实 cordis + 真实 dsh-llm）
└── src/
    ├── index.ts          # apply(ctx)：挂 llm/stream 捕获 + 写文件
    ├── capture.ts        # 捕获逻辑：提取 messages 结构化快照
    ├── serialize.ts      # 把 Message[] 转成可读 JSON
    ├── writer.ts         # JSONL 追加写，文件锁/缓冲，路径可配
    ├── types.ts          # 落盘行的类型契约
    ├── dsh-events.ts     # 两个 dsh 事件的本地类型声明
    └── cli.ts            # --selftest / 单次捕获
```
