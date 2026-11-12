"""Consensus.app 设置与检索端点。

- GET  /api/consensus        设置页读取（脱敏 key + 状态）
- PUT  /api/consensus        保存 API key（空串=保持原值）
- DELETE /api/consensus      清除 key
- POST /api/consensus/test   用一次小检索探活
- POST /api/consensus/search 真实共识检索，返回归一化论文列表（/consensus 页与 /research 智能体共用）
- POST /api/consensus/summarize 论文列表 → LLM 逐篇判立场 → 支持/反对百分比 + 一句话总结（/consensus 页底部卡片）
"""
import os

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import consensus as cs
import llm

router = APIRouter(prefix="/api/consensus", tags=["consensus"])

HINT_NO_KEY = cs.HINT_NO_KEY


def _mask_key(k: str) -> str:
    if not k:
        return ""
    return k[:4] + "…" + k[-4:] if len(k) > 10 else "已配置"


def _state() -> dict:
    s = cs.snapshot()
    s["key_masked"] = _mask_key(cs.api_key())
    return s


@router.get("")
def get_consensus():
    """只回脱敏 key + 状态，明文密钥不出现在响应里。"""
    return _state()


class ConsensusKeyIn(BaseModel):
    api_key: str = ""


@router.put("")
def put_consensus(body: ConsensusKeyIn):
    """空串视为「保持原值」，清空请走 DELETE。"""
    k = body.api_key.strip()
    if not k:
        return _state()
    if cs.looks_like_url(k):
        raise HTTPException(
            400,
            "这看起来是一个网址，不是 API key（key 形如 2a3b… 的随机串）。"
            "请到 consensus.app → 头像 → API & MCP Dashboard → Keys and Clients 生成后粘贴。",
        )
    cs.save_key(k)
    return _state()


@router.delete("")
def clear_consensus():
    cs.save_key("")
    return _state()


@router.post("/test")
async def test_consensus():
    """用一次小检索（page_size=3）探活，顺带验证 key 是否生效。"""
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            out = await cs.search(client, "does creatine improve cognition", page_size=3, cache=False)
        return {
            "ok": True,
            "message": f"Consensus 可达，返回 {len(out['results'])} 篇",
            **_state(),
        }
    except cs.ConsensusError as e:
        return {"ok": False, "message": e.message, "hint": e.hint or HINT_NO_KEY, **_state()}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"{type(e).__name__}: {e}", **_state()}


class ConsensusSearchIn(BaseModel):
    query: str
    page_size: int = 10
    year_min: int | None = None
    year_max: int | None = None
    study_types: str | None = None
    include_full_text_chunks: bool = False


@router.post("/search")
async def search_consensus(body: ConsensusSearchIn):
    """真实共识检索：返回归一化论文列表。

    调用方：① 独立 /consensus 页；② /research 调研智能体的「共识检索」方法。
    """
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(400, "query 不能为空")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            out = await cs.search(
                client,
                q,
                page_size=body.page_size,
                year_min=body.year_min,
                year_max=body.year_max,
                study_types=body.study_types,
                include_full_text_chunks=body.include_full_text_chunks,
            )
        return out
    except cs.ConsensusError as e:
        msg = e.message + ((" · " + e.hint) if e.hint else "")
        raise HTTPException(502, msg) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"{type(e).__name__}: {e}") from e


# ---------------------------------------------------------------- 共识度总结

_STANCES = ("support", "mixed", "oppose", "unclear")


def _llm_err(env: dict) -> str:
    e = env.get("error")
    if isinstance(e, dict):
        return e.get("label") or e.get("message") or "LLM 调用失败"
    return str(e or "LLM 调用失败")


class ConsensusSumIn(BaseModel):
    query: str
    papers: list[dict] = []


@router.post("/summarize")
async def summarize_consensus(body: ConsensusSumIn):
    """检索完的论文喂给 LLM 逐篇判定立场，服务端汇总成支持/反对百分比。

    百分比由服务端算（不信模型算术）；失败回 {ok: False}，前端静默降级不渲染卡片。
    """
    q = (body.query or "").strip()
    papers = [
        p
        for p in (body.papers or [])
        if isinstance(p, dict) and ((p.get("takeaway") or p.get("abstract") or "").strip() or p.get("title"))
    ]
    if not q or not papers:
        raise HTTPException(400, "query 与 papers 不能为空")

    lines = []
    for i, p in enumerate(papers[:20]):
        ev = ((p.get("takeaway") or "") or (p.get("abstract") or "")).strip()
        if len(ev) > 500:
            ev = ev[:500] + "…"
        head = f"{i + 1}. {p.get('title') or '（无标题）'}"
        if p.get("study_type"):
            head += f"（{p['study_type']}）"
        lines.append(head + (f"｜{ev}" if ev else ""))

    prompt = (
        f"研究问题：{q}\n\n"
        f"以下是检索到的 {len(lines)} 篇同行评审论文（编号. 标题（研究类型）｜结论或摘要）：\n"
        + "\n".join(lines)
        + "\n\n"
        "请逐篇判断每篇论文相对该研究问题的立场，只能依据给出的结论/摘要文本：\n"
        "- support：证据明确支持该观点\n"
        "- oppose：证据反对该观点\n"
        "- mixed：有条件支持 / 结论暧昧 / 只部分支持\n"
        "- unclear：文本不足以判断\n\n"
        "同时给一句 1-2 句的中文总结：证据总体倾向、样本量或研究类型上的分歧点。\n"
        '只输出合法 JSON：{"stances": ["support|oppose|mixed|unclear", ...数量必须等于论文数], "summary": "…"}'
    )
    data, env = await llm.complete_json_result(prompt, mode="fast", task="consensus-meter", max_tokens=1024)
    if data is None:
        return {"ok": False, "error": _llm_err(env), "model": env.get("model", "")}

    raw = data.get("stances") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return {"ok": False, "error": "LLM 未返回逐篇立场", "model": env.get("model", "")}
    stances = []
    for s in raw[: len(papers)]:
        stances.append(s if s in _STANCES else "unclear")
    while len(stances) < len(papers[:20]):
        stances.append("unclear")

    n = len(stances)
    counts = {s: stances.count(s) for s in _STANCES}
    percents = {s: round(c * 100 / n) for s, c in counts.items()}
    return {
        "ok": True,
        "stances": stances,
        "counts": counts,
        "percents": percents,
        "total": n,
        "summary": (data.get("summary") or "").strip(),
        "model": env.get("model", ""),
    }
