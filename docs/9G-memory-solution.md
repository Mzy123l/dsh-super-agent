# 记忆架构完整方案

> 读者：本机用户（懂架构的开发者）。定位：**设计文档，不是调研报告**——已有材料只引用、不重述。
> 证据：`(9B §3.1.7)` 指向 [9B](9B-dsh-source-findings.md) 章节；`[测]` = 本轮对 `~/.dsh` 只读实测（方法见 §5.1）；`[推断]` = 无直接证据的推理，评审时降权。
> 只读声明：全程未修改 `~/.dsh`；分析脚本在仓库 `.tmp/`。

---

## 0. 一页纸摘要

**专题一（上下文传输）**：五种注入源有四种存活语义，没有一个对插件可见的契约（9B §7 缺陷 4）。方案把"存活"从副作用升级为**声明式契约**（`persistence: 're-injected' | 'compactable'`），并给重注入集合**硬预算**（建议 4,000 tokens；业界 200 行–12k 字符）。关键数字：AGENTS.md 两条链各限 65,536 字节（9B §3.4.4），而 system prompt 实测中位仅 2,273 tokens `[测]`——**预算不是不够用，是没有**。

**专题二（压缩）**：当前是"从头上削一块"（9B §7 缺陷 1），17 次成功压缩遮蔽 15,768 节点 / 4,228,403 tokens（98 §4.2）。改为**按重要性选择 + 声明式检查点 + 压缩前钩子落盘**。核心是给 checkpoint 加**压缩声明**（规模、seq 范围、可执行取回命令），并把摘要 prompt 改成"义务清单 + 允许描述缺失"。验收：模型能仅凭上下文回答"我丢了什么、怎么取回"。

**专题三（记忆与检索）**：分四层，按**"是否会被静默删除"**而非抽象层次分。决策层用 `决定 + 否决 + 理由 + 溯源 + supersedes` 的只追加 schema，事实带 `validFrom`/`supersededBy`。关键原则：**系统的最小义务不是猜相关性，是登记存在性**——模型拉不到它不知道存在的东西（对 9C §3.1 的推进）。

**专题四（缓存）**：**实测推翻了本任务的预设**。全库 31,564 次请求命中率 **99.19%**（cacheRead 7,287,527,936 / 总输入 7,347,294,023）`[测]`。193 次断崖中压缩只占 **3.8%** 的未命中 input，大头是 89 次未归因（18.6%）与 45 次新请求序列（12.1%）。**压缩不是缓存杀手**（单次中位重建 34,477 tokens，17 次合计 884,796 ≈ 全库未命中的 1.5%）。真正风险在落地时：若重注入进 node 0 且带每轮变化的字段，命中率从 99.19% 归零，**输入成本放大 123 倍**`[推断，§5.3]`。这是全方案最硬的约束。

---

## 1. 现状与问题

四段式详解见 [9D](9D-memory-architecture-review.md)，此处只留骨架。

| 缺陷 | 一句话 | 专题 |
|---|---|---|
| 压缩按位置剪切 | `selectCompactableRange()` 只跳过 node 0、按 `retainTokens` 留尾、保工具对平衡（9B §7 缺陷 1） | 二 |
| 系统压制自描述 | 指令要求 `Do NOT mention … that the context was compacted`；preamble 要求 `without acknowledging this checkpoint`（9B §5.3） | 二 |
| prune 是无出口黑洞 | 标记不含字符数/路径（9B §7 缺陷 3）；59 次实测全部无回源句柄（98 §6.3） | 二 |
| 五种注入源无契约 | 见 9B §7 缺陷 4 对照表 | 一 |
| 检索三层链路全关 | `openAt: never` + 工具未挂载 + bundle 是 `export {};`（9B §3.3.3） | 三 |
| 工具 schema 恒定开销 | 中位 69 个工具、54,004 JSON 字符 ≈ 13,501 tokens；系统提示仅 ~2,273 `[测]` | 四 |

**与 9D 的两处冲突，按 9B 原始数据更正**：

1. **9D §1.2 把 AGENTS.md 与 goal 列为"系统段"——错。** 9B §3.4.3 有代码证据：AGENTS.md 是**普通 `user/message`**（`source.kind: 'agent-instructions'`），由 `agent/pre-step` splice 插入（`dsh-agent-instructions/lib/index.js:1480-1498`）；9B §3.5.3 同样证明 `goal/change` 是 log-only，模型只看到 `<goal_round>` 这条普通 user 消息。
2. **"schema 恒定 12,139 tokens"不是常数。** 本轮 243 个会话采样中位为 54,004 字符（÷4 = 13,501，÷3.2 = 16,876），工具数中位 69，随 preset 大幅变化。量级一致但不可当常数——直接影响 §5.4。

第二处冲突的成因值得记一笔：9D 转述自 9B，而 9B 在"注入到哪"这点上有过自我修订——**转述链每多一层就丢一次条件**。

---

## 2. 专题一：上下文传输

### 2.1 现状

请求 = `request/header`（config + 工具 schema）+ `Session.deriveMessages()`（surface 投影），**没有 `system` 字段**（9B §1.2）；system prompt 是 surface 节点 0 上的 `system/message`。

| 注入源 | 载体 | 压缩后 | 判定依据 | 插件可声明 |
|---|---|---|---|---|
| system prompt 段 | node 0 | 永不被遮蔽 | `systemHead()`（`dsh-compaction-basic/lib/index.js:415`） | 否（靠 order 表隐式） |
| AGENTS.md | user 消息 | 遮蔽后**自愈** | 只看 surface（`dsh-agent-instructions/lib/index.js:1272-1279`） | 否（写死在该包） |
| runtime context | user 尾部 | 遮蔽后**重注入** | `RuntimeContextProjection`（`dsh-agent-loop/src/runtime-context.ts:125-181`） | 部分（`required` 只控压不压） |
| goal objective | `<goal_round>` | 被遮蔽，**只能 pull** | 9B §3.5.3 / §7 缺陷 8 | 否 |
| 普通历史 | surface 节点 | **永久消失** | 无 | 不适用 |
| 工具 schema | request/header | 永不压缩，也永不可减 | 9B §7 缺陷 4 表末 | 否 |

**结构性问题不是"某个源会丢"，是"新插件作者无法从 API 上知道自己的注入会不会活过压缩"。** AGENTS.md 的自愈是副作用而非契约，且只能判断"在不在"、不能判断"全不全"。目标：契约化（`persistence` 必填）、预算化（超限报错而非静默截断）、可查询、信道可选。

### 2.2 设计

```ts
/** 存活承诺。系统只保证这两个取值。 */
export type Persistence =
  | 're-injected'   // 系统保证：只要 agent 活着，遮蔽后必然重建
  | 'compactable'   // 不保证：允许被遮蔽，重建由提供方自理

/** 走哪条信道。这决定它与 KV cache 的关系（见专题四）。 */
export type InjectionChannel =
  | 'system-section'   // node 0：永不被遮蔽，但一变就断整条前缀。只放几乎不变的文本
  | 'runtime-context'  // 尾部追加：内容不变则不重发，遮蔽后自动重建
  | 'history-message'  // 一次性消息：追在尾部，之后靠"留在历史里"存活

/** 重注入预算。're-injected' 必填。 */
export interface BudgetClaim {
  readonly maxTokens: number                 // 上界，按 4 字符/token 计价
  readonly onExceed?: 'reject' | 'demote'    // 默认 reject；demote = 降级为指针
}

/** 一次注入的完整声明。注册时提交，此后不可变。 */
export interface MemoryContribution {
  readonly name: string
  readonly persistence: Persistence
  readonly channel: InjectionChannel
  /**
   * 纯函数契约：相同输入必须产出逐字节相同的字符串——这是 KV cache 的前提（§5.3.3）。
   * 禁止读 Date.now()、随机数、每轮变化的计数器。
   */
  readonly render: (context: RenderContext) => string
  readonly budget?: BudgetClaim              // persistence='re-injected' 时必填
}
```

```ts
export interface Guarantee {
  readonly survives: boolean                  // 压缩后是否仍在
  readonly rebuiltAfterCompaction: boolean     // 遮蔽后是否自动重建
  readonly breaksPrefix: boolean | 'partial'   // 是否可能打断 KV 前缀
}

/** 系统对每个 (persistence, channel) 组合的承诺。插件在 apply() 时断言。 */
export type GuaranteeTable = Readonly<Record<Persistence, Readonly<Record<InjectionChannel, Guarantee>>>>
```

| `persistence × channel` | `survives` | `rebuiltAfterCompaction` | `breaksPrefix` |
|---|---|---|---|
| `re-injected × system-section` | 是 | 否（本来就不会被遮蔽） | 是（整条前缀） |
| `re-injected × runtime-context` | 是 | **是**（最常用组合） | 否 |
| `re-injected × history-message` | 是 | 是 | `partial` |
| `compactable × system-section` | 是 | 否 | 是 |
| `compactable × runtime-context` | **否** | 否 | 否 |
| `compactable × history-message` | **否** | 否 | 否 |

**这张导出的表是专题一的核心产出**：它把 9B §7 缺陷 4 的"四种语义、无契约"变成"六格矩阵、可断言"。断言失败就抛错，而不是运行三天后才发现记忆被压没了。

**硬预算**。业界区间（9C §4.1）：Claude Code 单文件 <200 行 / 索引 200 行或 25KB；Cursor <500 行；Windsurf 硬限 12,000 字符。本机 system prompt 中位 2,273 tokens `[测]`——问题是没额度概念，不是额度不足。

| 项 | 值 | 理由 |
|---|---|---|
| 总预算 | **4,000 tokens** | 约为当前 system prompt 中位的 1.76 倍；远小于 schema 的 13,501，不喧宾夺主 |
| 单条目 | 800 tokens | 12 条指针或 3-5 条决策摘要的量级 |
| 计价 | 4 字符/token | 对齐 `dsh-token-meter/lib/types/estimate.ts:9`。**对中文低估 3-4 倍**（9B §7 缺陷 6），中文条目按实测再打 3 折 |
| 超预算 | **拒绝注册 + 报错并指名** | 抄 AGENTS.md 的 `Workspace instruction budget ...`（9B §5.4）。宁可启动失败，不可静默截断 |

```ts
export interface LivenessReport {
  readonly name: string
  readonly present: boolean
  readonly renderedHash: string      // 渲染内容 sha256，用于判断"全不全"
  readonly surfaceHash?: string      // surface 上那一份；不一致 = 内容残缺
  readonly rebuildScheduled: boolean
}

export interface MemoryRegistry {
  register(contribution: MemoryContribution): () => void
  /** 用日志而非 surface.nodes 判定，修掉 9B §7 缺陷 4 的第 3 条批评。 */
  liveness(name: string): LivenessReport
  usage(): { claimed: number; rendered: number; limit: number }
}
```

`renderedHash` 比 `present` 重要：`visibleBaselineSource()` 找到任何一条 `baseline: true` 就认为"还在"，发现不了内容残缺。哈希把"在不在"升级为"全不全"，成本只是一个 sha256。

### 2.3 验收标准

| # | 标准 | 判定 |
|---|---|---|
| A1 | `re-injected` 条目被遮蔽后**下一个 pre-step 内**重建 | 手动 `/compact` 遮蔽它，查新注入事件 |
| A2 | 重注入内容**未变化时逐字节不变** | 连续 200 步抓取，sha256 全等 |
| A3 | 超预算**拒绝启动并指名** | 注册 5,000 tokens 条目，错误须含条目名 |
| A4 | `liveness()` 检出"被遮蔽"与"内容残缺" | 分别构造整体遮蔽、部分遮蔽（只压掉链的一半） |
| A5 | `GuaranteeTable` 六格与实际一致 | 六格各一条集成测试；`compactable × runtime-context` 须实测确认**不重建** |
| A6 | 中文条目预算误差 ≤ 30% | 对比声明值与提供方回报的实际 input 增量 |

---

## 3. 专题二：压缩机制

### 3.1 现状

触发：`thresholdTokens = floor(min(W × 0.8, W − O − 65536))`（`dsh-compaction-basic/lib/index.js:130-134`），4 次自动触发实测落在阈值的 99.77%–99.98%（98 §2.3）。范围：跳过 node 0、从尾向前保留 `retainTokens = 0.16 × (W − O)`、再退到工具对平衡点。

三个问题：**不看重要性**（第 1 轮的用户硬约束与 grep 噪音等价）、**替换而非追加**（永远 `surfaceOp: replace`；而 system prompt 在 `in-history` 路由有 append 通道——最重要与最不重要的东西待遇相反）、**自描述被主动压制**（17/17 有 preamble，0/17 有量化）。目标：范围由重要性决定、检查点自带声明、压缩前先落盘决策、摘要 prompt 允许描述缺失。

### 3.2 设计

#### 3.2.1 重要性选择（确定性启发式，不引入模型打分）

```ts
/** 压缩候选节点的保留分。纯函数，可单测。 */
export function retentionScore(node: SurfaceNode, ctx: ScoringContext): number {
  let score = 0
  // 1) 来源权重：用户原话是唯一不能从别处重建的信息源
  if (node.source.kind === 'user') score += 40
  else if (node.type === 'assistant/message') score += 10
  // 2) 约束关键词：出现一次就近乎永久条款
  if (/\b(must|never|always|only|do not|don't|禁止|必须|不要|只能|务必|绝不)\b/i.test(node.text)) score += 30
  // 3) 被后续引用：路径、callId、决策 id 被后来的消息提到过
  score += Math.min(25, 5 * (ctx.referenced.get(node.seq)?.size ?? 0))
  // 4) 可重建性：带 path/url 的工具结果压掉后代价低（98 §6.3 的 meta 字段）
  if (node.type === 'tool/result' && ctx.rebuildable(node)) score -= 20
  // 5) 冗余：与更早内容 n-gram 高度重合，压掉近乎无损
  if (ctx.maxSimilarity(node) > 0.8) score -= 15
  // 6) 已在决策层落盘：信息不会丢，可以更激进
  if (ctx.decisionised(node.seq)) score -= 30
  return score
}
```

保留集合 = 尾部 `retainTokens` 内节点 ∪ 分数最高的 K 个，`K = max(0, floor((shadowTarget − retainTokens) / avgNodeTokens))`。

**边界**：重要性选择会制造散点，而 `surfaceOp: replace` 只接受连续 `startSeq`/`endSeq`。所以落地必须**多段连续区间**：先按分数聚类成连续段，逐段调 `compactRegion`（签名见 `dsh-compaction/src/index.ts:187`）。不接受"任意散点"——那要改投影层，而投影层不在稳定 seam 上（9B §6.3）。

#### 3.2.2 压缩声明（精确格式）

写进 checkpoint 正文，位于 `<compacted-summary>` **之前**（模型先读"少了什么"，再读摘要）：

```
[compaction-declaration]
id: cmp-2026-11-13T14:22:07Z-07
index: 7 of this session
shadowed: 2143 surface nodes, 479142 route tokens
seq-range: 1000..3143 (surface position 10..5643)
released-net: 467128 tokens (summary 12014 tokens)
prior-checkpoint: cmp-...-06 (merged, not copied)
retrieval: session_event_read --session <id> --seq 1000 --limit 50
           session_search --query "<关键词>" --scope session
note: 本段原文仍在会话日志中；本声明是索引，不是内容。
[/compaction-declaration]
```

| 字段 | 为什么必须有 | 依据 |
|---|---|---|
| `id` + `index` | 模型要知道"第几次压缩"；累积损耗是串行的 | 9B §5.2（当前完全没有） |
| `shadowed` 双计数 | "2143 个事件"与"479142 tokens"是两种量级感 | 98 §4.2 两者都有 |
| `seq-range` | 唯一能让模型精确取回的句柄 | 9B §4.2 B1 |
| `released-net` | 让模型判断还剩多少余量 | 9B §5.2（当前无预算感知） |
| `retrieval` | **必须可直接执行，不是能力描述** | 9C §4.6：指针而非忏悔 |
| `note` | 明确"声明是索引不是内容"，防模型当摘要复述 | 9C §3.4 |

格式纪律：用方括号而非 XML 尖括号（避免与 `<compacted-summary>` 嵌套歧义）；一律 `key: value` 单行，不用 Markdown 列表（列表会被摘要模型当待合并内容重写）。

#### 3.2.3 压缩前钩子

```ts
export interface CompactSpan {
  readonly startSeq: number
  readonly endSeq: number
  readonly nodes: readonly SurfaceNode[]
  readonly scores: ReadonlyMap<number, number>   // 已算好的保留分
}

/** 压缩前先跑：把即将遮蔽区段里的决策抽成结构化条目落盘。 */
export interface PreCompactionHook {
  /**
   * 在 selectCompactableRange 之后、summarize 之前调用。
   * 条目先写入记忆层（专题三），再允许压缩提交。
   * 钩子失败时压缩仍可继续，但必须在 checkpoint 声明里记 note。
   */
  extractDecisions(span: CompactSpan, ctx: ExtractContext): Promise<DecisionRecord[]>
}
```

**顺序不能反**：先落盘决策、再提交压缩。与 [52-file-warden.md](52-file-warden.md) §3.2 的"先记后做"同构——崩溃在"记完未压"最坏是多一份可去重的条目，崩溃在"压完未记"则决策永久消失。**只追加的层可以容忍重复，不能容忍缺失。**

#### 3.2.4 改进后的摘要 prompt（完整草案，可整体替换）

替换 `dsh-compaction-basic/src/summarizer.ts` 的 `COMPACTION_INSTRUCTION`。**保留"追加在回放历史之后的最后一条 user 消息"这一形态**——那是为复用 KV cache，是 9B §3.1.4 说过的正确设计，不要动。

```markdown
You are condensing the conversation ABOVE into a checkpoint that lets another model resume this work.
The condensed span has been REMOVED from the other model's context. Your output is the only surviving
trace of it, plus a machine-readable declaration telling the next model what was removed and how to
fetch it back. Output the declaration block first, then the structure. Keep every section, in order.
Use terse bullets. Write "(none)" for an empty section — never drop a section.

## 1. Obligations
Every explicit instruction, constraint, or prohibition the user stated, verbatim where wording matters.
One bullet per obligation. Number them. This list is the highest-value part of the output: the next
model must be able to check compliance item by item. Do not merge two obligations into one bullet.
Do not paraphrase an obligation — quote it.

## 2. Decisions and Rejections
- DECIDED: <what> — because <why> — evidence <seq/file/command>
- REJECTED: <what was considered> — because <why>
Record rejected options explicitly. A future model repeating a rejected path is a real regression, and
only this list prevents it.

## 3. Files and Code
- <exact path>: <why it matters; exact symbol/signature if it was changed>

## 4. Errors and Fixes
- <exact error string>: <root cause> -> <fix> — <whether verified>

## 5. State at Checkpoint
What was in progress, what was verified, and what was assumed but NOT verified. Mark unverified claims
as (unverified). The next model must not inherit an assumption as if it were a finding.

## 6. Pending Work
Explicitly requested work not yet completed. Include the request's original wording.

## 7. Next Action

## 8. What Was Removed (required, even if approximate)
State plainly: how many turns/steps this span covered, which topics are now only represented by this
summary, and which topics you are LEAST confident about. This section exists so the next model can
calibrate its own uncertainty. Being honest here is more valuable than being concise.

Rules:
- Write concise engineering prose. Preserve exact file paths, commands, error strings, identifiers,
  numeric values, function signatures, and syntax fragments.
- Capture user feedback and corrections faithfully. A user correction is a permanent constraint, not a
  one-off remark.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Preserve
  still-true facts, and drop only what a later message explicitly contradicts. CARRY FORWARD every
  still-true obligation from section 1 — obligations do not expire by being summarised twice.
- Output only the checkpoint text: do not call any tool or take any other action.
```

| 改动 | 理由 |
|---|---|
| 新增 §1 Obligations（逐条、编号、禁转述） | 9C §3.2 白盒 context rot：逐条列出 24 项义务通过 10/10，"自查所有约束"通过 5/10。**摘要丢的从来不是整体，是零星条款** |
| 新增 §2 否决项 | 旧 8 小节里 `Rejected` 没有位置。只有"决定了"没有"否决了"，模型会重走死路 |
| §5 强制标 `(unverified)` | 9A 的教训：模型会把"机制存在"当"已发生"（9A §6.2） |
| §8 改为诚实描述缺失 | **删掉 `Do NOT mention … that the context was compacted`**（9B §5.3），改为允许且要求描述 |
| 改掉 "drop stale ones" | **"stale" 由摘要模型单方判定，而它没有判断依据**。实测摘要输出仅 2,333–4,348 tokens、压缩率 >99%（98 §5.2）；这个压缩比下"drop stale"等于"按叙事需要剪裁"。改为保留判定权 + 客观判据（只有后续消息明确否定的才丢） |
| preamble 删 `without acknowledging this checkpoint` | 保留"当作既定背景"，删掉沉默要求。模型可以承认"这段我只有摘要"，这是校准能力的前提 |

### 3.3 验收标准

| # | 标准 | 判定 |
|---|---|---|
| B1 | 每次 checkpoint 都含合法声明 | 正则 + 字段完整性；17/17 次历史重放全过 |
| B2 | `retrieval` 命令**实际可执行且能取回原文** | 解析声明 → 执行 → 比对日志原文 |
| B3 | 决策抽取召回率 ≥ 80% | 人工标注 3 个真实会话的决策点，跑钩子比对 |
| B4 | 新 prompt 在义务保持上优于旧版 | A/B：同段历史用新旧 prompt 摘要，再用"24 项义务清单"测下游通过率。**本方案唯一必须实证的验收项——9C §3.2 明说没有现成对照实验** |
| B5 | 重要性选择不破坏投影合法性 | 每段 `compactRegion` 后 `toolPairingBalanced*` 须为 true |
| B6 | 压缩率不低于旧版 | 新旧输出 token 对比；允许新版略长（多出的就是义务清单的价值） |

---

## 4. 专题三：记忆记录及检索

### 4.1 现状

原子能力存在但全关：`ctx.sessionQuery` 有 `readSurface`/`readEvent`/`traceEvent`（9B §3.3.1），但 `session-query-sqlite` 配 `openAt: never`、工具未挂载、bundle 是 `export {};`（9B §3.3.3）。检索纯 pull、无自动浮现；无语义检索、无衰减、无长期记忆子系统（9B §9 三处"未找到"）。原始层完好：252 个会话、22 万条以上记录条条可解压。**数据没丢，出口关着。**

### 4.2 分层

按**"是否会被静默删除"**分，而不是按抽象层次分：

| 层 | 存什么 | 会被静默删吗 | 载体 |
|---|---|---|---|
| **L0 原始事件** | 全部 `SessionEvent` | **绝不**（只追加、无删除接口，9B §7 缺陷 12） | `session.v4.jsonl.zstd` |
| **L1 决策记录** | 决定/否决/理由/溯源 | **绝不**（同一日志，新事件类型） | 同上 |
| **L2 常驻条目** | 重注入池里的不变量 | **会**，但系统保证重建（专题一契约） | system prompt / runtime context |
| **L3 指针索引** | 主题 → 句柄 | **会**（随 checkpoint 被下次压缩合并） | checkpoint 消息 |

依据 9C §3.6：存储层从不遗忘、工作集上主动遗忘。L0/L1 是存储层，L2/L3 是工作集。这个二分比"短期/长期/语义/情景"更可操作——**它直接对应"会不会某天早上突然不见了"**。

### 4.3 设计

#### 4.3.1 决策层 schema

```ts
/** 一条决策记录。只追加；变更通过 supersedes 表达，绝不就地改写。 */
export interface DecisionRecord {
  readonly id: string                // dec-<uuid>
  readonly at: string                // ISO 8601，写入时刻
  readonly subject: string           // 决定了什么。一句话，不写过程
  readonly decision: string
  /** 被否决的备选。本 schema 里最重要、也最常被省略的字段。 */
  readonly rejected: readonly RejectedAlternative[]
  /** 理由。允许写未验证的假设，但必须与已验证事实分开。 */
  readonly rationale: string
  /** 溯源。空数组表示"用户直接说的"。 */
  readonly provenance: readonly Provenance[]
  readonly supersedes?: readonly string[]   // 取代了哪些旧记录；旧记录不删，只被标记
  readonly validFrom: string                // 事实生效时间，与 at（写入时间）区分
  readonly supersededBy?: string            // 由后继记录写入时回填镜像事件
  readonly validTo?: string                 // 事实失效时间。仍有效则空
  readonly confidence: 'observed' | 'inferred'  // 对 9A 教训的 schema 化
}

export interface RejectedAlternative {
  readonly option: string
  readonly because: string    // 否决理由。空字符串视为 schema 违规
}

export interface Provenance {
  readonly kind: 'session-seq' | 'file' | 'tool-call' | 'user-message' | 'external'
  readonly ref: string            // seq 号 / 路径 / callId / URL
  readonly stillValid?: boolean    // 读到时该引用是否仍有效
}
```

- **`rejected`**：现有系统（及多数记忆方案）只记"决定了什么"。但重走被否决的路是长跑 agent 最贵也最常见的错误——**因为它看起来像新想法**（9C §5 第 6 条讲的是同一件事的另一面）。
- **`validFrom`/`supersededBy`/`validTo`**：抄 Zep 双时态但只做单时态（9C §4.4："至少做单时态，成本近似为零"）。冲突时新建一条并关闭旧的，不就地改写，于是"截至 T 时刻我们认为什么为真"就有了。
- **`confidence`**：来自 9A 的可靠性边界——可核对的事实陈述接近 100% 准确，归属与因果判断系统性失准（9A §7.3）。**必须在 schema 里，因为事后补不上。**

#### 4.3.2 检索：为什么 pull 不够，指针怎么进上下文

**核心论证**：检索的前提是"我知道该检索"，而遗忘恰好摧毁这个前提——忘了某条约束，就不会去搜"为什么当初这么定"，因为它以为自己知道（9D §3 提出，本文补推论）：

> **系统的最小义务不是"猜相关性"，是"登记存在性"。**

9C §3.1 的结论是"检索必须由模型发起，系统替它猜相关性几乎总猜错"。这容易被误读成"系统什么都不该做"——**是误读**。9C §5 第 5 条就是反例：Cursor 的 `@file` 只是指针不内联，若 Agent 没去读，"必须始终生效"的约束事实上不存在。边界：

| 判断 | 谁做 | 机制 | 失败模式 |
|---|---|---|---|
| 这条**存在** | **系统** | L3 指针索引 | 不登记 → 模型永远拉不到 |
| 这条**现在相关** | 模型 | `/memory`、`session_search` | 系统猜错 → 无信号地污染上下文 |
| 这条**必须遵守** | 系统 | L2 常驻（重注入） | 违反一次就出事 |

```ts
/** L3：常驻上下文的索引条目。极短，只回答"有什么、在哪、值不值得拉"。 */
export interface MemoryPointer {
  readonly topic: string          // 一句话。模型据此判断相关性——它唯一能判断的东西
  readonly count: number
  readonly latestId: string       // 用于判断新旧
  readonly latestAt: string
  readonly pull: string           // 可直接执行的取回命令，不是能力描述
}
```

| 项 | 值 | 依据 |
|---|---|---|
| 指针区总预算 | **800 tokens** | 约 12-16 条；占 4,000 重注入预算的 20% |
| 单条上限 | 60 tokens | 超了说明 `topic` 太啰嗦或该合并 |
| 排序 | `latestAt` 降序 + 固定上限 | 时间是最便宜的相关性代理（9C §4.7） |
| 超限 | 最旧降级为一行统计（`其他 37 个主题，用 /memory list 查看`） | 保留"存在性"这个最小信息，丢细节 |

**指针不是摘要。** 指针的每行都应让模型做出"要不要拉"的二元决策；摘要的作用是让模型"以为它知道"。混用两者，就是当前 checkpoint 的问题。

#### 4.3.3 打开三条被关闭的链路

| 层 | 现状 | 动作 | 代价 |
|---|---|---|---|
| 服务层 `ctx.sessionQuery` | 已挂载但 `openAt: never` / 内存库 | 改 `openAt: 'first-search'` + 持久路径 | 一个 SQLite 文件 |
| 工具层 `dsh-tool-session-query` | 未挂载 | 挂载 | 5 个工具 + 固定指引，**会增加 schema tokens** |
| bundle `dsh-experimental-session-search` | `export {};` | 它是壳，直接用前两项 | 0 |

**风险**：挂全套会把工具从 69 推到 74，按 §5.4 约增 1,800-2,500 tokens 的每请求恒定成本。**建议默认只挂 `session_event_read` 一个**，其余按 preset 可选。

#### 4.3.4 只追加 + 事实带有效期

1. **L0/L1 永不删除。** 唯一例外是一致性删除通道（被遗忘权），必须显式触发并留痕。9C §3.3：业界做法是"默认只追加 + 显式真删通道"，没有一家做"永不删除且不可删"。
2. **决策冲突时新建 + 关闭旧的。** `supersededBy` 写入时向旧记录追加镜像事件（`memory/superseded`），而非改写旧事件。**日志不可变性与"事实可失效"靠追加事件解决，不靠改写。**
3. **过期不等于删除。** 过了 `validTo` 的事实仍可检索，只是在读取时带时间标记返回，格式抄 Zep：`FACT (valid 2026-09-01 .. 2026-11-01): ...`（9C §4.4）。

### 4.4 验收标准

| # | 标准 | 判定 |
|---|---|---|
| C1 | `rejected`/`provenance`/`confidence` 合法 | schema 100% 通过；`rejected: []` 须在 `rationale` 说明 |
| C2 | 任一决策可回答"凭什么这么说" | 给定 `id`，3 步内追到原始 seq/文件/用户消息 |
| C3 | 事实失效后可回答"什么时候变的" | 构造一次 supersede，查询返回两版本 + 切换时间 |
| C4 | 指针区 ≤ 800 tokens 且**每条可执行** | 解析每条 `pull` 并试运行，全部成功 |
| C5 | 模型能凭指针找到被遮蔽原文 | 端到端：压缩后问一个只在被遮蔽区的事实，应取回并答对；无指针基线应失败 |
| C6 | `session_event_read` 可用且带授权边界 | 跨会话读取必须被拒或需显式授权（9B §6.3："模型工具层必须自己做授权"） |
| C7 | 挂载后每请求 schema 增量 ≤ 2,500 tokens | 对比挂载前后 `request/header` JSON 体积 |

---

## 5. 专题四：缓存命中

### 5.1 实测方法与总账

逐帧解压 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（拼接 zstd 帧，magic `0xFD2FB528`），提取全部 `assistant/message.data.usage`。252 文件、228 个含 usage、**31,564 次请求**。

| 指标 | 值 |
|---|---|
| 未命中 input 合计 | 59,766,087 |
| 命中 cacheRead 合计 | 7,287,527,936 |
| **命中率** | **99.19%** |
| 平均每请求 prompt | 232,774 tokens |
| cacheWrite | 0（本机所有路由都不回报写缓存） |

交叉验证：`input + cacheRead + cacheWrite + output = totalTokens` 在全部样本成立，与 98 §2.1 的等式一致。关键细节：**cacheRead 值 100% 是 64 的整数倍** `[测]`——上游按 64-token 块计价与复用，**小于一个块的扰动不产生成本**，这决定 §5.3.3 的要求能否放宽（见 §8 Q2）。

### 5.2 断崖归因（本专题最重要的新发现）

定义"断崖"：`cacheRead` 相对同会话上一次下降超 10%，且上一次 >10,000。全库 **193 次**。

| 归因 | 次数 | 该次 input 合计 | 占全部未命中 |
|---|---:|---:|---:|
| **未归因（无压缩/无切模型/无重试）** | 89 | 11,109,736 | **18.6%** |
| 新请求序列（`turn/start` + system 节点重写） | 45 | 7,228,886 | 12.1% |
| 模型切换（`model/selection`） | 13 | 3,940,832 | 6.6% |
| 重试（`llm/retry`） | 19 | 2,907,027 | 4.9% |
| **压缩（`compaction/*`）** | 22 | 2,280,565 | **3.8%** |
| system prompt 重写 node 0 | 5 | 1,221,242 | 2.0% |
| **合计** | 193 | **28,688,288** | **48.0%** |

**结论一：压缩不是缓存的主要杀手，代价只有 3.8%。** 这修正了本任务的预设。9B §3.1.7 的判断"每次压缩都必然打断 KV cache 前缀"——**成立**（见下），但"必然打断"不等于"代价很大"。

**验证 9B 的论断**：压缩后第一条请求的 `cacheRead` 均值只有 **16,768**（此前在 50-70 万量级），input 均值 35,969：

```
9ecf6@5672 (遮蔽479142) -> input 3989  / cacheRead 24704    2e27b@11755 (405642) -> 4897 / 15360
c8dfb@3633 (遮蔽400389) -> input 150202/ cacheRead 13952    6cb9@4368  (207980) -> 285113 / 15360
```

**cacheRead 从 ~66 万掉到 1.5-2.5 万，正是"从第一个被遮蔽 token 起失效"的教科书形状**——保留下来的尾部（`0.16 × (W−O)`）恰好对应那 1.5-2.5 万。9B 的结论被实测确认。

**结论二：压缩净收益仍然很大。** 17 次压缩遮蔽 4,228,403 tokens（98 §4.2），代价是 15 请求窗口内约 884,796 的重建（中位 34,477）。**88 万换 423 万，1:4.8。** "怕断缓存而不敢压缩"在数据上是错的。

**结论三：48% 的未命中集中在断崖上，最大单项是"未归因"。** 先怀疑 TTL 过期，时间戳否定了它：未归因断崖的相邻请求间隔**中位 0.18 分钟，86/89 在 1 分钟内** `[测]`。48/193 的窗口内有辅助调用（`session/title-llm-request` 24 次、`plugin:translator/request` 5 次、`team/mode` 3 次），其余 145 次找不到原因——**这 145 次我没有解释**（可能是上游驱逐策略不可见、会话恢复后的进程内状态重置、辅助调用与 20 事件窗口错位、`dsh_hydration` 类字段变化）。**这是明确的开放问题（§8 Q1），不假装已解决。**

### 5.3 前缀由什么决定，以及核心矛盾

#### 5.3.1 前缀构成（顺序即代价）

依据 `dsh-system-prompt/src/index.ts:136-186` 的 `SECTION_ORDERS`/`CONTEXT_ORDERS`，前缀顺序为：**模型路由 → 工具 schema 集合与顺序 → system prompt 渲染文本（node 0，段按 order 升序）→ 已遮蔽区间之前的全部历史 → 尾部（保留历史、runtime context、新用户消息）**。

**1-4 必须逐字节一致**（`dsh-agent-loop/README.zh.md` KV Cache 段："前缀复用要求在同一提供方与模型路由下，此前消息和声明保持逐字节一致"）。任一项变化，**从第一个变化的 token 起**失效。

dsh 已有的三项正确做法（原样保留）：易变内容放尾部；`in-history` 路由下提示词变更**追加**而非替换 node 0（`runtime-context.ts:106-113`）；内容不变就不重发（`deepEqualJson`，`:167`，全系统唯一的去重注入通道）。

#### 5.3.2 核心矛盾：重注入要稳定前缀，动态注入必然破坏

**当前实测的前缀稳定性**（比我预期好）：`system/message` 事件 266 个 / 31,710 次请求 = **0.839%**（node 0 每 119 次请求才变一次）；改过 node 0 的会话 18/228 = **7.9%**（绝大多数会话全程只有一个 system 节点）。

**落地时的风险**：若按专题一的字面含义实现"每轮把带时间戳的记忆条目重注入 system prompt"（形如 `text: () => entries.map(e => \`- [${e.at}] ${e.title}\`).join('\n')`），时间戳每轮都变，node 0 每轮重写：

| | 现在 | 错误实现 |
|---|---|---|
| 命中率 | 99.19% | **0%** |
| 总输入 tokens | 7,347,294,023（含 7.29G 命中） | 全部按未命中计 |
| 输入成本倍数 | 1× | **≈123×**（7,347M / 59.77M） |

这个 123 倍是**破坏前缀的代价上界**，也是本方案最硬的约束：**任何进入 node 0 的内容，必须在会话生命周期内逐字节不变。**

**正确实现：按"变化频率"分三级**（思路见 [60-model-cost.md](60-model-cost.md) §2.1，此处约束到记忆方案）：

| 级别 | 内容 | 信道 | 变化频率 | 断前缀代价 |
|---|---|---|---|---|
| **冷** | 身份、人设、工具指引、不变量清单 | node 0 | 部署时定，会话内不变 | 高（断全前缀），实际仅 0.839% |
| **温** | 记忆指针、重注入的决策条目 | runtime context 尾部 | 内容变才发 | 低（只断尾部） |
| **热** | 本轮工具结果、新消息 | surface append | 每步 | 零（append 天然保留前缀） |

**关键决定：指针与重注入条目必须走"温"信道。** 理由是实测的：挂检索工具已要付 1,800-2,500 tokens 的恒定 schema 成本（§4.3.3），不能再让记忆内容去动 node 0 把这个成本按 119 倍放大。

#### 5.3.3 byte-identical 的实现约束

```ts
/** 渲染结果 + 哈希。只有哈希变了才允许提交为新注入。 */
export interface StableRender { readonly text: string; readonly hash: string }

/** 提交前断言：与上次已提交哈希不同才走注入路径。 */
export interface InjectionGate {
  shouldInject(next: StableRender): boolean   // false = 内容未变，跳过
  commit(next: StableRender): void            // 记录已提交哈希
}
```

三条硬纪律：**① 禁止在渲染函数里读 `Date.now()`/随机数/step 计数器**——需要时间就取日期（`2026-11-13`）而非时刻，粒度粗到一个会话内不变；依据是 `RuntimeContextProjection` 用 `deepEqualJson` 整体比对，任何字节差异都会触发注入。**② 条目集合按 `id` 或 `createdAt` 稳定排序**，不能按 Map 迭代顺序（跨进程恢复后不保证一致）。**③ 不要为"看起来新鲜"加时间戳**——时间戳的价值是让模型判断新旧（9C §4.7），但它可以在**指针层**（温信道）提供，不必在 node 0。

### 5.4 工具 schema 的恒定开销治理

实测 `[测]`：243 个会话的 `request/header.tools` 中位 **54,004 JSON 字符、69 个工具**（÷4 = 13,501 tokens，÷3.2 ≈ 16,876）。对照 system prompt 中位 2,273 tokens，**schema 是系统提示的 6 倍**。这笔开销每请求重复，而且**压缩救不了它**：`dsh-compaction/README.zh.md` 明写"压缩缩减派生历史，绝不缩减系统提示词、工具或会话前缀"。

| # | 方案 | 省多少 | 代价 | 依据 |
|---|---|---|---|---|
| 1 | **按 preset 分档工具集** | 高（实测区间 14,904→54,004 字符，档位差异巨大） | 需维护 preset 与任务映射 | `ctx.tools.restrict()` 已支持 |
| 2 | **重工具用 `deferLoading`** | 中 | 模型要先"加载"，多一轮 | `dsh-system-prompt/src/index.ts:116` 已有该字段 |
| 3 | **描述瘦身** | 低但稳 | 无 | 描述文本是 schema 大头 |
| 4 | **不挂 `tool-session-query` 全套** | —— | 见 §4.3.3 | 本方案自绑的约束 |

**风险**：工具集变动会断前缀（`dsh-system-prompt/README.zh.md`："注册、限制或重排序可能从第一个变化的 schema token 起使复用失效"）。所以分档必须在**会话创建时绑定**，不能中途切换——与 60 §2.1 的"三样东西创建时绑定"一致。

### 5.5 压缩的缓存失效代价（量化）

| 口径 | 数值 | 说明 |
|---|---|---|
| **单次即时代价** | 首请求 input 均值 **35,969**（会话正常基线中位 232-848），≈ 50-120 倍 | 17 次首请求 input 从 182 到 285,113，方差极大 |
| **单次 15 请求窗口代价** | 中位 **34,477**，17 次合计 **884,796** | 含首请求与后续逐步重建 |
| **占全部未命中** | 884,796 / 59,766,087 = **1.5%** | 压缩的缓存成本占比极小 |

**方差为何这么大**：`69cd6cb9-1aba` 那次首请求 285,113，而 `session-2e27b` 的 8 次都在 5,000 左右。差别在**保留尾部规模**——`retainTokens = 0.16 × (W − O)`，W=1,048,576 时保留约 12.7 万 tokens，全部按未命中重付一次。

**结论**：代价与保留尾部成正比，由 `retainRatio` 决定。默认 0.16 意味着**每次压缩重付 16% 窗口**——可接受（换来释放 84%），但可调。建议把 `compaction-basic.config.retainRatio` 调到 **0.12**（单次压缩少付 25% 重建）；`thresholdRatio` 保持 0.8 不动——98 §7.3 已论证"要更保守应下调 `thresholdRatio` 而非 `headroomTokens`"，而本方案实测显示压缩代价不高，不需要更保守。

### 5.6 验收标准

| # | 标准 | 判定 |
|---|---|---|
| D1 | **命中率不低于基线 99.19%，波动 ≤ 0.5 个百分点** | 灰度期逐日对比 `cacheRead/(input+cacheRead)`；本方案唯一的硬回归闸门 |
| D2 | 重注入条目**连续 200 步字节不变** | sha256 序列全等（与 A2 共用同一测试） |
| D3 | 进入 node 0 的内容在会话内**零变更** | 断言 `system/message` 的 replace 事件数 ≤ 1 |
| D4 | 单次压缩重建代价 ≤ 保留尾部 tokens × 1.2 | 由 `retainRatio` 反推上界，逐次核对 |
| D5 | 工具 schema 恒定成本下降 ≥ 30% | 对比改造前后 `request/header.tools` 中位 JSON 体积 |
| D6 | **没有新增"未归因断崖"** | 归因脚本每周跑；未归因占比不得从 18.6% 上升 |

---

## 6. 四专题如何协同

四专题不是四个独立模块，它们互相拉扯。三处真实冲突及裁决：

**冲突一：专题一要"每轮在场"，专题四要"每轮不变"。** 依据是实测：node 0 重写频率已只有 0.839%，一旦日更就变 100%，成本放大 123 倍（§5.3.2）。**裁决：重注入一律走 runtime context（温信道），只有"永不变的不变量清单"允许进 node 0，且必须在会话创建时定型。** 代价是温信道的重注入内容**仍会被压缩遮蔽**——它靠 `RuntimeContextProjection` 的自动重建搬回来（`runtime-context.ts:145-154`），不是靠不被遮蔽。**"保证在场"和"不被遮蔽"是两件事，本方案只要前者。**

**冲突二：专题二的重要性选择制造不连续区间，专题三的指针需要连续 seq 范围。** `surfaceOp: replace` 只接受 `startSeq`/`endSeq`，而重要性选择天然散点。**裁决：先聚类成连续段，逐段调一次 `compactRegion`，每段声明合并成一份 `[compaction-declaration]`。** 不接受"任意散点"——那要改投影层，而投影层不在稳定 seam 上（9B §6.3）。

**冲突三：专题三要打开检索，专题四说检索工具本身有恒定成本。** 全套挂载约 1,800-2,500 tokens/请求。**裁决：默认只挂 `session_event_read`（一个工具、一个明确用途：读被遮蔽的事件），其余按 preset 可选。** 与 AGENTS.md 的"必须跨压缩存活就下沉为指针"同一思路：**能力要有，但不能无差别地每轮付费。**

**一致性论证：四条不变量。** 只要同时满足下面四条就不互相拆台，应写进任何实现 PR 的检查清单。

| # | 不变量 | 一句话检验 | 边界 |
|---|---|---|---|
| **I1** | 不可重建的东西不进可压信道。唯一不可重建的是 L0/L1。 | 这信息若被压掉，能重建吗？能 → 可压信道；不能 → L0/L1 | 一 × 二 |
| **I2** | 进入 node 0 的内容在会话内逐字节不变。 | 这段文本下个月会变吗？会 → 不进 node 0 | 一 × 四 |
| **I3** | 删除只发生在视图，不发生在基底。 | 这操作崩溃后能重算吗？不能 → 它在改基底，停下 | 二 × 三 |
| **I4** | 任何丢失都留**可执行的指针**，不留**陈述性的忏悔**。 | 模型拿到这句能执行一个动作吗？不能 → 它是指针的反面 | 二 × 三 |

---

## 7. 实施顺序

每步**可独立上线**且有独立验收。排序原则：先做"不改架构就能做"的，再"改一个 seam"，最后"改数据模型"。

| 步 | 内容 | 依赖 | 独立价值 | 验收 |
|---|---|---|---|---|
| **S1** | checkpoint 加 `[compaction-declaration]`（§3.2.2） | 无 | **最高性价比**：`shadowedSeqs` 已在事件里，只多写几十行文本 | B1、B2 |
| **S2** | prune 标记补规模与路径（9D §4.1 方案 A 下半句） | 无 | 与 S1 同源，同样便宜 | 标记含字符数 + 可执行路径 |
| **S3** | 挂 `session_event_read`，打开 `session-query-sqlite`（§4.3.3） | 无 | 让 S1/S2 的指针**真的能执行** | C6、C7 |
| **S4** | 换摘要 prompt（§3.2.4） | 无 | 独立收益，可与 S1-S3 并行 | B4（须 A/B 实证） |
| **S5** | `DecisionRecord` + 压缩前钩子（§3.2.3、§4.3.1） | S1 | 决策层开始积累 | B3、C1-C3 |
| **S6** | 记忆指针区（§4.3.2），走温信道 | S1、S3、S5 | 检索从 pull 变成"有指针的 pull" | C4、C5、D2 |
| **S7** | `MemoryContribution` 契约 + `GuaranteeTable`（§2.2） | S6 | 插件作者第一次能声明存活 | A1-A5 |
| **S8** | 重要性选择（§3.2.1） | S5 | 压缩质量的根本改善 | B5、B6 |
| **S9** | 工具 schema 分档治理（§5.4） | 无，但**风险最高**（断前缀） | 每请求省 30% schema | D5、D1 |
| **S10** | 重注入硬预算（§2.2） | S7 | 防 S7 被滥用 | A3、A6 |

三条排序理由：**S1/S2 排最前**，因为它们属于"信息已在日志里、只差一个接口"的那一类（9B §7 缺陷 2 原话），投入产出比高出其他所有步一个数量级。**S9 排最后且风险最高**，因为它动前缀且影响每个请求；出问题时 D1 闸门会报警，但它也会掩盖其他步骤的效果。**S7 不能提前**，因为契约需要至少两个真实注入源才能验证——只有一个源时，"存活契约"与"这个源恰好会自愈"在测试上不可区分。

---

## 8. 开放问题与风险

### 8.1 我没有解释的（诚实清单）

| # | 问题 | 已知 | 未知 | 影响 |
|---|---|---|---|---|
| **Q1** | 145 次未归因断崖（占未命中 18.6%） | 间隔中位 0.18 分钟、86/89 在 1 分钟内，**不是 TTL**；48/193 窗口内有辅助调用 | 其余 145 次的成因 | 若是可修的系统行为，收益比本方案全部步骤之和还大。**全篇最值得先查的一件事** |
| **Q2** | cacheRead 全是 64 的倍数 | 结论成立，按块复用 | 块粒度对"首 token 差异"的容错边界在哪 | 决定 §5.3.3 能否放宽到"块内一致即可"。若能，温信道自由度大增 |
| **Q3** | 声明窗口 vs 上游真实容量不符 | 98 §2.3：`9ecf69ac` 声明 1,000,000 但 ~664K 被拒 | 其他路由是否同类 | 影响压缩阈值可信度；也制造 §5.2 那种 `input=285,113` 的巨量断崖 |
| **Q4** | 辅助 LLM 调用对主会话缓存的影响 | 24 次 title、5 次 translator 请求出现在断崖窗口内 | 是**原因**还是**伴生现象** | 若是原因，把 title 生成改成异步/隔离上下文是免费优化 |

### 8.2 方案自身的风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| **重要性选择引入新的不确定性** | 高 | 打分确定性可单测，但"什么重要"是价值判断。**S8 之前先小规模对照**：3 个会话，人工标注与打分一致性 ≥ 70% 才继续 |
| **摘要 prompt 变长，压缩率下降** | 中 | B6 允许略长但需上界。若压缩率跌破 95%（当前 >99%），说明义务清单在吃掉收益 |
| **指针区侵蚀重注入预算 / `DecisionRecord` 变成噪音** | 中 | 800/4,000 硬切分，超限降级为一行统计；钩子只抽 `retentionScore` 高的节点，非全量抽取 |
| **检索工具的 schema 成本抵消收益** | 中 | 只挂一个工具；C7 的 2,500 tokens 是硬闸门 |
| **四专题实现互相等待** | 低 | §7 排序已保证每步独立；S1-S3 完全不依赖其他步 |

### 8.3 明确的**不做**

| 不做 | 理由 |
|---|---|
| embedding / 语义检索 | 9B §9 三处"未找到"，dsh 无现成能力；9C §3.1 显示检索质量不是当前瓶颈，"不知道要检索"才是 |
| 自动抽取事实并 ADD/UPDATE/DELETE | 9C §5 第 7 条 + §3.5：抽取判据是"显著性"，系统性漏掉低显著高复用的信息；ChatGPT 从条目退回摘要也说明条目抗压缩但不抗矛盾累积 |
| 记忆 TTL / 自动衰减、让模型改自己的高影响记忆 | 9C §3.6：遗忘应发生在工作集而非存储层；§5 第 6 条：静默重写是把不可逆性引进最不该有的地方 |
| 改 `deriveMessages()` 的投影规则 | 9B §6.3：不在 seam 上 |

### 8.4 诚实标注：属于推理而非实测的部分

| 结论 | 状态 |
|---|---|
| "重注入进 node 0 会放大输入成本 123 倍" | `[推断]` 上界。真实值取决于上游是否按块部分命中（Q2），可能显著小于 123 |
| "重要性选择能提升压缩质量" | `[推断]`。**没有对照实验**，9C §3.2 已明确业界也没做 |
| "结构化义务清单比自由摘要更抗压" | 机制推理 + 白盒 context rot 研究的间接证据（9C §3.2），**不是直接测量**。B4 就是为补这个洞 |
| "指针区 800 tokens 够用"、"重注入总预算 4,000 tokens" | `[推断]`，无实测。前者需 S6 上线后按真实会话调参；后者由"当前 system prompt 中位 2,273"外推，非实测最优 |

**判定这些编号与本文其他表格共用**；`[推断]` 标的是推理，不是实测。

---

## 9. 参考

| 文档 | 本文用它做什么 |
|---|---|
| [9B-dsh-source-findings.md](9B-dsh-source-findings.md) | 装配流程（§1）、注入点（§2）、五种存活语义（§3.4/§3.5/§7 缺陷 4）、不可恢复清单（§4）、自描述缺失（§5）、扩展边界（§6）、12 条缺陷（§7） |
| [9C-memory-survey.md](9C-memory-survey.md) | 重注入 vs 检索判据（§3.1）、结构化的真实强度（§3.2）、只追加用法（§3.3）、谁告知模型（§3.4）、遗忘二分（§3.6）、8 条可迁移原理（§4）、10 条反面教材（§5） |
| [9D-memory-architecture-review.md](9D-memory-architecture-review.md) | 四段式骨架；§1 直接引用并更正两处 |
| [98-compaction-findings.md](98-compaction-findings.md) | 阈值公式与实测触发点（§2）、遮蔽量统计（§4）、模型是否被通知（§5）、prune 实测（§6） |
| [9A-self-audit.md](9A-self-audit.md) | 自我报告的可靠性边界（§7.3）；`confidence` 字段的直接依据 |
| [50-file-model.md](50-file-model.md) / [52-file-warden.md](52-file-warden.md) | 写作风格基准与"剩余风险（诚实清单）"格式；"先记后做"的崩溃恢复原则（52 §3.2），§3.2.3 钩子顺序直接照搬 |
| [60-model-cost.md](60-model-cost.md) | 缓存是成本主战场（§2）、前缀稳定化的"变化频率排序"（§2.1）；§5.3.2 把它约束到记忆方案 |

**源码位置**（dsh `0.2.1-rc.5`）：order 表与 `deferLoading` —— `dsh-system-prompt/src/index.ts:136-186`、`:116`；system prompt 投影与 runtime context 去重 —— `dsh-agent-loop/src/runtime-context.ts:74-122`、`:164-180`；`contentGeneration`（系列判定）—— `dsh-session/src/surface.ts:574-582`；压缩跳过 node 0 / 阈值公式 / 永远 replace —— `dsh-compaction-basic/lib/index.js:415`、`:130-134`、`:650-661`；摘要指令原文与 `summarize()` 钩子 —— `dsh-compaction-basic/src/summarizer.ts`、`src/index.ts:108` 与 `:264-279`；`compactRegion` 签名 —— `dsh-compaction/src/index.ts:187`；4 字符/token —— `dsh-token-meter/lib/types/estimate.js:9`；AGENTS.md 自愈 —— `dsh-agent-instructions/lib/index.js:1272-1279`；搜索后端默认关闭 —— `dsh-base/cordis.patch.yml:157-161`。

**实测脚本**（仓库 `.tmp/` 内，只读 `~/.dsh`）：`cache-probe.mjs`（命中率总账）、`cache-probe2`（断崖与压缩前后对照）、`cache-probe3`（压缩归因窗口法）、`cache-probe4`（断崖分类与 header 结构）、`cache-probe5`（按 input 计价的代价归因 + schema 体积）、`probe10`（单次压缩重建代价）、`probe11`（压缩后首请求形状）、`probe12`（辅助调用相关性 + 64 倍数验证）、`probe13`（system prompt 重写频率）。脚本在**本会话内采集一次**，而 `.jsonl.zstd` 实时追加，故重跑总数会略高于文中（差异 < 0.2%）。

---

*文档结束。四专题均已给出可落地接口；专题四的实测推翻了一个常见直觉（压缩不是缓存杀手），并留下 4 个明确未解的问题。*
