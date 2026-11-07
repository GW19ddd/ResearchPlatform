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


# ---------------------------------------------------------------- 深度检索 / 对话 / 报告


class ChatIn(BaseModel):
    instruction: str
    mode: str = "auto"  # auto | deep | report
    tag: str | None = None


RESEARCH_SYSTEM = (
    "你是「研究对话」副驾，风格像 Undermind：严谨、结构化、结论先行、中文为主可混英文术语。"
    "用户在做 LLM 驱动的软件测试生成研究。回答要直接给观点和依据，不要寒暄；"
    "不确定的事情明说不确定，绝不编造文献、数字或引用。"
)


def _hist_text(sid: int, limit: int = 12) -> str:
    rows = query(
        "SELECT role, content FROM rchat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?",
        (sid, limit),
    )
    rows.reverse()
    return "\n".join(f"{'用户' if r['role'] == 'user' else '助手'}：{(r['content'] or '')[:600]}" for r in rows)


async def _gen_queries(instr: str) -> list[str]:
    """让 LLM 把问题（可能是中文）翻译成 2-3 条英文检索式（OpenAlex 英文效果最好）。

    走 complete_json_result（解析失败不算成功），最多重试一次；仍失败就返回空，
    上层回退用原句检索。至少要含英文词，防止整句中文丢进 OpenAlex 召回一堆无关中文文献。
    """
    prompt = (
        f"Research question (may be written in Chinese): {instr}\n\n"
        "Translate it into 2-3 concise ENGLISH search queries for the OpenAlex academic index. "
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
                return qs[:3]
    return []


async def _oa_search(client: httpx.AsyncClient, q: str, per_page: int = 6) -> list[dict]:
    r = await client.get(
        _OA_BASE,
        params={"search": q, "per-page": per_page, "mailto": _OA_MAILTO},
    )
    r.raise_for_status()
    return r.json().get("results", [])


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
    }


def _stage(key: str, label: str, pct: int, detail: str = "", count: int | None = None,
           unit: str = "") -> dict:
    """一条真实阶段事件。pct 是该阶段完成后的累计进度，不是定时器推出来的。"""
    return {"type": "stage", "key": key, "label": label, "pct": pct,
            "detail": detail, "count": count, "unit": unit}


async def _deep_search(
    instr: str, emit=None
) -> tuple[str, list[dict], list[str], list[dict], list[dict]]:
    """返回 (综述文本, citations, queries, suggests, 文献检索卡行)。

    emit 是可选的**同步**回调：每做完一个真实阶段就推一条 SSE 事件，进度框因此是
    「后端真实阶段」而不是前端假动画。JSON 端点不传 emit，行为与以前完全一致。
    """
    def stage(key, label, pct, detail="", count=None, unit=""):
        if emit:
            emit(_stage(key, label, pct, detail, count, unit))

    stage("queries", "生成检索式", 10, "把研究问题翻成 OpenAlex 英文检索式")
    queries = await _gen_queries(instr)
    if not queries:
        queries = [instr]
    stage("queries", "生成检索式", 20, " · ".join(queries), len(queries), "条")

    stage("search", "检索 OpenAlex", 32, f"{len(queries)} 条检索式并发检索")
    seen: set[str] = set()
    works: list[dict] = []
    raw_hits = 0
    async with httpx.AsyncClient(timeout=30) as client:
        results = await asyncio.gather(
            *(_oa_search(client, q) for q in queries), return_exceptions=True
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
    works = works[:8]
    stage("search", "检索 OpenAlex", 50,
          f"{len(queries)} 条检索式 · 原始命中 {raw_hits} 条", raw_hits, "条")

    stage("dedupe", "去重并写入文献库", 60,
          f"按 OpenAlex ID / 归一化标题去重，保留 {len(works)} 篇")
    citations: list[dict] = []
    papers: list[dict] = []
    src_lines: list[str] = []
    for i, w in enumerate(works, 1):
        meta = _parse_oa_work(w)
        lit_id, _created = _find_or_create_lit(meta)  # 命中即入文献库（去重）
        meta["lit_id"] = lit_id
        meta["n"] = i
        citations.append(meta)
        papers.append(_paper_hit(w, i, lit_id, queries))
        src_lines.append(
            f"[{i}] {meta['title']} — {meta['authors'] or '佚名'} ({meta['year'] or 'n.d.'}) "
            f"| {meta['venue'] or ''} | 被引 {meta['cited_by_count']} | doi:{meta['doi'] or '无'}"
        )
    stage("dedupe", "去重并写入文献库", 72,
          f"已入库 {len(citations)} 篇 · 生成文献检索卡", len(citations), "篇")
    if emit:
        emit({"type": "papers", "papers": papers, "total": len(papers),
              "query_count": len(queries), "raw_hits": raw_hits})

    stage("write", "撰写深度综述", 84, "只允许引用上面命中的真实来源，标注 [n]")
    env = await llm.complete_with_meta(
        f"研究问题：{instr}\n\n"
        f"检索式：{'；'.join(queries)}\n\n"
        "检索命中的来源（只允许引用这些，标注 [n]）：\n" + "\n".join(src_lines) + "\n\n"
        "请写一段深度检索综述：先 2-3 句结论（这个方向的研究现状一句话概括），"
        "再分点讲主要脉络与代表工作（每个论点后标 [n]），"
        "最后指出这些来源组合起来暴露出的研究空白。中文为主，可混英文术语。"
        "如果来源不足以支撑某个判断，直接说「检索结果未覆盖」。"
        "结尾另起一行输出：\nSUGGESTS: 后续指令1 | 后续指令2",
        system=RESEARCH_SYSTEM,
        mode="fast",
        task="rchat:deep",
        max_tokens=2200,
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
    return text, citations, queries, suggests, papers


async def _write_report(sid: int, emit=None) -> tuple[str, list[dict], list[str]]:
    """把整段会话浓缩成结构化 Markdown 报告。返回 (md, citations, suggests)。"""
    def stage(key, label, pct, detail="", count=None, unit=""):
        if emit:
            emit(_stage(key, label, pct, detail, count, unit))

    stage("collect", "汇总会话与引用", 20, "读取本会话历史消息与已命中的参考文献")
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
    stage("collect", "汇总会话与引用", 40,
          f"共收集 {len(cits)} 条参考文献", len(cits), "条")
    refs = "\n".join(
        f"[{c['n']}] {c.get('title')} — {c.get('authors') or '佚名'} ({c.get('year') or 'n.d.'})"
        for c in cits
    )
    stage("write", "撰写结构化报告", 62, "结论先行 · 证据范围 · 主要脉络 · 研究空白")
    env = await llm.complete_with_meta(
        "以下是本会话的完整对话与检索到的参考文献。请写一份结构化中文 Markdown 报告：\n"
        "# 标题（根据主题起）\n"
        "## 结论先行（3-5 条要点）\n## 证据范围（基于哪些来源，[n] 引用）\n"
        "## 主要脉络（分点，引用标注 [n]）\n## 研究空白与下一步\n\n"
        "要求：结论先行；每条主张都要有对话里的依据或 [n] 引用；"
        "没有依据的地方明写「会话中未覆盖」；不要编造文献或数字。\n\n"
        "=== 对话记录 ===\n" + _hist_text(sid, limit=30) + "\n\n=== 参考文献 ===\n" + (refs or "（无）"),
        system=RESEARCH_SYSTEM,
        mode="fast",
        task="rchat:report",
        max_tokens=3000,
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
    stage("write", "撰写结构化报告", 92, "报告正文完成")
    return md, cits, suggests


# ---------------------------------------------------------------- 两种 chat 端点共用的落库


def _prepare_user(sid: int, instr: str, mode: str, tag: str | None):
    """插入用户消息 + 首条消息自动起标题。JSON / SSE 两个端点共用，避免重复落库。"""
    execute(
        "INSERT INTO rchat_messages (session_id, role, kind, content, meta, created_at) VALUES (?,?,?,?,?,?)",
        (sid, "user", "text", instr,
         json.dumps({"tag": tag or ("深度检索" if mode == "deep" else "报告撰写" if mode == "report" else "研究对话")},
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


async def _run_modes(sid: int, instr: str, mode: str, emit, t0: float):
    """执行 auto / deep / report，返回 (env, kind, content, meta)。emit=None 时无阶段事件。"""
    env: dict = {}
    kind = "text"
    content = ""
    meta: dict = {}
    if mode == "deep":
        kind = "deep"
        text, citations, queries, suggests, _papers = await _deep_search(instr, emit)
        content = text
        meta = {"citations": citations, "queries": queries, "suggests": suggests}
    elif mode == "report":
        kind = "report"
        md, citations, suggests = await _write_report(sid, emit)
        content = md
        meta = {"citations": citations, "suggests": suggests}
    else:
        if emit:
            emit(_stage("context", "整理会话上下文", 25, "读取最近对话"))
        env = await llm.complete_with_meta(
            f"最近对话：\n{_hist_text(sid) or '（无）'}\n\n用户的新消息：{instr}\n\n"
            "直接回答（结论先行，不寒暄）。结尾另起一行输出：\n"
            "SUGGESTS: 后续指令1 | 后续指令2（用户可能追问的、可整句直接发送）",
            system=RESEARCH_SYSTEM,
            mode="fast",
            task="rchat:auto",
            max_tokens=1600,
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
        meta = {"suggests": suggests}
        if emit:
            emit(_stage("answer", "生成回答", 90, "结论先行 · 附后续建议"))
    return env, kind, content, meta


@router.post("/sessions/{sid}/chat")
async def chat(sid: int, body: ChatIn):
    """普通 JSON 端点：保留给非流式调用方；/research 已改用下面的 SSE 流式端点。"""
    _session(sid)
    instr = (body.instruction or "").strip()
    if not instr:
        raise HTTPException(400, "说点什么")
    mode = body.mode if body.mode in ("auto", "deep", "report") else "auto"
    t0 = time.monotonic()
    _prepare_user(sid, instr, mode, body.tag)
    env, kind, content, meta = await _run_modes(sid, instr, mode, None, t0)
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
    mode = body.mode if body.mode in ("auto", "deep", "report") else "auto"

    q: asyncio.Queue[dict | None] = asyncio.Queue()

    def emit(ev: dict) -> None:
        q.put_nowait(ev)

    async def run() -> None:
        t0 = time.monotonic()
        try:
            _prepare_user(sid, instr, mode, body.tag)
            emit(_stage("start", "任务已接收", 4, instr[:100]))
            env, kind, content, meta = await _run_modes(sid, instr, mode, emit, t0)
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
