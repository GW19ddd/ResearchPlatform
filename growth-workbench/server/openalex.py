"""OpenAlex 访问层：统一 API key、结果缓存与限流兜底。

为什么要有这一层（2026-11 实测 api.openalex.org）：

OpenAlex 已经改成「按额度计费」的免费池。不带 API key 时，所有请求共享
**出口 IP 那一份**每日免费预算（响应头 X-RateLimit-Limit-USD: 0.1，约 1000
credits），`mailto` 参数**不再**参与提额（meta.notice 原文有说明）。计费口径：

    关键词 / 全文检索（search=…）      10 credits ≈ $0.001
    单条详情（/works/W…）               1 credit
    批量 filter（openalex_id:a|b|…）    1 credit

也就是说不带 key 时每天大约只够 100 次关键词检索，而且同一出口 IP 下的所有人
（含本机反复输入建议词、点「重试」）共担这一笔。额度打空后 OpenAlex 一律回
429，于是检索页就停在「OpenAlex 返回 429，稍后重试」。

带一个免费 API key 后是独立 $1/天（≈10000 credits），且不与别人共享。
申请：POST https://api.openalex.org/api-keys  {"email": "<你收得到信的邮箱>"}
或网页 https://openalex.org/settings/api ，拿到后填到 设置 → 数据源 → OpenAlex，
也可以设环境变量 OPENALEX_API_KEY。

本模块做三件事：
1. identity() —— 有 key 就自动带上，调用方不用各自判断；
2. get()      —— 同一请求 15 分钟内走内存缓存，不重复计费（重试、来回切种子都不花钱）；
3. 429        —— 抛 OAError，带人话的重置时间和提额指引，而不是裸 HTTP 状态码。
"""
from __future__ import annotations

import os
import time

import httpx

from db import execute, query

BASE = "https://api.openalex.org/works"
MAILTO = "workbench@local"
SETTINGS_KEY = "openalex_api_key"

CACHE_TTL = 900  # 秒；同一查询 15 分钟内不再打 OpenAlex
CACHE_MAX = 300

_cache: dict[str, tuple[float, dict]] = {}
_last_quota: dict = {
    "remaining": None,
    "limit": None,
    "remaining_usd": None,
    "reset_in": 0,
    "at": 0,
}

HINT_NO_KEY = (
    "未配置 API key 时，OpenAlex 按出口 IP 共享每天 $0.10（约 100 次关键词检索），"
    "同网络下任何人都在一起花这笔额度。免费申请 key 可独占每天 $1（约 1000 次检索）："
    "https://openalex.org/settings/api ，拿到后填到 设置 → 数据源 → OpenAlex。"
)


class OAError(RuntimeError):
    """OpenAlex 侧的失败。message 直接给人看，hint 是补充说明。"""

    def __init__(
        self,
        message: str,
        *,
        code: str = "upstream",
        status: int = 0,
        reset_in: int = 0,
        hint: str = "",
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.reset_in = reset_in
        self.hint = hint


# ---------------------------------------------------------------- key 存取


def _stored_key() -> str:
    try:
        rows = query("SELECT value FROM settings WHERE key=?", (SETTINGS_KEY,))
    except Exception:  # 表还没建好时不阻塞检索
        return ""
    return (rows[0]["value"] or "").strip() if rows else ""


def api_key() -> str:
    return os.getenv("OPENALEX_API_KEY", "").strip() or _stored_key()


def save_key(key: str) -> str:
    k = (key or "").strip()
    rows = query("SELECT key FROM settings WHERE key=?", (SETTINGS_KEY,))
    if rows:
        execute("UPDATE settings SET value=? WHERE key=?", (k, SETTINGS_KEY))
    else:
        execute("INSERT INTO settings (key, value) VALUES (?,?)", (SETTINGS_KEY, k))
    return k


def identity() -> dict:
    """所有 OpenAlex 请求都该带上的公共参数。"""
    p = {"mailto": MAILTO}
    k = api_key()
    if k:
        p["api_key"] = k
    return p


def snapshot() -> dict:
    """最近一次请求看到的额度（来自响应头），供设置页显示。"""
    out = dict(_last_quota)
    out["has_key"] = bool(api_key())
    out["cache_entries"] = len(_cache)
    return out


# ---------------------------------------------------------------- 请求


def _reset_in(r: httpx.Response) -> int:
    for h in ("Retry-After", "X-RateLimit-Reset"):
        v = (r.headers.get(h) or "").strip()
        if v.isdigit():
            return int(v)
    return 3600


def _human(sec: int) -> str:
    if sec <= 0:
        return "稍后"
    if sec < 120:
        return f"{sec} 秒"
    if sec < 7200:
        return f"约 {max(1, round(sec / 60))} 分钟"
    return f"约 {max(1, round(sec / 3600))} 小时"


def _note_quota(r: httpx.Response) -> None:
    h = r.headers
    if h.get("X-RateLimit-Remaining") is None:
        return
    _last_quota.update(
        remaining=h.get("X-RateLimit-Remaining"),
        limit=h.get("X-RateLimit-Limit"),
        remaining_usd=h.get("X-RateLimit-Remaining-USD"),
        reset_in=_reset_in(r),
        at=int(time.time()),
    )


def _ck(url: str | None, params: dict) -> str:
    parts = [url or BASE]
    for k in sorted(params):
        parts.append(f"{k}={params[k]}")
    return "&".join(str(p) for p in parts)


async def get(
    client: httpx.AsyncClient,
    params: dict | None = None,
    url: str | None = None,
    *,
    cache: bool = True,
    ttl: int = CACHE_TTL,
) -> dict:
    """发一次 OpenAlex GET，返回 JSON。失败抛 OAError。"""
    p = dict(params or {})
    p.update(identity())  # key / mailto 由本层统一补，调用方只管业务参数
    key = _ck(url, p)

    if cache:
        hit = _cache.get(key)
        if hit and (time.time() - hit[0]) < ttl:
            return hit[1]

    try:
        r = await client.get(
            url or BASE,
            params=p,
            headers={"User-Agent": "growth-workbench/1.0 (+local research workbench)"},
        )
    except httpx.HTTPError as e:
        raise OAError(f"连不上 OpenAlex：{type(e).__name__}", code="network") from e

    _note_quota(r)

    if r.status_code == 429:
        reset = _reset_in(r)
        if api_key():
            msg = f"OpenAlex 今日额度已用尽（当前 API key），{_human(reset)}后重置"
            hint = "这支 key 今天的 $1 额度花完了：可以换一支 key，或等重置后再检索。"
        else:
            msg = f"OpenAlex 免费额度已用尽（按出口 IP 共享，每天 $0.10），{_human(reset)}后重置"
            hint = HINT_NO_KEY
        raise OAError(msg, code="rate_limited", status=429, reset_in=reset, hint=hint)

    if r.status_code >= 400:
        raise OAError(
            f"OpenAlex 返回 {r.status_code}",
            code="upstream",
            status=r.status_code,
            hint=(r.text or "")[:200],
        )

    data = r.json()
    if cache:
        _cache[key] = (time.time(), data)
        if len(_cache) > CACHE_MAX:
            for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:50]:
                _cache.pop(k, None)
    return data
