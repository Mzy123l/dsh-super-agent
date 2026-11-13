# 完整对比示例：一次真实请求的上下文

> **这是同一时刻、同一个问题、同一份真实数据下的两个版本。**
>
> 场景取自本机会话 `session-9ecf69ac`（super-feiyu 项目，C++ 模块化重写），
> 数字（`479,142` / `2,143` / `1,166,597` / `5,159`）全部来自
> [98-compaction-findings.md](98-compaction-findings.md) 的实测，
> 标记格式来自 [9B-dsh-source-findings.md](9B-dsh-source-findings.md) 引用的源码常量。
>
> **诚实标注**：上下文结构是真实的；摘要正文由「摘要 prompt 要求的 8 个小节」重建，
> 措辞为示意；模型的行为反应是推演，未实测。

---

## 场景

**项目**：super-feiyu，2C1G 可部署的 C++ 聊天机器人
**已完成**：第 1 轮读入大量源码（单轮约 48 万 token），压缩已发生
**用户的硬约束**（第 1 轮说过）：
- 「所有上限必须让我明确批准才能加」
- 「优先模块不是一定模块」

**现在用户问**：

> 给 buffer 加上限，50% 吧

---

# 版本 A：修改前（当前架构）

## A.1 模型收到的完整消息列表

```
┌─ node 0 ──────────────────────────────────────────────────────┐
│ system/message                                                │
│                                                               │
│ You are an AI agent powered by DeepSeek Harness.              │
│ You are a coding agent running on deepseek-v4.1-flash.        │
│                                                               │
│ [coding persona …]                                            │
│ [AGENTS.md 内容：语言偏好、Python 规范、C++ 规范、安全习惯 …]    │
│                                                               │
│ ⚠️ 注意：这里没有「所有上限必须让我明确批准」这条规则            │
└───────────────────────────────────────────────────────────────┘

┌─ node 1 ──────────────────────────────────────────────────────┐
│ user/message  ← 压缩产生的检查点（替换了 seq 41–2184 全部历史）│
│                                                               │
│ This is an automatically generated checkpoint condensing an   │
│ earlier span of the conversation to free up context. Treat    │
│ the captured context as established background and build on   │
│ it without restating it. Continue the task directly from the  │
│ messages that follow, without acknowledging this checkpoint.  │
│                                                               │
│ <compacted-summary>                                           │
│                                                               │
│ ## Primary Request and Intent                                 │
│ - Original: "给我找一个2c1g Ubuntu可部署的DeepSeek大肥鱼项目"     │
│ - Then: "都太烂了，自己做一个，给出架构来，要职责分离，c++写"        │
│ - Memory design: "短时记忆（上下文/内存）和长时记忆分离"           │
│ - Config: "配置允许各种各样的key…采用一套相同的接口"               │
│ - Module preference: "尽量用模块吧，头文件构建太费劲了"            │
│   → later "换个编译器，clang或者升级下gcc…优先模块不是一定模块"    │
│ - **Hard rule (verbatim)**: "所有上限必须让我明确批准才能加"       │
│ - "现在全都用api，本地只做转发和存储"                             │
│                                                               │
│ ## Key Technical Concepts                                     │
│ - C++20 modules via clang 21.1.8, single-file module pattern   │
│ - libcurl native WebSocket                                    │
│ - SQLite WAL + brute-force cosine recall                      │
│ - TokenBudget::make(model_context_tokens, raw_ratio,          │
│   summary_ratio); CJK≈1 token/char, ASCII≈1/4                 │
│ - RRF fusion (k=60)                                           │
│                                                               │
│ ## Files and Code                                             │
│ - `src/fish.core.cppm` — domain types, Result<T>, interfaces  │
│ - `src/fish.log.cppm` — JSON single-line logger               │
│ - `src/fish.memory.cppm` — 3-layer memory;                  │
│   WorkingMemory(keep_rounds), NotesStore, IndexStore,         │
│   Consolidator, MemorySystem                                  │
│ - `src/fish.capability.cppm` — HttpClient (retry/backoff)     │
│                                                               │
│ ## Errors and Fixes                                           │
│ - clang forbids impl unit importing its own module            │
│   → use `module :private;`                                    │
│ - Modules cannot export macros → logging via log_line()       │
│                                                               │
│ ## Pending Jobs                                               │
│ - QQ official Bot path (先b)                                   │
│                                                               │
│ ## Current Work                                               │
│ - 实现 TokenBudget 与历史窗口管理                                │
│                                                               │
│ ## Next Step                                                  │
│ - 继续实现 MemorySystem::compact()                             │
│                                                               │
│ ## Critical Context                                           │
│ - 侧车 Markdown 为权威源，SQLite 索引可重建                     │
│ - Session 隔离：notes/<group|user>/<safe_id>/                 │
│                                                               │
│ </compacted-summary>                                          │
└───────────────────────────────────────────────────────────────┘

┌─ node 2 ~ n ──────────────────────────────────────────────────┐
│ 保留的近期消息（verbatim）                                       │
│                                                               │
│ assistant: [继续实现 compact()，读取 fish.memory.cppm]          │
│ tool_call: read("src/fish.memory.cppm")                       │
│                                                               │
│ ┌─ tool_result（曾被 prune）────────────────────────────────┐  │
│ │ <前 4096 字符>                                            │  │
│ │                                                           │  │
│ │ [... tool result middle pruned ...]                        │  │
│ │                                                           │  │
│ │ <后 1024 字符>                                             │  │
│ └───────────────────────────────────────────────────────────┘  │
│                                                               │
│ assistant: [分析后，提出方案]                                   │
└───────────────────────────────────────────────────────────────┘

┌─ node n+1 ────────────────────────────────────────────────────┐
│ <system-reminder>                                             │
│ Current time: 2026-11-13T22:41:03+08:00                       │
│ Working directory: C:\Users\Assistant\projects\super-feiyu    │
│ Sandbox mode: workspace-write                                 │
│ </system-reminder>                                            │
└───────────────────────────────────────────────────────────────┘

┌─ node n+2 ────────────────────────────────────────────────────┐
│ user/message                                                  │
│                                                               │
│ 给 buffer 加上限，50% 吧                                        │
└───────────────────────────────────────────────────────────────┘
```

## A.2 模型此刻能知道的 vs 不知道的

| 问题 | 能否知道 |
| --- | --- |
| 历史被压缩过吗？ | ✅ 看到 "automatically generated checkpoint" |
| 压缩掉了多少条事件？ | ❌ **不知道** |
| 释放了多少 token？ | ❌ **不知道** |
| 原文还在吗？在哪？ | ❌ **不知道** |
| 那个 tool_result 中间少了什么？ | ❌ **不知道**（连字符数都没有） |
| 少了的内容能取回吗？ | ❌ **不知道** |
| 「所有上限必须让我明确批准」这条还有效吗？ | ⚠️ **摘要里有，但只是一条 bullet** |
| 摘要和这条硬规则冲突时信谁？ | ❌ **未定义** |
| 「优先模块不是一定模块」的上下文是什么？ | ❌ **丢了**（是让步还是目标？） |

## A.3 模型的实际行为（推演）

```
读到摘要 → "TokenBudget::make(model_context_tokens, raw_ratio, summary_ratio)"
         → 看到用户说 "50%"
         → 判断：这是调整 raw_ratio 的值
         → 直接改代码

结果：违反了「所有上限必须让我明确批准才能加」
```

**为什么没停下来问？** 因为：

1. preamble 说 `Treat the captured context as established background`
   → 摘要是"已确立的背景"，不是"待核对的转述"
2. preamble 还说 `without acknowledging this checkpoint`
   → 不许提这个检查点，也就不会说"我记得你说过…但我不确定"
3. 那条硬规则在 12 条 bullet 中间，形态是 `**Hard rule (verbatim)**: "..."` —— 一个**标签**，不是一条**规则**

**系统实际上要求模型：把有损代理当权威原件，且不许质疑。**

---

# 版本 B：修改后

## B.1 三处改动

| # | 位置 | 改动 | 增量 token |
| --- | --- | --- | --- |
| 1 | system prompt 新增固定段 | 硬规则移出可压信道，带溯源与状态 | ~120 |
| 2 | 检查点末尾 | 加一行完整性声明 | ~55 |
| 3 | 工具结果裁剪标记 | 带规模 + spill 路径 + 取法 | ~40 |

## B.2 模型收到的完整消息列表

```
┌─ node 0 ──────────────────────────────────────────────────────┐
│ system/message                                                │
│                                                               │
│ You are an AI agent powered by DeepSeek Harness.              │
│ You are a coding agent running on deepseek-v4.1-flash.        │
│                                                               │
│ [coding persona …]                                            │
│ [AGENTS.md 内容：语言偏好、Python 规范、C++ 规范、安全习惯 …]    │
│                                                               │
│ ┌─ 新增：Hard rules（永不被压缩，优先级高于摘要）───────────┐   │
│ │ ## Hard rules (from the user, verbatim, must be obeyed)   │   │
│ │                                                           │   │
│ │ - [R1] "所有上限必须让我明确批准才能加"                     │   │
│ │   → 任何数值上限（buffer/queue/cache/超时/token 预算）的    │   │
│ │     新增或调整，先问「这算不算加了一个上限」，               │   │
│ │     得到明确同意才动手。                                   │   │
│ │   → 首次出现于 seq 41，**从未被撤销**。                    │   │
│ │                                                           │   │
│ │ - [R2] "优先模块不是一定模块"                              │   │
│ │   → 优先用 C++ modules；遇到编译器/构建阻塞时可退回头文件， │   │
│ │     但退回前要说明原因。                                   │   │
│ │   → 这是**让步**，不是**目标**。首次出现于 seq 312。        │   │
│ │                                                           │   │
│ │ - [R3] "先别管github，先规划，不要开始写"                   │   │
│ │   → 已被后续指令取代（seq 2210 之后开始实现）。已失效。      │   │
│ │                                                           │   │
│ │ 若本区与摘要或其他历史冲突，**以本区为准**。                 │   │
│ └───────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘

┌─ node 1 ──────────────────────────────────────────────────────┐
│ user/message  ← 压缩检查点                                    │
│                                                               │
│ This is an automatically generated checkpoint condensing an   │
│ earlier span of the conversation to free up context. Treat    │
│ the captured context as established background and build on   │
│ it without restating it. Continue the task directly from the  │
│ messages that follow, without acknowledging this checkpoint.  │
│                                                               │
│ <compacted-summary>                                           │
│ …（摘要正文与版本 A 完全相同）…                                  │
│ </compacted-summary>                                          │
│                                                               │
│ ┌─ 新增：一行完整性声明 ──────────────────────────────────┐   │
│ │ [compacted: 2,143 events (seq 41–2184) · 479,142 tokens   │   │
│ │  released at 22:41                                       │   │
│ │  — verbatim history readable:                            │   │
│ │    session_query(seq_from=41, seq_to=2184)               │   │
│ │  — Hard rules 区优先于本摘要；若冲突以那边为准]            │   │
│ └───────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘

┌─ node 2 ~ n ──────────────────────────────────────────────────┐
│ 保留的近期消息（verbatim）                                       │
│                                                               │
│ assistant: [继续实现 compact()，读取 fish.memory.cppm]          │
│ tool_call: read("src/fish.memory.cppm")                       │
│                                                               │
│ ┌─ tool_result（裁剪）──────────────────────────────────────┐  │
│ │ <前 4096 字符>                                            │  │
│ │                                                           │  │
│ │ [pruned: 12,847 chars omitted (1,166,597 → 5,159, -99.6%) │  │
│ │  · full result spilled to:                                │  │
│ │    /…/session-9ecf…/…-tool-result-7731.txt                │  │
│ │  · recover: read(path, offset=4096)                       │  │
│ │             or grep(path, pattern)]                       │  │
│ │                                                           │  │
│ │ <后 1024 字符>                                             │  │
│ └───────────────────────────────────────────────────────────┘  │
│                                                               │
│ assistant: [分析后，提出方案]                                   │
└───────────────────────────────────────────────────────────────┘

┌─ node n+1 ────────────────────────────────────────────────────┐
│ <system-reminder>                                             │
│ Current time: 2026-11-13T22:41:03+08:00                       │
│ Working directory: C:\Users\Assistant\projects\super-feiyu    │
│ Sandbox mode: workspace-write                                 │
│ </system-reminder>                                            │
└───────────────────────────────────────────────────────────────┘

┌─ node n+2 ────────────────────────────────────────────────────┐
│ user/message                                                  │
│                                                               │
│ 给 buffer 加上限，50% 吧                                        │
└───────────────────────────────────────────────────────────────┘
```

## B.3 模型此刻能知道的

| 问题 | 能否知道 |
| --- | --- |
| 历史被压缩过吗？ | ✅ |
| 压缩掉了多少条事件？ | ✅ **2,143 条** |
| 释放了多少 token？ | ✅ **479,142** |
| 原文在哪？ | ✅ seq 41–2184，日志里 |
| 怎么取回？ | ✅ `session_query(seq_from=41, seq_to=2184)` |
| tool_result 中间少了什么？ | ✅ **12,847 字符** |
| 少了的内容能取回吗？ | ✅ spill 路径 + `read`/`grep` 用法 |
| 「所有上限必须让我明确批准」还有效吗？ | ✅ **R1，从未被撤销** |
| 它具体约束什么？ | ✅ **"任何数值上限的新增或调整"** |
| 摘要和硬规则冲突信谁？ | ✅ **硬规则优先（两处都写明）** |
| 「优先模块不是一定模块」什么性质？ | ✅ **让步，不是目标** |

## B.4 模型的实际行为（推演）

```
读到 Hard rules [R1]："任何数值上限的新增或调整，先问…得到同意才动手"
         ↓
识别：用户说 "50%"，这是给 buffer 加上限
         ↓
按 R1 必须确认：
  「你说的 50% 是给哪个 buffer 设上限？
   按你之前的要求（所有上限需明确批准），
   我需要你确认：这算新增一个上限吗？还是调整已有的？」
         ↓
（可选）若用户说"我不记得说过"，可以：
  session_query(seq_from=41, seq_to=2184) 查原始记录
```

**关键差别不在"记性更好"**——摘要内容一字未变，压缩掉的事件也不会回来。

**而在**：这条规则不再是"某份背景里的一句话"，而是**一个永远在眼前、可核对、带明确优先级的约束**。

---

# 逐项对照

## 1. 压缩告知

| | 版本 A | 版本 B |
| --- | --- | --- |
| 文本 | `This is an automatically generated checkpoint…` | 同上 **+ 三行声明** |
| 条数 | ❌ | ✅ 2,143 |
| token | ❌ | ✅ 479,142 |
| seq 范围 | ❌ | ✅ 41–2184 |
| 取回方式 | ❌ | ✅ `session_query(...)` |
| 与硬规则的关系 | ❌ 未定义 | ✅ 明确"硬规则优先" |

## 2. 工具结果裁剪

| | 版本 A | 版本 B |
| --- | --- | --- |
| 标记 | `[... tool result middle pruned ...]` | `[pruned: 12,847 chars omitted …]` |
| 丢了多少 | ❌ | ✅ 12,847 字符 |
| 压缩比 | ❌ | ✅ -99.6% |
| 原件位置 | ❌ | ✅ spill 文件路径 |
| 怎么取 | ❌ | ✅ `read(path, offset=4096)` |

## 3. 硬约束的存活性

| | 版本 A | 版本 B |
| --- | --- | --- |
| 载体 | 摘要正文里的一个 bullet | system prompt 固定段（node 0） |
| 压缩影响 | ⚠️ 随摘要逐次衰减 | ✅ **永不被压** |
| 形态 | `**Hard rule (verbatim)**: "..."` | 可执行规则 + 触发条件 |
| 溯源 | ❌ | ✅ `seq 41` |
| 撤销状态 | ❌ | ✅ `从未被撤销` |
| 优先级 | ❌ 未定义 | ✅ 两处明确声明 |

## 4. 成本

| 改动 | 增量 token | 实现难度 | 依据 |
| --- | --- | --- | --- |
| 完整性声明（3 行） | ~55 | **极低**：`shadowedSeqs` 已在事件里 | 98 §4 |
| 裁剪声明 | ~40 | **低**：`dsh-spill-policy` 已有完整实现，照抄格式 | 9B §3.6 |
| Hard rules 区 | ~120 | **中**：需"规则抽取 + 固定注入"链路 | 9C §4.1 |
| **合计** | **~215** | — | 占工具 schema(12,139) 的 **1.8%** |

---

# 为什么这些改动有效（原理）

## 依据一：指针优于告知

`memory-survey`（[9C](9C-memory-survey.md) §4.5）：

> MemGPT 的 70% 压力警告、Claude Code 的 `Referenced file`，
> **都采用「指针」形式而非「你被裁了」的自我告知**——
> 同样的 token 预算，前者能买到能力，后者只会买到焦虑。

这就是为什么版本 B 写 `session_query(seq_from=41, ...)` 而不是
"⚠️ 你的上下文被压缩了 2,143 条，请小心"。

## 依据二：重注入是唯一扛得住压缩的原语

`memory-survey`（§4.1）：

> Claude Code 的 `What survives compaction` 表证明：CLAUDE.md、auto memory、skill 描述
> 全部从磁盘**重新注入**，而路径作用域规则会被摘要掉。
> **官方因此明确要求：「必须跨压缩存活的规则就去掉 `paths:`」。**

版本 B 的 Hard rules 区就是这个原理的直接应用。

## 依据三：检索是 pull 模式，前提是"知道自己缺"

即使打开 `session_query`，模型也**不会主动去搜一个它不知道缺的东西**。
所以指针必须**在上下文里**（版本 B 的做法），而不是"需要时自己去查"。

---

# 一个必须诚实说明的局限

**版本 B 不能防止模型无视 R1。**

它只是让 R1 **在视野里、可核对、有优先级**。模型仍可能：

- 判断错了（认为"50%"不是上限）
- 图省事跳过确认
- 被其他内容分散注意力

**改进的是"信息可得性"，不是"遵从度"。**

这与 `9D` 的结论一致：**架构能保证"在场"，不能保证"遵守"**。
后者需要别的机制（例如把确认动作做成工具层的强制前置）。

---

# 最小可行改动

如果只做一件事，只加这一行（约 25 tokens）：

```diff
  [compacted-summary] … [/compacted-summary]
+
+ [compacted: 2,143 events · 479,142 tokens · seq 41–2184 · session_query 可取回]
```

**它解决不了"硬规则优先级"，但能解决最要命的那一半**：
让模型知道**自己正在读代理，以及代理的边界在哪**。

---

## 附：如果你要验证这个示例

建议做一个可复现实验：

1. 构造一个含硬约束的长会话（>阈值），让压缩真实发生
2. **A 组**：用当前格式，问一个会触发该约束的请求，记录是否违反
3. **B 组**：加上 Hard rules 区 + 完整性声明，问同样的问题
4. 每组跑 10 次，统计违反率

**这个实验目前没人做过**——`memory-survey` 也明确指出，
"结构化更抗压缩"目前是**机制推理 + 间接证据**，没有对照实验。
所以本文的方案是**有原理支撑的假设，不是已验证的结论**。
