"""对话模块：会话、消息、上下文注入、离线降级。"""
import pytest

from db import query


def test_roles_and_context_options(client):
    r = client.get("/api/chat/roles").json()
    assert {x["value"] for x in r["roles"]} >= {"assistant", "reviewer", "cfd"}
    opts = client.get("/api/chat/context/options").json()["options"]
    assert {o["value"] for o in opts} == {"ideas", "literature", "experiments", "paper", "plan"}


def test_plan_context_actually_builds(client):
    """「近期周计划」上下文曾因查询了不存在的列而恒为空。"""
    client.post("/api/plan/week", json={"outcomes": ["写完 Method", "跑完 F2"]})
    r = client.post("/api/chat/context/preview", json={"keys": ["plan"]})
    assert r.status_code == 200, r.text
    text = r.json()["text"]
    assert text, "周计划上下文为空——查询可能引用了不存在的列"
    assert "近期周计划" in text


def test_all_context_keys_build(client):
    client.post("/api/ideas", json={"title": "想法X"})
    client.post("/api/literature", json={"title": "文献X"})
    client.post("/api/experiments", json={"name": "实验X"})
    r = client.post(
        "/api/chat/context/preview",
        json={"keys": ["ideas", "literature", "experiments", "paper", "plan"]},
    )
    text = r.json()["text"]
    assert "创新点池" in text
    assert "文献库" in text
    assert "实验" in text
    assert "论文进度" in text


def test_session_crud(client):
    sid = client.post("/api/chat/sessions", json={"title": "会话A", "role": "cfd"}).json()["id"]
    body = client.get(f"/api/chat/sessions/{sid}").json()
    assert body["role"] == "cfd"
    assert body["messages"] == []

    client.patch(f"/api/chat/sessions/{sid}", json={"title": "改名", "mode": "reason"})
    assert client.get(f"/api/chat/sessions/{sid}").json()["title"] == "改名"

    client.delete(f"/api/chat/sessions/{sid}")
    assert client.get(f"/api/chat/sessions/{sid}").status_code == 404


def test_send_message_offline_keeps_input_only(client):
    """调用失败时：用户提问留在库里（可重试），但不写入任何假回复。

    历史上失败文案会被当成 assistant 消息存下来，下一次请求还会把它
    当上下文喂回去，错误会一路自我复制。
    """
    sid = client.post("/api/chat/sessions", json={"title": "离线会话"}).json()["id"]
    r = client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "你好"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False  # 无 provider，走降级
    assert r.json()["error"]["kind"] == "no_provider", r.json()
    msgs = client.get(f"/api/chat/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user"]
    assert msgs[0]["content"] == "你好"
    assert "失败" not in (msgs[0]["content"] or "")


def test_send_message_success_records_reply(client, monkeypatch):
    """成功的回复要照常入库，退化处理不能变成「永远不回复」。"""
    import llm as llm_mod

    async def fake(messages, **kw):
        return {"ok": True, "content": "这是回复", "provider": "fake", "model": "m",
                "tokens_in": 1, "tokens_out": 2, "error": None}

    monkeypatch.setattr(llm_mod, "chat_result", fake)
    sid = client.post("/api/chat/sessions", json={"title": "正常会话"}).json()["id"]
    r = client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "你好"})
    assert r.json()["ok"] is True
    assert r.json()["reply"] == "这是回复"
    msgs = client.get(f"/api/chat/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[1]["content"] == "这是回复"


def test_empty_message_rejected(client):
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    assert client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "   "}).status_code == 400


def test_regenerate_does_not_duplicate_user_message(client):
    """重新生成只应重跑最后一条，不能把 user 消息插两遍。"""
    sid = client.post("/api/chat/sessions", json={"title": "重生成"}).json()["id"]
    client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "第一个问题"})
    r = client.post(
        f"/api/chat/sessions/{sid}/messages", json={"regenerate": True, "content": ""}
    )
    assert r.status_code == 200, r.text
    msgs = client.get(f"/api/chat/sessions/{sid}").json()["messages"]
    user_msgs = [m for m in msgs if m["role"] == "user"]
    assert len(user_msgs) == 1, f"用户消息被重复插入：{len(user_msgs)}"
    assert user_msgs[0]["content"] == "第一个问题"


def test_export_session_markdown(client, monkeypatch):
    import llm as llm_mod

    async def fake(messages, **kw):
        return {"ok": True, "content": "回答A", "provider": "fake", "model": "m",
                "tokens_in": 1, "tokens_out": 1, "error": None}

    monkeypatch.setattr(llm_mod, "chat_result", fake)
    sid = client.post("/api/chat/sessions", json={"title": "导出会话"}).json()["id"]
    client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "问题"})
    r = client.post(f"/api/chat/sessions/{sid}/export").json()
    assert r["title"] == "导出会话"
    assert "## 我" in r["markdown"] and "## AI" in r["markdown"]
    assert "问题" in r["markdown"] and "回答A" in r["markdown"]


def test_clear_messages(client):
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "x"})
    client.post(f"/api/chat/sessions/{sid}/clear")
    assert client.get(f"/api/chat/sessions/{sid}").json()["messages"] == []


def test_delete_session_cascades_messages(client):
    sid = client.post("/api/chat/sessions", json={}).json()["id"]
    client.post(f"/api/chat/sessions/{sid}/messages", json={"content": "x"})
    client.delete(f"/api/chat/sessions/{sid}")
    assert query("SELECT * FROM chat_messages WHERE session_id=?", (sid,)) == []


def test_quick_chat_offline(client):
    r = client.post("/api/chat/quick", json={"content": "一句话问题"})
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert r.json()["content"] == "", "失败时不应返回任何可展示的正文"
    assert (r.json()["error"] or {}).get("kind")


def test_missing_session_404(client):
    assert client.get("/api/chat/sessions/999999").status_code == 404
    assert client.post("/api/chat/sessions/999999/messages", json={"content": "x"}).status_code == 404
