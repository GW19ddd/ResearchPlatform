"""测试基线：每个用例都用独立临时库，且不触网。

- DB 指向 tmp_path，跑完不留痕
- 把所有 LLM provider 置为 disabled，任何调用都走「无可用 provider」分支，
  保证测试不依赖网络与 API Key
"""
import pathlib
import sys

import pytest

SERVER = pathlib.Path(__file__).resolve().parents[1]
TESTS = pathlib.Path(__file__).resolve().parent
for _p in (SERVER, TESTS):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import config  # noqa: E402
import db  # noqa: E402
import llm_config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402


@pytest.fixture(scope="session")
def tmp_db(tmp_path_factory):
    """整场测试共用一个临时 SQLite，避免反复建表拖慢速度。"""
    p = tmp_path_factory.mktemp("wbdata") / "test.db"
    db.DB_PATH = str(p)
    config.DB_PATH = p
    config.DATA_DIR = p.parent
    config.EXPORT_DIR = p.parent / "export"
    config.EXPORT_DIR.mkdir(exist_ok=True)
    db.init_db()
    return p


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """禁用全部 provider：LLM 调用一律走降级分支，绝不发真实请求。"""
    cfg = llm_config.load_config()
    for p in cfg.get("providers", []):
        p["enabled"] = False
    cfg["default_provider"] = ""
    llm_config.save_config(cfg)

    async def _boom(*a, **kw):
        raise AssertionError("测试期间不应发起真实 HTTP 请求")

    monkeypatch.setattr("httpx.AsyncClient.post", _boom)
    monkeypatch.setattr("httpx.AsyncClient.get", _boom)


@pytest.fixture()
def client(tmp_db):
    with TestClient(main.app) as c:
        yield c


@pytest.fixture(autouse=True)
def _clean_tables(tmp_db):
    """每个用例前清空业务表，用例之间互不污染（保留种子阶段/章节/奖励）。"""
    for t in (
        "ideas",
        "idea_reviews",
        "literature",
        "lit_notes",
        "lit_matrix",
        "experiments",
        "exp_results",
        "weekly_plans",
        "tasks",
        "daily_checkins",
        "advisor_notes",
        "points_ledger",
        "bets",
        "canvas_node_outputs",
        "canvas_runs",
        "canvas_nodes",
        "canvas_edges",
        "canvases",
        "chat_messages",
        "chat_sessions",
        "idempotency_keys",
    ):
        db.execute(f"DELETE FROM {t}")
    # 积分规则与 Dify 配置存在 settings 表里，不清理会跨用例污染
    db.execute("DELETE FROM settings WHERE key LIKE 'rule:%'")
    db.execute("DELETE FROM settings WHERE key='dify_config'")
    db.execute("DELETE FROM settings WHERE key='canvas_user_templates'")
    yield
