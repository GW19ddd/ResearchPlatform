"""论文速递（对标 paperdance.org）：像刷短视频一样刷 arXiv 论文。

三条数据来源：
- arXiv API 拉取：按设置的学科（cat:cs.LG 等）+ 研究方向关键词过滤最新论文；
- 邮箱投喂：IMAP 轮询收件箱，解析邮件里的 arXiv 链接 / 标题摘要，进卡片流；
- 手动粘贴：POST ingest，把转发邮件正文 / BibTeX 粘进来也能识别。

设计取舍：
- arxiv_id 唯一，三个渠道都走 INSERT OR IGNORE，同一篇论文只落一次库；
- 拉取与邮件轮询都是同步阻塞的 best-effort：网络失败只返回错误信息，不炸服务；
- 图抓取尝试 arxiv.org/html 的第一张正文图（paperdance 式「摘要 + 图」卡片），
  抓不到就不带图，绝不虚构。
"""
from __future__ import annotations

import email
import imaplib
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

import auth as auth_core
from config import DATA_DIR
from db import execute, now, query

router = APIRouter(prefix="/api/paperfeed", tags=["paperfeed"])

SETTINGS_KEY = "paperfeed"
ARXIV_API = "http://export.arxiv.org/api/query"
ARXIV_HTML = "https://arxiv.org/html/{}"
AR5IV_HTML = "https://ar5iv.labs.arxiv.org/html/{}"

# 论文图本地缓存：浏览器直连 arxiv.org 常加载失败（网络/防盗链），
# 前端 img 一律走 /api/paperfeed/fig/{id}，由后端下载一次后从磁盘回源。
FIG_CACHE_DIR = DATA_DIR / "paperfeed_figs"

# 抓图时跳过的图片关键词（logo / 图标 / 装饰）
_FIG_BLOCKLIST = ("logo", "icon", "favicon", "banner", "spinner", "avatar", "badge")
_FIG_EXT_OK = (".png", ".jpg", ".jpeg", ".webp", ".gif")


def _sys_proxy() -> str | None:
    """读 Windows 系统代理（注册表）。服务器进程没有环境变量代理，
    而 arXiv 直连基本被墙，必须走系统代理才有机会通。"""
    try:
        import winreg

        k = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        )
        if not winreg.QueryValueEx(k, "ProxyEnable")[0]:
            return None
        server = str(winreg.QueryValueEx(k, "ProxyServer")[0])
        if "=" in server:  # per-protocol 形式：http=...;https=...
            picked = ""
            for part in server.split(";"):
                if part.startswith(("http=", "https=")):
                    picked = part.split("=", 1)[1]
                    break
            server = picked
        if not server:
            return None
        return server if server.startswith("http") else f"http://{server}"
    except Exception:  # noqa: BLE001 —— 非 Windows / 读不到就当没代理
        return None


def _fetch(url: str, timeout: float = 20.0) -> httpx.Response | None:
    """直连 → 系统代理 双路请求，先成功者胜；都失败返回 None。"""
    last_exc: Exception | None = None
    for kw in ({}, {"proxy": _sys_proxy()}):
        try:
            return httpx.get(url, timeout=timeout, follow_redirects=True, **kw)
        except Exception as e:  # noqa: BLE001 —— 换下一条路
            last_exc = e
    del last_exc
    return None

# 设置页可选的常用 arXiv 学科（够用就好，用户也可以手填）
SUBJECT_OPTIONS = [
    "cs.LG", "cs.CL", "cs.AI", "cs.CV", "cs.SE", "cs.CR", "cs.PL", "cs.DC",
    "stat.ML", "math.OC", "eess.SP", "eess.AS", "cs.HC", "cs.IR",
]

MAX_ABSTRACT = 4000
MAX_TITLE = 300


# ------------------------------------------------------------------ 设置


def _get_settings_raw() -> dict:
    rows = query("SELECT value FROM settings WHERE key=?", (SETTINGS_KEY,))
    if not rows or not rows[0]["value"]:
        return {}
    try:
        import json

        return json.loads(rows[0]["value"])
    except Exception:  # noqa: BLE001
        return {}


def _save_settings_raw(data: dict) -> None:
    import json

    execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (SETTINGS_KEY, json.dumps(data, ensure_ascii=False)),
    )


class FeedSettings(BaseModel):
    subjects: list[str] = []
    keywords: str = ""
    email: str = ""
    imap_host: str = ""
    imap_port: int = 993
    imap_user: str = ""
    imap_pass: str = ""
    language: str = "both"  # zh 中文 / en 英文 / both 双语


LANGS = {"zh", "en", "both"}


@router.get("/subjects")
def subject_options():
    return {"options": SUBJECT_OPTIONS}


@router.get("/settings")
def get_settings():
    s = _get_settings_raw()
    # 密码不回传明文，只回传「已配置」标记
    s["imap_pass"] = "***" if s.get("imap_pass") else ""
    s["has_imap_pass"] = bool(s.get("imap_pass_set"))
    s.pop("imap_pass_set", None)
    return s


@router.put("/settings")
def put_settings(body: FeedSettings):
    cur = _get_settings_raw()
    subjects = [str(x).strip() for x in (body.subjects or []) if str(x).strip()][:8]
    cur["subjects"] = subjects
    cur["keywords"] = str(body.keywords or "").strip()[:200]
    cur["email"] = str(body.email or "").strip()[:200]
    cur["imap_host"] = str(body.imap_host or "").strip()[:200]
    cur["imap_port"] = int(body.imap_port or 993)
    cur["imap_user"] = str(body.imap_user or "").strip()[:200]
    # 密码：前端回传 *** 表示没改，留旧值；传了新值才覆盖
    pw = str(body.imap_pass or "")
    if pw and pw != "***":
        cur["imap_pass"] = pw
    cur["language"] = body.language if body.language in LANGS else "both"
    _save_settings_raw(cur)
    return {"ok": True}


# ------------------------------------------------------------------ 落库


def _upsert_paper(p: dict, source: str) -> bool:
    """插入一篇论文；arxiv_id 或 标题重复时跳过。返回是否真的插入。"""
    title = (p.get("title") or "").strip()[:MAX_TITLE]
    if not title:
        return False
    arxiv_id = (p.get("arxiv_id") or "").strip() or None
    if arxiv_id:
        hit = query("SELECT id FROM paperfeed_papers WHERE arxiv_id=?", (arxiv_id,))
        if hit:
            return False
    else:
        hit = query("SELECT id FROM paperfeed_papers WHERE title=?", (title,))
        if hit:
            return False
    execute(
        """INSERT INTO paperfeed_papers
           (arxiv_id, title, authors, abstract, cats, primary_cat, figure_url,
            link, published, source, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            arxiv_id,
            title,
            (p.get("authors") or "")[:1000],
            (p.get("abstract") or "")[:MAX_ABSTRACT],
            (p.get("cats") or "")[:200],
            (p.get("primary_cat") or "")[:60],
            (p.get("figure_url") or "")[:600],
            (p.get("link") or "")[:600],
            (p.get("published") or "")[:40],
            source,
            now(),
        ),
    )
    return True


# ------------------------------------------------------------------ arXiv 拉取


_NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def _parse_atom(text: str) -> list[dict]:
    root = ET.fromstring(text)
    out = []
    for entry in root.findall("a:entry", _NS):
        eid = (entry.findtext("a:id", "", _NS) or "").strip()
        m = re.search(r"abs/([^v]+)(v\d+)?$", eid)
        aid = m.group(1).strip() if m else eid.rsplit("/", 1)[-1]
        authors = [
            (a.findtext("a:name", "", _NS) or "").strip()
            for a in entry.findall("a:author", _NS)
        ]
        cats = " ".join(
            sorted({c.get("term", "") for c in entry.findall("a:category", _NS) if c.get("term")})
        )
        out.append(
            {
                "arxiv_id": aid,
                "title": re.sub(r"\s+", " ", entry.findtext("a:title", "", _NS)).strip(),
                "abstract": re.sub(r"\s+", " ", entry.findtext("a:summary", "", _NS)).strip(),
                "authors": ", ".join(a for a in authors if a),
                "cats": cats,
                "primary_cat": (entry.find("arxiv:primary_category", _NS).get("term", "") if entry.find("arxiv:primary_category", _NS) is not None else (cats.split(" ")[0] if cats else "")),
                "link": f"https://arxiv.org/abs/{aid}",
                "published": (entry.findtext("a:published", "", _NS) or "")[:10],
            }
        )
    return out


# 允许的 SVG 封面暗示词（只在这些词出现在文件名里时才把 svg 当正文图，
# 避免把 logo/图标/公式 svg 当封面）
_FIG_OK_SVG_HINTS = ("fig", "figure", "plot", "diagram", "graph", "image", "img", "draw", "chart", "panel")


def _pick_fig_url(src: str, base: str) -> str:
    """把 img 地址归一化成绝对 URL（标准 urljoin 规则）；不像正文图的返回空串。"""
    from urllib.parse import urljoin

    src = (src or "").strip()
    low = src.lower()
    if not src or low.startswith("data:"):
        return ""
    if any(k in low for k in _FIG_BLOCKLIST):
        return ""
    is_svg = low.endswith(".svg")
    if is_svg:
        # 仅当文件名含正文图暗示词时才允许 svg 当封面
        if not any(h in low for h in _FIG_OK_SVG_HINTS):
            return ""
    elif not low.endswith(_FIG_EXT_OK):
        return ""
    try:
        u = urljoin(base, src)
    except Exception:  # noqa: BLE001
        return ""
    return u if u.startswith("http") else ""


def _img_real_url(tag: str, base: str) -> str:
    """从一段 <img> 标签里取出真实图地址：优先 src，再退 data-src / data-lazy-src /
    data-original / data-orig-src / data-srcset（arXiv 新版常用 JS 懒加载把真实地址放 data-*）。"""
    for attr in ("src", "data-src", "data-lazy-src", "data-original", "data-orig-src"):
        m = re.search(rf'{attr}\s*=\s*"([^"]+)"', tag, re.I)
        if m and m.group(1).strip():
            u = _pick_fig_url(m.group(1).strip(), base)
            if u:
                return u
    # data-srcset: "url 1x, url2 2x"
    ms = re.search(r'data-srcset\s*=\s*"([^"]+)"', tag, re.I)
    if ms:
        for part in ms.group(1).split(","):
            part = part.strip()
            url = part.split()[0] if part else ""
            if url:
                u = _pick_fig_url(url, base)
                if u:
                    return u
    return ""


def _extract_figure(html: str, base: str) -> str:
    """从 HTML 里挑第一张正文图：优先 <figure> 块内的图（含懒加载属性），
    再退回全部 img。绝不用 PDF 截图。"""
    # 1) <figure> 块优先：HTML5 figure 内基本就是正文图
    for m in re.finditer(r"<figure[\s\S]*?</figure>", html, re.I):
        for im in re.finditer(r"<img\b[^>]*>", m.group(0), re.I):
            u = _img_real_url(im.group(0), base)
            if u:
                return u
    # 2) 退化为全部 img（按出现顺序取第一张像样的）
    candidates: list[str] = []
    for im in re.finditer(r"<img\b[^>]*>", html, re.I):
        u = _img_real_url(im.group(0), base)
        if u and u not in candidates:
            candidates.append(u)
    return candidates[0] if candidates else ""


def _grab_figure(arxiv_id: str) -> str:
    """抓论文正文第一张图，作为卡片封面。先试 arXiv 官方 HTML 版，
    404 再退 ar5iv。base 用重定向后的最终 URL，相对路径才能拼对。
    best-effort：抓不到就空着，绝不虚构。"""
    for template in (ARXIV_HTML, AR5IV_HTML):
        base = template.format(arxiv_id)
        try:
            r = _fetch(base, timeout=12)
            if r is None or r.status_code != 200 or not r.text:
                continue
            fig = _extract_figure(r.text, str(r.url))
            if fig:
                return fig
        except Exception:  # noqa: BLE001 —— 单源失败换下一个
            continue
    return ""


def _build_query(subjects: list[str], keywords: str) -> str:
    parts = []
    if subjects:
        parts.append("(" + " OR ".join(f"cat:{s}" for s in subjects) + ")")
    kws = [k.strip() for k in re.split(r"[,，;；|\s]+", keywords or "") if k.strip()]
    if kws:
        parts.append("(" + " OR ".join(f'all:"{k}"' for k in kws[:6]) + ")")
    return " AND ".join(parts) if parts else ""


@router.post("/fetch")
def fetch_arxiv():
    s = _get_settings_raw()
    subjects = s.get("subjects") or []
    keywords = s.get("keywords") or ""
    q = _build_query(subjects, keywords)
    if not q:
        raise HTTPException(400, "先在设置里选学科或填研究方向")
    params = {
        "search_query": q,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
        "max_results": 40,
    }
    try:
        r = _fetch(ARXIV_API + "?" + "&".join(f"{k}={v}" for k, v in params.items()), timeout=30)
        if r is None:
            raise RuntimeError("直连与系统代理均失败")
        r.raise_for_status()
        papers = _parse_atom(r.text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"arXiv 拉取失败：{type(exc).__name__}: {exc}")

    added = 0
    for p in papers:
        if _upsert_paper(p, "arxiv"):
            # 只给真正新入库的论文抓图，老论文不重复消耗请求
            aid = p.get("arxiv_id")
            if aid:
                hit = query("SELECT id FROM paperfeed_papers WHERE arxiv_id=?", (aid,))
                if hit:
                    _fill_figure(hit[0]["id"], aid)
            added += 1
    return {"ok": True, "added": added, "fetched": len(papers)}


def _fill_figure(pid: int, arxiv_id: str) -> bool:
    """给一篇论文确定封面：只抓 arXiv HTML 正文首图（论文自己的配图）。
    抓不到不再兜底渲染 PDF 首页——绝不用论文截图当封面。"""
    fig = _grab_figure(arxiv_id)
    if fig:
        execute(
            "UPDATE paperfeed_papers SET figure_url=?, figure_kind='arxiv' WHERE id=?",
            (fig, pid),
        )
        return True
    return False


@router.post("/figures")
def backfill_figures(limit: int = 24):
    """给缺图的论文批量补抓封面（大厅/卡片流展示需要）。best-effort。
    只补 arXiv 正文首图（论文自己的配图）；无正文图的论文按用户规则显示占位卡，绝不渲染 PDF 截图。"""
    limit = max(1, min(int(limit), 60))
    rows = query(
        """SELECT id, arxiv_id FROM paperfeed_papers
           WHERE figure_url IS NULL OR figure_url=''
           ORDER BY id DESC LIMIT ?""",
        (limit,),
    )
    filled = 0
    for r in rows:
        if not r["arxiv_id"]:
            continue
        if _fill_figure(r["id"], r["arxiv_id"]):
            filled += 1
    return {"ok": True, "filled": filled, "tried": len(rows)}


@router.post("/papers/{pid}/figure")
def fill_paper_figure(pid: int):
    """单篇懒补图：详情页打开时没图就现场抓一次（arXiv 正文图 → PDF 首页兜底）。"""
    rows = query("SELECT id, arxiv_id, figure_url, figure_kind FROM paperfeed_papers WHERE id=?", (pid,))
    if not rows:
        raise HTTPException(404, "论文不存在")
    r = rows[0]
    # 已有图（论文自己的配图）则直接出
    if r["figure_url"]:
        return {"ok": True, "figure_url": r["figure_url"] or "", "cached": True}
    if not r["arxiv_id"]:
        return {"ok": False, "figure_url": "", "msg": "这篇不是 arXiv 论文，抓不到封面"}
    ok = _fill_figure(pid, r["arxiv_id"])
    url = ""
    if ok:
        row = query("SELECT figure_url FROM paperfeed_papers WHERE id=?", (pid,))
        url = row[0]["figure_url"] if row else ""
    return {"ok": ok, "figure_url": url, "msg": "" if ok else "没抓到封面"}


@router.get("/fig/{pid}")
def get_figure(pid: int):
    """论文图代理：只回源论文自己的配图（arXiv HTML 正文首图），本地缓存后回源。
    前端 <img> 一律用这个端点，避免浏览器直连 arxiv.org 加载失败。
    严禁用 PDF 首页截图当封面——figure_kind='pdf' 的行一律 404。"""
    rows = query(
        "SELECT id, figure_url, figure_kind, arxiv_id FROM paperfeed_papers WHERE id=?",
        (pid,),
    )
    if not rows:
        raise HTTPException(404, "论文不存在")
    row = rows[0]
    # 历史遗留的 PDF 截图封面：一律不再展示
    if row["figure_kind"] == "pdf":
        raise HTTPException(404, "图片暂不可用")

    FIG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = FIG_CACHE_DIR / f"{pid}.img"
    meta = FIG_CACHE_DIR / f"{pid}.ct"
    if cache.exists() and cache.stat().st_size > 0 and row["figure_url"]:
        ct = "image/png"
        if meta.exists():
            ct = meta.read_text(encoding="ascii").strip() or ct
        return Response(
            content=cache.read_bytes(),
            media_type=ct,
            headers={"Cache-Control": "public, max-age=604800"},
        )

    # 只回源 arXiv 正文首图（论文自己的配图）
    if row["figure_url"]:
        r = _fetch(row["figure_url"], timeout=25)
        if r is not None and r.status_code == 200 and r.content:
            ct = (r.headers.get("content-type") or "image/png").split(";")[0].strip().lower()
            if ct.startswith("image/"):
                cache.write_bytes(r.content)
                try:
                    meta.write_text(ct, encoding="ascii")
                except Exception:  # noqa: BLE001
                    pass
                return Response(
                    content=r.content,
                    media_type=ct,
                    headers={"Cache-Control": "public, max-age=604800"},
                )

    raise HTTPException(404, "图片暂不可用")


# ------------------------------------------------------------------ 列表 / 反应 / 笔记


@router.get("/papers")
def list_papers(view: str = "inbox", limit: int = 100):
    limit = max(1, min(int(limit), 300))
    where = {
        "inbox": "hidden=0",
        "liked": "liked=1",
        "saved": "saved=1",
        "hidden": "hidden=1",
    }.get(view, "hidden=0")
    rows = query(
        f"""SELECT id, arxiv_id, title, authors, abstract, cats, primary_cat,
                   figure_url, link, published, source, liked, saved, hidden,
                   title_zh, abstract_zh, figure_kind, created_at
            FROM paperfeed_papers WHERE {where}
            ORDER BY id DESC LIMIT {int(limit)}"""
    )
    for r in rows:
        r["liked"] = bool(r["liked"])
        r["saved"] = bool(r["saved"])
        r["hidden"] = bool(r["hidden"])
        n = query("SELECT COUNT(*) c FROM paperfeed_notes WHERE paper_id=?", (r["id"],))
        r["notes_count"] = n[0]["c"] if n else 0
    return rows


class Reaction(BaseModel):
    liked: bool | None = None
    saved: bool | None = None
    hidden: bool | None = None


@router.post("/papers/{pid}/react")
def react(pid: int, body: Reaction):
    row = query("SELECT id FROM paperfeed_papers WHERE id=?", (pid,))
    if not row:
        raise HTTPException(404, "论文不存在")
    sets, args = [], []
    for k in ("liked", "saved", "hidden"):
        v = getattr(body, k)
        if v is not None:
            sets.append(f"{k}=?")
            args.append(1 if v else 0)
    if sets:
        args.append(pid)
        execute(f"UPDATE paperfeed_papers SET {', '.join(sets)} WHERE id=?", args)
    return {"ok": True}


@router.delete("/papers/{pid}")
def delete_paper(pid: int):
    execute("DELETE FROM paperfeed_notes WHERE paper_id=?", (pid,))
    execute("DELETE FROM paperfeed_papers WHERE id=?", (pid,))
    return {"ok": True}


@router.get("/papers/{pid}/notes")
def list_notes(pid: int):
    return query(
        "SELECT id, content, created_at FROM paperfeed_notes WHERE paper_id=? ORDER BY id DESC",
        (pid,),
    )


class NoteIn(BaseModel):
    content: str


# ------------------------------------------------------------------ 中文翻译（LLM，结果缓存进库）

_TRANSLATE_SYSTEM = (
    "你是学术论文翻译助手。把英文论文标题和摘要翻译成准确、通顺的简体中文，"
    "保留专业术语的通用译法。只输出 JSON，不要输出其它内容。"
)


@router.post("/papers/{pid}/translate")
async def translate_paper(pid: int):
    row = query(
        "SELECT id, title, abstract, title_zh, abstract_zh FROM paperfeed_papers WHERE id=?",
        (pid,),
    )
    if not row:
        raise HTTPException(404, "论文不存在")
    r = row[0]
    if r["title_zh"] or r["abstract_zh"]:
        return {"ok": True, "cached": True, "title_zh": r["title_zh"] or "", "abstract_zh": r["abstract_zh"] or ""}
    abstract = (r["abstract"] or "").strip()
    if not abstract:
        raise HTTPException(400, "这篇论文没有摘要可翻译")
    prompt = (
        "请翻译以下论文的标题与摘要为简体中文，输出 JSON：\n"
        '{"title_zh": "标题中文", "abstract_zh": "摘要中文"}\n\n'
        f"Title: {r['title']}\n\nAbstract: {abstract[:3000]}"
    )
    from llm import complete_result

    env = await complete_result(
        prompt,
        system=_TRANSLATE_SYSTEM,
        mode="fast",
        task="paperfeed_translate",
        max_tokens=2400,
    )
    if env.get("ok") is False or not (env.get("content") or "").strip():
        return {"ok": False, "error": (env.get("error") or {}).get("message") or "翻译调用失败"}
    content = env["content"].strip()
    # 剥掉可能的 ```json 围栏，抓第一段 JSON
    m = re.search(r"\{[\s\S]*\}", content)
    if not m:
        return {"ok": False, "error": "模型没有返回可解析的 JSON"}
    try:
        import json

        data = json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": "翻译结果 JSON 解析失败"}
    title_zh = str(data.get("title_zh") or "")[:MAX_TITLE]
    abstract_zh = str(data.get("abstract_zh") or "")[:MAX_ABSTRACT]
    if not (title_zh or abstract_zh):
        return {"ok": False, "error": "翻译结果为空"}
    execute(
        "UPDATE paperfeed_papers SET title_zh=?, abstract_zh=? WHERE id=?",
        (title_zh, abstract_zh, pid),
    )
    return {"ok": True, "cached": False, "title_zh": title_zh, "abstract_zh": abstract_zh}


@router.post("/translate-all")
async def translate_all():
    """批量翻译所有缺中文的论文（标题+摘要），结果缓存进库。供后台预热调用。"""
    rows = query(
        "SELECT id, title, abstract, title_zh, abstract_zh FROM paperfeed_papers "
        "WHERE (title_zh IS NULL OR title_zh='' OR abstract_zh IS NULL OR abstract_zh='') "
        "AND abstract IS NOT NULL AND abstract != ''"
    )
    from llm import complete_result

    done = failed = 0
    for r in rows:
        # 单篇已翻过就跳过
        if r["title_zh"] or r["abstract_zh"]:
            continue
        abstract = (r["abstract"] or "").strip()
        if not abstract:
            continue
        prompt = (
            "请翻译以下论文的标题与摘要为简体中文，输出 JSON：\n"
            '{"title_zh": "标题中文", "abstract_zh": "摘要中文"}\n\n'
            f"Title: {r['title']}\n\nAbstract: {abstract[:3000]}"
        )
        try:
            env = await complete_result(
                prompt,
                system=_TRANSLATE_SYSTEM,
                mode="fast",
                task="paperfeed_translate",
                max_tokens=2400,
            )
        except Exception:  # noqa: BLE001
            failed += 1
            continue
        if env.get("ok") is False or not (env.get("content") or "").strip():
            failed += 1
            continue
        content = env["content"].strip()
        m = re.search(r"\{[\s\S]*\}", content)
        if not m:
            failed += 1
            continue
        try:
            import json

            data = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            failed += 1
            continue
        title_zh = str(data.get("title_zh") or "")[:MAX_TITLE]
        abstract_zh = str(data.get("abstract_zh") or "")[:MAX_ABSTRACT]
        if not (title_zh or abstract_zh):
            failed += 1
            continue
        execute(
            "UPDATE paperfeed_papers SET title_zh=?, abstract_zh=? WHERE id=?",
            (title_zh, abstract_zh, r["id"]),
        )
        done += 1
    return {"ok": True, "done": done, "failed": failed, "total": len(rows)}


@router.post("/papers/{pid}/notes")
def add_note(pid: int, body: NoteIn):
    text = (body.content or "").strip()
    if not text:
        raise HTTPException(400, "笔记内容不能为空")
    if not query("SELECT id FROM paperfeed_papers WHERE id=?", (pid,)):
        raise HTTPException(404, "论文不存在")
    execute(
        "INSERT INTO paperfeed_notes (paper_id, content, created_at) VALUES (?,?,?)",
        (pid, text[:3000], now()),
    )
    return {"ok": True}


# ------------------------------------------------------------------ 邮箱 / 手动投喂


ARXIV_ID_RE = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/|(?<![\d.]))(\d{4}\.\d{4,5})(?:v\d+)?", re.I)


def _ingest_text(text: str) -> int:
    """从一段文本（邮件正文 / 粘贴内容）里识别论文。识别优先级：
    arXiv id（拉真实元数据） > Subject 标题行（存标题）。返回新增篇数。"""
    added = 0
    ids: list[str] = []
    seen: set[str] = set()
    for m in ARXIV_ID_RE.finditer(text or ""):
        aid = m.group(1)
        if aid not in seen:
            seen.add(aid)
            ids.append(aid)
    if ids:
        fetched = False
        try:
            r = _fetch(
                ARXIV_API + f"?id_list={','.join(ids[:10])}&max_results=10",
                timeout=30,
            )
            if r is not None:
                r.raise_for_status()
                for p in _parse_atom(r.text):
                    if _upsert_paper(p, "email"):
                        added += 1
                fetched = True
        except Exception:  # noqa: BLE001 —— 网络不稳时不能把论文丢掉
            pass
        if not fetched:
            # 元数据拉不到（arXiv 偶发不通）也要入库：至少记下 id 和链接，
            # arxiv_id 唯一约束保证网络恢复后重复投喂不会插重
            for aid in ids:
                title_m = re.search(r"^(?:subject|标题|题目)[:：]\s*(.+)$", text or "", re.I | re.M)
                _upsert_paper(
                    {
                        "arxiv_id": aid,
                        "title": (title_m.group(1).strip() if title_m else f"arXiv:{aid}")[:MAX_TITLE],
                        "abstract": "",
                        "link": f"https://arxiv.org/abs/{aid}",
                    },
                    "email",
                )
                added += 1
        return added
    # 兜底：把「Subject: …」或第一行当标题，其余当摘要
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    title = ""
    for ln in lines:
        if re.match(r"^(subject|标题|题目)[:：]", ln, re.I):
            title = re.sub(r"^(subject|标题|题目)[:：]\s*", "", ln, flags=re.I)
            break
    if not title and lines:
        title = lines[0]
    title = title[:MAX_TITLE]
    if title:
        abstract = " ".join(lines[1:])[:MAX_ABSTRACT]
        added += 1 if _upsert_paper({"title": title, "abstract": abstract}, "email") else 0
    return added


class IngestIn(BaseModel):
    text: str


@router.post("/ingest")
def ingest_text(body: IngestIn):
    n = _ingest_text(body.text or "")
    if not n:
        return {"ok": True, "added": 0, "msg": "没有识别出论文（支持 arXiv 链接 / id）"}
    return {"ok": True, "added": n}


@router.post("/poll_email")
def poll_email():
    s = _get_settings_raw()
    host = s.get("imap_host") or ""
    user = s.get("imap_user") or ""
    pw = s.get("imap_pass") or ""
    if not (host and user and pw):
        raise HTTPException(400, "先在设置里填 IMAP 服务器、账号和授权码")
    port = int(s.get("imap_port") or 993)
    added = 0
    scanned = 0
    conn = None
    try:
        conn = imaplib.IMAP4_SSL(host, port) if port == 993 else imaplib.IMAP4(host, port)
        conn.login(user, pw)
        conn.select("INBOX")
        status, data = conn.search(None, "UNSEEN")
        if status != "OK":
            raise RuntimeError("IMAP search 失败")
        for num in data[0].split()[:20]:
            scanned += 1
            status, msg_data = conn.fetch(num, "(RFC822)")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue
            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)
            body = _email_body(msg)
            text = f"Subject: {msg.get('Subject', '')}\n{body}"
            try:
                added += _ingest_text(text)
            except Exception:  # noqa: BLE001 —— 单封解析失败不影响其它邮件
                pass
            conn.store(num, "+FLAGS", "\\Seen")
    except imaplib.IMAP4.error as exc:
        raise HTTPException(502, f"IMAP 登录/读取失败：{exc}（邮箱需要开 IMAP 并用授权码）")
    finally:
        if conn:
            try:
                conn.logout()
            except Exception:  # noqa: BLE001
                pass
    return {"ok": True, "added": added, "scanned": scanned}


def _email_body(msg) -> str:
    """取邮件正文文本：优先 text/plain，退回 text/html 剥标签。"""
    parts = []
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct in ("text/plain", "text/html"):
                try:
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        parts.append((ct, payload.decode(charset, "replace")))
                except Exception:  # noqa: BLE001
                    pass
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            parts.append((msg.get_content_type(), payload.decode(charset, "replace")))
    for ct, text in parts:
        if ct == "text/plain":
            return text
    # html 兜底：剥掉标签留文本
    for ct, text in parts:
        if ct == "text/html":
            return re.sub(r"<[^>]+>", " ", text)
    return ""
