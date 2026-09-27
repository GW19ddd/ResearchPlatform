"""Gloss（旁注）集成：把文献的 PDF 塞进 Gloss 里读。

只读 + 只调用 Gloss 自己的对外能力（HTTP API / CLI），不改 Gloss 的任何文件。
Gloss 项目位置默认 D:\\03-Codes\\gloss，可在设置里用 gloss.dir / gloss.port 覆盖。
"""
from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path

import httpx

from db import query

DEFAULT_DIR = Path(r"D:\03-Codes\gloss")
DEFAULT_PORT = 8010
CREATE_NO_WINDOW = 0x08000000


# ---------------------------------------------------------------- 配置


def _setting(key: str, default: str = "") -> str:
    try:
        rows = query("SELECT value FROM settings WHERE key=?", (key,))
    except Exception:
        return default
    if rows and rows[0].get("value"):
        return str(rows[0]["value"])
    return default


def gloss_dir() -> Path:
    return Path(_setting("gloss.dir", str(DEFAULT_DIR)))


def gloss_port() -> int:
    try:
        return int(_setting("gloss.port", str(DEFAULT_PORT)))
    except (TypeError, ValueError):
        return DEFAULT_PORT


def base_url() -> str:
    return f"http://127.0.0.1:{gloss_port()}"


def paper_pdf_url(paper_id: str) -> str | None:
    """Gloss 馆藏里某篇的 PDF 直链（Gloss 自带 /api/papers/{id}/pdf，只读调用，不改 Gloss）。"""
    pid = str(paper_id or "").strip()
    if not pid:
        return None
    return f"{base_url()}/api/papers/{pid}/pdf"


def _python() -> Path | None:
    p = gloss_dir() / "backend" / ".venv" / "Scripts" / "python.exe"
    return p if p.is_file() else None


# ---------------------------------------------------------------- 状态


def installed() -> bool:
    d = gloss_dir()
    return (d / "cli" / "gloss.py").is_file() or (d / "backend" / "app" / "main.py").is_file()


def running(timeout: float = 1.5) -> bool:
    try:
        r = httpx.get(f"{base_url()}/api/papers", timeout=timeout)
        return r.status_code < 500
    except Exception:
        return False


def status() -> dict:
    return {
        "dir": str(gloss_dir()),
        "port": gloss_port(),
        "url": base_url(),
        "installed": installed(),
        "running": running(),
        "python": str(_python() or ""),
        "pdf_dirs": [str(d) for d in pdf_dirs()],
    }


def start(wait: float = 25.0) -> dict:
    """起 Gloss 服务（ detached 子进程），等它就绪。"""
    if running():
        return {"ok": True, "started": False, "url": base_url()}
    if not installed():
        return {"ok": False, "started": False, "message": f"没找到 Gloss：{gloss_dir()}"}

    py = _python()
    root = gloss_dir()
    if py:
        cmd = [
            str(py),
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(gloss_port()),
        ]
        cwd = str(root / "backend")
    else:
        cmd = ["gloss", "serve"]
        cwd = str(root)

    try:
        subprocess.Popen(
            cmd,
            cwd=cwd,
            creationflags=CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        return {"ok": False, "started": False, "message": f"启动失败：{exc}"}

    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(0.6)
        if running():
            return {"ok": True, "started": True, "url": base_url()}
    return {
        "ok": False,
        "started": False,
        "message": f"Gloss 启动超时（{wait:.0f}s），可手动在 {root} 下运行 gloss serve",
    }


# ---------------------------------------------------------------- 找 PDF


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", " ", str(s or "").lower()).strip()


def _keywords(title: str) -> list[str]:
    words = [w for w in _norm(title).split() if len(w) >= 3]
    return words[:6]


def pdf_dirs() -> list[Path]:
    out: list[Path] = []
    raw = _setting("gloss.pdf_dir", "")
    if raw:
        for part in raw.split(";"):
            part = part.strip()
            if part and Path(part).is_dir():
                out.append(Path(part))
    default = Path.home() / "Zotero" / "storage"
    if default.is_dir() and default not in out:
        out.append(default)
    return out


def search_candidates(title: str, limit: int = 12) -> list[dict]:
    """标题模糊搜 PDF，返回候选（按命中关键词数排序）。"""
    keys = _keywords(title)
    if not keys:
        return []
    scored: list[tuple[int, Path]] = []
    for root in pdf_dirs():
        try:
            files = list(root.rglob("*.pdf"))
        except Exception:
            continue
        for f in files[:4000]:
            name = _norm(f.stem)
            if not name:
                continue
            hits = sum(1 for k in keys if k in name)
            if hits:
                scored.append((hits, f))
    scored.sort(key=lambda x: -x[0])
    seen: set[str] = set()
    out: list[dict] = []
    for hits, f in scored:
        key = str(f).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"path": str(f), "name": f.name, "hits": hits})
        if len(out) >= limit:
            break
    return out


def find_pdf(title: str, hint: str | None = None) -> Path | None:
    """按标题在 Zotero storage / 自定义目录里找 PDF。"""
    if hint:
        p = Path(hint)
        if p.is_file() and p.suffix.lower() == ".pdf":
            return p
    cands = search_candidates(title, limit=1)
    return Path(cands[0]["path"]) if cands and cands[0]["hits"] >= 2 else None


# ---------------------------------------------------------------- 导入


def import_pdf(path: Path, title: str = "") -> dict:
    """通过 Gloss 的上传接口把 PDF 加进它的库，返回 paper。"""
    if not running():
        st = start()
        if not st.get("ok"):
            raise RuntimeError(st.get("message") or "Gloss 未运行")
    data = path.read_bytes()
    if not data:
        raise RuntimeError("PDF 是空的")
    with httpx.Client(timeout=180.0) as client:
        r = client.post(
            f"{base_url()}/api/papers/upload",
            files={"file": (path.name or "paper.pdf", data, "application/pdf")},
        )
    if r.status_code >= 400:
        raise RuntimeError(f"Gloss 导入失败（{r.status_code}）：{r.text[:200]}")
    paper = r.json()
    if title:
        try:
            with httpx.Client(timeout=20.0) as client:
                client.patch(
                    f"{base_url()}/api/papers/{paper['id']}",
                    json={"title": title},
                )
        except Exception:
            pass  # 改标题失败不影响打开
    return paper


def import_remote(src: str) -> dict:
    """arXiv id / DOI / 链接 —— 交给 Gloss 自己下载。"""
    if not running():
        st = start()
        if not st.get("ok"):
            raise RuntimeError(st.get("message") or "Gloss 未运行")
    with httpx.Client(timeout=180.0) as client:
        r = client.post(f"{base_url()}/api/papers/import", json={"query": src})
    if r.status_code >= 400:
        raise RuntimeError(f"Gloss 导入失败（{r.status_code}）：{r.text[:200]}")
    return r.json()


def open_literature(lit: dict) -> dict:
    """给一篇文献找 PDF 并送进 Gloss，返回可打开的地址。"""
    title = str(lit.get("title") or "")
    path = find_pdf(title, lit.get("pdf_path"))

    if path:
        paper = import_pdf(path, title)
        return {
            "ok": True,
            "url": base_url(),
            "paper_id": paper.get("id"),
            "title": paper.get("title") or title,
            "pdf": str(path),
            "how": "local-pdf",
        }

    # 没有本地 PDF：url / doi 若是 arXiv 或 DOI，让 Gloss 自己去下
    for key in ("url", "doi"):
        src = str(lit.get(key) or "").strip()
        if not src:
            continue
        if src.lower().endswith(".pdf") and Path(src).is_file():
            paper = import_pdf(Path(src), title)
            return {
                "ok": True,
                "url": base_url(),
                "paper_id": paper.get("id"),
                "title": title,
                "pdf": src,
                "how": "local-pdf",
            }
        if re.match(r"^(arxiv:)?\d{4}\.\d{4,5}", src, re.I) or "arxiv.org" in src.lower() or src.startswith("10."):
            paper = import_remote(src)
            return {
                "ok": True,
                "url": base_url(),
                "paper_id": paper.get("id"),
                "title": paper.get("title") or title,
                "pdf": src,
                "how": "remote",
            }

    return {
        "ok": False,
        "message": "没找到这篇的 PDF。在下面填 PDF 路径，或把 Zotero storage 目录配到设置里（gloss.pdf_dir）。",
        "searched": [str(d) for d in pdf_dirs()],
    }


def fetch_paper_pdf(paper_id: str) -> bytes | None:
    """从 Gloss 馆藏里把这篇的 PDF 字节取回来（只读，不写 Gloss 任何东西）。
    本地没有 PDF、但这条文献之前被送进过 Gloss（含远程下载的 arXiv PDF）时靠它兜底。"""
    url = paper_pdf_url(paper_id)
    if not url or not running():
        return None
    try:
        r = httpx.get(url, timeout=120.0)
    except Exception:
        return None
    if r.status_code != 200 or not r.content.startswith(b"%PDF"):
        return None
    return r.content
