"""通用工作区 API：.tex 文件管理 + LaTeX 编译 + 数据分析 + 代码运行 + 全局任务带聚合。

命令全部由后端白名单拼装、subprocess.run(shell=False)：
  - LaTeX 编译：workspace.compile_tex 只认引擎名；
  - 数据分析：workspace.analyze_dataset 只认 4 个模板（preview/describe/compare/correlate）；
  - 代码运行：workspace.run_python 只允许跑工作区内已存在的 .py 文件。
均不开放任意命令行输入。
"""
import json
import mimetypes
import re

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

import workspace as core

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


def _fail(e: Exception, code: int = 400):
    raise HTTPException(code, str(e))


# ---------------------------------------------------------------- 编译设置


@router.get("/status")
def status():
    st = core.tex_status()
    st["kinds"] = list(core.KINDS)
    return st


class SettingsIn(BaseModel):
    bin_dir: str = ""
    engine: str = core.DEFAULT_ENGINE


@router.put("/settings")
def put_settings(body: SettingsIn):
    engine = body.engine.strip() or core.DEFAULT_ENGINE
    if engine not in core.TEX_ENGINES:
        raise HTTPException(400, f"不支持的编译引擎：{engine}")
    # 空串 = 保持原值（前端拿到的是回显值，没改就不该把探测结果清掉）
    if body.bin_dir.strip():
        core.set_setting(core.SETTING_BIN, body.bin_dir.strip())
    core.set_setting(core.SETTING_ENGINE, engine)
    return core.tex_status()


@router.post("/settings/detect")
def detect_settings():
    """重新探测本机 TeX bin，探测到就写回 settings（手动填过的值不再被覆盖）。"""
    found = core.detect_tex_bin()
    if found:
        core.set_setting(core.SETTING_BIN, found)
    st = core.tex_status()
    st["detected"] = bool(found)
    return st


# ---------------------------------------------------------------- 文件管理


@router.get("/files")
def files(kind: str = "tex", owner: str = core.DEFAULT_OWNER):
    try:
        return core.list_files(kind, owner)
    except ValueError as e:
        _fail(e, 422)


@router.get("/file")
def file(kind: str = "tex", name: str = "", owner: str = core.DEFAULT_OWNER):
    try:
        return core.read_text(kind, owner, name)
    except FileNotFoundError:
        raise HTTPException(404, "文件不存在")
    except ValueError as e:
        _fail(e, 422)


class FileIn(BaseModel):
    kind: str = "tex"
    owner: str = core.DEFAULT_OWNER
    name: str
    content: str = ""


@router.put("/file")
def put_file(body: FileIn):
    try:
        return core.write_text(body.kind, body.owner, body.name, body.content)
    except ValueError as e:
        _fail(e, 422)


FIGURE_TEMPLATE = {
    "type": "bar",
    "title": "示例：方法对比（示意数据，非实测）",
    "x_label": "方法",
    "y_label": "准确率",
    "categories": ["Baseline", "Ours"],
    "series": [{"name": "准确率", "values": [0.72, 0.86]}],
    "points": [],
    "note": "示意数据（illustrative）：手动填写的 spec 不得作为实测结果进论文结论。",
}


class NewFileIn(BaseModel):
    kind: str = "tex"
    owner: str = core.DEFAULT_OWNER
    name: str


@router.post("/file")
def new_file(body: NewFileIn):
    rel = core.safe_rel(body.name)
    if not rel:
        raise HTTPException(422, "非法文件名")
    p = core.resolve(body.kind, body.owner, rel)
    if p.exists():
        raise HTTPException(400, "同名文件已存在，换个名字或直接编辑它")
    ext = p.suffix.lower()
    if ext == ".tex":
        content = core.TEX_TEMPLATE
    elif ext == ".json":
        content = json.dumps(FIGURE_TEMPLATE, ensure_ascii=False, indent=2)
    elif ext == ".py":
        content = "# 工作区脚本（P1 接真实执行）\n\nprint('hello from workspace')\n"
    elif ext == ".csv":
        content = "case,method,metric\n"
    else:
        content = ""
    try:
        return core.write_text(body.kind, body.owner, rel, content)
    except ValueError as e:
        _fail(e, 422)


@router.delete("/file")
def delete_file(kind: str = "tex", name: str = "", owner: str = core.DEFAULT_OWNER):
    try:
        core.delete_file(kind, owner, name)
    except FileNotFoundError:
        raise HTTPException(404, "文件不存在")
    except ValueError as e:
        _fail(e, 422)
    return {"ok": True}


@router.get("/artifact")
def artifact(
    kind: str = "tex",
    name: str = "",
    owner: str = core.DEFAULT_OWNER,
    v: str = Query("", description="破缓存用的 nonce，不参与路径解析"),
):
    """二进制产物（PDF / PNG）直出，给 PdfViewer 与新标签下载用。"""
    try:
        p = core.resolve(kind, owner, name)
    except ValueError as e:
        _fail(e, 422)
    if not p.is_file():
        raise HTTPException(404, "产物不存在")
    if p.stat().st_size > core.MAX_ARTIFACT_BYTES:
        raise HTTPException(422, "产物过大（>20MB）")
    media, _ = mimetypes.guess_type(p.name)
    return FileResponse(str(p), media_type=media or "application/octet-stream", filename=p.name)


# ---------------------------------------------------------------- LaTeX 编译


class CompileIn(BaseModel):
    name: str
    engine: str = core.DEFAULT_ENGINE
    owner: str = core.DEFAULT_OWNER


@router.post("/tex/compile")
def compile_tex(body: CompileIn):
    try:
        return core.compile_tex(body.name, body.engine, body.owner)
    except FileNotFoundError:
        raise HTTPException(404, "文件不存在")
    except (ValueError, RuntimeError) as e:
        _fail(e, 422)


# ---------------------------------------------------------------- 数据分析（P1）

_ANALYSIS_RE = re.compile(r"[^A-Za-z0-9._-]")


@router.post("/analysis/upload")
async def analysis_upload(file: UploadFile = File(...), owner: str = core.DEFAULT_OWNER):
    """上传数据集（CSV / XLSX）到分析工作区；文件名做安全清洗，禁止路径越界。"""
    raw = file.filename or "dataset.csv"
    name = _ANALYSIS_RE.sub("_", raw)
    low = name.lower()
    if not (low.endswith(".csv") or low.endswith(".xlsx")):
        raise HTTPException(400, "只接受 .csv / .xlsx 数据集")
    p = core.resolve("analysis", owner, name)
    data = await file.read()
    if len(data) > core.MAX_ARTIFACT_BYTES:
        raise HTTPException(413, "文件过大（>20MB）")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return {"name": name, "size": len(data)}


class AnalysisIn(BaseModel):
    name: str
    template: str = "describe"
    group_col: str = ""
    value_col: str = ""
    owner: str = core.DEFAULT_OWNER


@router.post("/analysis/run")
def analysis_run(body: AnalysisIn):
    try:
        return core.analyze_dataset(body.name, body.template, body.group_col, body.value_col, body.owner)
    except FileNotFoundError:
        raise HTTPException(404, "数据集不存在")
    except (ValueError, RuntimeError) as e:
        _fail(e, 422)


@router.get("/analysis/columns")
def analysis_columns(name: str, owner: str = core.DEFAULT_OWNER):
    """读数据集列名 + 数值列（仅表头），给分组/数值下拉用。"""
    try:
        return core.dataset_columns(name, owner)
    except FileNotFoundError:
        raise HTTPException(404, "数据集不存在")
    except (ValueError, RuntimeError) as e:
        _fail(e, 422)


# ---------------------------------------------------------------- 代码运行（P1）


class CodeRunIn(BaseModel):
    name: str
    owner: str = core.DEFAULT_OWNER


@router.post("/code/run")
def code_run(body: CodeRunIn):
    try:
        return core.run_python(body.name, kind="code", owner=body.owner)
    except FileNotFoundError:
        raise HTTPException(404, "脚本不存在")
    except ValueError as e:
        _fail(e, 422)


# ---------------------------------------------------------------- 全局任务带



@router.get("/runs")
def runs(limit: int = 20):
    """只读聚合 workspace_runs / canvas_runs / exp_runs；不改动任何既有表。"""
    return core.list_runs(limit)
