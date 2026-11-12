"""会员 / 支付路由。

链路：
  GET  /api/billing/plans    → 前端渲染定价页（两档 + 支付方式）
  GET  /api/billing/state    → 当前用户会员状态（套餐 / 额度 / Pro 特性开关）
  POST /api/billing/checkout → 下单，返回支付入口（manual 走演示，hosted 返回收银台 URL）
  POST /api/billing/confirm  → 演示支付：标记已付并升级（manual 用，无需真网关）
  POST /api/billing/cancel   → 退回免费版
  POST /api/billing/webhook  → 真实网关回调入口（Stripe / 微信 / 支付宝），校验签名后升级
"""
from __future__ import annotations

import hashlib
import json

from fastapi import APIRouter, HTTPException, Request

import auth as auth_core
import billing as billing_core
import plans as plans_catalog

router = APIRouter(prefix="/api/billing", tags=["billing"])

# 演示用的 webhook 签名密钥；真实环境应走各网关自带的签名校验（见 webhook 注释）。
_DEMO_WEBHOOK_SECRET = "wb-demo-billing-secret"


def _uid(request: Request) -> int:
    token = request.cookies.get(auth_core.SESSION_COOKIE)
    user = auth_core.resolve_session(token)
    if not user:
        raise HTTPException(401, "请先登录")
    return int(user["id"])


@router.get("/plans")
def get_plans():
    return {
        "plans": [plans_catalog.PLANS[p] for p in plans_catalog.PLAN_IDS],
        "currency": plans_catalog.CURRENCY,
        "currency_symbol": plans_catalog.CURRENCY_SYMBOL,
        "providers": plans_catalog.provider_meta(),
    }


@router.get("/state")
def get_state(request: Request):
    return billing_core.compute_state(_uid(request))


class CheckoutBody:
    def __init__(self, **kwargs):
        self.cycle = (kwargs.get("cycle") or "monthly") if isinstance(kwargs, dict) else "monthly"
        self.provider = (kwargs.get("provider") or "manual") if isinstance(kwargs, dict) else "manual"


@router.post("/checkout")
def checkout(body: dict, request: Request):
    uid = _uid(request)
    cycle = body.get("cycle") or "monthly"
    provider_key = body.get("provider") or "manual"
    if cycle not in ("monthly", "annual"):
        raise HTTPException(400, "cycle 只能是 monthly / annual")

    provider = plans_catalog.get_provider(provider_key)
    if not provider.enabled():
        raise HTTPException(400, f"{provider.name} 尚未配置支付密钥，暂不可用（演示请选「本地模拟支付」）")

    order = billing_core.create_order(uid, "pro", cycle, provider.key)
    try:
        pay = provider.checkout(order)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    return {
        "order_id": pay["order_id"],
        "pay_url": pay.get("pay_url"),
        "manual": pay.get("manual", False),
        "provider": provider.key,
        "provider_name": provider.name,
        "amount": order["amount"],
        "currency": order["currency"],
        "cycle": cycle,
    }


@router.post("/confirm")
def confirm(body: dict, request: Request):
    """演示支付确认：把订单标为已付并升级。

    仅 manual 演示流程使用。真实网关请走 /webhook，不要在前端直接 confirm。
    """
    uid = _uid(request)
    order_id = (body.get("order_id") or "").strip()
    order = billing_core.get_order(order_id)
    if not order:
        raise HTTPException(404, "订单不存在")
    if int(order["user_id"]) != uid:
        raise HTTPException(403, "无权操作该订单")
    if order["status"] != "paid":
        billing_core.mark_order_paid(order_id)
    state = billing_core.apply_plan_from_order(order_id)
    return {"ok": True, "state": state}


@router.post("/cancel")
def cancel(request: Request):
    uid = _uid(request)
    billing_core.set_plan(uid, "free", None, None, 0)
    return {"ok": True, "state": billing_core.compute_state(uid)}


@router.post("/webhook")
async def webhook(request: Request):
    """真实网关回调入口（Stripe / 微信 / 支付宝）。

    演示实现仅校验一个 demo 签名头，便于本地联调；上线时替换为对应网关的
    验签逻辑（Stripe 用 whsec、微信用平台证书、支付宝用公钥），从 body 解析出
    order_id 后标记已付并升级即可，业务其余部分不变。
    """
    raw = await request.body()
    sign = request.headers.get("x-wb-pay-sign") or request.headers.get("x-pay-sign") or ""
    expected = hashlib.sha256(raw + _DEMO_WEBHOOK_SECRET.encode()).hexdigest()
    if not sign or not secrets_compare(sign, expected):
        raise HTTPException(401, "签名校验失败")
    try:
        payload = json.loads(raw or b"{}")
    except Exception:
        raise HTTPException(400, "无效的回调体")
    order_id = (payload.get("order_id") or "").strip()
    order = billing_core.get_order(order_id)
    if not order:
        raise HTTPException(404, "订单不存在")
    if order["status"] != "paid":
        billing_core.mark_order_paid(order_id)
        billing_core.apply_plan_from_order(order_id)
    return {"ok": True, "order_id": order_id}


def secrets_compare(a: str, b: str) -> bool:
    return hashlib.compare_digest(a, b)
