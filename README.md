# dsh-super-agent

基于 DeepSeek Harness（dsh）的 Super-agent 架构研究与实践。

本仓库不是对官方原型的复刻，而是在**读完官方设计长文 + 官方原型（`deepseek-ai/dsh-superagent-prototype`，MIT）源码之后**，
对「常驻、多任务、事件驱动、可自愈的 Agent 系统」继续做的一层设计：补上原型明确留空的几块（端侧执行、任务级看门狗、
通用投机执行、长程记忆、凭据隔离、跨实例协作），并把它们组织成可以按里程碑落地的方案。

## 为什么要做这件事

官方设计长文的判断是：单任务的上限取决于模型能力，**多任务的上限取决于人的注意力**。
官方原型用「Router 常驻 Session + 每 Ticket 一个 Worker Session」把分工从提示词里挪到架构里，
用消融实验证明了这件事（同一批任务 p95 从 29.5 分钟降到 15.7 分钟；去掉订阅直通后 Router 决策数 +30%、缓存读 token +37%）。

但原型自己声明了三处缺口：

1. 计算、状态与环境**没有分离**——Worker 以操作员 OS 用户身份跑在本机，文档自认「垫片不是安全边界」；
2. **任务级** Watchdog 缺失——只有每小时一次的 `status` 脚本巡检，抓不到「同一张图表改第五次配色」这种空转；
3. 通用投机执行、跨月长程记忆、不接触凭据的执行通道——公开列为未来方向或开放问题。

本仓库就落在这三处缺口上。

## 目录

| 文档 | 内容 |
| --- | --- |
| [docs/00-official-notes.md](docs/00-official-notes.md) | 官方架构学习笔记：五个模块、十个领域概念、不变量、工程约束、实验数据 |
| [docs/10-gap-analysis.md](docs/10-gap-analysis.md) | 设计目标 vs 原型实现：差距矩阵，带源码位置证据 |
| [docs/20-design.md](docs/20-design.md) | 进一步设计：分层、六个增强模块、接口草图、数据模型增量 |
| [docs/30-roadmap.md](docs/30-roadmap.md) | 里程碑 M0–M4、验收标准、指标口径、风险清单 |

## 三条硬约束（继承自官方，不打算改）

在往上加东西之前，先把官方原型验证过的东西当作地基，不去动它：

1. **Model-visible means logged。** 凡是进过模型上下文的内容都必须能从 Session Log 重建。加任何模块都不能绕开这条。
2. **权限由代码强制，不由文本赋予。** 消息、评论、引用文档都是决策的输入，不能改变授权。`Mandate` 只能被三种操作改变：
   accept 创建、人的 stop 撤销、重新校验失败吊销。
3. **每个状态只有一个写者。** 领域状态归 Engine，Source 的读位与 Thread 元数据归 Source，副作用先落库再执行（stored work）。

## 状态

设计阶段。仓库内目前只有文档，没有可运行代码。

## 参考

- 官方原型：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，研究原型，非正式产品）
- 官方设计长文：《Super-agent 设计探索：迈向更自主的 Agent 系统》（DeepSeek Harness 团队，2026-10-31）
- 运行时：[DeepSeek Harness](https://www.deepseek.com/en/harness/)（本机为 `0.2.1-rc.5`，仍是 developer preview）
