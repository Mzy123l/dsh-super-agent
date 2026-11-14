# memory-plugin — DSH 会话记忆插件（纯理论实现）

## 与规格的偏差（先读这段）

按 [9O 规格](../docs/9O-memory-plugin-spec.md) 实现，以下偏差需要知道：

| 偏差 | 说明 |
| --- | --- |
| 验收 1 的数字口径 | 真实数据实测 274 个会话文件（规格写作 245；实时增长），索引记录数见下方实测输出，量级与 9I 的 223,513 一致。 |
| 向量维度/表 | 规格 §2.3 的 `vec0` 虚表未建——better-sqlite3 不带 sqlite-vec 扩展，向量走注入式 `VectorStore`（内存 Map 余弦 top-k，理论实现）；`NoopVectorStore` 下 vectors 计数恒为 0。规格也明确"向量维度与来源不写死、接口注入"。 |
| FTS 中文分词 | unicode61 不分中文词，规格 §4.1 预告了局限。实现加了超出规格的补偿：索引侧 CJK 逐字分词 + 查询侧单字 phrase（`src/search/segment.ts`），"待办"能命中"记成待办"。这是字级匹配不是真分词，取舍见 DESIGN.md §3。 |
| schema.sql 语义 | 规格 §2.3 的 `records` 主键 `(sessionId, seq, kind)` 原样保留；`vectors` 虚表换成注入式接口后，watermarks/meta 两张规格未画的表是增量索引与 status 的必要补充。 |
| hybrid 实测范围 | hybrid 双路合并（RRF k=60）在单测中用 fake embedding 端到端验证；CLI 对真实数据默认 Noop（无 embedding key），故真实搜索实测都是 keyword 模式。 |
| CLI 增加了 serve 子命令 | 规格 §5.2 只列 index/search/status；HTTP API（§5.1）需要一个入口，加了 `serve`。 |
| 图片占位文本 | 规格示例"（图片，未索引）"，实现为通用占位"（未索引内容）"——日志事件里图片以 content block 出现，插件在 content 层无法区分图片与二进制。 |
| build 用 tsc | 规格建议 tsdown 或 tsc；用 tsc + 5 行 postbuild 脚本复制 schema.sql，少一个依赖。 |

没做的（与规格 §7 一致）：不动 `~/.dsh`（除只读扫描 sessions）、不挂载 profile、不自动触发、不索引 spill 正文、不接真向量模型。

## 是什么

把 dsh 会话日志（`.jsonl.zstd`，拼接 zstd 帧）**复制**进插件自己的 SQLite 库，提供：

- **关键词搜索**（FTS5，全量记录，含被压缩遮蔽的事件，带 shadowed 标记）
- **向量检索**（注入式 embedding，reasoning 只在这里可搜——决策①）
- **双路合并**（RRF，k=60）
- **只读 HTTP API**（为未来 Router/面板预留）

四条用户决策的落实细节见 [DESIGN.md](DESIGN.md)。

## 用法

```bash
pnpm install && pnpm build

# 全量索引（对真实 ~/.dsh/sessions，只读原文件；索引写入 ./data）
node dist/cli.js index --all

# 关键词搜索
node dist/cli.js search "待办"
node dist/cli.js search "时间戳" --limit 10
node dist/cli.js search "待办 OR 时间戳" --order time

# hybrid（需先配置 embedding 环境变量，否则自动退化为关键词）
MEMORY_EMBEDDING_API_KEY=... MEMORY_EMBEDDING_BASE_URL=... MEMORY_EMBEDDING_MODEL=... \
  node dist/cli.js search "那个日期问题" --mode hybrid

# 状态
node dist/cli.js status

# HTTP 只读 API（默认 127.0.0.1:7800）
node dist/cli.js serve
# GET /status  GET /search?q=&mode=  GET /records?sessionId=&shadowed=  GET /reasoning?sessionId=  POST /index
```

指定目录：`--sessions <dir>`（默认 `~/.dsh/sessions`）、`--data <dir>`（默认 `./data`）。

## 架构

```
sessions/**/session.v4.jsonl.zstd   （只读）
        │  ingest/log-reader.ts     逐帧解压（magic 0xFD2FB528，坏帧/残帧跳过）
        ▼
   ingest/extractor.ts              事件 → MemoryRecord / ReasoningRecord / shadowedSeqs
        │                           （决策①③的落实点）
        ▼
   ingest/indexer.ts                写库 + FTS + 向量双通道
        ▼
   store/sqlite.ts  ← schema.sql（唯一权威建表）
        │
        ├── search/keyword.ts       FTS5 关键词（segment.ts 补中文分词局限）
        ├── search/vector.ts        注入式向量（Noop / OpenAI 兼容）
        └── search/merge.ts         RRF k=60 双路合并
                │
                ├── cli.ts           index / search / status / serve
                └── api/server.ts    HTTP 只读 API
```

## 安全边界

- 只读 `sessions/**/session.v4.jsonl.zstd`；不打开凭据、vault 等任何其他 `~/.dsh` 文件。
- 原文件绝不修改；索引数据只写 `--data` 目录（已 gitignore）。
- embedding key 只从环境变量读；HTTP API 无鉴权 = 只监听 127.0.0.1。

## 开发

```bash
pnpm test      # vitest + 覆盖率（store/extractor/search ≥80%）
pnpm build     # tsc → dist/
pnpm typecheck
```
