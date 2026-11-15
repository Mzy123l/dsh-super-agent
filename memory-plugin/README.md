# memory-plugin — DSH 会话记忆插件

把长会话的每一段内容编上号，让模型自己写摘要，老化的内容只发摘要，随时能取回原文。

许可证：[GPL-3.0-or-later](../LICENSE)

---

## 它解决什么

长会话里，早期的思考、工具输出、正文会撑爆上下文，但它们的有效信息往往一两句就够。

dsh 自带的压缩是「满了才压、静默切头」——被压掉的内容模型完全看不见，只剩一段它没参与写的摘要。

这个插件换一条路：

- **每段内容编一个号（`#0` `#1` …）**，编号会话内线性递增，永不改变
- **摘要由正在运行的模型自己写**，串行、当场写，不事后补
- **近几十条发「摘要 + 原文」，更早的只发摘要**
- **任何编号随时能取回完整原文**，包括已经不在上下文里的

原文永远留在库里，一个字都不删。

---

## 核心概念

### 编号单位

每个独立单元占一个编号，会话内从 0 开始线性递增：

| 单位类型 | 来源 | 说明 |
| --- | --- | --- |
| `user` | 用户消息 | 永不衰减，永远发原文 |
| `thinking` | 模型思考块 | 长单位必有摘要 |
| `tool` | 工具调用 + 结果 | **合并为一个单位**，内部用标签区分 |
| `reply` | 模型正文 | 长单位必有摘要 |

不占编号的：`system` / `developer` 框架内容、程序注入的一次性产物
（`<system-reminder>`、时间戳、生成标题的请求、提炼指令本身）。

**工具单位内部形态**：

```
#5 <summary>确认 ttl 配置为 300 秒</summary>
<content>
<tool-call name="bash">{"command":"grep ttl config"}</tool-call>
<tool-result isError="false">ttl=300</tool-result>
</content>
```

一次工具调用和它的结果按 `callId` 关联，合成同一个编号。

### 两层保真

| 层 | 内容 | 何时 | 谁生成 |
| --- | --- | --- | --- |
| **L0** | 完整原文 | 永远在库里 | 原始记录 |
| **L1** | 摘要 | 长单位（≥4000 字符）产生后串行 | 正在运行的模型 |

折叠摘要（L2）必须从 L0 生成，**绝不从 L1 再摘要**——递归摘要会系统性语义衰减。

### 发送投影

模型看到什么，由投影决定（纯函数，不改库）：

```
近程（最新 32 个单位内）
  #0 帮我修登录超时                          ← user，永不衰减
  #1 <summary>排查方向：ttl 提前失效</summary>
     <content>先看 token 过期逻辑…</content>   ← 有摘要，全发
  #3 把 ttl 改成 600                          ← 无摘要，原样发

远程（更早）
  #1 <summary>排查方向：ttl 提前失效</summary>  ← 只发摘要
  #3 把 ttl 改成 600                          ← 无摘要，原样保留
```

窗口按**单位数量**算（默认 32），不看 token。

---

## 安装

### 在 WSL 里

```bash
bash scripts-wsl/install-memory-plugin.sh
bash scripts-wsl/launch-web.sh 8085
```

脚本会：同步源码 → 装依赖 → 构建 → 清旧库 → 挂到 web profile → 启动并打印带 token 的 URL。

**登录由你自己完成**，脚本不碰凭据。

### 手动

```bash
cd memory-plugin
npm install && npm run build

dsh plugin --profile web add "link:$(pwd)"
```

启动后插件自动激活，无需额外配置。

---

## 配置

全部走环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MEMORY_DATA_DIR` | `./data` | 数据库目录 |
| `MEMORY_WINDOW` | `32` | 近程窗口（单位数量） |
| `MEMORY_SUMMARY_THRESHOLD` | `4000` | 长单位阈值（字符数） |
| `MEMORY_AUTO_SUMMARY` | 开 | 设为 `0` 关闭自动总结 |
| `MEMORY_MAX_RESULTS` | `8` | 检索默认返回条数 |

---

## 模型可用的工具

### `memory_search`

关键词检索，命中返回**完整原文**（不摘要、不截断），包含已老化、已折叠的内容。

```
memory_search("ttl 配置")
→ [{ idx: 5, kind: "tool", summary: "确认 ttl=300", content: "<完整原文>" }]
```

### `memory_expand`

展开折叠体，**严格分两级**：

```
memory_expand(from=4, to=9)   → 第一级：区间内各单位的摘要
memory_expand(idx=7)          → 第二级：#7 的完整原文
```

不能一步跳到原文——强制先看概览、再决定深入哪里。

### `memory_todo`

待办台账。**用户只记得「有事没做」但想不起是什么**时，`list` 无需关键词直接返回全部未完成项。

```
list            → 所有 open 待办
add             → 登记新待办
done / drop     → 完成 / 放弃（记原因）
```

### `memory_override`

用户后来推翻自己先前的判断，或承认模型的结论才对时，覆写某单位的摘要。

**只改摘要，原文不动**，并保留完整的覆写记录（旧摘要、原因、谁推翻的）。发送视图会标 `[已覆写]`。

### `memory_plan`

规划：怎么干（架构、顺序、依赖）。**不是待办**——

- **goal** = 什么算成功
- **规划** = 怎么干，可覆写、可重建、可削弱
- **待办** = 现在不做、留到以后

关键规则：

- 准入**只问时间**：「这件事要多久？」≥5 分钟建规划，不问「要不要规划」、不问步数
- **每个版本强制命名**（1–60 字符），拒绝「更新」「修改」「v1」这类无信息量的名字
- **已完成步骤绝不作废**：更新时漏掉的已完成步骤会自动补回
- **追加任务削弱前、增强后**：已完成权重归零，未完成降到 0.3，新步骤 1.0
- **回滚产生新版本**，旧版本全部保留，版本号只增不减

---

## CLI

```bash
memory-plugin units     --session <id>           列出编号单位
memory-plugin unit      --session <id> --idx N   取某单位全文
memory-plugin view      --session <id>           查看发送视图
memory-plugin search    "query"                  检索
memory-plugin fold      --session <id> --list    列出折叠
memory-plugin todo      --session <id>           待办台账
memory-plugin override  --session <id>           覆写记录
memory-plugin plan      --session <id>           规划与版本历史
memory-plugin compact   --session <id>           手动折叠（试运行加 --dry-run）
memory-plugin status                             库状态
```

---

## 数据

单个 SQLite 文件（默认 `data/memory.sqlite`）：

| 表 | 作用 |
| --- | --- |
| `message` | 编号单位（`idx` 唯一，`content` 永不删） |
| `message_fts` | 关键词索引（思考的原文不入 FTS，避免命中过多） |
| `message_vector` | 向量 |
| `fold` | 折叠体 |
| `todo` | 待办台账 |
| `override_log` | 覆写记录 |
| `plan` / `plan_version` | 规划快照 / 版本历史 |
| `pending_summary` | 待总结状态 |
| `summary_reply_fp` | 提炼回复指纹（避免一次性产物入库） |

---

## 设计约束

这些是踩过坑之后定下来的，改代码时别破坏：

**1. 原文永不删、永不改**

`message.content` 是审计与防漂移的锚点。覆写只改 `summary`，折叠只标记 `folded_into`。

**2. 编号永不改变、永不复用**

总结后不变、老化后不变、折叠后不变。会话内连续无空洞。

**3. 摘要必须校验**

收割模型回复时有**三道校验**（`src/summary/validate.ts`）：

- 过程性开场（「我先查一下…」「Let me check…」）→ 这是在干活，拒收
- 长度 > 原文 60% → 未收敛，拒收
- 与原文实词重合 < 15% → 串位，拒收

实测教训：不加校验时 86 条摘要里 85 条是错的——串位、或把原话重复一遍。
拒收时**保留 pending**，等下一轮。

**4. 没有程序化触发索引**

索引进库只发生在请求路径上（`llm/stream` 拿到实际发送的消息时）。
没有定时器、没有轮末批量、没有 `agent/disposed` 钩子。

**5. 投影只能走 surface**

`llm/stream` 的消息被 `deepFreeze`，`pre-step` 只含本步批次，`snapshotEvents` 已废弃。
唯一能改变模型所见历史的通道是 `session.append` + `surfaceOp: replace`（dsh 自家压缩同款）。
读数用未废弃的 `eventAt(seq)`。

**6. dsh 自带压缩不挂载**

上下文大小完全由本模块的投影控制。

---

## 已知未验证

**投影是否真的改变了模型所见**——代码路径接通、加载无错、纯函数逻辑有测试，
但**没有在真实模型对话里实证过**（需要凭据）。

如果消息前没有 `#N` 编号，就是投影没生效，检查 `/tmp/dsh-web-<port>.log`。

---

## 开发

```bash
npm test              # 193 项测试
npm run build         # 编译
npx tsc --noEmit      # 类型检查
```

诊断脚本在 [`scripts-wsl/`](../scripts-wsl/)：

| 脚本 | 作用 |
| --- | --- |
| `install-memory-plugin.sh` | 安装到 WSL |
| `verify-install.sh` | 验证安装完整性 |
| `inspect-db.sh` | 查看数据库内容 |
| `assess-session.sh` | 评估单会话质量（污染率、摘要覆盖率） |
| `audit-mismatch.sh` | 核查摘要串位 |
| `replay-validation.sh` | 用历史数据回放校验逻辑 |

完整设计见 [`docs/A7-memory-design-final.md`](../docs/A7-memory-design-final.md)。
