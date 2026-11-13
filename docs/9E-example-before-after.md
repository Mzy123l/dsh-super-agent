# 示例：修改前后，模型实际收到什么

> 用真实会话数据构造的对照示例。
> 所有数字（`479,142` / `2,143` / `5,159` / `12,847`）来自 [98-compaction-findings.md](98-compaction-findings.md) 的实测，
> **注意口径**：`1,166,597` 是 59 次 prune 的原文**合计**，`5,159` 是**单条**替换后的固定长度
> （head 4096 + 标记 35 + tail 1024）。两者不能相减。示例中单条的原文取 18,006 字符，
> 故省略 12,847、减幅 71.3%——与合计层面的 1,166,597 → 304,427（同为 −73.9%）口径一致。
> 标记文本格式来自 [9B-dsh-source-findings.md](9B-dsh-source-findings.md) 引用的源码常量。
>
> 场景取自本机真实会话 `session-9ecf69ac`（super-feiyu 项目，C++ 模块化重写）。

---

## 场景设定

**项目**：super-feiyu，一个 2C1G 可部署的 C++ 聊天机器人
**任务**：用户要求"用 clang 模块（modules）重写，而不是头文件"
**硬约束**（用户在第 1 轮说的）：

> "优先模块不是一定模块"
> "所有上限必须让我明确批准才能加"

**发生的事情**（真实链路）：

1. 第 1 轮读入大量源码，单轮消耗 ~48 万 token
2. 压缩触发，遮蔽 **2,143 条事件 / 479,142 tokens**
3. 之后模型继续工作，遇到大型工具结果 → prune 裁到 **5,159 字符**
4. 模型此时要决定：要不要给某个 buffer 加上限？

---

## 一、修改前：模型实际收到的

### 1.1 压缩发生后，模型看到的历史

```
[系统提示词 —— 不受压缩影响]

[历史消息……已全部消失，替换为下面这一条]

user:
This is an automatically generated checkpoint condensing an earlier span of the
conversation to free up context. Treat the captured context as established
background and build on it without restating it. Continue the task directly from
the messages that follow, without acknowledging this checkpoint.

<compacted-summary>

## Primary Request and Intent
- Original: "给我找一个2c1g Ubuntu可部署的DeepSeek大肥鱼项目"
- Then: "都太烂了，自己做一个，给出架构来，要职责分离，c++写"
- Memory design mandated: "短时记忆（上下文/内存）和长时记忆分离"
- Config: "配置允许各种各样的key…采用一套相同的接口"
- Module preference: "尽量用模块吧，头文件构建太费劲了" → later
  "换个编译器，clang或者升级下gcc…优先模块不是一定模块"
- **Hard rule (verbatim)**: "所有上限必须让我明确批准才能加"

## Key Technical Concepts
- C++20 modules via clang 21.1.8, single-file module pattern
- SQLite WAL + brute-force cosine recall
- TokenBudget::make(model_context_tokens, raw_ratio, summary_ratio)

## Files and Code
- `src/fish.core.cppm` — domain types, Result<T>, 7 interfaces
- `src/fish.memory.cppm` — 3-layer memory

## Errors and Fixes
- clang forbids impl unit importing its own module → use `module :private;`

## Pending Jobs
- QQ official Bot path

## Current Work
- 实现 TokenBudget 与历史窗口

## Next Step
- 继续实现 compact()

## Critical Context
- 侧车 Markdown 为权威源，SQLite 索引可重建

</compacted-summary>

[此后是保留的近期消息]
```

### 1.2 裁剪发生后，模型看到的工具结果

```
<前 4096 字符>

[... tool result middle pruned ...]

<后 1024 字符>
```

### 1.3 现在模型被问到

> "给 buffer 加上限，50% 吧"

### 1.4 模型会怎么做（问题所在）

模型此刻的处境：

| 信息 | 状态 |
| --- | --- |
| 用户说过"所有上限必须让我明确批准才能加" | **摘要里有，但混在 12 条 bullet 中间**，且措辞是 `Hard rule (verbatim)`——一个标签，不是一条规则 |
| 用户说过"优先模块不是一定模块" | 摘要里写成 `"优先模块不是一定模块"`，但**上下文丢了**（是在讨论什么时说的？为什么要让步？） |
| 压缩遮蔽了 2,143 条事件 | **完全不知道** |
| 被裁的工具结果里有什么 | **完全不知道**，只有一个无规模标记 |
| 能不能找回 | **不知道有检索通道**（默认全关） |

**最可能的失败**：模型看到摘要里有 `TokenBudget::make(...)` 和 `raw_ratio`，
又看到用户说"50%"，于是直接改代码，**不问"这算不算加了一个上限"**。

因为它读到的是一份"已建立背景"，而 preamble 明确要求
**`without restating it`（不要重述）** 和 **`without acknowledging this checkpoint`（不要提及这个检查点）**。

**系统在要求它"把代理当原件、且不要指出这是代理"。**

---

## 二、修改后：模型实际收到的

### 2.1 压缩发生后（改动：摘要末尾加 3 行）

```
user:
This is an automatically generated checkpoint condensing an earlier span of the
conversation to free up context. Treat the captured context as established
background and build on it without restating it. Continue the task directly from
the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
…（摘要内容不变）…

## Critical Context
- 侧车 Markdown 为权威源，SQLite 索引可重建

</compacted-summary>

<!-- 新增：一行机器可读的完整性声明 -->
[compacted: 2,143 events (seq 41–2184) · 479,142 tokens released at 22:41
 — verbatim history readable: session_query(seq_from=41, seq_to=2184)
 — rules that must survive are re-injected above; if this summary contradicts them, they win]
```

**三个改动**：

1. `2,143 events / 479,142 tokens` —— **量化**，不再是"有个检查点"
2. `session_query(seq_from=41, seq_to=2184)` —— **可操作**，不是"你丢了东西"
3. `rules that must survive are re-injected above; if this summary contradicts them, they win`
   —— **优先级声明**，让模型知道矛盾时该信谁

### 2.2 裁剪发生后（改动：带规模 + 路径）

```
<前 4096 字符>

[pruned: 12,847 chars omitted (18,006 → 5,159, -71.3%)
 · full result spilled to:
   /…/session-9ecf…/…-tool-result-7731.txt
 · recover: read(path, offset=4096) or grep(path, pattern)]

<后 1024 字符>
```

对比：现在只有 `[... tool result middle pruned ...]`，**连丢了多少字符都不说**。

### 2.3 重注入区（改动：必须存活的移出可压信道）

在 system prompt 的固定位置（`node 0`，永不被压缩）：

```
## Hard rules (from the user, verbatim, must be obeyed)

- [R1] "所有上限必须让我明确批准才能加"
  → 任何数值上限（buffer/queue/cache/超时/token 预算）的新增或调整，
    先问「这算不算加了一个上限」，得到明确同意才动手。
  → 首次出现于 seq 41，从未被撤销。

- [R2] "优先模块不是一定模块"
  → 优先用 C++ modules；遇到编译器/构建阻塞时可退回头文件，
    但退回前要说明原因。这是**让步**，不是**目标**。
  → 首次出现于 seq 312。

- [R3] "先别管github，先规划，不要开始写"
  → 已被后续指令取代（seq 2210 之后开始实现）。见历史。
```

**关键差别**：

- 现在是"摘要里 12 条 bullet 中的一条"
- 修改后是"**固定位置的一条可执行规则，带 seq 溯源、带撤销状态**"

### 2.4 现在模型被问到同一个问题

> "给 buffer 加上限，50% 吧"

**修改后模型的推理路径**：

```
读到重注入区 [R1]："任何数值上限…先问，得到同意才动手"
         ↓
识别到"50%"是一个数值上限
         ↓
报告：这是上限。按 R1，需要你明确批准。
         ↓
同时（可选）：如果我记得历史上讨论过 buffer 大小，
          可以 session_query 回去核对——但不必，规则已经足够
```

**差别不在"记性更好"，而在**：
**这条规则不再是"某个已建立背景里的一句话"，而是"一个永远在眼前、可核对、带优先级的约束"。**

---

## 三、两个示例的并列对比

| | 修改前 | 修改后 |
| --- | --- | --- |
| 压缩告知 | "有个检查点" | "遮蔽 2,143 条 / 479,142 tokens" |
| 能否取回 | ❌ 不知道有通道 | ✅ `session_query(seq_from, seq_to)` |
| 裁剪告知 | 无规模、无路径 | `12,847 chars omitted` + spill 路径 + 取法 |
| 硬约束位置 | 摘要里的一条 bullet | system prompt 固定段，永不被压 |
| 硬约束形态 | 自然语言陈述 | **可执行规则 + seq 溯源 + 撤销状态** |
| 矛盾时的优先级 | 未定义 | 明确"重注入区优先于摘要" |
| 模型是否知道缺了什么 | ❌ | ✅ |

---

## 四、这个改动到底改变了什么

### 不是"让模型记得更多"

摘要还是摘要，**2,143 条事件不会回到上下文里**。上下文占用几乎没变（多了约 60 tokens）。

### 是"让模型知道自己站在哪儿"

| 认知 | 修改前 | 修改后 |
| --- | --- | --- |
| 我手里是原件还是代理 | 不知道 | **知道** |
| 代理可能漏了什么、漏了多少 | 不知道 | **知道范围** |
| 漏了的东西能不能查 | 不知道 | **知道命令** |
| 有没有一些东西优先于这份代理 | 不知道 | **知道是哪些** |

### 用一个类比

- **修改前**：给你一张地图，撕掉了 80%，但不告诉你撕了哪儿，也不给你指南针。
- **修改后**：同一张残缺地图，但标注了「此处缺失 2,143 格，原图存放在 X，坐标从这里开始」，
  并在角落钉着三张「不可协商的便签」。

**地图还是残的，但你不再迷路。**

---

## 五、成本核算

| 改动 | 增量 token | 实现难度 |
| --- | --- | --- |
| 压缩声明（3 行） | ~55 | **极低**：`shadowedSeqs` 已在事件里，多写一行 |
| 裁剪声明（带规模+路径） | ~40 | **低**：`dsh-spill-policy` 已有完整实现，照抄格式 |
| 重注入区（3 条规则） | ~120 | **中**：需要一条"规则抽取 + 固定注入"的链路 |

**合计约 215 tokens**——不到工具 schema（12,139）的 2%。

而它换取的是：**模型不会在没察觉的情况下违反一条被明确说过的约束**。

---

## 六、这个示例暴露的真正矛盾

看修改前的两句话：

```
Treat the captured context as established background and build on it without restating it.
…
without acknowledging this checkpoint.
```

**"当作已确立的背景" + "不要提及它"** —— 这两句合起来，等于要求模型：

> **把一份有损的代理，当成权威的原件，并且不许质疑。**

这不是文档措辞问题。它是**架构选择**：
系统认为"让模型自然接着说"比"让模型知道自己缺什么"更重要。

而 `memory-survey` 的数据给了反证：
**同样 token 预算下，「指针」买到能力，「自我告知」只买到焦虑。**
所以正确做法不是二选一，而是——
**别说"你被压缩了"（焦虑），说"这部分在 X，用 Y 取"（能力）。**

---

## 附：如果要做最小可行改动

只改一处、只加一行，就能拿到大部分收益：

```diff
  [compacted-summary] … [/compacted-summary]
+
+ [compacted: 2,143 events · 479,142 tokens · seq 41–2184 · session_query 可取回]
```

**一行，约 25 tokens。**

它不能解决"规则优先级"问题，但能解决**最要命的那一半**：
让模型知道**自己正在读一份代理，以及代理的边界在哪**。
