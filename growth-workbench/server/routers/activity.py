"""活跃度统计：给首页热力图用的按天聚合数据。

不额外记流水，直接扫各业务表里已有的时间戳，按「条目 + 日期」去重，
避免同一条记录被反复编辑后把当天热度刷高。
"""
from datetime import date, timedelta

from fastapi import APIRouter

from db import query

router = APIRouter(prefix="/api", tags=["activity"])

# (分类名, SQL) —— SQL 必须选出 id / ts / ts2 / label 四列
QUERIES: list[tuple[str, str]] = [
    ("文献", "SELECT id, created_at ts, updated_at ts2, title label FROM literature"),
    ("创新点", "SELECT id, created_at ts, updated_at ts2, title label FROM ideas"),
    ("实验", "SELECT id, created_at ts, updated_at ts2, name label FROM experiments"),
    ("笔记", "SELECT id, created_at ts, updated_at ts2, section label FROM lit_notes"),
    ("画布", "SELECT id, created_at ts, NULL ts2, node_key label FROM canvas_node_outputs"),
    ("对话", "SELECT id, created_at ts, NULL ts2, substr(content, 1, 40) label FROM chat_messages"),
    ("积分", "SELECT id, created_at ts, NULL ts2, reason label FROM points_ledger"),
    ("组会", "SELECT id, date ts, NULL ts2, scene label FROM advisor_notes"),
]


def _day(ts: str | None) -> str | None:
    if not ts:
        return None
    s = str(ts).strip()
    if not s:
        return None
    # daily_checkins.date 是 'YYYY-MM-DD'，其它表是 ISO datetime
    return s[:10]


def _collect(days: int) -> dict[str, dict]:
    start = (date.today() - timedelta(days=days - 1)).isoformat()
    today = date.today().isoformat()
    buckets: dict[str, dict] = {}

    def bump(d: str | None, kind: str, label: str, seen: set):
        if not d or d < start or d > today:
            return
        key = (kind, d, label)
        if key in seen:
            return
        seen.add(key)
        b = buckets.setdefault(d, {"date": d, "total": 0, "kinds": {}, "labels": []})
        b["total"] += 1
        b["kinds"][kind] = b["kinds"].get(kind, 0) + 1
        if label and len(b["labels"]) < 6:
            b["labels"].append(f"{kind}·{label}")

    for kind, sql in QUERIES:
        try:
            rows = query(sql)
        except Exception:
            continue  # 表还没建 / 老库缺列就跳过这一类
        seen: set = set()
        for r in rows:
            bump(_day(r.get("ts")), kind, str(r.get("label") or ""), seen)
            bump(_day(r.get("ts2")), kind, str(r.get("label") or ""), seen)

    # 打卡单独算：它只有日期，没有时间戳
    try:
        seen = set()
        for r in query("SELECT id, date ts, NULL ts2, note label FROM daily_checkins"):
            bump(_day(r.get("ts")), "打卡", "每日打卡", seen)
    except Exception:
        pass

    return buckets


def _streaks(buckets: dict[str, dict]) -> tuple[int, int, int]:
    """返回 (当前连续天数, 最长连续天数, 有活动的总天数)。"""
    active = {d for d, b in buckets.items() if b["total"] > 0}
    if not active:
        return 0, 0, 0

    # 当前连续：从今天（若今天没动则从昨天）往前数
    today = date.today()
    cursor = today if today.isoformat() in active else today - timedelta(days=1)
    cur = 0
    while cursor.isoformat() in active:
        cur += 1
        cursor -= timedelta(days=1)

    best = run = 0
    prev: date | None = None
    for dstr in sorted(active):
        d = date.fromisoformat(dstr)
        run = run + 1 if prev and (d - prev).days == 1 else 1
        best = max(best, run)
        prev = d
    return cur, best, len(active)


@router.get("/activity/heatmap")
def heatmap(days: int = 365):
    days = max(28, min(730, int(days or 365)))
    buckets = _collect(days)
    cur, best, active_days = _streaks(buckets)

    start = date.today() - timedelta(days=days - 1)
    # 对齐到周日，跟 GitHub 一样让每周从周日开始
    start = start - timedelta(days=(start.weekday() + 1) % 7)
    series = []
    cursor = start
    today = date.today()
    while cursor <= today:
        d = cursor.isoformat()
        b = buckets.get(d)
        series.append(
            {
                "date": d,
                "count": b["total"] if b else 0,
                "kinds": b["kinds"] if b else {},
                "labels": b["labels"] if b else [],
            }
        )
        cursor += timedelta(days=1)

    return {
        "days": series,
        "start": series[0]["date"],
        "end": today.isoformat(),
        "total": sum(x["count"] for x in series),
        "active_days": active_days,
        "streak": cur,
        "best_streak": best,
        "max": max((x["count"] for x in series), default=0),
    }
