"""全局配置：路径、数据库、LLM provider。"""
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
EXPORT_DIR = ROOT / "export"
DATA_DIR.mkdir(exist_ok=True)
EXPORT_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "workbench.db"

# ---- LLM ----
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
DEEPSEEK_FAST_MODEL = os.getenv("DEEPSEEK_FAST_MODEL", "deepseek-chat")
DEEPSEEK_REASON_MODEL = os.getenv("DEEPSEEK_REASON_MODEL", "deepseek-reasoner")

LOCAL_QWEN_BASE_URL = os.getenv(
    "LOCAL_QWEN_BASE_URL", "http://gw-computer.tailcb2155.ts.net/v1"
)
LOCAL_QWEN_MODEL = os.getenv("LOCAL_QWEN_MODEL", "qwen3.6-35b")

# deepseek | local-qwen
DEFAULT_PROVIDER = os.getenv("LLM_PROVIDER", "deepseek")

# ---- 其他 provider 的环境变量（仅作为设置页的初始种子，之后以数据库为准）----
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_FAST_MODEL = os.getenv("OPENAI_FAST_MODEL", "gpt-4o-mini")
OPENAI_REASON_MODEL = os.getenv("OPENAI_REASON_MODEL", "o3-mini")

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:14b")

# 设置页持久化用的 key
LLM_CONFIG_KEY = "llm_config"

# ---- Dify ----
DIFY_CONFIG_KEY = "dify_config"
DIFY_BASE_URL = os.getenv("DIFY_BASE_URL", "http://localhost/v1")
DIFY_API_KEY = os.getenv("DIFY_API_KEY", "")

# ---- 积分规则（默认值，运行时可从 /api/points/rules 覆盖保存到 settings 表）----
DEFAULT_RULES = {
    "weekly_outcome_done": 100,
    "task_done": 10,
    "daily_checkin": 5,
    "weekly_review": 30,
    "paper_stage_advance": 50,
    "idea_validated": 40,
    "paper_read_done": 20,
    "experiment_done": 60,
    "weekly_outcome_missed": -60,
    "bet_lost": -100,
    "no_checkin_3days": -30,
    "weekly_net_floor": -100,
}

# ---- 论文流水线默认阶段 ----
DEFAULT_PAPER_STAGES = [
    "选题与定位",
    "实验设计与跑批",
    "数据整理与图表",
    "正文写作",
    "内部修改",
    "投稿",
    "返修",
]

DEFAULT_PAPER_SECTIONS = [
    ("Introduction", 800),
    ("Related Work", 1200),
    ("Method", 1500),
    ("Experiments", 1500),
    ("Results", 1000),
    ("Discussion", 600),
    ("Conclusion", 400),
]

DEFAULT_REWARDS = [
    ("一杯奶茶", 200),
    ("游戏 1 小时", 300),
    ("看一场电影", 500),
    ("一次购物额度", 1000),
]
