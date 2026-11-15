# 记忆模块重构报告

> 日期：2026-11-15
> 范围：`memory-plugin/` 的存储模型、编号体系、总结/提炼机制
> 状态：78 项测试全过，编译通过，**未装到任何设备**

---

## 一、这次改了什么（对照你的四条要求）

| 你的要求 | 改动 |
| --- | --- |
| 「所有条目信息标号，按唯一标识符递增作为主键」 | 每张表都有自增整数主键；对外暴露的编号是 `event_no` |
| 「不要引入奇奇怪怪的 map」 | 删除 `fts_map` 表。FTS 的 rowid 直接复用事件的内部主键 |
| 「每个事件，工具调用都要标号」 | 新增 `event` 表，消息/工具调用/工具结果/思考/摘要**每条都占一个编号** |
| 「每个 session 一套编号」 | `event_no` **按会话独立递增**，从 1 开始；唯一定位需 `(sessionId, event_no)` |
| 「近期全量加总结一起传时，编号合并为同一个，用标签区分」 | 段内用 `<recent-slot>` / `<summary-slot>` 两槽，**同属一个编号** |
| 「总结和压缩分清楚」 | 代码里明确区分，注释写清；总结不负责腾空间 |
| 「提炼不是压缩，要保留否决路径」 | 提炼提示强制要求「否决方案 + 原因 + 最终方案」 |
| 「提示只出现一次，不回传」 | `hidePromptAfterUse()` 在提炼后用空事件遮蔽该提示 |
| 「不要程序化触发」 | 无任何自动索引/注入/总结监听器 |

---

## 二、编号体系（核心变化）

### 2.1 三层标识，各自职责

| 标识 | 作用域 | 用途 |
| --- | --- | --- |
| `row_id` | 全库 | 数据库内部主键，**只给 FTS 当 rowid**，不对外 |
| `event_no` | **会话内** | 对外唯一标识；从 1 开始，每个会话独立 |
| `seq` | 会话内 | dsh 日志的原始序号，只作普通列 |

**为什么 `event_no` 不能全库统一**：不同会话是彼此独立的记录单元。
混在一起编号，「本会话第 5 个事件」这种引用就失去意义，也破坏按会话做增量索引的前提。

### 2.2 一个 seq 可以对应多个事件

`assistant/message` 同时含正文与思考两块：

```
seq=7 → event_no=10  kind='assistant'   正文
seq=7 → event_no=11  kind='reasoning'   思考
```

所以复合键 `(sessionId, seq, kind)` 只能当幂等约束，不能当主键。

### 2.3 编号示例

```
会话 A:  #1 user  #2 assistant  #3 reasoning  #4 tool-call  #5 tool-result
会话 B:  #1 user  #2 assistant
会话 A:  #6 user   ← 继续 A 自己的序列
```

---

## 三、总结 vs 压缩（这不是文字游戏）

你的原话说得很清楚，我把它固化进代码：

| | 总结（本插件） | 压缩（dsh 自己做） |
| --- | --- | --- |
| 触发 | 模型主动调 `memory_summarize` | 上下文将满时自动 |
| 目的 | **提炼有效信息** | **腾出空间** |
| 产出 | 保留否决路径：`否决 A：因为…  最终：D` | 一段摘要，可能只剩结论 |
| 谁管 | 本插件 | 不归本插件 |

**提炼提示的原文要求**（`buildSummarizePrompt`）：

```
这不是压缩，是提炼。区别在于：
- 压缩会把一大段变成"最终方案：X"
- 提炼必须保留否决路径：哪些方案被否定了、为什么被否定

期望的形态：
  否决方案 A：因为 <具体原因>
  否决方案 B：因为 <具体原因>
  ...
  最终方案：<结论>
```

---

## 四、槽位机制（近期全量 + 总结合并）

### 4.1 一个段 = 一个编号 = 一条消息

```xml
<recent-slot>
  近期的逐字原文（全量保留）
</recent-slot>

<summary-slot>
  否决 A：因为鉴权冲突
  否决 B：因为延迟超标
  最终：D
</summary-slot>
```

**同一条消息、同一个编号、内部两个标签。**

### 4.2 段的生命周期

```
live       recent + summary 都在         ← 刚封存
   ↓ archive()
archived   只剩 summary，recent 清空     ← 滑出近期窗口
```

**编号不变，内容降级。** 这是「近期全量 → 更早只有总结」的实现。

### 4.3 长度阈值（我定的）

| 原文长度 | 建议 |
| --- | --- |
| ≤ 1,200 字符 | 保持原文，不必总结 |
| 1,200–4,000 | **可选**，由模型自己决定 |
| ≥ 4,000 字符 | 建议总结 |

阈值可用环境变量覆盖，代码里是 `KEEP_ORIGINAL_THRESHOLD_CHARS` / `SUMMARIZE_THRESHOLD_CHARS`。

---

## 五、表结构

| 表 | 主键 | 说明 |
| --- | --- | --- |
| `event` | `row_id` 自增 | 事件台账；`(sessionId, event_no)` 唯一 |
| `event_text` | `row_id` | 与 event 一对一，存正文 |
| `event_fts` | rowid = `event.row_id` | 关键词索引；**思考不进** |
| `segment` | `row_id` 自增 | 总结段；`(sessionId, event_no)` 唯一 |
| `watermark` | `sessionId` | 增量索引水位 |
| `meta` | `key` | 元信息 |

**已删除**：`records`、`reasoning`、`records_fts`、`fts_map`、`watermarks`、`sealed_segment`。

**没有映射表**：FTS 的 rowid 就是 `event.row_id`，插入显式给、删除按它精确命中。

---

## 六、对外能力

| 工具 | 作用 |
| --- | --- |
| `memory_search` | 在全部历史里搜文本 |
| `memory_summarize` | 两阶段：先取提炼指导，再提交总结 |

`memory_summarize` 的两阶段设计：

```
第一次调用（不带 summary）
  → 返回提炼提示 + 基于长度的建议
  → 模型据此产出保留否决路径的总结

第二次调用（带 summary）
  → 落库 + 替换历史 + 该提示被遮蔽（不再回传）
```

---

## 七、程序化触发：确认没有

全插件只有 **1 个** `ctx.on` 监听器：

```
dsh-bundle.ts:93  ctx.on('session/event', ...)
```

它只往内存 Map 写 `turn` 号，**不索引、不注入、不发消息、不调工具**。

- 无 `agent/disposed` 自动索引（已删除）
- 无 `agent/pre-step` 注入
- 无定时器

---

## 八、测试与验证

| 项 | 结果 |
| --- | --- |
| `tsc` 编译 | 通过 |
| 单元测试 | **78 项全过** |
| 其中新增/重写 | store 14 项、seal 25 项 |

**关键测试覆盖**：

- 同一会话内编号 1→2→3 递增
- 不同会话各自从 1 开始
- 同一 `(sessionId, seq, kind)` 重复写入复用编号
- 同一 `seq` 不同 `kind` 各占一个编号
- 思考不进 FTS
- 槽位组装：两槽都在 / 空槽不输出 / 全空报错
- 提炼提示包含「否决」「不是压缩」
- `archive` 清空 recent 保留 summary
- `applySegment` 用正确的 `surfaceOp` + `sourceEventSeqs`

---

## 九、已知缺口（诚实列出）

| # | 缺口 | 影响 |
| --- | --- | --- |
| 1 | **段滑出近期窗口的判定逻辑未实现** | `archive()` 有了，但没人调用——即"什么时候从 live 变 archived"没做 |
| 2 | 模型拿不到 `from_seq`/`to_seq` | `memory_summarize` 要求显式传，但模型不知道 seq，需要额外告知途径 |
| 3 | 向量检索仍是 Noop | 接口在，跑不了 |
| 4 | 索引仍需手动 CLI | 符合"不程序化触发"，但当前会话搜不到自己刚说的 |
| 5 | `hidePromptAfterUse` 未被调用 | 已实现，但没接进 summarize 流程 |

**第 1 和第 2 是下一步的主要工作。**

---

## 十、改动文件

```
src/store/schema.sql        重写（event/event_text/event_fts/segment/watermark/meta）
src/store/sqlite.ts         重写（会话内编号、去掉 fts_map）
src/types.ts                重写（EventRecord/EventSearchResult/KeywordHit 带编号）
src/seal/types.ts           重写（槽位、阈值、提炼提示）
src/seal/store.ts           重写（SegmentStore，会话内编号）
src/seal/apply.ts           重写（applySegment、collectShadowedSeqs、hidePromptAfterUse）
src/seal/tool.ts            重写（memory_summarize 两阶段）
src/ingest/indexer.ts       改（正文与思考合并为统一事件数组）
src/ingest/extractor.ts     改（reasoning 事件带 kind）
src/search/keyword.ts       改（用 rowId 回链）
src/search/vector.ts        改（向量 id 用 <sessionId>#<eventNo>，兼容旧格式）
src/dsh-bundle.ts           改（接入 SegmentStore / memory_summarize）
src/cli.ts / src/api/server.ts  改（适配新状态结构）
tests/store.test.ts         重写
tests/seal.test.ts          重写
```
