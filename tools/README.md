# gen-memory-debug — 上下文增量对比 HTML 生成器

把两轮采集到的上下文 JSONL（每轮 = 一个 session 的完整消息序列）渲染成一个**自包含 HTML**，
左右横向对比「不启用插件」与「启用插件」两条链路的上下文构成。

## 快速开始

```bash
cd tools
npm install
npx tsc -p tsconfig.json

# 两侧各一个文件
node dist/gen-memory-debug.js \
  --on  ../capture/capture-on.jsonl \
  --off ../capture/capture-off.jsonl \
  --out ../memory-debug.html

# 目录模式：读出目录下所有 .jsonl，按每行的 variant 字段分流
node dist/gen-memory-debug.js --dir ../capture --out ../memory-debug.html
```

输出 `memory-debug.html` 直接双击打开即可（单文件，零外部依赖，无网络请求）。

## 参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--on <path>` | 启用插件一侧的 JSONL（可重复） | — |
| `--off <path>` | 不启用插件一侧的 JSONL（可重复） | — |
| `--dir <path>` | 目录：递归读出全部 `.jsonl`，按每行的 `variant` 字段分流 | — |
| `--out <path>` | 输出 HTML 路径 | `memory-debug.html` |
| `--max-chars <n>` | 单条正文进入页面的字符上限（0 = 不截断） | `20000` |
| `--preview <n>` | 折叠态每段显示的字符数 | `220` |
| `--max-ops <n>` | 单个气泡最多渲染的操作条数（超出折叠） | `200` |
| `--title <text>` | 页面标题 | 上下文增量对比 |
| `--quiet` | 不打印摘要 | — |

## 输入格式

采集插件每行写一条 JSON（与 `memory-debug-capture` 的契约一致）：

```json
{
  "ts": "2026-11-15T06:00:10.000Z",
  "sessionId": "session-...",
  "provider": "deepseek",
  "model": "deepseek-chat",
  "step": 3, "turn": 1, "variant": "on", "runId": "run-...",
  "messages": [
    { "role": "system", "text": "...", "chars": 1234 },
    { "role": "assistant", "text": "...", "chars": 56,
      "reasoning": "...", "reasoningChars": 900 }
  ],
  "totals": { "messages": 12, "chars": 48123, "reasoningChars": 90210, "systemChars": 2273 }
}
```

字段语义：

- `chars` = 所有消息 `text.length` 之和（**不含** reasoning）
- `reasoningChars` = 所有消息 `reasoning.length` 之和（与 `chars` 互斥）
- `systemChars` = `role==="system"` 的 `text` 之和（是 `chars` 的**子集**）
- `(turn, step)` 是序号二元组；`step` 每个 turn 重置为 1，**不能**单独当全局序号
- `ts` 是主排序键（ISO 字符串，字典序 == 时间序）

解析是**宽松**的：缺字段给默认值，未知键忽略，坏行跳过并计入页面上的告警区。

## 增量算法（LCP 细节）

每个气泡 = 一次请求送出的上下文。**不把全量塞进气泡**——只列相对上一次请求的变化。

对「本次 messages」与「上一步 messages」两个序列：

1. **LCP（最长公共前缀）**：从头逐位比较 `(role, pid, rpid)` 三元组，相同即前移。
   得到 `lcp` —— 前 `lcp` 条与上一步**逐字节一致**（正文与 reasoning 都同）。
   这一段标记为「未变前缀」，默认折叠，只给一条汇总（条数 + role 分布）。
2. **公共后缀**：从尾部反向比较，得到 `suf`。
   （例如中间插入了新消息但结尾不变；或 reasoning 补在尾部。）
3. **脏区（LCP 与 suffix 之间的部分）**：两侧分别用 **LCS（最长公共子序列）** 对齐：
   - LCS 命中的元素 → 未变（罕见：位置漂移）
   - LCS 之外的本次元素 → **新增**
   - LCS 之外的上次元素 → **消失**
   - 同 role 的「本次 vs 上次」配对，正文或 reasoning 变了：
     变长 → **增长**，等长改写或变短 → **变化**
4. **退化保护**：脏区规模超过 `LCS_MAX = 400`（即 `|cur|×|old| > 160000`）时，
   放弃 LCS，改走**线性对齐**（同 role 配对），最坏情况不退化成 O(n·m)。

### 为什么用 `(role, pid, rpid)` 三元组判等

正文按**内容哈希**编号（`pid`），reasoning 单独一个池（`rpid`）。
采集插件把 reasoning 作为 assistant 消息内的**独立字段**，所以：

- 「同一条消息补上了 reasoning」= `pid` 相同、`rpid` 从 -1 变成有值 → 判为**增长**，
  并把 reasoning 的字符数计入增量。
- 「同一条消息正文被改写」= `pid` 变了 → 判为**变化**或**增长**。
- 「内容哈希相同」= 未变，**不做任何字符串比较**。

### 两侧 LCP 长度不同 → 重要发现

两侧**各自独立**计算 LCP。同一序号（气泡 N）的两侧 LCP 长度不同时：

- 气泡上打黄色高亮标签「LCP 与对侧差 ±N」
- 气泡整体加黄色描边（`bubble--diff`）
- 底部汇总表该行整行标黄（`lcp-diff`）
- 「只看差异」模式下该行一定保留

## 页面结构

```
┌─────────────────────────────────────────────────────────┐
│ 标题 + 元信息（runId、模型、提供方、总气泡数、生成时间）  │
├─────────────────────────────────────────────────────────┤
│ 工具条：只看差异 / 全量 · 联动滚动开关                    │
├─────────────────────────────────────────────────────────┤
│ 概览卡：不启用最终值 / 启用最终值 / 累计节省 / 单步最大节省│
├──────────────────────────┬──────────────────────────────┤
│  左栏：variant=off       │  右栏：variant=on             │
│  ● 气泡 1  step 1         │  ● 气泡 1  step 1            │
│  ● 气泡 2  step 2         │  ● 气泡 2  step 2            │
├──────────────────────────┴──────────────────────────────┤
│ 底部：逐 step 对比表 + 总节省量                          │
└─────────────────────────────────────────────────────────┘
```

**布局用「行」而不是「列」**：每一行 = 同一步的左右两个气泡（CSS grid 两列）。
这样两侧同一步的气泡**顶部严格对齐**（实测偏差 0 px），即使两侧气泡高度不同。

### 颜色约定

| 含义 | 颜色 |
| --- | --- |
| 新增 | 绿 |
| 消失 | 红 |
| 增长 / 变化 | 黄 |
| 未变 | 灰 |

### 大文件处理

三层措施，保证几十 MB 的上下文不会让页面卡死：

1. **正文池去重 + 裁剪**：同一段正文在内存和载荷里只存一份；
   载荷生成后扫一遍所有操作，**只保留被引用**的正文（未被引用的绝大多数是「未变前缀」里的）。
   实测把 117 MB 的 HTML 压到 14.7 MB。
2. **客户端虚拟化**：服务端只渲染气泡的「壳」（头部 + 统计标签 + 空正文区），
   正文由 JS 在**进入视口时才填充**（`requestAnimationFrame` 节流，上下各多留一屏）。
   33k 个气泡的页面，DOM 里同时只有几十个气泡有正文。
3. **默认折叠 + 截断**：正文默认只显示前 N 字符（`--preview`），点「展开全文」才展开；
   单条正文进页面前先按 `--max-chars` 截断（默认 20000 字符）。
   汇总表最多 500 行，超出部分在表尾提示。

## 开发

```bash
npx tsc -p tsconfig.json                       # 编译
node --test "dist/tests/*.test.js"             # 单元测试（12 项）
node dist/scripts/make-fixture.js ../.tmp/fixtures   # 造合成夹具
node dist/scripts/serve.js ../.tmp/fixtures 8731     # 本地静态服务（浏览器验证用）
node dist/scripts/verify.js <url> <outDir>          # 无头浏览器验证（截图 + 控制台）
node dist/scripts/bench.js 20000 60 ../.tmp/bench   # 性能压测
```

### 目录

```
tools/
├── gen-memory-debug.ts      CLI 入口
├── lib/
│   ├── types.ts             数据模型
│   ├── reader.ts            JSONL 流式读取 + 宽松解析
│   ├── diff.ts              增量 diff 引擎（LCP + suffix + LCS）
│   ├── pool.ts              正文池（去重 + 截断）
│   ├── model.ts             分组、配对、跨侧比较、池裁剪
│   └── render.ts            HTML 渲染（内联 CSS/JS + 客户端虚拟化）
├── scripts/                 夹具 / 静态服务 / 无头验证 / 压测
└── tests/diff.test.ts       diff 引擎单元测试
```

运行时零依赖（只用 Node 内置模块）。TypeScript 与 `@types/node` 是开发期依赖。

## 性能实测

环境：Windows / Node v22.18.0，机器为普通笔记本。

| 场景 | 输入 | 生成耗时 | HTML 产物 |
| --- | --- | --- | --- |
| 11 行小夹具 | 11 条消息 | 7 ms | 50 KB |
| 60 步 × 2 万条上下文 | 1,070,951 个 message 对象 / 1042 MB JSONL | 9.7 s | 14.7 MB |

即 **约 94 MB/s 的 JSONL 吞吐**，每万条 message 约 90 ms。
生成器常驻内存与「单步上下文规模」成正比（不是与总消息数成正比），
因为每一步算完 diff 就丢掉上一步的紧凑行。
