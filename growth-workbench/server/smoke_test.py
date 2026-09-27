"""冒烟测试：用 TestClient 跑一遍主要接口，不依赖真实网络。"""
import io
import sys
import traceback

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
from db import init_db  # noqa: E402

init_db()
client = TestClient(main.app)
ok, fail = [], []


def check(name, method, path, body=None, expect=200):
    try:
        if method == "GET":
            r = client.get(path)
        elif method == "POST":
            r = client.post(path, json=body or {})
        elif method == "PATCH":
            r = client.patch(path, json=body or {})
        elif method == "PUT":
            r = client.put(path, json=body or {})
        else:
            r = client.delete(path)
        if r.status_code != expect:
            fail.append(f"{name}: HTTP {r.status_code} {r.text[:200]}")
        else:
            ok.append(f"{name}: {r.status_code}")
        return r
    except Exception as exc:
        fail.append(f"{name}: EXC {type(exc).__name__} {exc}")
        traceback.print_exc()
        return None


check("root", "GET", "/")

# 创新点
r = check("create idea", "POST", "/api/ideas", {"title": "测试创新点", "novelty": 4})
idea_id = r.json()["id"] if r else None
check("list ideas", "GET", "/api/ideas")
if idea_id:
    check("patch idea", "PATCH", f"/api/ideas/{idea_id}", {"status": "validated"})

# 文献
r = check("create lit", "POST", "/api/literature", {"title": "测试论文", "year": 2025})
lit_id = r.json()["id"] if r else None
check("list lit", "GET", "/api/literature")
if lit_id:
    check("patch lit", "PATCH", f"/api/literature/{lit_id}", {"status": "done"})
check("add dim", "POST", "/api/literature/matrix/dimension", {"dim_name": "是否开源"})
check("matrix", "GET", "/api/literature/matrix")
if lit_id:
    check("set cell", "POST", "/api/literature/matrix", {"literature_id": lit_id, "dim_name": "是否开源", "dim_value": "是"})

# 实验
r = check("create exp", "POST", "/api/experiments", {"name": "测试实验", "hypothesis": "X 优于 Y"})
exp_id = r.json()["id"] if r else None
if exp_id:
    check("add result", "POST", f"/api/experiments/{exp_id}/results", {"case_name": "F1", "method": "Rule-based", "success": 1, "metrics_json": '{"acc":0.6}'})
    check("list results", "GET", f"/api/experiments/{exp_id}/results")
    check("patch exp", "PATCH", f"/api/experiments/{exp_id}", {"status": "done"})

# 论文
check("paper overview", "GET", "/api/paper/overview")
check("stages", "GET", "/api/paper/stages")
check("sections", "GET", "/api/paper/sections")

# 计划
check("current week", "GET", "/api/plan/current")
check("upsert week", "POST", "/api/plan/week", {"outcomes": ["完成 F2 数据整理", "写完 Related Work"]})
r = check("add task", "POST", "/api/plan/tasks", {"title": "整理表格", "points": 10})
task_id = r.json()["id"] if r else None
if task_id:
    check("done task", "PATCH", f"/api/plan/tasks/{task_id}", {"status": "done"})
check("checkin", "POST", "/api/plan/checkin", {"sleep_h": 7, "exercise_min": 30, "focus_min": 240, "mood": 4})
check("list checkins", "GET", "/api/plan/checkins")
check("review", "POST", "/api/plan/review", {"done": ["完成 F2 数据整理"], "missed": [], "blockers": "无", "self_score": 4})

# 导师
r = check("advisor note", "POST", "/api/advisor/notes", {"scene": "组会", "my_commitment": "补一组消融实验", "due_date": "2026-09-25"})
check("advisor notes", "GET", "/api/advisor/notes")
check("advisor pending", "GET", "/api/advisor/pending")

# 积分
check("points summary", "GET", "/api/points/summary")
check("rewards", "GET", "/api/points/rewards")
check("create bet", "POST", "/api/points/bets", {"title": "测试押注", "amount": 50})
check("list bets", "GET", "/api/points/bets")
check("rules", "GET", "/api/points/rules")

# 设置：LLM provider
check("llm config", "GET", "/api/settings/llm")
r = check("add provider", "POST", "/api/settings/llm/providers", {
    "name": "测试端点", "type": "openai", "base_url": "http://127.0.0.1:9/v1",
    "api_key": "", "model_fast": "x", "model_reason": "x", "routing": "all", "enabled": False,
})
pid = (r.json().get("provider") or {}).get("id") if r else None
check("test conn (不可达也应返回 200)", "POST", "/api/settings/llm/test", {
    "name": "测试端点", "type": "openai", "base_url": "http://127.0.0.1:9/v1",
    "api_key": "", "model_fast": "x", "model_reason": "x", "routing": "all", "enabled": True,
})
check("models (不可达也应返回 200)", "POST", "/api/settings/llm/models", {
    "name": "测试端点", "type": "openai", "base_url": "http://127.0.0.1:9/v1", "api_key": "",
})
if pid:
    check("set default", "POST", f"/api/settings/llm/providers/{pid}/default")
    check("del provider", "DELETE", f"/api/settings/llm/providers/{pid}")
check("llm usage", "GET", "/api/settings/llm/usage")

# 科研画布
check("canvas skills", "GET", "/api/canvas/skills")
check("canvas list", "GET", "/api/canvas")
check("canvas templates", "GET", "/api/canvas/templates")
r = check("canvas create(topic tpl)", "POST", "/api/canvas", {"name": "冒烟画布", "template": "topic"})
cid = r.json()["id"] if r else None
if cid:
    d = check("canvas get", "GET", f"/api/canvas/{cid}")
    if d:
        body = d.json()
        assert len(body["nodes"]) >= 5, f"模板节点数不足: {len(body['nodes'])}"
        ok.append(f"canvas template nodes: {len(body['nodes'])}")
        assert len(body["edges"]) >= 4, "模板连线数不足"
        ok.append(f"canvas template edges: {len(body['edges'])}")
    check("canvas save", "POST", f"/api/canvas/{cid}/save", {
        "name": "冒烟画布改名",
        "nodes": [
            {"node_key": "a", "type": "input", "title": "输入", "x": 0, "y": 0, "config": {"text": "OpenFOAM LLM 智能体"}},
            {"node_key": "b", "type": "skill", "skill_id": "academic-research-suite", "title": "框架", "x": 300, "y": 0, "config": {"inputs": {"constraint": "1 个月"}}},
            {"node_key": "c", "type": "tool", "title": "Dify", "x": 600, "y": 0, "config": {"tool": "dify", "base_url": "", "inputs": {}}},
            {"node_key": "d", "type": "output", "title": "输出", "x": 900, "y": 0, "config": {}},
        ],
        "edges": [
            {"source_key": "a", "target_key": "b"},
            {"source_key": "b", "target_key": "c"},
            {"source_key": "c", "target_key": "d"},
        ],
    })
    rr = check("canvas run(offline)", "POST", f"/api/canvas/{cid}/run", {})
    if rr:
        res = rr.json().get("results") or []
        ok.append(f"canvas run outputs: {len(res)}")
        texts = {x["node_key"]: (x["output"] or "") for x in res}
        if texts.get("a") != "OpenFOAM LLM 智能体":
            fail.append("input 节点未按原文透传")
        else:
            ok.append("input 节点透传正常")
        if "Dify" not in texts.get("c", "") and "[Dify 节点未配置]" not in texts.get("c", ""):
            fail.append(f"dify 节点降级异常: {texts.get('c','')[:80]}")
        else:
            ok.append("dify 未配置时降级正常")
        if texts.get("d", "") == "（上游无输出）":
            fail.append("output 节点未汇总上游")
        else:
            ok.append("output 节点汇总正常")
    check("canvas runs", "GET", f"/api/canvas/{cid}/runs")
    check("canvas save output", "POST", f"/api/canvas/{cid}/output/save", {"node_key": "d", "target": "idea"})
    check("canvas delete", "DELETE", f"/api/canvas/{cid}")

# Dify 设置
check("dify config", "GET", "/api/settings/dify")
check("dify test (地址可达/不可达都返回 200)", "POST", "/api/settings/dify/test", {"base_url": "http://127.0.0.1:9/v1"})
r = check("dify add app", "POST", "/api/settings/dify/apps", {"name": "冒烟应用", "api_key": "app-test", "mode": "workflow"})
aid = (r.json().get("app") or {}).get("id") if r else None
r = check("dify put", "PUT", "/api/settings/dify", {"enabled": True, "base_url": "http://127.0.0.1:9/v1", "apps": []})
if r:
    cfg = r.json()
    if cfg.get("base_url") != "http://127.0.0.1:9/v1":
        fail.append("dify put: base_url 未生效")
    else:
        ok.append("dify put: base_url 生效")
if aid:
    check("dify del app", "DELETE", f"/api/settings/dify/apps/{aid}")

# Dashboard / 导出
check("dashboard", "GET", "/api/dashboard")
check("export", "GET", "/api/export/all")

# LLM 离线降级（不联网，应返回占位文本）
r = check("biweekly(offline)", "GET", "/api/plan/biweekly")
if r:
    txt = r.json().get("result", "")
    markers = ["DEEPSEEK_API_KEY", "LLM", "未填 API Key", "没有可用的", "调用失败"]
    if not any(m in txt for m in markers):
        fail.append("biweekly: 未走降级分支，可能真的联网了")
    else:
        ok.append("biweekly: 离线降级正常")

print("\n=== PASS ===")
print("\n".join(ok))
print(f"\n=== FAIL ({len(fail)}) ===")
print("\n".join(fail) if fail else "无")
