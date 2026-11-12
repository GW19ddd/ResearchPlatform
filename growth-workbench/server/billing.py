"""会员计费：订单、套餐状态、月度额度。

数据都落在 SQLite（同一份库），不引第三方依赖。所有写操作走 db.execute / db.query。
额度口径：以 llm_usage 表当月 AI 调用次数为「AI 调用额度」的计量单位，与设置页的「调用统计」一致。
"""
from __future__ import annotations

import secrets

from db import execute, now, query

import plans as plans_catalog


def get_plan_row(user_id: int) -> dict:
    rows = query("SELECT plan, plan_expires_at, plan_provider, plan_order_id FROM users WHERE id=?", (user_id,))
    return rows[0] if rows else {}


def set_plan(
    user_id: int,
    plan: str,
    provider: str | None = None,
    order_id: str | None = None,
    months: int = 1,
) -> dict:
    from datetime import datetime, timedelta

    if months and plan == "pro":
        expires = (datetime.now() + timedelta(days=30 * months)).isoformat(timespec="seconds")
    else:
        expires = None
    execute(
        "UPDATE users SET plan=?, plan_expires_at=?, plan_provider=?, plan_order_id=? WHERE id=?",
        (plan, expires, provider, order_id, user_id),
    )
    return get_plan_row(user_id)


def ai_credits_used_this_month(user_id: int) -> int:
    """当月 AI 调用次数（llm_usage 表），作为额度计量。

    本机单用户，llm_usage 无 user_id 列；直接按月份聚合全表即可。
    """
    cur = now()[:7]
    rows = query(
        "SELECT COUNT(*) c FROM llm_usage WHERE substr(created_at,1,7)=?",
        (cur,),
    )
    return int(rows[0]["c"]) if rows else 0


def compute_state(user_id: int) -> dict:
    """当前用户的会员状态：套餐、是否 Pro、额度、各 Pro 特性开关。"""
    row = get_plan_row(user_id)
    plan = (row.get("plan") or "free") if row else "free"
    meta = plans_catalog.PLANS.get(plan, plans_catalog.PLANS["free"])
    limit = meta["ai_credits_monthly"]
    used = ai_credits_used_this_month(user_id)
    remaining = None if limit is None else max(0, limit - used)
    return {
        "plan": plan,
        "is_pro": plan == "pro",
        "plan_expires_at": row.get("plan_expires_at") if row else None,
        "plan_provider": row.get("plan_provider") if row else None,
        "ai_credits_limit": limit,
        "ai_credits_used": used,
        "ai_credits_remaining": remaining,
        "features": {
            "advanced-models": bool(meta["advanced_models"]),
            "unlimited-canvas": bool(meta["unlimited_canvas"]),
            "priority-support": bool(meta["priority_support"]),
        },
    }


def create_order(user_id: int, plan_id: str, cycle: str, provider: str) -> dict:
    if plan_id not in plans_catalog.PLANS or plan_id == "free":
        raise ValueError("只能为付费套餐下单")
    amount = plans_catalog.price_of(plan_id, cycle)
    order_id = "ord_" + secrets.token_urlsafe(16)
    created = now()
    # 订单 30 分钟未支付自动过期（演示环境无所谓，真实网关用网关自己的过期）
    from datetime import datetime, timedelta

    expires = (datetime.now() + timedelta(minutes=30)).isoformat(timespec="seconds")
    execute(
        """INSERT INTO billing_orders
           (order_id, user_id, plan, cycle, amount, currency, provider, status, created_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            order_id,
            user_id,
            plan_id,
            cycle,
            amount,
            plans_catalog.CURRENCY,
            provider,
            "pending",
            created,
            expires,
        ),
    )
    return query("SELECT * FROM billing_orders WHERE order_id=?", (order_id,))[0]


def get_order(order_id: str) -> dict | None:
    rows = query("SELECT * FROM billing_orders WHERE order_id=?", (order_id,))
    return rows[0] if rows else None


def mark_order_paid(order_id: str) -> dict:
    execute(
        "UPDATE billing_orders SET status='paid', paid_at=? WHERE order_id=?",
        (now(), order_id),
    )
    return get_order(order_id)


def apply_plan_from_order(order_id: str) -> dict:
    """支付成功后把套餐写进用户表，并返回新的会员状态。"""
    order = get_order(order_id)
    if not order:
        raise ValueError("订单不存在")
    if order["status"] != "paid":
        raise ValueError("订单尚未支付")
    months = plans_catalog.months_of(order["cycle"])
    set_plan(order["user_id"], order["plan"], order["provider"], order_id, months)
    return compute_state(order["user_id"])
