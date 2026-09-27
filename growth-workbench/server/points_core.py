"""积分核心：规则、加减分、余额、周净分保护下限。"""
from datetime import date, timedelta

from config import DEFAULT_RULES
from db import execute, now, query


def _week_start(d: date | None = None) -> str:
    d = d or date.today()
    return (d - timedelta(days=d.weekday())).isoformat()


def get_rules() -> dict:
    rules = dict(DEFAULT_RULES)
    for row in query("SELECT key, value FROM settings WHERE key LIKE 'rule:%'"):
        try:
            rules[row["key"].split(":", 1)[1]] = int(row["value"])
        except (ValueError, IndexError):
            pass
    return rules


def set_rule(key: str, value: int):
    key = key if key.startswith("rule:") else f"rule:{key}"
    execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def balance() -> int:
    rows = query("SELECT COALESCE(SUM(delta), 0) AS b FROM points_ledger")
    return int(rows[0]["b"]) if rows else 0


def week_net(week_start: str | None = None) -> int:
    ws = week_start or _week_start()
    rows = query(
        "SELECT COALESCE(SUM(delta), 0) AS b FROM points_ledger WHERE created_at >= ?",
        (ws,),
    )
    return int(rows[0]["b"]) if rows else 0


def award(delta: int, reason: str, ref_type: str | None = None, ref_id: int | None = None) -> dict:
    """记录一笔积分。负分受周净分下限保护，避免连续挫败导致弃用。"""
    applied = int(delta)
    if delta < 0:
        floor = int(get_rules().get("weekly_net_floor", -100))
        current = week_net()
        if current <= floor:
            # 已经触底：一分都不再扣，也绝不能反向加分
            return {"applied": 0, "reason": reason, "clamped": True}
        # 最多扣到下限为止；min(..., 0) 保证结果恒为负
        applied = min(max(floor - current, delta), 0)
    if applied == 0:
        return {"applied": 0, "reason": reason, "clamped": True}
    execute(
        "INSERT INTO points_ledger (delta, reason, ref_type, ref_id, created_at) VALUES (?,?,?,?,?)",
        (applied, reason, ref_type, ref_id, now()),
    )
    return {"applied": applied, "reason": reason, "clamped": applied != delta}


def earn(rule_key: str, reason: str | None = None, ref_type: str | None = None, ref_id: int | None = None):
    return award(int(get_rules().get(rule_key, 0)), reason or rule_key, ref_type, ref_id)


def earn_on_transition(
    before: dict | None,
    after: dict,
    field: str,
    target: str,
    rule_key: str,
    reason: str,
    ref_type: str | None = None,
    ref_id: int | None = None,
):
    """只在状态真正「变到」target 时才加分。

    前端会把整包字段回传，同一个状态可能被 PATCH 很多次；
    不做这层判断就会变成点一下加一次分。
    """
    if after.get(field) != target:
        return None
    if before is not None and before.get(field) == target:
        return None
    return earn(rule_key, reason, ref_type, ref_id)
