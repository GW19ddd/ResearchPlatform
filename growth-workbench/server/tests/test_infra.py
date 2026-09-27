"""基础设施：路由可达性、静态托管安全、看板、活跃度、设置。"""
import pathlib

import pytest

from db import query


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_unknown_api_returns_json_404(client):
    r = client.get("/api/definitely-not-exist")
    assert r.status_code == 404
    assert r.headers.get("content-type", "").startswith("application/json")


@pytest.mark.parametrize(
    "path",
    [
        "/../../../../Windows/win.ini",
        "/..%2f..%2f..%2fWindows/win.ini",
        "/assets/../../server/config.py",
    ],
)
def test_static_route_must_not_escape_dist(client, path):
    """catch-all 静态路由不能把 web/dist 之外的文件吐出来。"""
    r = client.get(path)
    if r.status_code == 200:
        body = r.text
        assert "DB_PATH" not in body and "[fonts]" not in body, f"目录穿越泄漏了文件：{path}"


def test_dashboard_shape(client):
    d = client.get("/api/dashboard").json()
    for k in ("points", "paper", "ideas", "literature", "experiments", "checkin_today", "commitments"):
        assert k in d, f"dashboard 缺字段 {k}"
    assert d["paper"]["progress"] <= 100


def test_export_markdown(client):
    client.post("/api/ideas", json={"title": "导出用想法"})
    r = client.get("/api/export/all")
    assert r.status_code == 200
    assert "# 科研工作台全量导出" in r.text
    assert "导出用想法" in r.text


def test_activity_heatmap(client):
    client.post("/api/ideas", json={"title": "活跃度"})
    h = client.get("/api/activity/heatmap", params={"days": 30}).json()
    assert h["days"], "热力图序列不应为空"
    assert h["days"][0]["date"] <= h["end"]
    assert h["total"] >= 1
    assert h["streak"] >= 1
    assert h["max"] >= 1


def test_activity_days_clamped(client):
    h0 = client.get("/api/activity/heatmap", params={"days": 1}).json()
    h1 = client.get("/api/activity/heatmap", params={"days": 99999}).json()
    assert len(h0["days"]) >= 28
    assert len(h1["days"]) <= 730 + 7


def test_settings_llm_roundtrip(client):
    cfg = client.get("/api/settings/llm").json()
    assert cfg["providers"], "应至少有默认 provider 列表"
    assert cfg["types"]

    r = client.post(
        "/api/settings/llm/providers",
        json={"name": "T", "type": "openai", "base_url": "http://127.0.0.1:9/v1",
              "model_fast": "m", "model_reason": "m", "enabled": False},
    )
    pid = r.json()["provider"]["id"]
    assert any(p["id"] == pid for p in client.get("/api/settings/llm").json()["providers"])
    client.delete(f"/api/settings/llm/providers/{pid}")
    assert not any(p["id"] == pid for p in client.get("/api/settings/llm").json()["providers"])


def test_settings_test_connection_never_500(client):
    r = client.post(
        "/api/settings/llm/test",
        json={"name": "不可达", "type": "openai", "base_url": "http://127.0.0.1:9/v1",
              "model_fast": "m", "model_reason": "m"},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_settings_models_never_500(client):
    r = client.post(
        "/api/settings/llm/models",
        json={"name": "不可达", "type": "openai", "base_url": "http://127.0.0.1:9/v1"},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_dify_settings(client):
    r = client.get("/api/settings/dify")
    assert r.status_code == 200
    aid = client.post(
        "/api/settings/dify/apps", json={"name": "a", "api_key": "app-x", "mode": "workflow"}
    ).json()["app"]["id"]
    masked = client.get("/api/settings/dify").json()
    app = next(a for a in masked["apps"] if a["id"] == aid)
    assert "app-x" not in str(app), f"接口回传了明文 API Key：{app}"
    assert app.get("api_key_masked")

    r = client.put(
        "/api/settings/dify",
        json={"enabled": True, "base_url": "http://127.0.0.1:9/v1",
              "apps": [{"id": aid, "name": "a", "api_key": "", "mode": "workflow"}]},
    )
    assert r.status_code == 200, r.text
    # 前端回传空 key 时应保留原值，不能被清空
    from dify_config import get_app

    assert (get_app(aid) or {}).get("api_key") == "app-x", "空 key 覆盖丢失了原值"


def test_zotero_config_roundtrip(client):
    assert client.get("/api/zotero/config").status_code == 200
    r = client.put("/api/zotero/config", json={"source": "web", "user_id": "123", "limit": 50})
    assert r.status_code == 200
    assert client.get("/api/zotero/config").json()["user_id"] == "123"


def test_zotero_import_empty_rejected(client):
    assert client.post("/api/zotero/import", json={"text": "   "}).status_code == 400


def test_zotero_import_bibtex(client):
    bib = """@inproceedings{foo2024,
      title = {A Title For Testing},
      author = {Alice Smith and Bob Lee},
      booktitle = {FSE},
      year = {2024},
      doi = {10.1000/xyz123}
    }"""
    r = client.post("/api/zotero/import", json={"text": bib})
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1
    rows = query("SELECT title, year, venue, doi FROM literature")
    assert rows[0]["year"] == 2024
    assert rows[0]["venue"] == "FSE"
    assert rows[0]["doi"] == "10.1000/xyz123"


def test_zotero_import_dedupe(client):
    bib = """@article{dup, title = {Same Title}, author = {A}, year = {2024}}"""
    client.post("/api/zotero/import", json={"text": bib})
    r = client.post("/api/zotero/import", json={"text": bib})
    assert r.json()["imported"] == 0
    assert len(query("SELECT * FROM literature")) == 1


def test_zotero_collection_name_with_slash_not_split(client):
    """集合名含裸斜杠（C/C++）时不能被切成两层。"""
    from routers.zotero import _build_tree

    tree = _build_tree(["Lang / C/C++", "Lang", "Lang / Python"])
    names = [n["name"] for n in tree]
    assert "Lang" in names
    lang = next(n for n in tree if n["name"] == "Lang")
    kids = sorted(c["name"] for c in lang["children"])
    assert kids == ["C/C++", "Python"], f"C/C++ 被错误拆分：{kids}"
