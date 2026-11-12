"""研究对话（Undermind 式）：左侧对话管理 + 深度文献检索 + 报告撰写 + 文献导入。

会话/消息独立成表（rchat_*），不动已有 /api/chat 的 Quest 流。
- 深度检索是真数据：LLM 生成英文检索式 → OpenAlex /works 搜索 → 命中自动入文献库
  （复用 research.py 的 _find_or_create_lit 去重）→ LLM 汇总成带 [n] 引用的综述。
- 报告撰写把整段会话（含引用）浓缩成结构化 Markdown 报告，前端文档式预览 + 导出。
- 文献导入：粘贴 BibTeX/CSL JSON/RIS（复用 zotero.py 的解析与去重入库），或上传 PDF
  落到 data/uploads 并建文献条目（pdf_path 直通现有 PdfModal 阅读器）。
"""
import asyncio
import json
import re
import time

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import llm
import chat_prefs
from chat_prefs import ChatPrefsIn
from config import DATA_DIR
from db import execute, now, query
from routers.research import _find_or_create_lit, _norm_title, _parse_oa_work
from routers.zotero import _insert_many, _parse_bibtex, _parse_csl, _parse_ris

router = APIRouter(prefix="/api/rchat", tags=["rchat"])

_OA_BASE = "https://api.openalex.org/works"
_OA_MAILTO = "workbench@local"
_UPLOAD_DIR = DATA_DIR / "uploads"


# ---------------------------------------------------------------- 会话管理


def _session(sid: int) -> dict:
    rows = query("SELECT * FROM rchat_sessions WHERE id=?", (sid,))
    if not rows:
        raise HTTPException(404, "会话不存在")
    return rows[0]


def _touch(sid: int):
    execute("UPDATE rchat_sessions SET updated_at=? WHERE id=?", (now(), sid))


@router.get("/sessions")
def list_sessions():
    rows = query(
        """SELECT s.*, (SELECT COUNT(*) FROM rchat_messages m WHERE m.session_id=s.id) AS msg_count
           FROM rchat_sessions s ORDER BY s.updated_at DESC"""
    )
    return {"sessions": rows}


@router.post("/sessions")
def create_session(body: dict | None = None):
    ts = now()
    title = ((body or {}).get("title") or "新对话").strip()[:40] or "新对话"
    sid = execute(
        "INSERT INTO rchat_sessions (title, created_at, updated_at) VALUES (?,?,?)",
        (title, ts, ts),
    )
    return {"id": sid, "title": title}


@router.patch("/sessions/{sid}")
def rename_session(sid: int, body: dict):
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "标题不能为空")
    execute("UPDATE rchat_sessions SET title=?, updated_at=? WHERE id=?", (title[:60], now(), sid))
    return {"ok": True}


@router.delete("/sessions/{sid}")
def delete_session(sid: int):
    _session(sid)
    execute("DELETE FROM rchat_messages WHERE session_id=?", (sid,))
    execute("DELETE FROM rchat_sessions WHERE id=?", (sid,))
    return {"ok": True}


@router.get("/sessions/{sid}")
def get_session(sid: int):
    s = _session(sid)
    msgs = query(
        "SELECT * FROM rchat_messages WHERE session_id=? ORDER BY id ASC", (sid,)
    )
    out = []
    for m in msgs:
        d = dict(m)
        try:
            d["meta"] = json.loads(d.pop("meta") or "{}")
        except ValueError:
            d["meta"] = {}
        out.append(d)
    return {"session": s, "messages": out}


# ---------------------------------------------------------------- 文档（报告沉淀）

@router.get("/documents")
def list_documents():
    """左栏「文档」区：全部 kind=report 的报告消息，标题取 Markdown 首个一级标题。"""
    rows = query(
        "SELECT id, session_id, content, created_at FROM rchat_messages WHERE kind='report' ORDER BY id DESC"
    )
    docs = []
    for r in rows:
        content = r["content"] or ""
        m = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
        stripped = content.strip()
        first_line = stripped.splitlines()[0].lstrip("# ").strip() if stripped else ""
        title = (m.group(1).strip() if m else first_line) or "未命名报告"
        docs.append(
            {
                "id": r["id"],
                "session_id": r["session_id"],
                "title": title[:60],
                "created_at": r["created_at"],
                "content": content,
            }
        )
    return {"documents": docs}


@router.patch("/messages/{mid}")
def edit_report_message(mid: int, body: dict):
    """直接编辑报告文档正文（文档 = kind=report 的消息沉淀）。

    只放行 report：聊天消息的编辑走各模块自己的通道，这里不兜底。
    文档标题取正文首个一级标题，保存后左栏文档列表会随刷新自动更新。
    """
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(400, "内容不能为空")
    row = query("SELECT kind FROM rchat_messages WHERE id=?", (mid,))
    if not row:
        raise HTTPException(404, "文档不存在")
    if row[0]["kind"] != "report":
        raise HTTPException(400, "只支持编辑报告文档")
    execute("UPDATE rchat_messages SET content=? WHERE id=?", (content, mid))
    return {"ok": True}


# ---------------------------------------------------------------- 深度检索 / 对话 / 报告


class ChatIn(ChatPrefsIn):
    instruction: str
    mode: str = "auto"  # auto | deep | report | review
    tag: str | None = None
    # 输入框里挂的技能 chip：本轮注入 system，格式同 /api/chat 的 skill_refs
    skill_refs: list[dict] | None = None
    # 深度检索想保留的文献篇数上限（仅 deep 模式生效；None 走默认 15，合法区间 4–40）
    max_papers: int | None = None
    # review 模式：用户在文献检索栏勾选的 literature.id 列表，只对这些写综述
    lit_ids: list[int] | None = None
    # 深度检索叠加 Consensus.app 共识检索（作为调研方法，把同行评审文献并回引用）
    use_consensus: bool = False


RESEARCH_SYSTEM = (
    "你是「研究对话」副驾，风格像 Undermind：严谨、结构化、结论先行、中文为主可混英文术语。"
    "用户在做 LLM 驱动的软件测试生成研究。回答要直接给观点和依据，不要寒暄；"
    "不确定的事情明说不确定，绝不编造文献、数字或引用。"
)


def _research_system(prefs: dict | None) -> str:
    """本轮 system = 研究副驾 + 对话框偏好 + 挂载技能原文。

    技能解析复用 /api/chat 的 _skill_mounts（只读本机 SKILL.md / 技能注册表，
    路径白名单在那里统一守着），保证 /research 里挂的技能真的生效而不是装饰。
    """
    base = RESEARCH_SYSTEM + chat_prefs.system_from(prefs)
    refs = (prefs or {}).get("skill_refs") or []
    if not refs:
        return base
    from types import SimpleNamespace

    from routers.chat import _skill_mounts

    mounts = _skill_mounts(SimpleNamespace(
        skill_refs=refs, skill_id=None, skill_path=None,
    ))
    if not mounts:
        return base
    blocks = "\n\n".join(f"--- {name} ---\n{raw}" for name, raw in mounts)
    return base + "\n\n【本轮挂载技能（按技能原文执行，仅对这一轮生效）】\n" + blocks


def _hist_text(sid: int, limit: int = 12) -> str:
    rows = query(
        "SELECT role, content FROM rchat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?",
        (sid, limit),
    )
    rows.reverse()
    return "\n".join(f"{'用户' if r['role'] == 'user' else '助手'}：{(r['content'] or '')[:600]}" for r in rows)


async def _gen_queries(instr: str, max_q: int = 3) -> list[str]:
    """让 LLM 把问题（可能是中文）翻译成 2-4 条英文检索式（OpenAlex 英文效果最好）。

    走 complete_json_result（解析失败不算成功），最多重试一次；仍失败就返回空，
    上层回退用原句检索。至少要含英文词，防止整句中文丢进 OpenAlex 召回一堆无关中文文献。
    max_q 决定最多要几条（检索篇数目标大时允许更多角度）。
    """
    prompt = (
        f"Research question (may be written in Chinese): {instr}\n\n"
        f"Translate it into {max_q} concise ENGLISH search queries for the OpenAlex academic index. "
        "Each query focuses on one angle (method / system / benchmark). "
        'Output JSON only: {"queries": ["...", "..."]}'
    )
    for _attempt in range(2):
        data, _env = await llm.complete_json_result(
            prompt,
            system="You output only valid JSON. No explanations, no code fences.",
            mode="fast",
            task="rchat:qgen",
            max_tokens=300,
        )
        if isinstance(data, dict):
            qs = [str(q).strip() for q in data.get("queries") or [] if str(q).strip()]
            qs = [q for q in qs if re.search(r"[A-Za-z]{3,}", q)]
            if qs:
                return qs[:max_q]
    return []


async def _oa_search(client: httpx.AsyncClient, q: str, per_page: int = 6) -> list[dict]:
    import openalex

    data = await openalex.get(client, {"search": q, "per-page": per_page}, ttl=1800)
    return data.get("results", [])


def _tokens(s: str) -> set[str]:
    """中英文词面 token（英文 ≥3 字母 / 中文 ≥2 字），用于算可复核的词面重合度。"""
    return set(re.findall(r"[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}", s.lower()))


def _paper_hit(w: dict, n: int, lit_id: int, queries: list[str]) -> dict:
    """OpenAlex 原始 work → 「文献检索」卡的一行。

    只填真实可核验字段：
    - cited_by_count / publication_year / language / OA PDF 均来自 OpenAlex 原样字段；
    - match = 英文检索式词与「标题 + 摘要词表」的词面重合率（本地计算，不是模型打分）；
    - cit_per_year = 被引数 / (今年 - 发表年 + 1)，作为可核验的影响力替代指标；
    - **不提供 JIF**：OpenAlex 没有期刊影响因子字段，不虚构数值（前端明确标注）。
    """
    meta = _parse_oa_work(w)
    year = int(w.get("publication_year") or 0)
    cited = int(w.get("cited_by_count") or 0)
    yr_now = time.localtime().tm_year
    age = max(1, yr_now - year + 1) if year else 1
    idx = w.get("abstract_inverted_index") or {}
    abs_words = {str(k).lower() for k in idx} if isinstance(idx, dict) else set()
    qt = _tokens(" ".join(queries))
    common = qt & (abs_words | _tokens(meta.get("title") or ""))
    match = min(100, round(100 * len(common) / max(1, len(qt))))
    best = w.get("best_oa_location") or {}
    primary = w.get("primary_location") or {}
    return {
        "n": n,
        "lit_id": lit_id,
        "openalex_id": meta.get("openalex_id"),
        "title": meta.get("title"),
        "authors": meta.get("authors"),
        "year": year or None,
        "venue": meta.get("venue"),
        "doi": meta.get("doi"),
        "url": meta.get("url"),
        "cited_by_count": cited,
        "cit_per_year": round(cited / age, 1),
        "language": (w.get("language") or "").upper() or "—",
        "match": match,
        "pdf_url": best.get("pdf_url") or primary.get("pdf_url") or "",
        "is_oa": bool((w.get("open_access") or {}).get("is_oa")),
        "abstract": meta.get("abstract") or "",
    }


def _stage(key: str, label: str, pct: int, detail: str = "", count: int | None = None,
           unit: str = "", estimated: bool = False) -> dict:
    """一条阶段事件。pct 是真实阶段完成后的累计进度；estimated=True 表示耗时心跳（不是完成度）。"""
    return {"type": "stage", "key": key, "label": label, "pct": pct,
            "detail": detail, "count": count, "unit": unit, "estimated": estimated}


async def _paced(coro, emit, key: str, label: str, start: int, cap: int):
    """LLM 长调用期间按「真实经过时间」推心跳，避免进度条在 84% 干等十几秒。

    心跳的 pct 是耗时估算，不是任务完成度：事件带 estimated=True，detail 里明写，
    前端也标「按耗时估算」。最终完成值仍由真实阶段事件给出，不虚构成果。
    """
    if not emit:
        return await coro
    task = asyncio.create_task(coro)
    t0 = time.monotonic()
    while not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=2.0)
            break
        except asyncio.TimeoutError:
            sec = int(time.monotonic() - t0)
            emit(_stage(key, label, min(cap, start + (sec // 2) * 2),
                        f"生成中 · 已用 {sec}s（按耗时估算，非完成度）", estimated=True))
    return await task


async def _gen_text(
    prompt: str, *, system: str, task: str, max_tokens: int, prefs: dict | None, emit,
    delta_event: str = "delta",
) -> dict:
    """正文生成统一入口：SSE 端点传 emit 时走 token 级流式（逐段推 delta 事件），
    JSON 端点 emit=None 时整段调用（行为与旧版完全一致）。

    delta_event 决定流式时推的事件名：正文用 "delta"，思考过程用 "thinking_delta"
    （让「正在思考」也逐字流出，而不是等整段生成完才弹出来）。

    返回与 complete_with_meta 同构的信封：ok / content / provider / model / tokens。
    流式失败同样抛 HTTPException(502)，与旧版失败路径一致。
    """
    if emit is None:
        return await llm.complete_with_meta(
            prompt, system=system, mode="fast", task=task, max_tokens=max_tokens,
            model_override=chat_prefs.model_override(prefs),
        )
    text_parts: list[str] = []
    meta_ev: dict | None = None
    err: dict | None = None
    async for ev in llm.stream_chat_events(
        [{"role": "user", "content": prompt}],
        system=system, mode="fast", task=task, max_tokens=max_tokens,
        model_override=chat_prefs.model_override(prefs),
    ):
        if ev["type"] == "delta":
            text_parts.append(ev["text"])
            emit({"type": delta_event, "text": ev["text"]})
        elif ev["type"] == "meta":
            meta_ev = ev
        else:
            err = ev.get("error") or {}
    if err:
        raise HTTPException(502, f"AI 生成失败：{err.get('label') or ''} {err.get('message') or ''}")
    if meta_ev is None:
        raise HTTPException(502, "AI 生成失败：流已结束但没有结果")
    return {
        "ok": True,
        "content": meta_ev.get("content") or "".join(text_parts),
        "provider": meta_ev.get("provider") or "",
        "model": meta_ev.get("model") or "",
        "tokens_in": int(meta_ev.get("tokens_in") or 0),
        "tokens_out": int(meta_ev.get("tokens_out") or 0),
        "error": None,
    }


async def _gen_think(
    instr: str, hist_text: str, prefs: dict | None, emit
) -> tuple[str, bool, list[str]]:
    """思考步骤（agentic 的「显式推理 + 工具决策」）：

    1) 轻量 JSON 决策：这个问题要不要查 OpenAlex 文献来支撑（避免闲聊/观点题也去检索）；
    2) 流式输出推理过程（thinking_delta），让前端看到「正在思考」逐字展开，
       而不是等整段答完才弹思考块。

    返回 (thinking 文本, 是否检索, 建议检索式)。emit=None 时仍返回 thinking 供落库。
    决策失败优雅降级：thinking 给一句占位，search 默认 False（少检索比误检索安全）。
    """
    def stage(key, label, pct, detail="", count=None, unit=""):
        if emit:
            emit(_stage(key, label, pct, detail, count, unit))

    stage("think", "理解问题并规划", 8, "判断是否需要检索文献，并梳理回答思路")

    # ① 决策：是否需要检索（轻量 JSON，先出，便于后面决定是否调用检索工具）
    decide_prompt = (
        f"研究问题：{instr}\n\n最近对话：\n{hist_text or '（无）'}\n\n"
        '只需输出 JSON：{"search": true/false, "queries": ["英文检索式，最多 3 条，仅 search=true 时填"]}。'
        "search=true 当且仅当回答需要外部文献支撑；纯对话续写/观点/闲聊填 false。"
    )
    search, queries = False, []
    try:
        data, _e = await llm.complete_json_result(
            decide_prompt, system="你是严谨的研究副驾。只输出 JSON，不要解释。", mode="fast",
            task="rchat:think-decide", max_tokens=300,
            model_override=chat_prefs.model_override(prefs),
        )
        if isinstance(data, dict):
            search = bool(data.get("search"))
            queries = [str(q).strip() for q in (data.get("queries") or []) if str(q).strip()][:3]
    except Exception:
        # 决策失败不致命：默认不检索，思考块仍会给出一句占位
        search, queries = False, []

    # ② 流式输出思考过程（thinking_delta）
    stage("think", "梳理回答思路", 12, "正在生成推理过程…")
    think_env = await _gen_text(
        f"研究问题：{instr}\n\n最近对话：\n{hist_text or '（无）'}\n\n"
        "请输出你的推理过程（中文，2-5 句，简明，不要寒暄、不要列点）：\n"
        "核心问题是什么、打算从哪些角度回答、"
        + ("将检索文献来支撑论点" if search else "可基于已有对话直接回答，无需检索")
        + "。",
        system=_research_system(prefs),
        task="rchat:think", max_tokens=500, prefs=prefs, emit=emit, delta_event="thinking_delta",
    )
    thinking = (think_env.get("content") or "").strip()
    if not thinking:
        thinking = "已分析问题并规划回答方向。"
    stage("think", "梳理回答思路", 16, thinking[:120])
    return thinking, search, queries


async def _retrieve_auto(
    queries: list[str], mp: int, emit, stage,
) -> tuple[list[dict], list[dict], int]:
    """auto 模式的轻量真实检索：与 deep 同款 OpenAlex 链路，规模更小（默认 8 篇）。

    返回 (citations, papers, raw_hits)。emit=None 时仍返回数据用于落库。
    papers 与 citations 同构（文献检索卡行 = 引用行），前端从引用回填时各列才有值。
    """
    mp = max(4, min(12, mp))
    n_queries = max(1, len(queries))
    per_page = max(5, min(12, -(-(mp * 16) // n_queries)))  # ceil(mp*1.6/n_queries)

    stage("search", "检索 OpenAlex", 28, f"{n_queries} 条检索式并发检索（每式最多 {per_page} 条）")
    seen: set[str] = set()
    works: list[dict] = []
    raw_hits = 0
    async with httpx.AsyncClient(timeout=30) as client:
        results = await asyncio.gather(
            *(_oa_search(client, q, per_page=per_page) for q in queries), return_exceptions=True
        )
        for res in results:
            if isinstance(res, Exception):
                continue
            raw_hits += len(res)
            for w in res:
                pm = _parse_oa_work(w)
                key = pm.get("openalex_id") or _norm_title(pm.get("title", ""))
                if key and key not in seen:
                    seen.add(key)
                    works.append(w)
    works.sort(key=lambda w: w.get("cited_by_count") or 0, reverse=True)
    works = works[:mp]
    stage("dedupe", "去重并写入文献库", 44, f"按 OpenAlex ID / 归一化标题去重，保留 {len(works)} 篇")
    citations: list[dict] = []
    papers: list[dict] = []
    for i, w in enumerate(works, 1):
        meta = _parse_oa_work(w)
        lit_id, _created = _find_or_create_lit(meta)  # 命中即入文献库（去重）
        hit = _paper_hit(w, i, lit_id, queries)
        citations.append(hit)
        papers.append(hit)
    if emit:
        emit({"type": "papers", "papers": papers, "total": len(papers),
              "query_count": len(queries), "raw_hits": raw_hits})
    stage("dedupe", "去重并写入文献库", 56,
          f"已入库 {len(citations)} 篇 · 生成文献检索卡", len(citations), "篇")
    return citations, papers, raw_hits


async def _deep_search(
    instr: str, emit=None, prefs: dict | None = None, max_papers: int | None = None,
    use_consensus: bool = False,
) -> tuple[str, list[dict], list[str], list[dict], list[dict]]:
    """返回 (综述文本, citations, queries, suggests, 文献检索卡行)。

    emit 是可选的**同步**回调：每做完一个真实阶段就推一条 SSE 事件，进度框因此是
    「后端真实阶段」而不是前端假动画。JSON 端点不传 emit，行为与以前完全一致。

    max_papers：想保留的文献篇数上限（仅影响 deep 模式）。默认 15，合法区间 4–40。
    检索式数量与每条 per_page 都按目标篇数自适应放大，保证去重后仍有足够候选。
    use_consensus：叠加 Consensus.app 共识检索，把同行评审文献并回引用（调研方法）。
    """
    # 篇数预算：限制区间，避免一次拉几百上千条把 OpenAlex 与 LLM 提示词撑爆
    mp = 15
    if isinstance(max_papers, int):
        mp = max(4, min(40, max_papers))
    n_queries = 4 if mp >= 20 else 3
    per_page = max(6, min(20, -(-(mp * 16) // n_queries)))  # ceil(mp*1.6/n_queries)

    def stage(key, label, pct, detail="", count=None, unit=""):
        if emit:
            emit(_stage(key, label, pct, detail, count, unit))

    # 思考步骤：先让模型梳理检索方向（流式 thinking_delta 推到前端，显示「正在思考」）
    stage("think", "梳理检索方向", 4, "分析研究问题，规划检索角度")
    think_env = await _gen_text(
        f"研究问题：{instr}\n\n请输出你的检索思路（中文，2-4 句，简明，不要寒暄）："
        "这个方向的核心是什么、打算从哪些角度检索文献、预期能回答什么。",
        system=_research_system(prefs),
        task="rchat:think", max_tokens=400, prefs=prefs, emit=emit, delta_event="thinking_delta",
    )
    thinking = (think_env.get("content") or "").strip()
    stage("think", "梳理检索方向", 8, (thinking[:120] if thinking else "规划检索角度"))

    stage("queries", "生成检索式", 12, "把研究问题翻成 OpenAlex 英文检索式")
    queries = await _gen_queries(instr, max_q=n_queries)
    if not queries:
        queries = [instr]
    stage("queries", "生成检索式", 16, " · ".join(queries), len(queries), "条")

    stage("search", "检索 OpenAlex", 26, f"{len(queries)} 条检索式并发检索（每式最多 {per_page} 条）")
    seen: set[str] = set()
    works: list[dict] = []
    raw_hits = 0
    async with httpx.AsyncClient(timeout=30) as client:
        results = await asyncio.gather(
            *(_oa_search(client, q, per_page=per_page) for q in queries), return_exceptions=True
        )
        for res in results:
            if isinstance(res, Exception):
                continue
            raw_hits += len(res)
            for w in res:
                pm = _parse_oa_work(w)
                key = pm.get("openalex_id") or _norm_title(pm.get("title", ""))
                if key and key not in seen:
                    seen.add(key)
                    works.append(w)
    works.sort(key=lambda w: w.get("cited_by_count") or 0, reverse=True)
    works = works[:mp]
    stage("search", "检索 OpenAlex", 40,
          f"{len(queries)} 条检索式 · 原始命中 {raw_hits} 条 · 保留 {len(works)} 篇", raw_hits, "条")

    stage("dedupe", "去重并写入文献库", 48,
          f"按 OpenAlex ID / 归一化标题去重，保留 {len(works)} 篇")
    citations: list[dict] = []
    papers: list[dict] = []
    src_lines: list[str] = []
    for i, w in enumerate(works, 1):
        meta = _parse_oa_work(w)
        lit_id, _created = _find_or_create_lit(meta)  # 命中即入文献库（去重）
        # 引用 = 文献检索卡同一份全字段行（match/language/cit_per_year/pdf_url 等），
        # 报告/综述继承它，前端从引用回填文献栏时各列才有值
        hit = _paper_hit(w, i, lit_id, queries)
        citations.append(hit)
        papers.append(hit)
        src_lines.append(
            f"[{i}] {meta['title']} — {meta['authors'] or '佚名'} ({meta['year'] or 'n.d.'}) "
            f"| {meta['venue'] or ''} | 被引 {meta['cited_by_count']} | doi:{meta['doi'] or '无'}"
        )
    # ---- 共识检索（Consensus.app）：作为可叠加的调研方法，把同行评审文献并回引用 ----
    if use_consensus:
        stage("consensus", "共识检索 Consensus", 52, "向 Consensus.app 检索同行评审文献与结论 takeaway")
        try:
            import consensus as cs
            async with httpx.AsyncClient(timeout=30) as ccli:
                cns = await cs.search(ccli, instr, page_size=10)
            added = 0
            for p in cns.get("results", []):
                added += 1
                i = len(citations) + 1
                title = p.get("title") or "（无标题）"
                authors = p.get("authors") or "佚名"
                year = p.get("year") or "n.d."
                venue = p.get("journal_name") or ""
                cited = p.get("citation_count") or 0
                tk = p.get("takeaway")
                hit = {
                    "n": i, "lit_id": 0, "openalex_id": None,
                    "title": title, "authors": authors, "year": p.get("year"),
                    "venue": venue, "doi": p.get("doi") or "", "url": p.get("url") or "",
                    "cited_by_count": cited, "cit_per_year": None,
                    "language": "—", "match": None, "pdf_url": "", "is_oa": False,
                    "abstract": p.get("abstract") or "",
                    "takeaway": tk or "", "source": "consensus",
                }
                citations.append(hit)
                papers.append(hit)
                tk_line = f" | 结论：{tk}" if tk else ""
                src_lines.append(
                    f"[{i}] {title} — {authors} ({year}) "
                    f"| {venue} | 被引 {cited} | Consensus{tk_line}"
                )
            stage("consensus", "共识检索 Consensus", 58,
                  f"并入 {added} 篇共识来源（Consensus.app）", added, "篇")
        except Exception as e:  # 共识失败不影响 OpenAlex 主线
            stage("consensus", "共识检索 Consensus", 58, f"跳过（{type(e).__name__}）")

    stage("dedupe", "去重并写入文献库", 60,
          f"已入库 {len(citations)} 篇 · 生成文献检索卡", len(citations), "篇")
    if emit:
        emit({"type": "papers", "papers": papers, "total": len(papers),
              "query_count": len(queries), "raw_hits": raw_hits})

    stage("write", "撰写深度综述", 62, "只允许引用上面命中的真实来源，标注 [n]")
    env = await _gen_text(
        f"研究问题：{instr}\n\n"
        f"检索式：{'；'.join(queries)}\n\n"
        "检索命中的来源（只允许引用这些，标注 [n]）：\n" + "\n".join(src_lines) + "\n\n"
        "请写一段深度检索综述：先 2-3 句结论（这个方向的研究现状一句话概括），"
        "再分点讲主要脉络与代表工作（每个论点后标 [n]），"
        "最后指出这些来源组合起来暴露出的研究空白。中文为主，可混英文术语。"
        "如果来源不足以支撑某个判断，直接说「检索结果未覆盖」。"
        "结尾另起一行输出：\nSUGGESTS: 后续指令1 | 后续指令2",
        system=_research_system(prefs),
        task="rchat:deep",
        max_tokens=min(4000, max(2200, 130 * mp)),
        prefs=prefs, emit=emit,
    )
    if not env.get("ok"):
        e = env.get("error") or {}
        raise HTTPException(502, f"AI 综述失败：{e.get('label') or ''} {e.get('message') or ''}")
    text = (env.get("content") or "").strip()
    suggests: list[str] = []
    m = re.search(r"SUGGESTS:\s*(.+)$", text, re.S)
    if m:
        text = text[: m.start()].strip()
        suggests = [s.strip() for s in m.group(1).split("|") if s.strip()][:2]
    stage("write", "撰写深度综述", 96,
          f"综述完成 · 引用 {len(citations)} 篇", len(citations), "篇")
    return text, citations, queries, suggests, papers, thinking


async def _write_report(
    sid: int, emit=None, prefs: dict | None = None
) -> tuple[str, list[dict], list[str]]:
    """把整段会话浓缩成结构化 Markdown 报告。返回 (md, citations, suggests)。"""
    def stage(key, label, pct, detail="", count=None, unit=""):
        if emit:
            emit(_stage(key, label, pct, detail, count, unit))

    stage("collect", "汇总会话与引用", 15, "读取本会话历史消息与已命中的参考文献")
    # 收集会话里出现过的全部引用（deep 消息的 meta.citations）
    all_cits: dict[int, dict] = {}
    rows = query(
        "SELECT meta FROM rchat_messages WHERE session_id=? AND kind='deep'", (sid,)
    )
    for r in rows:
        try:
            for c in json.loads(r["meta"] or "{}").get("citations") or []:
                if c.get("n"):
                    all_cits[int(c["n"])] = c
        except ValueError:
            continue
    cits = sorted(all_cits.values(), key=lambda c: c.get("n") or 0)
    stage("collect", "汇总会话与引用", 30,
          f"共收集 {len(cits)} 条参考文献", len(cits), "条")
    refs = "\n".join(
        f"[{c['n']}] {c.get('title')} — {c.get('authors') or '佚名'} ({c.get('year') or 'n.d.'})"
        for c in cits
    )
    stage("write", "撰写结构化报告", 45, "结论先行 · 证据范围 · 主要脉络 · 研究空白")
    env = await _gen_text(
        "以下是本会话的完整对话与检索到的参考文献。请写一份结构化中文 Markdown 报告：\n"
        "# 标题（根据主题起）\n"
        "## 结论先行（3-5 条要点）\n## 证据范围（基于哪些来源，[n] 引用）\n"
        "## 主要脉络（分点，引用标注 [n]）\n## 研究空白与下一步\n\n"
        "要求：结论先行；每条主张都要有对话里的依据或 [n] 引用；"
        "没有依据的地方明写「会话中未覆盖」；不要编造文献或数字。\n\n"
        "=== 对话记录 ===\n" + _hist_text(sid, limit=30) + "\n\n=== 参考文献 ===\n" + (refs or "（无）"),
        system=_research_system(prefs),
        task="rchat:report",
        max_tokens=3000,
        prefs=prefs, emit=emit,
    )
    if not env.get("ok"):
        e = env.get("error") or {}
        raise HTTPException(502, f"报告生成失败：{e.get('label') or ''} {e.get('message') or ''}")
    md = (env.get("content") or "").strip()
    suggests: list[str] = []
    m = re.search(r"SUGGESTS:\s*(.+)$", md, re.S)
    if m:
        md = md[: m.start()].strip()
        suggests = [s.strip() for s in m.group(1).split("|") if s.strip()][:2]
    stage("write", "撰写结构化报告", 94, "报告正文完成")
    return md, cits, suggests


async def _review_selected(
    sid: int, instr: str, lit_ids: list[int] | None, emit=None, prefs: dict | None = None
) -> tuple[str, list[dict], list[str]]:
    """对用户在文献检索栏勾选的文献子集写综述。返回 (md, citations, suggests)。

    数据口径（不虚构）：
    - 标题 / 作者 / 年份 / venue / DOI / 摘要全部来自 literature 表（OpenAlex 落库的原样字段）；
    - literature 表没有被引数列，从本会话 deep 消息的 meta.citations 按 lit_id 回填，
      回填不到就明写「未知」，不编造；
    - 勾选的 id 若已被删出文献库，跳过并在阶段详情里说明，不会静默丢。
    """
    def stage(key, label, pct, detail="", count=None, unit=""):
        if emit:
            emit(_stage(key, label, pct, detail, count, unit))

    # 去重保序，封顶 60：再多提示词会撑爆，且勾选语义就是「人工精选子集」
    ids: list[int] = []
    for x in lit_ids or []:
        try:
            v = int(x)
        except (TypeError, ValueError):
            continue
        if v > 0 and v not in ids:
            ids.append(v)
    ids = ids[:60]
    if not ids:
        raise HTTPException(400, "没有勾选任何文献")

    stage("collect", "汇总选中文献", 18, f"按勾选读取 {len(ids)} 篇文献的标题与摘要")
    marks = ",".join("?" * len(ids))
    by_id = {r["id"]: r for r in query(f"SELECT * FROM literature WHERE id IN ({marks})", tuple(ids))}
    # 被引数回填：本会话 deep 消息的 meta.citations 带 OpenAlex 原样 cited_by_count
    cited_map: dict[int, int] = {}
    for r in query("SELECT meta FROM rchat_messages WHERE session_id=? AND kind='deep'", (sid,)):
        try:
            for c in json.loads(r["meta"] or "{}").get("citations") or []:
                lid = c.get("lit_id")
                if lid and c.get("cited_by_count") is not None:
                    try:
                        cited_map[int(lid)] = int(c["cited_by_count"])
                    except (TypeError, ValueError):
                        continue
        except ValueError:
            continue

    citations: list[dict] = []
    src_lines: list[str] = []
    missing = 0
    for lid in ids:
        r = by_id.get(lid)
        if r is None:
            missing += 1
            continue
        n = len(citations) + 1
        abstract = (r["abstract"] or "").strip()
        cited = cited_map.get(lid)
        citations.append({
            "n": n, "lit_id": lid, "title": r["title"], "authors": r["authors"] or "",
            "year": r["year"], "venue": r["venue"] or "", "doi": r["doi"] or "",
            "url": r["url"] or "", "cited_by_count": cited, "abstract": abstract[:1200],
        })
        src_lines.append(
            f"[{n}] {r['title']} — {r['authors'] or '佚名'} ({r['year'] or 'n.d.'})"
            f" | {r['venue'] or 'venue 未知'} | 被引 {cited if cited is not None else '未知'}\n"
            f"摘要：{abstract[:600] or '（OpenAlex 未提供摘要）'}"
        )
    if not citations:
        raise HTTPException(404, "勾选的文献都不在文献库里（可能已被删除）")
    stage("collect", "汇总选中文献", 32,
          f"就绪 {len(citations)} 篇" + (f" · {missing} 篇已不在库中，已跳过" if missing else ""),
          len(citations), "篇")

    stage("write", "撰写选中文献综述", 45, "只引用勾选的来源，标注 [n]")
    env = await _gen_text(
        f"用户指令：{instr}\n\n"
        "以下是用户从检索结果中**勾选**的文献（只允许引用这些，标注 [n]）：\n"
        + "\n".join(src_lines) + "\n\n"
        "请写一份结构化中文 Markdown 综述：\n"
        "# 标题（概括这批文献的共同主题）\n"
        "## 结论先行（2-4 条要点）\n"
        "## 文献概览（这批文献的构成：年份 / 出处分布，不要编造具体统计）\n"
        "## 主要脉络（分点，每条论点后标 [n]）\n"
        "## 研究空白与下一步\n\n"
        "要求：每条主张都要有 [n] 引用或摘要依据；摘要里没写的不要脑补；"
        "证据不足的地方明写「所选文献未覆盖」；不要编造文献、venue 或数字。",
        system=_research_system(prefs),
        task="rchat:review",
        max_tokens=min(4000, max(2200, 160 * len(citations))),
        prefs=prefs, emit=emit,
    )
    if not env.get("ok"):
        e = env.get("error") or {}
        raise HTTPException(502, f"综述生成失败：{e.get('label') or ''} {e.get('message') or ''}")
    md = (env.get("content") or "").strip()
    suggests: list[str] = []
    m = re.search(r"SUGGESTS:\s*(.+)$", md, re.S)
    if m:
        md = md[: m.start()].strip()
        suggests = [s.strip() for s in m.group(1).split("|") if s.strip()][:2]
    stage("write", "撰写选中文献综述", 94,
          f"综述完成 · 引用 {len(citations)} 篇勾选文献", len(citations), "篇")
    return md, citations, suggests


# ---------------------------------------------------------------- 两种 chat 端点共用的落库


def _prepare_user(sid: int, instr: str, mode: str, tag: str | None):
    """插入用户消息 + 首条消息自动起标题。JSON / SSE 两个端点共用，避免重复落库。"""
    execute(
        "INSERT INTO rchat_messages (session_id, role, kind, content, meta, created_at) VALUES (?,?,?,?,?,?)",
        (sid, "user", "text", instr,
         json.dumps({"tag": tag or ("深度检索" if mode == "deep" else "报告撰写" if mode == "report"
                                    else "综述撰写" if mode == "review" else "研究对话")},
                    ensure_ascii=False),
         now()),
    )
    row = query("SELECT COUNT(*) AS c FROM rchat_messages WHERE session_id=?", (sid,))[0]
    s = _session(sid)
    if row["c"] == 1 and (s["title"] in ("", "新对话")):
        execute("UPDATE rchat_sessions SET title=? WHERE id=?", (instr[:24], sid))
    _touch(sid)


def _store_assistant(sid: int, kind: str, content: str, meta: dict, env: dict, t0: float) -> dict:
    elapsed = int((time.monotonic() - t0) * 1000)
    mid = execute(
        "INSERT INTO rchat_messages (session_id, role, kind, content, meta, provider, model, elapsed_ms, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (sid, "assistant", kind, content, json.dumps(meta, ensure_ascii=False),
         env.get("provider") or "", env.get("model") or "", elapsed, now()),
    )
    _touch(sid)
    return {
        "id": mid, "session_id": sid, "role": "assistant", "kind": kind,
        "content": content, "meta": meta, "elapsed_ms": elapsed,
        "provider": env.get("provider") or "", "model": env.get("model") or "",
        "created_at": now(),
    }


async def _run_modes(sid: int, instr: str, mode: str, emit, t0: float, prefs: dict | None = None,
                     max_papers: int | None = None, lit_ids: list[int] | None = None):
    """执行 auto / deep / report / review，返回 (env, kind, content, meta)。emit=None 时无阶段事件。

    auto / deep 现在是 agentic 流程：先显式「思考」（推理过程 + 是否检索的工具决策），
    必要时调用真实检索工具（OpenAlex），最后结构化输出；思考过程通过 thinking_delta
    流式推到前端，避免「直接吐一整串」的网页对话观感。
    """
    env: dict = {}
    kind = "text"
    content = ""
    meta: dict = {}
    if mode == "deep":
        kind = "deep"
        use_cns = bool((prefs or {}).get("use_consensus"))
        text, citations, queries, suggests, _papers, thinking = await _deep_search(
            instr, emit, prefs, max_papers, use_consensus=use_cns)
        content = text
        meta = {"citations": citations, "queries": queries, "suggests": suggests, "thinking": thinking}
    elif mode == "review":
        kind = "report"  # 复用报告的消息形态：左栏文档 + ReportPane 渲染 + 引用 chips
        md, citations, suggests = await _review_selected(sid, instr, lit_ids, emit, prefs)
        content = md
        meta = {"citations": citations, "suggests": suggests}
    elif mode == "report":
        kind = "report"
        md, citations, suggests = await _write_report(sid, emit, prefs)
        content = md
        meta = {"citations": citations, "suggests": suggests}
    else:
        # auto：思考 →（按需）真实检索 → 结构化回答
        def st(key, label, pct, detail="", count=None, unit=""):
            if emit:
                emit(_stage(key, label, pct, detail, count, unit))

        hist = _hist_text(sid)
        thinking, search, auto_queries = await _gen_think(instr, hist, prefs, emit)
        applied: list[str] = []
        citations: list[dict] = []
        queries: list[str] = []
        if search:
            if not auto_queries:
                auto_queries = await _gen_queries(instr, max_q=3)
            queries = auto_queries or [instr]
            cits, _papers, raw_hits = await _retrieve_auto(queries, max_papers or 8, emit, st)
            citations = cits
            applied.append(f"检索 OpenAlex：原始命中 {raw_hits} 条，入库 {len(citations)} 篇")
        else:
            st("skip", "无需检索", 22, "基于已有对话直接回答")
            applied.append("基于对话上下文回答（未调用检索）")

        # 结构化回答：结论先行 + 分点；引用了文献则标 [n]
        src_lines = "\n".join(
            f"[{c['n']}] {c.get('title')} — {c.get('authors') or '佚名'} ({c.get('year') or 'n.d.'})"
            for c in citations
        ) if citations else ""
        answer_prompt = (
            f"最近对话：\n{hist or '（无）'}\n\n用户的新消息：{instr}\n\n"
            + (f"本轮检索命中的来源（只允许引用这些，标注 [n]）：\n{src_lines}\n\n" if citations else "")
            + "请按以下结构回答（结论先行，不寒暄）：\n"
            "第一段：一句话核心结论。\n"
            "第二段起：分 2-4 点展开，每点用小标题（**加粗**）开头，每点 1-3 句。\n"
            + ("每个论点后标 [n] 引用检索来源；证据不足明写「检索结果未覆盖」。\n" if citations else "")
            + "结尾另起一行输出：\nSUGGESTS: 后续指令1 | 后续指令2（用户可能追问的、可整句直接发送）"
        )
        st("answer", "生成结构化回答", 70 if search else 40, "结论先行 · 分点展开")
        env = await _gen_text(
            answer_prompt, system=_research_system(prefs), task="rchat:auto",
            max_tokens=1600, prefs=prefs, emit=emit,
        )
        if not env.get("ok"):
            e = env.get("error") or {}
            raise HTTPException(502, f"AI 回复失败：{e.get('label') or ''} {e.get('message') or ''}")
        text = (env.get("content") or "").strip()
        suggests: list[str] = []
        m = re.search(r"SUGGESTS:\s*(.+)$", text, re.S)
        if m:
            text = text[: m.start()].strip()
            suggests = [x.strip() for x in m.group(1).split("|") if x.strip()][:2]
        content = text
        meta = {
            "thinking": thinking, "suggests": suggests,
            "queries": queries, "citations": citations, "applied": applied,
        }
        st("answer", "生成结构化回答", 96, "结论先行 · 附后续建议")
    return env, kind, content, meta


@router.post("/sessions/{sid}/chat")
async def chat(sid: int, body: ChatIn):
    """普通 JSON 端点：保留给非流式调用方；/research 已改用下面的 SSE 流式端点。"""
    _session(sid)
    instr = (body.instruction or "").strip()
    if not instr:
        raise HTTPException(400, "说点什么")
    mode = body.mode if body.mode in ("auto", "deep", "report", "review") else "auto"
    t0 = time.monotonic()
    _prepare_user(sid, instr, mode, body.tag)
    env, kind, content, meta = await _run_modes(sid, instr, mode, None, t0, body.model_dump(),
                                                body.max_papers, body.lit_ids)
    return {"ok": True, "message": _store_assistant(sid, kind, content, meta, env, t0)}


def _sse(ev: dict) -> str:
    return "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"


@router.post("/sessions/{sid}/chat/stream")
async def chat_stream(sid: int, body: ChatIn):
    """SSE 流式端点：真实阶段事件（生成检索式 / OpenAlex 检索 / 去重入库 / 撰写综述）+ 文献卡数据。

    与 /chat 共用 _prepare_user / _run_modes / _store_assistant，只落一次 user + 一次 assistant。
    事件：stage（进度）、papers（文献检索卡行）、done（最终消息）、error（失败原因）。
    **不要带 Idempotency-Key**：幂等中间件会把整条流读进内存再回放，实时阶段就没了。
    """
    _session(sid)
    instr = (body.instruction or "").strip()
    if not instr:
        raise HTTPException(400, "说点什么")
    mode = body.mode if body.mode in ("auto", "deep", "report", "review") else "auto"

    q: asyncio.Queue[dict | None] = asyncio.Queue()

    def emit(ev: dict) -> None:
        q.put_nowait(ev)

    async def run() -> None:
        t0 = time.monotonic()
        try:
            _prepare_user(sid, instr, mode, body.tag)
            emit(_stage("start", "任务已接收", 4, instr[:100]))
            env, kind, content, meta = await _run_modes(sid, instr, mode, emit, t0, body.model_dump(),
                                                        body.max_papers, body.lit_ids)
            emit({"type": "done", "message": _store_assistant(sid, kind, content, meta, env, t0)})
        except HTTPException as exc:
            emit({"type": "error", "message": str(exc.detail)})
        except Exception as exc:  # noqa: BLE001 —— 流里不能抛裸异常，否则前端只看到连接断开
            emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        finally:
            q.put_nowait(None)

    async def gen():
        task = asyncio.create_task(run())
        try:
            while True:
                ev = await q.get()
                if ev is None:
                    break
                yield _sse(ev)
                if ev.get("type") in ("done", "error"):
                    break
        finally:
            if not task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=0.2)
                except Exception:
                    task.cancel()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------- 文献详情 / 共识


@router.get("/papers/{lit_id}")
def paper_detail(lit_id: int):
    """点击正文 [n] 或文献标题时弹出的「对应内容」。

    只返回本地已存的真实字段 + 该文献已有的阅读笔记，不现场编造摘要或结论。
    摘要来自 OpenAlex 的 abstract_inverted_index 还原（未返回则为空）。
    """
    rows = query("SELECT * FROM literature WHERE id=?", (lit_id,))
    if not rows:
        raise HTTPException(404, "文献库里没有这条记录")
    notes = query(
        "SELECT id, section, content, source, created_at FROM lit_notes "
        "WHERE literature_id=? ORDER BY sort_order, id",
        (lit_id,),
    )
    return {"paper": rows[0], "notes": notes}


class ConsensusIn(BaseModel):
    question: str
    papers: list[dict] = []


_STANCES = {"support", "neutral", "oppose", "unknown"}


@router.post("/consensus")
async def consensus(body: ConsensusIn):
    """对本次命中的文献就研究问题做立场判定（对标 Consensus 的 Paper / Answer 表）。

    只依据传入的真实标题与摘要；摘要缺失一律 unknown，不臆测。
    返回的 stance 是「模型推断」，不是文献作者的结论，前端必须显式标注。
    """
    question = (body.question or "").strip()[:300]
    papers = [p for p in (body.papers or []) if (p.get("title") or "").strip()][:12]
    if not question or not papers:
        raise HTTPException(400, "需要研究问题和至少一篇文献")
    valid_n = {
        int(p["n"]) for p in papers
        if isinstance(p.get("n"), (int, float)) or str(p.get("n") or "").isdigit()
    }
    lines = []
    for p in papers:
        abstract = str(p.get("abstract") or "").strip()
        lines.append(
            f"[{p.get('n')}] {p.get('title')} ({p.get('year') or 'n.d.'})\n"
            f"摘要：{abstract[:900] if abstract else '（OpenAlex 未提供摘要）'}"
        )
    prompt = (
        f"研究问题：{question}\n\n"
        "下面是本次检索命中的文献（只有标题与摘要，没有全文）：\n"
        + "\n\n".join(lines)
        + "\n\n请逐篇判断：这篇文献的内容是否支持 / 反对 / 中立于 / 无法判断该问题的某个主张。"
        "只输出 JSON：{\"items\":[{\"n\": 序号, \"stance\": \"support|neutral|oppose|unknown\", "
        "\"reason\": \"一句话依据（必须能在标题或摘要里找到对应词句）\"}]}\n"
        "硬规则：\n"
        "1. 摘要为「（OpenAlex 未提供摘要）」时，stance 必须是 unknown，reason 写「本库未保存摘要，无法判定」；\n"
        "2. 只依据给定标题/摘要，禁止补全文里可能存在的结论、禁止编造数字或实验；\n"
        "3. reason 要引述或转述摘要中的具体词句，判断不了就写 unknown，不要硬猜；\n"
        "4. 每篇恰好一条，n 必须与上面序号一致，不要输出 JSON 以外的文字。"
    )
    data, env = await llm.complete_json_result(
        prompt, mode="fast", task="rchat:consensus", max_tokens=2400,
    )
    if not env.get("ok"):
        e = env.get("error") or {}
        raise HTTPException(502, f"共识分析失败：{e.get('label') or ''} {e.get('message') or ''}")
    raw = data.get("items") if isinstance(data, dict) else None
    items: list[dict] = []
    for it in raw or []:
        if not isinstance(it, dict):
            continue
        try:
            n = int(it.get("n"))
        except (TypeError, ValueError):
            continue
        if n not in valid_n or any(x["n"] == n for x in items):
            continue
        stance = str(it.get("stance") or "unknown").strip().lower()
        items.append({
            "n": n,
            "stance": stance if stance in _STANCES else "unknown",
            "reason": str(it.get("reason") or "").strip()[:240],
        })
    # 模型漏判的条目补 unknown，明确「未判定」，不假装已有结论
    for n in sorted(valid_n):
        if not any(x["n"] == n for x in items):
            items.append({"n": n, "stance": "unknown", "reason": "模型未返回该篇的判定"})
    return {
        "ok": True, "items": items,
        "source": "model_inference",
        "note": "以上立场是模型依据标题/摘要的推断，不是文献原文结论；请人工复核。",
    }


# ---------------------------------------------------------------- 文献导入


class ImportIn(BaseModel):
    text: str
    fmt: str = "auto"  # auto | bibtex | csljson | ris


@router.post("/import/bibtex")
def import_bibtex(body: ImportIn):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "导入内容为空")
    fmt = body.fmt
    if fmt == "auto":
        fmt = (
            "csljson"
            if text.lstrip().startswith(("[", "{")) and '"title"' in text
            else "bibtex" if text.lstrip().startswith("@") else "ris"
        )
    try:
        if fmt == "csljson":
            mapped = _parse_csl(text)
        elif fmt == "bibtex":
            mapped = _parse_bibtex(text)
        else:
            mapped = _parse_ris(text)
    except Exception as exc:
        raise HTTPException(400, f"解析失败（格式={fmt}）：{type(exc).__name__}: {exc}")
    if not mapped:
        raise HTTPException(400, "没解析出条目，确认是 CSL JSON / BibTeX / RIS 导出格式")
    imported, updated, skipped, samples = _insert_many(mapped)
    return {
        "ok": True, "total": len(mapped), "imported": imported,
        "updated": updated, "skipped": skipped, "fmt": fmt,
    }


@router.post("/import/pdf")
async def import_pdf(file: UploadFile = File(...)):
    """上传 PDF → data/uploads + 建文献条目（pdf_path 直通现有阅读器）。"""
    name = file.filename or "paper.pdf"
    if not name.lower().endswith(".pdf"):
        raise HTTPException(400, "只收 .pdf 文件")
    data = await file.read()
    if not data:
        raise HTTPException(400, "文件是空的")
    if len(data) > 60 * 1024 * 1024:
        raise HTTPException(400, "PDF 超过 60MB，先压缩一下")
    _UPLOAD_DIR.mkdir(exist_ok=True)
    safe = re.sub(r"[^\w.\-() ]", "_", name)
    path = _UPLOAD_DIR / f"{int(time.time())}-{safe}"
    path.write_bytes(data)
    ts = now()
    lit_id = execute(
        """INSERT INTO literature (title, status, pdf_path, created_at, updated_at)
           VALUES (?,?,?,?,?)""",
        (path.stem.split("-", 1)[-1] or "未命名 PDF", "todo", str(path), ts, ts),
    )
    return {"ok": True, "id": lit_id, "title": path.stem, "pdf_path": str(path)}
