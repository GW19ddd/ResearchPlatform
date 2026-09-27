"""科研画布：模板、拓扑执行、离线降级、输出落库。"""
import pytest

from db import query
from helpers import outputs_of, run_canvas


def _mk_canvas(client, name="测试画布"):
    return client.post("/api/canvas", json={"name": name, "template": "topic"}).json()["id"]


def test_template_canvas_has_nodes_edges(client):
    cid = _mk_canvas(client)
    body = client.get(f"/api/canvas/{cid}").json()
    assert len(body["nodes"]) >= 5
    assert len(body["edges"]) >= 4
    assert client.get("/api/canvas/templates").json()["templates"]


def test_topo_order_respects_edges(client):
    from routers.canvas import _topo

    nodes = [{"node_key": k} for k in ("a", "b", "c")]
    edges = [
        {"source_key": "a", "target_key": "b"},
        {"source_key": "b", "target_key": "c"},
    ]
    assert [n["node_key"] for n in _topo(nodes, edges)] == ["a", "b", "c"]


def test_topo_cycle_does_not_drop_nodes(client):
    from routers.canvas import _topo

    nodes = [{"node_key": k} for k in ("a", "b")]
    edges = [
        {"source_key": "a", "target_key": "b"},
        {"source_key": "b", "target_key": "a"},
    ]
    assert len(_topo(nodes, edges)) == 2


def test_run_offline_input_passthrough_and_output_merge(client):
    cid = client.post("/api/canvas", json={"name": "离线跑"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "离线跑",
            "nodes": [
                {"node_key": "a", "type": "input", "title": "输入", "x": 0, "y": 0,
                 "config": {"text": "原始文本"}},
                {"node_key": "d", "type": "output", "title": "输出", "x": 300, "y": 0,
                 "config": {"prefix": "## 汇总"}},
            ],
            "edges": [{"source_key": "a", "target_key": "d"}],
        },
    )
    detail = run_canvas(client, cid)
    assert detail["run"]["status"] == "done", detail["run"]
    outs = outputs_of(detail)
    assert outs["a"]["output_text"] == "原始文本"
    assert "原始文本" in outs["d"]["output_text"]
    assert "## 汇总" in outs["d"]["output_text"]
    assert query("SELECT * FROM canvas_node_outputs")


def test_unknown_skill_degrades(client):
    cid = client.post("/api/canvas", json={"name": "未知技能"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "未知技能",
            "nodes": [
                {"node_key": "s", "type": "skill", "skill_id": "no-such-skill", "title": "X",
                 "x": 0, "y": 0, "config": {}},
            ],
            "edges": [],
        },
    )
    detail = run_canvas(client, cid)
    assert detail["run"]["status"] == "failed", detail["run"]
    outs = outputs_of(detail)
    assert outs["s"]["ok"] is False
    assert "未找到 skill" in (outs["s"]["error"] or {}).get("message", "")
    assert outs["s"]["output_text"] == "", "失败节点不应保存任何输出文本"


def test_save_output_to_idea(client):
    cid = client.post("/api/canvas", json={"name": "落库"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "落库",
            "nodes": [{"node_key": "d", "type": "output", "title": "输出", "x": 0, "y": 0,
                       "config": {}}],
            "edges": [],
        },
    )
    # 先造一条上游输出，避免 output 节点为空
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "落库",
            "nodes": [
                {"node_key": "a", "type": "input", "title": "输入", "x": 0, "y": 0,
                 "config": {"text": "要存进 Ideas 的内容"}},
                {"node_key": "d", "type": "output", "title": "输出", "x": 300, "y": 0, "config": {}},
            ],
            "edges": [{"source_key": "a", "target_key": "d"}],
        },
    )
    run_canvas(client, cid)
    r = client.post(f"/api/canvas/{cid}/output/save", json={"node_key": "d", "target": "idea"})
    assert r.status_code == 200, r.text
    assert r.json()["target"] == "idea"
    row = query("SELECT * FROM ideas ORDER BY id DESC LIMIT 1")[0]
    assert "要存进 Ideas 的内容" in (row["notes"] or "")


def test_save_output_to_paper_targets_current_stage(client):
    """产出应写进「当前进行中」的阶段，而不是无脑写第一个阶段的 blocker。"""
    stages = client.get("/api/paper/stages").json()
    doing = stages[-1]
    for s in stages:
        client.patch(f"/api/paper/stages/{s['id']}", json={"status": "done"})
    client.patch(f"/api/paper/stages/{doing['id']}", json={"status": "doing"})

    cid = client.post("/api/canvas", json={"name": "到论文"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "到论文",
            "nodes": [
                {"node_key": "a", "type": "input", "title": "输入", "x": 0, "y": 0,
                 "config": {"text": "产出内容 P"}},
                {"node_key": "d", "type": "output", "title": "输出", "x": 300, "y": 0, "config": {}},
            ],
            "edges": [{"source_key": "a", "target_key": "d"}],
        },
    )
    run_canvas(client, cid)
    r = client.post(f"/api/canvas/{cid}/output/save", json={"node_key": "d", "target": "paper"})
    assert r.status_code == 200, r.text
    row = query("SELECT * FROM paper_stages WHERE id=?", (doing["id"],))[0]
    assert "产出内容 P" in ((row["next_action"] or "") + (row["blocker"] or "")), \
        f"产出没落到当前阶段：{dict(row)}"


def test_save_output_missing_run_404(client):
    cid = client.post("/api/canvas", json={"name": "空跑"}).json()["id"]
    r = client.post(f"/api/canvas/{cid}/output/save", json={"node_key": "nope", "target": "idea"})
    assert r.status_code == 404


def test_canvas_delete_cascades(client):
    cid = _mk_canvas(client)
    run_canvas(client, cid)
    client.delete(f"/api/canvas/{cid}")
    assert query("SELECT * FROM canvases WHERE id=?", (cid,)) == []
    assert query("SELECT * FROM canvas_nodes WHERE canvas_id=?", (cid,)) == []
    assert query("SELECT * FROM canvas_edges WHERE canvas_id=?", (cid,)) == []
    assert query("SELECT * FROM canvas_runs WHERE canvas_id=?", (cid,)) == []
    assert query("SELECT * FROM canvas_node_outputs") == []


def test_missing_canvas_404(client):
    assert client.get("/api/canvas/999999").status_code == 404


def test_skills_and_openapi(client):
    s = client.get("/api/canvas/skills").json()
    assert s["skills"], "技能库为空"
    oa = client.get("/api/canvas/dify/openapi").json()
    assert oa["openapi"].startswith("3.")
    assert oa["paths"], "OpenAPI 未导出任何 skill"


def test_skill_run_unknown_404(client):
    assert client.post("/api/canvas/skills/no-such/run", json={}).status_code == 404


# ---------------------------------------------------------------- 自定义节点


def _save_prompt_canvas(client, cid, *, prompt, text="", system=""):
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "自定义节点",
            "nodes": [
                {"node_key": "a", "type": "input", "title": "原始素材", "x": 0, "y": 0,
                 "config": {"text": "上游文本-进度三条"}},
                {"node_key": "p", "type": "prompt", "title": "我的指令", "x": 300, "y": 0,
                 "config": {"prompt": prompt, "text": text, "system": system,
                            "mode": "reason", "max_ctx": 4000}},
                {"node_key": "d", "type": "output", "title": "汇总", "x": 600, "y": 0,
                 "config": {}},
            ],
            "edges": [
                {"source_key": "a", "target_key": "p"},
                {"source_key": "p", "target_key": "d"},
            ],
        },
    )


def test_prompt_node_injects_upstream_and_records_meta(client, monkeypatch):
    """自定义节点：{{upstream}} / {{input}} 都要被替换，元信息（provider/model/token）要落库。"""
    import llm as llm_mod

    seen: dict = {}

    async def fake(prompt, **kw):
        seen.update(prompt=prompt, system=kw.get("system"), mode=kw.get("mode"))
        return {
            "ok": True,
            "content": "整理完成：3 条结论",
            "provider": "fake-provider",
            "model": "fake-model",
            "tokens_in": 11,
            "tokens_out": 5,
        }

    monkeypatch.setattr(llm_mod, "complete_result", fake)

    cid = client.post("/api/canvas", json={"name": "自定义节点"}).json()["id"]
    _save_prompt_canvas(
        client,
        cid,
        prompt="把下面的进展整理成 3 条结论：\n\n{{upstream}}\n\n额外要求：{{input}}",
        text="要面向导师",
        system="你是严格的审稿人",
    )

    detail = run_canvas(client, cid)
    outs = outputs_of(detail)
    assert outs["p"]["output_text"] == "整理完成：3 条结论"
    assert "整理完成：3 条结论" in outs["d"]["output_text"], "输出节点应汇总自定义节点的产出"

    assert "上游文本-进度三条" in seen["prompt"], f"{{{{upstream}}}} 没被替换：{seen['prompt']}"
    assert "要面向导师" in seen["prompt"], "{{input}} 没被替换"
    assert "{{" not in seen["prompt"], "还有没被替换的占位符"
    assert seen["system"] == "你是严格的审稿人"
    assert seen["mode"] == "reason", "节点上指定的模式没传下去"

    row = query("SELECT * FROM canvas_node_outputs WHERE node_key='p'")[0]
    assert row["provider"] == "fake-provider"
    assert row["model"] == "fake-model"
    assert (row["tokens_in"], row["tokens_out"]) == (11, 5)


def test_prompt_node_without_instruction_degrades(client, monkeypatch):
    """空指令不该发请求，要给人话提示。"""
    import llm as llm_mod

    async def boom(*a, **kw):
        raise AssertionError("空指令不应调用模型")

    monkeypatch.setattr(llm_mod, "complete_result", boom)

    cid = client.post("/api/canvas", json={"name": "空自定义"}).json()["id"]
    _save_prompt_canvas(client, cid, prompt="   ")
    detail = run_canvas(client, cid)
    outs = outputs_of(detail)
    assert outs["p"]["ok"] is False
    assert "指令" in (outs["p"]["error"] or {}).get("message", ""), outs["p"]
    assert outs["p"]["output_text"] == ""


def test_latest_outputs_carry_usage_fields(client):
    """前端要展示 token / 耗时，latest 里必须带这些列。"""
    cid = client.post("/api/canvas", json={"name": "列检查"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "列检查",
            "nodes": [{"node_key": "a", "type": "input", "title": "输入", "x": 0, "y": 0,
                       "config": {"text": "hi"}}],
            "edges": [],
        },
    )
    run_canvas(client, cid)
    latest = client.get(f"/api/canvas/{cid}").json()["latest"]
    assert latest and {"tokens_in", "tokens_out", "elapsed_ms", "provider", "ok"} <= set(latest[0])


# ---------------------------------------------------------------- 模板


def test_builtin_templates_listed(client):
    tpls = client.get("/api/canvas/templates").json()["templates"]
    keys = {t["key"] for t in tpls}
    assert {"topic", "write", "slides"} <= keys
    assert all(t["builtin"] is True for t in tpls)


def test_save_canvas_as_template_and_reuse(client):
    """创作者搭好的流水线要能冻结成模板，再用它一键新建出同样一张画布。"""
    cid = client.post("/api/canvas", json={"name": "我的流水线"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "我的流水线",
            "nodes": [
                {"node_key": "a", "type": "input", "title": "素材", "x": 10, "y": 20,
                 "config": {"text": "x"}},
                {"node_key": "p", "type": "prompt", "title": "我的指令", "x": 300, "y": 20,
                 "config": {"prompt": "总结 {{upstream}}"}},
            ],
            "edges": [{"source_key": "a", "target_key": "p"}],
        },
    )

    r = client.post(f"/api/canvas/{cid}/save-as-template", json={"name": "我的模板"})
    assert r.status_code == 200, r.text
    key = r.json()["key"]
    assert r.json()["node_count"] == 2

    tpls = {t["key"]: t for t in client.get("/api/canvas/templates").json()["templates"]}
    assert tpls[key]["name"] == "我的模板"
    assert tpls[key]["builtin"] is False

    new_id = client.post("/api/canvas", json={"name": "", "template": key}).json()["id"]
    body = client.get(f"/api/canvas/{new_id}").json()
    assert {n["node_key"] for n in body["nodes"]} == {"a", "p"}
    prompt_node = next(n for n in body["nodes"] if n["node_key"] == "p")
    assert prompt_node["type"] == "prompt"
    assert prompt_node["config"]["prompt"] == "总结 {{upstream}}", "模板应还原节点配置"
    assert body["edges"][0]["source_key"] == "a"


def test_save_as_template_overwrites_same_name(client):
    """同名再存一次是覆盖，不是堆两份。"""
    cid = client.post("/api/canvas", json={"name": "C"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "C",
            "nodes": [{"node_key": "a", "type": "input", "title": "i", "x": 0, "y": 0, "config": {}}],
            "edges": [],
        },
    )
    k1 = client.post(f"/api/canvas/{cid}/save-as-template", json={"name": "同名"}).json()["key"]
    k2 = client.post(f"/api/canvas/{cid}/save-as-template", json={"name": "同名"}).json()["key"]
    assert k1 == k2
    mine = [
        t
        for t in client.get("/api/canvas/templates").json()["templates"]
        if t["builtin"] is False
    ]
    assert len(mine) == 1


def test_empty_canvas_cannot_be_template(client):
    cid = client.post("/api/canvas", json={"name": "空的"}).json()["id"]
    r = client.post(f"/api/canvas/{cid}/save-as-template", json={"name": "空模板"})
    assert r.status_code == 400


def test_delete_user_template_but_not_builtin(client):
    cid = client.post("/api/canvas", json={"name": "C"}).json()["id"]
    client.post(
        f"/api/canvas/{cid}/save",
        json={
            "name": "C",
            "nodes": [{"node_key": "a", "type": "input", "title": "i", "x": 0, "y": 0, "config": {}}],
            "edges": [],
        },
    )
    key = client.post(f"/api/canvas/{cid}/save-as-template", json={"name": "待删"}).json()["key"]

    assert client.delete(f"/api/canvas/templates/{key}").status_code == 200
    assert client.delete(f"/api/canvas/templates/{key}").status_code == 404
    assert client.delete("/api/canvas/templates/topic").status_code == 404, "内置模板不可删"
    keys = {t["key"] for t in client.get("/api/canvas/templates").json()["templates"]}
    assert "topic" in keys and key not in keys
