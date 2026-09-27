"""Zotero 同步：把 Zotero 条目导入文献库。

三种来源：
1. local —— Zotero 桌面端本地 API（http://localhost:23119），无需联网
2. web   —— Zotero Web API（api.zotero.org），需要 user_id + API Key
3. paste —— 粘贴 CSL JSON / BibTeX / RIS 文本离线导入

去重策略：优先按 DOI，其次按归一化标题。
"""
import html
import json
import re
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import execute, now, query

router = APIRouter(prefix="/api/zotero", tags=["zotero"])

LOCAL_BASE = "http://localhost:23119"
WEB_BASE = "https://api.zotero.org"
CONFIG_KEY = "zotero_config"
SKIP_TYPES = {"attachment", "note", "annotation"}
# 分类层级的分隔符。必须是「空格+斜杠+空格」，因为集合名本身可以含裸斜杠（"C/C++"）
SEP = " / "


# ------------------------------ 配置持久化 ------------------------------


def _load_config() -> dict:
    rows = query("SELECT value FROM settings WHERE key=?", (CONFIG_KEY,))
    if not rows:
        return {}
    try:
        return json.loads(rows[0]["value"]) or {}
    except Exception:
        return {}


def _save_config(cfg: dict):
    # settings 表只有 key/value 两列，没有 id
    val = json.dumps(cfg, ensure_ascii=False)
    rows = query("SELECT key FROM settings WHERE key=?", (CONFIG_KEY,))
    if rows:
        execute("UPDATE settings SET value=? WHERE key=?", (val, CONFIG_KEY))
    else:
        execute("INSERT INTO settings (key, value) VALUES (?,?)", (CONFIG_KEY, val))


@router.get("/config")
def get_config():
    cfg = _load_config()
    return {
        "source": cfg.get("source", "local"),
        "user_id": cfg.get("user_id", ""),
        "api_key": cfg.get("api_key", ""),
        "library_type": cfg.get("library_type", "user"),
        "collection": cfg.get("collection", ""),
        "tag": cfg.get("tag", ""),
        "limit": cfg.get("limit", 100),
    }


class ConfigIn(BaseModel):
    source: str = "local"
    user_id: str = ""
    api_key: str = ""
    library_type: str = "user"
    collection: str = ""
    tag: str = ""
    limit: int = 100


@router.put("/config")
def save_config(body: ConfigIn):
    cfg = _load_config()
    cfg.update(body.model_dump())
    _save_config(cfg)
    return {"ok": True}


# ------------------------------ 表结构兜底 ------------------------------


def _ensure_columns():
    cols = {r["name"] for r in query("PRAGMA table_info(literature)")}
    for col in ("doi", "source_key", "collections"):
        if col not in cols:
            execute(f"ALTER TABLE literature ADD COLUMN {col} TEXT")


# ------------------------------ 拉取条目 ------------------------------


def _endpoint(cfg: dict, path: str = "items") -> tuple[str, dict]:
    lib = "groups" if cfg.get("library_type") == "group" else "users"
    uid = (cfg.get("user_id") or "").strip()
    if cfg.get("source") == "web":
        if not uid:
            raise HTTPException(400, "Web API 模式需要填 user_id（个人库 ID 或群组 ID）")
        base = f"{WEB_BASE}/{lib}/{uid}"
        headers = {"Zotero-API-Version": "3"}
        if cfg.get("api_key"):
            headers["Zotero-API-Key"] = cfg["api_key"]
        return f"{base}/{path}", headers
    return f"{LOCAL_BASE}/api/users/0/{path}", {"Zotero-API-Version": "3"}


async def _fetch_collections(cfg: dict) -> dict:
    """返回 {collection_key: {"name","parent","path"}}，path 是含父级的完整路径。

    Zotero 的分类是树状的（parentCollection），这里把父链解析成 '祖父 / 父 / 子'，
    保证导入后仍是原来的层级，而不是被摊平成一堆互不相干的分类。
    """
    url, headers = _endpoint(cfg, "collections")
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(url, headers=headers, params={"format": "json", "limit": 300})
            r.raise_for_status()
            raw = r.json()
    except Exception:
        return {}
    nodes: dict[str, dict] = {}
    for x in raw if isinstance(raw, list) else []:
        d = x.get("data") if isinstance(x, dict) and "data" in x else x
        if isinstance(d, dict) and d.get("key") and d.get("name"):
            nodes[d["key"]] = {
                "key": d["key"],
                "name": _clean(d["name"]),
                "parent": d.get("parentCollection") or "",
            }
    for k, n in nodes.items():
        parts, cur, guard = [], n, 0
        while cur and guard < 20:
            parts.append(cur["name"])
            cur = nodes.get(cur.get("parent") or "")
            guard += 1
        n["path"] = SEP.join(reversed(parts))
    return nodes


async def _fetch_items(cfg: dict, limit: int) -> list[dict]:
    collection = (cfg.get("collection") or "").strip()
    # /items/top 只返回顶层条目，自动排除附件、笔记、批注
    if collection:
        url, headers = _endpoint(cfg, f"collections/{collection}/items/top")
    else:
        url, headers = _endpoint(cfg, "items/top")
    params = {
        "format": "json",
        "limit": min(int(limit or 100), 200),
        "sort": "dateModified",
        "direction": "desc",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url, headers=headers, params=params)
        r.raise_for_status()
        raw = r.json()
    items = []
    for x in raw if isinstance(raw, list) else []:
        data = x.get("data") if isinstance(x, dict) and "data" in x else x
        if isinstance(data, dict):
            items.append(data)
    return items


# ------------------------------ 字段映射 ------------------------------


def _norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", "", (t or "").lower())


def _authors(creators: list) -> str:
    names = []
    for c in creators or []:
        if not isinstance(c, dict):
            continue
        if c.get("creatorType") and c.get("creatorType") not in ("author", "editor", "contributor"):
            continue
        if c.get("name"):
            names.append(c["name"])
        else:
            last = (c.get("lastName") or "").strip()
            first = (c.get("firstName") or "").strip()
            names.append(f"{first} {last}".strip() or last)
    if not names:
        return ""
    if len(names) <= 3:
        return "; ".join(names)
    return "; ".join(names[:3]) + f" 等 {len(names)} 人"


def _year(d: str) -> int | None:
    m = re.search(r"(19|20)\d{2}", d or "")
    return int(m.group(0)) if m else None


def _venue(d: dict) -> str:
    for k in ("publicationTitle", "bookTitle", "proceedingsTitle", "journalAbbreviation",
              "conferenceName", "meetingName", "websiteTitle", "institution", "publisher",
              "university", "series"):
        v = (d.get(k) or "").strip()
        if v:
            return v
    return ""


def _doi(d: dict) -> str:
    doi = (d.get("DOI") or d.get("doi") or "").strip()
    if not doi:
        extra = d.get("extra") or ""
        m = re.search(r"DOI:\s*(\S+)", extra)
        doi = m.group(1) if m else ""
    return doi.strip().rstrip(".")


def _url(d: dict) -> str:
    u = (d.get("url") or "").strip()
    if u:
        return u
    doi = _doi(d)
    return f"https://doi.org/{doi}" if doi else ""


def _tags(d: dict) -> str:
    names = []
    for t in d.get("tags") or []:
        if isinstance(t, dict) and t.get("tag"):
            names.append(str(t["tag"]).strip())
        elif isinstance(t, str):
            names.append(t)
    return ", ".join(names[:12])


def _notes(d: dict) -> str:
    parts = []
    abstract = (d.get("abstractNote") or "").strip()
    if abstract:
        parts.append("【摘要】" + abstract[:1200])
    extra = (d.get("extra") or "").strip()
    if extra:
        parts.append("【Zotero Extra】" + extra[:400])
    return "\n\n".join(parts)


def _collections(d: dict, coll_map: dict) -> str:
    """条目所属分类（完整路径），JSON 数组字符串；单分类同步时补上当前分类路径。"""
    names: list[str] = []
    for k in d.get("collections") or []:
        node = coll_map.get(k)
        if not node:
            continue
        p = node.get("path") or node.get("name")
        if p and p not in names:
            names.append(p)
    return json.dumps(names, ensure_ascii=False)


def _parse_collections(raw: Any) -> list[str]:
    """兼容两种落库格式：新的 JSON 数组，旧的 'a / b' 斜杠串。

    分隔符是 " / "（前后带空格），不是裸 "/"，否则 "C/C++" 这种集合名会被切开。
    """
    s = (raw or "").strip() if isinstance(raw, str) else ""
    if not s:
        return []
    if s.startswith("["):
        try:
            v = json.loads(s)
            if isinstance(v, list):
                return [str(x).strip() for x in v if str(x).strip()]
        except Exception:
            pass
    # 新格式本身就是 JSON，走到这的旧串才需要拆；按 " / " 拆，拆不动就整段保留
    parts = [p.strip() for p in s.split(SEP) if p.strip()]
    return parts or ([s] if s else [])


def _dump_collections(names: list[str]) -> str:
    return json.dumps([n.strip() for n in names if n.strip()], ensure_ascii=False)


def _clean(s: str) -> str:
    """Zotero 的标题/期刊名里偶尔混 HTML 标签（如 <span style=...>）。"""
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", "", str(s))
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def _map_item(d: dict, coll_map: dict | None = None, fallback_collection: str = "") -> dict | None:
    title = _clean(d.get("title") or d.get("itemTitle") or "")
    if not title:
        return None
    colls = _parse_collections(_collections(d, coll_map or {}))
    if not colls and fallback_collection:
        colls = [fallback_collection]
    return {
        "title": title[:500],
        "authors": _authors(d.get("creators") or []),
        "year": _year(d.get("date") or ""),
        "venue": _clean(_venue(d)),
        "url": _url(d),
        "doi": _doi(d),
        "tags": _tags(d),
        "notes": _notes(d),
        "collections": _dump_collections(colls),
        "source_key": str(d.get("key") or ""),
        "status": "todo",
        "rating": 3,
    }


# ------------------------------ 去重 + 落库 ------------------------------


def _existing_index() -> tuple[set, dict]:
    """返回 (归一化标题集合, {(类型,值): 行id})。"""
    rows = query("SELECT id, title, doi, source_key FROM literature")
    titles = {_norm_title(r["title"]) for r in rows}
    keys: dict = {}
    for r in rows:
        if r.get("doi"):
            keys[("doi", (r["doi"] or "").lower().strip())] = r["id"]
        if r.get("source_key"):
            keys[("key", r["source_key"])] = r["id"]
    return titles, keys


def _refresh_meta(lid: int, m: dict) -> bool:
    """已存在的条目：补上分类 / 标签 / venue / 年份。返回是否真的改了。"""
    rows = query("SELECT collections, tags, venue, year FROM literature WHERE id=?", (lid,))
    if not rows:
        return False
    cur = rows[0]
    new_c = m.get("collections") or cur.get("collections") or ""
    new_t = m.get("tags") or cur.get("tags") or ""
    new_v = m.get("venue") or cur.get("venue") or ""
    new_y = m.get("year") if m.get("year") else cur.get("year")
    if (
        (cur.get("collections") or "") == new_c
        and (cur.get("tags") or "") == new_t
        and (cur.get("venue") or "") == new_v
        and cur.get("year") == new_y
    ):
        return False
    execute(
        "UPDATE literature SET collections=?, tags=?, venue=?, year=? WHERE id=?",
        (new_c, new_t, new_v, new_y, lid),
    )
    return True


def _insert_many(mapped: list[dict]) -> tuple[int, int, int, list[str]]:
    _ensure_columns()
    titles, keys = _existing_index()
    ts = now()
    imported, updated, samples = 0, 0, []
    seen: set = set()
    for m in mapped:
        doi = (m["doi"] or "").lower().strip()
        skey = m["source_key"]
        nt = _norm_title(m["title"])
        hit = None
        if doi and ("doi", doi) in keys:
            hit = keys[("doi", doi)]
        elif skey and ("key", skey) in keys:
            hit = keys[("key", skey)]
        elif nt in titles or nt in seen:
            continue
        if hit is not None:
            if _refresh_meta(hit, m):
                updated += 1
            continue
        seen.add(nt)
        execute(
            """INSERT INTO literature (title, authors, year, venue, url, status, rating,
               relevance, notes, tags, idea_id, doi, source_key, collections, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                m["title"], m["authors"], m["year"], m["venue"], m["url"],
                m["status"], m["rating"], None, m["notes"] or None, m["tags"] or None,
                None, m["doi"] or None, skey or None, m.get("collections") or None, ts, ts,
            ),
        )
        imported += 1
        titles.add(nt)
        if skey:
            keys[("key", skey)] = None
        if doi:
            keys[("doi", doi)] = None
        if len(samples) < 8:
            samples.append(m["title"][:60])
    return imported, updated, len(mapped) - imported - updated, samples


# ------------------------------ 接口 ------------------------------


class SyncIn(BaseModel):
    source: str = "local"
    user_id: str = ""
    api_key: str = ""
    library_type: str = "user"
    collection: str = ""
    tag: str = ""
    limit: int = 100
    save: bool = True


@router.post("/probe")
async def probe(body: SyncIn):
    cfg = body.model_dump()
    try:
        items = await _fetch_items(cfg, min(int(body.limit or 100), 5))
    except httpx.HTTPError as exc:
        hint = ""
        if "localhost:23119" in str(exc) or cfg.get("source") == "local":
            hint = "（本地模式：确认 Zotero 桌面端已启动，并在 设置→高级→「允许本机其他程序访问」中开启本地 API）"
        return {"ok": False, "message": f"连接失败：{type(exc).__name__}: {exc}{hint}", "count": 0}
    except HTTPException as exc:
        return {"ok": False, "message": str(exc.detail), "count": 0}
    except Exception as exc:
        return {"ok": False, "message": f"{type(exc).__name__}: {exc}", "count": 0}
    n = len([i for i in items if i.get("itemType") not in SKIP_TYPES])
    msg = f"连通正常，可同步条目约 {n} 条" + ("（以上为前 5 条抽样）" if items else "")
    return {"ok": True, "message": msg, "count": n}


@router.post("/sync")
async def sync(body: SyncIn):
    cfg = body.model_dump()
    if body.save:
        saved = _load_config()
        saved.update({k: v for k, v in cfg.items() if k != "save"})
        _save_config(saved)
    try:
        items = await _fetch_items(cfg, body.limit)
    except HTTPException as exc:
        raise exc
    except httpx.HTTPError as exc:
        hint = ""
        if cfg.get("source") == "local":
            hint = "（确认 Zotero 桌面端已启动并开启本地 API：设置 → 高级 → 允许本机其他程序访问）"
        raise HTTPException(502, f"连接 Zotero 失败：{type(exc).__name__}: {exc}{hint}")
    except Exception as exc:
        raise HTTPException(502, f"连接 Zotero 失败：{type(exc).__name__}: {exc}")

    coll_map = await _fetch_collections(cfg)
    # 单分类同步时，用该分类的完整路径兜底（Zotero 单分类查询的返回体偶尔不带 collections 字段）
    fallback = ""
    if cfg.get("collection"):
        node = coll_map.get(cfg["collection"])
        if node:
            fallback = node.get("path") or node.get("name") or ""

    tag_filter = (body.tag or "").strip().lower()
    mapped: list[dict] = []
    for d in items:
        if d.get("itemType") in SKIP_TYPES:
            continue
        if tag_filter:
            names = [str(t.get("tag", "")).lower() for t in (d.get("tags") or []) if isinstance(t, dict)]
            if tag_filter not in names:
                continue
        m = _map_item(d, coll_map, fallback)
        if m:
            mapped.append(m)

    imported, updated, skipped, samples = _insert_many(mapped)
    return {
        "ok": True,
        "total": len(items),
        "matched": len(mapped),
        "imported": imported,
        "updated": updated,
        "skipped": skipped,
        "samples": samples,
        "collections_found": len(coll_map),
    }


class CollectionsIn(BaseModel):
    source: str = "local"
    user_id: str = ""
    api_key: str = ""
    library_type: str = "user"


@router.post("/collections")
async def collections(body: CollectionsIn):
    cfg = body.model_dump()
    coll_map = await _fetch_collections(cfg)
    flat = [
        {"key": n["key"], "name": n["name"], "parent": n["parent"], "path": n["path"]}
        for n in sorted(coll_map.values(), key=lambda x: x["path"])
    ]
    if not flat:
        hint = "（本地模式：确认 Zotero 桌面端已启动，并开启「设置 → 高级 → 允许本机其他程序访问」）" if cfg.get("source") == "local" else ""
        return {"ok": False, "message": f"Zotero 里没有读到任何分类（collections 为空）{hint}", "collections": [], "tree": []}
    return {"ok": True, "collections": flat, "tree": _build_tree([f["path"] for f in flat])}


def _build_tree(paths: list[str]) -> list[dict]:
    """把完整路径列表还原成 Zotero 里的父子树。

    关键：绝不能按 "/" 切路径——集合名本身可能带斜杠（如 "C/C++"），
    切了就会把 "C/C++" 拆成 C → C++ 两层。层级只能靠「已知完整路径」的前缀匹配来定。
    """
    unique: list[str] = []
    for p in paths or []:
        p = (p or "").strip() if isinstance(p, str) else str(p or "").strip()
        if p and p not in unique:
            unique.append(p)
    unique.sort(key=lambda x: (x.count(SEP), x))

    roots: list[dict] = []
    nodes: dict[str, dict] = {}
    for p in unique:
        parent_path = ""
        for cand in nodes:
            # 只在 " / " 这个真实分隔符边界上认父子，"C/C++" 里的裸斜杠不算
            if p.startswith(cand + SEP) and len(cand) > len(parent_path):
                parent_path = cand
        name = p[len(parent_path) + len(SEP):] if parent_path else p
        parent = nodes.get(parent_path)
        node = {
            "name": name,
            "path": p,
            "depth": (parent["depth"] + 1) if parent else 0,
            "children": [],
        }
        nodes[p] = node
        if parent:
            parent["children"].append(node)
        else:
            roots.append(node)
    return roots


@router.get("/library/collections")
def library_collections():
    """文献库里已导入条目按 Zotero 分类的分组统计（保留父子层级）。"""
    _ensure_columns()
    rows = query("SELECT id, collections, status FROM literature")
    own: dict[str, dict] = {}  # path -> {count, done}
    for r in rows:
        paths = _parse_collections(r.get("collections"))
        if not paths:
            b = own.setdefault("未分类", {"count": 0, "done": 0})
            b["count"] += 1
            if r.get("status") == "done":
                b["done"] += 1
            continue
        for p in paths:
            b = own.setdefault(p, {"count": 0, "done": 0})
            b["count"] += 1
            if r.get("status") == "done":
                b["done"] += 1

    # 名字交给 _build_tree 按前缀算，这里只给完整路径（"C/C++" 这种名字不能被切）
    tree = _build_tree([p for p in own if p != "未分类"])

    def fill(nodes: list[dict]) -> int:
        """返回该子树总篇数（含子孙），并就地写 total/done。"""
        total = 0
        done = 0
        for n in nodes:
            st = own.get(n["path"], {"count": 0, "done": 0})
            sub = fill(n["children"])
            n["count"] = st["count"]
            n["total"] = st["count"] + sub[0]
            n["done"] = st["done"] + sub[1]
            total += n["total"]
            done += n["done"]
        return total, done

    fill(tree)
    tree.sort(key=lambda x: -x["total"])
    if "未分类" in own:
        tree.append({
            "name": "未分类",
            "path": "未分类",
            "depth": 0,
            "children": [],
            "count": own["未分类"]["count"],
            "total": own["未分类"]["count"],
            "done": own["未分类"]["done"],
        })

    groups = sorted(
        [{"name": k, **v} for k, v in own.items()],
        key=lambda x: -x["count"],
    )
    return {"groups": groups, "tree": tree}


# ------------------------------ 文本导入（离线兜底） ------------------------------


class ImportIn(BaseModel):
    text: str
    fmt: str = "auto"


def _parse_bibtex(text: str) -> list[dict]:
    out = []
    for block in re.findall(r"@\w+\s*\{[^{}]*\{?[^{}]*\}?\s*(?:,\s*[^{}]*\{[^{}]*\}\s*)*\}", text, re.S):
        head = re.match(r"@(\w+)\s*\{([^,]+),", block)
        if not head:
            continue
        fields = {}
        for m in re.finditer(r"(\w+)\s*=\s*\{(.*?)\}|\s*(\w+)\s*=\s*\"(.*?)\"", block, re.S):
            k = m.group(1) or m.group(3)
            v = m.group(2) if m.group(1) else m.group(4)
            fields[k.lower()] = re.sub(r"\s+", " ", v).strip()
        title = fields.get("title", "")
        year = _year(fields.get("year", ""))
        authors = "; ".join(
            [a.strip() for a in re.split(r"\s+and\s+", fields.get("author", "")) if a.strip()][:3]
        )
        if not title:
            continue
        out.append({
            "title": title.strip("{}"),
            "authors": authors,
            "year": year,
            "venue": fields.get("booktitle") or fields.get("journal") or fields.get("publisher") or "",
            "url": fields.get("url") or "",
            "doi": fields.get("doi", ""),
            "tags": fields.get("keywords", ""),
            "notes": "",
            "source_key": "",
            "status": "todo",
            "rating": 3,
        })
    return out


def _parse_ris(text: str) -> list[dict]:
    out, cur = [], {}
    for line in text.splitlines():
        m = re.match(r"^([A-Z]{2})\s*-\s*(.*)$", line)
        if not m:
            continue
        tag, val = m.group(1), m.group(2).strip()
        if tag == "ER":
            if cur.get("TI"):
                out.append({
                    "title": cur["TI"],
                    "authors": "; ".join(cur.get("AUs", [])[:3]) or cur.get("AU", ""),
                    "year": _year(cur.get("PY") or cur.get("Y1") or ""),
                    "venue": cur.get("T2") or cur.get("JF") or cur.get("PB") or "",
                    "url": cur.get("UR") or "",
                    "doi": cur.get("DO") or "",
                    "tags": ", ".join(cur.get("KWs", [])),
                    "notes": ("【摘要】" + cur["AB"][:1200]) if cur.get("AB") else "",
                    "source_key": "",
                    "status": "todo",
                    "rating": 3,
                })
            cur = {}
            continue
        if tag == "TI":
            cur["TI"] = val
        elif tag == "AU":
            cur.setdefault("AUs", []).append(val)
            cur["AU"] = val
        elif tag == "KW":
            cur.setdefault("KWs", []).append(val)
        elif tag in ("PY", "Y1", "T2", "JF", "PB", "UR", "DO", "AB"):
            cur[tag] = val
    return out


def _parse_csl(text: str) -> list[dict]:
    data = json.loads(text)
    if isinstance(data, dict):
        data = data.get("items") or [data]
    mapped = []
    for x in data or []:
        d = x.get("data") if isinstance(x, dict) and "data" in x else x
        if isinstance(d, dict):
            m = _map_item(d)
            if m:
                mapped.append(m)
    return mapped


@router.post("/import")
def import_text(body: ImportIn):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "导入内容为空")
    fmt = body.fmt
    if fmt == "auto":
        fmt = "csljson" if text.lstrip().startswith(("[", "{")) and '"title"' in text else (
            "bibtex" if text.lstrip().startswith("@") else "ris"
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
        raise HTTPException(400, f"没解析出条目（格式={fmt}）。确认导出格式是否为 CSL JSON / BibTeX / RIS。")
    imported, updated, skipped, samples = _insert_many(mapped)
    return {
        "ok": True,
        "total": len(mapped),
        "matched": len(mapped),
        "imported": imported,
        "updated": updated,
        "skipped": skipped,
        "samples": samples,
        "fmt": fmt,
    }
