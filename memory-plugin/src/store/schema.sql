-- 记忆插件建表语句（唯一权威，代码不得内联建表）
--
-- 完整设计见 docs/A7-memory-design-final.md（v5）
--
-- 核心结构：
--   message        编号单位（#N 线性，L0 永不删）
--   fold           折叠体（L2，按任务边界把一段单位收成一条）
--   todo           待办台账（挂起项，不是规划步骤）
--   override_log   覆写记录（改 L1 不改 L0）
--   plan           当前规划快照
--   plan_version   规划版本历史（强制命名，永不覆盖）

-- ---------------------------------------------------------------------------
-- 编号单位
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT    NOT NULL,
  -- 会话内线性编号：0 = 第一个 user prompt
  idx         INTEGER NOT NULL,
  -- user | thinking | tool | reply
  kind        TEXT    NOT NULL,
  -- L1：模型提炼结果；空串 = 未总结；可被覆写
  summary     TEXT    NOT NULL DEFAULT '',
  -- L0：完整原文，永不删、永不改
  content     TEXT    NOT NULL,
  at          TEXT    NOT NULL,
  in_context  INTEGER NOT NULL DEFAULT 1,
  -- 便签（程序内部维护）
  tags        TEXT    NOT NULL DEFAULT '[]',
  -- 若已折叠，指向折叠体编号
  folded_into INTEGER,
  UNIQUE (sessionId, idx)
);
CREATE INDEX IF NOT EXISTS idx_message_session ON message(sessionId, idx);
CREATE INDEX IF NOT EXISTS idx_message_folded  ON message(sessionId, folded_into);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS message_vector (
  row_id INTEGER PRIMARY KEY REFERENCES message(row_id) ON DELETE CASCADE,
  dims   INTEGER NOT NULL,
  vec    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 折叠体（L2）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fold (
  fold_no      INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId    TEXT    NOT NULL,
  -- 覆盖的单位编号区间（闭区间）
  from_idx     INTEGER NOT NULL,
  to_idx       INTEGER NOT NULL,
  -- 折叠摘要（模型从 L0 生成，不是从 L1 再摘要）
  fold_summary TEXT    NOT NULL,
  -- 折叠原因/触发：task-boundary | multi-task | budget | manual
  trigger      TEXT    NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fold_session ON fold(sessionId, from_idx);

-- ---------------------------------------------------------------------------
-- 待办台账（挂起项，与规划步骤不同）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todo (
  todo_no    INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId  TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  -- open | done | dropped
  status     TEXT    NOT NULL DEFAULT 'open',
  -- 来源单位编号（可回溯原文）
  from_idx   INTEGER,
  -- 放弃原因
  drop_reason TEXT   NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_session ON todo(sessionId, status);

-- ---------------------------------------------------------------------------
-- 覆写记录（改 L1，L0 不动）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS override_log (
  override_no INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT    NOT NULL,
  target_idx  INTEGER NOT NULL,
  old_summary TEXT    NOT NULL,
  new_summary TEXT    NOT NULL,
  reason      TEXT    NOT NULL,
  -- 1 = 用户推翻自己；0 = 用户承认模型对
  by_user     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_override_session ON override_log(sessionId, target_idx);

-- ---------------------------------------------------------------------------
-- 规划：当前快照（每会话一行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan (
  sessionId    TEXT PRIMARY KEY,
  version      INTEGER NOT NULL,
  -- 版本名（强制必填，1-60 字符）
  name         TEXT    NOT NULL,
  goal         TEXT    NOT NULL,
  -- 模型自估完成时间（分钟）
  estimate_min INTEGER,
  -- JSON：步骤数组
  steps        TEXT    NOT NULL,
  -- JSON：架构决策数组
  decisions    TEXT    NOT NULL DEFAULT '[]',
  -- active | done | abandoned
  status       TEXT    NOT NULL DEFAULT 'active',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 规划版本历史（每次变更加一行，永不覆盖）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_version (
  plan_no     INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  -- 该版完整 JSON（goal + steps + decisions）
  snapshot    TEXT    NOT NULL,
  -- init | extend | revise | rebuild | revert | step-update
  change_kind TEXT    NOT NULL,
  reason      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  UNIQUE (sessionId, version)
);
CREATE INDEX IF NOT EXISTS idx_planver_session ON plan_version(sessionId, version);

-- ---------------------------------------------------------------------------
-- 待总结状态（每会话最多一条）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_summary (
  sessionId  TEXT PRIMARY KEY,
  unitIdx    INTEGER NOT NULL,
  promptText TEXT    NOT NULL,
  createdAt  TEXT    NOT NULL
);

-- 提炼回复指纹（一次性产物，不入库）
CREATE TABLE IF NOT EXISTS summary_reply_fp (
  sessionId TEXT NOT NULL,
  fp        TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reply_fp ON summary_reply_fp(sessionId, fp);

-- 元信息
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
