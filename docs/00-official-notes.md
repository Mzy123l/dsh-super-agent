# 官方架构学习笔记

> 材料来源：官方设计长文《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31），
> 以及官方原型仓库 `deepseek-ai/dsh-superagent-prototype`（单次提交，src 约 1.49 万行 TS，tests 约 1.44 万行、59 个 spec 文件，MIT）。
> 本文引用的行号与文件路径均对应该仓库 `8c32a9d` 这一提交。
> 本文只记录「读到了什么」，判断与取舍放在 [20-design.md](20-design.md)。

## 1. 问题的定义方式

长文先把问题从「怎么把一件事做好」挪到「一个 Agent 怎么在组织里常驻」，给出四个特征，
并且每个特征都对应一个**在单 ReAct Loop 结构之外**的要求：

| 特征 | 工程要求 | 单循环为什么做不到 | 对应模块 |
| --- | --- | --- | --- |
| 连续 | 不同渠道（IM、PR 评论、CI）里关于同一件事的信息自动接到同一任务 | 上下文是一条线性历史 | 事件驱动：Thread 订阅 + 链式召回 |
| 高效 | 上一条没做完就能接下一条；多任务并行且不互相污染 | 串行：跑五分钟的工具调用期间听不见新消息 | 双层架构 + 异步 ReAct Loop |
| 主动 | 持续观察环境事件，值得处理的推进，不值得的保持安静 | 由人的输入驱动，没人说话就停 | 事件驱动：两级过滤 + 投机执行 |
| 持久 | 始终在线、接入真实环境、异常时自己恢复 | 生命周期等于一个进程 | 存算分离 + Watchdog |

这套论证的关键在于：**四个特征每一个都在单循环的结构之外**，所以解法只能在循环外面加一层系统结构，
而不是把提示词写得更好。这一点被实验数据坐实（见 §5）。

## 2. 五个模块

### 2.1 双层架构（Router / Worker）

- **Router 只做两件事**：承接所有入口的人类交互、处理任务之间的分派与协调。它不介入单任务内部怎么拆，不亲自执行。
- Router 是全局的**序点（Sequence Point）、协调点和记忆**，但它刻意保持轻量——长文说它「甚至可以不配 Bash」。
- **Worker 决定结果质量**，配最强的模型，但不直接对外说话，只向 Router 汇报，由 Router 统一回复。
- 长文对「常见的 Agent Team」做了区分：Team Lead 需要理解任务细节、拆子任务、高频协调，自己背着很重的推理负载，最后变成新的瓶颈；
  Router 只处理**任务之间**的高层关联。
- **批处理让单 Router 不容易成为瓶颈**：上一轮推理期间到达的事件积压，下一轮一起处理；
  Router 每步是长输入短输出，合并进一次调用会在 Prefill 阶段并行计算，耗时增长远慢于 batch 大小。
- 扩展性上，长文明确说 Router 层内部**不必**是单个 Session：规模更大时可以多层过滤或水平切分，
  但切得越细、分片之间的上下文连续性越低——这是「全局记忆被解决之前始终存在」的权衡。

**原型怎么把这件事写进配置而不是提示词**（`cordis.patch.yml`）：

| | Router preset（`dsh-superagent-router`） | Worker preset（`dsh-superagent-worker`） |
| --- | --- | --- |
| 文件工具 | 只读（`write: false, edit: false`） | 读写俱全 |
| shell | 有，前台 5 秒转后台 | 有，前台 5 秒转后台 |
| job 等待 | 上限 5 秒 | 上限 5 秒 |
| subagent | 无 | 有（spawn，跑在 `standard` preset） |
| web / 文件搜索 / todo | 无 | 有 |
| 向人提问 / present / 改 profile / 调度 | 无 | 无 |

Router 保留 bash 但被 `noWait` 守卫约束（`src/app/sessions.ts:77`）：拒绝在命令位置调 `sleep`、
拒绝 `timeoutMs > 30s`、拒绝 `job_output` 等待超过 5 秒。理由是「汇报和作业结果会自动以消息形式到达，等待只会延误新候选」。

路由备注有硬上限 **30 词**（中文按分词计数），只写路由背景与人的显式约束，不写实现指导。

### 2.2 事件驱动：一条 Trigger 的四道关

**第一关：要不要处理？** 借鉴 Fast Path / Slow Path 做两级过滤：

- **Gate（程序，确定性）**：消息来源、群组范围、用户/机器人白名单。输出「强度」：
  白名单里的人 @ 了 Agent = `explicit`；不在名单上的人或 bot 的消息最多 `inferred`；其他不准入。
- **Assessment（模型，语义）**：只对 `inferred` 候选跑完整评估，同时作为面向人类的自然语言扩展点。

**第二关：该给谁？** `Thread`（同一 IM 话题、同一封邮件串、同一个 PR）上的第一条消息由 Router 建 Worker 后，
该 Worker 订阅这条 Thread，后续消息由程序直通，不再经过 Router。订阅是**多对多**的。

消融实验：去掉直通后任务完成时间基本不变，但 Router 决策数 +30%，总缓存读 token 2323 万 → 3177 万（+37%）。
直通买的是 Router 的 token 与推理开销，不是速度。

**第三关：怎么找回之前那件事？** 把上下文窗口当 Cache 管：

- **Inline**：近期很可能用到的信息直接内联，省一次工具调用；
- **Spill**：放不下的完整内容留在窗口外，只留摘要和续读入口；
- **链式召回（Chain of Recall）**：每个 Trigger / Thread / Worker Session 都有 ID，注入时内联紧密相关对象的 ID，
  于是对象之间构成引用图，模型可以从当前消息 → 所在 Thread → 相关 Worker → 该 Worker 的另一个 PR Thread 逐跳展开。

长文自己承认局限：链式召回解决的是**近期**任务的检索，跨月的长程记忆仍是开放问题。

**第四关：还没正式下指令，能不能先准备？** 投机执行。内部群里配一条「静默复现并修复」策略：
后台复现、分析、找修复，只有确认问题存在且修复简单才提交，否则全程安静。**改变的是准备的时机，不是谁有权决定。**

### 2.3 面向人的交互

- **异步 ReAct Loop（全双工）**：把耗时的命令与子任务调用从同步 `run()` 改成 `start()` / `stop()`，
  `start()` 立即返回 Started，后台完成后把结果作为新事件消息投递回会话。
  长文明说这个机制「已经在 DeepSeek Harness 中实现，但尚未默认开启」。
- **多信道**：IM 侧重低打扰（单条回复**不超过 100 词**的硬规定），GitHub / 邮件 / 文档侧重结构化高密度交付。
  Worker 内部冗长的推理与密集的工具调用被隔离，不输出到外部信道。

### 2.4 计算、状态与环境的分离

分两步解耦三样东西（计算 / 状态 / 执行环境）：

1. **计算与状态分离**：Agent Loop 放进云端无状态弹性容器，Session 状态存数据库。容器可水平扩展、重启、替换。
2. **计算与执行环境分离**：环境**不搬**。端侧只装一个不保存会话状态的轻量 daemon，只执行命令、返回结果，像 CI 的 Runner。
   电脑离线时任务在云端等，第二天开机云端 Agent 核对等待中的步骤再写回。

长文补了一句很关键的话：**共享状态解决的是换台服务器还能找到状态，并不保证正在执行的工作自动恢复**——
Agent 还需要知道接着执行哪一步、上一条工具命令是否已经生效。状态保存是恢复的基础，不是恢复的全部。

长文也点了对应的安全代价：云端被攻破 / 被提示词注入时，连接的所有端侧设备都面临风险；
即使没被攻破，只要端侧凭据能进模型上下文就有泄露风险，需要「让 Agent 完全不接触凭据本身地使用凭据」。

### 2.5 Watchdog

嵌入式的看门狗 + 分布式的外部控制回路，但 Agent 场景的不同点是：**很多故障不是进程崩溃**。

> 晚上八点，Worker 进程一切正常，但它已经第五次调整同一张图表的配色。进程活着，任务没推进。

所以要监控**两层**：基础设施是否存活，任务本身有没有进展。Watchdog 本身是一个完整的 Agent Session，
用定时消息驱动，维护者可以用自然语言问它「昨晚汇报任务为什么卡住了」，也可以让它在线修正主系统的提示词与触发规则。

## 3. 原型的领域模型（真正值得逐行读的部分）

十个概念，一条主线：

```
Source ──Trigger──> Thread ──batch──> Eval ──accept──> Ticket ──Assignment──> Executor
                       │                                  │
                       └──Subscription fan-out────────────┘
Ticket ──Channel──> Source（回复、PR、评审结论）
```

| 概念 | 一句话 | 关键规则 |
| --- | --- | --- |
| Source | 一路事件流 | 持有读位与自己的 bot 身份；重启不得重放事件；丢弃 bot 自己的消息 |
| Trigger | 一个不可变事件 | 属于一条或多条 Thread；同一个 Trigger 接受两次只产生一个 Ticket（幂等与审计的单位） |
| Thread | 时间有序的 Trigger 序列 | 同一时刻最多一个 Eval 在跑；可以有多张 Ticket；持有订阅、进行中的 Eval 与决策历史 |
| Correlation | 一个 Trigger 所跨 Thread 之间的关系 | **只加上下文，永不路由** |
| Channel | Thread 的写侧 | 一条 Thread 可有多个 Channel；确认、回复、PR、评审结论都是写 |
| Policy | 带版本号的评估规则 + 每 Source 的授权部分 | 规则、accept 模式、Source 部分构成版本；**不跨 Source 映射身份** |
| Eval | 对一批 Trigger 的判断（gate + assessment 两层） | 无状态；输入是批次、Thread 快照、该 Thread 全部 Ticket、当前 Policy |
| Mandate | accept 授予的东西 | **不可变**；范围变宽必须新开 Ticket；只有人的 stop 撤销、重新校验失败吊销 |
| Ticket | 一个被授权的工作单元 | 只有 Eval 能创建；open ↔ ended；定义自己的状态而不是跟随 Executor |
| Assignment | Ticket 与一次 Executor 实例的绑定 | 一个 Ticket 先后可有多个；只有最终报告能在 Executor 侧结束 Ticket |
| Subscription | Ticket 与 Thread 的多对多关系 | 扇出**绕过 Gate 但不赋予新权限**；结束的 Ticket 保留订阅，人的一句话可在同一 Mandate 下恢复它 |

### 3.1 授权是主轴

> 消息、评论和引用的文档是决策的输入，它们不能改变这些权限。

- **三种操作能改变 Mandate**：accept 创建、人的 stop 撤销、重新校验失败吊销。
- **Policy 改了不杀正在跑的 Ticket**，只投递一条 `policy-changed` 输入；等它结束后被人唤醒时才重新校验。理由是「取消一个跑到一半的变更会留下半成品」。
- **accept 三档**：`off` / `observe`（默认）/ `auto`。`observe` 下模型评估通过的候选只记录为「本来会接」（`would_accept`），不真执行。这是一条很稳的上线路径。
- **admission 表**：行是接收范围，列是「在不在名单上 × 有没有 @ Agent」。
- **人在 Ticket 自己的 Thread 上发的消息归该 Worker 决定**；此时 Router 只能做一件事——按人的要求 stop。
- **结束的 Ticket 保留订阅**：PR 合并两周后有人说「这里好像有个回归」，当初那个 Worker 的 Session 和目录还在，直接接着干。

### 3.2 「被拒绝的概念」表

这份表比概念表更有价值——它记录了设计者踩过的坑：

| 被拒绝的 | 理由 |
| --- | --- |
| 把「人」/成员关系做成实体，或跨 Source 映射身份 | 人是 Trigger 的元数据；名单是 Source 的 Policy 部分；跨 Source 映射是提示词文本 |
| Eval 自己调度延迟触发的 Trigger | 需要等待的条件就是一个普通 Source，Eval 永不反向依赖 Source |
| Eval 的「等待」「撤销」状态 | 等待属于 Source；超时的 Eval 重新排队或记 `unavailable` |
| 一条 Thread 最多一张活跃 Ticket | 一条 Thread 可以承载多件独立的工作 |
| 「追加到 Ticket」这种 Decision | 追加就是订阅扇出，不需要 Eval |
| 在订阅上做准入检查 | 订阅覆盖整条 Thread；**Mandate 把授权和上下文分开** |
| Correlation 参与路由 | 订阅负责路由；Correlation 只加上下文 |
| Ticket 状态跟随 dsh Session | Ticket 可被交接、恢复、多个 Executor 跑，必须有自己的状态 |
| Executor 声明「人说停了」 | 只有 Eval 能判定结束的强度 |
| Policy 变更时取消运行中的 Ticket | 取消会留下半成品；改为记录并投递 |
| Executor 失败或阻塞时锁住它全部工具 | 会挡住人直接在 Session 里工作，也挡住恢复后的报告；暂停自动输入就够了 |
| 从报告自由文本推断「在等人」 | 分类要靠结构化字段，Executor 用 `human_action` 主动问 |

## 4. 工程约束（最值得抄的部分）

### 4.1 Engine 的形状

- **`src/core` 不导入自己之外的任何东西**（除 Node 的 hash），**不做 I/O**。
- **Engine 是 Trigger / Thread / Decision / Ticket / Assignment 的唯一写者**，所有方法同步，每个命令在一个事务里改完它的聚合。
- **调用方只拿到自己角色的 `Pick` 类型**：`EngineForSources` / `EngineForMainSession` / `EngineForPeople` / `EngineForSettings` / `EngineForExecutor`，各看各的。
- **请求用祈使句且可以被拒绝**（`stopTicket`），**事实用过去式且只是记录**（`assignmentStarted`）。
- Engine 内部拆成五块，依赖单向流动：

```
Intake → Tickets
Evals  → Tickets
Tickets → Replies
Assignments → Tickets, Replies
Replies → （无依赖）
```

### 4.2 Stored work：先存，后做

所有对外副作用（给主 Session 投递候选、启动 Worker、投递消息、发回复）都先写进 SQLite 的 `effect` 表，
**事务提交之后才真正执行**，失败按指数退避重试。

| effect kind | 干什么 | 并发 | 退避 |
| --- | --- | --- | --- |
| `assessment` | 把候选卡片送进主 Session 的轮次 | 4 | 2s → 60s |
| `launch` | 启动一个待跑的 Assignment | 空闲 worker 槽 | 5s → 300s，三次 |
| `delivery` | 按序把等待的 Input 投给运行中的 Assignment | 4 | 2s → 60s |
| `relay` | 把 Worker 报告/问题、人的跟进送进主 Session | 1，严格有序 | 2s → 60s |
| `notice` | 只注入通知，不唤醒主 Session | 1，严格有序 | 2s → 60s |
| `reply` | 通过 Source 的 Channel 发消息 | 1 | 5s → 300s |

失败是**连续三次**才在系统问题里报错（避免偶发故障刷屏），`delivery` 例外——它的失败显示在自己的 Ticket 上。

### 4.3 Worker 槽位与恢复

- 一个 Ticket 从启动（含 prepare）或从唤醒空闲 Worker 的投递开始占槽，直到本轮结束。
- **额外留一个槽给人**：人的消息可以用「上限 + 1」，唤醒优先于新启动。设计意图直说：**新工作不能阻止人继续一个已有的 Ticket**。
- 一轮结束后仍有 shell job 或 subagent 在跑，Ticket 继续占槽、保持 working，不报 waiting。
- 后台工作最多 30 分钟，到点杀掉 shell 作业并报告 waiting；subagent 允许继续。
- 重启时正在跑的派工以 `host restarted` 结束，新派工带一条恢复提示：「先检查目录、git 历史和 GitHub，再重复任何对外动作」，最老的 Ticket 先恢复。

### 4.4 部署与隔离的诚实描述

原型的原话：这些垫片和目录「establish defaults, not a security boundary. A worker can still execute a program by absolute path.」

具体做法：每个 Ticket 一个 git worktree 目录；一组命令垫片放在 `PATH` 最前面（`gh` 走 Agent 自己的账号，`lark-cli` 走机器人，操作员的个人 CLI 列为屏蔽命令）；
一份独立的 git 配置替换操作员的全局配置；GitHub SSH 地址改写成 HTTPS；`GH_TOKEN` / `GITHUB_TOKEN` 从环境里删掉。

部署要求用**独立的 dsh profile**，因为插件会改进程级 `PATH` 和 git 设置。

## 5. 实验数据

### 5.1 消融实验

约 300 条消息里混着约 20 个工作请求，每种方案跑 5 次，编码工作用只消耗时间的工具代替（衡量调度与协作，不衡量执行能力）。

| 方案 | 分工情况 | 完成时间 |
| --- | --- | --- |
| 单 Session + Subagent，中性提示词 | 5 次里一次都没调用 Subagent，全部自己干 | p95 **29.5 分钟** |
| 单 Session + Subagent，优先委派提示词 | 5 次里 4 次分了工，剩下 1 次判断活「很小」自己干，形成长尾 | 仍慢于双层 |
| 双层架构 | 由架构保证分工 | p50 **12.4** / p95 **15.7 分钟** |

结论比数字重要：**分不分工不该取决于提示词写得好不好、模型怎么判断，应该由架构保证**。
靠提示词纠正的成功率是 4/5，生产系统里那 1/5 就是事故。

### 5.2 Router 批处理压测

待决定 Trigger 从约 1 条/分钟升到约 40 条/分钟：

| 指标 | 低负载 | 高负载 |
| --- | --- | --- |
| 平均 batch | 1.0 | 2.8 |
| 单次请求耗时 | 2.5s | 3.9s |
| 单个决定分摊推理时间 | 6.4s | **1.6s** |

批处理提高的是**有效吞吐**，不保证每条消息的等待时间都更短。

### 5.3 代价

Super-agent 单次实验的读缓存 token **高于**单 Session——效率是用 token 换来的。长文没有回避这一点。

## 6. 与主流 Harness 的层次差异

| 维度 | Super-agent | LangChain Deep Agents | Claude Agent SDK |
| --- | --- | --- | --- |
| 生命周期单位 | 常驻 Router + 每 Ticket 一个 Worker，结束后可被人的消息恢复 | 一次 invoke / 一个 thread | 一次会话 |
| 多任务隔离 | 架构保证：不同 Ticket 不同 Session 不同目录 | 同一次运行内隔离上下文 | 同一会话内 |
| 事件来源 | Source 插件 | 无内置 | 无内置 |
| 授权模型 | Policy 版本 + Mandate + 白名单 + admission 表，代码强制 | 按工具审批 | hooks + 权限模式 |
| 持久性 | SQLite 存全部领域状态与副作用队列 | checkpointer | 自建 |
| 对人说话的约束 | 只在人必须行动或能用结果时说，≤100 词 | 无 | 无 |

真正的分层差异：**Deep Agents 和 Claude Agent SDK 解决「一个 Agent 怎么把一件事做好」，Super-agent 解决「一个 Agent 怎么在组织里常驻」**。
两者不冲突——理论上可以把 Deep Agents 当 Worker 塞进 Router/Worker 结构里。

## 7. 我读出来的关键判断

1. **瓶颈已经从模型转到人的注意力。** 所以系统级指标不该是单次任务成功率，而是「每一个人类决定能换来多少 Agent 工作量」。
2. **架构保证 > 提示词约束。** 4/5 和 5/5 的差距在生产环境里是事故与无事故的差距。
3. **授权比并发更难补。** Mandate、accept 三档、100 词上限、只在人必须行动时才开口——这些规则比 Router/Worker 更难事后加。
4. **「被拒绝的概念」表是最便宜的资产。** 它把团队踩过的坑变成了先验。
5. **原型是「可运行的设计文档」，不是框架。** 它的价值在设计，不在现成可用。
