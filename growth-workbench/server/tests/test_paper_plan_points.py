"""论文流水线、计划复盘、导师、积分四块的接口行为。"""
import pytest

from db import query
from points_core import balance, set_rule


# ---------------------------- 论文 ----------------------------


def test_paper_stage_advance_and_stuck_days(client):
    stages = client.get("/api/paper/stages").json()
    assert stages, "种子阶段应存在"
    sid = stages[0]["id"]

    r = client.patch(f"/api/paper/stages/{sid}", json={"status": "doing"})
    assert r.json()["status"] == "doing"
    assert r.json()["stuck_days"] == 0

    r = client.patch(f"/api/paper/stages/{sid}", json={"status": "blocked", "blocker": "没数据"})
    assert r.json()["stuck_days"] >= 0


def test_stage_custom_status_must_not_500(client):
    """阶段状态不在 todo/doing/blocked/done 里时，推进判定不能抛 ValueError。"""
    sid = client.get("/api/paper/stages").json()[0]["id"]
    client.patch(f"/api/paper/stages/{sid}", json={"status": "waiting-review"})
    r = client.patch(f"/api/paper/stages/{sid}", json={"status": "done"})
    assert r.status_code == 200, f"自定义状态导致 500：{r.text}"
    assert r.json()["status"] == "done"


def test_stage_advance_awards_once(client):
    sid = client.get("/api/paper/stages").json()[0]["id"]
    client.patch(f"/api/paper/stages/{sid}", json={"status": "todo"})
    base = balance()
    client.patch(f"/api/paper/stages/{sid}", json={"status": "doing"})
    first = balance()
    client.patch(f"/api/paper/stages/{sid}", json={"status": "doing"})
    assert first > base
    assert balance() == first, "同阶段重复推进被重复加分"


def test_paper_sections_word_progress(client):
    sec = client.get("/api/paper/sections").json()[0]
    client.patch(f"/api/paper/sections/{sec['id']}", json={"word_count": 400})
    ov = client.get("/api/paper/overview").json()
    assert ov["words"] >= 400
    assert 0 <= ov["word_progress"] <= 100
    assert 0 <= ov["progress"] <= 100


def test_paper_section_negative_words_rejected_or_clamped(client):
    sec = client.get("/api/paper/sections").json()[0]
    client.patch(f"/api/paper/sections/{sec['id']}", json={"word_count": -50})
    row = query("SELECT word_count FROM paper_sections WHERE id=?", (sec["id"],))[0]
    assert row["word_count"] >= 0, f"负字数被落库：{row['word_count']}"


def test_missing_stage_404(client):
    assert client.patch("/api/paper/stages/999999", json={"status": "done"}).status_code == 404


# ---------------------------- 计划 / 复盘 ----------------------------


def test_week_plan_and_tasks(client):
    w = client.get("/api/plan/current").json()
    assert w["outcomes"] == []
    assert "tasks" in w

    w = client.post("/api/plan/week", json={"outcomes": ["写完 Method", "跑完 F2"]}).json()
    assert w["outcomes"] == ["写完 Method", "跑完 F2"]

    tid = client.post("/api/plan/tasks", json={"title": "任务1", "points": 15}).json()["id"]
    base = balance()
    client.patch(f"/api/plan/tasks/{tid}", json={"status": "done"})
    assert balance() - base == 15

    # 再点一次完成不应重复加分
    client.patch(f"/api/plan/tasks/{tid}", json={"status": "done"})
    assert balance() - base == 15

    client.delete(f"/api/plan/tasks/{tid}")
    assert client.get("/api/plan/current").json()["tasks"] == []


def test_checkin_upsert_and_no_double_reward(client):
    base = balance()
    r1 = client.post("/api/plan/checkin", json={"sleep_h": 7, "mood": 4}).json()
    assert r1["rewarded"] is True
    first = balance()

    r2 = client.post("/api/plan/checkin", json={"sleep_h": 8, "mood": 5}).json()
    assert r2["rewarded"] is False
    assert balance() == first, "同日重复打卡被重复加分"
    assert len(client.get("/api/plan/checkins").json()) == 1


def test_weekly_review_awards_once(client):
    """同一周反复提交复盘，不应无限刷分。"""
    base = balance()
    client.post("/api/plan/review", json={"done": ["a"], "missed": [], "self_score": 4})
    first = balance()
    client.post("/api/plan/review", json={"done": ["a"], "missed": [], "self_score": 4})
    assert first > base + 0, "首次复盘应加分"
    assert balance() == first, f"重复复盘被重复加分：{first} -> {balance()}"


def test_review_missed_is_negative(client):
    set_rule("weekly_outcome_missed", -60)
    base = balance()
    client.post("/api/plan/review", json={"done": [], "missed": ["x", "y"]})
    assert balance() < base


def test_biweekly_offline_degrades(client):
    """离线时返回失败信封，而不是把错误文案塞进 result 让用户当汇报材料拿去用。"""
    r = client.get("/api/plan/biweekly")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False and body["result"] == ""
    assert body["error"]["kind"] == "no_provider"
    assert body["scope"]["window_days"] == 14, "失败也要给出统计口径，别让人猜范围"
    # 没有 provider 时同样要说明「本来打算统计什么范围」
    assert body["scope"]["since"] == body["since"]


# ---------------------------- 导师 ----------------------------


def test_advisor_pending_overdue_first(client):
    client.post("/api/advisor/notes", json={"my_commitment": "逾期的", "due_date": "2020-01-01"})
    client.post("/api/advisor/notes", json={"my_commitment": "以后的", "due_date": "2099-01-01"})
    rows = client.get("/api/advisor/pending").json()
    assert len(rows) == 2
    assert rows[0]["overdue"] is True
    assert rows[0]["my_commitment"] == "逾期的"


def test_advisor_note_crud(client):
    nid = client.post("/api/advisor/notes", json={"scene": "周报", "my_commitment": "c"}).json()["id"]
    assert client.patch(f"/api/advisor/notes/{nid}", json={"status": "done"}).json()["status"] == "done"
    assert client.get("/api/advisor/pending").json() == []
    client.delete(f"/api/advisor/notes/{nid}")
    assert client.get("/api/advisor/notes").json() == []


def test_advisor_patch_missing_404(client):
    assert client.patch("/api/advisor/notes/999999", json={"status": "done"}).status_code == 404


# ---------------------------- 积分 ----------------------------


def test_rewards_redeem_flow(client):
    from points_core import award

    award(500, "垫高余额")
    rid = client.post("/api/points/rewards", json={"name": "小奖励", "cost": 120}).json()["id"]
    before = balance()
    r = client.post(f"/api/points/rewards/{rid}/redeem")
    assert r.status_code == 200, r.text
    assert balance() == before - 120, "兑换未正确扣减积分"
    assert client.get("/api/points/rewards").json()[0]["redeemed_count"] >= 1


def test_redeem_insufficient_points(client):
    set_rule("weekly_net_floor", -100000)
    rid = client.post("/api/points/rewards", json={"name": "天价", "cost": 999999}).json()["id"]
    r = client.post(f"/api/points/rewards/{rid}/redeem")
    assert r.status_code == 400, r.text
    assert "积分不足" in r.json()["detail"]


def test_reward_cost_must_be_positive(client):
    r = client.post("/api/points/rewards", json={"name": "负价", "cost": -500})
    assert r.status_code == 422, "负成本奖励可被创建，兑换即刷分"


def test_bet_settle(client):
    set_rule("weekly_net_floor", -10000)
    bid = client.post("/api/points/bets", json={"title": "押注", "amount": 100}).json()["id"]
    after_bet = balance()
    client.post(f"/api/points/bets/{bid}/settle", json={"result": "won"})
    assert balance() == after_bet + 200
    assert query("SELECT status FROM bets WHERE id=?", (bid,))[0]["status"] == "won"


def test_bet_bad_result(client):
    bid = client.post("/api/points/bets", json={"title": "B", "amount": 10}).json()["id"]
    assert client.post(f"/api/points/bets/{bid}/settle", json={"result": "maybe"}).status_code == 400


def test_points_summary_shape(client):
    s = client.get("/api/points/summary").json()
    for k in ("balance", "week_net", "rules", "ledger", "trend"):
        assert k in s
    assert isinstance(s["trend"], list)


def test_trend_cumulative_matches_window(client):
    """trend 的 total 应是窗口内逐日累加，最后一天等于窗口内净分。"""
    client.post("/api/plan/checkin", json={"mood": 3})
    s = client.get("/api/points/summary").json()
    trend = s["trend"]
    assert trend, "有流水时 trend 不应为空"
    assert trend[-1]["total"] == sum(x["delta"] for x in trend)
