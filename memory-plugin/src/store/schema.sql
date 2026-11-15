-- 记忆插件建表语句（唯一权威，代码不得内联建表）
--
-- ===========================================================================
-- 索引模型
-- ===========================================================================
--
--   索引是**给模型看的 token**，形如 `#0` `#1` `#2`，直接标在消息里。
--   模型读到上下文时就能看到每条消息的编号，想查某条就说得出编号。
--
--   **一个会话内索引完全线性递增**：0, 1, 2, 3 … 不间断、不重复、不跳号。
--   不再按 (sessionId, seq, kind) 三元组区分——
--   一条消息就是一个槽位，一个槽位只有一个编号。
--
--   idx = 0 → 该会话最开始的那个 user prompt
--   idx = N → 第 N+1 条进入上下文的消息
--
--   编号一旦分配就固定：
--     - 后续轮次在同一位置看到同一条消息 → 复用原编号
--     - 被压缩遮蔽后从上下文消失 → 编号保留，仍可检索
--
-- ===========================================================================
-- 便签（tag）
-- ===========================================================================
--   便签是**程序内部维护**的展示标记（「已提炼」「已滑出窗口」等），
--   随检索结果展示给模型看，模型不能按便签检索、也不能改便签。

-- ---------------------------------------------------------------------------
-- 消息：每会话线性编号，从 0 开始
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message (
  -- 数据库内部行号（仅供 FTS 当 rowid 用，不对外）
  row_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT    NOT NULL,
  -- 会话内索引：0 = 第一个 user prompt；线性递增，无空洞
  idx       INTEGER NOT NULL,
  -- 角色：user / assistant / tool / system（普通列，不参与编号）
  role      TEXT    NOT NULL,
  -- 完整正文（检索命中时原样返回）
  text      TEXT    NOT NULL,
  -- 首次进入上下文的时刻
  at        TEXT    NOT NULL,
  -- 是否仍在上下文里（0 = 已被压缩遮蔽，但仍可检索）
  in_context INTEGER NOT NULL DEFAULT 1,
  -- 便签：程序内部维护的展示标记（JSON 数组）
  tags      TEXT    NOT NULL DEFAULT '[]',
  UNIQUE (sessionId, idx)
);
CREATE INDEX IF NOT EXISTS idx_message_session ON message(sessionId, idx);
CREATE INDEX IF NOT EXISTS idx_message_inctx  ON message(sessionId, in_context);

-- ---------------------------------------------------------------------------
-- 关键词索引：思考内容同样进这张表（不区分类型）
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  tokenize = 'unicode61'
);

-- ---------------------------------------------------------------------------
-- 向量索引（本地实现，存 JSON 数组）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_vector (
  row_id INTEGER PRIMARY KEY REFERENCES message(row_id) ON DELETE CASCADE,
  dims   INTEGER NOT NULL,
  vec    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 提炼段：「近几步全量 + 总结」的总结
-- 覆盖的是一段本会话内的 idx 区间
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS segment (
  segment_no INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId  TEXT    NOT NULL,
  from_idx   INTEGER NOT NULL,
  to_idx     INTEGER NOT NULL,
  summary    TEXT    NOT NULL,
  recent     TEXT    NOT NULL DEFAULT '',
  stage      TEXT    NOT NULL DEFAULT 'live',
  at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segment_session ON segment(sessionId, from_idx);

-- ---------------------------------------------------------------------------
-- 等待提炼的状态（每个会话最多一条）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_inject (
  sessionId  TEXT PRIMARY KEY,
  from_idx   INTEGER NOT NULL,
  to_idx     INTEGER NOT NULL,
  promptText TEXT    NOT NULL,
  createdAt  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 元信息
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
