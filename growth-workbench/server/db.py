"""SQLite 数据层：建表 + 种子数据 + 通用查询助手。"""
import sqlite3
from datetime import datetime
from pathlib import Path

from config import (
    DB_PATH,
    DEFAULT_PAPER_SECTIONS,
    DEFAULT_PAPER_STAGES,
    DEFAULT_REWARDS,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  one_liner TEXT,
  direction TEXT,
  novelty INTEGER DEFAULT 3,
  feasibility INTEGER DEFAULT 3,
  impact INTEGER DEFAULT 3,
  effort INTEGER DEFAULT 3,
  status TEXT DEFAULT 'captured',
  category TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS idea_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER,
  role TEXT,
  content TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS literature (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  authors TEXT,
  year INTEGER,
  venue TEXT,
  url TEXT,
  status TEXT DEFAULT 'todo',
  rating INTEGER DEFAULT 3,
  relevance TEXT,
  notes TEXT,
  tags TEXT,
  idea_id INTEGER,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS lit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  literature_id INTEGER,
  section TEXT,
  content TEXT,
  sort_order INTEGER DEFAULT 0,
  source TEXT DEFAULT 'ai',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS lit_matrix (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  literature_id INTEGER,
  dim_name TEXT,
  dim_value TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  hypothesis TEXT,
  design TEXT,
  status TEXT DEFAULT 'planned',
  idea_id INTEGER,
  config_json TEXT,
  conclusion TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS exp_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER,
  case_name TEXT,
  method TEXT,
  success INTEGER DEFAULT 0,
  metrics_json TEXT,
  notes TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'todo',
  blocker TEXT,
  next_action TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  target_words INTEGER DEFAULT 0,
  status TEXT DEFAULT 'todo',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS weekly_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT,
  outcomes_json TEXT,
  status TEXT DEFAULT 'active',
  review_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER,
  title TEXT,
  status TEXT DEFAULT 'todo',
  points INTEGER DEFAULT 10,
  due_date TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE,
  sleep_h REAL,
  exercise_min INTEGER,
  focus_min INTEGER,
  mood INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS advisor_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,
  scene TEXT,
  advisor_said TEXT,
  my_commitment TEXT,
  due_date TEXT,
  status TEXT DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS points_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delta INTEGER,
  reason TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  cost INTEGER,
  redeemed_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  task TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  amount INTEGER DEFAULT 100,
  due_date TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS canvases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS canvas_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canvas_id INTEGER,
  node_key TEXT,
  type TEXT DEFAULT 'skill',
  skill_id TEXT,
  title TEXT,
  x REAL DEFAULT 0,
  y REAL DEFAULT 0,
  config_json TEXT,
  UNIQUE(canvas_id, node_key)
);

CREATE TABLE IF NOT EXISTS canvas_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canvas_id INTEGER,
  source_key TEXT,
  target_key TEXT
);

CREATE TABLE IF NOT EXISTS canvas_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canvas_id INTEGER,
  scope TEXT,
  status TEXT DEFAULT 'running',
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS canvas_node_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  node_key TEXT,
  input_text TEXT,
  output_text TEXT,
  provider TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  elapsed_ms INTEGER DEFAULT 0,
  status TEXT DEFAULT 'done',
  error_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  role TEXT DEFAULT 'assistant',
  mode TEXT DEFAULT 'fast',
  context TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  role TEXT,
  content TEXT,
  provider TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_at TEXT
);

-- 幂等写：同一个 Idempotency-Key 重复提交只产生一次业务写入
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  endpoint TEXT,
  status_code INTEGER,
  content_type TEXT,
  response TEXT,
  created_at TEXT
);
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def query(sql: str, args=()):
    conn = get_conn()
    try:
        cur = conn.execute(sql, args)
        rows = [dict(r) for r in cur.fetchall()]
        return rows
    finally:
        conn.close()


def execute(sql: str, args=()):
    """执行写操作，返回 lastrowid。"""
    conn = get_conn()
    try:
        cur = conn.execute(sql, args)
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def executescript(sql: str):
    conn = get_conn()
    try:
        conn.executescript(sql)
        conn.commit()
    finally:
        conn.close()


def seed(conn: sqlite3.Connection):
    ts = now()
    n = conn.execute("SELECT COUNT(*) c FROM paper_stages").fetchone()["c"]
    if n == 0:
        conn.executemany(
            "INSERT INTO paper_stages (name, sort_order, status, updated_at) VALUES (?,?,?,?)",
            [(name, i, "todo" if i else "doing", ts) for i, name in enumerate(DEFAULT_PAPER_STAGES)],
        )
    n = conn.execute("SELECT COUNT(*) c FROM paper_sections").fetchone()["c"]
    if n == 0:
        conn.executemany(
            "INSERT INTO paper_sections (name, sort_order, target_words, status, updated_at) VALUES (?,?,?,?,?)",
            [(name, i, target, "todo", ts) for i, (name, target) in enumerate(DEFAULT_PAPER_SECTIONS)],
        )
    n = conn.execute("SELECT COUNT(*) c FROM rewards").fetchone()["c"]
    if n == 0:
        conn.executemany(
            "INSERT INTO rewards (name, cost) VALUES (?,?)", DEFAULT_REWARDS
        )


# 老库升级：补上后加的列，不动已有数据。只做加法（ADD COLUMN），
# 任何一步都不会删表、不会改已有列的类型。
MIGRATIONS = [
    ("ideas", "category", "TEXT"),
    ("literature", "collections", "TEXT"),
    ("literature", "doi", "TEXT"),
    ("literature", "source_key", "TEXT"),
    ("literature", "pdf_path", "TEXT"),
    ("literature", "gloss_id", "TEXT"),
    ("canvas_node_outputs", "status", "TEXT"),
    ("canvas_node_outputs", "error_json", "TEXT"),
]


def pending_migrations(conn: sqlite3.Connection) -> list[tuple[str, str, str]]:
    """返回还没应用的迁移项。迁移前用它判断「要不要先备份」。"""
    todo: list[tuple[str, str, str]] = []
    for table, col, decl in MIGRATIONS:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if cols and col not in cols:
            todo.append((table, col, decl))
    return todo


def _apply_migrations(conn: sqlite3.Connection) -> list[str]:
    applied = []
    for table, col, decl in pending_migrations(conn):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        applied.append(f"{table}.{col}")
    return applied


def init_db():
    """建表 + 兼容迁移 + 种子数据。

    迁移前若发现有列要补，先把数据库整份备份到 data/backups，
    万一迁移不符合预期还能原样退回。
    """
    # 测试里 DB_PATH 会被换成 str，统一包一层 Path 再判断
    first_time = not Path(DB_PATH).exists()
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        pending = pending_migrations(conn)
        if pending and not first_time:
            try:
                from backup import create_backup

                snap = create_backup("pre-migrate")
                print(f"[init_db] 迁移项 {len(pending)} 个，已先备份到 {snap['name']}")
            except Exception as exc:  # noqa: BLE001 —— 备份失败不该阻断启动，但要留痕
                print(f"[init_db] 迁移前备份失败：{type(exc).__name__}: {exc}")
        applied = _apply_migrations(conn)
        if applied:
            print(f"[init_db] 已补充列：{', '.join(applied)}")
        seed(conn)
        conn.commit()
    finally:
        conn.close()
