# 记忆插件规格（9O）

> **本文是 `memory-plugin/` 实现的规范与验收标准。**
> 四项用户决策已定（见 [9N](9N-cross-time-recall.md) 修订说明）：
> ①思考不进关键词索引、只向量化；②不启用 dsh 内置 session-query，自建存储复制数据；
> ③搜索全量（搜原始日志，不管压缩/摘要状态）；④不做轮末自动触发（未来 Router 提醒）。
>
> **纯理论编写**：不动本机 `~/.dsh`，不挂进任何 profile，只交付可 review 的代码与文档。

---

## 1. 交付物

```
memory-plugin/
├── README.md                  # 使用说明 + 架构 + 与 dsh 的关系（理论定位）
├── package.json               # 纯 TS 包，不声明 dsh 依赖（理论阶段）
├── tsconfig.json
├── src/
│   ├── index.ts               # 导出全部公共 API
│   ├── types.ts               # 全部类型定义
│   ├── store/
│   │   ├── sqlite.ts          # SQLite 存储（better-sqlite3）
│   │   ├── schema.sql         # 建表语句（唯一权威，代码不得内联建表）
│   │   └── fts.ts             # FTS5 关键词索引维护
│   ├── ingest/
│   │   ├── log-reader.ts      # 逐帧解压 .jsonl.zstd → 事件流
│   │   ├── extractor.ts       # 事件 → 可索引记录（含四条决策的落实）
│   │   └── indexer.ts         # 写库 + FTS + 向量双通道
│   ├── search/
│   │   ├── keyword.ts         # FTS5 关键词搜索
│   │   ├── vector.ts          # 向量检索（接口 + SQLite 落地，embedding 可注入）
│   │   └── merge.ts           # 双路合并（RRF，k=60）
│   ├── api/
│   │   └── server.ts          # HTTP 只读 API（供 Router/面板未来使用）
│   └── cli.ts                 # 命令行：index / search / status
├── tests/                     # vitest，覆盖率 ≥80%
└── DESIGN.md                  # 设计决策记录（为什么这么做）
```

**硬性边界**：
- 不 import 任何 `@deepseek-ai/*` 包（纯理论阶段，数据靠复制）
- 不读写 `~/.dsh`（运行时数据路径由配置传入，默认 `./data/`）
- 不实现 dsh 插件挂载（`post-execute` 等），但 **DESIGN.md 必须写清未来挂载点**（`tools/post-execute`，9B §2 表第 9 行）
- 不做轮末触发、不做自动提醒（未来 Router 职责，DESIGN.md 说明接口预留）

---

## 2. 数据模型

### 2.1 输入：dsh 会话日志

来源是 `.jsonl.zstd`（拼接 zstd 帧，逐帧解压），复用已验证的解压方式。
**只复制，不移动、不修改原文件。** 索引存放在插件自己的数据目录。

### 2.2 记录类型（`types.ts` 必须含这些）

```ts
/** 一次工具调用或一条消息的可索引记录 */
interface MemoryRecord {
  seq: number                 // 原日志中的事件 seq
  sessionId: string           // 会话 id（从目录名提取）
  kind: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'summary'
  at: string                  // ISO 时间
  text: string                // 可检索正文（按 §3 规则提取）
  turn?: number               // 所在轮次（日志里有 turn/start 可归属）
}

/** 用户决策④：搜索全量——被压缩遮蔽的事件照常索引 */
// 实现要点：不读 surface 投影，直接读原始事件流（含 shadowed）。
// 每条记录带 shadowed 标记，供 UI 未来展示"这条已不在上下文里，但在库中"。

/** 用户决策①：reasoning 不进 FTS，只向量化 */
interface ReasoningRecord {
  seq: number
  sessionId: string
  at: string
  turn?: number
  text: string                // 思考原文（只进向量库，绝不进 FTS）
  summary?: string            // 若有 self-gist / turn-summary，可关联（理论预留）
}
```

### 2.3 表结构（`schema.sql` 唯一权威）

```sql
-- 关键词索引：不含 reasoning（决策①）
CREATE VIRTUAL TABLE records_fts USING fts5(
  text, sessionId UNINDEXED, seq UNINDEXED, kind UNINDEXED, at UNINDEXED
);

-- 全量记录（含 shadowed 标记；决策③）
CREATE TABLE records (
  sessionId TEXT, seq INTEGER, kind TEXT, at TEXT,
  turn INTEGER, text TEXT, shadowed INTEGER DEFAULT 0,
  PRIMARY KEY (sessionId, seq, kind)
);

-- reasoning 单独存（决策①：只向量化，不进 FTS）
CREATE TABLE reasoning (
  sessionId TEXT, seq INTEGER, at TEXT, turn INTEGER, text TEXT,
  PRIMARY KEY (sessionId, seq)
);

-- 向量表（embedding 注入式：插件不绑定具体模型）
CREATE VIRTUAL TABLE vectors USING vec0(
  record_id TEXT PRIMARY KEY,      -- 'r:<sessionId>:<seq>:<kind>' 或 'n:<sessionId>:<seq>'
  embedding float[<维度>]
);
```

> 向量维度与 embedding 来源**不写死**：`VectorStore` 接口由调用方注入实现；
> 理论阶段提供一个 `NoopVectorStore`（空实现，向量检索返回空）与一个
> `OpenAICompatVectorStore`（任何 OpenAI 兼容 embedding 端点，key 从环境变量读）。

---

## 3. 提取规则（`extractor.ts`，四条决策的落实点）

| 用户决策 | 落实 |
| --- | --- |
| ①思考只向量化 | `assistant/message` 里的 reasoning 块 → `reasoning` 表 + 向量；**绝不写 records_fts** |
| ③搜索全量 | 逐事件遍历**原始日志**（含 shadowed），每条打 `shadowed` 标记；**不读 surface 投影** |
| 待办不再保全 | 摘要（`summary` kind）**照常索引**——它只是历史的一部分，不再承担"待办清单"职责 |
| ④不自动触发 | 本插件无任何主动注入逻辑；检索只能被显式调用 |

其他提取规则：
- `user/message` / `assistant/message` 的可见文本 → `records_fts` + 向量
- `tool/call` → 记录工具名 + 参数摘要（`JSON.stringify(args).slice(0, 500)`）→ 只进 FTS（参数无语义价值）
- `tool/result` → 按 spill/prune 状态区分：被裁剪的记录裁剪标记 + spill 路径（**正文在 spill 文件里，理论阶段不索引 spill 文件内容**，DESIGN.md 说明）
- `compaction/summary` → kind=`summary`，正文进 FTS + 向量（它是"发生过压缩"的事实，可检索）
- 图片/二进制 → 跳过，记录占位（"（图片，未索引）"）

---

## 4. 搜索语义

### 4.1 关键词（FTS5）

- 默认 AND，支持显式 `OR`；中文按 FTS5 默认 tokenizer（unicode61）——**DESIGN.md 诚实标注**：中文分词质量有限，长词命中好、短语命中差，这是用向量检索补的点
- 返回：`{ sessionId, seq, kind, at, turn, snippet(±80字), shadowed }`
- **排序**：默认按 FTS rank；`--by time` 按时间

### 4.2 向量（接口注入）

- `VectorStore.search(embedding, k)` → 按余弦/内积 top-k
- 查询文本 → 调用注入的 embedding 实现 → 向量检索 → 回链 `records`/`reasoning` 表取正文
- reasoning 命中时结果标记 `kind: 'reasoning'`——**调用方据此知道这是思考不是事实**

### 4.3 双路合并（RRF, k=60）

`search(text, { mode: 'hybrid' })` = RRF 合并关键词与向量两路；`mode: 'keyword'` 只走 FTS。
**理论阶段 hybrid 依赖真实 embedding 实现；NoopVectorStore 下自动退化为纯关键词。**

---

## 5. API 与 CLI

### 5.1 HTTP API（只读，为 Router/面板预留）

```
GET /records?sessionId=&kind=&q=&shadowed=      # 分页列表
GET /search?q=&mode=keyword|hybrid&limit=       # 搜索
GET /reasoning?sessionId=&q=                    # reasoning 专用（仅向量命中）
GET /status                                     # 各表计数、最后索引时间
POST /index                                     # 触发增量索引（读配置的日志目录）
```

只读 + 一个 POST。**无鉴权 = 只监听 127.0.0.1**（DESIGN.md 说明；未来 Router 接入时再议）。

### 5.2 CLI

```
memory-plugin index [--session <id>] [--all]     # 建/增量索引
memory-plugin search "待办" [--mode hybrid] [--limit 20] [--json]
memory-plugin status
```

---

## 6. 验收标准（明早验收清单）

| # | 标准 | 验证方式 |
| --- | --- | --- |
| 1 | **解压正确**：对 `~/.dsh/sessions` 只读扫描，解压 245 个文件的记录数与 9I 的口径一致（223,513 条量级） | 跑 `index --all`，比对 status 计数 |
| 2 | **关键词搜索可用**：搜「待办」能命中历史里的承诺语句，返回 seq 可定位 | CLI 实测 |
| 3 | **全量性**：被压缩遮蔽的事件在结果里出现且带 shadowed 标记 | 用 98 里已知被遮蔽的 seq 验证 |
| 4 | **reasoning 隔离**：FTS 搜不到任何 reasoning 原文；向量库里有 reasoning 记录 | 分别查两个表 |
| 5 | **摘要照常索引**：`compaction/summary` 17 条全部可搜 | 按 kind=summary 过滤 |
| 6 | **无副作用**：`~/.dsh` 目录哈希前后一致；插件数据只写在自身目录 | 前后对比 |
| 7 | **测试**：`pnpm test` 全绿，覆盖率 ≥80%（store/extractor/search 三模块） | vitest |
| 8 | **零依赖 dsh**：`package.json` 无 `@deepseek-ai/*` | 人工 review |
| 9 | DESIGN.md 完整：四条决策的落实说明 + 未来挂载点（post-execute）+ Router 接口预留 | 人工 review |

> **验收 1 的诚实说明**：实际数字可能因实时会话增长而不同，口径是"量级一致"（±5%）。

---

## 7. 明确不做（本轮边界）

| 不做 | 理由 |
| --- | --- |
| 不改 `~/.dsh` | 纯理论；数据靠复制 |
| 不做 dsh 插件挂载 | 先验证价值，再接缝（未来挂 `tools/post-execute`，9B §2 表第 9 行） |
| 不做轮末触发/提醒 | 用户决策④；未来 Router 职责，HTTP API 已预留 |
| 不做压缩声明保全待办 | 用户决策③（搜索全量后，声明保全不再必要——**这是决策③的隐藏收益**：9N 原来的"压缩前保全"机制整个不需要了，因为"原文永远可搜"替代了"原文必须驻留"） |
| 不索引 spill 文件正文 | spill 有路径已够定位；真要搜再扩 |
| 不做真向量模型 | embedding 注入式，理论阶段 Noop；接哪家模型是部署决策 |

---

## 8. 给实现子代理的提示

- 逐帧解压函数在 9I/98 的报告里有验证过的版本（magic `0xFD2FB528`，拼接帧），直接复用逻辑
- **不要打印、不要复制凭据类文件**（`.credentials.yaml`、`workbuddy-vault/` 等）——只读 `sessions/**/session.v4.jsonl.zstd`
- 会话文件被实时写入（当前会话自己在追加），坏帧 try/catch 跳过
- 中文注释、英文变量名；vitest；**不装 better-sqlite3 之外的运行时依赖也可以用纯 JSON 落地**（理论阶段质量优先于性能，DESIGN.md 说明取舍）——但如果用 better-sqlite3，FTS5 是内置的，别自己造倒排
- 报告写到本文件所在目录：实现完成后在 `memory-plugin/README.md` 顶部写一段"与规格的偏差"（有哪些没做、为什么）
