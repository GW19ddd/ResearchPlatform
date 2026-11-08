"""大模型功能点测试矩阵 —— 契约层（不触网、不发真实模型请求）。

覆盖所有走 llm.py 统一信封的 AI 端点，以及 llm 层核心 API。每个端点验两件事：

1. **失败**：LLM 返回 ok=False 时，端点不得把错误文本当成果返回、不得落库、
   不得覆盖用户已有内容；SSE 端点只吐 error 事件、不落 assistant 消息。
   502 响应体也要显式检查，不能只看状态码。
2. **成功**：LLM 返回 ok=True 时，端点能把真实产出交出去（并按需落库），
   且替身必须记录到预期的 task，证明测试真的打到了该端点的 AI 调用点。

真实模型调用在 ``live_llm_smoke.py``（独立脚本，不参与 pytest 收集），
两者边界在测试报告中显式声明，绝不把 mock 结果写成真实调用结果。

实现要点：``llm.complete_with_meta`` 是模块级别名赋值，必须和
``complete_result`` 一起 monkeypatch，否则画布 / rchat 会漏掉替身。

审查反馈已处理（见 docs/llm-feature-test-report.md）：
- C1 画布 run 端点、C2 rchat deep 全链路补齐；
- I1 覆盖自检升级到「端点 + task」双维度，不再是 router 文件级；
- I2 canvas.auto / canvas.chat 的 ok=True 偏差改用 xfail(strict) 显式标注；
- I3 失败态显式解析 502 响应体并断言成果字段为空；
- I4 替身记录 task 与调用次数，成功态断言具体成果字段。
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import pytest

import llm
import llm_config
from db import query

OK = "SENTINEL_OK_真实成果"
ERR = "SENTINEL_ERR_模拟故障"


def _ok_env(content: str = OK) -> dict:
    return {
        "ok": True,
        "content": content,
        "provider": "fake",
        "provider_id": "fake",
        "model": "fake-model",
        "tokens_in": 7,
        "tokens_out": 11,
        "error": None,
    }


def _fail_env() -> dict:
    return {
        "ok": False,
        "content": "",
        "provider": "fake",
        "provider_id": "fake",
        "model": "",
        "tokens_in": 0,
        "tokens_out": 0,
        "error": {
            "kind": "network",
            "label": "网络不通",
            "message": ERR,
            "detail": "simulated failure",
            "hint": "请重试或换一个 provider",
        },
    }


# complete_json_result 的替身按 task 返回各端点真正期望的结构，
# 这样测的是「JSON 成功路径」，而不是一律掉进 Markdown 兜底。
_JSON_BY_TASK: dict[str, Any] = {
    "brainstorm": [
        {
            "title": OK,
            "one_liner": "可验证的一句话主张",
            "defect": "现有方法的具体缺陷",
            "mve": "做 A/B 看指标",
            "novelty": 4,
            "feasibility": 4,
            "impact": 3,
            "effort": 2,
            "category": "测试类",
            "risk": "样本量偏小",
        }
    ],
    "lit-digest": {"sections": [{"title": "方法核心", "content": OK}]},
    "rchat:qgen": {"queries": ["LLM unit test generation", "mutation testing"]},
}

_CANVAS_AUTO_PLAN = {
    "name": "测试画布",
    "rationale": OK,
    "nodes": [
        {"key": "n2", "skill_id": "academic-research-suite", "title": "研究框架",
         "inputs": {}, "why": "收敛问题"},
        {"key": "n3", "skill_id": "literature-survey-skill", "title": "综述与空白",
         "inputs": {}, "why": "确认空白"},
    ],
    "edges": [["n2", "n3"]],
}

_CANVAS_CHAT_PLAN = {"reply": OK, "ops": [], "plan": [], "suggests": ["继续追问"]}


def _content_for(task: str) -> str:
    if task == "canvas:auto":
        return json.dumps(_CANVAS_AUTO_PLAN, ensure_ascii=False)
    if task == "canvas:chat":
        return json.dumps(_CANVAS_CHAT_PLAN, ensure_ascii=False)
    if task == "advisor-extract":
        return json.dumps(
            {"scene": "组会", "advisor_said": OK, "my_commitment": "补一组实验",
             "due_date": "", "risks": ""},
            ensure_ascii=False,
        )
    return OK


class _FakeLLMState(str):
    """既是 'ok'/'fail' 字符串（兼容原有比较），又挂载调用记录。"""

    def __new__(cls, state: str, calls: list[tuple[str, str]]):
        obj = super().__new__(cls, state)
        obj.calls = calls
        return obj


@pytest.fixture()
def fake_llm(monkeypatch, request):
    """request.param = 'ok' | 'fail'；替换 llm 模块的全部对外入口并记录调用。"""
    state = request.param
    calls: list[tuple[str, str]] = []  # (入口, task)

    def rec(entry: str, task: str) -> None:
        calls.append((entry, task or ""))

    async def complete_result(prompt=None, **kw):
        rec("complete_result", kw.get("task", ""))
        if state == "fail":
            return _fail_env()
        return _ok_env(_content_for(kw.get("task", "")))

    async def complete_json_result(prompt=None, **kw):
        rec("complete_json_result", kw.get("task", ""))
        if state == "fail":
            return None, _fail_env()
        task = kw.get("task", "")
        data = _JSON_BY_TASK.get(task, {"sections": [{"title": "方法核心", "content": OK}]})
        return data, _ok_env(json.dumps(data, ensure_ascii=False))

    async def chat_result(messages=None, **kw):
        rec("chat_result", kw.get("task", ""))
        return _fail_env() if state == "fail" else _ok_env()

    def stream_chat_events(messages=None, **kw):
        rec("stream_chat_events", kw.get("task", ""))

        async def gen():
            if state == "fail":
                yield {"type": "error", "error": _fail_env()["error"]}
            else:
                yield {"type": "delta", "text": OK}
                yield {
                    "type": "meta", "content": OK, "provider": "fake", "provider_id": "fake",
                    "model": "fake-model", "tokens_in": 7, "tokens_out": 11,
                }
        return gen()

    monkeypatch.setattr(llm, "complete_result", complete_result)
    monkeypatch.setattr(llm, "complete_with_meta", complete_result)  # 别名必须一起换
    monkeypatch.setattr(llm, "complete_json_result", complete_json_result)
    monkeypatch.setattr(llm, "chat_result", chat_result)
    monkeypatch.setattr(llm, "stream_chat_events", stream_chat_events)
    return _FakeLLMState(state, calls)


# ---------------------------------------------------------------- 用例定义


def _assert_empty(table: str, where: str = "", args: tuple = ()) -> None:
    sql = f"SELECT * FROM {table}" + (f" WHERE {where}" if where else "")
    assert query(sql, args) == [], f"{table} 里出现了不该写入的 AI 成果"


def _prep_idea(client):
    return {"iid": client.post("/api/ideas", json={"title": "测试想法"}).json()["id"]}


def _prep_lit(client):
    return {"lid": client.post("/api/literature", json={"title": "某篇论文"}).json()["id"]}


def _prep_exp(client):
    eid = client.post(
        "/api/experiments", json={"name": "实验E", "conclusion": "我手写的结论"}
    ).json()["id"]
    return {"eid": eid}


def _prep_exp_failed(client):
    eid = _prep_exp(client)["eid"]
    client.post(
        f"/api/experiments/{eid}/results",
        json={"case_name": "case1", "method": "baseline", "success": False,
              "metrics_json": "{}", "notes": "报错"},
    )
    return {"eid": eid}


def _prep_two_exps(client):
    a = client.post("/api/experiments", json={"name": "A"}).json()["id"]
    b = client.post("/api/experiments", json={"name": "B"}).json()["id"]
    return {"a": a, "b": b}


def _prep_stage(client):
    rows = client.get("/api/paper/stages").json()
    return {"sid": rows[0]["id"]}


def _prep_section(client):
    rows = client.get("/api/paper/sections").json()
    return {"sec": rows[0]["id"]}


def _prep_chat_session(client):
    return {"sid": client.post("/api/chat/sessions", json={"title": "测试会话"}).json()["id"]}


def _prep_chat_session_autotitle(client):
    """默认标题「新对话」的会话，首轮消息会触发 _auto_title 的 chat-title 调用点。"""
    return {"sid": client.post("/api/chat/sessions", json={"title": "新对话"}).json()["id"]}


def _prep_rchat_session(client):
    return {"sid": client.post("/api/rchat/sessions", json={}).json()["id"]}


def _prep_skill(client):
    skills = client.get("/api/canvas/skills").json()
    items = skills if isinstance(skills, list) else skills.get("skills", [])
    assert items, "技能库为空，无法测 skill/run"
    return {"skid": items[0]["id"]}


def _prep_canvas(client):
    return {"cid": client.post("/api/canvas", json={"name": "测试画布"}).json()["id"]}


@dataclass
class Case:
    key: str
    method: str
    url: str
    body: dict = field(default_factory=dict)
    prepare: Callable | None = None
    fail_status: int = 200
    check_ok_false: bool = True
    allow_error_in: tuple = ()          # 允许错误文案出现的字段（如实降级标注）
    fail_extra: Callable | None = None  # 失败态的额外结构断言
    pollution: Callable | None = None   # 失败后检查没有脏数据
    expect_task: str | tuple[str, ...] | None = None  # 成功态必须命中的 LLM task
    ok_probe: Callable[[dict], str] | None = None     # 成功态取成果文本


CASES: list[Case] = [
    # ---- research：创新点 / 文献 / 实验 ----
    Case("research.brainstorm", "POST", "/api/ideas/brainstorm",
         {"direction": "CFD 智能体", "count": 2},
         pollution=lambda c: _assert_empty("ideas"), expect_task="brainstorm",
         ok_probe=lambda j: json.dumps(j.get("candidates"), ensure_ascii=False)),
    Case("research.idea_review", "POST", "/api/ideas/{iid}/review", {"role": "reviewer"},
         prepare=_prep_idea, pollution=lambda c: _assert_empty("idea_reviews"),
         expect_task="idea-review"),
    Case("research.lit_keywords", "POST", "/api/literature/keywords", {"topic": "LLM 测试生成"},
         expect_task="lit-keywords"),
    Case("research.lit_digest", "POST", "/api/literature/{lid}/digest", {},
         prepare=_prep_lit, pollution=lambda c: _assert_empty("lit_notes"),
         expect_task="lit-digest"),
    Case("research.exp_analysis", "POST", "/api/experiments/{eid}/analysis",
         prepare=_prep_exp, expect_task="exp-analysis",
         pollution=lambda c: (_assert_empty("experiments", "conclusion<>?", ("我手写的结论",)))),
    Case("research.exp_failures", "POST", "/api/experiments/{eid}/failures",
         prepare=_prep_exp_failed, expect_task="exp-failures"),
    Case("research.exp_design_review", "POST", "/api/experiments/{eid}/design-review", {},
         prepare=_prep_exp, expect_task="exp-design-review"),
    Case("research.exp_compare", "POST", "/api/experiments/compare",
         {"ids": ["{a}", "{b}"]}, prepare=_prep_two_exps, expect_task="exp-compare"),
    # ---- paper：解阻塞 / 诊断 / 提纲 ----
    Case("paper.unblock", "POST", "/api/paper/stages/{sid}/unblock", prepare=_prep_stage,
         expect_task="unblock"),
    Case("paper.diagnose", "POST", "/api/paper/stages/{sid}/diagnose", {}, prepare=_prep_stage,
         expect_task="stage-diagnose"),
    Case("paper.outline", "POST", "/api/paper/sections/{sec}/outline", {}, prepare=_prep_section,
         expect_task="section-outline"),
    # ---- plan：双周组会汇报 ----
    Case("plan.biweekly", "GET", "/api/plan/biweekly", expect_task="biweekly"),
    # ---- advisor：话术 / 承诺抽取 ----
    Case("advisor.draft", "POST", "/api/advisor/draft",
         {"scene": "周报", "progress": "跑完两组实验"}, expect_task="advisor-draft"),
    Case("advisor.extract", "POST", "/api/advisor/extract", {"raw": "导师说下周五前交初稿"},
         expect_task="advisor-extract"),
    # ---- chat：对话 / 单次提问 / 自动标题 ----
    Case("chat.send", "POST", "/api/chat/sessions/{sid}/messages", {"content": "你好"},
         prepare=_prep_chat_session, expect_task="chat",
         ok_probe=lambda j: str(j.get("reply") or ""),
         pollution=lambda c: _assert_empty("chat_messages", "role='assistant'")),
    Case("chat.send_autotitle", "POST", "/api/chat/sessions/{sid}/messages", {"content": "你好"},
         prepare=_prep_chat_session_autotitle, expect_task=("chat", "chat-title"),
         ok_probe=lambda j: str(j.get("reply") or ""),
         pollution=lambda c: _assert_empty("chat_messages", "role='assistant'")),
    Case("chat.quick", "POST", "/api/chat/quick", {"content": "你好"},
         expect_task="chat-quick", ok_probe=lambda j: str(j.get("content") or "")),
    # ---- rchat：研究对话 / 报告（失败抛 502） ----
    Case("rchat.auto", "POST", "/api/rchat/sessions/{sid}/chat",
         {"instruction": "总结一下", "mode": "auto"},
         prepare=_prep_rchat_session, fail_status=502, check_ok_false=False,
         expect_task="rchat:auto", ok_probe=lambda j: j["message"]["content"],
         pollution=lambda c: _assert_empty("rchat_messages", "role='assistant'")),
    Case("rchat.report", "POST", "/api/rchat/sessions/{sid}/chat",
         {"instruction": "写份报告", "mode": "report"},
         prepare=_prep_rchat_session, fail_status=502, check_ok_false=False,
         expect_task="rchat:report", ok_probe=lambda j: j["message"]["content"],
         pollution=lambda c: _assert_empty("rchat_messages", "role='assistant'")),
    # ---- canvas：技能 / 自动编排 / 对话即操作 ----
    # skill/run 的 task 是 f"canvas:{skill_id}" 动态值，无法静态声明，
    # 由 test_canvas_skill_run_hits_llm 单独断言调用记录。
    Case("canvas.skill_run", "POST", "/api/canvas/skills/{skid}/run", {"inputs": {}},
         prepare=_prep_skill, pollution=lambda c: _assert_empty("canvas_runs")),
    Case("canvas.auto", "POST", "/api/canvas/auto", {"topic": "测试选题", "save": False},
         check_ok_false=False, allow_error_in=("rationale",), expect_task="canvas:auto",
         ok_probe=lambda j: str(j.get("rationale") or "") + json.dumps(j.get("nodes"), ensure_ascii=False),
         fail_extra=lambda j: _assert_fallback(j),
         pollution=lambda c: _assert_empty("canvases")),
    Case("canvas.chat", "POST", "/api/canvas/{cid}/chat", {"instruction": "加一个节点"},
         prepare=_prep_canvas, check_ok_false=False, allow_error_in=("reply",),
         expect_task="canvas:chat", ok_probe=lambda j: str(j.get("reply") or ""),
         fail_extra=lambda j: _assert_chat_failed_reply(j),
         pollution=lambda c: _assert_empty("canvas_nodes")),
]


def _assert_fallback(j: dict) -> None:
    assert j.get("fallback") is True, "AI 编排失败却没有如实标注 fallback"
    assert j.get("nodes"), "AI 失败后保底编排也没给出节点"
    assert OK not in json.dumps(j.get("nodes"), ensure_ascii=False), "保底编排里混进了 AI 成果"


def _assert_chat_failed_reply(j: dict) -> None:
    """失败态只验「如实告知 + 没落改动」，不再断言 ok 字段本身。

    ok=True 是已知产品偏差，用 xfail(strict) 单独标注，避免把偏差固化成合格测试。
    """
    assert str(j.get("reply", "")).startswith("（操作失败"), j
    assert OK not in json.dumps(j, ensure_ascii=False), j


def _format_ids(body: dict, vars: dict) -> dict:
    """compare 的 ids 里带 {a}/{b} 占位，按 prepare 的返回值替换。"""
    out = {}
    for k, v in body.items():
        if isinstance(v, list):
            out[k] = [int(str(x).format(**vars)) for x in v]
        elif isinstance(v, str) and "{" in v:
            out[k] = v.format(**vars)
        else:
            out[k] = v
    return out


# 成果字段白名单：成功态只在这里找 OK，避免元数据字段的偶然匹配。
_OUTCOME_KEYS = {
    "result", "results", "review", "content", "sections", "reply", "message",
    "analysis", "keywords", "text", "report", "outline", "md", "title",
    "notes", "plan", "draft", "answer", "summary", "rationale", "nodes",
    "digest", "diagnosis", "suggestions", "items", "list", "data", "output",
}


def _outcome_text(j: dict) -> str:
    picked = {k: v for k, v in j.items() if k in _OUTCOME_KEYS}
    rest = picked or {k: v for k, v in j.items() if k not in ("error", "detail")}
    return json.dumps(rest, ensure_ascii=False)


def _called_tasks(fake_llm) -> list[str]:
    return [t for _, t in fake_llm.calls]


def _assert_expected_tasks(case: Case, fake_llm) -> None:
    if not case.expect_task:
        return
    want = (case.expect_task,) if isinstance(case.expect_task, str) else case.expect_task
    seen = _called_tasks(fake_llm)
    missing = [t for t in want if t not in seen]
    assert not missing, f"{case.key} 没命中预期 LLM 调用点 {missing}；实际 task={seen}"


@pytest.mark.parametrize("fake_llm", ["fail", "ok"], indirect=True)
@pytest.mark.parametrize("case", CASES, ids=lambda c: c.key)
def test_ai_endpoint_contract(client, fake_llm, case):
    vars_ = case.prepare(client) if case.prepare else {}
    url = case.url.format(**vars_)
    body = _format_ids(case.body, vars_)
    r = client.get(url) if case.method == "GET" else client.request(case.method, url, json=body)

    if fake_llm == "fail":
        assert r.status_code == case.fail_status, f"{case.key}: {r.text[:300]}"
        # P0：无论 200 还是 502，都必须真的打到 LLM 层（不是靠别的路径绕过）
        assert fake_llm.calls, f"{case.key} 失败态没有触发任何 LLM 调用"
        j = r.json()
        # I3：502 响应体不再完全忽略；成功成果哨兵绝不能出现，错误只许落在 detail/error
        assert OK not in json.dumps(j, ensure_ascii=False), (
            f"{case.key} 失败响应里夹带了成功成果：{str(j)[:300]}"
        )
        if case.fail_status != 200:
            assert j.get("ok") is not True, f"{case.key} 失败却带 ok=True：{str(j)[:300]}"
            assert j.get("detail"), f"{case.key} 502 没给错误说明：{str(j)[:300]}"
        elif case.check_ok_false:
            assert j.get("ok") is False, f"{case.key} 失败却返回 ok=True：{str(j)[:300]}"
        non_error = {k: v for k, v in j.items() if k not in ("error", "detail", *case.allow_error_in)}
        assert ERR not in json.dumps(non_error, ensure_ascii=False), (
            f"{case.key} 把错误文本当成成果返回：{str(non_error)[:300]}"
        )
        if case.fail_extra:
            case.fail_extra(j)
        if case.pollution:
            case.pollution(client)
        return

    assert r.status_code == 200, f"{case.key}: {r.text[:300]}"
    j = r.json()
    # I4：成功态断言具体成果字段 + 预期 task 命中，不再只靠全文搜 OK
    outcome = case.ok_probe(j) if case.ok_probe else _outcome_text(j)
    assert OK in outcome, f"{case.key} 成功路径没拿到模型产出：{str(j)[:300]}"
    assert ERR not in json.dumps(j, ensure_ascii=False), f"{case.key} 成功响应里混进了错误文本"
    _assert_expected_tasks(case, fake_llm)


@pytest.mark.parametrize("fake_llm", ["ok"], indirect=True)
def test_canvas_skill_run_hits_llm(client, fake_llm):
    """skill/run 的 task 是动态 f"canvas:{skill_id}"，单独断言它真的调了 LLM。"""
    skid = _prep_skill(client)["skid"]
    r = client.post(f"/api/canvas/skills/{skid}/run", json={"inputs": {}})
    assert r.status_code == 200, r.text[:300]
    tasks = _called_tasks(fake_llm)
    # skill/run 的 task 是动态 f"skill:{skill_id}"（见 canvas.py api_skill_run），
    # 与 canvas:auto / canvas:chat 的 canvas: 前缀不同，这里分别确认。
    assert any(t.startswith("skill:") for t in tasks), f"skill/run 没走 LLM：{tasks}"
    assert OK in json.dumps(r.json(), ensure_ascii=False)


# ---------------------------------------------------------------- 已知偏差（不固化成合格）


@pytest.mark.parametrize("fake_llm", ["fail"], indirect=True)
@pytest.mark.parametrize(
    "case", [c for c in CASES if c.key in ("canvas.auto", "canvas.chat")], ids=lambda c: c.key
)
@pytest.mark.xfail(
    strict=True,
    reason="已知产品偏差：canvas.auto / canvas.chat 在 AI 失败时仍返回 ok=True；"
           "产品修好后本用例会 XPASS(strict) 失败，提醒删除本标记并收紧主矩阵。",
)
def test_known_deviation_canvas_failure_ok_flag(client, fake_llm, case):
    vars_ = case.prepare(client) if case.prepare else {}
    url = case.url.format(**vars_)
    r = client.post(url, json=_format_ids(case.body, vars_))
    assert r.status_code == 200, r.text[:300]
    assert r.json().get("ok") is False, f"{case.key} 失败仍返回 ok=True（待修）"


# ---------------------------------------------------------------- SSE 端点


def _sse_events(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        if line.startswith("data: "):
            try:
                out.append(json.loads(line[6:]))
            except ValueError:
                pass
    return out


@pytest.mark.parametrize("fake_llm", ["fail", "ok"], indirect=True)
def test_chat_stream_contract(client, fake_llm):
    sid = _prep_chat_session(client)["sid"]
    r = client.post(f"/api/chat/sessions/{sid}/messages/stream", json={"content": "你好"})
    assert r.status_code == 200, r.text[:300]
    events = _sse_events(r.text)
    if fake_llm == "fail":
        assert any(e.get("type") == "error" for e in events), events
        assert not any(e.get("type") == "done" for e in events), events
        _assert_empty("chat_messages", "session_id=? AND role='assistant'", (sid,))
    else:
        assert any(e.get("type") == "delta" and OK in e.get("text", "") for e in events), events
        assert any(e.get("type") == "done" for e in events), events
        assert query("SELECT * FROM chat_messages WHERE session_id=? AND role='assistant'", (sid,))
        assert "chat" in _called_tasks(fake_llm)


@pytest.mark.parametrize("fake_llm", ["fail", "ok"], indirect=True)
def test_rchat_stream_contract(client, fake_llm):
    sid = _prep_rchat_session(client)["sid"]
    r = client.post(
        f"/api/rchat/sessions/{sid}/chat/stream",
        json={"instruction": "总结一下", "mode": "auto"},
    )
    assert r.status_code == 200, r.text[:300]
    events = _sse_events(r.text)
    if fake_llm == "fail":
        assert any(e.get("type") == "error" for e in events), events
        assert not any(e.get("type") == "done" for e in events), events
        assert OK not in json.dumps(events, ensure_ascii=False), events
        _assert_empty("rchat_messages", "session_id=? AND role='assistant'", (sid,))
    else:
        done = [e for e in events if e.get("type") == "done"]
        assert done, events
        assert OK in done[0]["message"]["content"], done[0]
        assert query("SELECT * FROM rchat_messages WHERE session_id=? AND role='assistant'", (sid,))
        assert "rchat:auto" in _called_tasks(fake_llm)


# ---------------------------------------------------------------- C1：画布节点执行


def _prep_canvas_with_llm_node(client) -> dict:
    """input 节点 + prompt 节点：prompt 走 _run_llm → complete_result(task=canvas:custom)。"""
    cid = client.post("/api/canvas", json={"name": "运行测试画布"}).json()["id"]
    saved = client.post(f"/api/canvas/{cid}/save", json={
        "nodes": [
            {"node_key": "n1", "type": "input", "title": "原始输入",
             "config": {"text": "待总结的原始材料"}},
            {"node_key": "n2", "type": "prompt", "title": "生成结论",
             "config": {"prompt": "请基于下面材料给出结论：{{upstream}}"}},
        ],
        "edges": [{"source_key": "n1", "target_key": "n2"}],
    })
    assert saved.json().get("ok") is True, saved.text[:300]
    return {"cid": cid}


def _await_run(client, run_id: int, tries: int = 60) -> dict:
    """后台任务在 TestClient 的 portal loop 里跑，连续请求让它有机会被调度完。"""
    for _ in range(tries):
        j = client.get(f"/api/canvas/runs/{run_id}").json()
        if j["run"]["status"] in ("done", "failed", "cancelled"):
            return j
        time.sleep(0.01)
    return j


@pytest.mark.parametrize("fake_llm", ["fail", "ok"], indirect=True)
def test_canvas_run_endpoint_contract(client, fake_llm):
    """C1：POST /api/canvas/{id}/run 的 P0 契约。

    - 端点立刻回 run_id，后台执行 _exec_node → _run_llm；
    - 成功：canvas_node_outputs 落真实成果、status=done；
    - 失败：output_text 恒为空、status=error、error_json 有说明，绝不把错误文本当成果。
    """
    cid = _prep_canvas_with_llm_node(client)["cid"]
    r = client.post(f"/api/canvas/{cid}/run", json={})
    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert j["status"] == "queued" and j["run_id"], j
    assert j["nodes"] == ["n1", "n2"], j

    detail = _await_run(client, j["run_id"])
    run, outputs = detail["run"], detail["outputs"]
    assert run["status"] in ("done", "failed"), run
    llm_out = [o for o in outputs if o["node_key"] == "n2"]
    assert len(llm_out) == 1, outputs
    o = llm_out[0]
    assert "canvas:custom" in _called_tasks(fake_llm), _called_tasks(fake_llm)

    if fake_llm == "fail":
        assert run["status"] == "failed", run
        assert o["status"] == "error" and o["ok"] is False, o
        assert o["output_text"] == "", "P0：LLM 失败时节点产出必须为空"
        assert o["error"] and o["error"].get("message"), o
        assert ERR not in (o.get("output_text") or ""), o
        assert OK not in json.dumps(outputs, ensure_ascii=False), outputs
    else:
        assert run["status"] == "done", run
        assert o["status"] == "done" and o["ok"] is True, o
        assert OK in o["output_text"], o
        assert o["model"] == "fake-model" and o["provider"] == "fake", o


# ---------------------------------------------------------------- C2：rchat deep 全链路


_FAKE_OA_WORK = {
    "id": "https://openalex.org/W990001",
    "display_name": "A Fake Paper on LLM Test Generation",
    "publication_year": 2024,
    "cited_by_count": 42,
    "doi": "https://doi.org/10.1000/fake-paper",
    "authorships": [{"author": {"display_name": "A. Author"}}],
    "primary_location": {"source": {"display_name": "Fake Venue"}},
    "abstract_inverted_index": {"test": [0], "generation": [1]},
    "open_access": {"is_oa": True},
}


@pytest.fixture()
def fake_openalex(monkeypatch):
    """替换 _oa_search，让 deep 链路拿到确定的假 OpenAlex work（不触网）。"""
    import routers.rchat as rchat_mod

    async def _search(client, q, per_page=6):
        return [_FAKE_OA_WORK]

    monkeypatch.setattr(rchat_mod, "_oa_search", _search)
    return rchat_mod


@pytest.mark.parametrize("fake_llm", ["fail", "ok"], indirect=True)
def test_rchat_deep_json_contract(client, fake_llm, fake_openalex):
    """C2：mode=deep 的 JSON 端点。

    必须命中 rchat:qgen（检索式）与 rchat:deep（综述）两个调用点；
    成功态把检索命中的真实元数据写入 literature 并落 assistant 消息；
    失败态 502，绝不落 assistant 消息、绝不把错误文本当成果。
    """
    sid = _prep_rchat_session(client)["sid"]
    r = client.post(f"/api/rchat/sessions/{sid}/chat",
                    json={"instruction": "LLM 单元测试生成的研究现状", "mode": "deep"})
    tasks = _called_tasks(fake_llm)
    assert "rchat:qgen" in tasks, tasks
    assert "rchat:deep" in tasks, tasks

    if fake_llm == "fail":
        assert r.status_code == 502, r.text[:300]
        j = r.json()
        assert OK not in json.dumps(j, ensure_ascii=False), j
        assert j.get("ok") is not True, j
        assert j.get("detail"), j
        _assert_empty("rchat_messages", "session_id=? AND role='assistant'", (sid,))
        return

    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert OK in j["message"]["content"], j
    assert j["message"]["kind"] == "deep", j
    assert j["message"]["meta"]["citations"], j
    # 检索命中即入文献库（真实元数据，非 AI 生成文本）
    rows = query("SELECT * FROM literature WHERE title=?", (_FAKE_OA_WORK["display_name"],))
    assert len(rows) == 1, rows
    assert query("SELECT * FROM rchat_messages WHERE session_id=? AND role='assistant'", (sid,))


@pytest.mark.parametrize("fake_llm", ["fail", "ok"], indirect=True)
def test_rchat_deep_stream_contract(client, fake_llm, fake_openalex):
    """C2：mode=deep 的 SSE 端点，验证真实阶段事件与 papers 文献卡。

    失败态只吐 error、不吐 done，且不落 assistant 消息。
    """
    sid = _prep_rchat_session(client)["sid"]
    r = client.post(f"/api/rchat/sessions/{sid}/chat/stream",
                    json={"instruction": "LLM 单元测试生成的研究现状", "mode": "deep"})
    assert r.status_code == 200, r.text[:300]
    events = _sse_events(r.text)
    tasks = _called_tasks(fake_llm)
    assert "rchat:qgen" in tasks and "rchat:deep" in tasks, tasks
    stages = [e["key"] for e in events if e.get("type") == "stage"]
    assert "queries" in stages and "search" in stages and "dedupe" in stages, stages

    if fake_llm == "fail":
        assert any(e.get("type") == "error" for e in events), events
        assert not any(e.get("type") == "done" for e in events), events
        assert OK not in json.dumps(events, ensure_ascii=False), events
        _assert_empty("rchat_messages", "session_id=? AND role='assistant'", (sid,))
        return

    papers = [e for e in events if e.get("type") == "papers"]
    assert papers and papers[0]["total"] == 1, events
    assert papers[0]["papers"][0]["title"] == _FAKE_OA_WORK["display_name"], papers[0]
    done = [e for e in events if e.get("type") == "done"]
    assert done and OK in done[0]["message"]["content"], done
    assert query("SELECT * FROM rchat_messages WHERE session_id=? AND role='assistant'", (sid,))


# ---------------------------------------------------------------- settings 连通性


@pytest.mark.parametrize("state", ["fail", "ok"])
def test_settings_llm_test_and_models(client, monkeypatch, state):
    """设置页的「测试连接 / 拉模型」不走统一信封，单独验证 ok 字段与脱敏。"""
    async def fake_test(p):
        return {"ok": state == "ok", "message": "连通正常" if state == "ok" else "连不上"}

    async def fake_models(p):
        return {"ok": state == "ok", "models": ["m1", "m2"] if state == "ok" else [],
                "message": "" if state == "ok" else "拉取失败"}

    monkeypatch.setattr(llm, "test_connection", fake_test)
    monkeypatch.setattr(llm, "list_models", fake_models)
    body = {"base_url": "http://x/v1", "api_key": "k", "type": "openai", "model_fast": "m"}
    a = client.post("/api/settings/llm/test", json=body)
    b = client.post("/api/settings/llm/models", json=body)
    assert a.status_code == 200 and b.status_code == 200
    assert a.json()["ok"] is (state == "ok")
    assert b.json()["ok"] is (state == "ok")
    if state == "ok":
        assert b.json()["models"] == ["m1", "m2"]


# ---------------------------------------------------------------- llm 层核心契约


def _run(coro):
    return asyncio.run(coro)


def test_no_provider_returns_empty_content_envelope():
    """conftest 已禁用全部 provider：失败信封的 content 必须恒为空。"""
    env = _run(llm.complete_result("随便问点什么"))
    assert env["ok"] is False
    assert env["content"] == ""
    assert env["error"]["kind"] == "no_provider"
    assert env["error"]["hint"]


def test_force_fast_normalizes_reason_mode(monkeypatch):
    """FORCE_FAST=True 时即使调用点写 mode='reason'，也必须落到 fast 模型。"""
    cfg = llm_config.load_config()
    cfg["providers"] = [{
        "id": "fake", "name": "fake", "type": "openai", "base_url": "http://x/v1",
        "api_key": "k", "model_fast": "fast-model", "model_reason": "reason-model",
        "routing": "all", "enabled": True,
    }]
    cfg["default_provider"] = "fake"
    llm_config.save_config(cfg)

    seen = {}

    async def fake_dispatch(p, messages, mode, max_tokens, temperature):
        seen["mode"] = mode
        # 与真实 _dispatch_with_recovery 一致：返回 (内容, tin, tout, 实际 mode)
        return OK, 3, 5, mode

    monkeypatch.setattr(llm, "_dispatch_with_recovery", fake_dispatch)
    env = _run(llm.complete_result("x", mode="reason", task="pytest"))
    assert llm.FORCE_FAST is True
    assert seen["mode"] == "fast", seen
    assert env["ok"] is True and env["model"] == "fast-model"
    assert "degraded" not in env


def test_complete_json_parse_failure_is_not_success(monkeypatch):
    async def fake(prompt=None, **kw):
        return _ok_env("这不是 JSON")

    monkeypatch.setattr(llm, "complete_result", fake)
    data, env = _run(llm.complete_json_result("给我 JSON"))
    assert data is None
    assert env["ok"] is False and env["content"] == ""
    assert env["error"]["kind"] == "parse"


def test_complete_json_strips_code_fence(monkeypatch):
    async def fake(prompt=None, **kw):
        return _ok_env('```json\n{"a": 1}\n```')

    monkeypatch.setattr(llm, "complete_result", fake)
    data, env = _run(llm.complete_json_result("给我 JSON"))
    assert env["ok"] is True and data == {"a": 1}


def test_stream_failure_yields_only_error_event():
    """无可用 provider 时流式只吐 error，绝不吐 meta（调用方据此不落库）。"""
    async def collect():
        return [ev async for ev in llm.stream_chat_events([{"role": "user", "content": "x"}])]

    events = _run(collect())
    assert [e["type"] for e in events] == ["error"], events
    assert events[0]["error"]["kind"] == "no_provider"


def test_redact_masks_known_secret():
    cfg = llm_config.load_config()
    cfg["providers"] = [{
        "id": "k", "name": "K", "type": "openai", "base_url": "http://x/v1",
        "api_key": "sk-supersecret-123456", "model_fast": "m", "model_reason": "m",
        "enabled": True,
    }]
    cfg["default_provider"] = "k"
    llm_config.save_config(cfg)
    masked = llm.redact("请求头 Authorization: Bearer sk-supersecret-123456 失败")
    assert "sk-supersecret-123456" not in masked
    assert "***" in masked


# ---------------------------------------------------------------- I1：端点级 + task 级覆盖自检


def _norm_path(p: str) -> str:
    return re.sub(r"\{[^}]*\}", "{}", p)


# 从源码盘点出的全部 AI 端点（规范化路径）。新增 AI 端点必须同步进这里，
# 否则下面的自检会失败 —— 这是「新增端点没进矩阵」的护栏。
AI_PATHS: set[tuple[str, str]] = {
    ("POST", "/api/ideas/brainstorm"),
    ("POST", "/api/ideas/{}/review"),
    ("POST", "/api/literature/keywords"),
    ("POST", "/api/literature/{}/digest"),
    ("POST", "/api/experiments/{}/analysis"),
    ("POST", "/api/experiments/{}/failures"),
    ("POST", "/api/experiments/{}/design-review"),
    ("POST", "/api/experiments/compare"),
    ("POST", "/api/paper/stages/{}/unblock"),
    ("POST", "/api/paper/stages/{}/diagnose"),
    ("POST", "/api/paper/sections/{}/outline"),
    ("GET", "/api/plan/biweekly"),
    ("POST", "/api/advisor/draft"),
    ("POST", "/api/advisor/extract"),
    ("POST", "/api/chat/sessions/{}/messages"),
    ("POST", "/api/chat/quick"),
    ("POST", "/api/chat/sessions/{}/messages/stream"),
    ("POST", "/api/rchat/sessions/{}/chat"),
    ("POST", "/api/rchat/sessions/{}/chat/stream"),
    ("POST", "/api/canvas/skills/{}/run"),
    ("POST", "/api/canvas/auto"),
    ("POST", "/api/canvas/{}/chat"),
    ("POST", "/api/canvas/{}/run"),
    ("POST", "/api/settings/llm/test"),
    ("POST", "/api/settings/llm/models"),
}

# 不进 CASES、由专门测试覆盖的端点（SSE / settings / 画布后台 run）
_EXTRA_COVERED: set[tuple[str, str]] = {
    ("POST", "/api/chat/sessions/{}/messages/stream"),
    ("POST", "/api/rchat/sessions/{}/chat/stream"),
    ("POST", "/api/canvas/{}/run"),
    ("POST", "/api/settings/llm/test"),
    ("POST", "/api/settings/llm/models"),
}

# 专门测试里显式断言过调用记录的 task（不在 CASES.expect_task 中的那些）
_SPECIAL_TASKS: set[str] = {
    "rchat:qgen", "rchat:deep", "canvas:custom", "chat", "rchat:auto",
}


def _router_sources() -> list[tuple[pathlib.Path, str]]:
    router_dir = pathlib.Path(__file__).resolve().parents[1] / "routers"
    return [(f, f.read_text(encoding="utf-8")) for f in sorted(router_dir.glob("*.py"))]


def test_matrix_covers_every_llm_endpoint_and_task():
    """I1：三条护栏，替代原来只比对 router 文件名的弱自检。

    1. 源码里出现的每个静态 task= 字面量都必须被某个测试显式声明（端点级调用点）；
    2. 盘点出的每个 AI 端点都必须出现在覆盖集合里；
    3. 覆盖集合里每个 URL 都必须是源码里真实存在的端点（防止 URL 拼错还自以为覆盖）。
    """
    declared: set[str] = set(_SPECIAL_TASKS)
    for c in CASES:
        if c.expect_task:
            declared.update(
                (c.expect_task,) if isinstance(c.expect_task, str) else c.expect_task
            )

    src_tasks: set[str] = set()
    real_endpoints: set[tuple[str, str]] = set()
    for _f, text in _router_sources():
        src_tasks.update(re.findall(r"""task\s*=\s*["']([^"']+)["']""", text))
        m = re.search(r"""APIRouter\(prefix=["']([^"']+)["']""", text)
        prefix = m.group(1) if m else ""
        for mm in re.finditer(
            r"""@router\.(get|post|patch|put|delete)\(\s*["']([^"']+)["']""", text
        ):
            real_endpoints.add((mm.group(1).upper(), _norm_path(prefix + mm.group(2))))

    assert src_tasks <= declared, (
        f"有 LLM 调用点的 task 没有被任何测试声明：{sorted(src_tasks - declared)}"
    )

    covered = {(c.method, _norm_path(c.url)) for c in CASES} | _EXTRA_COVERED
    assert AI_PATHS <= covered, f"有 AI 端点未被覆盖：{sorted(AI_PATHS - covered)}"
    assert covered <= real_endpoints, (
        f"覆盖集合里有源码中不存在的端点（URL 写错了？）：{sorted(covered - real_endpoints)}"
    )


def test_every_router_with_llm_calls_has_a_covered_endpoint():
    """保留文件级兜底：凡是出现 llm. 调用的 router，至少要有一个端点进了矩阵。"""
    covered_files = {c.key.split(".")[0] for c in CASES} | {"settings", "canvas", "rchat", "chat"}
    callers = {
        f.stem
        for f, text in _router_sources()
        if re.search(r"llm\.(complete|chat|stream|test_connection|list_models)", text)
    }
    assert callers <= covered_files, f"有 LLM 调用点未被测试矩阵覆盖：{sorted(callers - covered_files)}"


# ---------------------------------------------------------------- 补充边界


def test_reason_empty_output_degrades_to_fast(monkeypatch):
    """P0 自愈：推理模型把输出预算全花在 CoT 上时，翻倍预算后降级到 fast。

    当前全站 FORCE_FAST=True，这条分支是休眠的；这里临时关掉开关验证
    逻辑本身没坏，将来恢复「按任务分派 fast/reason」时不用重写测试。
    """
    cfg = llm_config.load_config()
    cfg["providers"] = [{
        "id": "fake", "name": "fake", "type": "openai", "base_url": "http://x/v1",
        "api_key": "k", "model_fast": "fast-model", "model_reason": "reason-model",
        "routing": "all", "enabled": True,
    }]
    cfg["default_provider"] = "fake"
    llm_config.save_config(cfg)
    monkeypatch.setattr(llm, "FORCE_FAST", False)

    calls: list[tuple[str, int]] = []

    async def fake_dispatch(p, messages, mode, max_tokens, temperature):
        calls.append((mode, max_tokens))
        if mode == "reason":
            raise llm.LLMError(
                "empty_output", "模型未输出任何内容",
                "finish_reason=length completion_tokens=8192 reasoning_tokens=8192",
            )
        return OK, 1, 2

    monkeypatch.setattr(llm, "_dispatch", fake_dispatch)
    env = _run(llm.complete_result("x", mode="reason", task="pytest"))
    assert env["ok"] is True
    assert env["degraded"] is True, "降级过必须打标记"
    assert env["model"] == "fast-model", "模型名要如实反映降级结果"
    assert calls[0][0] == "reason" and calls[0][1] >= 8192, "reason 档 max_tokens 含 CoT，不能低于 8192"
    assert any(m == "fast" for m, _ in calls), "最终必须退到 fast 模型拿到结果"


def test_brainstorm_falls_back_to_markdown_when_json_unparseable(client, monkeypatch):
    """JSON 解析失败不算成功，但 brainstorm 仍要退回 Markdown 给可用文本。"""
    async def fake_cr(prompt=None, **kw):
        return _ok_env("这不是合法 JSON")

    monkeypatch.setattr(llm, "complete_result", fake_cr)
    r = client.post("/api/ideas/brainstorm", json={"direction": "CFD", "count": 2})
    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert j["ok"] is True and j["source"] == "markdown"
    assert "这不是合法 JSON" in j["result"]


def test_digest_falls_back_to_markdown_when_json_shape_is_wrong(client, monkeypatch):
    """合法 JSON 但缺 sections 时，digest 再调一次 LLM 走 Markdown 兜底并落库。"""
    lid = client.post("/api/literature", json={"title": "某篇论文"}).json()["id"]

    async def fake_cjr(prompt=None, **kw):
        return {"unexpected": 1}, _ok_env('{"unexpected": 1}')

    async def fake_cr(prompt=None, **kw):
        return _ok_env("## 方法核心\n" + OK)

    monkeypatch.setattr(llm, "complete_json_result", fake_cjr)
    monkeypatch.setattr(llm, "complete_result", fake_cr)
    r = client.post(f"/api/literature/{lid}/digest", json={})
    assert r.status_code == 200, r.text[:300]
    j = r.json()
    assert j["ok"] is True
    assert any(OK in (s.get("content") or "") for s in j["sections"])
    assert query("SELECT * FROM lit_notes WHERE literature_id=?", (lid,))
