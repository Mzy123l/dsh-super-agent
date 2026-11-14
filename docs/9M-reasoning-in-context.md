# 思考内容（reasoning）在上下文中的处理

> 调查对象：DSH `0.2.1-rc.5`，`E:\Applications\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\`
> 方法：只读源码（`src/*.ts` 为原始 TS，`lib/*.js` 为编译产物，两者对照）与 README。

## 1. 直接回答（一句话 + 流程图）

**结论：会进。** assistant 轮次产生的 reasoning 块被完整写入 Session 日志（`assistant/message` 事件），`deriveMessages()` 原样投影进模型历史，DeepSeek Messages 适配器把每个 reasoning 块逐字序列化为 `thinking` 内容块回传到下一次请求——完整保留，不截断、不占位符。没有配置开关控制这一行为。

```
模型流式输出
  └─ reasoning-delta ─→ BlockAssembler → ReasoningBlock { type:'reasoning', text }
        └─ dsh-agent-loop: session.append('assistant/message', { message })   ← 含 reasoning 块
              ├─ dsh-session-persistence-jsonl: 逐事件编码落盘（含内嵌 stream）
              └─ session.deriveMessages(): surface 投影，reasoning 块原样保留
                    └─ 下一轮请求: header.config + deriveMessages() + header.tools
                          └─ dsh-llm-deepseek/serialize.ts: assistant()
                               case 'reasoning' → { type:'thinking', thinking: block.text, signature? }
```

## 2. 请求侧证据（A1–A3）

**A1. reasoning_content 会不会出现在下一次请求的 messages 里？——会。**

- 代码：`dsh-llm-deepseek/src/serialize.ts:31-34` —— assistant 消息的 `case 'reasoning': return { type: 'thinking', thinking: block.text, ...signature }`，即每个 reasoning 块逐字变成 DeepSeek Messages 的 `thinking` 块。
- README 原文（`dsh-llm-deepseek/README.zh.md:176`）：「此前 assistant 轮次的推理内容会原样传回，无论该轮次是否调用了工具。」
- README 原文（`dsh-llm-deepseek/README.md:180`）：「Reasoning passback carries every reasoned turn's chain of thought into later requests」。
- 上游来源：`dsh-agent-loop/src/agent.ts:572-588` —— `createAssistantMessage({ content: live.blocks() })` 整体提交为 `assistant/message`；reasoning 块在 `live.blocks()` 里未被过滤（对照 `dsh-llm/src/assembler.ts:112` 的 `case 'reasoning'` 产出完整块）。
- Session 投影：`dsh-session/src/surface.ts:140-142` —— `assistant/message` 的 `event.data.message` 整体返回，不剥离 reasoning 块；`deriveMessages()` 以此构成模型历史。

**A2. 完整保留、截断、还是占位符？——完整保留（逐字）。**

- `serialize.ts:32` 直接传 `block.text`，无截断/占位逻辑；user 与 tool-result 方向才做省略（见 E7）。
- 附加元数据：thinking 签名（`signature_delta` → `replay.signature`，`dsh-llm-deepseek/src/translate.ts:78-80`）随块回传；回放元数据非法时「发出警告并省略签名，同时保留文本与工具历史」（`dsh-llm-deepseek/README.md:85`）——签名可丢，思考文本不丢。
- 缓存影响：README.md:184「reasoning passback appends on every reasoned turn」——每个带思考的轮次都会向后追加，破坏前缀复用从该点起。

**A3. 有没有配置开关？默认值？——未找到。**

- `dsh-llm-deepseek` 的 Config 只有 `thinking: 'enabled' | 'disabled'` 与 `reasoningEffort: 'off' | 'low' | 'high' | 'max'`（`src/types.ts:130-132`、`src/config.ts:25,95`），二者控制「生成时是否思考、用多大强度」，均不控制「历史 reasoning 是否回传」。
- 全包 grep `reasoning` 无任何 passback/retain/drop 开关；serialize.ts 回传是无条件的。
- README 未记载任何相关开关；`dsh/docs/config-catalog.md` 中相关字段（`reasoningEffort`、pi-ai 的 `compat.thinkingFormat` 等）也都只作用于请求参数或协议格式，不作用于历史回传。
- 结论：**无开关，默认且唯一行为是完整回传**（DeepSeek Messages 路由）。注意：`reasoningEffort: 'off'` 只让新输出不思考，历史里已有的 reasoning 块仍照传。

## 3. 日志侧证据（B4）

**存，且有两份：内容块内嵌 + 事件内嵌流。**

- `assistant/message` 事件的 `data.message.content` 含 `ReasoningBlock`（`{ type: 'reasoning', text }`）；类型目录明确收录：`dsh/docs/persistence-catalog.md:4544-4557`（`ReasoningBlock`，`type` 必需 `"reasoning"`）。
- 事件同时内嵌紧凑带时间戳的 provider stream，其中 reasoning 以 `reasoning` / `reasoning-chunks` 记录存在（persistence-catalog.md:2339-2359、8737-8763）。
- 校验保证两者一致：`dsh-session-persistence-jsonl/src/generation.ts:556-574` —— 种子数据里 `message.content` 与内嵌 stream 重放出的 blocks 必须 `isDeepStrictEqual`，否则报 "content disagrees with its embedded stream"。
- 即：reasoning 不需要单独字段——它就是消息内容块的一部分，日志逐事件完整落盘。

## 4. 压缩侧证据（C5）

**摘要输出侧：排除，出处核实无误；但摘要输入侧：reasoning 随历史照常回放给摘要模型。**

- 9B 报告引用的原文确认存在于 `dsh-compaction-basic/README.zh.md:129`：「调用将 `GenerateOptions.purpose` 设为 `compaction`；只有返回文本进入检查点，推理与工具调用都会被排除。」英文版 README.md:129 同义（"only returned text enters the checkpoint, excluding reasoning and tool calls"）。
- 代码实现：`dsh-compaction-basic/src/summarizer.ts:213-221` —— `summaryText()` 过滤 `block.type === 'text'`，reasoning 块不会进入 `frameSummary()`（188-194 行只包裹 text 块）。
- 另一处原文（README.zh.md:198）：「会话模型绝不会看到该私有请求或其推理；只有返回文本会被存储。」——压缩是独立辅助请求，其推理不回灌。
- 关键区分：被排除的是**摘要模型自己的输出推理**；被压缩区域里的**历史 reasoning** 在回放给摘要模型时按 A1 的同一序列化路径照传（`summarizer.ts:145-151` 直接使用 `input.messages`，未剥离块）。
- 压缩指令 `maxTokens` 口径（README.zh.md:74）：「正数摘要输出上限，包含提供方计入的推理 token」——即隐藏推理会消耗摘要输出额度，可能触发截断。

## 5. 计量侧证据（D6）

**计入。reasoning 块在 surface 历史里就按其文本长度计价；提供方报告的 prompt 压力自然也含它。**

- 启发式计价：`dsh-token-meter/src/estimate.ts:47-48` —— `case 'text': case 'reasoning': tokens += ceil(text.length / 4) + BLOCK_OVERHEAD`，reasoning 与 text 同一计价分支；`estimateMessage()`（88-91 行）对所有模型可见消息整体计价，assistant 消息里的 reasoning 块不豁免。
- `measure().nodes[].tokens` 与 `contextBreakdown.messageTokens` 因此包含历史 reasoning（README.md:36,53：surface-only 总量 = 各节点之和）。
- 提供方口径：`pressureTokens` = provider 报告的 prompt 规模（`src/usage-projection.ts:77-79`，input + cacheRead + cacheWrite）——回传的 thinking 块在请求体里，自然计入。
- 用量侧不重复计：`reasoningTokens` 是 `outputTokens` 的信息性子桶，汇总时不得再加（`dsh/docs/subsystems/llm-streaming.zh.md:342`）。

## 6. 与工具结果的对比（E7）

**同：全量进日志、全量回传、同被启发式计价、同被压缩摘要排除输出。异：方向性省略与修剪器。**

| 维度 | 工具调用/结果 | reasoning |
|---|---|---|
| Session 日志 | `tool/result` 事件全量存 | `assistant/message` 内容块全量存 |
| 下一次请求 | tool-call → `tool_use`，结果 → `tool_result` 全量传 | 逐字传为 `thinking` 块 |
| user/tool-result 内部 | —— | 两者一起被省略：`serialize.ts:67` `if (block.type === 'reasoning' || block.type === 'tool-call') return []`（README.zh.md:176「Messages 会省略用户消息和工具结果中的 reasoning 与 tool-call 块」） |
| token 计价 | `tool-call` 有独立分支（estimate.ts:50-53） | 与 text 同分支（47-48 行） |
| 压缩摘要输出 | 排除 | 排除 |
| 专用修剪器 | 有：`dsh-compaction-tool-result-pruner` 先修剪超大工具结果再压缩 | **未找到**：无 reasoning 修剪器 |

结论：主链路上 reasoning 与工具结果**同待遇**（都全量持久、全量回传、同占压力）；唯一区别是工具结果有专门的预压缩修剪器，reasoning 没有——大段思考只能靠整体压缩摘要消掉，且摘要模型输入里它仍在。

## 7. 设计含义

1. **模型"记得"自己想过什么**：下一轮请求里它能看到前几轮的完整 chain-of-thought，无需靠 visible text 复述推理；self-gist（用模型自己提炼自己的思考）在 DSH 里不是唯一记忆通道——系统本来就替它存了。
2. **self-gist 的省 token 假设不成立**：历史 reasoning 不但没被丢弃，还逐字回传并计入 `pressureTokens`/`projectedTokens`（D6）。若目标是省上下文，self-gist 需要主动**改写/替换** assistant 消息内容（surface replacement），而不是指望系统已裁剪；替换会从首个被改 token 起打破前缀缓存（README.md:184 同理：reasoning passback 每个思考轮都在追加，缓存收益本就受限）。
3. **日志是金矿**：reasoning 在 JSONL 里有两份一致副本（内容块 + 内嵌流，generation.ts 校验相等），self-gist 或事后分析可直接读会话日志取思考原文，不必重放模型。
4. **无开关意味着无法轻量关闭**：想减小 thinking 回传开销，现版本只能靠 `reasoningEffort: 'off'` 停止新思考、或压缩旧历史；没有"回传但截断/占位"的中间档。
5. **语义搜索不含 reasoning**（`dsh/docs/subsystems/session-query.zh.md:147`：reasoning 块不纳入语义文本）——基于 session 检索做 self-gist 素材收集时，别指望搜索命中思考内容，要按 seq 直接读消息。

---

### 附：核实清单

| 问题 | 答案 | 关键证据 |
|---|---|---|
| A1 回传？ | 是（DeepSeek Messages 路由） | serialize.ts:31-34；README.zh.md:176 |
| A2 形式 | 逐字完整 + 可选签名；签名可降级丢弃 | serialize.ts:32-33；README.md:85 |
| A3 开关 | 未找到；无开关，默认回传 | types.ts:130-132（Config 全集） |
| B4 日志 | 存（内容块内嵌 + stream 双份） | persistence-catalog.md:4544；generation.ts:556-574 |
| C5 压缩 | 摘要输出排除（出处属实）；摘要输入不排除 | README.zh.md:129,198；summarizer.ts:213-221 |
| D6 计量 | 计入（surface 计价 + provider prompt 压力） | estimate.ts:47-48；usage-projection.ts:77-79 |
| E7 对比 | 主链路同待遇；工具结果有修剪器，reasoning 无 | serialize.ts:67；package.json:39 |
