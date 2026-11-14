# DESIGN — 记忆插件设计决策记录

> 规格来源：[9O-memory-plugin-spec.md](../docs/9O-memory-plugin-spec.md)。
> 背景：[9N-cross-time-recall.md](../docs/9N-cross-time-recall.md)（场景与四条用户决策）、
> [98-compaction-findings.md](../docs/98-compaction-findings.md)（压缩实测数字口径）。

## 0. 定位（纯理论）

本插件是**纯理论实现**：不修改 `~/.dsh`（除只读扫描 `sessions/**/session.v4.jsonl.zstd`），
不挂载到任何 profile，无任何自动触发。全部价值交付为：可 review 的代码 + 可实测的 CLI/HTTP 接口。

## 1. 四条用户决策怎么落实的

### 决策① reasoning 不进 FTS，只向量化

- `extractor.ts`：`assistant/message` 事件里 `data.message.content` 中 `type === 'reasoning'`
  的块单独收集进 `ReasoningRecord`，**绝不写入 `records` 表与 `records_fts`**。
- `schema.sql`：`reasoning` 表独立建表，与 `records_fts` 无任何外键/触发器关联。
- 向量 id 约定 `n:<sessionId>:<seq>`（records 是 `r:<sessionId>:<seq>:<kind>`），
  检索命中后结果标记 `kind: 'reasoning'`——调用方据此知道"这是思考不是事实"。
- 验证：单测「reasoning 写入/读取/列出（决策①：与 FTS 隔离）」——FTS 搜 reasoning 原文必须为 0 条。

### 决策② 不用 dsh 内置 session-query，自建存储复制数据

- 全链路只 `readFileSync` 原始 `.jsonl.zstd`（只读打开，绝不写原文件），
  提取后的记录写入插件自己的数据目录（`--data`，默认 `./data/memory.sqlite`）。
- 不 import 任何 `@deepseek-ai/*` 包；dsh 内置的 `session-query` SQLite 完全不触碰。
- 取舍：复制意味着索引滞后于日志（靠 `index`/`POST /index` 手动刷新），
  换来的是 schema 完全自主（shadowed 标记、reasoning 隔离、水位线），不被 dsh 存储演进绑架。

### 决策③ 搜索全量（含被压缩遮蔽的事件）

- 不读 surface 投影、不读任何"当前上下文"，直接逐事件遍历原始日志。
- shadowed 口径：`compaction/summary` 与 `compaction/prune` 事件的 `data.shadowedSeqs`
  （98 实测 17/17 与 59/59 次都带该字段）→ 收集为 seq 集合 → 落库时对命中的 seq 打
  `shadowed = 1`。这个口径以"seq 是否被压缩事件声明遮蔽"为准，与 surface 层的实际可见性
  存在理论差异（见 98 §7.4 的诚实标注），但它是日志里唯一可机读的遮蔽信号。
- 每条搜索结果带 `shadowed` 标记，供 UI 未来展示"这条已不在上下文里，但在库中"。
- 隐藏收益（9O §7）：原文永远可搜之后，"压缩前保全待办"机制整个不需要了。

### 决策④ 无任何自动触发/提醒逻辑

- 插件无定时器、无 hook、无轮末扫描。`POST /index` 是显式调用的增量索引，
  不是自动触发；搜索只能被显式调用（CLI/HTTP）。
- 未来"主动浮现"归 Router（见 §4）。

## 2. 数据与解压

- 解压方式复用 96/9I/98 已验证口径：拼接 zstd 帧容器（magic `0xFD2FB528`），
  逐帧扫边界（`scanZstdFrames`：帧头描述符 + 块头 3 字节迭代 + checksum 4 字节），
  再对每帧单独 `zlib.zstdDecompressSync`。逻辑与 dsh 自家
  `dsh-session-persistence-jsonl/src/zstd.ts` 的 public decoder 一致（未 import，独立实现）。
- 实时写入容错：结构扫描时 EOF 截断返回 `tornStart`（残帧不计入完整帧）；
  单帧解压失败（checksum 不过）跳过并计数 `badFrames`；坏行跳过计 `parseErrors`。绝不抛出。
- 安全边界：只读 `sessions/**/session.v4.jsonl.zstd`；绝不打开
  `.credentials.yaml`、`workbuddy-vault/` 等任何其他文件；绝不修改任何原文件。

## 3. 关键词检索：FTS5 与中文的诚实局限

- 用 better-sqlite3（FTS5 内置，零额外运行时依赖）。
- **unicode61 tokenizer 的真实局限**：连续汉字串被当作单个 token。
  "记成待办"是一个词——搜"待办"两个字的查询**命不中**它。规格 §4.1 预告了这一点。
- **本实现的补偿（超出规格的部分）**：索引时把 CJK 字符逐字用空格分隔
  （`search/segment.ts` 的 `segmentForFts`），查询侧把 CJK 词转成单字 phrase
  （"待办" → `"待 办"`）。phrase 的相邻性等价于子串匹配，于是"待办"能命中"记成待办"。
- **诚实说明**：这是字级匹配，不是中文分词。代价与局限：
  1. FTS 索引体积膨胀（每个汉字一个 token，CJK 密集文本索引约 3–4 倍于原文）；
  2. 跨标点的"子串"不会命中（"待办，先干"搜不出"待办先干"——多数情况符合直觉）；
  3. 没有词级相关性：不分词就谈不上"词频/IDF"，rank 质量弱于真正的中文分词器。
  词级语义召回靠向量检索补——这正是关键词是底座、向量是增强的原因（9N §2）。
- 若未来接 dsh 主线，可换 `fts5` 的自定义 tokenizer 或 `trigram` tokenizer，接口不变。

## 4. 向量检索：注入式接口与未来接缝

- `VectorStore` + `EmbeddingProvider` 接口在 `types.ts`，插件不绑定任何模型。
- 理论阶段交付：`NoopVectorStore`（默认，hybrid 自动退化为纯关键词）与
  `OpenAICompatVectorStore`（任何 OpenAI 兼容 `/v1/embeddings` 端点；
  key 从 `MEMORY_EMBEDDING_API_KEY` 等环境变量读，不落盘、不进代码）。
- 内存 Map 暴力余弦 top-k 是理论实现；量级上去后换 sqlite-vec 或外部库，
  `VectorStore` 接口不变。
- **Router 接口预留（决策④的对应面）**：触发层的"轮末提醒"不在本插件做，
  但 HTTP API 已备好 Router 所需的只读面：
  `GET /search?mode=hybrid`（语义召回）、`GET /reasoning?q=`（思考专用检索）、
  `GET /records?shadowed=true`（"不在上下文但在库"的列表）。
  未来 Router 的轮末扫描只需要调这三个 GET + 自行决定注入与否——
  插件保持被动，注入决策权在 Router。

## 5. 未来 dsh 挂载点（本轮不做）

- 挂载点：`tools/post-execute`（9B §2 表第 9 行）。
  轮次结束时 dsh 调用插件的 post-execute 回调，插件在那里做两件事（未来）：
  1. 增量索引本轮新增事件（比全量扫描便宜得多，水位线已备好）；
  2. （若 Router 接管触发）把 open 待办的提醒请求递给 Router。
- 在那之前，索引只能由用户手动 `memory-plugin index` 或 `POST /index` 触发。
- 挂载需要的 dsh 侧配置（profile patch + 插件 manifest）不在本轮范围。

## 6. 其他取舍

- **records 正文截断 4000 字符**（`TEXT_SLICE`）：巨型 tool/result（98 实测最大 55,770 字符）
  不截断会撑爆 FTS 与向量库；截断只影响索引文本，`seq` 可定位原日志原文。
- **tool-call 只进 FTS 不向量化**：参数是结构化数据，无语义价值（规格 §3）。
- **不索引 spill 文件正文**：prune 后正文在 spill 文件里，记录"曾被裁剪"标记已够定位
  （规格 §3、§7）；真要搜再扩。
- **summary 照常索引**：压缩摘要是"发生过压缩"的事实，可检索（规格 §3）。
- **mtime 水线增量**：`index --all` 跳过 `mtime <= 上次索引时间` 的会话；
  会话实时追加时 mtime 必然更新，代价是追加后重扫整个文件（帧级幂等：INSERT OR REPLACE）。
- **HTTP API 只监听 127.0.0.1**：无鉴权 = 只允许本机访问（规格 §5.1）；
  未来 Router 接入时再议鉴权。
