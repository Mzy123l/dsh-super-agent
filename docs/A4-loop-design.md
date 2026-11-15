# 消息循环设计（重写）

> 上一版我写错了三处根本性的东西，导致编译不过、逻辑不成立。
> 这份文档先把契约和时序想清楚，再谈实现。

---

## 一、`agent/pre-step` 的真实契约

从官方 `dsh-agent-instructions` 的用法提取（`lib/index.js` 的监听器）：

```ts
ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
  const decision = await next()          // ① 先执行后续监听器，拿到最终决定
  // …在这里修改 decision.messages…
  return decision                        // ② 返回完整的 PreStepDecision
})
```

### 1.1 参数

| 字段 | 含义 |
| --- | --- |
| `agent` | 当前 agent（`agent.session` 拿会话） |
| `messages` | **本步从 inbox 领取的原始批次**（不是完整历史） |
| `step` | 本步序号（从 1 开始） |
| `signal` | 取消信号，修改前应 `throwIfAborted()` |

### 1.2 返回值：`PreStepDecision`

两种形态：

```ts
{ kind: 'reject' }                          // 拒绝本步
{ kind: 'enter', messages: Message[], … }   // 进入本步，带消息批次
```

**必须原样返回一个合法 decision**，不能返回 `undefined`，不能返回裸 `{messages}`。

### 1.3 修改 messages 的正确姿势

官方范例：

```ts
const lastClaimedIndex = decision.messages.findLastIndex(m => messages.includes(m))
const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
return { ...decision, messages: entered }
```

**要点**：
- 找到「最后一条本步领取的消息」的位置
- 把注入内容插在它**之后**（这样注入跟在本步用户消息后面）
- 用 `toSpliced` 生成新数组，不原地改
- 展开 `...decision` 保留其他字段（如 `startsRequestSeries`）

### 1.4 关键限制

`decision.messages` **只是本步要进入的批次**，不含完整历史。
要「把旧历史替换成总结」，这个钩子**做不到**——它只能追加。

---

## 二、所以「替换历史」必须走另一条路

这是上一版最大的设计错误：我以为能在 pre-step 里替换历史。

**实际上「替换历史」只能通过 `session.append(..., {surfaceOp: 'replace'})`**，
这是**写入日志并改变 surface 投影**，不是在 pre-step 里改 messages 数组。

两条路径分工明确：

| 目标 | 手段 |
| --- | --- |
| 让模型「看到」一段提炼提示 | pre-step 注入 message |
| 让模型「不再看到」旧历史 | `session.append` + `surfaceOp: replace` |

---

## 三、正确的循环时序

```
┌─ 第 N 轮 ────────────────────────────────────────────────┐
│                                                          │
│  pre-step                                                │
│    ① 收割：若存在 awaiting，且模型上一轮已给出提炼结果      │
│       → append(replace) 遮蔽 [提示 seq, 区间末尾]         │
│       → 落库为段                                          │
│       → 清除 awaiting                                     │
│                                                          │
│    ② 注入：若没有 awaiting，且找到「该提炼」的区间          │
│       → 在 decision.messages 末尾插入提炼提示              │
│       → 记 awaiting（含区间）                             │
│                                                          │
│  模型推理 → 输出提炼结果（自然语言，不是工具调用）           │
│                                                          │
└──────────────────────────────────────────────────────────┘
        ↓ 下一轮 pre-step
    收割上一轮的提炼结果
```

**⚠️ 这里有我上一版没想清的关键问题**：

「收割」需要知道**模型这一轮说了什么**。但 pre-step 触发时，
模型**还没开始这一轮推理**——它拿到的是上一轮的输出。

所以 `awaiting` 的语义必须是：
- 第 N 轮注入提示
- 第 N 轮模型输出提炼结果
- **第 N+1 轮** pre-step 时才收割（此时能读到第 N 轮的 assistant 消息）

这要求：**从 session 事件流里拿到「最后一条 assistant 消息」**。
我上一版用 `lastAssistant` Map，但**从未写入过它**——这是死代码。

正确做法：监听 `assistant/message` 事件，把最近一条存起来。

---

## 四、还需要确定的三件事

### 4.1 提炼结果怎么与提示配对

模型可能：
- 正常输出提炼结果
- 输出别的东西（跑偏）
- 什么都没输出

**判断依据**：awaiting 存在 + 上一条 assistant 消息发生在那之后 + 内容非空。

**风险**：模型可能把提炼结果和别的回复混在一起。接受这个风险——
提炼是「尽力而为」的优化，不是正确性要求。

### 4.2 一次只安排一个区间

`awaiting` 每会话最多一条。避免同时注入多个提示把上下文撑爆。

### 4.3 提示只出现一次

注入的提示在**收割时**连同旧区间一起被 `replace` 遮蔽。
所以它只存在一轮，之后消失。

---

## 五、实现清单（想清楚再写）

| 模块 | 职责 | 关键点 |
| --- | --- | --- |
| `loop/store.ts` | awaiting 持久化 | ✅ 已写，字段够用 |
| `loop/engine.ts` | 决策逻辑（收割/注入） | ⚠️ 需要改：收割要能拿到 assistant 文本 |
| `dsh-bundle.ts` | pre-step 钩子 + assistant 事件监听 | ❌ 上一版签名错、没写 lastAssistant |
| `seal/apply.ts` | replace 逻辑 | ✅ 已写，可用 |

**最小正确路径**：

1. 监听 `session/event` 的 `assistant/message` → 存最后一条文本与 seq
2. pre-step 里：
   - 若有 awaiting 且有比它更新的 assistant 消息 → 收割
   - 否则若无 awaiting → 找区间、注入提示、记 awaiting
3. 返回完整的 decision（原样返回，或带注入的新数组）

---

## 六、我上一版的三个错误（留档）

| # | 错误 | 后果 |
| --- | --- | --- |
| 1 | pre-step 签名写成 `(payload, next)` | 类型不匹配，编译失败 |
| 2 | 返回 `{messages}` 而非完整 `PreStepDecision` | 运行时会被 loop 拒绝 |
| 3 | `lastAssistant` 只读不写 | 收割永远拿不到内容，功能空转 |

**共同点：都是没有先读真实契约就动手。**
