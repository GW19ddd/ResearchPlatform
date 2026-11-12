"""会员套餐目录 + 支付 Provider 抽象。

设计取舍：
- 套餐是「配置」不是「数据库行」：两档（free / pro）写死在这里，前端 / 后端都从 /api/billing/plans 取，
  改价、改权益只动这一处，不用迁库。
- 支付做成可插拔 Provider：manual 是本地演示支付（不依赖任何密钥即可把下单→支付→升级跑通）；
  stripe / wechat / alipay 是真实网关的占位，接好密钥 + webhook 即可上线。
- 价格走人民币（regional conventions）：月付 ¥39，年付 ¥390（约 ¥32.5/月，省 17%）。
"""
from __future__ import annotations

CURRENCY = "CNY"
CURRENCY_SYMBOL = "¥"

PLAN_IDS = ["free", "pro"]


def _plan(
    id: str,
    name: str,
    price_monthly: int,
    price_annual: int,
    tagline: str,
    features: list[str],
    ai_credits_monthly,
    advanced_models: bool,
    unlimited_canvas: bool,
    priority_support: bool,
    highlight: bool = False,
) -> dict:
    return {
        "id": id,
        "name": name,
        "price_monthly": price_monthly,
        "price_annual": price_annual,
        "tagline": tagline,
        "features": features,
        "ai_credits_monthly": ai_credits_monthly,  # None = 不限量
        "advanced_models": advanced_models,
        "unlimited_canvas": unlimited_canvas,
        "priority_support": priority_support,
        "highlight": highlight,
    }


# 权益以「用户能直接看懂的短句」表达，前端直接渲染，不在此处夹杂业务逻辑。
PLANS: dict[str, dict] = {
    "free": _plan(
        id="free",
        name="免费版",
        price_monthly=0,
        price_annual=0,
        tagline="个人科研起步，核心功能免费体验",
        features=[
            "完整研究流水线：文献 · 实验 · 论文 · 编排画布",
            "每月 200 次 AI 调用额度",
            "标准模型（DeepSeek / 本地 Qwen 等）",
            "单画布 ≤ 30 节点",
            "文献库 / 论文速递 / 社区只读",
            "本机存储与本地备份",
        ],
        ai_credits_monthly=200,
        advanced_models=False,
        unlimited_canvas=False,
        priority_support=False,
    ),
    "pro": _plan(
        id="pro",
        name="Pro 版",
        price_monthly=39,
        price_annual=390,
        tagline="面向重度科研用户：无限额度 + 高级模型 + 优先支持",
        features=[
            "无限 AI 调用额度",
            "高级推理模型（更强长文 / 推理能力）",
            "无限画布节点 + 高级画布模板",
            "批量导出 / 云端备份（架构预留）",
            "优先支持 & 新功能抢先体验",
            "社区发帖与课题协作",
        ],
        ai_credits_monthly=None,
        advanced_models=True,
        unlimited_canvas=True,
        priority_support=True,
        highlight=True,
    ),
}


def price_of(plan_id: str, cycle: str) -> int:
    p = PLANS.get(plan_id)
    if not p:
        raise ValueError("未知套餐")
    return p["price_annual"] if cycle == "annual" else p["price_monthly"]


def months_of(cycle: str) -> int:
    return 12 if cycle == "annual" else 1


# ---------------------------------------------------------------- 支付 Provider 抽象

def _env(name: str) -> str | None:
    import os

    v = (os.environ.get(name) or "").strip()
    return v or None


class PaymentProvider:
    """真实网关的统一接口；manual 是演示实现，hosted 是待接密钥的占位。"""

    key: str = ""
    name: str = ""
    desc: str = ""
    kind: str = "manual"  # manual=本地演示；hosted=跳转第三方收银台

    def enabled(self) -> bool:
        return True

    def checkout(self, order: dict) -> dict:
        """返回给前端的下单结果：{order_id, pay_url, manual}。"""
        raise NotImplementedError


class ManualProvider(PaymentProvider):
    key = "manual"
    name = "本地模拟支付（演示）"
    desc = "无需任何密钥即可跑通「下单 → 支付 → 升级」完整链路，便于本地联调与演示。"
    kind = "manual"

    def checkout(self, order: dict) -> dict:
        return {"order_id": order["order_id"], "pay_url": None, "manual": True}


class HostedProvider(PaymentProvider):
    """Stripe / 微信 / 支付宝 的统一占位。

    接线上时只替换 `enabled()`（读对应密钥环境变量）与 `checkout()`（调网关创建收银台会话，
    返回真实 pay_url），并接好 /api/billing/webhook 校验回调即可，业务其余部分不用动。
    """

    kind: str = "hosted"  # 跳转第三方收银台
    env_key: str = ""

    def enabled(self) -> bool:
        return self.env_key != "" and _env(self.env_key) is not None

    def checkout(self, order: dict) -> dict:
        if not self.enabled():
            raise RuntimeError(f"尚未配置 {self.name} 的支付密钥（{self.env_key}）")
        # TODO(支付上线): 调用网关 SDK 创建收银台会话，返回真实 pay_url
        return {"order_id": order["order_id"], "pay_url": None, "manual": False}


class StripeProvider(HostedProvider):
    key = "stripe"
    name = "Stripe"
    desc = "国际信用卡 / 外币结算，适合海外用户。"
    env_key = "STRIPE_SECRET_KEY"


class WechatProvider(HostedProvider):
    key = "wechat"
    name = "微信支付"
    desc = "国内主流移动端支付。"
    env_key = "WECHAT_PAY_MCH_KEY"


class AlipayProvider(HostedProvider):
    key = "alipay"
    name = "支付宝"
    desc = "国内主流扫码 / 网页支付。"
    env_key = "ALIPAY_APP_PRIVATE_KEY"


PROVIDERS: list[PaymentProvider] = [
    ManualProvider(),
    StripeProvider(),
    WechatProvider(),
    AlipayProvider(),
]


def get_provider(key: str) -> PaymentProvider:
    for p in PROVIDERS:
        if p.key == key:
            return p
    raise ValueError("未知支付方式")


def provider_meta() -> list[dict]:
    return [
        {
            "key": p.key,
            "name": p.name,
            "desc": p.desc,
            "kind": p.kind,
            "enabled": p.enabled(),
        }
        for p in PROVIDERS
    ]
