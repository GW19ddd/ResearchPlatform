"""通用工作区执行底座（P0）。

四个能力工作室共用同一套「文件即产物 + 运行留痕」的机制：

    tex      论文工作室：.tex / .bib / 编译产物 PDF
    figure   绘图工作室：图表 spec（JSON）
    analysis 分析工作室：CSV / 结果表（P1 再接真实 Python 渲染）
    code     代码工作室：脚本与运行产物（P1）

从 expagent 泛化而来，但有三处刻意不同：

1. **命令不接受任意字符串**。只认 TEX_ENGINES 里的引擎名，参数由后端拼装，
   subprocess.run(shell=False)，从根上掐掉 shell 注入（expagent 的 shell=True
   是历史遗留，本底座不沿用）。
2. **TeX 可执行目录走 settings 注入**。服务由计划任务启动时 PATH 里常常没有
   MiKTeX，编译会直接「命令不存在」，所以显式探测并持久化 bin_dir。
3. **统一 run 记录写 workspace_runs**，供底部「全局任务带」只读聚合；
   既有 exp_runs / canvas_runs 一行不改。
"""
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import config
from db import execute, now, query

KINDS = ("tex", "figure", "analysis", "code")
DEFAULT_OWNER = "default"

RUN_TIMEOUT_S = 180
MAX_FILE_CHARS = 200_000
MAX_OUTPUT_CHARS = 8000
MAX_ARTIFACT_BYTES = 20 * 1024 * 1024

SETTING_BIN = "workspace.latex.bin_dir"
SETTING_ENGINE = "workspace.latex.engine"

# 允许执行的 LaTeX 引擎 → (可执行文件名, 固定参数)。
# 用户只能传这里的 key，不能传命令；参数也由后端决定，不开放拼接。
TEX_ENGINES = {
    "xelatex": ("xelatex", ["-interaction=nonstopmode", "-halt-on-error"]),
    "pdflatex": ("pdflatex", ["-interaction=nonstopmode", "-halt-on-error"]),
    "lualatex": ("lualatex", ["-interaction=nonstopmode", "-halt-on-error"]),
    "latexmk": ("latexmk", ["-xelatex", "-interaction=nonstopmode", "-halt-on-error", "-silent"]),
}
DEFAULT_ENGINE = "xelatex"

# 服务进程 PATH 不可靠时的兜底探测顺序（都是本机常见安装位置）。
TEX_BIN_CANDIDATES = [
    r"D:\01-App\06_Academic\MiKTeX\miktex\bin\x64",
    r"C:\Program Files\MiKTeX\miktex\bin\x64",
    r"C:\Program Files (x86)\MiKTeX\miktex\bin\x64",
    r"C:\texlive\2024\bin\windows",
    r"C:\texlive\2025\bin\windows",
]

# 新建 .tex 的默认模板：刻意不依赖 ctex / 中文字体，保证任何 MiKTeX 都能一次编译过。
# 中文写法在论文工作室的提示里给，由用户自己往导言区加，避免缺宏包时静默失败。
TEX_TEMPLATE = r"""\documentclass[11pt]{article}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled Draft}
\author{}
\date{}

\begin{document}
\maketitle

\begin{abstract}
Write the abstract here.
\end{abstract}

\section{Introduction}
Write here.

\section{Method}
\begin{equation}
    y = f(x)
\end{equation}

\section{Results}
Fill in with measured numbers only.

\section{Conclusion}
Write here.

\end{document}
"""


# ---------------------------------------------------------------- settings


def get_setting(key: str, default: str = "") -> str:
    try:
        rows = query("SELECT value FROM settings WHERE key=?", (key,))
        return (rows[0]["value"] or default) if rows else default
    except Exception:  # noqa: BLE001 —— 表还没建好时不阻断
        return default


def set_setting(key: str, value: str) -> str:
    if query("SELECT key FROM settings WHERE key=?", (key,)):
        execute("UPDATE settings SET value=? WHERE key=?", (value, key))
    else:
        execute("INSERT INTO settings (key, value) VALUES (?,?)", (key, value))
    return value


def _exe_in(bin_dir: str, name: str) -> str:
    """在指定 bin 目录里找可执行文件；Windows 补 .exe。"""
    if not bin_dir:
        return ""
    p = Path(bin_dir) / name
    if os.name == "nt":
        e = p.with_suffix(".exe")
        if e.is_file():
            return str(e)
    return str(p) if p.is_file() else ""


def detect_tex_bin() -> str:
    """返回可用的 TeX bin 目录；找不到返回空串，由前端提示用户手填。"""
    saved = get_setting(SETTING_BIN).strip()
    if saved and Path(saved).is_dir():
        return saved
    for n in ("xelatex", "pdflatex", "latexmk"):
        w = shutil.which(n)
        if w:
            return str(Path(w).resolve().parent)
    for d in TEX_BIN_CANDIDATES:
        if Path(d).is_dir() and _exe_in(d, "xelatex"):
            return d
    return ""


def tex_status() -> dict:
    bin_dir = detect_tex_bin()
    engine = get_setting(SETTING_ENGINE, DEFAULT_ENGINE).strip() or DEFAULT_ENGINE
    if engine not in TEX_ENGINES:
        engine = DEFAULT_ENGINE
    exe_name, _ = TEX_ENGINES[engine]
    exe = _exe_in(bin_dir, exe_name)
    return {
        "bin_dir": bin_dir,
        "engine": engine,
        "engines": sorted(TEX_ENGINES.keys()),
        "resolved_exe": exe,
        "ready": bool(exe),
        "hint": "" if exe else "没找到 LaTeX 可执行文件，请在下方填写 MiKTeX / TeX Live 的 bin 目录（例：D:\\01-App\\06_Academic\\MiKTeX\\miktex\\bin\\x64）",
    }


def _sub_env(bin_dir: str = "") -> dict:
    env = os.environ.copy()
    extra: list[str] = []
    if bin_dir:
        extra.append(bin_dir)
    exe_dir = Path(sys.executable).resolve().parent
    extra += [str(exe_dir), str(exe_dir / "Scripts")]
    env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
    return env


# ---------------------------------------------------------------- 工作区路径


def _safe_owner(owner: str | None) -> str:
    o = (owner or DEFAULT_OWNER).strip()
    return o if o and all(c.isalnum() or c in "-_" for c in o) else DEFAULT_OWNER


def ws_dir(kind: str, owner: str | None = DEFAULT_OWNER) -> Path:
    if kind not in KINDS:
        raise ValueError(f"未知工作区类型：{kind}")
    return config.DATA_DIR / "workspace" / kind / _safe_owner(owner)


def safe_rel(name: str) -> str | None:
    """只允许工作区相对路径，禁止越界 / 绝对路径 / 盘符 / 家目录。"""
    n = (name or "").strip().replace("\\", "/").lstrip("/")
    if not n or n.startswith("~") or ":" in n:
        return None
    parts = [p for p in n.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def resolve(kind: str, owner: str | None, name: str) -> Path:
    rel = safe_rel(name)
    if not rel:
        raise ValueError("非法文件名")
    root = ws_dir(kind, owner)
    p = (root / rel).resolve()
    # resolve() 后再兜一次：软链接 / 符号跳转也不能跑出工作区
    try:
        p.relative_to(root.resolve())
    except ValueError:
        raise ValueError("路径越出工作区")
    return p


def list_files(kind: str, owner: str | None = DEFAULT_OWNER) -> list[dict]:
    root = ws_dir(kind, owner)
    if not root.is_dir():
        return []
    out = []
    for f in sorted(root.rglob("*")):
        if not f.is_file():
            continue
        try:
            st = f.stat()
        except OSError:
            continue
        rel = f.relative_to(root).as_posix()
        out.append({
            "name": rel,
            "size": st.st_size,
            "mtime": st.st_mtime,
            "ext": f.suffix.lower(),
        })
    return out


def read_text(kind: str, owner: str | None, name: str) -> dict:
    p = resolve(kind, owner, name)
    if not p.is_file():
        raise FileNotFoundError(name)
    if p.stat().st_size > MAX_ARTIFACT_BYTES:
        raise ValueError("文件过大（>20MB），请拆分后再看")
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise ValueError(f"读取失败：{e}")
    return {"name": safe_rel(name), "size": p.stat().st_size, "content": content}


def write_text(kind: str, owner: str | None, name: str, content: str) -> dict:
    rel = safe_rel(name)
    if not rel:
        raise ValueError("非法文件名")
    if len(content) > MAX_FILE_CHARS:
        raise ValueError(f"内容过长（>{MAX_FILE_CHARS} 字符）")
    p = resolve(kind, owner, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return {"name": rel, "size": p.stat().st_size}


def delete_file(kind: str, owner: str | None, name: str) -> None:
    p = resolve(kind, owner, name)
    if not p.is_file():
        raise FileNotFoundError(name)
    p.unlink()
    # 同名编译产物（aux/log/out/pdf/synctex.gz 等）没有独立删除入口，源删了它们就是孤儿，一并清掉
    if p.suffix.lower() == ".tex":
        for ext in (".aux", ".log", ".out", ".pdf", ".synctex.gz", ".fls", ".fdb_latexmk", ".xdv"):
            side = p.parent / (p.stem + ext)  # synctex.gz 是双后缀，用 stem+ext 拼接而不是 with_suffix
            if side.is_file() and side != p:
                side.unlink()


def _snapshot(root: Path) -> dict[str, float]:
    snap: dict[str, float] = {}
    for f in root.rglob("*"):
        if f.is_file():
            try:
                snap[f.relative_to(root).as_posix()] = f.stat().st_mtime
            except OSError:
                pass
    return snap


# ---------------------------------------------------------------- 运行记录


def _new_run(kind: str, owner: str | None, label: str, command: str) -> tuple[int, str]:
    run_id = uuid.uuid4().hex[:16]
    ts = now()
    rid = execute(
        """INSERT INTO workspace_runs
           (run_id, kind, owner_id, label, command, status, created_at)
           VALUES (?,?,?,?,?,'running',?)""",
        (run_id, kind, _safe_owner(owner), label, command, ts),
    )
    return rid, run_id


def _finish_run(rid: int, status: str, exit_code: int | None, wall_ms: int,
                tail: str, outputs: list[str], error: str | None) -> None:
    execute(
        """UPDATE workspace_runs SET status=?, exit_code=?, wall_ms=?,
           stdout_tail=?, outputs_json=?, error=?, finished_at=? WHERE id=?""",
        (status, exit_code, wall_ms, tail[-MAX_OUTPUT_CHARS:],
         json.dumps(outputs, ensure_ascii=False), error, now(), rid),
    )


def compile_tex(name: str, engine: str = DEFAULT_ENGINE,
                owner: str | None = DEFAULT_OWNER) -> dict:
    """编译工作区里的 .tex。命令由后端拼装，不接受用户传命令行。"""
    rel = safe_rel(name)
    if not rel or not rel.lower().endswith(".tex"):
        raise ValueError("编译入口必须是工作区内的 .tex 文件")
    root = ws_dir("tex", owner)
    src = root / rel
    if not src.is_file():
        raise FileNotFoundError(rel)
    engine = (engine or DEFAULT_ENGINE).strip()
    if engine not in TEX_ENGINES:
        raise ValueError(f"不支持的编译引擎：{engine}")

    bin_dir = detect_tex_bin()
    exe_name, base_args = TEX_ENGINES[engine]
    exe = _exe_in(bin_dir, exe_name)
    if not exe:
        raise RuntimeError(
            "没找到 LaTeX 可执行文件：请在论文工作室的「编译设置」里填 MiKTeX / TeX Live 的 bin 目录"
        )

    argv = [exe, *base_args, rel]
    display_cmd = f"{exe_name} {' '.join(base_args)} {rel}"
    rid, run_id = _new_run("tex", owner, f"编译 {rel}", display_cmd)
    pre = _snapshot(root)
    t0 = time.monotonic()

    try:
        proc = subprocess.run(
            argv, shell=False, cwd=str(root), capture_output=True,
            text=True, encoding="utf-8", errors="replace",
            timeout=RUN_TIMEOUT_S, env=_sub_env(bin_dir),
        )
        wall = int((time.monotonic() - t0) * 1000)
        code = proc.returncode
        tail = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        status = "ok" if code == 0 else "failed"
        error = None if status == "ok" else f"退出码 {code}"
    except subprocess.TimeoutExpired:
        wall = RUN_TIMEOUT_S * 1000
        code, status = -9, "failed"
        tail = f"[超时] 超过 {RUN_TIMEOUT_S}s 被强杀"
        error = "编译超时"
    except Exception as e:  # noqa: BLE001
        wall = int((time.monotonic() - t0) * 1000)
        code, status = -1, "failed"
        tail = f"[执行异常] {type(e).__name__}: {e}"
        error = str(e)

    if not tail.strip():
        tail = f"[退出码 {code}]（无输出——可能是引擎不存在或立即崩溃）"

    post = _snapshot(root)
    changed = sorted(k for k, v in post.items() if pre.get(k) != v)
    pdf_name = rel[:-4] + ".pdf"
    pdf_path = root / pdf_name
    pdf_ok = status == "ok" and pdf_path.is_file()
    if status == "ok" and not pdf_ok:
        status, error = "failed", "编译退出码为 0，但没有生成 PDF（检查 .log）"
        code = code if code else -2

    _finish_run(rid, status, code, wall, tail, changed, error)

    # 失败时把 .log 的尾部并进回显，用户不用再点开文件也能看到缺哪个包
    log_path = root / (rel[:-4] + ".log")
    log_tail = ""
    if log_path.is_file():
        try:
            log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
        except OSError:
            pass

    return {
        "ok": status == "ok",
        "run_id": run_id,
        "status": status,
        "exit_code": code,
        "wall_ms": wall,
        "pdf": pdf_name if pdf_ok else None,
        "log_tail": log_tail,
        "tail": tail[-MAX_OUTPUT_CHARS:],
        "outputs": changed,
        "error": error,
    }


# ---------------------------------------------------------------- Python 执行（P1）
#
# 分析 / 代码工作室的真实执行底座：只允许跑工作区内已存在的 .py 文件，
# 命令由后端拼装、subprocess.run(shell=False)，与 LaTeX 编译同款安全边界。
# 解释器复用服务进程自身所在的 venv（已装 pandas / matplotlib / scipy / openpyxl）。


def _python_exe() -> str:
    """服务进程所在的 venv python——它就是装了科学栈的那个解释器。"""
    return str(Path(sys.executable).resolve())


def run_python(name: str, kind: str = "code", owner: str | None = DEFAULT_OWNER) -> dict:
    """运行工作区里的 .py 脚本（代码工作室）。返回 stdout / 产物清单 / 运行记录。"""
    rel = safe_rel(name)
    if not rel or not rel.lower().endswith(".py"):
        raise ValueError("代码执行入口必须是工作区内的 .py 文件")
    root = ws_dir(kind, owner)
    src = root / rel
    if not src.is_file():
        raise FileNotFoundError(rel)

    display_cmd = f"python {rel}"
    rid, run_id = _new_run(kind, owner, f"运行 {rel}", display_cmd)
    pre = _snapshot(root)
    t0 = time.monotonic()

    try:
        proc = subprocess.run(
            [_python_exe(), rel],
            shell=False, cwd=str(root), capture_output=True,
            text=True, encoding="utf-8", errors="replace",
            timeout=RUN_TIMEOUT_S, env=_sub_env(),
        )
        wall = int((time.monotonic() - t0) * 1000)
        code = proc.returncode
        tail = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else "")
        status = "ok" if code == 0 else "failed"
        error = None if status == "ok" else f"退出码 {code}"
    except subprocess.TimeoutExpired:
        wall = RUN_TIMEOUT_S * 1000
        code, status = -9, "failed"
        tail = f"[超时] 超过 {RUN_TIMEOUT_S}s 被强杀"
        error = "执行超时"
    except Exception as e:  # noqa: BLE001
        wall = int((time.monotonic() - t0) * 1000)
        code, status = -1, "failed"
        tail = f"[执行异常] {type(e).__name__}: {e}"
        error = str(e)

    if not tail.strip():
        tail = f"[退出码 {code}]（无输出）"

    post = _snapshot(root)
    changed = sorted(k for k, v in post.items() if pre.get(k) != v)
    _finish_run(rid, status, code, wall, tail, changed, error)

    return {
        "ok": status == "ok",
        "run_id": run_id,
        "status": status,
        "exit_code": code,
        "wall_ms": wall,
        "stdout": tail[-MAX_OUTPUT_CHARS:],
        "outputs": changed,
        "error": error,
    }


# 服务端生成的分析脚本模板：读取数据集 → 按模板出表 + 可选图表 → 写 analysis_result.json。
# 字段占位符由 analyze_dataset 在调用前替换；脚本本身只读数据集、只写工作区内的产物。
_ANALYZE_TMPL = r'''
import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

try:
    from matplotlib import font_manager
    _cjk = None
    for _c in ["Microsoft YaHei", "SimHei", "SimSun", "Noto Sans CJK SC", "WenQuanYi Micro Hei"]:
        if any(_c.lower() in f.name.lower() for f in font_manager.fontManager.ttflist):
            _cjk = _c
            break
    if _cjk:
        plt.rcParams["font.family"] = _cjk
except Exception:
    pass
plt.rcParams["axes.unicode_minus"] = False

import pandas as pd

SRC = "__SRC__"
TEMPLATE = "__TEMPLATE__"
GROUP = "__GROUP__"
VALUE = "__VALUE__"


def main():
    if SRC.lower().endswith(".csv"):
        df = pd.read_csv(SRC, encoding="utf-8-sig")
    else:
        df = pd.read_excel(SRC)
    numeric = df.select_dtypes(include="number")
    result = {
        "template": TEMPLATE,
        "rows": int(len(df)),
        "cols": [str(c) for c in df.columns],
        "n_numeric": int(len(numeric.columns)),
        "table": None,
        "chart_png": None,
        "summary": "",
    }

    if TEMPLATE == "preview":
        head = df.head(20)
        result["table"] = {
            "headers": [str(c) for c in head.columns],
            "rows": head.astype(str).values.tolist(),
        }
        result["summary"] = f"前 20 行预览 · 全表 {len(df)} 行"

    elif TEMPLATE == "describe":
        if len(numeric.columns) == 0:
            result["summary"] = "没有数值列，无法做描述统计"
        else:
            desc = numeric.describe().T[["count", "mean", "std", "min", "25%", "50%", "75%", "max"]]
            result["table"] = {
                "headers": ["字段", "count", "mean", "std", "min", "25%", "50%", "75%", "max"],
                "rows": [[str(i)] + [round(float(x), 4) for x in r]
                         for i, r in zip(desc.index, desc.values)],
            }
            result["summary"] = f"{len(numeric.columns)} 个数值字段的描述统计"
            plt.figure(figsize=(6, 3.2))
            plt.bar([str(c) for c in desc.index], desc["mean"].values, color="#4f46e5")
            plt.title("各数值字段均值")
            plt.xticks(rotation=30, ha="right", fontsize=8)
            plt.tight_layout()
            plt.savefig("analysis_chart.png", dpi=120)
            plt.close()
            result["chart_png"] = "analysis_chart.png"

    elif TEMPLATE == "compare":
        g = GROUP if GROUP in df.columns else None
        v = VALUE if VALUE in df.columns else (numeric.columns[0] if len(numeric.columns) else None)
        if g and v:
            grp = df.groupby(g)[v].agg(["count", "mean", "std"]).reset_index()
            result["table"] = {
                "headers": [str(g), "n", "mean", "std"],
                "rows": [[str(r[0]), int(r[1]), round(float(r[2]), 4),
                          (round(float(r[3]), 4) if pd.notna(r[3]) else None)]
                         for r in grp.itertuples(index=False)],
            }
            plt.figure(figsize=(6, 3.2))
            plt.bar([str(x) for x in grp[g]], grp["mean"].values,
                    yerr=grp["std"].values, capsize=3, color="#0f9d58")
            plt.title(f"{v} 按 {g} 分组均值（误差棒=±std）")
            plt.xticks(rotation=30, ha="right", fontsize=8)
            plt.tight_layout()
            plt.savefig("analysis_chart.png", dpi=120)
            plt.close()
            result["chart_png"] = "analysis_chart.png"
            result["summary"] = f"按 {g} 分组比较 {v}：共 {len(grp)} 组"
        else:
            result["summary"] = "未指定有效分组列或数值列"

    elif TEMPLATE == "correlate":
        if len(numeric.columns) >= 2:
            corr = numeric.corr()
            result["table"] = {
                "headers": [""] + [str(c) for c in corr.columns],
                "rows": [[str(i)] + [round(float(x), 3) for x in r]
                         for i, r in zip(corr.index, corr.values)],
            }
            plt.figure(figsize=(5, 4.2))
            plt.imshow(corr.values, cmap="coolwarm", vmin=-1, vmax=1)
            plt.colorbar()
            plt.xticks(range(len(corr.columns)), corr.columns, rotation=45, ha="right", fontsize=7)
            plt.yticks(range(len(corr.columns)), corr.columns, fontsize=7)
            plt.title("Pearson 相关性")
            plt.tight_layout()
            plt.savefig("analysis_chart.png", dpi=120)
            plt.close()
            result["chart_png"] = "analysis_chart.png"
            result["summary"] = f"{len(numeric.columns)} 个数值字段两两相关"
        else:
            result["summary"] = "数值列不足 2 个，无法做相关"

    else:
        result["summary"] = f"未知分析模板：{TEMPLATE}"

    with open("analysis_result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2, default=str)


main()
'''


def analyze_dataset(name: str, template: str = "describe",
                    group_col: str = "", value_col: str = "",
                    owner: str | None = DEFAULT_OWNER) -> dict:
    """分析工作区里的数据集（CSV / XLSX）：描述统计 / 分组对比 / 相关性。

    后端生成 pandas 脚本写到工作区、用 venv python 跑，结果表写 analysis_result.json，
    图表写 analysis_chart.png（如有）。不开放任意分析代码，模板由后端白名单给出。
    """
    rel = safe_rel(name)
    if not rel:
        raise ValueError("非法文件名")
    root = ws_dir("analysis", owner)
    src = root / rel
    if not src.is_file():
        raise FileNotFoundError(rel)

    template = (template or "describe").strip()
    if template not in ("preview", "describe", "compare", "correlate"):
        raise ValueError(f"不支持的分析模板：{template}")

    script = (
        _ANALYZE_TMPL
        .replace("__SRC__", rel)
        .replace("__TEMPLATE__", template)
        .replace("__GROUP__", group_col or "")
        .replace("__VALUE__", value_col or "")
    )
    py_name = "_analyze_run.py"
    (root / py_name).write_text(script, encoding="utf-8")

    res = run_python(py_name, kind="analysis", owner=owner)

    # 清理生成的脚本，保留 result.json 与 chart.png 供前端取用
    try:
        (root / py_name).unlink()
    except OSError:
        pass

    out = {
        "ok": res["ok"],
        "status": res["status"],
        "wall_ms": res["wall_ms"],
        "stdout": res["stdout"],
        "error": res["error"],
        "run_id": res["run_id"],
        "result": None,
    }
    rj = root / "analysis_result.json"
    if rj.is_file():
        try:
            out["result"] = json.loads(rj.read_text(encoding="utf-8"))
            # 补数据集名并回写：前端刷新后靠它恢复「最近一次分析」现场
            out["result"]["dataset"] = rel
            rj.write_text(json.dumps(out["result"], ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    return out


def dataset_columns(name: str, owner: str | None = DEFAULT_OWNER) -> dict:
    """读取数据集列名与数值列（仅读表头，开销极小），供前端下拉选择分组/数值列。"""
    rel = safe_rel(name)
    if not rel:
        raise ValueError("非法文件名")
    root = ws_dir("analysis", owner)
    src = root / rel
    if not src.is_file():
        raise FileNotFoundError(rel)
    try:
        import pandas as pd
    except ImportError:
        raise RuntimeError("科学栈未安装（pandas），无法读取数据集列")
    if src.suffix.lower() == ".csv":
        df = pd.read_csv(src, encoding="utf-8-sig", nrows=1000)
    else:
        df = pd.read_excel(src, nrows=1000)
    cols = [str(c) for c in df.columns]
    numeric = [str(c) for c in df.select_dtypes(include="number").columns]
    return {"name": rel, "cols": cols, "numeric": numeric}


# ---------------------------------------------------------------- 全局任务带



def _norm_status(s: str | None) -> str:
    s = (s or "").strip().lower()
    if s in ("ok", "done", "success"):
        return "ok"
    if s in ("failed", "error", "fail"):
        return "failed"
    return "running"


def _run_counts() -> dict:
    c = {"running": 0, "ok": 0, "failed": 0, "total": 0}
    for table in ("workspace_runs", "canvas_runs", "exp_runs"):
        try:
            for r in query(f"SELECT status, COUNT(*) n FROM {table} GROUP BY status"):
                c[_norm_status(r["status"])] += r["n"]
                c["total"] += r["n"]
        except Exception:  # noqa: BLE001 —— 老库缺表不拖垮任务带
            continue
    return c


def list_runs(limit: int = 20) -> dict:
    """只读聚合三类 run，归一成任务带要的形状。既有表一行不改。"""
    limit = max(1, min(int(limit or 20), 60))
    rows: list[dict] = []

    for r in query("SELECT * FROM workspace_runs ORDER BY id DESC LIMIT ?", (limit,)):
        try:
            outs = json.loads(r["outputs_json"] or "[]")
        except Exception:
            outs = []
        rows.append({
            "id": r["id"], "source": "workspace", "kind": r["kind"],
            "label": r["label"] or "工作区任务",
            "command": r["command"], "status": _norm_status(r["status"]),
            "created_at": r["created_at"], "finished_at": r["finished_at"],
            "wall_ms": r["wall_ms"], "error": r["error"], "outputs": outs,
        })

    for r in query("SELECT * FROM canvas_runs ORDER BY id DESC LIMIT ?", (limit,)):
        rows.append({
            "id": r["id"], "source": "canvas", "kind": "canvas",
            "label": f"画布运行 · {r['scope'] or '全链路'}",
            "command": None, "status": _norm_status(r["status"]),
            "created_at": r["started_at"], "finished_at": r["finished_at"],
            "wall_ms": None, "error": None, "outputs": [],
        })

    for r in query("SELECT * FROM exp_runs ORDER BY id DESC LIMIT ?", (limit,)):
        rows.append({
            "id": r["id"], "source": "exp", "kind": "code",
            "label": f"实验运行 · {(r['command'] or '')[:48]}".strip(),
            "command": r["command"], "status": _norm_status(r["status"]),
            "created_at": r["created_at"], "finished_at": None,
            "wall_ms": r["wall_ms"], "error": None, "outputs": [],
        })

    rows.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return {"runs": rows[:limit], "counts": _run_counts()}
