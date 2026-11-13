# 差距分析：设计目标 vs 原型实现

> 目的：把「长文说要什么」「原型做到了什么」「差在哪」对齐成一张可执行的清单，作为 [20-design.md](20-design.md) 的输入。
> 判定标准：只看原型仓库里能指到位置的实现，不看宣传口径。

## 0. 一句话结论

官方原型把**双层架构 + 事件驱动 + 授权模型**做到了接近生产级（这三块占了绝大部分代码量与测试），
而**存算分离、任务级看门狗、通用投机执行、长程记忆、凭据隔离、跨实例协作**六项，长文自己列为未来方向或开放问题，
原型里只有雏形或完全没有。本仓库的增量就落在这六项上。

## 1. 差距矩阵

| # | 设计目标（长文） | 原型实现 | 差距等级 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | Router/Worker 双层，工具集差异写进配置 | ✅ 完整 | — | `cordis.patch.yml` 两个 preset；`src/app/sessions.ts:61` `WORK_TOOLS` |
| 2 | Router 不等待（noWait 守卫） | ✅ 完整 | — | `src/app/sessions.ts:77-86` |
| 3 | 两级过滤 Gate + Assessment | ✅ 完整 | — | `policy.ts` `gate()`、`admission.ts`、`prompts/admission.md` |
| 4 | Thread 订阅直通（绕过 Gate 不加权限） | ✅ 完整 | — | `core/tickets.ts`、`docs/002` §Subscriptions |
| 5 | Mandate 不可变 + 三操作变更 | ✅ 完整 | — | `core/model.ts` `MandateBasis`、`policy.ts` `revalidate()` |
| 6 | accept 三档 off/observe/auto | ✅ 完整 | — | `policy.ts:55` `would_accept` 记录 |
| 7 | Inline & Spill + 链式召回 | ✅ 实现 | ⚠️ 仅近期 | `app/resources.ts` 的 `RESOURCES`；文本页 4000 单元、列表 20 条 |
| 8 | 异步 ReAct Loop（全双工） | ⚠️ 靠 5 秒超时近似 | 中 | Worker preset `timeoutMs: 5000`；长文说 dsh 的异步机制「尚未默认开启」 |
| 9 | 多信道交互规范 | ✅ 提示词层 | — | `prompts/communication.md`、`dispatch.md`、100 词硬限 |
| 10 | 计算与状态分离（云端无状态容器） | ❌ 无 | **大** | 本地单进程 + SQLite + 目录锁（`src/app/store.ts`） |
| 11 | 计算与执行环境分离（端侧 daemon） | ❌ 无 | **大** | Worker 直接跑在操作员机器上（`docs/006` §Permissions） |
| 12 | 不接触凭据的执行通道 | ❌ 无 | **大** | 原型自认「垫片不是安全边界」；凭据以环境变量/CLI 配置文件形式存在于同机 |
| 13 | 基础设施 Watchdog | ⚠️ 脚本级 | 中 | `scripts/dsh-superagent status` 四档退出码 + 每小时 schedule |
| 14 | 任务级 Watchdog（判断有没有实质进展） | ❌ 无 | **大** | 原型只有静态规则：30 分钟后台上限、`request_status`、连续三次失败才报错 |
| 15 | 通用投机执行 | ⚠️ 用 observe 模式替代 | 中 | `docs/002` §Accept mode；无「预算内先做、按条件丢弃」的机制 |
| 16 | 跨月长程记忆 | ❌ 无 | **大** | 原型自认链式召回只解决近期；`trigger`/`decision` 表还「无界增长」 |
| 17 | 多实例 / A2A 协作 | ❌ 无 | **大** | 单仓库、单实例（`docs/006` 前置条件） |
| 18 | 安全与隐私（提示词注入、跨设备信任） | ⚠️ 部分 | 中 | `docs/007` §Open questions 第一条就是「哪些 Trigger 字段可信」 |

图例：✅ 完整 / ⚠️ 部分或近似 / ❌ 缺失。

## 2. 六个缺口的展开

### 2.1 存算分离（长文 §5.1）

**长文要求**：Agent Loop 进云端无状态容器，Session 状态进数据库，容器可水平扩展、重启、替换。

**原型现状**：单机单进程。`Runtime` 构造时先锁住 state 目录（`proper-lockfile`），再打开一个 SQLite 文件
`<stateDir>/orchestrator.sqlite`，明确「防止第二个进程迁移或写同一份状态」。
这不是缺陷，是刻意的取舍——原型选择了「用最小的工程代价验证调度与路由」。

**但原型已经铺好了一半的路**：`Engine` 所有方法同步、每个命令一个事务、所有副作用先落 `effect` 表再执行。
这套 stored work 的设计**本来就是为可重启服务的**，缺的是：
- 状态从「本地 SQLite 文件」换成「可共享的存储」；
- 执行从「进程内 Passes 定时器」换成「可多实例竞争的安全调度」；
- 单写者不变式从「进程锁保证」换成「分布式租约 + 乐观并发」保证。

最后一条是真正的难点：`Engine` 的「每种状态只有一个写者」在单进程里靠对象所有权，在多实例里要靠 CAS 或单写者分区。

### 2.2 执行环境分离（长文 §5.2）

**长文要求**：环境不搬，端侧只装一个不保存会话状态的轻量 daemon，只执行命令返回结果。

**原型现状**：Worker 以操作员 OS 用户身份在本机执行，`danger-full-access`，不需要审批。
原型文档自己写：「Account wrappers choose the agent's credentials by default; they do not isolate the process.
A worker can execute programs by path and read the operator's home directory.」
官方建议的缓解措施是「用一个只装了 Agent 凭据的独立 OS 账号」——这是运维措施，不是架构措施。

**缺口的具体形态**：
- 没有 daemon 协议（命令下发、结果回传、工件回传、断线重连、离线排队）；
- 没有「设备在线状态」概念（长文的例子：电脑离线时任务在云端等，第二天开机云端 Agent 核对等待中的步骤）；
- 没有「哪个 Ticket 该在哪台设备执行」的路由（同一份仓库可能存在于多台设备）。

### 2.3 不接触凭据的执行通道（长文 §8.4）

**长文要求**：设计相应机制，让 Agent 在完全不接触凭据本身的情况下使用凭据。

**原型现状**：凭据以三种形式与 Worker 同生共死：
1. `gh` / `lark-cli` 的配置文件在操作员 home 下，靠 `PATH` 垫片选到 Agent 那个账号；
2. `GH_TOKEN` / `GITHUB_TOKEN` 被从环境里删掉——但这是「删已知的变量名」，不是「凭据不可达」；
3. git 凭据助手被改写，但 Worker 仍可 `cat ~/.config/gh/hosts.yml`。

**这条不解决，Super-agent 就只能在一个很小且可信的范围内工作**——长文自己的原话。

### 2.4 任务级 Watchdog（长文 §6）

**长文要求**：不仅监控基础设施存活，还要由模型判断每个 Worker「有没有实质进展、方向是否偏离」。

**原型现状**：只有基础设施层。`scripts/dsh-superagent status` 按退出码四档处理
（0 正常 / 1 可重启修复 / 2 重启修不好只报告 / 3 等待设置），每小时跑一次 schedule，尊重人为 stop 标记。

任务层只有三个静态零件：
- 主 Session 可以对「没汇报就结束回合」的 Worker 发 `request_status`；
- Worker 每轮结束后台作业最多跑 30 分钟，到点杀掉 shell 作业并报 waiting；
- 每个部件有健康条目，连续失败三次才报错。

**原型抓不到「第五次改同一张图表配色」这种空转。** 长文自己也承认这是五个模块里最难做对的一个，
因为要先回答「什么叫有进展」，而且 Watchdog 一旦判错、又有权改主系统提示词，就是一个新的故障点。

### 2.5 通用投机执行（长文 §3.4）

**长文要求**：分支结果还没确定就先按最可能的方向算下去，猜对直接用、猜错丢掉。

**原型现状**：只有 `observe` 模式这个「替代物」——策略规则 + 模型评估通过后记录「本来会接」，切到 `auto` 才真干。
这解决的是**上线路径**（先看它想干什么，再让它干），不是**投机执行**本身：
真正缺的是「在授权尚未确定时，用有限的预算做不可逆性很低的前置工作」。

典型的缺失场景就是长文举的例子：群里还在讨论，Agent 已经复现了问题、找到了修复，但**没提交**。
按现在的原型，这需要一条 `auto` 规则，而 `auto` 会真的去开 PR。中间那档「先算、先不交付」没有。

### 2.6 长程记忆（长文 §8.1）

**长文要求**：跨月甚至更长的时间跨度。

**原型现状**：`docs/007` §Persistence 明确写「Nothing deletes old records yet, so these grow without bound」——
`trigger`、`disposition`、`decision`、结束的 Ticket 与 Thread、outbox 收据、每个 Session 用过的 prompt 版本，全部只增不减。

也就是说：原型在**存储层**还没考虑遗忘，在**检索层**只有链式召回（近期多跳）。两者都不是长程记忆。

## 3. 另外三处「长文有、原型没有」的小差异

| 项 | 长文 | 原型 |
| --- | --- | --- |
| 异步 ReAct Loop | `start()` / `stop()` 一等公民，立即返回 Started | 用 5 秒前台超时 + 转后台作业近似；没有 `stop()` 语义 |
| Router 水平切分 | 规模大时可多层过滤或切分 | 单 Session，长文说「当前规模够用」 |
| 多仓库 | 未明确限制 | 明确单仓库 `owner/name`，GitHub Enterprise 不支持，MCP 完全未用 |

最后一条对我们要做的设计影响最大：**单仓库是原型最大的场景约束之一**。真实团队里 Agent 通常要跨多个仓库、
甚至跨 GitHub 之外的平台（Jira、内部工单、CI 系统）。而原型里 `SourceKind` 是可插拔的，
但 Executor 的「一个 Ticket 一个目录 + 一条 prepare 命令」隐含了「只有一个 git 仓库」的假设。

## 4. 复用的判断

原型有大量东西可以**直接复用而不需要重写**：

| 可复用 | 为什么 |
| --- | --- |
| 领域模型十概念 + 规则 | 与运行时无关，换任何执行底座都成立 |
| 「被拒绝的概念」表 | 是设计约束的先验，直接当评审清单 |
| Engine 的单写者 / 角色 Pick / 祈使-过去式命名 | 与存算分离不冲突，反而更容易迁移 |
| Effects 的 kind/key/backoff 结构 | 换成分布式队列时形状基本不变 |
| Stored work（先存后做） | 这就是持久性的正确起点 |
| `noWait` 守卫、5 秒超时、30 词备注上限、100 词回复上限 | 纯策略，逐字可搬 |
| admission 表结构 | 纯数据结构，与 Source 实现解耦 |
| Gate / Mandate / revalidate 三段式 | 抽象层次正确，扩展 Source 时不用动核心 |

**不需要复用**的：单机 SQLite Store 的写实现、DshExecutor 的目录与垫片方案、`scripts/` 里的进程管理。

## 5. 由此得到的增量范围

本仓库只做下面六件事，不做别的（范围控制见 [30-roadmap.md](30-roadmap.md)）：

1. **执行平面抽象**：把「在哪儿跑」从 DshExecutor 里抽出来。接入点是 dsh 已有的 `ctx.fs` / `ctx.shell` seam，
   **不是**自造转发层——官方 `dsh-sandbox` 文档明说「容器、microVM 或远程执行器会替换整个 `ctx.shell`/`ctx.fs` 能力」。
2. **端侧 daemon 协议**：命令下发 / 结果回传 / 离线排队 / 断线重连。
3. **凭据代理**：Agent 侧只能看到「能力句柄」，看不到凭据本身。
4. **任务级 Watchdog**：独立的进展判据 + 分级介入策略（观察 / 催办 / 叫停 / 交人）。
5. **投机执行预算**：在授权未定时允许有界、不可逆性低的前置工作，产物默认不交付。
6. **记忆分层**：改按「是否会被静默删除」分层——L0 不变量（永久重注入）/ L1 决策与否决（只追加）/ L2 事实（可衰减）/ L3 轨迹（可丢）。详见 [20-design.md](20-design.md) §3.6。

多实例 / A2A 与跨仓库列为 M4 之后的方向，不在首发范围。
