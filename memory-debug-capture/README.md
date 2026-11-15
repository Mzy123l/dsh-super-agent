# memory-debug-capture

**DSH 调试采集插件**：**同一轮会话内**抓两次上下文——「原版（记忆机制介入前）」与
「新版（介入后真正发给模型）」——落盘为 JSONL。

这是记忆插件实测的**采集端**——它不改变模型行为，只旁路观测。

> 调研依据：[`docs/9Q-debug-capture.md`](../docs/9Q-debug-capture.md)。核心结论：
> `llm/stream` waterfall 是**唯一全覆盖**的捕获点（provider 无关、覆盖重试、
> `messages` 与适配器输入同一份对象、请求已 deep-frozen 不会被误改）。

---

## 1. 双栏采集模型

**不是两轮 A/B，而是同一轮里的两个相位。**

| 相位 | 捕获时机 | 拿到的上下文 |
|---|---|---|
| `before` | `agent/pre-step`（**最外层**监听器） | 记忆机制介入**之前**的完整上下文 |
| `after` | `llm/stream` | **最终发出**给模型的 messages |

两栏来自**同一个请求**，用 `requestKey`（= `sessionId#turn#step`）配对。

### before 版怎么算出来

**`before = after − 插件注入`**。

dsh 的时序（`dsh-agent-loop/src/agent.ts`）是：

```
preStep() → waterfall 'agent/pre-step' → 提交 system/message 与 user/message
           → step/start → buildRequest() → llm/stream
```

所以在 pre-step 时刻拿到的派生历史里，**没有**本步的系统提示词（它在 pre-step
之后才投影进 surface）。直接用它当 before 栏，会把「系统提示词的差异」
误报成「记忆机制的注入量」。

正确的算法（见 `src/before.ts`）：

1. pre-step 时刻记下**基线历史**（`session.deriveMessages()`）；
2. `llm/stream` 时拿到 after；
3. 找出 after 里有、基线里没有的，且 `source.kind` **不是** dsh 自有来源的消息
   ——那些就是**插件注入**（记忆机制、AGENTS.md 等）；
4. before = after − 这些注入。

**怎么区分「插件注入」和「dsh 自有」**：用 dsh 的 `Message.source.kind`。
它是可扩展的联合类型（`dsh-llm/src/message.ts:110`）。dsh 自有的几种是
`'user'`（用户输入）、`'system-prompt'`（系统提示词）、`'runtime-context'`、
`'model'`、`'tool'`；其余都是**插件声明的注入**。

> **实测**：真实 dsh headless 运行里，不挂注入插件时 before == after（完全一致）；
> 挂上模拟注入插件后，两栏的差异**恰好**是那一条注入消息。

### 配对键以 pre-step 的 (turn, step) 为准

`step/start` 事件在 pre-step **之后**才提交，所以从会话事件拿到的 step 号
在 `llm/stream` 时可能已经是下一步的值。pre-step 的 payload 里带着本步自己的
`turn`/`step`，是唯一可靠的来源（插件已按此实现，并集成验证过）。

### 为什么 pre-step 监听器要用 `prepend`

cordis 的 waterfall 按注册顺序**从外到内**排列。只有**最外层**的监听器
`await next()` 之后，拿到的才是**所有其它监听器都改完之后**的最终决定。
所以本插件用 `{ prepend: true }` 把自己放到最外层——否则拿到的是**尚未**被
记忆机制改写的决定，注入就看不见了。

---

## 2. 快速开始

```bash
npm install          # 只装 devDependencies（typescript + @types/node + cordis 类型）
npm run build        # tsc 编译到 dist/
npm run selftest     # 自检：序列化 + 落盘 + before/after 配对（不需要 dsh 运行时）
npm start            # 跑一次捕获并打印统计
npm run verify       # build + selftest + 集成验证（真实 cordis + 真实 dsh-llm）
```

## 3. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MEMORY_DEBUG_OUT` | `./captures/` | 输出目录 |
| `MEMORY_DEBUG_VARIANT` | `off` | 变体标记，只接受 `on` / `off`（大小写不敏感），其它值一律降级为 `off` |
| `MEMORY_DEBUG_RUN_ID` | `run-unknown` | 本轮 run 的标识（用于区分多次运行） |
| `MEMORY_DEBUG_MAX_CHARS` | 不截断 | 单条消息**文本**的字符上限；超限则截断并标 `truncated` + `originalChars` |

**环境变量优先于插件配置**，这样切换实测场景只需改环境变量重启。

## 4. 落盘格式

每行一个 JSON 对象（JSONL）。输出文件默认是 `<MEMORY_DEBUG_OUT>/capture-<runId>.jsonl`。

**同一个请求写两行**，先 `before` 后 `after`，两行共用一个 `requestKey`：

```json
{"ts":"2026-11-15T06:00:00.000Z","sessionId":"session-demo-0001","provider":"deepseek","model":"deepseek-chat","step":1,"turn":1,"variant":"on","runId":"run-2026-11-15-dual","phase":"before","requestKey":"session-demo-0001#1#1","messages":[{"role":"system","text":"你是一个命令行助手。回答简洁。","chars":15},{"role":"user","text":"帮我看看这个仓库的结构，然后写一个 TS 工具把 JSONL 转成 HTML。","chars":39}],"totals":{"messages":2,"chars":54,"reasoningChars":0,"systemChars":15}}
{"ts":"2026-11-15T06:00:10.000Z","sessionId":"session-demo-0001","provider":"deepseek","model":"deepseek-chat","step":1,"turn":1,"variant":"on","runId":"run-2026-11-15-dual","phase":"after","requestKey":"session-demo-0001#1#1","messages":[{"role":"system","text":"你是一个命令行助手。回答简洁。","chars":15},{"role":"user","text":"帮我看看这个仓库的结构，然后写一个 TS 工具把 JSONL 转成 HTML。","chars":39}],"totals":{"messages":2,"chars":54,"reasoningChars":0,"systemChars":15}}
```

### 4.1 顶层字段

| 键 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `ts` | string | ✅ | 捕获时刻，ISO 8601（UTC，毫秒精度） |
| `sessionId` | string | ✅ | 会话 id；未知时为 `""` |
| `provider` | string | ✅ | 提供方路由名 |
| `model` | string | ✅ | 模型 id |
| `step` | number | ✅ | 步号（从 1 起）；未知时 `0` |
| `turn` | number | ✅ | 轮号（从 1 起）；未知时 `0` |
| `variant` | string | ✅ | `"on"` / `"off"`（保留字段，旧的 A/B 分组用） |
| `runId` | string | ✅ | 本轮 run 标识 |
| **`phase`** | string | ✅ | **`"before"`（介入前）/ `"after"`（介入后）** |
| **`requestKey`** | string | ✅ | **配对键：同一次请求的 before/after 共用** |
| `messages` | array | ✅ | 消息快照，**保持原始顺序** |
| `totals` | object | ✅ | 聚合统计，见 §4.3 |

**没有额外顶层键**：不输出 `purpose`、不输出 `tools` 数量。辅助调用（`purpose` 为
`compaction` / `session-title`）**不落盘**。

### 4.2 `messages[]` 每条

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

**`toolName` 是 best-effort**：dsh 的 tool 角色消息只带 `toolCallId`，工具名在**前一条
assistant 消息**的 `tool-call` 块里（`{ id, name, arguments }`）。本插件扫全量消息建立
`toolCallId → 工具名` 反查表；取不到时**不写这个键**（而不是写空串）。

### 4.3 `totals` 语义

- `messages` = 消息条数
- `chars` = 所有消息 `text.length` 之和（**不含** reasoning）
- `reasoningChars` = 所有消息 `reasoning.length` 之和（与 `chars` **互斥**）
- `systemChars` = `role==="system"` 的 `text.length` 之和（是 `chars` 的**子集**）

⚠️ `chars` + `reasoningChars` 才是总可见量；`systemChars` 是子集，**不要**再加进总量。

### 4.4 step / turn / requestKey 的语义

- `turn` 从 1 起单调递增。
- `step` **在每轮内重置**（dsh 的 `phase.step = 0`，见 `dsh-agent-loop/src/agent.ts:437`）。
  所以 **`(turn, step)` 才是全局唯一的步标识**，`step` 单独不单调。
- `requestKey` = `${sessionId}#${turn}#${step}`；三者都未知时退化为纯 `sessionId`。
- 排序建议：用 `ts`（ISO 字符串，字典序 == 时间序）做主键，`(turn, step)` 做次键。

### 4.5 向后兼容

**旧采集文件没有 `phase` / `requestKey` 字段**，读取时：

- `phase` 缺失 → 按 **`'after'`** 处理；
- `requestKey` 缺失 → 按 `sessionId#turn#step` 兜底推导。

所以旧文件仍能被生成器渲染（走旧的 A/B 两轮模式）。

---

## 5. 挂载到 WSL web profile（实测步骤）

### 5.1 安装

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

### 5.2 验证挂载

```bash
dsh --profile web --dump-config | grep -A3 memory-debug
# == dsh-memory-debug-capture
# - id: memory-debug-capture
#   name: dsh-memory-debug-capture
```

### 5.3 启动采集

```bash
# 一轮即可：插件自己会为每个请求抓 before / after 两栏
MEMORY_DEBUG_OUT=/mnt/c/Users/Assistant/projects/dsh-super-agent/captures \
MEMORY_DEBUG_VARIANT=on \
MEMORY_DEBUG_RUN_ID=run-2026-11-15-01 \
dsh --profile web --port 8080 --no-open
```

输出落在 `MEMORY_DEBUG_OUT/capture-<runId>.jsonl`，每个请求两行。

### 5.4 生成对比页

```bash
cd tools
node dist/gen-memory-debug.js \
  --dir ../captures \
  --out ../memory-debug.html \
  --title "同轮双栏：原版上下文 vs 新版上下文"
```

## 6. 设计约束

- **只读 dsh**：不改 dsh 源码。
- **运行时不依赖 dsh 包**：`package.json` 的 `dependencies` 为空；`@deepseek-ai/cordis` 只作为
  **可选 peer + devDependency**，代码里只 `import type`。用到的三个 dsh 事件
  （`llm/stream` / `session/event` / `agent/pre-step`）在 `src/dsh-events.ts` 里**本地声明**类型，
  避免把 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-agent` 拉成依赖
  （现场装的是 `0.2.1-rc.5`，参考树是 `0.2.2-rc.3`，版本耦合不划算）。
- **不阻塞模型请求**：捕获只做内存序列化 + 推进队列，磁盘 I/O 在后台消费者里做。
- **退出前排空**：插件用 `ctx.effect` 注册 dispose 钩子，dsh 的关停流程会 await 它。

详见 [DESIGN.md](./DESIGN.md)。

## 7. 目录结构

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
    ├── index.ts          # apply(ctx)：挂 pre-step + llm/stream 捕获 + 写文件
    ├── capture.ts        # 捕获逻辑：提取 messages 结构化快照 + requestKey
    ├── before.ts         # before 重建：after − 插件注入（纯函数）
    ├── serialize.ts      # 把 Message[] 转成可读 JSON
    ├── writer.ts         # JSONL 追加写，文件锁/缓冲，路径可配
    ├── types.ts          # 落盘行的类型契约（含 phase / requestKey）
    ├── dsh-events.ts     # 三个 dsh 事件的本地类型声明
    └── cli.ts            # --selftest / 单次捕获
```

## 8. 验证状态

| 层次 | 命令 | 状态 |
|---|---|---|
| 单元自检 | `npm run selftest` | ✅ 全过（含 before/after 配对与重建逻辑） |
| 类型检查 | `npx tsc -p tsconfig.json --noEmit` | ✅ 无错误 |
| 集成验证 | `npm run integration` | ✅ 全过（真实 cordis + 真实 dsh-llm） |
| 真实 dsh 端到端 | WSL `dsh --profile headless "..."` | ⚠️ **部分**——采集链路在真实 dsh 里跑通了，但**真实模型请求没跑成**（缺 `DEEPSEEK_API_KEY`） |

真实 dsh 里已实测的结论：

- 插件被真实 dsh 加载（`dump-config` 可见，启动无报错）；
- 无注入插件时 before == after（完全一致）；
- 挂上模拟注入插件后，两栏差异**恰好**是那条注入消息。

详见 [DESIGN.md §11](./DESIGN.md#11-验证实测)。
