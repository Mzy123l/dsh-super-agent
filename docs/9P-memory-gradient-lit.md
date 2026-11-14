# 记忆梯度保真：文献调研

日期：2026-11-15。目的：为"近几步全量+总结并存（both），更早只有总结（summary-only），总结由当时运行的模型自己写"这一设计找理论依据与先例。标注：【论文】【官方】【第三方】。

## 1. 直接结论

**有强先例。** "近期逐字保留 + 远期只留总结、原文进可检索存储"不是我们的独创，而是当前主流生产系统（Claude Code、Cursor、LangChain v1）和研究系统（MemGPT、MemoryOS）的共同收敛点。差异主要在三个自由度上：

1. **边界怎么划**：所有先例都按 **token/条数阈值**（容量驱动、FIFO），没有一个按"重要性"划边界。这正好印证我们对 DSH 现状"从头上削"的批评——但注意，**头部 FIFO 削本身是行业标准做法**，我们批评的落点应该是"削完不检索/不总结"，而不是"按容量削"。
2. **总结谁写**：逐字保留近期 + 摘要远期的系统，摘要几乎都由**当时运行的那个模型**生成（MemGPT 自我编辑、Claude API compaction 用同一模型、Cursor Composer 把自摘要训进 RL）。"事后外挂模型写总结"只出现在 Letta sleep-time compute 和 MemoryOS 的 LLM 元信息提取里——且 Letta 明确说那是**离线巩固**，不在关键路径上，跑的是更强/另一个模型。两种范式并存，但"在线、同模型"是 compaction 路线的主流。
3. **并存（both）**：Claude 的 keep-tail compaction 是"摘要块 + 逐字近期尾巴"直接并存的最明确官方先例；MemGPT 的 FIFO 队列第一项就是递归总结，后面跟着全量近期消息。**"近全量+总结并存"就是这两个系统的默认形态**，我们不是孤例。

依据强度：强（多个独立生产系统 + 同期研究系统收敛到同一形态），但**总结保真度**这条有明确反例证据（见 §3.4），必须配上可检索原文才能安全使用。

## 2. 各系统先例表

| 系统 | 边界划法 | 总结谁写 | 原文去向 |
|---|---|---|---|
| MemGPT（Packer et al. 2023）【论文】 | FIFO 队列 + token 阈值：70% 触发"内存压力"警告，100% 强制 flush 并按比例逐出 | 当时运行的主模型（自我编辑 working context + 队列首递归总结） | recall storage（消息库，可检索回填）+ archival storage（pgvector） |
| MemoryOS（arXiv 2506.06326）【论文】 | 三层：STM 对话页 FIFO → MTM 分段页（话题+热度 Heat=访问数×页数×时间衰减）→ LPM 人格画像；热度淘汰 | 生成对话页/段摘要的 LLM（页面元信息两步生成：链判定+链摘要） | MTM/LPM 内部保留原文页，检索时两级（先段后页）召回 |
| Claude Code /compact（官方文档）【官方】 | token 容量驱动自动压缩；keep-tail compaction 官方 API beta（compact-2026-09-04）让开发者自选保留最后 N 轮逐字 | 压缩请求里同一个模型；v2.1.198 起继承会话的扩展思考设置 | /compact 后自动重读最多 5 个最近读过的文件（>5000 token 只留路径引用）；skill 重新注入（超预算最旧的先丢） |
| Claude API compaction【官方】 | 开发者自选切点，须落在无未闭合 tool call 处；kept turns 逐字回传 | 同一模型生成摘要块 | 旧消息只以摘要形式存在（API 层无自动检索回填） |
| Cursor Composer【官方】 | 固定 token 触发点暂停 → 自摘要 → 继续；摘要 ~1000 token，带会话状态（计划、剩余任务、已摘要次数） | **模型自己**，且把自摘要训进 RL（好摘要被奖励、丢关键信息的被降权） | 官方博客只描述摘要循环，未提原文检索回填（未找到证据） |
| LangChain v1 SummarizationMiddleware【官方】 | token 阈值触发，默认保留最近 20 条消息且 AI/tool 消息对不拆开 | 配置的 summarizer 模型（默认即主模型） | 旧消息被摘要替换；原文不进向量库（deepagents 变体可留文件路径） |
| Letta（MemGPT 产品化）【官方】 | core/recall/archival 三层 memory block | 在线摘要=主模型；**sleep-time compute**=空闲时后台 agent 重写记忆（可选更强模型，明确离线、不在关键路径） | recall/archival 可检索 |
| AWM（arXiv 2409.07429）【论文】 | 不做逐字压缩；从轨迹中归纳可复用 workflow 存入记忆库 | 任务模型自己归纳（online 模式边跑边归纳） | workflow 库，按相关性检索注入 |
| Reflexion（arXiv 2303.11366）【论文】 | 不做逐字压缩；失败后生成言语反思存入 episodic buffer | 自反思模型（同模型族） | 反思记忆 buffer，下轮注入 |
| Chain of Agents（arXiv 2406.02818）【论文】 | 分块串行：worker 逐块处理，传递滚动有用信息摘要给下一个 worker | 每个 worker 用同一个底层模型 | 前文不保留原文，只有传递的摘要（设计如此，非缺陷） |
| Voyager（arXiv 2305.16291）【论文】 | 不压缩对话；技能以可执行代码入库 | 同模型自写代码技能 | 技能库（向量检索描述后取回代码） |
| LLMLingua / LongLLMLingua【论文】 | token 级压缩，不摘要 | 无生成式摘要（小模型 perplexity 删 token） | 原文不可恢复（有损删除） |

## 3. 六个问题的回答

### 3.1 "近全量+远总结"的先例有哪些？边界怎么划？

**先例明确且多**：MemGPT（队列首放递归总结 + 队列内全量近期消息，[arXiv 2310.08560 §2.2](https://arxiv.org/abs/2310.08560)）；Claude keep-tail compaction（摘要块在前、最后 N 轮逐字在后，官方 API，[Compaction 文档](https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns)）；LangChain SummarizationMiddleware（默认保最近 20 条 + 摘要前文，[源码](https://github.com/langchain-ai/langchain/blob/master/libs/langchain_v1/langchain/agents/middleware/summarization.py)）；MemoryOS（STM FIFO 保实时对话 + MTM/LPM 存摘要与画像，[arXiv 2506.06326](https://arxiv.org/abs/2506.06326)）。

**边界划法**：全部是**容量/阈值驱动**（token 数或消息条数），不是重要性驱动。MemGPT 用 70%/100% 两级阈值；Claude Code 按容量自动压缩、keep-tail 让开发者指定保留轮数（无参数自动决定保留谁，切点由开发者选）；LangChain 默认 20 条/4000 token。MemoryOS 的"重要性"体现在**远期层内部**（Heat 热度淘汰），不在边界划分上。结论：**边界按容量划是共识；"重要性"应放在远期层的淘汰/检索里，不要试图用重要性划近期/远期边界**（没有先例这么做，且语义盲区风险高——EMNLP 2026 压缩综述把这类纯长度触发策略的弱点明确称为 semantic blindness）。

### 3.2 总结由"当时的模型"写 vs "事后外挂模型"——有对比吗？

**没有找到严格 controlled 对比实验**（同任务、同数据，比较"主模型自写"与"外挂模型写"的摘要质量对下游成功率的影响）——这一点如实标注：未找到。

但两条路线的定位讨论是清晰的：

- **在线/同模型**：MemGPT 全部自我编辑（模型自主决定存什么、摘要什么）；Claude compaction 用同一模型（[keep-tail 文档](https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns)）；Cursor 最激进——把自摘要**训进 RL 循环**，因为"compaction 会导致模型遗忘关键信息"是他们的动机（[self-summarization 博客](https://cursor.com/en-US/blog/self-summarization)）。
- **离线/可外挂**：Letta sleep-time compute 让后台 agent 在空闲时重写记忆、可用更强模型（[Letta 博客](https://www.letta.com/blog/sleep-time-compute)），定位是"off the critical path"——即承认在线摘要会占关键路径，事后巩固是补充而非替代。
- **关键证据**：Cursor 实测，**训练过的自摘要比精心调优的提示词压缩基线（几千 token 的摘要提示 + 平均 5000+ token 的结构化摘要输出）错误率降 50%、摘要只 1/5 长（~1000 token）**。理由：模型通过训练学会了"该留什么"。这直接支持"当时的模型自己写"——前提是它了解自己的任务状态。没有训练的纯 prompt 自摘要（如 Claude compaction）是保守版本：仍同模型，但没有 RL 强化。
- **风险面**：MemoryOS 的页面元信息由 LLM 两步生成（链判定+链摘要），属于"同模型写元信息"，论文没有讨论外挂对比；EMNLP 2026 压缩综述明确列出"controller 与执行 agent 解耦"（可能是小模型）这一设计空间，指出其好处是模块化、代价是额外延迟和 token 开销，且**没有给出谁更优的定论**。

**结论**：我们的 turn-summary"模型自选写不写、自己写"属于在线同模型路线，先例充分（MemGPT→Cursor 谱系）；但 Cursor 的证据表明**没有训练信号的纯 prompt 自摘要质量参差**，需要靠"原文可检索"兜底（见 3.4），而不是靠摘要本身完美。

### 3.3 "全量+总结并存"（近期）相比"只有总结"的价值证据？

- **直接证据（训练来源）**：Cursor 把"summary + 会话状态"作为继续生成的新上下文，逐字内容在摘要中被压缩；但其 RL 信号来自完整轨迹——未直接对比 both vs summary-only。
- **MemGPT 对照实验**：DMR 任务里，baseline 只拿到"过去五轮的有损摘要"，MemGPT 拿到全量历史（经检索分页进入上下文）；结果是 MemGPT 大幅领先（GPT-4 32.1%→92.5% 准确率，[arXiv 2310.08560 表2](https://arxiv.org/abs/2310.08560)）。注意这个实验测的是"摘要 vs 全量检索"，不是"近期并存 vs 全摘要"，但方向明确：**摘要不够用，模型需要能拿到原文**。
- **结构证据**：Claude keep-tail compaction 的官方存在本身就是最直接的论据——Anthropic 认为"旧历史摘要 + 近期逐字"比"全部摘要"值得做成 API 功能。文档里 kept turns 连 thinking blocks 都原样回传（因为截断会破坏 thinking 验证），说明近期逐字保留对**推理连贯性**有功能价值，不只是记忆价值。
- **位置效应佐证**：lost in the middle（[arXiv 2307.03172](https://arxiv.org/abs/2307.03172)）显示模型对开头/结尾敏感、中间易丢——近期消息天然在上下文尾部，逐字保留它们恰好落在模型最可靠的位置；远期内容位置靠后（被总结），丢失风险本来就高，用摘要+检索补偿是合理的分层。
- **未找到**：直接对比"近 N 轮 both vs 近 N 轮 summary-only"的受控实验。我们自己的 9I-ab 实验正好补这个空白。

### 3.4 总结丢关键信息导致失败的案例研究？

**有，而且这是我们设计最大的风险点的直接证据**：

- **Cursor（最强证据）**：明确指出 compaction（无论提示词摘要还是滑动窗口）"可能导致模型遗忘上下文中的关键信息，降低长任务有效性"；他们的 RL 训练就是对着这个问题去的，且 case study 里 Composer 的自摘要含"what's still broken / to do for the next assistant"段落——**摘要必须承载交接信息**这一点被产品化验证（[self-summarization 博客](https://cursor.com/en-US/blog/self-summarization)）。
- **EMNLP 2026 压缩综述**（[ACL Anthology](https://aclanthology.org/2026.emnlp-main.2396.pdf)）：形式化三个失败模式——**F1 压缩前决策错误**（该压的没压/不该压的压了）、**F2 压缩中信息丢失**、**F3 压缩后访问失败**（信息存了但取不回）。我们的设计里 F2 对应"turn-summary 写漏"，F3 对应"原文进了日志/向量库但检索不到"。综述指出 F3 是被低估的失败面——存了不等于能取回。
- **Claude Code 官方缓解措施**：/compact 后自动重读最近改动的最多 5 个文件、重新注入 skill——承认摘要会丢，用**确定性的重注入**补偿（[Claude Code 上下文文档](https://code.claude.com/docs/zh-TW/context-window)）。
- **LLMLingua 路线的对照**：token 级压缩不做语义改写，保真度问题不同（删错 token 而非写错摘要）；LongLLMLingua 在高压缩比下"难以保留重要信息"（[EMNLP Findings 2024](https://aclanthology.org/2024.findings-emnlp.864.pdf)），说明任何有损压缩在高压缩率下都危险，语义摘要的优势是可读性和可交接性，不是无损性。

**结论**：摘要丢信息不是"会不会"而是"何时"的问题。所有先例的应对都是同一招：**原文永久保留 + 确定性回填（重读文件/检索）+ 摘要只作为默认视角**。我们的设计（原文进日志/向量库）方向正确，但必须把"回填"做成一等公民，不能只是"可检索"。

### 3.5 梯度/分级记忆有形式化框架吗？

**有**：

- **MemGPT 的 context hierarchy**：main context（系统指令/working context/FIFO 队列）+ external context（recall/archival）两级，OS 分页隐喻，队列首放递归总结是明确的"梯度"实现（[arXiv 2310.08560 §2](https://arxiv.org/abs/2310.08560)）。
- **MemoryOS 三层**：STM（实时对话页）→ MTM（分段页，话题聚类+热度）→ LPM（人格画像），更新机制形式化（FIFO、Heat=α·N_visit+β·L_interaction+γ·R_recency、时间衰减 exp(−Δt/μ)），LoCoMo 上 F1 平均提升 49.11%（[arXiv 2506.06326](https://arxiv.org/abs/2506.06326)）。
- **Letta 三层**：core（memory block，模型可编辑）/ recall（历史可检索）/ archival（长期库），sleep-time compute 做离线巩固。
- **EMNLP 2026 综述的抽象**：Select / Compress / Store / Recover 四算子 + 控制策略（系统触发 vs agent 自主触发），是目前最接近"梯度保真"的统一形式化语言。
- **未找到**：把"保真度"本身作为显式维度（多级保真度数值化、逐级降级策略）的形式化框架——MemoryOS 的三层是**存储位置**分层，不是**保真度**连续梯度。"梯度保真"作为一个明确术语和框架，未见文献使用；最接近的是 Claude 的"逐字尾巴+摘要头"两级实践。

### 3.6 （补充）模型自写总结/技能库的先例谱系

Reflexion（自反思言语记忆，[arXiv 2303.11366](https://arxiv.org/abs/2303.11366)）→ AWM（自归纳 workflow，online 模式边跑边归纳，[arXiv 2409.07429](https://arxiv.org/abs/2409.07429)）→ Voyager（自写可执行技能库，[arXiv 2305.16291](https://arxiv.org/abs/2305.16291)）→ Chain of Agents（worker 间滚动摘要交接，[arXiv 2406.02818](https://arxiv.org/abs/2406.02818)）→ Cursor Composer（自摘要训进 RL）。共同点：**记忆产物由当时的任务模型自己生成**，且产物质量直接决定下游表现——这是我们 turn-summary"模型自选写不写"设计的谱系依据。区别：这条谱系全是"任务结束/段落后"写，没有"每轮实时可选"的先例（turn-summary 的实时性是我们在谱系上的增量，无直接先例，需实验验证）。

## 4. 对我们设计的印证与修正建议

### 照做（文献支持充分）

1. **近全量+总结并存**：照做。Claude keep-tail compaction 和 MemGPT 队列结构是直接同构先例，可以引用为设计依据。
2. **总结由当时的模型写**：照做。谱系（Reflexion→AWM→Composer）支持"同模型、了解任务状态"写总结；Cursor 数据表明同模型自摘要可以显著优于通用提示词压缩。
3. **原文进可检索存储**：照做，但见第 2 条修正——"存了"不等于"能用"。

### 要改/要补（文献揭示的风险与空白）

1. **回填要做成一等公民，不只是"可检索"**。最大的修正：EMNLP 综述的 F3（post-compression access failure）说明存进向量库/日志后取不回是独立失败面。MemGPT 对应物是"队列管理器把检索结果**主动回填**到队尾"；Claude Code 是 /compact 后**确定性重读 5 个文件**。建议：turn-summary 写入时**同时记录它覆盖的原文区间指针**，近期窗口滑出后，若下一步命中相关区间（或检索命中），由 harness 确定性回填原文片段，而不是指望模型主动去查。**这是本次调研最重要的一条修正。**
2. **边界按容量划，别按重要性划**。所有先例都用 token/条数阈值；把重要性判断留给远期层的淘汰（MemoryOS Heat）和检索排序，不要试图让边界智能化。我们已有的"压缩从头上削"批评应修正为：**头部 FIFO 削本身没错，错的是削掉的不进总结、总结不挂原文指针**。
3. **摘要必须承载交接信息，不只是"发生了什么"**。Cursor 的摘要模板含 goal / what was implemented / errors & fixes / **what's still broken** / paths。我们的 turn-summary 提示词应要求类似结构（当前目标、已做、失败尝试、待办、关键路径），否则下轮模型拿到摘要也无法接续。Cursor 把"丢关键信息的摘要"在 RL 中降权——我们没有训练信号，只能靠结构化模板 + 原文兜底。
4. **turn-summary"模型自选写不写"无直接先例，需要护栏**。谱系全是段落后写（失败后/任务后/容量触发），没有每轮实时自选。风险：模型选择不写导致信息直接丢进 FIFO（比 MemGPT 的"容量警告后强制写"更弱）。建议加一条 MemGPT 式机制：容量警告（如 70%）时**强制触发**一次 turn-summary 机会，自选只在平时生效——把"自选"限制在无压力区间，压力区间退化成 MemGPT 行为。这一点文献不冲突但也不背书，标注为需实验（9I-ab）验证。
5. **近期"both"的并存形式**：总结放前面还是后面？Claude 是摘要块在前、逐字在后（切点前旧消息→摘要，kept turns 原样跟随）；MemGPT 是递归总结在队首、近期消息在后。两家一致：**摘要永远在逐字内容之前**。我们如果近期也写 turn-summary，应同样放在该轮逐字内容之前（或明确标注为前置摘要），不要混排。
6. **reasoning 逐字回传是独立问题**。本次调研的先例全部针对"对话/工具结果"通道；Claude 文档显示 thinking blocks 在压缩后是**被特殊处理的**（kept turns 原样保留以维持思考有效性，摘要继承思考设置）。我们"reasoning 逐字回传、无开关、257 步堆叠"的问题在文献里没有直接对应物——这既是机会（无先例包袱）也是风险（无证据背书），建议把 reasoning 通道的治理与消息通道的梯度保真**分开设计**，不要套用同一个梯度策略。

## 5. 参考链接清单

【论文】
- MemGPT: Towards LLMs as Operating Systems — https://arxiv.org/abs/2310.08560
- MemoryOS of AI Agent — https://arxiv.org/abs/2506.06326
- A Survey on the Memory Mechanism of LLM-based Agents — https://arxiv.org/abs/2404.13501
- Agent Workflow Memory — https://arxiv.org/abs/2409.07429
- Reflexion — https://arxiv.org/abs/2303.11366
- Chain of Agents — https://arxiv.org/abs/2406.02818
- Voyager — https://arxiv.org/abs/2305.16291
- Lost in the Middle — https://arxiv.org/abs/2307.03172
- LLMLingua — https://arxiv.org/abs/2310.05736；LongLLMLingua — https://arxiv.org/abs/2312.06827
- Context Compression for LLM Agents: A Survey of Methods, Failure Modes, and Evaluation（EMNLP 2026）— https://aclanthology.org/2026.emnlp-main.2396.pdf

【官方】
- Claude API Compaction（keep-tail）— https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns
- Claude Code 上下文窗口（/compact 行为）— https://code.claude.com/docs/zh-TW/context-window
- Cursor: Training Composer for longer horizons（self-summarization）— https://cursor.com/en-US/blog/self-summarization
- LangChain SummarizationMiddleware — https://github.com/langchain-ai/langchain/blob/master/libs/langchain_v1/langchain/agents/middleware/summarization.py
- Letta Sleep-time Compute — https://www.letta.com/blog/sleep-time-compute

【第三方】
- Anthropic: Effective Context Engineering for AI Agents（context rot；原文直抓未成功，引用第三方镜像记录）— https://raw.githubusercontent.com/ismailkhan313/tech-llm-wiki/refs/heads/main/references/anthropic-effective-context-engineering.md （原始 URL：https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents）
- Letta sleep-time agent 实践 — https://dreaming.press/posts/letta-sleep-time-agent-dream-subagent.html

**未找到项**（如实标注）：① "主模型自写 vs 外挂模型写"的受控对比实验；② "近 N 轮 both vs summary-only"的受控实验；③ 以"保真度"为显式维度的形式化分级框架；④ 每轮实时自选写总结的先例。
