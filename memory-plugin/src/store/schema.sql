-- 记忆插件建表语句（唯一权威，代码不得内联建表）
--
-- ===========================================================================
-- 编号单位（每个独立单元一个编号）
-- ===========================================================================
--   user 消息          → 一号（kind='user'）
--   assistant 思考块    → 一号（kind='thinking'）
--   一次工具调用+结果   → 合并一号（kind='tool'，正文内 <tool-call>/<tool-result> 标签）
--   assistant 正文      → 一号（kind='reply'）
--   system / developer → 不占编号、不索引
--
--   会话内完全线性：0,1,2… 连续无空洞、不复用、不跳号。
--   #0 = 该会话第一个 user prompt。
--   编号永不改变：总结后不变、老化后不变、仍可检索。
--
-- ===========================================================================
-- summary（总结的产物）
-- ===========================================================================
--   由**正在运行的模型**串行生成：
--     长单位产生后 → 程序紧接着注入 user 提炼指令 → 模型回复提炼结果
--     → 挂到该单位的 summary 列 → 撤掉指令与回复的发送视图（日志保留）
--
--   模型**从不写 <summary> 标签**（标签是程序组装发送文本时加的）。
--   长单位（≥4000 字符）必须有 summary；短单位可选（模型可回"无"）。
--   summary 为空 = 未总结。
--
-- ===========================================================================
-- 发送投影（两级展示，与压缩无关）
-- ===========================================================================
--   近程（窗口内）：#N <summary>…</summary><content>…</content>  全发
--   远程（窗口外）：#N <summary>…</summary>                      只发 summary
--                    未总结单位原样保留（内容短，地位与 summary 等同）
--   user 单位永不衰减，原样全发。

CREATE TABLE IF NOT EXISTS message (
  -- 数据库内部行号（仅供 FTS 当 rowid，不对外）
  row_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT    NOT NULL,
  -- 会话内线性编号：0 = 第一个 user prompt
  idx       INTEGER NOT NULL,
  -- 单位类型
  kind      TEXT    NOT NULL,
  -- 模型提炼结果；空串 = 未总结
  summary   TEXT    NOT NULL DEFAULT '',
  -- 完整原文，永不删
  content   TEXT    NOT NULL,
  -- 首次进入上下文的时刻
  at        TEXT    NOT NULL,
  -- 是否仍在 dsh 的上下文里
  in_context INTEGER NOT NULL DEFAULT 1,
  -- 便签：程序内部维护的展示标记（JSON 数组）
  tags      TEXT    NOT NULL DEFAULT '[]',
  UNIQUE (sessionId, idx)
);
CREATE INDEX IF NOT EXISTS idx_message_session ON message(sessionId, idx);
CREATE INDEX IF NOT EXISTS idx_message_inctx  ON message(sessionId, in_context);

-- 关键词索引：summary 与 content 都进（thinking 的 content 除外，见 insertMessage）
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  tokenize = 'unicode61'
);

-- 向量索引（本地实现）
CREATE TABLE IF NOT EXISTS message_vector (
  row_id INTEGER PRIMARY KEY REFERENCES message(row_id) ON DELETE CASCADE,
  dims   INTEGER NOT NULL,
  vec    TEXT    NOT NULL
);

-- 等待总结的状态（每会话最多一条）：记录当前待总结的单位编号
CREATE TABLE IF NOT EXISTS pending_summary (
  sessionId  TEXT PRIMARY KEY,
  unitIdx    INTEGER NOT NULL,
  promptText TEXT    NOT NULL,
  createdAt  TEXT    NOT NULL
);

-- 元信息
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
