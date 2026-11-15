-- 记忆插件建表语句（唯一权威，代码不得内联建表）
--
-- 核心约定：**每一个事件都有自己的编号，且编号在每个会话内独立递增。**
--   * 每个会话各自一套编号，从 1 开始，互不相干。
--     会话 A 的 #1 和会话 B 的 #1 是两个不同的事件。
--   * 唯一定位一个事件需要 (sessionId, event_no) 这一对。
--   * 消息、工具调用、工具结果、思考、压缩摘要——每条都占一个 event_no。
--
-- dsh 自己的 `seq` 只保留为普通列：它是「该会话内该事件在 dsh 日志里的序号」。
-- 同一 seq 可能对应多个载体（assistant 消息含正文 + 思考两块）。
--
-- 为什么不能全库统一编号：不同会话是彼此独立的记录单元，
-- 混在一起编号会让「会话内的第 5 个事件」这种引用失去意义，
-- 也破坏按会话做增量索引与水位线的前提。

-- ---------------------------------------------------------------------------
-- 事件台账：event_no 按会话独立递增
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event (
  -- 数据库内部行号（仅供 FTS 作为 rowid 使用，不对外暴露、不参与语义）
  row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 会话内的编号：从 1 开始，每个会话独立递增
  event_no   INTEGER NOT NULL,
  sessionId  TEXT    NOT NULL,
  -- dsh 日志里的序号（普通列）
  seq        INTEGER NOT NULL,
  -- 载体类型
  kind       TEXT    NOT NULL,
  at         TEXT    NOT NULL,
  turn       INTEGER,
  shadowed   INTEGER NOT NULL DEFAULT 0,
  -- 会话内编号唯一
  UNIQUE (sessionId, event_no),
  -- 幂等：同一会话同一 seq 同一载体只允许一条
  UNIQUE (sessionId, seq, kind)
);
CREATE INDEX IF NOT EXISTS idx_event_session ON event(sessionId, event_no);
CREATE INDEX IF NOT EXISTS idx_event_seq     ON event(sessionId, seq);
CREATE INDEX IF NOT EXISTS idx_event_kind    ON event(kind);

-- ---------------------------------------------------------------------------
-- 正文：与 event 一对一（思考也有正文，只是不进 FTS）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_text (
  row_id   INTEGER PRIMARY KEY REFERENCES event(row_id) ON DELETE CASCADE,
  text     TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 关键词检索表
--
-- rowid 复用 event.row_id：插入时显式给 rowid，删除按 rowid 精确命中。
-- 因此不需要任何 rowid 映射表。
--
-- 注意：这里**不能**用 `content=''`（外部内容表模式）——那要求调用方自己维护
-- 索引与内容的同步，漏一次就搜不到。本表直接存原文（分词后），自包含。
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  text,
  tokenize = 'unicode61'
);

-- ---------------------------------------------------------------------------
-- 封存段：「近几步全量 + 总结，再前面的只有总结」里的总结
-- 覆盖的是一段**本会话内**的 event_no 区间
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seal (
  seal_no        INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId      TEXT    NOT NULL,
  from_event_no  INTEGER NOT NULL,
  to_event_no    INTEGER NOT NULL,
  shadowed_nos   TEXT    NOT NULL,
  summary        TEXT    NOT NULL,
  reason         TEXT    NOT NULL,
  turn           INTEGER NOT NULL,
  at             TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seal_session ON seal(sessionId, turn);

-- ---------------------------------------------------------------------------
-- 会话水位线：每个会话已索引到的事件序号与编号
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watermark (
  sessionId     TEXT PRIMARY KEY,
  lastSeq       INTEGER NOT NULL,
  last_event_no INTEGER NOT NULL,
  indexedAt     TEXT    NOT NULL,
  eventCount    INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 元信息
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
