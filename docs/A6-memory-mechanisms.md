# 记忆模块：机制详解

> 上一版我写成了数值表，等于没讲机制。这一版逐个讲**发生了什么、怎么发生的、边界在哪**。
> 所有描述都对应代码里真实存在的逻辑，附文件与行号。

---

## 机制一：事件编号

### 怎么编号

每条进入库的事件，先看它**是否已存在**（按 `sessionId + seq + kind` 三元组查），
不存在才分配新编号：

```
INSERT 前先查：
  已存在 → 复用原 event_no，只更新内容
  不存在 → SELECT MAX(event_no)+1 WHERE sessionId=?  → 插入
```

**关键点：编号是「查出来的」，不是数据库自增的。**
因为要求每个会话独立从 1 开始，而 `AUTOINCREMENT` 只能全表递增。
所以真正的主键是 `row_id`（全局自增），`event_no` 是普通列 + 唯一约束。

### 为什么一个 seq 会有两条事件

`assistant/message` 事件里同时含正文块和 `reasoning` 块。
`extractor.ts` 会把它拆成两条：

```
seq=7, kind='assistant' → event_no=10   正文进 FTS
seq=7, kind='reasoning' → event_no=11   正文不进 FTS
```

所以 `(sessionId, seq)` **不能**唯一确定一行，必须带 `kind`。

### 边界

- 同一个 `(sessionId, seq, kind)` 重复索引 → 编号不变，内容覆盖
- `event_no` 只在会话内保证连续；会话间无关

---

## 机制二：槽位（近全量 + 总结并存）

### 一条消息里塞两段

`composeSlottedText()` 把槽位数组拼成一条正文：

```
输入：[{kind:'recent', text:'原文...'}, {kind:'summary', text:'总结...'}]
输出：
<recent-slot>
原文...
</recent-slot>

<summary-slot>
总结...
</summary-slot>
```

**空槽直接跳过**——`recent` 为空时只输出 `<summary-slot>`。
全空则抛错（不允许产出空段）。

### 阶段迁移是「清空 + 改标记」

```
archive(sessionId, eventNo):
  UPDATE segment SET stage='archived', recent='' WHERE ...
```

**注意：这不是删除历史，是删除段里存的原文副本。**
dsh 的日志里原文还在，只是模型看不到这条段的原文槽了。

---

## 机制三：区间计算（哪些可以提炼）

`computeSpans()` 的逻辑按顺序：

```
for 每个事件 ev:
  1. 若 ev.seq 已在 covered 集合里 → 跳过（已被某段覆盖）
  2. 若 ev 没有 turn → 跳过（无法归属，不冒险）
  3. 若 ev.turn > latestTurn - keepTurns → 跳过（还在近期窗口）
  4. 否则按 turn 分组累加
```

**覆盖判断的双路径**（`coveredSeqs`）：

```
if seg.shadowedSeqs 非空 → 用精确的 seq 列表
else                     → 退回用 [fromSeq, toSeq] 区间展开
```

第二条是兜底：段写入时 `shadowedSeqs` 可能还是空的。

### 每个区间算三样东西

- `fromSeq` / `toSeq`：`Math.min/max` 该轮所有事件的 seq
- `chars`：该轮所有事件字符数之和
- `recommendation`：按 chars 落进 1200/4000 两档

---

## 机制四：循环（这是核心）

### 为什么必须两轮才完成一次提炼

```
第 N 轮 pre-step 时：
  模型的这一轮还没开始 → 拿不到它的输出
  所以只能「注入提示」

第 N 轮模型推理：
  输出提炼结果（自然语言）

第 N+1 轮 pre-step 时：
  能读到第 N 轮的 assistant 消息了 → 才能「收割」
```

这是 `runLoopStep` 里「先收割、后注入」的原因：如果先注入，会把 awaiting 覆盖掉，
第 N 轮的结果永远收不到。

### 收割的判定条件（三个都必须满足）

```ts
1. lastAssistant 存在
2. Date.parse(last.at) >= Date.parse(awaiting.createdAt)   // 晚于提示
3. text.trim().length > 0                                   // 非空
```

第 2 条防的是「收错了」：如果模型还没回复，`lastAssistant` 是更早的历史消息，
时间戳会早于 `awaiting.createdAt`，被正确拒绝。

### 收割时做的事

```
1. segments.insert({ fromSeq: awaiting.fromSeq,
                     toSeq: Math.max(awaiting.toSeq, last.seq),   ← 注意这里
                     summary: last.text,
                     recent: '',          ← 当前版恒空
                     stage: 'archived' }) ← 当前版恒 archived
2. applySegment → session.append(surfaceOp:'replace')
3. pending.clear
4. applyArchive（顺带降级）
```

**`toSeq = max(区间末尾, assistant 的 seq)`** 的原因：
提示注入后成为一条新消息，它的 seq 大于原区间末尾。
要让「提示」也一起被遮蔽，上界必须拉到提示之后的 assistant 消息。

### 过期与失败

| 情况 | 行为 |
| --- | --- |
| 有 awaiting 但无新回复，未超 10 分钟 | 返回 idle，等待 |
| 超 10 分钟 | 清 awaiting，记 warn，返回 harvest-failed |
| apply 抛错 | 清 awaiting，记 warn，返回 harvest-failed（段已落库，保留） |

**段落库在 apply 之前**——因为总结是不可再生的，替换失败不能连总结一起丢。

---

## 机制五：表面替换（让模型看不见）

`applySegment` 做三件事：

```
1. 取会话：ctx.sessions.get(sessionId)
2. 读真实 surface：collectShadowedSeqs(session, fromSeq, toSeq)
     → 从 snapshotEvents() / ownEvents() / events 里
     → 筛出 seq 落在区间内、且 surfaceOp !== undefined 的节点
     → 去重 + 升序
3. append：
     session.append('user/message', 槽位内容, {
       surfaceOp: { op:'replace', startSeq, endSeq },
       sourceEventSeqs: 上一步读到的列表
     })
```

### 为什么必须读真实 surface

我在真实 dsh 里试过按区间直接猜：

```
surface replace: sourceEventSeqs must include every shadowed surface node; missing 0, 1
```

dsh 要求列表**完整且精确**，缺一个节点就拒绝提交。
所以只能从会话当前投影里读，不能凭 `[fromSeq, toSeq]` 推。

### 拿不到节点时拒绝

```ts
if (!shadowed || shadowed.length === 0) {
  throw new Error('nothing would be shadowed, so the seal is refused')
}
```

宁可失败，也不做「什么都没遮蔽」的空替换——那会让段落库但历史没变，状态不一致。

---

## 机制六：注入的精确位置

`dsh-bundle.ts` 的 pre-step 里：

```ts
const prompt = createUserMessage({ content, source: {kind:'memory-loop-prompt'} })
const lastClaimedIndex = decision.messages.findLastIndex(m => messages.includes(m))
const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, prompt)
return { ...decision, messages: entered }
```

### 三个要点

**① 为什么找 `findLastIndex`**
`decision.messages` 里可能既有本步领取的消息，也有别的前缀。
注入要插在「本步领取的最后一条」之后，跟在本轮用户输入后面，而不是插到最前面。

**② 为什么用 `toSpliced` 而不是 `push`**
`decision.messages` 是冻结的（deep-frozen），原地改会抛错。
`toSpliced` 返回新数组。

**③ 为什么返回 `{...decision}` 而不是只返回 messages**
`PreStepDecision` 还有其他字段（如 `startsRequestSeries`、`kind`）。
只返回 messages 会丢掉它们，导致 loop 行为异常。

### `createUserMessage` 的必要性

手写 `{role:'user', content:[...]}` 会被拒——`UserMessage` 需要一个 `id`。
`createUserMessage` 负责生成 id 并冻结。

且 `source.kind` 是**闭合联合类型**，自定义种类必须做模块增强：

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-loop-prompt': { kind: 'memory-loop-prompt' }
  }
}
```

---

## 机制七：提示只出现一次

不是靠特殊逻辑，而是**靠它被一起遮蔽**：

```
收割时 toSeq 取到 assistant 的 seq
→ 提示的 seq 落在 [fromSeq, toSeq] 内
→ 被同一条 replace 一起遮掉
```

所以提示只存在一轮，下一轮 pre-step 时它已经不在 surface 上了。

`hidePromptAfterUse()` 是另一条路（单独遮蔽某条提示），
但当前版**没有调用它**——因为主路径已经覆盖了这个需求。

---

## 机制八：索引（手动）

```
CLI: memory-plugin index --all
  → discoverSessionFiles(sessionsDir)
  → 逐文件 indexSession()
      → log-reader 解压 zstd 拼接帧（magic 0xFD2FB528，容错坏帧）
      → extractor 逐事件转 EventRecord
      → store.insertBatch（单事务）
      → setWatermark
```

**没有自动索引。** `agent/disposed` / `agent/pre-step` 都不调索引。
索引入口只通过 `ctx.provide('memory', { indexAll, indexSession })` 暴露给 CLI。

### 增量靠水位线

```
watermark.lastSeq = 该会话已索引到的最大 seq
下次索引时跳过 seq <= lastSeq 的事件
```

但当前 `index --all` 走的是全量路径；增量逻辑存在但未在主路径启用。

---

## 机制九：检索

### 关键词路径

```
查询 → buildFtsQuery → FTS5 MATCH
  → 中文词转 phrase："待办" → '"待 办"'
  → 混合词拆 runs："日志abc" → '("日 志" AND "abc")'

命中 → 按 rowid 回链 event
  → snippet() 取 ±24 token 上下文
  → shadowed 标记从 event 表读
```

### 中文为什么要逐字

`unicode61` 分词器把连续汉字当一个 token。
索引「记成待办」时不切开，搜「待办」就命中不了（token 不匹配）。
所以 `segmentForFts()` 在汉字之间插空格：`"记 成 待 办"`，
查询侧也做同样处理，两边对齐就能命中。

### 思考的隔离

```
insertEvent 时：
  if (kind !== 'reasoning') → 插入 event_fts
  else                     → 只插 event_text，不插 FTS
```

实测确认：21,163 条 reasoning，FTS 里 0 行。

### 混合检索

```
keyword 路 → 结果列表 A
vector 路  → embedding(query) → vectorStore.search → 回链 → 结果列表 B
RRF 合并   → score = Σ 1/(60 + rank_i)
```

**当前 vector 路恒空**（NoopVectorStore），所以 hybrid 等于 keyword。

---

## 机制十：总结与压缩的分工

| | 总结 | 压缩 |
| --- | --- | --- |
| 谁做 | 本插件 | dsh 的 compaction |
| 何时 | 循环判定该提炼时 | 上下文将满时 |
| 产出 | 保留否决路径的提炼 | 摘要（可能只留结论） |
| 数据 | 存 `segment` 表 | 存 `compaction/summary` 事件 |

**两者独立运行，互不协调。** 这是当前状态，也是潜在冲突点（见缺口）。

---

## 当前实现的机制性缺陷

不是「没写」，是「写了但逻辑不完整」：

### 缺陷 1：`recent` 恒空，`stage` 恒 archived

`engine.ts:138-139` 硬编码：

```ts
recent: '',
stage: 'archived',
```

**后果**：`<recent-slot>` 永远不出现，所有段都只有总结。
「近几步全量」这条机制**实际不存在**——`composeSlottedText` 里的 recent 分支是死代码。

### 缺陷 2：覆盖检测的双路径可能漏判

```ts
if (seg.shadowedSeqs.length > 0) → 用精确列表
else → 用 [fromSeq, toSeq] 区间展开
```

但 `engine.ts` 写入段时 `shadowedSeqs: []`（恒空），
所以**永远走第二条路径**——用区间展开判断覆盖。
如果段实际遮蔽的节点比区间少（例如中间有空洞），会误判为「已覆盖」。

### 缺陷 3：`toSeq = max(区间, assistant.seq)` 可能过度遮蔽

如果模型在第 N 轮输出了提炼结果，但 `assistant.seq` 之后还有别的消息
（同一轮多步工具调用），这些也被一起遮蔽了。
**没有校验被遮蔽的节点数是否合理。**

---

## 已实现 vs 未实现（按机制，不按数值）

| 机制 | 状态 |
| --- | --- |
| 事件编号（会话内独立） | ✅ 完整 |
| 一号多载体（正文+思考） | ✅ 完整 |
| 槽位拼装 | ✅ 完整 |
| 槽位降级（archive） | ✅ 完整 |
| 区间计算 | ✅ 完整 |
| 循环：注入 | ✅ 完整 |
| 循环：收割 | ⚠️ 能跑，但 `recent`/`stage` 写死 |
| 循环：过期与失败 | ✅ 完整 |
| 表面替换 | ✅ 完整 |
| 注入位置 | ✅ 完整 |
| 提示只出现一次 | ✅ 完整（靠遮蔽） |
| 手动索引 | ✅ 完整 |
| 增量索引 | ⚠️ 逻辑在，主路径未启用 |
| 关键词检索 | ✅ 完整 |
| 中文逐字分词 | ✅ 完整 |
| 思考隔离 | ✅ 完整 |
| 向量检索 | ❌ 空实现 |
| **近全量 + 总结并存** | ❌ **因缺陷 1 而失效** |
| 总结/压缩协调 | ❌ 没有协调 |
