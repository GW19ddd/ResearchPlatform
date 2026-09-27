"""P0 可靠性：AI 失败不污染数据、写操作幂等、复盘单状态、备份可恢复。"""
import asyncio
import json
import time

import pytest

import backup
import llm
from db import query
from helpers import outputs_of, run_canvas


def call_llm(**kw) -> dict:
    """llm 层是 async 的，测试里同步跑一次即可。"""
    return asyncio.run(llm.complete_result(**kw))

SECRET = "sk-testsecret-123456"


@pytest.fixture()
def broken_provider():
    """配一个会失败的 provider：key 是真的（用来验证脱敏），端点不可达。"""
    import llm_config

    cfg = llm_config.load_config()
    cfg["providers"] = [
        {
            "id": "boom",
            "name": "必定失败",
            "type": "openai",
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": SECRET,
            "model_fast": "m",
            "model_reason": "m",
            "routing": "all",
            "enabled": True,
        }
    ]
    cfg["default_provider"] = "boom"
    llm_config.save_config(cfg)
    yield
    cfg["providers"] = []
    cfg["default_provider"] = ""
    llm_config.save_config(cfg)


# ---------------------------- A. AI 失败不落库 ----------------------------


def test_llm_failure_returns_envelope_not_text(broken_provider):
    env = call_llm(prompt="随便问点什么", task="pytest")
    assert env["ok"] is False
    assert env["content"] == "", "失败时正文必须为空，否则会被当成成果保存"
    assert env["error"]["kind"] in ("network", "timeout", "unknown")
    assert env["error"]["message"] and env["error"]["hint"]


def test_llm_error_detail_never_leaks_api_key(broken_provider, monkeypatch):
    """错误详情会写日志、会展示给用户：里面绝不能出现明文 key。"""
    import httpx

    class Boom(httpx.HTTPStatusError):
        def __init__(self):  # noqa: D107
            req = httpx.Request("POST", "http://x/v1")
            resp = httpx.Response(401, text=f"invalid api key: {SECRET}", request=req)
            super().__init__(f"Client error '401' for url: {SECRET}", request=req, response=resp)

    async def boom(*a, **kw):
        raise Boom()

    monkeypatch.setattr("httpx.AsyncClient.post", boom)
    env = call_llm(prompt="x", task="pytest")
    blob = json.dumps(env, ensure_ascii=False)
    assert SECRET not in blob, f"明文密钥出现在响应里：{blob}"
    assert "***" in blob, "脱敏后应留下标记"


def test_idea_review_failure_is_not_saved(broken_provider, client):
    iid = client.post("/api/ideas", json={"title": "待质疑的想法"}).json()["id"]
    r = client.post(f"/api/ideas/{iid}/review", json={"role": "reviewer"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False
    assert r.json()["result"] == "" and r.json()["saved"] is False
    assert query("SELECT * FROM idea_reviews WHERE idea_id=?", (iid,)) == [], \
        "LLM 错误文本被写进了质疑意见"


def test_literature_digest_failure_is_not_saved(broken_provider, client):
    lid = client.post("/api/literature", json={"title": "某篇论文"}).json()["id"]
    r = client.post(f"/api/literature/{lid}/digest", json={})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False
    assert query("SELECT * FROM lit_notes WHERE literature_id=?", (lid,)) == [], \
        "LLM 错误文本被写成了阅读笔记"


def test_experiment_analysis_failure_does_not_overwrite_conclusion(broken_provider, client):
    eid = client.post(
        "/api/experiments", json={"name": "实验E", "conclusion": "我手写的结论"}
    ).json()["id"]
    r = client.post(f"/api/experiments/{eid}/analysis")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False and r.json()["saved"] is False
    row = query("SELECT conclusion FROM experiments WHERE id=?", (eid,))[0]
    assert row["conclusion"] == "我手写的结论", "失败把用户已有的结论覆盖了"


def test_brainstorm_failure_returns_no_candidates(broken_provider, client):
    r = client.post("/api/ideas/brainstorm", json={"direction": "CFD 智能体"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False
    assert r.json()["candidates"] == []
    assert r.json()["result"] == ""
    assert query("SELECT * FROM ideas") == [], "失败竟然生成了创新点"


def test_canvas_failed_output_cannot_be_saved(client):
    """失败节点的输出不允许存进科研成果：接口要挡住，不是靠前端自觉。"""
    cid = client.post("/api/canvas", json={"name": "失败画布"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "失败画布",
            "nodes": [
                {"node_key": "s", "type": "skill", "skill_id": "no-such", "title": "X",
                 "x": 0, "y": 0, "config": {}},
                {"node_key": "d", "type": "output", "title": "输出", "x": 300, "y": 0,
                 "config": {}},
            ],
            "edges": [{"source_key": "s", "target_key": "d"}],
        },
    )
    run_canvas(client, cid)
    r = client.post(f"/api/canvas/{cid}/output/save", json={"node_key": "d", "target": "idea"})
    assert r.status_code == 409, f"失败输出被放行保存：{r.text}"
    assert query("SELECT * FROM ideas") == []


def test_canvas_run_is_async_and_cancelable(client):
    """运行要能给出真实状态，并且真的能取消。"""
    cid = client.post("/api/canvas", json={"name": "异步画布"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "异步画布",
            "nodes": [
                {"node_key": "a", "type": "input", "title": "输入", "x": 0, "y": 0,
                 "config": {"text": "文本"}},
                {"node_key": "b", "type": "skill", "skill_id": "no-such", "title": "坏节点",
                 "x": 300, "y": 0, "config": {}},
            ],
            "edges": [{"source_key": "a", "target_key": "b"}],
        },
    )
    r = client.post(f"/api/canvas/{cid}/run", json={})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "queued"
    run_id = r.json()["run_id"]

    detail = run_canvas(client, cid)
    assert detail["run"]["status"] == "failed"
    outs = outputs_of(detail)
    assert outs["a"]["ok"] is True and outs["b"]["ok"] is False

    # 已结束的运行不能再被取消
    r = client.post(f"/api/canvas/runs/{run_id}/cancel")
    assert r.json()["ok"] is False


def test_canvas_cancel_stops_pending_nodes(client, monkeypatch):
    """取消后剩下的节点不应该继续跑：6 个慢节点，取消后不该跑满 6 个。"""
    ran = {"n": 0}

    async def slow(prompt, **kw):
        await asyncio.sleep(0.05)
        ran["n"] += 1
        return {"ok": True, "content": f"结果{ran['n']}", "provider": "p", "model": "m",
                "tokens_in": 0, "tokens_out": 0, "error": None}

    monkeypatch.setattr("llm.complete_result", slow)
    cid = client.post("/api/canvas", json={"name": "取消画布"}).json()["id"]
    nodes = [
        {"node_key": f"n{i}", "type": "prompt", "title": f"节点{i}", "x": i * 220, "y": 0,
         "config": {"prompt": f"处理第 {i} 步：{{{{upstream}}}}"}}
        for i in range(6)
    ]
    client.post(f"/api/canvas/{cid}/save", json={"name": "取消画布", "nodes": nodes, "edges": []})
    r = client.post(f"/api/canvas/{cid}/run", json={})
    run_id = r.json()["run_id"]
    assert client.post(f"/api/canvas/runs/{run_id}/cancel").json()["ok"] is True

    detail = client.get(f"/api/canvas/runs/{run_id}").json()
    deadline = time.time() + 5
    while detail["run"]["status"] not in ("done", "failed", "cancelled") and time.time() < deadline:
        time.sleep(0.05)
        detail = client.get(f"/api/canvas/runs/{run_id}").json()
    assert detail["run"]["status"] == "cancelled", detail["run"]
    assert ran["n"] < 6, f"取消后仍跑满了全部节点：{ran['n']}"


# ---------------------------- B. 幂等 ----------------------------


def test_duplicate_create_with_same_key_writes_once(client):
    key = "idem-create-1"
    a = client.post("/api/ideas", json={"title": "幂等想法"}, headers={"Idempotency-Key": key})
    b = client.post("/api/ideas", json={"title": "幂等想法"}, headers={"Idempotency-Key": key})
    assert a.status_code == 200 and b.status_code == 200
    assert a.json()["id"] == b.json()["id"], "重复提交返回了不同的记录"
    assert len(query("SELECT * FROM ideas")) == 1, f"重复提交写入了多条：{query('SELECT * FROM ideas')}"


def test_same_title_without_key_still_creates_twice(client):
    """用户有意创建同名记录时不能被当成重复拦截。"""
    client.post("/api/ideas", json={"title": "同名"})
    client.post("/api/ideas", json={"title": "同名"})
    assert len(query("SELECT * FROM ideas")) == 2


def test_review_state_conflict_rejected(client):
    client.post("/api/plan/week", json={"outcomes": ["成果A", "成果B"]})
    r = client.post("/api/plan/review", json={"done": ["成果A"], "missed": ["成果A"]})
    assert r.status_code == 400, f"同一成果同时标完成/未完成被放行：{r.text}"
    assert "不能同时" in r.json()["detail"]


def test_review_accepts_single_state_and_reports_it(client):
    client.post("/api/plan/week", json={"outcomes": ["成果A", "成果B"]})
    r = client.post("/api/plan/review", json={"done": ["成果A"], "missed": ["成果B"]})
    assert r.status_code == 200, r.text
    saved = json.loads(query("SELECT review_json FROM weekly_plans")[0]["review_json"] or "null")
    assert saved["done"] == ["成果A"] and saved["missed"] == ["成果B"]
    assert r.json()["review"]["done"] == ["成果A"]


def test_review_dedupes_repeated_items(client):
    client.post("/api/plan/week", json={"outcomes": ["成果A"]})
    r = client.post("/api/plan/review", json={"done": ["成果A", "成果A"], "missed": []})
    assert r.status_code == 200
    assert r.json()["review"]["done"] == ["成果A"]


# ---------------------------- C. 备份与恢复 ----------------------------


def test_backup_roundtrip_in_isolation(client):
    """备份 → 隔离恢复 → 行数一致。全程不动正式库。"""
    client.post("/api/ideas", json={"title": "备份前的想法"})
    client.post("/api/literature", json={"title": "备份前的文献"})

    snap = backup.create_backup("pytest")
    info = backup.inspect(snap["name"])
    assert info["ok"] is True
    assert info["counts"]["ideas"] == 1 and info["counts"]["literature"] == 1

    restored = backup.restore_to_isolated(snap["name"])
    assert restored["counts"]["ideas"] == 1
    assert restored["counts"]["literature"] == 1
    # 正式库仍在原处，没被这次验证动过
    assert backup.db_path().exists()
    assert len(query("SELECT * FROM ideas")) == 1


def test_backup_restore_live_keeps_data(client):
    """覆盖恢复：先造数据 → 备份 → 改数据 → 恢复，原数据要回得来。"""
    client.post("/api/ideas", json={"title": "要被恢复回来的想法"})
    snap = backup.create_backup("pytest-live")

    client.post("/api/ideas", json={"title": "恢复前多出来的想法"})
    assert len(query("SELECT * FROM ideas")) == 2

    res = backup.restore_to_live(snap["name"])
    assert res["mode"] == "live"
    assert res["counts"]["ideas"] == 1
    assert backup.list_backups(), "恢复前应自动打了安全快照"


def test_backup_api_requires_confirm_for_live_restore(client):
    snap = backup.create_backup("pytest-api")
    r = client.post(f"/api/backup/{snap['name']}/restore", json={"mode": "live"})
    assert r.status_code == 400, "没有 confirm 竟然允许覆盖正式库"
    ok = client.post(f"/api/backup/{snap['name']}/restore", json={"mode": "isolated"})
    assert ok.status_code == 200 and ok.json()["mode"] == "isolated"
    lst = client.get("/api/backup").json()
    assert any(b["name"] == snap["name"] for b in lst["backups"])


# ---------------------------- D. 密钥不出现在响应里 ----------------------------


def test_settings_llm_response_has_no_plain_key(client):
    import llm_config

    llm_config.save_config(
        {
            "default_provider": "k",
            "providers": [{"id": "k", "name": "K", "type": "openai",
                           "base_url": "http://x/v1", "api_key": SECRET,
                           "model_fast": "m", "model_reason": "m", "enabled": True}],
        }
    )
    body = client.get("/api/settings/llm").json()
    assert SECRET not in json.dumps(body, ensure_ascii=False), "设置接口回传了明文 key"
    assert body["providers"][0]["api_key_set"] is True

    # 原样回传脱敏值 = 没改这一项，库里的 key 必须还在
    client.put(
        "/api/settings/llm",
        json={"default_provider": "k",
              "providers": [{**body["providers"][0], "name": "改名了"}]},
    )
    from llm_config import get_provider

    assert get_provider("k")["api_key"] == SECRET, "回传脱敏值把密钥清空了"


def test_export_never_contains_secrets(client):
    import llm_config

    llm_config.save_config(
        {
            "default_provider": "k",
            "providers": [{"id": "k", "name": "K", "type": "openai",
                           "base_url": "http://x/v1", "api_key": SECRET,
                           "model_fast": "m", "model_reason": "m", "enabled": True}],
        }
    )
    text = client.get("/api/export/all").text
    assert SECRET not in text, "全量导出里出现了密钥"


# ---------------------------- E. 历史污染只识别不自动删 ----------------------------


def test_suspects_are_listed_not_deleted(client):
    lid = client.post("/api/literature", json={"title": "被污染的文献"}).json()["id"]
    nid = client.post(
        f"/api/literature/{lid}/notes",
        json={"section": "笔记", "content": "[LLM 调用失败] provider=x base_url=y"},
    ).json()[0]["id"]
    eid = client.post("/api/experiments", json={"name": "污染实验"}).json()["id"]
    from db import execute

    execute("UPDATE experiments SET conclusion=? WHERE id=?", ("[Dify 调用失败] 连不上", eid))

    body = client.get("/api/ai/suspects").json()
    assert body["total"] >= 2, body
    kinds = {i["table"] for i in body["items"]}
    assert "lit_notes" in kinds and "experiments" in kinds

    # GET 只是看，绝不能删
    assert query("SELECT * FROM lit_notes WHERE id=?", (nid,))

    # 不带清单 / 不确认 → 不动任何数据
    assert client.post("/api/ai/suspects/cleanup", json={"items": []}).status_code == 400
    assert client.post(
        "/api/ai/suspects/cleanup",
        json={"items": [{"table": "lit_notes", "id": nid, "action": "delete"}]},
    ).status_code == 400

    # 明确指定 + 确认 → 才处理
    r = client.post(
        "/api/ai/suspects/cleanup",
        json={"items": [{"table": "lit_notes", "id": nid, "action": "delete"}], "confirm": True},
    )
    assert r.status_code == 200 and r.json()["deleted"] == 1
    assert query("SELECT * FROM lit_notes WHERE id=?", (nid,)) == []
    # 没点名的实验结论必须原样留着
    row = query("SELECT conclusion FROM experiments WHERE id=?", (eid,))[0]
    assert "Dify" in (row["conclusion"] or "")
