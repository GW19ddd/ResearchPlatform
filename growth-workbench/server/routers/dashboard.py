"""首页看板与数据导出。"""
from datetime import date, datetime, timedelta

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from config import EXPORT_DIR
from db import query
from points_core import balance, get_rules, week_net

router = APIRouter(prefix="/api", tags=["dashboard"])


def _count(sql: str) -> int:
    rows = query(sql)
    return int(rows[0]["c"]) if rows else 0


def _days_since(ts: str | None) -> int:
    if not ts:
        return 0
    try:
        d = datetime.fromisoformat(ts)
    except ValueError:
        return 0
    return (datetime.now() - d).days


@router.get("/dashboard")
def dashboard():
    since = (date.today() - timedelta(days=14)).isoformat()
    today = date.today().isoformat()

    stages = query("SELECT * FROM paper_stages ORDER BY sort_order, id")
    blocked = [dict(s, stuck_days=_days_since(s.get("updated_at"))) for s in stages if s["status"] == "blocked"]
    current = blocked[0] if blocked else next(
        (dict(s, stuck_days=0) for s in stages if s["status"] == "doing"), None
    )

    sections = query("SELECT * FROM paper_sections")
    words = sum(s["word_count"] or 0 for s in sections)
    target = sum(s["target_words"] or 0 for s in sections)

    checkins = query(
        "SELECT * FROM daily_checkins WHERE date >= ? ORDER BY date", (since,)
    )
    open_notes = query("SELECT * FROM advisor_notes WHERE status='open'")
    overdue = [n for n in open_notes if n.get("due_date") and n["due_date"] < today]

    idea_stats = {
        r["status"]: r["c"]
        for r in query("SELECT status, COUNT(*) c FROM ideas GROUP BY status")
    }
    lit_stats = {
        r["status"]: r["c"]
        for r in query("SELECT status, COUNT(*) c FROM literature GROUP BY status")
    }
    exp_stats = {
        r["status"]: r["c"]
        for r in query("SELECT status, COUNT(*) c FROM experiments GROUP BY status")
    }

    return {
        "points": {
            "balance": balance(),
            "week_net": week_net(),
            "floor": int(get_rules().get("weekly_net_floor", -100)),
        },
        "paper": {
            "current": current,
            "blocked": blocked,
            "progress": round(len([s for s in stages if s["status"] == "done"]) / len(stages) * 100)
            if stages
            else 0,
            "words": words,
            "target_words": target,
            "word_progress": round(words / target * 100) if target else 0,
        },
        "ideas": idea_stats,
        "literature": lit_stats,
        "experiments": exp_stats,
        "checkin_today": bool(query("SELECT id FROM daily_checkins WHERE date=?", (today,))),
        "checkins": checkins,
        "commitments": {"open": len(open_notes), "overdue": len(overdue), "items": overdue},
        "open_bets": _count("SELECT COUNT(*) c FROM bets WHERE status='open'"),
        "open_tasks": _count("SELECT COUNT(*) c FROM tasks WHERE status='todo'"),
    }


@router.get("/export/all", response_class=PlainTextResponse)
def export_all():
    """把全库导成一份 Markdown，用于备份或交给 LLM 做长上下文分析。"""
    out = ["# 科研工作台全量导出\n", f"\n导出时间：{date.today().isoformat()}\n"]

    def dump(title: str, sql: str, fields: list[str]):
        rows = query(sql)
        out.append(f"\n## {title}（{len(rows)} 条）\n")
        if not rows:
            out.append("\n（无）\n")
            return
        out.append("\n| " + " | ".join(fields) + " |")
        out.append("\n|" + "|".join(["---"] * len(fields)) + "|")
        for r in rows:
            out.append(
                "\n| " + " | ".join(str(r.get(f) or "").replace("\n", " ") for f in fields) + " |"
            )
        out.append("\n")

    dump("创新点", "SELECT * FROM ideas ORDER BY id DESC", ["id", "title", "status", "novelty", "feasibility", "impact"])
    dump("文献", "SELECT * FROM literature ORDER BY id DESC", ["id", "title", "year", "venue", "status"])
    dump("实验", "SELECT * FROM experiments ORDER BY id DESC", ["id", "name", "status", "hypothesis"])
    dump("论文阶段", "SELECT * FROM paper_stages ORDER BY sort_order", ["name", "status", "blocker", "next_action"])
    dump("论文章节", "SELECT * FROM paper_sections ORDER BY sort_order", ["name", "word_count", "target_words", "status"])
    dump("导师承诺", "SELECT * FROM advisor_notes ORDER BY id DESC", ["date", "scene", "my_commitment", "due_date", "status"])
    dump("积分流水", "SELECT * FROM points_ledger ORDER BY id DESC LIMIT 200", ["created_at", "delta", "reason"])

    text = "".join(out)
    path = EXPORT_DIR / f"workbench-{date.today().isoformat()}.md"
    path.write_text(text, encoding="utf-8")
    return text
