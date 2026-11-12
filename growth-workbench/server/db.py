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

CREATE TABLE IF NOT EXISTS lit_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  edge_type TEXT NOT NULL DEFAULT 'cites',
  created_at TEXT,
  UNIQUE(source_id, target_id, edge_type)
);

CREATE TABLE IF NOT EXISTS lit_painpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  literature_id INTEGER,
  content TEXT NOT NULL,
  evidence TEXT,
  direction TEXT,
  status TEXT DEFAULT 'new',
  created_at TEXT
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
  provenance TEXT DEFAULT 'measured',
  created_at TEXT
);

-- 运行溯源（借鉴 Open Science record_run）：一次运行一条记录，
-- 代码/输出文件逐个 sha1 钉码，环境以内容寻址 hash 钉死。
CREATE TABLE IF NOT EXISTS exp_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER,
  run_id TEXT,
  command TEXT,
  surface TEXT DEFAULT 'local',
  status TEXT DEFAULT 'ok',
  host TEXT,
  job_id TEXT,
  wall_ms INTEGER,
  notes TEXT,
  env_text TEXT,
  env_hash TEXT,
  code_json TEXT,
  output_json TEXT,
  created_at TEXT
);

-- 实验 Agent 对话（借鉴 Open Science 会话形态）：user/assistant 轮次，
-- assistant 轮的 meta_json 带本轮产物文件、执行的 run 与自动落账的结果。
CREATE TABLE IF NOT EXISTS exp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER,
  role TEXT,
  content TEXT,
  meta_json TEXT,
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

-- 研究对话（Undermind 式）：独立于 /api/chat 的会话与消息。
-- kind: text 普通回复 / deep 深度检索 / report 报告；meta 存 JSON（引用、检索式、建议）。
CREATE TABLE IF NOT EXISTS rchat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT DEFAULT '新对话',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS rchat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  role TEXT,
  kind TEXT DEFAULT 'text',
  content TEXT,
  meta TEXT,
  provider TEXT,
  model TEXT,
  elapsed_ms INTEGER DEFAULT 0,
  created_at TEXT
);

-- quest 发现沉淀（Findings Memory）：每轮对话的 system prompt 会自动带上这些结论
CREATE TABLE IF NOT EXISTS chat_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  content TEXT,
  source_msg_id INTEGER,
  created_at TEXT
);

-- 本地账户：单用户登录，密码用 PBKDF2-SHA256 加盐存储，不存明文
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  avatar_hue INTEGER DEFAULT 240,
  created_at TEXT,
  last_login_at TEXT,
  -- 会员：free / pro。老库通过 MIGRATIONS 补列，默认值 free，不影响已有数据。
  plan TEXT DEFAULT 'free',
  plan_expires_at TEXT,
  plan_provider TEXT,
  plan_order_id TEXT
);

-- 会话：登录后发一个随机 token 写进 HttpOnly Cookie，服务端只存哈希
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT,
  expires_at TEXT
);

-- 会员订单：下单 → 支付 → 升级。provider=manual 为本地演示支付（无需密钥即可跑通链路），
-- stripe / wechat / alipay 为真实支付网关的占位，接好密钥与 webhook 即可上线。
CREATE TABLE IF NOT EXISTS billing_orders (
  order_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pro',
  cycle TEXT NOT NULL DEFAULT 'monthly',
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  provider TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'pending',
  pay_url TEXT,
  created_at TEXT,
  paid_at TEXT,
  expires_at TEXT
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

-- 科研社区：帖子 / 评论 / 点赞收藏。
-- 作者署名随帖冗余存一份：以后改了账户显示名，历史帖的署名仍保持发帖当时的样子。
CREATE TABLE IF NOT EXISTS community_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '方法讨论',
  kind TEXT DEFAULT 'discussion',
  tags TEXT,
  cover_style TEXT DEFAULT 'paper',
  cover_url TEXT,
  author_id INTEGER DEFAULT 0,
  author_name TEXT,
  author_hue INTEGER DEFAULT 240,
  is_sample INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  favorites INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS community_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  parent_id INTEGER,
  author_id INTEGER DEFAULT 0,
  author_name TEXT,
  author_hue INTEGER DEFAULT 240,
  content TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS community_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT,
  UNIQUE(post_id, user_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_community_posts_category ON community_posts(category);
CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id);
CREATE INDEX IF NOT EXISTS idx_community_reactions_post ON community_reactions(post_id);

-- 论文速递（对标 paperdance）：arXiv 拉取 + 邮件投喂的短视频式论文卡片流。
-- arxiv_id 唯一：同一篇论文不管从哪条渠道来都只落一次库。
CREATE TABLE IF NOT EXISTS paperfeed_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arxiv_id TEXT UNIQUE,
  title TEXT NOT NULL,
  authors TEXT,
  abstract TEXT,
  cats TEXT,
  primary_cat TEXT,
  figure_url TEXT,
  link TEXT,
  published TEXT,
  source TEXT DEFAULT 'arxiv',
  liked INTEGER DEFAULT 0,
  saved INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  title_zh TEXT,
  abstract_zh TEXT,
  figure_kind TEXT DEFAULT 'arxiv',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS paperfeed_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_paperfeed_notes_paper ON paperfeed_notes(paper_id);

-- 通用工作区运行记录：论文编译 / 绘图 / 分析 / 代码共用一张表，
-- 底部「全局任务带」只读聚合这张表 + canvas_runs + exp_runs，不改既有表结构。
CREATE TABLE IF NOT EXISTS workspace_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  kind TEXT NOT NULL DEFAULT 'tex',
  owner_id TEXT NOT NULL DEFAULT 'default',
  label TEXT,
  command TEXT,
  status TEXT DEFAULT 'running',
  exit_code INTEGER,
  wall_ms INTEGER DEFAULT 0,
  stdout_tail TEXT,
  outputs_json TEXT,
  error TEXT,
  created_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspace_runs_created ON workspace_runs(created_at);
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
    # 社区示例帖：只在表为空时写一次，用户删干净后不会在下次启动又冒出来
    try:
        from routers.community import seed_community

        seed_community(conn)
    except Exception as exc:  # noqa: BLE001 —— 示例内容写不进去不能阻断启动
        print(f"[seed] 社区示例帖跳过：{type(exc).__name__}: {exc}")


# 老库升级：补上后加的列，不动已有数据。只做加法（ADD COLUMN），
# 任何一步都不会删表、不会改已有列的类型。
MIGRATIONS = [
    ("ideas", "category", "TEXT"),
    ("users", "plan", "TEXT DEFAULT 'free'"),
    ("users", "plan_expires_at", "TEXT"),
    ("users", "plan_provider", "TEXT"),
    ("users", "plan_order_id", "TEXT"),
    # 云端账户关联：WorkBuddy 云服务登录（短信/邮箱/微信）映射到本机用户
    ("users", "cloud_uid", "TEXT"),
    ("users", "cloud_email", "TEXT"),
    ("users", "cloud_phone", "TEXT"),
    ("literature", "collections", "TEXT"),
    ("literature", "doi", "TEXT"),
    ("literature", "source_key", "TEXT"),
    ("literature", "pdf_path", "TEXT"),
    ("literature", "gloss_id", "TEXT"),
    ("literature", "openalex_id", "TEXT"),
    ("literature", "abstract", "TEXT"),
    ("literature", "cited_by_count", "INTEGER"),
    ("literature", "ref_count", "INTEGER"),
    ("canvas_node_outputs", "status", "TEXT"),
    ("canvas_node_outputs", "error_json", "TEXT"),
    ("chat_sessions", "stage", "TEXT DEFAULT 'survey'"),
    ("exp_results", "provenance", "TEXT DEFAULT 'measured'"),
    ("paperfeed_papers", "title_zh", "TEXT"),
    ("paperfeed_papers", "abstract_zh", "TEXT"),
    ("paperfeed_papers", "figure_kind", "TEXT DEFAULT 'arxiv'"),
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
