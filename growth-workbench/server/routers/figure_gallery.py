"""绘图工作室 · 参考画廊（agent-figure-gallery 形态）。

直接复用本机 AgentFigureGallery 知识库的纯 stdlib 包（agentfiguregallery.server），
不另起独立服务端口，把它包成 FastAPI 路由，让 /studio/figure 的画廊模式原生调用。

知识库根目录默认 D:/01-App/06_Academic/AgentFigureGallery，
可用环境变量 AGENT_FIGURE_GALLERY_ROOT 覆盖（settings 表暂不强依赖）。
"""
import importlib.util
import mimetypes
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

# 知识库根：环境变量优先，其次默认落在 06_Academic 下
KB_ROOT = Path(
    os.environ.get("AGENT_FIGURE_GALLERY_ROOT", r"D:/01-App/06_Academic/AgentFigureGallery")
).resolve()

_afg = None


def _load_afg():
    """懒加载 agentfiguregallery.server 包（直接按文件路径 import，不污染 sys.path 顶层）。"""
    global _afg
    if _afg is not None:
        return _afg
    server_py = KB_ROOT / "agentfiguregallery" / "server.py"
    if not server_py.is_file():
        raise RuntimeError(
            f"未找到 AgentFigureGallery：{server_py} 不存在。"
            "请设置环境变量 AGENT_FIGURE_GALLERY_ROOT 指向包含 agentfiguregallery/ 的仓库根。"
        )
    spec = importlib.util.spec_from_file_location("agentfiguregallery_server", str(server_py))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    _afg = mod
    return mod


def _unavailable(e: Exception):
    raise HTTPException(503, str(e))


router = APIRouter(prefix="/api/figure-gallery", tags=["figure-gallery"])


def _root_present() -> bool:
    return (KB_ROOT / "agentfiguregallery" / "server.py").is_file()


# 已知 colormap / 工具名 → 十六进制调色板（科学论文常见风格）。
# KB 索引不随附真实源脚本（本地 0 个脚本文件），无法从代码里解析配色，
# 故按元数据里的工具名 / colormap 词推断，匹配不到再按 plot_type 给学术风兜底。
KNOWN_COLORMAPS: dict[str, list[str]] = {
    "viridis": ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
    "plasma": ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"],
    "magma": ["#000004", "#51127c", "#b73779", "#fc8961", "#fcfdbf"],
    "inferno": ["#000004", "#420a68", "#932667", "#dd513a", "#fcffa4"],
    "cividis": ["#00224e", "#414d6b", "#7d88a1", "#bfb09f", "#ffea46"],
    "turbo": ["#30123b", "#28bceb", "#a4fc3c", "#fb8022", "#7a0403"],
    "rdbu": ["#053061", "#2166ac", "#f7f7f7", "#d6604d", "#67001f"],
    "coolwarm": ["#3b4cc0", "#8fbcdb", "#fdf2e8", "#df6658", "#b40426"],
    "seaborn": ["#4c72b0", "#dd8452", "#55a868", "#c44e52", "#8172b3"],
    "tab10": ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"],
    "set1": ["#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00"],
    "set2": ["#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854"],
    "colorblind": ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#d55e00", "#56b4e9"],
    "okabe": ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#d55e00", "#56b4e9"],
    "greys": ["#222222", "#555555", "#888888", "#bbbbbb"],
    "gray": ["#222222", "#555555", "#888888", "#bbbbbb"],
    "grey": ["#222222", "#555555", "#888888", "#bbbbbb"],
    "monochrome": ["#222222", "#555555", "#888888", "#bbbbbb"],
    "pastel": ["#8dd3c7", "#ffffb3", "#bebada", "#fb8072", "#80b1d3"],
    "ggplot": ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"],
    "nature": ["#003f5c", "#58508d", "#bc5090", "#ff6361", "#ffa600"],
    "cell": ["#1b3a6b", "#2c7fb8", "#7fcdbb", "#edf8b1", "#fd8d3c"],
}

_PLOT_FALLBACK: dict[str, list[str]] = {
    "bar_chart": ["#0072b2", "#e69f00", "#009e73", "#cc79a7"],
    "line_chart": ["#1f77b4", "#2ca02c", "#9467bd", "#d62728"],
    "scatter_plot": ["#4c72b0", "#dd8452", "#55a868", "#c44e52"],
    "heatmap_matrix": ["#053061", "#2166ac", "#f7f7f7", "#d6604d", "#67001f"],
    "box_violin_distribution": ["#009e73", "#0072b2", "#e69f00", "#cc79a7"],
    "embedding_plot": ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728"],
    "benchmark_performance": ["#0072b2", "#e69f00", "#009e73", "#cc79a7"],
    "multi_panel_figure": ["#4c72b0", "#dd8452", "#55a868", "#c44e52"],
    "spatial_map": ["#2c7fb8", "#7fcdbb", "#edf8b1", "#fd8d3c"],
    "microscopy_panel": ["#404040", "#808080", "#b0b0b0", "#d0d0d0"],
}


def _text_blob(candidate: dict) -> str:
    parts = [
        str(candidate.get("why_suggested", "") or ""),
        str(candidate.get("source_repo", "") or ""),
        str(candidate.get("source_role", "") or ""),
        str(candidate.get("what_to_borrow", "") or ""),
        str(candidate.get("design_takeaways", "") or ""),
    ]
    tags = candidate.get("tags") or []
    if isinstance(tags, list):
        parts.append(" ".join(str(t) for t in tags if isinstance(t, str)))
    return " ".join(parts).lower()


def derive_palette(candidate: dict) -> list[str]:
    """从候选元数据推断一套 hex 调色板：优先命中已知 colormap / 工具名，否则按 plot_type 兜底。"""
    blob = _text_blob(candidate)
    for name, hexes in KNOWN_COLORMAPS.items():
        if re.search(rf"\b{re.escape(name)}\b", blob):
            return hexes
    pt = candidate.get("plot_type") or candidate.get("primary_plot_type") or ""
    return _PLOT_FALLBACK.get(pt, ["#4c72b0", "#dd8452", "#55a868", "#c44e52"])


def enrich_session(payload: dict) -> dict:
    """给会话里每个候选补一个 palette 字段（前端「用作样板」据此初始化配色）。"""
    for c in payload.get("candidates", []) or []:
        if isinstance(c, dict):
            c["palette"] = derive_palette(c)
    return payload


@router.get("/status")
def status():
    """画廊可用性 + 候选总数（前端据此决定是否展示画廊入口）。"""
    try:
        afg = _load_afg()
        index = afg.load_index(KB_ROOT)
        count = len(index.get("candidates", []))
    except Exception as e:  # noqa: BLE001
        return {"available": False, "root": str(KB_ROOT), "candidate_count": 0, "error": str(e)}
    return {"available": True, "root": str(KB_ROOT), "candidate_count": count}


@router.get("/sessions")
def list_sessions():
    try:
        afg = _load_afg()
        return {"sessions": afg.discover_sessions(KB_ROOT)}
    except Exception as e:  # noqa: BLE001
        return _unavailable(e)


@router.post("/generate")
def generate(body: dict):
    """按 plot_type / 数量 / 策略 / 任务生成候选会话，返回完整会话（含 preview_url）。"""
    try:
        afg = _load_afg()
        sess = afg.generate_session(
            root=KB_ROOT,
            plot_type=body.get("plot_type") or "",
            task=body.get("task") or f"Reference session for {body.get('plot_type')}",
            limit=int(body.get("limit") or 50),
            session_id=body.get("session_id") or "",
            strategy=body.get("strategy") or "explore",
            seed=int(body["seed"]) if body.get("seed") not in (None, "") else None,
        )
        session_json = Path(sess["workdir"]) / "reference_session.json"
        return enrich_session(afg.session_payload(KB_ROOT, session_json))
    except Exception as e:  # noqa: BLE001
        return _unavailable(e)


@router.get("/session")
def get_session(session: str = Query("")):
    """按会话路径或 session_id 取完整会话。"""
    try:
        afg = _load_afg()
        return enrich_session(afg.session_payload(KB_ROOT, afg.resolve_session(KB_ROOT, session or None)))
    except Exception as e:  # noqa: BLE001
        return _unavailable(e)


@router.get("/top")
def top_candidate(plot_type: str = "", candidate_id: str = ""):
    """取质量最高的单个候选（编辑器默认示例用）。

    不落会话文件，纯读索引：默认返回全类型质量第 1 名；可用 plot_type / candidate_id 收窄。
    """
    try:
        afg = _load_afg()
        index = afg.load_index(KB_ROOT)
        rejected = set(afg.load_global_preferences(KB_ROOT).get("rejected", []))
        pool = [
            item
            for item in index.get("candidates", [])
            if item.get("preview_path") and afg.global_preference_key(item) not in rejected
        ]
        if candidate_id:
            pool = [
                i
                for i in pool
                if candidate_id in {i.get("stable_candidate_id"), i.get("candidate_id"), i.get("display_id"), i.get("reference_candidate_id")}
            ]
        if plot_type:
            pool = [i for i in pool if (i.get("plot_type") or i.get("primary_plot_type")) == plot_type]
        pool.sort(key=lambda item: (-(float(item.get("quality_score") or 0)), item.get("stable_candidate_id") or ""))
        if not pool:
            return {"available": False, "candidate": None, "root": str(KB_ROOT)}
        cand = dict(pool[0])
        sid = cand.get("stable_candidate_id") or cand.get("candidate_id") or cand.get("reference_candidate_id")
        cand["candidate_id"] = sid
        cand["stable_candidate_id"] = sid
        cand["display_id"] = cand.get("display_id") or sid
        cand["source_repo"] = cand.get("source_repo") or cand.get("repo")
        cand["palette"] = derive_palette(cand)
        sp = cand.get("script_path_rel")
        cand["script_exists"] = bool(sp) and afg.safe_path(KB_ROOT, sp).is_file()
        return {"available": True, "candidate": cand, "root": str(KB_ROOT)}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "candidate": None, "root": str(KB_ROOT), "error": str(e)}


@router.post("/featured")
def featured(body: dict):
    """精选榜：跨全部 plot_type 按 quality_score 从高到低取 Top N，组成固定会话。

    固定 session_id（featured_top_quality），重复调用覆盖同一会话；已存在的
    preferences.json 会被保留，所以在精选榜上的 赞/拒/选 不会因刷新而丢失。
    """
    try:
        afg = _load_afg()
        limit = max(1, min(int(body.get("limit") or 24), 100))
        session_id = "featured_top_quality"
        workdir = KB_ROOT / "outputs" / "reference_sessions" / session_id
        index = afg.load_index(KB_ROOT)
        global_prefs = afg.load_global_preferences(KB_ROOT)
        rejected = set(global_prefs.get("rejected", []))
        pool = [
            item
            for item in index.get("candidates", [])
            if item.get("preview_path") and afg.global_preference_key(item) not in rejected
        ]
        pool.sort(key=lambda item: (-(float(item.get("quality_score") or 0)), item.get("stable_candidate_id") or ""))
        normalized: list[dict] = []
        for pos, cand in enumerate(pool[:limit], start=1):
            item = dict(cand)
            stable_id = item.get("stable_candidate_id") or item.get("candidate_id") or item.get("reference_candidate_id")
            item["candidate_id"] = stable_id
            item["stable_candidate_id"] = stable_id
            item["display_id"] = stable_id
            item["session_candidate_id"] = f"T{pos:02d}"
            item.setdefault("source_repo", item.get("repo") or item.get("source_repo"))
            item.setdefault("status", "candidate")
            normalized.append(item)
        if not normalized:
            raise HTTPException(503, "知识库中没有带预览图的候选，无法生成精选榜")
        prefs_file = workdir / "preferences.json"
        if prefs_file.is_file():
            preferences = afg.read_json(prefs_file)
        else:
            preferences = {
                "scope": {"level": "plot_type_session", "plot_type": "featured", "session_id": session_id},
                "liked": [],
                "rejected": [],
                "selected": [],
                "notes": {},
                "updated_at": afg.utc_now(),
            }
        session = {
            "schema_version": "agentfiguregallery.reference_session.v1",
            "session_id": session_id,
            "created_at": afg.utc_now(),
            "updated_at": afg.utc_now(),
            "workdir": str(workdir),
            "query": {"task": "全类型质量榜（featured）", "plot_type": "featured"},
            "generation": {"strategy": "featured", "seed": None, "limit": limit},
            "resolved": {"plot_type": "featured"},
            "selection": {
                "title": "Featured Top Quality",
                "goal": "跨全部绘图类型、按质量分从高到低的精选参考",
                "recommended_palettes": [],
                "self_check": [],
            },
            "paths": {
                "session_json": str(workdir / "reference_session.json"),
                "preferences_json": str(prefs_file),
                "candidate_sheets": [],
            },
            "candidate_summary": {
                "count": len(normalized),
                "source_repos": sorted({i.get("source_repo") or "local" for i in normalized}),
            },
            "candidates": normalized,
            "preferences": preferences,
        }
        afg.write_json(prefs_file, preferences)
        afg.write_json(workdir / "reference_session.json", session)
        return enrich_session(afg.session_payload(KB_ROOT, workdir / "reference_session.json"))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        return _unavailable(e)


@router.get("/candidate")
def get_candidate(session: str = Query(""), candidate_id: str = Query("")):
    """取单个候选的完整元数据（设计要点 / 源码路径 / 推断调色板 / 源码是否随库分发）。"""
    try:
        afg = _load_afg()
        session_json = afg.resolve_session(KB_ROOT, session or None)
        payload = afg.session_payload(KB_ROOT, session_json)
        target = None
        for c in payload.get("candidates", []) or []:
            if candidate_id in {c.get("candidate_id"), c.get("stable_candidate_id"), c.get("display_id")}:
                target = c
                break
        if not target:
            raise HTTPException(404, "候选不存在")
        target["palette"] = derive_palette(target)
        sp = target.get("script_path_rel")
        target["script_exists"] = bool(sp) and afg.safe_path(KB_ROOT, sp).is_file()
        return target
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        return _unavailable(e)


class PrefIn(BaseModel):
    session: str = ""
    candidate_id: str = ""
    action: str = ""
    updated_at: str = ""


@router.post("/preference")
def preference(body: PrefIn):
    """like / reject / select / clear / clear_rejected / global_* 偏好操作。"""
    try:
        afg = _load_afg()
        session_json = afg.resolve_session(KB_ROOT, body.session or None)
        payload = body.model_dump()
        return afg.update_preference(KB_ROOT, session_json, payload)
    except Exception as e:  # noqa: BLE001
        return _unavailable(e)


@router.post("/export")
def export_bundle(body: dict):
    """导出选中参考 bundle（selected → 退而求其次 liked）。"""
    try:
        afg = _load_afg()
        session_json = afg.resolve_session(KB_ROOT, body.get("session") or None)
        return afg.export_bundle(KB_ROOT, session_json, bool(body.get("copy_scripts")))
    except Exception as e:  # noqa: BLE001
        return _unavailable(e)


@router.get("/media")
def media(path: str = Query("")):
    """取候选预览图（路径限定在 KB_ROOT 内，防越权）。"""
    try:
        afg = _load_afg()
        file = afg.safe_path(KB_ROOT, path or "")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e))
    if not file.is_file():
        raise HTTPException(404, "预览图不存在")
    return FileResponse(file, media_type=mimetypes.guess_type(str(file))[0] or "image/png")


# ---------------------------------------------------------------- Python 真实渲染
#
# 口径：画廊候选只带预览图、不带源脚本（KB 里 script 数为 0）。所以「拿到这张图的代码」
# 走的是「版式复刻」：内置一份与参考图同版式的 matplotlib 脚本（server/templates/），
# 用户可在代码页签里直接改，改完交给工作区 venv 的 python 真跑一遍，出 PNG / PDF / SVG。
# 渲染的是真实 matplotlib 输出（矢量可用），但数据仍是示意 —— 别当成实测结果。

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates"
TEMPLATE_FILES = {
    "chi1_scatter": TEMPLATE_DIR / "chi1_scatter.py",
}


def _template_code(key: str) -> str:
    f = TEMPLATE_FILES.get(key)
    if not f or not f.is_file():
        raise HTTPException(404, f"没有名为 {key} 的绘图模板")
    return f.read_text(encoding="utf-8")


class RenderIn(BaseModel):
    code: str = ""
    template: str = "chi1_scatter"
    stem: str = "figure"
    dpi: int = 200


@router.get("/python-template")
def python_template(template: str = Query("chi1_scatter")):
    """取内置绘图模板的源码（编辑器「Python 代码」页签首次打开时用）。"""
    code = _template_code(template)
    return {"ok": True, "template": template, "code": code,
            "templates": sorted(TEMPLATE_FILES)}


@router.post("/render-python")
def render_python(body: RenderIn):
    """把（可编辑的）matplotlib 脚本写进工作区，用 venv python 真跑，回图 + 产物。"""
    import workspace as ws  # 局部导入：与 routers/workspace.py 一致（server/ 在 sys.path 上）

    code = body.code.strip()
    if not code:
        code = _template_code(body.template)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", body.stem or "figure").strip("_") or "figure"
    script = f"{stem}.py"

    try:
        ws.write_text("figure", ws.DEFAULT_OWNER, script, code)
        res = ws.run_python(script, kind="figure")
    except ValueError as e:
        raise HTTPException(422, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "脚本不存在")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"渲染失败：{e}")

    out = res.get("outputs") or []
    imgs = [o for o in out if o.lower().endswith((".png", ".pdf", ".svg"))]

    def url(name: str) -> str:
        return f"/api/workspace/artifact?kind=figure&name={name}"

    png = next((o for o in imgs if o.lower().endswith(".png")), "")
    return {
        "ok": res.get("status") == "ok",
        "status": res.get("status"),
        "script": script,
        "code": code,
        "log": res.get("stdout") or res.get("tail") or "",
        "error": res.get("error"),
        "image": url(png) if png else "",
        "outputs": [{"name": o, "url": url(o), "ext": os.path.splitext(o)[1].lower()} for o in imgs],
        "run_id": res.get("run_id"),
    }

