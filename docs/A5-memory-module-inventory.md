# 记忆模块：完整实现清单与缺口对照

> 生成时间：2026-11-15
> 代码版本：`memory-plugin/` 3459 行 → 删除死代码后 **3252 行**
> 测试：**105 项全过**（6 个测试文件）
> 本文只描述**代码里真实存在并能跑通的东西**，未实现的单列一节。

---

## 一、你提出的架构（逐条复述）

从对话里还原的完整设计：

1. **每个事件都要编号**，包括消息、工具调用、工具结果、思考、摘要
2. **编号按会话独立**，会话 A 的 #1 与会话 B 的 #1 无关
3. **不要奇怪的 map**，用自增整数做主键
4. **近几步全量 + 总结**，再前面的只有总结
5. **总结和压缩分开**：总结是提炼，压缩是腾空间
6. **提炼要保留否决路径**，不是只留结论
7. **提炼提示只出现一次**，不回传
8. **总结由模型自己写**，不是外挂小模型
9. **不要程序化触发**索引
10. **不要让模型自己调工具**，改消息循环机制
11. **思考不进关键词索引**，只向量化
12. **不用 dsh 内置的检索**，自建存储复制数据
13. **搜索要全量**，不管有没有被压缩

---

## 二、已完成（含具体数值与机制）

### 2.1 编号体系

| 项 | 实现 |
| --- | --- |
| 内部主键 | `row_id INTEGER PRIMARY KEY AUTOINCREMENT`（全库唯一，仅供 FTS 当 rowid） |
| 对外编号 | `event_no`，**按会话独立递增**，从 1 开始 |
| 唯一定位 | `(sessionId, event_no)` |
| 幂等约束 | `UNIQUE (sessionId, seq, kind)`——同一事件重复写入复用编号 |

**覆盖的事件类型**（6 种，全部占编号）：

```
user/message · assistant/message · reasoning · tool/call · tool/result · compaction/summary
```

**一个 seq 对应多个编号的真实例子**：`assistant/message` 同时含正文与思考，
产生 `event_no=N`（kind=assistant）与 `event_no=N+1`（kind=reasoning）。

### 2.2 存储表（6 张）

| 表 | 主键 | 唯一约束 | 用途 |
| --- | --- | --- | --- |
| `event` | `row_id` | `(sessionId, event_no)`, `(sessionId, seq, kind)` | 事件台账 |
| `event_text` | `row_id` | 一对一外键 | 正文 |
| `event_fts` | `rowid` = `event.row_id` | — | 关键词索引 |
| `segment` | `row_id` | `(sessionId, event_no)` | 总结段 |
| `pending_inject` | `sessionId` | — | 等待提炼的状态 |
| `watermark` / `meta` | `sessionId` / `key` | — | 增量与元信息 |

**已删除的**：`records`、`reasoning`、`records_fts`、`fts_map`、`watermarks`、`sealed_segment`、`seal`。

### 2.3 槽位合并（近全量 + 总结）

**一个段 = 一个编号 = 一条消息**，内部用 XML 标签分区：

```xml
<recent-slot>
近期逐字原文
</recent-slot>

<summary-slot>
否决 A：因为鉴权冲突
否决 B：因为延迟超标
最终：D
</summary-slot>
```

| 阶段 | 内容 | 何时 |
| --- | --- | --- |
| `live` | recent + summary 并存 | 刚写入 |
| `archived` | 只剩 summary | `turn ≤ latestTurn - keepTurns` |

**降级规则的实际公式**：`cutoff = latestTurn − keepTurns`，`seg.turn ≤ cutoff` 即降级。
`keepTurns` 默认 **3**。

### 2.4 提炼（不是压缩）

**触发提示的原文**（`buildSummarizePrompt`，节选）：

```
你需要提炼下面这段内容的**有效信息**，丢弃噪音。

这不是压缩，是提炼。区别在于：
- 压缩会把一大段变成"最终方案：X"
- 提炼必须保留**否决路径**：哪些方案被否定了、为什么被否定

期望的形态：
  否决方案 A：因为 <具体原因>
  ...
  最终方案：<结论>

要求：
1. 每一处否决都要保留理由
2. 保留具体的事实性细节（文件路径、数值、错误信息）
3. 不要保留过程性的试错（同样错误重复 N 次只写一次）
4. 总长度控制在原文的 10%–20%
```

### 2.5 长度阈值（三档）

| 原文长度 | 决策 | 常量 |
| --- | --- | --- |
| ≤ **1,200** 字符 | `keep-original`：原文够短，不总结 | `KEEP_ORIGINAL_THRESHOLD_CHARS` |
| 1,200 – 4,000 | `optional`：由模型自行决定 | — |
| ≥ **4,000** 字符 | `should-summarize`：应提炼 | `SUMMARIZE_THRESHOLD_CHARS` |

循环里**只挑 `should-summarize`**，短区间原样保留。

### 2.6 消息循环（不经过工具调用）

```
第 N 轮 pre-step（插件，{prepend: true} 放最外层）
  │
  ├─ 有 awaiting？
  │    ├─ 有更新的 assistant 消息 → 收割
  │    │    → segments.insert 落库
  │    │    → session.append(surfaceOp: replace) 遮蔽 [fromSeq, max(toSeq, assistantSeq)]
  │    │    → pending.clear
  │    │    → applyArchive 顺带降级
  │    └─ 无更新 → 保持等待（TTL 10 分钟）
  │
  └─ 无 awaiting？
       → computeSpans 找候选
       → 只取 should-summarize 的第一个
       → pending.markAwaiting
       → 注入提示到 decision.messages（插在最后一条已领取消息之后）
```

**注入的技术细节**（照官方 `dsh-agent-instructions`）：

```ts
const prompt = createUserMessage({ content, source: { kind: 'memory-loop-prompt' } })
const lastClaimedIndex = decision.messages.findLastIndex(m => messages.includes(m))
const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, prompt)
return { ...decision, messages: entered }
```

**提示只出现一次**：收割时它连同旧区间一起被 `replace` 遮蔽。

**TTL**：`PENDING_TTL_MS = 10 * 60 * 1000`（10 分钟），超时放弃并记日志。

### 2.7 表面替换（唯一的「让模型不再看到」手段）

```ts
session.append('user/message', data, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: [...被遮蔽的每个节点],   // dsh 强制要求完整列出
})
```

**两条硬约束（实测踩出来的）**：
1. `sourceEventSeqs` 必须**完整列出**每个被遮蔽节点，缺一个抛
   `surface replace: sourceEventSeqs must include every shadowed surface node`
2. `sourceEventSeqs` **不允许重复**，必须 `new Set()` 去重

### 2.8 检索

| 项 | 值 |
| --- | --- |
| 关键词引擎 | SQLite FTS5，`tokenize='unicode61'` |
| CJK 补偿 | 汉字逐字插入空格再索引（`segmentForFts`） |
| 查询构造 | 中文词转 phrase `"待 办"` |
| RRF 合并 | `RRF_K = 60` |
| 默认返回条数 | `DEFAULT_MAX_RESULTS = 8` |
| 正文截断 | `TEXT_SLICE = 4000` 字符 |
| 工具参数截断 | `TOOL_ARGS_SLICE = 500` 字符 |

**思考隔离**：`kind='reasoning'` 的事件**不进 `event_fts`**，只在 `event_text` 与向量通道。

### 2.9 真实运行数据

**索引**（151 个会话文件）：

| 指标 | 值 |
| --- | --- |
| 扫描/索引会话 | 151 / 151 |
| 正文事件 | **89,422** |
| 思考事件 | **21,163** |
| 坏帧 | **0** |
| 解析错误 | **0** |
| 耗时 | **17.4 秒**（约 5,100 事件/秒） |

**库状态**：

| 指标 | 值 |
| --- | --- |
| 有事件的会话 | 141 |
| 事件总数 | **110,585** |
| 其中思考 | 21,163 |
| 其中摘要 | 20 |
| 被压缩遮蔽 | 23,616 |
| 已封存段 | 0（尚未真实使用） |

**搜索性能**：约 **122 ms**（含 Node 启动约 80ms，纯查询约 40ms）。

**spans 真实输出**（某个 65 轮会话，keep=2）：

```
可总结区间：63 个
  turn 1  seq 9–6415    330 条  359897 字符  should-summarize
  turn 2  seq 684–685     2 条    1657 字符  optional
  turn 3  seq 692–705     7 条   14831 字符  should-summarize
  ...
```

### 2.10 对外暴露

| 项 | 数量 | 说明 |
| --- | --- | --- |
| 模型工具 | **1 个**（`memory_search`） | `memory_summarize` / `memory_spans` **已移除** |
| 事件监听器 | **2 个** | `session/event`（只记轮次与最近 assistant）、`agent/pre-step`（循环） |
| 自动索引 | **0** | 只有 CLI `index` 显式触发 |

### 2.11 CLI

```
memory-plugin index    [--sessions <dir>] [--data <dir>] [--session <id>] [--all]
memory-plugin search   "query" [--mode keyword|hybrid] [--limit 20] [--order rank|time] [--json]
memory-plugin status   [--data <dir>]
memory-plugin serve    [--port 7800] [--data <dir>]
memory-plugin spans    --session <id> [--keep 3]
memory-plugin archive  --session <id> --latest N [--keep 3]
```

### 2.12 代码规模

| 模块 | 行数 |
| --- | --- |
| `store/` | 358 |
| `ingest/` | 562 |
| `search/` | 509 |
| `seal/` | 506（apply 134 + lifecycle 69 + spans 185 + store 159 + types 163，已删 tool.ts 207） |
| `loop/` | 213 |
| `dsh-bundle.ts` | 320 |
| `cli.ts` / `api` / `types` / `index` | 580 |
| **合计** | **3252** |

---

## 三、还没做的（对照你的架构）

### 3.1 严重缺口

| # | 缺什么 | 现状 | 影响 |
| --- | --- | --- | --- |
| 1 | **向量检索是空实现** | `NoopVectorStore` 的 `search()` 永远返回 `[]` | 决策「思考只向量化」**等于没实现**——21,163 条思考完全搜不到 |
| 2 | **思考实际上不可检索** | 既不进 FTS，向量又是 Noop | 你的第 11 条决策**当前零收益** |
| 3 | **`live` 阶段的 recent 恒为空** | `tryHarvest` 里 `recent: ''`，永远走 `archived` | **「近几步全量」没有实现**——所有段都只留总结 |
| 4 | **循环未在真实对话中验证** | 单测过了，但没跑过真实模型对话 | 不知道模型会不会按提示输出提炼结果 |

### 3.2 中等缺口

| # | 缺什么 | 现状 |
| --- | --- | --- |
| 5 | 提炼结果与提示的配对靠时间戳 | 模型若跑偏，会把无关回复当提炼结果 |
| 6 | 没有「提炼质量」校验 | 模型可能输出很短的敷衍总结，无检测 |
| 7 | 一次只安排一个区间 | 长会话积压很多区间时，一次只推进一个 |
| 8 | 跨会话检索的语义合并 | 同一话题分散在多个会话时无法聚合 |

### 3.3 轻微缺口

| # | 缺什么 |
| --- | --- |
| 9 | 向量 id 格式已定义但无真实实现 |
| 10 | HTTP API 未做过端到端测试 |
| 11 | 中文分词是字级匹配，rank 质量弱于真分词器 |

---

## 四、最该先做的三件事

按「你的架构里权重最高、当前收益为零」排序：

### ① 让 `live` 阶段真的有 recent（缺口 #3）

现在所有段都是 `archived`，等于**「近几步全量」完全没实现**。

修法：`tryHarvest` 时判断该区间是否仍在近期窗口内——
在窗口内则 `stage: 'live'` 并把原文塞进 `recent`；否则 `archived`。

### ② 接一个真的向量实现（缺口 #1、#2）

21,163 条思考现在完全不可检索。你的决策是「思考只向量化」，
向量是 Noop = 决策落空。

最小实现：SQLite + 本地 embedding（`bge-small` 类），或接一个 OpenAI 兼容端点。

### ③ 真实对话跑一遍循环（缺口 #4）

单测证明逻辑对，但没证明**模型会照做**。需要一次真实会话观察：
- 提示注入后模型是否输出提炼结果
- 收割是否拿到正确内容
- 段是否正确遮蔽旧历史

---

## 五、一句话总结

**编号体系、槽位合并、提炼提示、表面替换、消息循环——这五块的代码都写完了且有测试。**
**但「近几步全量」退化成「全部只有总结」，且「思考只向量化」因向量是空实现而完全没生效。**

这两条是你架构里很核心的部分，现在都是空的。
