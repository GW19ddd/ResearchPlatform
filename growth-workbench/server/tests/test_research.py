"""创新点 / 文献 / 实验三个研究模块的 CRUD、边界值与异常处理。"""
import pytest

from db import query


# ---------------------------- 创新点 ----------------------------


def test_idea_crud(client):
    r = client.post("/api/ideas", json={"title": "想法A", "novelty": 5, "category": "CFD"})
    assert r.status_code == 200, r.text
    iid = r.json()["id"]
    assert r.json()["category"] == "CFD"

    assert client.get("/api/ideas").json()[0]["title"] == "想法A"
    assert len(client.get("/api/ideas", params={"category": "CFD"}).json()) == 1
    assert client.get("/api/ideas", params={"category": "不存在"}).json() == []

    r = client.patch(f"/api/ideas/{iid}", json={"status": "selected", "novelty": 2})
    assert r.json()["status"] == "selected" and r.json()["novelty"] == 2

    assert client.delete(f"/api/ideas/{iid}").json() == {"ok": True}
    assert client.get("/api/ideas").json() == []


def test_idea_requires_title(client):
    assert client.post("/api/ideas", json={}).status_code == 422


def test_idea_scores_outside_1_5_rejected(client):
    """评分超出 1-5 必须被拒，而不是静默改写成 5 或 1 骗过用户。"""
    r = client.post("/api/ideas", json={"title": "越界评分", "novelty": 99, "impact": -3})
    assert r.status_code == 422, f"越界评分被放行了：{r.text}"


def test_patch_score_outside_1_5_rejected(client):
    """局部更新同样要拦 —— 历史上 PATCH 完全不做范围校验。"""
    iid = client.post("/api/ideas", json={"title": "X"}).json()["id"]
    assert client.patch(f"/api/ideas/{iid}", json={"novelty": 99}).status_code == 400
    assert client.patch(f"/api/ideas/{iid}", json={"novelty": 0}).status_code == 400
    assert client.patch(f"/api/ideas/{iid}", json={"novelty": 4}).json()["novelty"] == 4


def test_patch_unknown_field_rejected(client):
    iid = client.post("/api/ideas", json={"title": "X"}).json()["id"]
    r = client.patch(f"/api/ideas/{iid}", json={"password": "1"})
    assert r.status_code == 400


def test_delete_missing_idea_is_404(client):
    assert client.delete("/api/ideas/999999").status_code == 404


def test_validated_idea_awards_points_only_once(client):
    """反复 PATCH 成 validated 不应重复加分。"""
    from points_core import balance

    iid = client.post("/api/ideas", json={"title": "只该加一次"}).json()["id"]
    base = balance()
    client.patch(f"/api/ideas/{iid}", json={"status": "validated"})
    after_first = balance()
    client.patch(f"/api/ideas/{iid}", json={"status": "validated"})
    client.patch(f"/api/ideas/{iid}", json={"status": "validated"})
    assert after_first > base, "首次验证应加分"
    assert balance() == after_first, f"重复验证被重复加分：{after_first} -> {balance()}"


def test_idea_categories_grouping(client):
    client.post("/api/ideas", json={"title": "a", "category": "CFD"})
    client.post("/api/ideas", json={"title": "b", "category": "CFD", "status": "selected"})
    client.post("/api/ideas", json={"title": "c"})
    groups = {g["name"]: g for g in client.get("/api/ideas/categories").json()["groups"]}
    assert groups["CFD"]["count"] == 2
    assert groups["CFD"]["selected"] == 1
    assert groups["未分类"]["count"] == 1
    assert 1 <= groups["CFD"]["avg_score"] <= 5


# ---------------------------- 文献 ----------------------------


def test_literature_crud(client):
    r = client.post("/api/literature", json={"title": "论文A", "year": 2024, "status": "reading"})
    assert r.status_code == 200, r.text
    lid = r.json()["id"]
    assert client.get("/api/literature", params={"status": "reading"}).json()[0]["id"] == lid
    assert client.get("/api/literature", params={"status": "done"}).json() == []
    r = client.patch(f"/api/literature/{lid}", json={"rating": 5})
    assert r.json()["rating"] == 5
    assert client.delete(f"/api/literature/{lid}").json() == {"ok": True}


def test_literature_year_must_be_number(client):
    assert client.post("/api/literature", json={"title": "T", "year": "不是年份"}).status_code == 422


def test_read_done_awards_once(client):
    from points_core import balance

    lid = client.post("/api/literature", json={"title": "读完加分"}).json()["id"]
    base = balance()
    client.patch(f"/api/literature/{lid}", json={"status": "done"})
    first = balance()
    client.patch(f"/api/literature/{lid}", json={"status": "done"})
    assert first > base
    assert balance() == first, "重复标记已读被重复加分"


def test_notes_upsert_by_section(client):
    lid = client.post("/api/literature", json={"title": "带笔记"}).json()["id"]
    client.post(f"/api/literature/{lid}/notes", json={"section": "方法核心", "content": "v1"})
    client.post(f"/api/literature/{lid}/notes", json={"section": "方法核心", "content": "v2"})
    notes = client.get(f"/api/literature/{lid}/notes").json()
    assert len(notes) == 1, f"同名小节应覆盖而不是新增：{len(notes)}"
    assert notes[0]["content"] == "v2"

    nid = notes[0]["id"]
    assert client.patch(f"/api/lit_notes/{nid}", json={"content": "v3"}).json()["content"] == "v3"
    assert client.delete(f"/api/lit_notes/{nid}").json() == {"ok": True}


def test_matrix_dimension_requires_name(client):
    """空维度名不应无条件建出一堆垃圾行。"""
    client.post("/api/literature", json={"title": "M"})
    r = client.post("/api/literature/matrix/dimension", json={"dim_name": "   "})
    assert r.status_code == 400, f"空维度名被接受了：{r.text}"
    assert query("SELECT * FROM lit_matrix") == []


def test_matrix_roundtrip(client):
    lid = client.post("/api/literature", json={"title": "矩阵论文"}).json()["id"]
    assert client.post(
        "/api/literature/matrix/dimension", json={"dim_name": "是否开源"}
    ).status_code == 200
    client.post(
        "/api/literature/matrix",
        json={"literature_id": lid, "dim_name": "是否开源", "dim_value": "是"},
    ).json()
    m = client.get("/api/literature/matrix").json()
    assert m["dimensions"] == ["是否开源"]
    assert m["papers"][0]["cells"]["是否开源"] == "是"

    client.delete("/api/literature/matrix/dimension/是否开源")
    assert client.get("/api/literature/matrix").json()["dimensions"] == []


def test_delete_literature_cascades(client):
    lid = client.post("/api/literature", json={"title": "级联删除"}).json()["id"]
    client.post(f"/api/literature/{lid}/notes", json={"section": "s", "content": "c"})
    client.post(
        "/api/literature/matrix",
        json={"literature_id": lid, "dim_name": "d", "dim_value": "v"},
    )
    client.delete(f"/api/literature/{lid}")
    assert query("SELECT * FROM lit_notes WHERE literature_id=?", (lid,)) == []
    assert query("SELECT * FROM lit_matrix WHERE literature_id=?", (lid,)) == []


# ---------------------------- 实验 ----------------------------


def test_experiment_and_results(client):
    eid = client.post("/api/experiments", json={"name": "E1", "hypothesis": "H"}).json()["id"]
    rid = client.post(
        f"/api/experiments/{eid}/results",
        json={"case_name": "F1", "method": "Rule-based", "success": 1, "metrics_json": '{"acc":0.6}'},
    ).json()["id"]
    rows = client.get(f"/api/experiments/{eid}/results").json()
    assert rows[0]["metrics"] == {"acc": 0.6}
    assert rows[0]["success"] == 1

    assert client.delete(f"/api/results/{rid}").json() == {"ok": True}
    assert client.get(f"/api/experiments/{eid}/results").json() == []


def test_broken_metrics_json_falls_back(client):
    eid = client.post("/api/experiments", json={"name": "E2"}).json()["id"]
    client.post(
        f"/api/experiments/{eid}/results",
        json={"case_name": "bad", "metrics_json": "{not json"},
    )
    assert client.get(f"/api/experiments/{eid}/results").json()[0]["metrics"] == {}


def test_experiment_done_awards_once(client):
    from points_core import balance

    eid = client.post("/api/experiments", json={"name": "只加一次"}).json()["id"]
    base = balance()
    client.patch(f"/api/experiments/{eid}", json={"status": "done"})
    first = balance()
    client.patch(f"/api/experiments/{eid}", json={"status": "done"})
    assert first > base
    assert balance() == first, "重复标记完成被重复加分"


def test_missing_experiment_404(client):
    assert client.patch("/api/experiments/999999", json={"status": "done"}).status_code == 404
