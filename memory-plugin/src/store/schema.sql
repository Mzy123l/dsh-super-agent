-- 记忆插件建表语句（唯一权威，代码不得内联建表）
-- 决策①：reasoning 不进 FTS，只存 reasoning 表供向量化
-- 决策②：自建存储，数据从会话日志复制到插件自己的数据目录
-- 决策③：records 表存全量事件（含被压缩遮蔽的），带 shadowed 标记

-- 全量记录（含 shadowed 标记；决策③）
CREATE TABLE IF NOT EXISTS records (
  sessionId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  turn INTEGER,
  text TEXT NOT NULL,
  shadowed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sessionId, seq, kind)
);
CREATE INDEX IF NOT EXISTS idx_records_session ON records(sessionId, seq);
CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind);

-- reasoning 单独存（决策①：只向量化，不进 FTS）
CREATE TABLE IF NOT EXISTS reasoning (
  sessionId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  turn INTEGER,
  text TEXT NOT NULL,
  PRIMARY KEY (sessionId, seq)
);

-- 关键词索引：不含 reasoning（决策①）
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  text, sessionId UNINDEXED, seq UNINDEXED, kind UNINDEXED, at UNINDEXED
);

-- FTS rowid 映射（(sessionId, seq, kind) → records_fts 的 rowid）。
-- 没有它，替换一条记录时只能按 UNINDEXED 列 DELETE——那是对 FTS 全表扫描，
-- 8 万+ 记录时是 O(n²)（实测卡死）。按 rowid 删除是精确命中。
CREATE TABLE IF NOT EXISTS fts_map (
  sessionId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ftsRowid INTEGER NOT NULL,
  PRIMARY KEY (sessionId, seq, kind)
);

-- 会话级索引水位线（增量索引用：记录每个会话已索引到的 seq）
CREATE TABLE IF NOT EXISTS watermarks (
  sessionId TEXT PRIMARY KEY,
  lastSeq INTEGER NOT NULL,
  indexedAt TEXT NOT NULL,
  eventCount INTEGER NOT NULL
);

-- 索引元信息（status 用）
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
