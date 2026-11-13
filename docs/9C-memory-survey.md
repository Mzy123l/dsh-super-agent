# 业界记忆系统设计对照

> 用途：架构评审对照材料。重点不是功能清单，而是**可迁移的原理与取舍**。
>
> **来源标注约定**：`【论文】`= 同行评审/arXiv 原文；`【官方】`= 产品方文档或工程博客；`【第三方】`= 独立分析、逆向观察、社区整理。商业产品内部机制不公开的，一律写「未披露」，不推测。
>
> **营销话术与可验证机制的区分**：凡本文写「机制」，指能在源码、论文、官方文档里指出具体数据结构或操作的地方；凡写「宣称」，指只有厂商博客措辞、无对应实现说明的地方。审阅时请以「机制」列为准。

---

## 1. 总览对照表

> 缩写：`FT`=自由文本，`KB`=结构化条目/KV，`VEC`=向量，`G`=图，`MD`=磁盘上的 Markdown 文件。
> 「—」= 公开资料未披露。「部分」= 有但覆盖不全，详见 §3。

| 系统 | 记忆层级 | 写入时机 | 载体形式 | 是否可改写 | 检索方式 | 遗忘策略 | 压缩后如何处理 | 模型自知忘了 |
|---|---|---|---|---|---|---|---|---|
| **MemGPT** 【论文】 | 2 层实体（主上下文 / 外部），主上下文内再分 3 段：只读系统指令、working context、FIFO 队列 | 模型主动（function call 自编辑） | 主上下文=FT 块；外部=recall（消息库）+ archival（任意长文本） | 覆盖（working context 定长可重写） | 每轮重注入（主上下文）+ 模型 pull（recall/archival） | 容量淘汰：从上下文逐出，**recall 永久保留** | 队列头部维护「递归摘要」，逐出时用旧摘要+被逐消息生成新摘要 | **有**：70% 窗口注入 memory pressure 警告系统消息 |
| **Letta**（MemGPT 产品化）【官方】 | 同 MemGPT，另加 files / external RAG | 模型主动 + 人可改 | memory blocks（FT，建议 <50k 字符、<20 块）；files 只读 5MB；archival 单条约 300 token、数量不限 | 覆盖（block 可读写/可设只读） | 块=每轮重注入；archival/files=工具 pull | 容量建议值 + 无 TTL | 同 MemGPT；另有 sleep-time 异步整理（第三方报道） | 有（沿袭 pressure 机制） |
| **Mem0** 【论文】 | 1 层事实库（+ 摘要） | **自动抽取**（每消息对触发） | KB（原子事实）+ VEC；Mem0g 加 G | **覆盖**：LLM 选 ADD/UPDATE/DELETE/NOOP | 自动召回（top-k 相似） | DELETE 真删除；无 TTL | 摘要异步刷新，作为抽取的上下文，不替代事实 | 无 |
| **Mem0g**（图变体）【论文】 | 实体节点 + 关系三元组 | 自动抽取（两阶段：实体→关系） | G（Neo4j）+ VEC | 冲突关系**标记失效而非物理删除** | 实体中心 + 语义三元组双路 | 不物理删除（保留做时序推理） | 同上 | 无 |
| **Zep / Graphiti** 【论文】 | **3 层**：episode（原始、非有损）→ semantic（实体/事实）→ community（摘要） | 自动抽取（摄入即抽） | G + VEC + 全文索引 | 事实边**不覆盖**：置 `t_invalid`，保留历史 | 自动召回（search→rerank→constructor，预算约 1.6K token） | **不遗忘**（non-lossy） | 只有 community 层是摘要；episode 与事实不参与压缩 | 部分（事实带有效期，但不告知被裁剪） |
| **LangGraph checkpointer** 【官方】 | 线程内状态快照 | 框架自动（每步 checkpoint） | 图状态（任意可序列化结构） | 覆盖（新 checkpoint 追加，旧的可回放） | 按 `thread_id` 加载 | 未披露（由存储层决定） | 不是压缩机制：它保的是状态，不是语义 | 无 |
| **LangGraph Store / LangMem** 【官方】 | 跨线程长期 KV + 语义/程序性记忆 | 应用代码写 / 抽取 | KB + VEC | 覆盖 | 工具读取（按 namespace/key） | 未披露 | — | 无 |
| **A-MEM** 【论文】 | 1 层「笔记网络」（Zettelkasten） | 模型主动（新增笔记时自动建链） | KB（含描述/关键词/标签）+ 链接 | **覆盖 + 演化**：新记忆可回改旧记忆的属性 | 自动召回（链接 + 向量） | 无明确淘汰（依赖检索排序） | 不涉及压缩 | 无 |
| **MemoryOS** 【论文】 | **3 层**：短期 / 中期 / 长期个人 | 自动（对话链驱动） | FT + 分段页 | 覆盖（层间搬移） | 分层召回 | 短→中 FIFO；中→长「分段页」组织 | 层间搬移即压缩 | 未披露 |
| **Cognee** 【官方+第三方】 | 图 + 向量双存，pipeline 可组合 | 自动（`add`→`cognify`） | G + VEC + 摘要 | 覆盖 | 自动召回（16 种 search 策略，按 query 路由） | 未披露 | 不涉及 | 无 |
| **Claude Code：CLAUDE.md** 【官方】 | 1 层（磁盘），目录树分层 | **人手动写**（`/init` 可生成） | MD | 人覆盖（无版本语义，靠 git） | **每轮重注入**（含祖先目录，拼接不覆盖） | 不遗忘（>4MiB 整个跳过） | **从磁盘重注入**，天然免疫压缩 | 不适用 |
| **Claude Code：auto memory** 【官方】 | 1 层（`~/.claude/projects/<p>/memory/`） | 模型主动写 | MD；`MEMORY.md` 作索引 + 主题文件 | 覆盖 + 合并/丢弃过期项 | **索引每轮重注入**（前 200 行或 25KB）+ 主题文件按需读 | 无 TTL；**保留策略明确豁免记忆文件** | 从磁盘重注入 | 不适用 |
| **Claude Code：`/compact`** 【官方】 | 无独立层，改写消息历史 | 自动（接近上限）+ 手动 | 结构化摘要 | 不可逆覆盖 | 摘要本身在上下文里 | 摘要替换原历史 | **摘要 + 从磁盘重注入 + 重读最近 5 个文件**（>5000 token 只留路径） | **部分**（超限文件标 `Referenced file` 而非 `Read`） |
| **Cursor Rules** 【官方】 | 4 类（Project/User/Team/AGENTS.md） | 人手动写 | MD（`.mdc` + frontmatter） | 人覆盖（版本控制） | **四种激活**：alwaysApply / glob 自动附加 / description 由 Agent 自判 / `@` 手动 | 不遗忘 | 不适用（非对话内） | 不适用 |
| **Cursor 检索** 【官方】 | 无记忆层 | — | 本地索引（Instant Grep）+ 文件 | — | **模型 pull**（grep/语义/Explore 子代理） | — | 子代理独立窗口，只回传结论 | 不适用 |
| **GitHub Copilot** 【官方】 | 无独立记忆层 | — | 工作区索引 + `#` 引用 + 指令文件 | — | **模型 pull**（语义/文本/grep/文件/usages，自动多轮补搜） | — | 未披露 | 不适用 |
| **Windsurf** 【官方】 | 2 类：自动 Memories + 人写 Rules | Memories **自动**；Rules 人写 | Memories 本地文件；Rules MD（含 `trigger`） | Memories 可编辑；Rules 人覆盖 | Memories「认为相关时」自动检索；Rules 按 always_on/glob/model_decision/manual | 未披露（仅工作区隔离） | 未披露 | 无 |
| **Cline Memory Bank** 【官方】 | 6 个固定 MD 文件（项目简报/产品/技术/系统模式/当前上下文/进度） | **模型主动写**（人触发 "update memory bank"） | MD | 覆盖 | **每任务强制重注入**（指令要求读全部） | 不遗忘 | 换新会话前人工落盘 | 不适用 |
| **ChatGPT memory** 【官方+第三方】 | 1 层（记忆摘要）+ 遗留的离散「已保存记忆」 | **自动**（"dreaming"）+ 用户指令 | **FT 摘要**（2026-06 起）；遗留为 KB 条目 | 用户可改（自然语言或在摘要中划词改） | 自动召回（+来源列表） | 容量淘汰 + **自动降权过期项**；用户可删 | 未披露 | 无 |
| **Claude（App）memory** 【官方】 | 按项目隔离的独立记忆 | 自动 + 用户指令 | 记忆摘要（FT） | 用户可通过对话改 | 自动召回 | 未披露 | 未披露 | 无 |
| **Devin / Cognition** 【官方】 | 不建记忆层，改为**委托隔离** | — | 上下文分叉（smart friend 共享全量上下文） | — | 每轮重注入（fork 全量） | 靠专用压缩模型蒸馏（已自训） | 专用压缩模型（非通用摘要） | 未披露（明确反对并行写） |

---

## 2. 六种典型范式

### 范式一：OS 分页式（虚拟上下文）

**代表**：MemGPT / Letta、MemoryOS。

**核心机制**：把上下文窗口当作物理内存，外部存储当作磁盘，让**模型自己**通过 function call 执行 page-in / page-out。MemGPT 的具体机制值得完整复述，因为它是全文最精确的类比落地：

- 主上下文分三段：只读系统指令、定长可写 working context、FIFO 队列（队首是「被逐出消息的递归摘要」）。
- 两个阈值：到 **~70%** 窗口时，队列管理器往队列里插一条系统消息，警告即将发生逐出——这不是硬策略，是**给模型的信号**；到 **100%**（flush 阈值）时逐出约 50% 的消息，并用「旧摘要 + 新逐出消息」重新生成队首摘要。
- 被逐出的消息**永久保留在 recall storage**，模型可用 function call 取回并重新追加到队列尾部。
- 因此「压力」不是被动触发的，而是模型可感知、可反应的输入事件；paging 决策权在模型，不在硬编码的淘汰策略。

**适用场景**：单个长期存续、工作集有界且可自然分段的会话（个人助手、文档分块分析）。

**失败模式**：① 分页决策占掉真实任务轮次；② 递归摘要是**串行有损**的，第 N 代摘要承载第 1 代信息的能力指数衰减；③ 模型可能把关键内容逐出后**永久不再想起**——因为没有东西告诉它「你逐出过 X」。文件分析场景里这表现为「找不到那段」，而它自信地继续。

### 范式二：抽取—合并式事实库

**代表**：Mem0（含 Mem0g）、ChatGPT 遗留「已保存记忆」、LangMem。

**核心机制**：每次交互后由 LLM 抽取候选事实，与 top-s 相似历史事实一起送进 LLM，由 LLM 在 **ADD / UPDATE / DELETE / NOOP** 四选一。Mem0 论文的配置是 s=10、最近 10 条消息、GPT-4o-mini 做抽取与决策。Mem0g 换成两阶段（实体抽取 → 关系生成），冲突时**标记失效而非删除**。

**适用场景**：个性化，且「真相的最小单元」是原子事实（偏好、姓名、时区）。

**失败模式**：① 抽取判据是「显著性」而非「未来有用性」，容易漏掉**低显著、高复用**的信息（构建命令、一次性的口径约定）；② DELETE 是真删除，一次错误合并不可逆；③ top-k 相似对多跳问题天然弱（Mem0 论文自己也把 multi-hop 单列一类）；④ 事实与来源解耦后，无法回答「你怎么知道」。

### 范式三：时序知识图谱

**代表**：Zep / Graphiti、Mem0g、Cognee。

**核心机制**：三层子图——episode（原始输入，非有损）、semantic（实体 + 带有效期的事实边）、community（聚类摘要）。**双时间轴**：`T` 是事件真实发生/失效的时间（`t_valid` / `t_invalid`），`T'` 是系统写入/作废的时间（`t'_created` / `t'_expired`）。新事实与语义相关旧事实冲突时，**不删旧边**，只把旧边的 `t_invalid` 设为新边的 `t_valid`；按 `T'` 优先采信新信息。检索输出给模型时直接带上有效期标记：

```
FACT (Date range: from - to) ...
```

**适用场景**：事实会变、且「什么时候为真」本身是答案的一部分（企业客户关系、医疗、合规）。

**失败模式**：① 构图成本与延迟高（实体消解、去重、社区检测都是 LLM 调用）；② 实体消解错误会**向下游复合**；③ **有元数据不等于检索用得上**——第三方对 Zep 的复盘明确指出：知识更新类问题上 Zep 反而弱于全上下文基线，双时态基础设施存在但检索路径没利用好（*第三方观点*）；④ 对「记住我姓什么」是过度工程。

### 范式四：人在环的指令文件（配置即记忆）

**代表**：CLAUDE.md / AGENTS.md、Cursor Rules、Copilot 自定义指令、Windsurf Rules、Cline Memory Bank。

**核心机制**：记忆是人写的纯文本，进版本控制，**每会话从磁盘重新注入**。Cursor 把它说得最直白：【官方】"Large language models don't retain memory between completions. Rules provide persistent, reusable context at the prompt level." Cursor 的四级激活（always / glob / 描述自判 / 手动）本质是把「常驻上下文预算」当成一个显式的资源调度问题。

**适用场景**：稳定的约定、不变量、团队规范。

**失败模式**：① 陈旧——Cursor/Copilot 官方都警告规则会随代码漂移；Claude Code 甚至内置 `/doctor prompt-audit` 专门查「写给旧模型的指令、指向不存在文件的指令、互相矛盾的指令」；② 冲突由模型**任意择一**（Claude Code 官方原话：两条指令矛盾时 Claude may pick one arbitrarily）；③ 无学习能力，全靠人；④ 太长了反而降低遵循度（Claude Code 建议单文件 <200 行）。

### 范式五：代理式结构化笔记（Zettelkasten）

**代表**：A-MEM、Claude Code auto memory、Cline Memory Bank、Letta memory blocks。

**核心机制**：模型自己写「笔记」，每条带属性（上下文描述、关键词、标签），并主动建立链接；A-MEM 更进一步做 **memory evolution**——新记忆写入时会**回改旧记忆的属性**，让网络自我精化。Claude Code auto memory 用 `MEMORY.md` 作**索引**、主题文件按需读取，并在写入时自动记录 `modified` ISO 时间戳（"The timestamp shows how current the fact is, both to you and to Claude when it reads the memory back"）。

**适用场景**：agent 需要跨会话积累**程序性知识**（「这个仓库的测试要本地 Redis」）。

**失败模式**：① **静默改写**——没有版本，高影响记忆被悄悄改掉无法追溯（第三方对 A-MEM 的批评直指此点，建议「不要静默重写高影响记忆」）；② 自我强化：模型写错的笔记会被自己反复读回来；③ 无索引时无限膨胀（Claude Code 的对策是硬性 200 行/25KB 上限 + 超限报错要求重写）。

### 范式六：压缩即记忆（summary-as-state）

**代表**：Claude Code `/compact`、Anthropic 压缩 API、Cognition 的自训压缩模型、Zep community 层。

**核心机制**：把旧对话整体替换成一段摘要。Anthropic 官方把压缩拆成可配置的几个正交维度：按需 / 按 token 阈值；是否**保留最近若干轮逐字原文**；是否**后台压缩**（不阻塞）；是否保留 thinking 块；**可否自定义摘要 prompt**。【官方】

**适用场景**：同一任务的连续推进。

**失败模式**：① 不可逆地丢掉高熵细节（见 §3、§5）；② 无来源，摘要无法回溯到原始证据；③ **串行累积**：压完再压，每次都在上一代摘要上做有损变换；④ 静默——模型不知道自己少了一半历史。

> **范式之外的第七种：把「上下文隔离」当记忆策略。** 不建记忆层，而是让子代理在**干净上下文**里干活，只回传结论。Cognition 的实测：clean-context reviewer 平均每 PR 抓 2 个 bug，约 58% 是严重级；他们给的解释不是「reviewer 更聪明」，而是「attention 的数学」——上下文越长，模型决策质量越低。【官方】Cursor 的 Explore 子代理、Claude Code 的 subagent 同理。它的失败模式是**上下文传递瓶颈**：Cognition 自己的诚实负面结果是 SWE-1.5 作主模型时「不知道何时该升级、该问什么」，整套 smart-friend 模式跑不起来。

---

## 3. 深层问题的回答

### 3.1 「重注入」vs「检索」，各自在什么场景胜出？有没有明确失败案例？

**结论：这不是两条竞争路线，而是两个不同的预算科目。重注入买的是「必然在场」，检索买的是「规模」。真正的分野不在机制，而在「谁决定拉取」。**

**重注入胜出的条件**（三条同时成立）：信息量小（能塞进几千 token）、必须在**每一轮**都成立、且**违反一次就出事**。CLAUDE.md / Rules 正好落在这个三角里——所以整个行业不约而同地把「不变量」放这里，且刻意保持小（Cursor 建议 <500 行，Claude Code 建议 <200 行，Windsurf 工作区规则硬限 12000 字符）。

**检索胜出的条件**：语料远超窗口、访问稀疏、且相关性依赖具体 query。这里的量化证据是硬的：
- Mem0 论文对比全上下文：token 省 >90%，p95 延迟低 91%，LLM-as-Judge 相对 OpenAI memory 提升 26%。
- Zep 在 LongMemEval 上比全上下文高 15.2%（gpt-4o-mini）/ 18.5%（gpt-4o），平均上下文从 115K 降到 1.6K，延迟从 31.3s 降到 3.2s。

**明确的失败案例（这是本节最有价值的部分）：**

1. **指针当载荷**——Cursor 官方文档明说：`@file.ts` 只是告诉 Agent 去哪看，**"The file's contents are not inlined into the prompt"**，要 Agent 用工具自己去读。所以如果 Agent 没去读，「必须始终在上下文中」的约束就**事实上不存在**。这是纯检索路线最典型的静默失效：约束没报错、没告警，就是没生效。Cursor 的对策是让用户「把必须常驻的东西直接写进规则正文」——等于承认检索不可靠。

2. **全上下文重放**——Mem0 之外，最硬的是 2026 年那份白盒 context rot 研究：干净 10,991 字符上下文 10 次跑通 8 次；同样任务、299,140 字符（不管相关还是无关）都只跑通 3 次，失败率从 20% 升到 70%。**注意「相关」和「无关」的长上下文表现一样差**——说明杀死性能的不是信息量，是长度本身。

3. **元数据存在但检索没用上**——Zep 的双时态设计专门为「事实更新」而生，但第三方复盘指出它在知识更新类问题上仍弱于全上下文。这说明「模型知道有这个能力」和「检索路径真的会用它」是两件事。

4. **子代理隔离的传递损失**——Cognition 的诚实记录：SWE-1.5 作主模型时整套模式失败，因为「弱模型不知道自己到极限了」。隔离解决了上下文污染，但引入了「我不知道该问什么」的新失败面。

**可操作的判据**：把记忆分成两个预算池——
- **常驻池**（重注入）：放「违反一次就出事且每轮都相关」的东西，硬性限额，超了就必须下沉成指针。
- **按需池**（检索）：其余全部。**且检索必须由模型发起**（工具 + 好描述 + 可发现性），而不是系统替它猜「什么是相关的」。系统猜相关性这件事，在长尾上几乎总是猜错——错的那次没有任何信号。

---

### 3.2 结构化条目 vs 自由文本摘要：哪种更能抵抗反复压缩？有没有实证？

**结论：结构化条目显著更强，但机制不是「结构化更抗压」，而是「结构化可以被幂等地重渲染，摘要只能被串行地再摘要」。**

这个区别很关键。一条事实在库里被 ADD/UPDATE，它的信息量**不随访问次数衰减**；一段摘要被压缩第二次时，是在**上一次摘要的输出**上做有损变换，误差复合。所以真正的敌人不是「文本」而是「摘要的摘要」。

**直接证据（强）**：
- **白盒 context rot 研究的复现**：同一个长上下文条件，让 Agent「自查所有约束」通过 5/10；给一份**逐条列出 24 项义务的外部清单**通过 10/10。差别不在模型，在于**把义务枚举出来**这件事本身。研究者还发现：需求覆盖率仍保持 0.933–0.949，崩掉的是少数几条决定性义务——也就是说，长上下文不是「整体变笨」，而是**零星丢条款**。这正是结构化清单能救、自由文本摘要救不了的地方：摘要会把「24 条里的第 17 条」平滑掉，而它不知道自己平滑掉了。
- **Claude Code 的架构本身就是这个结论的落地**：`/compact` 之后，它**不是**指望摘要记得住 CLAUDE.md，而是从磁盘**重新注入**——项目根 CLAUDE.md、无 `paths` 的规则、auto memory、skill 描述、plan 文件全部重来一遍。等于承认「摘要不可靠，那就别让不变量依赖摘要」。更狠的一条官方说明：路径作用域的规则和子目录 CLAUDE.md「会和其余内容一起被摘要掉」，所以「**若某条规则必须跨压缩存活，就去掉 `paths:` frontmatter 或挪到项目根 CLAUDE.md**」。
- **Zep 的分层**：只有 community 层是摘要，episode 和事实边永不参与压缩；反复访问不会导致反复摘要。

**间接证据（中）**：MemGPT 的队首递归摘要被后续系统（Zep、MemoryOS 的层间搬移）普遍替换为「保留原始 + 分层索引」，可以视为业界用脚投票。

**诚实的空白**：**没有找到**「同一信息分别以结构化条目/自由文本摘要存储，经过 N 轮压缩后的保真度」的对照实验。Mem0、Zep 的 benchmark（LoCoMo / LongMemEval / DMR）测的是端到端问答，不是压缩保真度，且各自有偏向（Zep 论文作者即系统作者，DMR 已被第三方指为饱和）。所以「结构化更抗压」目前是**机制推理 + 间接证据**，不是被直接测量过的结论。评审时应当作假设而非事实。

**一个反例需要记下**：ChatGPT 在 2026-06 把「离散已保存记忆条目」**改成了**「可编辑的记忆摘要」。【官方+第三方】方向是从结构化条目退回自由文本。原因不是抗压性，而是**过时与矛盾**：离散条目会累积成互相打架的清单（官方举的例子是「我在为马拉松训练」和「我扭伤了脚踝」并存）。这提示一个真实取舍——**结构化条目抗压缩，但不抗矛盾累积**；摘要抗矛盾（因为每次重写都会合并），但不抗压缩。选哪个取决于你的主要失败模式是「忘」还是「错」。

---

### 3.3 「只追加」（append-only）被用在哪里？为什么重要？

**用在三处，且三处的理由不同：**

1. **原始事件层（最普遍）**。MemGPT 把逐出的消息「stored indefinitely in recall storage」；Zep 的 episode 子图是显式的「non-lossy data store」。上下文可以破坏性裁剪，**底层不行**。

2. **事实层（Zep / Mem0g）**。事实冲突时置 `t_invalid` 而不是 DELETE，Mem0g 论文的原话是「marking them as invalid rather than physically removing them to enable temporal reasoning」。产物是「截至 T 时刻我们认为什么为真」这个能力——这不是审计花活，是唯一能回答「这个结论是什么时候变的」的方式。

3. **派生与原始的分离**（ChatGPT）。记忆与聊天历史分开存储，删对话不删记忆；反过来删记忆也不会去清洗历史对话。【官方】

**为什么重要（四条，按重要性排）：**

- **可逆性**：任何一次错误的合并/摘要，在原始层还在时都只是「视图算错了」，可以重算。原始没了，就是事故。这是「破坏性操作只应作用于派生视图，永不作用于基底」的一条特例。
- **可追溯性**：context rot 研究里那个最刺眼的案例——子代理加载 2.4M 字符、经历 3 次原生压缩后，报告说那份 256 条的 opaque contract「不见了」，最后是**读了被禁止的父级材料**才恢复出来，产出的 JSON 字节级正确。如果只看产物，评测记录成功；只有 provenance-aware 评测才记录失败。**没有原始层，连「它是不是猜的」都判不了。**
- **可重算**：抽取策略会变（换模型、换 prompt、换 schema）。基底只追加，才能在新策略下重建整个派生层。
- **成本前置**：追加比删除便宜（无一致性协调），且天然支持并发与回放。

**代价要说清楚**：append-only 意味着存储单调增长、检索干扰项单调增长、以及**隐私合规上的硬约束**（GDPR 类「被遗忘权」要求真删）。所以业界的实际做法是「**默认只追加 + 显式真删通道**」——ChatGPT 提供逐条删除与清空，并保留 30 天删除日志；Mem0 保留 DELETE 操作。没有一家做「永不删除且不可删」。

---

### 3.4 有没有系统明确告诉模型「你的上下文被裁剪过」？如果几乎没有，为什么？

**有，但只有一家做成了机制，其余都是间接信号。**

**明确做到的**：**MemGPT**。它是唯一把「你即将失去上下文」当作**一等输入事件**的系统——到 70% 窗口时往队列里插一条系统消息（memory pressure warning），让模型有机会在逐出前把重要内容搬进 working context 或 archival；逐出后队首留一条递归摘要，等于告诉模型「这里原本有一段，这是它的摘要」。这不是隐喻，是论文里写明的机制。

**部分做到的**：
- **Claude Code** 有两处。其一，超限的按需加载文件只给开头，且「**结尾附一句提示，让 Claude 用 Read 工具读剩下的部分**」；其二，压缩后重读的文件的 token 超过 5000 时，以**路径引用**返回，界面上显示为 `Referenced file` 而不是 `Read`。这两处都是「以**指针**形式告知缺失」，不是以声明形式。
- **Zep** 给每条事实带有效期，模型知道事实**何时为真**，但不知道**有什么被裁掉了**。

**明确没做到的**：ChatGPT、Claude App memory、Cursor、Windsurf、Copilot、Mem0、MemoryOS（至少公开资料未披露任何此类信号）。

**为什么几乎没有——四个理由，从表面到根因：**

1. **产品激励相反**。压缩的卖点是「无缝续接」。一句「我丢掉了 40 轮对话」会立刻让模型开始追问、加免责声明、或者要求用户重述——这恰好是产品想消除的体验。所以**摘要被设计成透明的**。

2. **实现形态上没地方放**。压缩是**历史改写**，不是**事件**。消息被摘要替换后，那条「你被裁剪过」的标记要放在哪？放一次就永久占 token；而且没有自然的「你」可以称呼——说得通的说法只有「此前 N 轮已被摘要」。

3. **收益不确定，风险确定**。模型知道自己忘了之后，可能去检索（好），也可能围着空洞编（坏），也可能过度保守（坏）。Cognition 的经验倾向后者不重要、前者靠不住——他们给出的解法是**外部清单**和**干净上下文的复核者**，都是外部机制，不是内省。

4. **最根本的一条：这类知识已经被生产出来了，但被路由给了人，不是模型。** Claude Code 的官方文档有一整张「What survives compaction」表，逐项列出压缩后每个机制的下场，并明确写出「若这条规则必须跨压缩存活，就改 frontmatter」。**这份知识的消费者是运维者，不是 agent。** 系统的设计假设是：人负责把重要的东西挪到安全区，模型只管在给定的上下文里干活。同一份损失清单，换个投递对象就是「让模型知道自己忘了」——业界的缺失不是「没想到」，是**投递对象选错了**。

**给 dsh 的直接推论**：不要写成忏悔（"你丢失了上下文"），要写成**指针**（"此处原有关于 X 的 N 轮，可用 `<tool>` 取回"）。前者花 token 买焦虑，后者花 token 买能力。MemGPT 的递归摘要和 Claude Code 的 `Referenced file` 都是指针形态，这不是巧合。

---

### 3.5 个人助手类产品怎么避免「用户可编辑记忆」被污染和过时？

**先看它们实际踩的坑，因为设计是被坑逼出来的。**

ChatGPT 的旧方案是**离散条目 + 用户手动触发保存**，跑了两年，官方给出的重构理由是：手动管理的记忆会**过时且互相矛盾**，并举了「我在为马拉松训练」与「我扭伤了脚踝」并存的例子。【官方，经第三方整理】2026-06 的新架构把核心从「条目清单」换成了**可编辑的记忆摘要**：自动更新、显示最后更新时间、用户可以在摘要底部的输入框直接写修改意见，也可以**划选任意一段做定点修正**；每条回答下方的书本图标会列出**是哪几个来源**（自定义指令/历史对话/文件/记忆）影响了这次回答，并解释为什么用了它。【第三方整理，附官方 FAQ 引用】

Claude 走的是另一条：**项目作用域记忆**（每个 project 独立记忆，「product launch planning 与 client work 不混」），记忆以摘要形式呈现、通过对话修改，配套 incognito 会话（不读也不写），企业管理员可整体关闭。值得注意的是他们上线前做的安全测试，明确测了「记忆是否会强化有害模式、导致过度迎合（over-accommodation）」——**这说明被识别的主要风险不是事实错误，而是行为漂移**。【官方】

**可归纳的六条抗污染机制：**

1. **人可读的表面即存储**（summary-as-UI）。用户看到的摘要就是存储本身，改摘要就是改记忆。避免了「设置页能看到、实际用的却是另一份」的双轨。
2. **来源可见**（provenance per response）。这是唯一能让用户判断「它为什么这么说」的机制，也是纠错的入口。
3. **时间戳**。ChatGPT 显示最后更新时间；Claude Code 在记忆文件 frontmatter 里自动写 `modified` ISO 时间。低成本、高杠杆——它让「新」与「旧」在读取时就可分辨。
4. **命名空间硬隔离**。project-scoped memory（Claude）、project-only memory（ChatGPT Projects）、workspace-scoped memories（Windsurf）都是同一招：**用边界代替清理**。跨域污染无法事后修复，只能事前隔离。
5. **不写入模式**。incognito / temporary chat。这承认了一个事实：**污染是防不住的，只能给一条不进池子的通道**。
6. **矛盾的合并优先于累积**。从离散条目转向重写式摘要，本质是接受「每次重写都会丢掉一些东西，换取不会自相矛盾」。

**仍然没解决的**：用户**信念变了**但没说，系统仍持旧值。所有产品都只能靠用户显式删除或修正，没有任何一家公开说明它如何检测「用户已经不再持有这个偏好」——**公开资料未披露**。这是个人助手记忆的真实上限，评审时不应假设它能自动收敛。

---

### 3.6 长期记忆的遗忘：主流是「从不遗忘」还是「主动遗忘」？各自代价？

**主流是「在存储层从不遗忘，在工作集上主动遗忘」。** 这个二分是本节最重要的一句话，因为大多数讨论把两者混为一谈。

**存储层几乎不遗忘（证据密集）**：
- MemGPT：逐出的消息永久在 recall；archival 数量不限。
- Zep：episode 明确是 non-lossy；事实边只失效不删除。
- Claude Code auto memory：**保留策略明确豁免记忆文件**——"Claude Code deletes old session transcripts after the `cleanupPeriodDays` retention period, but excludes the memory files... `MEMORY.md` and topic files stay until you or Claude edits or deletes them."【官方】这是「从不遗忘」被写进产品行为的最直接证据。
- Cline Memory Bank：只增不删，靠人工整理。

**工作集上主动遗忘（同样是主流）**：MemGPT 的 50% 逐出、MemoryOS 的短→中 FIFO、ChatGPT 的容量淘汰与自动降权、Claude Code 的 200 行/25KB 截断与 skill 预算（每 skill 5000 / 总计 25000，最旧的先丢）。**共同点：遗忘发生在「当下放什么进窗口」，不发生在「库里留什么」。**

**主动遗忘的例外只有两类**：① 被新事实推翻（Mem0 的 DELETE、Zep 的 invalidate——后者严格说不是遗忘而是标注）；② 用户/合规要求真删（ChatGPT 逐条删、企业版关记忆会删除成员已有记忆）。

**两种代价：**

*从不遗忘的代价*：① **干扰项单调增长**，检索质量随时间下降（Zep/Mem0 的设计本质都是在对抗这一点）；② 过时事实的**污染**——ChatGPT 那段马拉松/脚踝的例子就是代价本身的说明；③ 隐私与法律敞口（被遗忘权 vs 只追加的直接冲突）；④ 成本线性增长；⑤ **agent 会变笨**：白盒研究显示，长上下文下失败率从 20% 升到 70%，而且**相关与无关的长上下文一样糟**——意味着「多存点反正不吃亏」是错的，存得多本身就伤性能。

*主动遗忘的代价*：① **丢掉的恰好是最该留的**。context rot 研究里子代理丢掉的是那份 256 条 opaque contract——**高熵、低冗余、无法从别处重建**的信息，正是最容易被摘要平滑掉的东西，也正是最有价值的东西。② **不可逆**：没有原始层时，遗忘 = 事故。③ **遗忘不可见**：静默的遗忘和「从来不知道」在模型侧无法区分。

**所以业界的实际答案是一个三元结构**：
**存储只追加（可逆）+ 工作集强淘汰（控成本）+ 声明式真删通道（合规）**，并且——这一点最少被做到但最便宜——**淘汰要说出来**（MemGPT 的 pressure warning、Claude Code 的 `Referenced file`）。

---

## 4. 可直接迁移的设计原理（给 dsh）

> 每条给：原理 → 依据 → 为什么能迁移到 dsh（含现有形态）。

### 4.1 把持久状态移出可压缩信道

**原理**：任何「必须长期成立」的信息，都不能只存在于会被摘要的消息历史里，必须在磁盘上有一份、并在每轮（或压缩后）**重新注入**。

**依据**：Claude Code 的 `What survives compaction` 表是完整证据——CLAUDE.md / auto memory / skill 描述 / plan 全部「从磁盘重新注入」，而路径作用域规则和子目录 CLAUDE.md「被摘要掉」，官方因此明确要求「必须跨压缩存活的规则就去掉 `paths:`」。

**为何可迁移**：dsh 的 skill、AGENTS.md、plugin manifest 本来就是磁盘上的文件，天然具备「重新注入」的可能。需要明确的是**注入策略**：区分「每轮重注入」（不变量、身份、当前任务契约）与「首次注入 + 可按需重读」（大块参考资料），并给重注入集合定一个**硬预算**（Claude Code 是 200 行/25KB，Cursor 是 500 行，Windsurf 是 12k 字符），超预算就强制下沉为指针。没有预算的重注入一定会退化成 §5 的「无界重放」。

### 4.2 小核心常驻，大外围按需拉取——但拉取必须由模型发起

**原理**：常驻池只放「违反一次就出事、且每轮都相关」的东西；其余一律做成**指针**（路径、查询、ID、句柄），由模型用工具现取。

**依据**：Anthropic 的 just-in-time 路线（保留轻量标识符，运行时加载）；Cursor 官方承认 `@file` 不内联，所以「必须常驻的写进规则正文」；Mem0/Zep 的量化收益（>90% token、91% 延迟、72× 上下文缩减）。

**为何可迁移**：dsh 已有工具调用与文件系统，指针形态是现成能力，缺的是**纪律**：常驻池要有配额、要有「为什么它在常驻池」的登记、要有超配额的拒绝路径。同时工具描述要做成「模型愿意用」的样子——检索路线的实际失败很少是「检索不到」，而是「模型没去检索」。

### 4.3 原始层只追加，派生层可改写

**原理**：破坏性操作（合并、摘要、失效）只作用于派生视图；原始事件与原始事实永不被覆盖，只被标注。

**依据**：MemGPT 的 recall 永久保留；Zep 的 episode non-lossy + 事实只置 `t_invalid`；Mem0g「标记失效而非物理删除」以支持时序推理；ChatGPT 记忆与聊天历史分存。

**为何可迁移**：这是唯一让「抽取策略可迭代」成立的前提。dsh 的抽取/摘要策略一定会改（换模型、改 prompt），没有只追加的基底，每次改动都是不可回滚的一次性事件。落地成本低：多写一份原始、多一个 `superseded_by` 字段即可，不需要图数据库。

### 4.4 事实带有效期，而不是被覆盖

**原理**：每条会被时间改变的事实，至少带 `valid_from` / `valid_to`；冲突时新建一条并关闭旧的，而不是就地改写。

**依据**：Zep 的双时态与 edge invalidation，以及它输出给模型时的 `FACT (Date range: from - to)` 格式——**有效期是被喂给模型的，不只是存在库里的**。

**为何可迁移**：长跑 agent 最贵的错误不是「不知道」，而是「用三个月前的口径自信地回答今天的问题」。带有效期是这种错误的最便宜解药，而且它同时解决了「压缩后如何判断新旧」——不用判断，读时间戳。dsh 若不想上双时态，至少做单时态（`valid_from` + `superseded_at`），成本近似为零。

### 4.5 遗忘发生在排序层，不发生在存储层——且遗忘要可见

**原理**：用容量压力、recency、重要性打分决定「这轮放什么进来」；库里不动。且被淘汰的东西要留下**可取回的指针**。

**依据**：MemGPT 的 70%/100% 双阈值 + pressure warning + recall 可取回；反例是 context rot 研究里 38/44 次失败仍以「成功/完成」收尾——**静默淘汰 + 静默收尾**是同一个病。

**为何可迁移**：dsh 的上下文是有界的，淘汰必然发生；区别只在于「淘汰后模型知不知道」。做成「淘汰即留指针」几乎是零成本的：一行 `[已移出上下文：<摘要一句话> — 可用 <tool> 取回]` 就够。这条的投入产出比在全文最高。

### 4.6 把「你忘了什么」做成指针，不要做成忏悔

**原理**：告知缺失的正确形式是「此处原有 X，取回方式 Y」，不是「你的上下文被裁剪了」。

**依据**：MemGPT 队首递归摘要（既是摘要也是指针）；Claude Code 超限文件结尾附「用 Read 读剩下的」、压缩后大文件标 `Referenced file` 而非 `Read`；Cognition 的结论是修复靠外部机制（清单、干净复核者）而非内省。

**为何可迁移**：忏悔型提示会让模型进入追问/免责/过度保守三种坏状态之一，而指针型提示直接给它一条**可执行动作**。同样的 token 预算，买能力而不是买焦虑。这和 4.5 是同一件事的两面：4.5 管「淘汰时留痕」，4.6 管「留痕的措辞形态」。

### 4.7 每条记忆带来源与时间戳

**原理**：写入时记录 `source`（哪个会话/文件/工具）与 `modified`（ISO 时间），读取时一并给模型。

**依据**：Claude Code auto memory 自动写 `modified` frontmatter 并说明「让 Claude 读回时知道这个事实有多新」；ChatGPT 的书本图标列出来源并解释为何使用；Zep 的 episode↔事实双向索引用于引用与溯源。

**为何可迁移**：两个直接收益——① 模型能自己判断新旧，不必靠人清理；② 出问题时能回答「它凭什么这么说」，这是把记忆系统从「黑盒」变成「可审计」的唯一低成本手段。dsh 的文件型记忆只需在 frontmatter 加两个字段。

### 4.8 写入必须有人类的否决面

**原理**：记忆的写入、修改、删除都要有一个**人可读可改的表面**；并提供「本次不写入」的通道。

**依据**：ChatGPT 的可编辑摘要 + 划词定点修正 + temporary chat；Claude 的项目作用域 + incognito + 管理员总开关；Claude Code 的 `/memory`（纯 Markdown，随便改删）；Windsurf 的 Memories 可在 UI 内编辑。

**为何可迁移**：污染的事后清理成本远高于事前拦截，而「人可读的表面」是最便宜的拦截点——它同时充当调试界面、审计界面和纠错入口。**特别值得抄的是 incognito 这一条**：它承认「我们防不住污染」，于是给一条不进池子的通道，而不是假装能洗干净。dsh 若记忆是文件型的，这一条天然满足（人可 `cat` 可 `edit`），要补的是「本次会话不写入」的显式开关。

---

## 5. 反面教材：被验证效果不好的做法

1. **把全上下文当记忆**。Mem0：全上下文在 token 上贵 10 倍以上、p95 延迟高 91%。更硬的是 context rot 白盒研究：**相关**与**无关**的长上下文失败率相同（都是 3/10 vs 干净的 8/10）——说明伤害来自长度本身，不是信息密度，所以「反正都相关，全塞进去」在数据上是错的。

2. **依赖模型自检来保证完整性**。同一长上下文条件下，「自查所有约束」通过 5/10，「给一份逐条列出 24 项义务的外部清单」通过 10/10。**模型的自检会忘掉它正在检查的那件事本身**。任何「请确认你没有遗漏」的提示词都是这一类的弱化版。

3. **递归摘要链（摘要的摘要）**。MemGPT 的队首递归摘要是这一形态的教科书案例，也是它最被后续系统替换的部分。Cognition 对此的判断更直接：压缩「很难做对」，值得投入专训一个压缩模型——**这等于承认通用摘要不够用**。

4. **静默压缩、且成功声明不受约束**。白盒研究：44 次失败运行里 38 次仍以「成功/安全/完成」收尾。压缩本身不可怕，**没有独立于 agent 自述的完成判据**才可怕。

5. **指针当载荷**。Cursor 官方明说 `@file` 不内联。把「必须始终生效」的约束寄托在一个 Agent 可能永远不去读的引用上，等于没有约束。判据很简单：这条约束如果 Agent 从不读那个文件，会不会出事？会，就不能只给指针。

6. **无版本地自我改写记忆**。A-MEM 的 memory evolution 会让新记忆回改旧记忆属性；第三方复盘的告诫是「不要静默重写高影响记忆」。Letta 自己的文档也承认 self-editing memory「可能导致意外行为或不一致」（*第三方转述官方文档*）。**让模型改自己的高影响记忆而不留旧值，是把不可逆性引进了最不该有的地方。**

7. **「什么都记」的流水账式记忆**。Cline Memory Bank 的指令原文是「我必须在**每个**任务开始时读**全部** memory bank 文件」——这是把重注入做到极致的形态，代价是它只能靠人工判断何时该收敛。Windsurf 的官方建议更直接地否定了纯自动记忆：**「对于你希望稳定复用的知识，请写成 Rule 或放进 AGENTS.md，而不是依赖自动生成的 Memories。」**【官方】——厂商自己承认自动记忆不可靠，这是很有信息量的一句话。

8. **把「永不遗忘」当卖点**。MemGPT 的「无限上下文」实际是「无限存储 + 有损工作集」。宣称与机制的差距在于：存储不遗忘，但**工作集每轮都在遗忘**，而后者才是用户感知到的能力。评审时应要求任何「记忆」宣称给出**工作集淘汰策略**，否则无法评估。

9. **多智能体并行写**。Cognition 两篇文章的连续结论：并行 writer 会因「动作携带隐式决策」而互相冲突；可行的收窄形态是「写单线程，其他 agent 只贡献智能」。他们自己承认这也带来新的失败面（子代理发现无法回流给兄弟）。

10. **承诺「记忆会自动保持最新」**。ChatGPT 的重构理由本身就是反证：手动/离散记忆会「过时且互相矛盾」，而新方案也只做到「自动降权过期项 + 用户可手改」——**没有任何一家公开说明它如何检测用户信念的变化**。任何声称「不用管，它会自己变新」的设计都应被要求给出机制，否则按宣称处理。

---

## 6. 参考链接

**论文（一手）**
- MemGPT: Towards LLMs as Operating Systems — https://arxiv.org/abs/2310.08560 ｜ 全文 https://arxiv.org/html/2310.08560v2
- Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory — https://arxiv.org/abs/2504.19413 ｜ 全文 https://arxiv.org/html/2504.19413v1
- Zep: A Temporal Knowledge Graph Architecture for Agent Memory — https://arxiv.org/abs/2501.13956 ｜ 全文 https://arxiv.org/html/2501.13956v1
- A-MEM: Agentic Memory for LLM Agents (NeurIPS 2025) — https://arxiv.org/abs/2502.12110
- Memory OS of AI Agent (EMNLP 2025) — https://aclanthology.org/2025.emnlp-main.1318/
- When and How Context Rot Appears in Coding Agents（白盒 context rot 实证，本文 §3/§5 多处引用）— https://arxiv.org/html/2607.17937v2

**官方文档 / 工程博客**
- Letta Context hierarchy（memory blocks / files / archival 的容量与访问模型）— https://docs.letta.com/v1-sdk/memory/context-hierarchy
- Claude Code: How Claude remembers your project（CLAUDE.md + auto memory + `modified` 时间戳 + 200 行/25KB 上限）— https://code.claude.com/docs/en/memory
- Claude Code: Explore the context window（**What survives compaction 表**，本文 §3.4 核心证据）— https://code.claude.com/docs/en/context-window ｜ 中文 https://code.claude.com/docs/zh-CN/context-window
- Claude Platform: Compaction overview（压缩的五个正交维度）— https://platform.claude.com/docs/en/build-with-claude/compaction ｜ 阈值压缩 https://platform.claude.com/docs/en/build-with-claude/compaction-threshold.md
- Anthropic Engineering: Effective context engineering for AI agents（context rot、just-in-time 检索、compaction / note-taking / sub-agent）— https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ※ 该页在当前网络环境下直连失败，本文相关引文经第三方存档转述核对，已在 §3 标注
- Cognition: Don't Build Multi-Agents（共享上下文 / 动作携带隐式决策 / 专用压缩模型）— https://cognition.ai/blog/dont-build-multi-agents
- Cognition: Multi-Agents: What's Actually Working（clean-context reviewer、smart friend、SWE-1.5 的负面结果）— https://cognition.com/blog/multi-agents-working
- Cursor Rules（四级激活、`@file` 不内联）— https://cursor.com/docs/rules
- Cursor Search / codebase（Instant Grep 本地索引、Explore 子代理）— https://cursor.com/docs/context/codebase-indexing
- Cline Memory Bank（6 文件结构、"MUST read ALL" 指令、Manual 更新流程）— https://docs.cline.bot/best-practices/memory-bank
- Windsurf Cascade Memories（自动 Memories vs Rules、**建议用 Rule 而非依赖自动 Memories**、规则长度上限）— https://docs.windsurf.com/zh/windsurf/cascade/memories
- LangGraph Persistence（checkpointer = 线程内短期，store = 跨线程长期）— https://docs.langchain.com/oss/python/langgraph/persistence
- GitHub Copilot: How Copilot understands your workspace（语义/文本/grep/文件/usages 多工具迭代检索）— https://code.visualstudio.com/docs/agents/reference/workspace-context.md
- Claude: Bringing memory to Claude（项目作用域记忆、记忆摘要可编辑、incognito、over-accommodation 安全测试）— https://claude.com/resources/articles/memory
- OpenAI Help: Memory in ChatGPT — https://help.openai.com/en/articles/8590148-memory-in-chatgpt （原文抓取受限，下述第三方整理引用了其 FAQ 条目）
- Cognee: Beyond Recall — Building Persistent Memory in AI Agents — https://www.cognee.ai/blog/tutorials/beyond-recall-building-persistent-memory-in-ai-agents-with-cognee

**第三方分析（观点性，已在正文标注）**
- How ChatGPT Memory Works（past.dev）— https://past.dev/blog/chatgpt-memory —— 逐条引用 OpenAI FAQ 与 release notes，整理 2024→2026 记忆架构演进与「马拉松/脚踝」重构理由
- Graphiti / Zep 独立复盘（第三方，指出知识更新类问题弱于全上下文、DMR 饱和）— https://huggingface.co/datasets/quantellence/srb-data/blob/main/datasets/public_ai_memory/papers/09_graphiti.md
- MemGPT 机制拆解（含 70%/100% 压力阈值与「调度由 LLM 驱动而非硬编码」）— https://huggingface.co/datasets/quantellence/srb-data/…/papers/02_memgpt.md
- Letta framework 分析（记录官方文档对 self-editing memory 的风险承认）— https://github.com/larsderidder/framework-analysis/blob/main/tier-1/letta.md
- A-MEM 复盘（对「静默重写高影响记忆」的批评）— https://raw.githubusercontent.com/lhl/agentic-memory/refs/heads/main/references/xu-a-mem.md
- Agent Memory Architectures 综述（sleep-time compute 演进）— https://raw.githubusercontent.com/MohamedAbdallah-14/prompt-to-asset/refs/heads/main/docs/research/30-agent-memory-state/30a-agent-memory-architectures.md
- ChatGPT 记忆系统中文整理（Dreaming V3、准确率 41.5%→82.8% 等厂商口径，未经独立验证）— https://baike.baidu.com/item/ChatGPT记忆系统/68022297
- How ChatGPT Remembers You（Embrace The Red，对上下文注入的逆向观察）— https://www.mbgsec.com/archive/2025-05-05-how-chatgpt-remembers-you-a-deep-dive-into-its-memory-and-chat-history-features-embrace-the-red/
