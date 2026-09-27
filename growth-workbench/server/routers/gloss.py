"""Gloss（旁注）对接：状态、启动、把某篇文献的 PDF 送进 Gloss + 工作台内嵌阅读。"""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import gloss
from db import execute, now, query

router = APIRouter(prefix="/api", tags=["gloss"])


def _lit(lit_id: int) -> dict:
    rows = query("SELECT * FROM literature WHERE id=?", (lit_id,))
    if not rows:
        raise HTTPException(404, "literature not found")
    return rows[0]


# ---------------------- 工作台内嵌阅读（不经过 Gloss 的界面） ----------------------


def _resolve_pdf(lit: dict) -> tuple[Path | None, list[dict]]:
    """手填路径优先，其次按标题在本地搜（命中 >=2 个关键词才算数）。"""
    hint = str(lit.get("pdf_path") or "").strip()
    if hint:
        p = Path(hint)
        if p.is_file() and p.suffix.lower() == ".pdf":
            return p, []
    cands = gloss.search_candidates(str(lit.get("title") or ""), limit=8)
    for c in cands:
        if c.get("hits", 0) >= 2:
            return Path(c["path"]), cands
    return None, cands


def _pdf_source(lit: dict) -> dict:
    """三档兜底：本地文件 → Gloss 馆藏 → 没有。
    Gloss 馆藏这一档让我们能读到本地不存在、但 Gloss 之前下载过的 PDF（比如 arXiv 远程导入的）。"""
    path, cands = _resolve_pdf(lit)
    if path:
        return {"kind": "local", "path": path, "candidates": cands}
    gid = str(lit.get("gloss_id") or "").strip()
    if gid and gloss.running():
        return {"kind": "gloss", "gloss_id": gid, "candidates": cands}
    return {"kind": "none", "candidates": cands, "gloss_id": gid, "gloss_running": gloss.running()}


@router.get("/literature/{lit_id}/pdf-info")
def pdf_info(lit_id: int):
    """前端先问一句有没有 PDF，再决定渲染阅读器还是给候选列表。"""
    lit = _lit(lit_id)
    src = _pdf_source(lit)
    return {
        "ok": src["kind"] != "none",
        "source": src["kind"],  # local | gloss | none
        "path": str(src["path"]) if src.get("path") else "",
        "gloss_id": src.get("gloss_id") or "",
        "gloss_running": src.get("gloss_running", True),
        "candidates": src["candidates"],
        "dirs": [str(d) for d in gloss.pdf_dirs()],
    }


@router.get("/literature/{lit_id}/pdf")
def pdf_file(lit_id: int):
    """把这篇文献的 PDF 以 inline 方式吐给浏览器内嵌阅读器。"""
    lit = _lit(lit_id)
    src = _pdf_source(lit)

    if src["kind"] == "local":
        path: Path = src["path"]
        if not path.is_file():
            raise HTTPException(404, "PDF 文件不见了：重新定位一下")
        return FileResponse(
            str(path),
            media_type="application/pdf",
            filename=path.name,
            headers={"Content-Disposition": "inline"},
        )

    if src["kind"] == "gloss":
        data = gloss.fetch_paper_pdf(src["gloss_id"])
        if not data:
            raise HTTPException(502, "Gloss 那边读不到这篇的 PDF 了")
        return Response(
            content=data,
            media_type="application/pdf",
            headers={"Content-Disposition": "inline"},
        )

    raise HTTPException(404, "没找到这篇的 PDF：先在下面填路径，或从候选里挑一个")


class OpenIn(BaseModel):
    pdf_path: str | None = None


@router.get("/gloss/status")
def status():
    return gloss.status()


@router.post("/gloss/start")
def start():
    return gloss.start()


class GlossCfg(BaseModel):
    dir: str | None = None
    port: int | None = None
    pdf_dir: str | None = None


@router.put("/gloss/config")
def set_config(body: GlossCfg):
    for key, val in (
        ("gloss.dir", body.dir),
        ("gloss.port", body.port),
        ("gloss.pdf_dir", body.pdf_dir),
    ):
        if val is None or str(val).strip() == "":
            continue
        rows = query("SELECT key FROM settings WHERE key=?", (key,))
        if rows:
            execute("UPDATE settings SET value=? WHERE key=?", (str(val).strip(), key))
        else:
            execute("INSERT INTO settings (key, value) VALUES (?,?)", (key, str(val).strip()))
    return gloss.status()


@router.get("/gloss/find")
def find(title: str = ""):
    if not title.strip():
        return {"candidates": []}
    return {"candidates": gloss.search_candidates(title), "dirs": [str(d) for d in gloss.pdf_dirs()]}


@router.post("/literature/{lit_id}/gloss")
def open_in_gloss(lit_id: int, body: OpenIn | None = None):
    lit = _lit(lit_id)
    pdf = (body.pdf_path if body else None) or ""
    if pdf:
        # 用户手填/选中的路径顺手存起来，下次一点就开
        execute(
            "UPDATE literature SET pdf_path=?, updated_at=? WHERE id=?",
            (pdf, now(), lit_id),
        )
        lit["pdf_path"] = pdf

    try:
        res = gloss.open_literature(dict(lit))
    except Exception as exc:
        return {"ok": False, "message": str(exc), "url": gloss.base_url()}

    if res.get("ok") and res.get("paper_id"):
        execute(
            "UPDATE literature SET gloss_id=?, updated_at=? WHERE id=?",
            (str(res["paper_id"]), now(), lit_id),
        )
    res["status"] = gloss.status()
    return res
