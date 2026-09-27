"""积分核心：加减分、周净分保护下限、规则读写。"""
import pytest

import points_core as pc
from db import execute, now


def _ledger_sum():
    from db import query

    return int(query("SELECT COALESCE(SUM(delta),0) s FROM points_ledger")[0]["s"])


def test_balance_and_award():
    pc.award(100, "测试加分")
    assert _ledger_sum() == 100
    assert pc.balance() == 100


def test_negative_clamped_by_weekly_floor():
    """周净分下限 = -100：一次性扣 500 只能扣到 -100。"""
    pc.set_rule("weekly_net_floor", -100)
    r = pc.award(-500, "超量扣分")
    assert r["clamped"] is True
    assert pc.balance() == -100
    assert pc.week_net() == -100


def test_negative_never_becomes_positive_even_when_already_below_floor():
    """已低于下限时再扣分，不得反向加分（历史上会算出正 delta）。"""
    pc.set_rule("weekly_net_floor", -100)
    execute(
        "INSERT INTO points_ledger (delta, reason, created_at) VALUES (?,?,?)",
        (-300, "历史欠账", now()),
    )
    assert pc.week_net() == -300
    r = pc.award(-50, "再扣一笔")
    assert r["applied"] <= 0, f"扣分被算成了加分：{r}"
    assert _ledger_sum() == -300, "已低于下限，不应再写入任何流水"


def test_positive_award_not_affected_by_floor():
    pc.set_rule("weekly_net_floor", -100)
    pc.award(-500, "先打到下限")
    pc.award(80, "之后正常加分")
    assert pc.balance() == -20


def test_zero_delta_not_recorded():
    r = pc.award(0, "空操作")
    assert r["applied"] == 0
    assert _ledger_sum() == 0


def test_rules_roundtrip():
    pc.set_rule("task_done", 42)
    assert pc.get_rules()["task_done"] == 42
    pc.set_rule("rule:task_done", 10)
    assert pc.get_rules()["task_done"] == 10


def test_week_start_is_monday():
    import datetime

    d = datetime.date(2026, 9, 22)  # 周二
    assert pc._week_start(d) == "2026-09-21"
