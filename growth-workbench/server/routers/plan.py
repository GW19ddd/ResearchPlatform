"""计划与复盘：周计划、任务、日打卡、周复盘、双周组会汇总。"""
import json
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import llm
from db import execute, now, query
from points_core import _week_start, award, earn, get_rules

router = APIRouter(prefix="/api/plan", tags=["plan"])


def _get_or_create_week(week_start: str) -> dict:
    rows = query("SELECT * FROM weekly_plans WHERE week_start=?", (week_start,))
    if rows:
        return rows[0]
    pid = execute(
        "INSERT INTO weekly_plans (week_start, outcomes_json, status, created_at) VALUES (?,?,?,?)",
        (week_start, "[]", "active", now()),
    )
    return query("SELECT * FROM weekly_plans WHERE id=?", (pid,))[0]


class WeekIn(BaseModel):
    outcomes: list[str] = []


@router.get("/current")
def current_week():
    plan = _get_or_create_week(_week_start())
    plan = dict(plan)
    plan["outcomes"] = json.loads(plan.get("outcomes_json") or "[]")
    plan["review"] = json.loads(plan.get("review_json") or "null")
    plan["tasks"] = query("SELECT * FROM tasks WHERE plan_id=? ORDER BY id", (plan["id"],))
    return plan


@router.post("/week")
def upsert_week(body: WeekIn):
    week_start = _week_start()
    plan = _get_or_create_week(week_start)
    execute(
        "UPDATE weekly_plans SET outcomes_json=? WHERE id=?",
        (json.dumps(body.outcomes, ensure_ascii=False), plan["id"]),
    )
    return current_week()


class TaskIn(BaseModel):
    title: str
    points: int = 10
    due_date: str | None = None
    plan_id: int | None = None


@router.post("/tasks")
def create_task(body: TaskIn):
    plan_id = body.plan_id or _get_or_create_week(_week_start())["id"]
    tid = execute(
        "INSERT INTO tasks (plan_id, title, status, points, due_date, created_at) VALUES (?,?,?,?,?,?)",
        (plan_id, body.title, "todo", body.points, body.due_date, now()),
    )
    return query("SELECT * FROM tasks WHERE id=?", (tid,))[0]


@router.patch("/tasks/{task_id}")
def update_task(task_id: int, body: dict):
    rows = query("SELECT * FROM tasks WHERE id=?", (task_id,))
    if not rows:
        raise HTTPException(404, "task not found")
    task = rows[0]
    allowed = {"title", "status", "points", "due_date"}
    sets, vals = [], []
    for k, v in body.items():
        if k in allowed:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        raise HTTPException(400, "no valid field")
    vals.append(task_id)
    execute(f"UPDATE tasks SET {','.join(sets)} WHERE id=?", vals)
    row = query("SELECT * FROM tasks WHERE id=?", (task_id,))[0]
    if body.get("status") == "done" and task["status"] != "done":
        award(int(row["points"] or 10), f"完成任务：{row['title']}", "task", task_id)
    return row


@router.delete("/tasks/{task_id}")
def delete_task(task_id: int):
    execute("DELETE FROM tasks WHERE id=?", (task_id,))
    return {"ok": True}


class CheckinIn(BaseModel):
    date: str | None = None
    sleep_h: float | None = None
    exercise_min: int | None = None
    focus_min: int | None = None
    mood: int | None = None
    note: str | None = None


@router.post("/checkin")
def checkin(body: CheckinIn):
    d = body.date or date.today().isoformat()
    existing = query("SELECT id FROM daily_checkins WHERE date=?", (d,))
    if existing:
        execute(
            """UPDATE daily_checkins SET sleep_h=?, exercise_min=?, focus_min=?, mood=?, note=?
               WHERE date=?""",
            (body.sleep_h, body.exercise_min, body.focus_min, body.mood, body.note, d),
        )
        return {"ok": True, "id": existing[0]["id"], "rewarded": False}
    cid = execute(
        """INSERT INTO daily_checkins (date, sleep_h, exercise_min, focus_min, mood, note)
           VALUES (?,?,?,?,?,?)""",
        (d, body.sleep_h, body.exercise_min, body.focus_min, body.mood, body.note),
    )
    earn("daily_checkin", f"日打卡 {d}", "checkin", cid)
    return {"ok": True, "id": cid, "rewarded": True}


@router.get("/checkins")
def list_checkins(days: int = 30):
    since = (date.today() - timedelta(days=days)).isoformat()
    return query(
        "SELECT * FROM daily_checkins WHERE date >= ? ORDER BY date DESC", (since,)
    )


class ReviewIn(BaseModel):
    plan_id: int | None = None
    done: list[str] = []
    missed: list[str] = []
    blockers: str | None = None
    next_min_action: str | None = None
    self_score: int = 3


def _dedup(items: list[str]) -> list[str]:
    """去空白 + 去重，保序。前端整包回传时很容易带上重复项。"""
    out: list[str] = []
    seen: set[str] = set()
    for raw in items or []:
        s = str(raw or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


@router.post("/review")
def submit_review(body: ReviewIn):
    plan_id = body.plan_id or _get_or_create_week(_week_start())["id"]
    plan = query("SELECT * FROM weekly_plans WHERE id=?", (plan_id,))
    if not plan:
        raise HTTPException(404, "plan not found")

    done = _dedup(body.done)
    missed = _dedup(body.missed)
    # 同一条成果只能有一个状态：既要允许改主意，又不能同时存在于两栏。
    # 这里拦截而不是静默修正 —— 静默修正会让用户对「我到底勾了什么」失去判断。
    overlap = [x for x in done if x in set(missed)]
    if overlap:
        preview = "、".join(x[:20] for x in overlap[:3])
        raise HTTPException(
            400,
            f"同一条成果不能同时标记「完成」和「未完成」：{preview}"
            f"{'…' if len(overlap) > 3 else ''}（共 {len(overlap)} 条）",
        )

    # 复盘可以改很多次（补充卡点、改下步动作），但积分只在首次提交时结算，
    # 否则「改一次复盘刷一次分」就成了最快的提分路径。
    first_time = (plan[0].get("status") or "active") != "reviewed"

    payload = {
        "done": done,
        "missed": missed,
        "blockers": body.blockers,
        "next_min_action": body.next_min_action,
        "self_score": body.self_score,
    }
    execute(
        "UPDATE weekly_plans SET review_json=?, status=? WHERE id=?",
        (json.dumps(payload, ensure_ascii=False), "reviewed", plan_id),
    )
    if not first_time:
        return {"ok": True, "rewarded": False, "plan_id": plan_id, "review": payload}

    earn("weekly_review", "完成周复盘", "plan", plan_id)
    done_n = len(done)
    missed_n = len(missed)
    rules = get_rules()
    if done_n:
        award(
            int(rules.get("weekly_outcome_done", 100)) * done_n,
            f"周成果完成 {done_n} 项",
            "plan",
            plan_id,
        )
    if missed_n:
        award(
            int(rules.get("weekly_outcome_missed", -60)) * missed_n,
            f"周成果未完成 {missed_n} 项",
            "plan",
            plan_id,
        )
    return {"ok": True, "rewarded": True, "plan_id": plan_id, "review": payload}


@router.get("/biweekly")
async def biweekly_summary():
    """双周组会汇报材料：汇总近 14 天数据并交给 LLM 成文。

    接口会同时返回 `scope`（统计口径）：数据窗口、窗口覆盖的实际条目数、
    以及「哪些表是全量取最近 N 条」这类例外说明。AI 汇总必须能让人知道
    它到底看了什么范围，否则数字被拿去组会上用就是埋雷。
    """
    since = (date.today() - timedelta(days=14)).isoformat()
    checkins = query("SELECT * FROM daily_checkins WHERE date >= ? ORDER BY date", (since,))
    tasks = query("SELECT * FROM tasks WHERE created_at >= ? ORDER BY id DESC", (since,))
    stages = query("SELECT * FROM paper_stages ORDER BY sort_order, id")
    exps = query("SELECT * FROM experiments ORDER BY id DESC LIMIT 10")
    lit = query("SELECT * FROM literature WHERE status='done' ORDER BY id DESC LIMIT 20")
    ideas = query("SELECT * FROM ideas ORDER BY id DESC LIMIT 20")
    # 承诺按日期过滤而不是取最近 20 条：逾期的老承诺比新承诺更该出现在汇报里
    commits = query("SELECT * FROM advisor_notes WHERE date >= ? ORDER BY due_date, id", (since,))

    def fmt(rows, keys):
        return "\n".join(
            " | ".join(str(r.get(k) or "-") for k in keys) for r in rows
        ) or "（无）"

    prompt = f"""请基于下面这份近两周的真实工作数据，生成一份可以直接带去组会的汇报材料。

【日打卡】日期|睡眠h|运动min|专注min|心情
{fmt(checkins, ['date', 'sleep_h', 'exercise_min', 'focus_min', 'mood'])}

【任务】标题|状态|积分
{fmt(tasks, ['title', 'status', 'points'])}

【论文阶段】阶段|状态|卡点|下一步
{fmt(stages, ['name', 'status', 'blocker', 'next_action'])}

【实验】名称|状态|假设
{fmt(exps, ['name', 'status', 'hypothesis'])}

【已读文献】标题|年份|相关度
{fmt(lit, ['title', 'year', 'relevance'])}

【创新点】标题|状态
{fmt(ideas, ['title', 'status'])}

【对导师的承诺】日期|承诺|截止|状态
{fmt(commits, ['date', 'my_commitment', 'due_date', 'status'])}

输出结构：
## 一、这两周做了什么（分条，只写有据可查的事）
## 二、没做成什么 + 原因（诚实，不要粉饰）
## 三、当前卡点与需要的帮助（写清楚需要导师给什么：方向/资源/决策）
## 四、未来两周计划（3-5 条，每条可验证）
## 五、给导师的一句话开场白

要求：具体、有数字、不空话。数据缺失的地方直接写"未记录"。"""
    env = await llm.complete_result(prompt, mode="reason", task="biweekly", max_tokens=4096)
    scope = {
        "since": since,
        "until": date.today().isoformat(),
        "window_days": 14,
        "counts": {
            "checkins": len(checkins),
            "tasks": len(tasks),
            "stages": len(stages),
            "experiments": len(exps),
            "literature_done": len(lit),
            "ideas": len(ideas),
            "commitments": len(commits),
        },
        "notes": [
            f"窗口：{since} 起共 14 天（按创建/记录日期筛）",
            "论文阶段是全量，不受窗口限制",
            "实验 / 已读文献 / 创新点取最近 10 / 20 / 20 条，可能包含更早记录",
        ],
    }
    if not env["ok"]:
        return {"ok": False, "result": "", "since": since, "scope": scope, "error": env["error"]}
    return {
        "ok": True,
        "result": env["content"],
        "since": since,
        "scope": scope,
        "error": None,
        "provider": env["provider"],
        "model": env["model"],
        "tokens_in": env["tokens_in"],
        "tokens_out": env["tokens_out"],
    }
