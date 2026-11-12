"""Consensus.app 访问层：统一 API key、结果缓存与限流兜底。

为什么要有这一层（2026-11 实测 api.consensus.app/v1/search）：

Consensus 是同行评审文献的「共识检索」引擎，自带 AI takeaway（论文结论摘要）。
调用方式：

    GET https://api.consensus.app/v1/search
    header: x-api-key: <YOUR_API_KEY>
    params: query(必填), year_min, year_max, study_types, page_size, ...

额度（官方文档，2026-11）：
    - Free：每次最多 10 篇，每月 30 次调用；
    - Pro/Deep/Teams：每次最多 300/750/300 篇，takeaway / study_type / 全文摘录等字段才返回。
    - ⚠️ 2026-11-12 实测：无 key 请求一律 HTTP 401 "Not authenticated"，
      官方已收回「无 key 也返回 3 篇」的匿名模式，key 是硬门槛。
密钥免费申请：consensus.app → 头像 → API & MCP Dashboard → Keys and Clients → New key。
也可设环境变量 CONSENSUS_API_KEY（优先于设置里保存的值）。

本模块做三件事：
1. api_key()   —— 环境变量优先，否则读 settings 表里的 consensus_api_key；
2. search()    —— 发一次 GET，归一化结果，带 15 分钟内存缓存（重复检索不重复计费）；
3. 失败        —— 抛 ConsensusError，带人话提示（无效 key / 额度 / 限流），而不是裸状态码。
"""
from __future__ import annotations

import os
import time

import httpx

from db import execute, query

BASE = "https://api.consensus.app/v1/search"
SETTINGS_KEY = "consensus_api_key"

CACHE_TTL = 900  # 秒；同一查询 15 分钟内不再打 Consensus
CACHE_MAX = 200

_cache: dict[str, tuple[float, dict]] = {}
_last_err: dict = {"message": "", "code": "", "at": 0}

HINT_NO_KEY = (
    "Consensus 现在要求鉴权：无 key 的请求一律 401，检索不出结果。"
    "免费申请一支 key（每次 10 篇、每月 30 次调用）："
    "https://consensus.app → 头像 → API & MCP Dashboard。"
)

SIGNUP_URL = "https://consensus.app/app/dashboard/api"


def looks_like_url(k: str) -> bool:
    """拦截「把网址当 key 粘进去」的低级失误（2026-11-12 实测发生过）。"""
    s = (k or "").strip().lower()
    return s.startswith(("http://", "https://", "ftp://")) or s.startswith("localhost")


class ConsensusError(RuntimeError):
    """Consensus 侧的失败。message 直接给人看，hint 是补充说明。"""

    def __init__(
        self,
        message: str,
        *,
        code: str = "upstream",
        status: int = 0,
        hint: str = "",
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.hint = hint


# ---------------------------------------------------------------- key 存取


def _stored_key() -> str:
    try:
        rows = query("SELECT value FROM settings WHERE key=?", (SETTINGS_KEY,))
    except Exception:  # 表还没建好时不阻塞检索
        return ""
    return (rows[0]["value"] or "").strip() if rows else ""


def api_key() -> str:
    return os.getenv("CONSENSUS_API_KEY", "").strip() or _stored_key()


def save_key(key: str) -> str:
    k = (key or "").strip()
    rows = query("SELECT key FROM settings WHERE key=?", (SETTINGS_KEY,))
    if rows:
        execute("UPDATE settings SET value=? WHERE key=?", (k, SETTINGS_KEY))
    else:
        execute("INSERT INTO settings (key, value) VALUES (?,?)", (SETTINGS_KEY, k))
    return k


def snapshot() -> dict:
    """最近一次请求看到的状态，供设置页显示。"""
    return {
        "has_key": bool(api_key()),
        "from_env": bool(os.getenv("CONSENSUS_API_KEY", "").strip()),
        "signup_url": SIGNUP_URL,
        "last_err": _last_err.get("message") or "",
        "cache_entries": len(_cache),
    }


# ---------------------------------------------------------------- 归一化


def _norm_paper(p: dict) -> dict:
    """Consensus 原始 result → 站点内统一论文行。只填真实可核验字段，不虚构。"""
    authors = p.get("authors") or []
    if isinstance(authors, list):
        authors = ", ".join(str(a) for a in authors[:6])
    return {
        "title": p.get("title") or "",
        "authors": authors or "佚名",
        "year": p.get("publish_year") or None,
        "journal_name": p.get("journal_name") or "",
        "doi": p.get("doi") or "",
        "url": p.get("url") or "",
        "citation_count": p.get("citation_count") or 0,
        "study_type": p.get("study_type") or "",
        "sample_size": p.get("sample_size") or None,
        "sjr_best_quartile": p.get("sjr_best_quartile") or None,
        "takeaway": p.get("takeaway") or "",
        "abstract": p.get("abstract") or "",
        "full_text_chunks": p.get("full_text_chunks") or [],
        "source": "consensus",
    }


# ---------------------------------------------------------------- 请求


def _cache_key(params: dict) -> str:
    parts = [BASE]
    for k in sorted(params):
        parts.append(f"{k}={params[k]}")
    return "&".join(str(p) for p in parts)


async def search(
    client: httpx.AsyncClient,
    query_text: str,
    *,
    page_size: int = 10,
    year_min: int | None = None,
    year_max: int | None = None,
    study_types: str | None = None,
    include_full_text_chunks: bool = False,
    cache: bool = True,
) -> dict:
    """发一次 Consensus 检索，返回 {results, page, page_size, is_end, next_page}。

    失败抛 ConsensusError。无 key 时最多 3 篇（Consensus 服务端强制），本层不假装能拿更多。
    """
    params: dict = {"query": query_text, "page_size": max(1, min(100, page_size))}
    if year_min is not None:
        params["year_min"] = year_min
    if year_max is not None:
        params["year_max"] = year_max
    if study_types:
        params["study_types"] = study_types
    # 只有带 key 且用户显式要时才请求全文摘录（无 key / Free 会 403 feature_not_allowed）
    if include_full_text_chunks and api_key():
        params["include_full_text_chunks"] = True

    key = _cache_key(params)
    if cache:
        hit = _cache.get(key)
        if hit and (time.time() - hit[0]) < CACHE_TTL:
            return hit[1]

    try:
        r = await client.get(
            BASE,
            params=params,
            headers={
                "x-api-key": api_key(),
                "User-Agent": "growth-workbench/1.0 (+local research workbench)",
                "Accept": "application/json",
            },
            timeout=30.0,
        )
    except httpx.HTTPError as e:
        raise ConsensusError(f"连不上 Consensus：{type(e).__name__}", code="network") from e

    if r.status_code == 401:
        if not api_key():
            _last_err = {"message": "未配置 Consensus API key", "code": "auth", "at": int(time.time())}
            raise ConsensusError(
                "未配置 Consensus API key（Consensus 现在要求鉴权，免费申请见设置页）",
                code="auth",
                status=401,
                hint="到「设置 → 数据源 → Consensus」填一支免费 key，或设环境变量 CONSENSUS_API_KEY；"
                     "填好后下一次检索自动生效。",
            )
        _last_err = {"message": "Consensus API key 无效", "code": "auth", "at": int(time.time())}
        raise ConsensusError(
            "Consensus API key 无效（HTTP 401）",
            code="auth",
            status=401,
            hint="检查设置 → 数据源 → Consensus 里填的 key，或环境变量 CONSENSUS_API_KEY。",
        )
    if r.status_code == 429:
        reset = 0
        for h in ("Retry-After", "X-RateLimit-Reset"):
            v = (r.headers.get(h) or "").strip()
            if v.isdigit():
                reset = int(v)
        _last_err = {"message": "Consensus 限流", "code": "rate_limited", "at": int(time.time())}
        raise ConsensusError(
            f"Consensus 触发限流（HTTP 429），{'约 %d 秒' % reset if reset else '稍后'}后重试",
            code="rate_limited",
            status=429,
            hint="免费档每月 30 次调用、5 次/秒；升级 Pro 档可提额。",
        )
    if r.status_code == 403:
        # 多半是免费档请求了付费字段（feature_not_allowed）
        _last_err = {"message": "Consensus 拒绝（403）", "code": "forbidden", "at": int(time.time())}
        raise ConsensusError(
            "Consensus 返回 403：当前档位不支持该字段（例如无 key / Free 请求了全文摘录）",
            code="forbidden",
            status=403,
            hint="去掉全文摘录选项，或在 Pro 档账号下重试。",
        )
    if r.status_code >= 400:
        _last_err = {"message": f"Consensus 返回 {r.status_code}", "code": "upstream", "at": int(time.time())}
        raise ConsensusError(
            f"Consensus 返回 {r.status_code}",
            code="upstream",
            status=r.status_code,
            hint=(r.text or "")[:200],
        )

    try:
        data = r.json()
    except Exception as e:
        raise ConsensusError(f"Consensus 响应不是合法 JSON：{e}", code="parse") from e

    results = [_norm_paper(p) for p in (data.get("results") or [])]
    out = {
        "results": results,
        "page": data.get("page", 0),
        "page_size": data.get("page_size", len(results)),
        "is_end": data.get("is_end", True),
        "next_page": data.get("next_page"),
        "has_key": bool(api_key()),
        "truncated": (not api_key()) and len(results) >= 3,
    }
    if cache:
        _cache[key] = (time.time(), out)
        if len(_cache) > CACHE_MAX:
            for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:50]:
                _cache.pop(k, None)
    return out
