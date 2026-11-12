"""论文速递（对标 paperdance.org）：像刷短视频一样刷 arXiv 论文。

三条数据来源：
- arXiv API 拉取：按设置的学科（cat:cs.LG 等）+ 研究方向关键词过滤最新论文；
- 邮箱投喂：IMAP 轮询收件箱，解析邮件里的 arXiv 链接 / 标题摘要，进卡片流；
- 手动粘贴：POST ingest，把转发邮件正文 / BibTeX 粘进来也能识别。

设计取舍：
- arxiv_id 唯一，三个渠道都走 INSERT OR IGNORE，同一篇论文只落一次库；
- 拉取与邮件轮询都是同步阻塞的 best-effort：网络失败只返回错误信息，不炸服务；
- 图抓取四层兜底（保证每张卡都有图）：arXiv HTML 正文 img → <object> 矢量图 →
  figure 块内嵌 svg（本地保存）→ PDF 首页渲染（没有 HTML 版的论文，渲染的是
  论文自己的第一页）。
"""
from __future__ import annotations

import email
import imaplib
import re
import threading
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
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


_PROXY_CACHE: str | None = None  # None=还没读过注册表；""=无代理


def _sys_proxy() -> str | None:
    """读 Windows 系统代理（注册表，结果缓存——补图并行时每次读注册表很浪费）。
    服务器进程没有环境变量代理，而 arXiv 直连基本被墙，必须走系统代理才有机会通。"""
    global _PROXY_CACHE
    if _PROXY_CACHE is not None:
        return _PROXY_CACHE or None
    result: str | None = None
    try:
        import winreg

        k = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        )
        if not winreg.QueryValueEx(k, "ProxyEnable")[0]:
            result = None
        else:
            server = str(winreg.QueryValueEx(k, "ProxyServer")[0])
            if "=" in server:  # per-protocol 形式：http=...;https=...
                picked = ""
                for part in server.split(";"):
                    if part.startswith(("http=", "https=")):
                        picked = part.split("=", 1)[1]
                        break
                server = picked
            if server:
                result = server if server.startswith("http") else f"http://{server}"
    except Exception:  # noqa: BLE001 —— 非 Windows / 读不到就当没代理
        result = None
    _PROXY_CACHE = result or ""
    return result


# 记住最近一次成功的请求路径（"direct"/"proxy"），下次先走它——
# arXiv 直连基本必败，每次先试直连会白白多等一个超时
_ROUTE: list[str] = ["direct", "proxy"]
_ROUTE_LOCK = threading.Lock()


def _fetch(url: str, timeout: float = 20.0, headers: dict | None = None) -> httpx.Response | None:
    """双路请求（直连 → 系统代理），按最近成功率动态排序：成功路径提前、
    失败路径沉底——arXiv 直连必败的环境里，最多白等一次超时就永久代理优先。"""
    with _ROUTE_LOCK:
        order = list(_ROUTE)
    for path in order:
        kw: dict = {} if path == "direct" else {"proxy": _sys_proxy()}
        try:
            r = httpx.get(url, timeout=timeout, follow_redirects=True,
                          headers=headers or None, **kw)
            if _ROUTE and _ROUTE[0] != path:
                with _ROUTE_LOCK:
                    _ROUTE[:] = [path] + [p for p in _ROUTE if p != path]
            return r
        except Exception:  # noqa: BLE001 —— 失败路径沉底，下次先走另一条
            with _ROUTE_LOCK:
                if path in _ROUTE:
                    _ROUTE[:] = [p for p in _ROUTE if p != path] + [path]
            continue
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


@router.get("/status")
def feed_status():
    """给前端判断是否需要实时拉取：论文总数、上次 arXiv 拉取时间、是否已配学科/关键词。"""
    cnt = query("SELECT COUNT(*) c FROM paperfeed_papers")
    s = _get_settings_raw()
    return {
        "count": cnt[0]["c"] if cnt else 0,
        "last_fetch_at": s.get("last_fetch_at") or None,
        "has_query": bool((s.get("subjects") or []) or (s.get("keywords") or "").strip()),
    }


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
    """从 HTML 里挑第一张正文图，三层找：
    1) <figure> 块内的 <img>（含懒加载属性）；
    2) <figure> 块内的 <object type="image/svg+xml" data="...">——LaTeXML（arXiv
       新 HTML 版）把矢量图挂 object 标签上，不产生 <img>，漏掉它就漏掉一半论文；
    3) 全页 img / 全页 object 退化兜底。
    绝不用 PDF 截图。"""
    # 1) <figure> 块优先：HTML5 figure 内基本就是正文图
    for m in re.finditer(r"<figure[\s\S]*?</figure>", html, re.I):
        for im in re.finditer(r"<img\b[^>]*>", m.group(0), re.I):
            u = _img_real_url(im.group(0), base)
            if u:
                return u
    # 1.5) figure 块内的 object svg（LaTeXML 矢量图）
    for m in re.finditer(r"<figure[\s\S]*?</figure>", html, re.I):
        for ob in re.finditer(r"<object\b[^>]*>", m.group(0), re.I):
            u = _obj_svg_url(ob.group(0), base)
            if u:
                return u
    # 2) 退化为全部 img（按出现顺序取第一张像样的）
    candidates: list[str] = []
    for im in re.finditer(r"<img\b[^>]*>", html, re.I):
        u = _img_real_url(im.group(0), base)
        if u and u not in candidates:
            candidates.append(u)
    if candidates:
        return candidates[0]
    # 3) 全页 object svg 兜底
    for ob in re.finditer(r"<object\b[^>]*>", html, re.I):
        u = _obj_svg_url(ob.group(0), base)
        if u:
            return u
    return ""


def _obj_svg_url(tag: str, base: str) -> str:
    """<object type="image/svg+xml" data="..."> 里的矢量图地址。
    type 已声明是 image/svg+xml（在论文正文里），不再要求文件名含 figure 暗示词，
    只挡 logo / 图标。"""
    from urllib.parse import urljoin

    m = re.search(r'data\s*=\s*"([^"]+)"', tag, re.I)
    src = (m.group(1) if m else "").strip()
    if not src or src.lower().startswith("data:"):
        return ""
    if any(k in src.lower() for k in _FIG_BLOCKLIST):
        return ""
    tm = re.search(r'type\s*=\s*"([^"]+)"', tag, re.I)
    ctype = (tm.group(1) if tm else "").lower()
    if "svg" not in ctype and not src.lower().endswith(".svg"):
        return ""
    try:
        u = urljoin(base, src)
    except Exception:  # noqa: BLE001
        return ""
    return u if u.startswith("http") else ""


def _extract_inline_svg(html: str) -> str:
    """提取第一个 <figure> 块里内嵌的 <svg>（LaTeXML 把 TikZ/pgfplots 矢量图
    直接渲染成内联 svg 标签，没有独立图片 URL）。返回可直接保存成 .svg 文件
    的标记，空串=没有。只认 <figure> 块内的 svg，避免抓到行内数学公式。"""
    for m in re.finditer(r"<figure[\s\S]*?</figure>", html, re.I):
        s = re.search(r"<svg\b[\s\S]*?</svg>", m.group(0), re.I)
        if s:
            svg = s.group(0)
            if "xmlns" not in svg[:300]:
                svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
            return svg
    return ""


# 只要 HTML 开头 256KB：正文第一张图几乎总在摘要/引言附近（页面头部），
# 完整 HTML 有 1~3MB，走代理整页下载是补图慢的主因——Range 截断后单页只要 ~1s
_RANGE_HEADERS = {"Range": "bytes=0-262143"}


def _grab_figure(arxiv_id: str) -> tuple[str, bool, str]:
    """抓论文正文第一张图，作为卡片封面。三层：arXiv HTML img → object/内嵌 svg
    （ar5iv 兜底）。截断页（Range 256KB）里没找到时再用完整页重试一次——
    有些论文第一个 figure 在第 3 节之后，可能落在截断窗口外。
    返回 (图URL, 是否拿到过页面, 内嵌svg标记)。saw_page 用于区分「确认没图」
    与「网络失败」——只有前者才允许打 none 标记放弃。best-effort，绝不虚构。"""
    saw_page = False
    for template in (ARXIV_HTML, AR5IV_HTML):
        base = template.format(arxiv_id)
        try:
            r = _fetch(base, timeout=8, headers=_RANGE_HEADERS)
            if r is None or r.status_code not in (200, 206) or not r.text:
                continue
            saw_page = True
            fig = _extract_figure(r.text, str(r.url))
            if fig:
                return fig, True, ""
            svg = _extract_inline_svg(r.text)
            if svg:
                return "", True, svg
            # 截断页一无所获 → 完整页再试一次（figure 可能在页面后半段）
            if r.status_code == 206:
                r2 = _fetch(base, timeout=15)
                if r2 is not None and r2.status_code == 200 and r2.text:
                    fig = _extract_figure(r2.text, str(r2.url))
                    if fig:
                        return fig, True, ""
                    svg = _extract_inline_svg(r2.text)
                    if svg:
                        return "", True, svg
        except Exception:  # noqa: BLE001 —— 单源失败换下一个
            continue
    return "", saw_page, ""


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
    added_ids: list[str] = []
    for p in papers:
        if _upsert_paper(p, "arxiv"):
            added_ids.append(p.get("arxiv_id") or "")
            added += 1
    # 记时间戳（先落，再后台预热封面，保证 fetch 永远秒回）
    s = _get_settings_raw()
    s["last_fetch_at"] = now()
    _save_settings_raw(s)
    # 后台并行预热新论文封面：不阻塞本次响应，用户刷到的卡片随后陆续有图
    if added_ids:
        threading.Thread(target=_warm_covers_bg, args=(added_ids,), daemon=True).start()
    return {"ok": True, "added": added, "fetched": len(papers), "last_fetch_at": s["last_fetch_at"]}


def _warm_covers_bg(arxiv_ids: list[str]) -> None:
    """后台线程：给刚拉取入库的论文并行补抓正文首图（best-effort，失败静默）。"""
    try:
        rows = query(
            """SELECT id, arxiv_id FROM paperfeed_papers
               WHERE (figure_url IS NULL OR figure_url='')
                 AND (figure_kind IS NULL OR figure_kind != 'none')"""
        )
        todo = [(r["id"], r["arxiv_id"]) for r in rows if r["arxiv_id"] in set(arxiv_ids)]
        _BATCH_FIG_RUNNING.set()
        try:
            _parallel_fill(todo)
        finally:
            _BATCH_FIG_RUNNING.clear()
    except Exception:  # noqa: BLE001
        pass


def _parallel_fill(pairs: list[tuple[int, str]], workers: int = 16) -> int:
    """并行给 (pid, arxiv_id) 列表补图。arXiv 能承受温和并发；配合 Range 只拉
    页面开头 256KB，单页 ~1s，16 线程把 100 篇的补图压到 ~10 秒内。
    写库用独立连接，避免跨线程共用。"""
    if not pairs:
        return 0
    filled = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_fill_figure, pid, aid): pid for pid, aid in pairs}
        for _ in as_completed(futs):
            pass
    # 统计实际有图的数量
    ids = [pid for pid, _ in pairs]
    marks = ",".join("?" * len(ids))
    row = query(f"SELECT COUNT(*) AS n FROM paperfeed_papers WHERE id IN ({marks}) AND figure_url IS NOT NULL AND figure_url!=''", ids)  # noqa: S608
    filled = row[0]["n"] if row else 0
    return filled


def _fill_figure(pid: int, arxiv_id: str) -> bool:
    """给一篇论文确定封面，四层逐级兜底（保证每张卡都有图）：
    ① arXiv HTML 正文 <img>；② <object> 引用的矢量图；③ figure 块内嵌 <svg>
    （TikZ 图，保存为本地 svg 文件）；④ PDF 首页渲染（论文自己的第一页，
    含标题/摘要/首图——没有 HTML 版的论文只有这条路）。
    全部失败：页面确认拿到的才打 none 标记，网络失败留着重试。"""
    fig, saw_page, svg = _grab_figure(arxiv_id)
    if fig:
        execute(
            "UPDATE paperfeed_papers SET figure_url=?, figure_kind='arxiv' WHERE id=?",
            (fig, pid),
        )
        return True
    if svg:
        # 内嵌矢量图：直接落本地缓存，figure_url 记标记（/fig 从缓存出）
        try:
            FIG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            (FIG_CACHE_DIR / f"{pid}.img").write_text(svg, encoding="utf-8")
            (FIG_CACHE_DIR / f"{pid}.ct").write_text("image/svg+xml", encoding="ascii")
        except Exception:  # noqa: BLE001 —— 落盘失败就走 PDF 兜底
            svg = ""
        if svg:
            execute(
                "UPDATE paperfeed_papers SET figure_url=?, figure_kind='arxiv' WHERE id=?",
                (f"inline-svg:{pid}", pid),
            )
            return True
    # ④ PDF 首页渲染兜底（论文自己的第一页，不是外部截图）
    status = _render_pdf_cover(pid, arxiv_id)
    if status == "ok":
        return True
    if status == "bad":
        # HTML 页面和 PDF 都到手过但确实一张图都拿不到才放弃；
        # 'nofetch' 是网络失败，留着重试
        execute(
            "UPDATE paperfeed_papers SET figure_kind='none' WHERE id=? AND (figure_url IS NULL OR figure_url='')",
            (pid,),
        )
    return False


def _render_pdf_cover(pid: int, arxiv_id: str) -> str:
    """下载论文 PDF、渲染第一页为 PNG 封面（论文自己的首页）。
    返回 'ok' 成功 / 'nofetch' 网络失败（留着重试）/ 'bad' 拿到了但渲染失败。"""
    try:
        r = _fetch(f"https://arxiv.org/pdf/{arxiv_id}", timeout=40)
    except Exception:  # noqa: BLE001
        return "nofetch"
    if r is None or r.status_code != 200:
        return "nofetch"
    if not r.content:
        return "bad"
    try:
        import io

        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(io.BytesIO(r.content))
        if len(doc) == 0:
            return "bad"
        page = doc[0]
        bitmap = page.render(scale=1.5)
        img = bitmap.to_pil().convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
    except Exception:  # noqa: BLE001
        return "bad"
    try:
        FIG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (FIG_CACHE_DIR / f"{pid}.img").write_bytes(data)
        (FIG_CACHE_DIR / f"{pid}.ct").write_text("image/png", encoding="ascii")
    except Exception:  # noqa: BLE001
        return "bad"
    execute(
        "UPDATE paperfeed_papers SET figure_url=?, figure_kind='pdf' WHERE id=?",
        (f"pdf-cover:{pid}", pid),
    )
    return "ok"


@router.post("/figures")
def backfill_figures(limit: int = 60):
    """给缺图的论文批量补抓封面（大厅/卡片流展示需要）。best-effort。
    四层兜底（img → object svg → 内嵌 svg → PDF 首页），保证每篇都有图；
    只有确认全空的 'none' 标记行跳过，不再每次打开页面都白跑。"""
    limit = max(1, min(int(limit), 120))
    rows = query(
        """SELECT id, arxiv_id FROM paperfeed_papers
           WHERE (figure_url IS NULL OR figure_url='')
             AND (figure_kind IS NULL OR figure_kind != 'none')
           ORDER BY id DESC LIMIT ?""",
        (limit,),
    )
    pairs = [(r["id"], r["arxiv_id"]) for r in rows if r["arxiv_id"]]
    _BATCH_FIG_RUNNING.set()
    try:
        filled = _parallel_fill(pairs)
    finally:
        _BATCH_FIG_RUNNING.clear()
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
    # 'none' 是批量补图的放弃标记；用户主动打开详情时值得再试一次，先清标记
    execute(
        "UPDATE paperfeed_papers SET figure_kind='' WHERE id=? AND figure_kind='none'",
        (pid,),
    )
    ok = _fill_figure(pid, r["arxiv_id"])
    url = ""
    if ok:
        row = query("SELECT figure_url FROM paperfeed_papers WHERE id=?", (pid,))
        url = row[0]["figure_url"] if row else ""
    return {"ok": ok, "figure_url": url, "msg": "" if ok else "没抓到封面"}


# 正在现场补抓的论文 id（防同卡多请求并发打爆）
_FIG_BUSY: set[int] = set()
_FIG_BUSY_LOCK = threading.Lock()
# 批量补图进行中：/fig 的懒补图先歇着（批量很快会填上），避免卡片图请求挂着转圈
_BATCH_FIG_RUNNING = threading.Event()


@router.get("/fig/{pid}")
def get_figure(pid: int):
    """论文图代理：正文图（img/object svg）、内嵌矢量图（本地缓存 svg）、
    PDF 首页渲染（本地缓存 png）都从这里出；远程图由后端下载一次后从磁盘回源。
    前端 <img> 一律用这个端点，避免浏览器直连 arxiv.org 加载失败。
    该论文还没解析到图时，顺手现场快抓一次（懒补图：谁看到的卡片谁触发）。"""
    rows = query(
        "SELECT id, figure_url, figure_kind, arxiv_id FROM paperfeed_papers WHERE id=?",
        (pid,),
    )
    if not rows:
        raise HTTPException(404, "论文不存在")
    row = rows[0]

    FIG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = FIG_CACHE_DIR / f"{pid}.img"
    meta = FIG_CACHE_DIR / f"{pid}.ct"

    def _serve_cache() -> Response | None:
        if cache.exists() and cache.stat().st_size > 0 and row["figure_url"]:
            ct = "image/png"
            if meta.exists():
                ct = meta.read_text(encoding="ascii").strip() or ct
            return Response(
                content=cache.read_bytes(),
                media_type=ct,
                headers={"Cache-Control": "public, max-age=604800"},
            )
        return None

    # 本地生成的封面（inline-svg / pdf-cover 标记）：缓存被清过就重新生成一次
    if row["figure_url"] and str(row["figure_url"]).startswith(("inline-svg:", "pdf-cover:")):
        resp = _serve_cache()
        if resp is not None:
            return resp
        if row["arxiv_id"]:
            _fill_figure(pid, row["arxiv_id"])
        resp = _serve_cache()
        if resp is not None:
            return resp
        raise HTTPException(404, "图片暂不可用")

    # 还没图：现场快抓一次（'none' 是确认全空的标记，不重跑）。
    # 批量补图进行中时跳过——批量很快会填上，这里同步抓会让图片请求挂着转圈
    if (
        not row["figure_url"]
        and row["arxiv_id"]
        and row["figure_kind"] != "none"
        and not _BATCH_FIG_RUNNING.is_set()
    ):
        with _FIG_BUSY_LOCK:
            busy = pid in _FIG_BUSY
            if not busy:
                _FIG_BUSY.add(pid)
        if not busy:
            try:
                _fill_figure(pid, row["arxiv_id"])
            finally:
                with _FIG_BUSY_LOCK:
                    _FIG_BUSY.discard(pid)
            got = query("SELECT figure_url FROM paperfeed_papers WHERE id=?", (pid,))
            if got and got[0]["figure_url"]:
                row = {**row, "figure_url": got[0]["figure_url"]}
                # 本地生成的封面直接从缓存出
                if str(row["figure_url"]).startswith(("inline-svg:", "pdf-cover:")):
                    resp = _serve_cache()
                    if resp is not None:
                        return resp

    if not row["figure_url"]:
        raise HTTPException(404, "图片暂不可用")

    # 远程正文图：回源一次，落缓存
    resp = _serve_cache()
    if resp is not None:
        return resp
    r = _fetch(row["figure_url"], timeout=25)
    if r is not None and r.status_code == 200 and r.content:
        ct = (r.headers.get("content-type") or "image/png").split(";")[0].strip().lower()
        if ct.startswith("image/") or ct == "text/plain" and row["figure_url"].endswith(".svg"):
            if ct == "text/plain":
                ct = "image/svg+xml"
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
