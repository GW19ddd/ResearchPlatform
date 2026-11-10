"""实验 Agent（借鉴 Open Science 的会话驱动形态）：

对话 → 生成代码/产物文件 → 工作区内真实执行 → 自动登记运行溯源与结果记录。
产物落盘在 data/exp_ws/{exp_id}/，文件即产物（对应 Open Science 的文件面板）；
执行输出按「新时间戳目录」落盘，与运行溯源的输出路径不可变校验天然兼容。
"""
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
import llm
import chat_prefs
from chat_prefs import ChatPrefsIn
from crud import row_or_404
from db import execute, now, query

router = APIRouter(prefix="/api", tags=["expagent"])

MAX_FILES = 4
MAX_FILE_CHARS = 12000
MAX_OUTPUT_CHARS = 6000
RUN_TIMEOUT_S = 300
MAX_MSG_CHARS = 1500

PROV_LEVELS = {"measured", "simulated", "illustrative"}


def ws_dir(exp_id: int) -> Path:
    return config.DATA_DIR / "exp_ws" / str(exp_id)


# 服务进程（计划任务启动）的 PATH 往往没有 python——把当前解释器所在目录
# 及其 Scripts/ 前置进 PATH，让 Agent 生成的 `python xxx.py` 命令能直接跑。
_EXE_DIR = Path(sys.executable).resolve().parent
_EXTRA_PATH = os.pathsep.join([str(_EXE_DIR), str(_EXE_DIR / "Scripts")])


def _sub_env() -> dict:
    env = os.environ.copy()
    env["PATH"] = _EXTRA_PATH + os.pathsep + env.get("PATH", "")
    return env


def _safe_rel(name: str) -> str | None:
    """产物文件名只允许工作区相对路径，禁止越界。"""
    n = (name or "").strip().replace("\\", "/").lstrip("/")
    if not n or n.startswith("~") or ":" in n:
        return None
    parts = [p for p in n.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def list_ws_files(exp_id: int) -> list[dict]:
    root = ws_dir(exp_id)
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
        out.append({"name": f.relative_to(root).as_posix(), "size": st.st_size})
    return out


def _snapshot(root: Path) -> dict[str, float]:
    snap = {}
    for f in root.rglob("*"):
        if f.is_file():
            try:
                snap[f.relative_to(root).as_posix()] = f.stat().st_mtime
            except OSError:
                pass
    return snap


class AgentIn(ChatPrefsIn):
    message: str


@router.get("/experiments/{exp_id}/agent/messages")
def agent_messages(exp_id: int):
    row_or_404("experiments", exp_id)
    rows = query(
        "SELECT * FROM exp_messages WHERE experiment_id=? ORDER BY id", (exp_id,)
    )
    for r in rows:
        try:
            r["meta"] = json.loads(r["meta_json"] or "null")
        except Exception:
            r["meta"] = None
    return rows


@router.delete("/experiments/{exp_id}/agent/messages")
def agent_clear(exp_id: int):
    row_or_404("experiments", exp_id)
    execute("DELETE FROM exp_messages WHERE experiment_id=?", (exp_id,))
    return {"ok": True}


@router.get("/experiments/{exp_id}/agent/files")
def agent_files(exp_id: int):
    row_or_404("experiments", exp_id)
    return list_ws_files(exp_id)


@router.get("/experiments/{exp_id}/agent/file")
def agent_file(exp_id: int, name: str):
    row_or_404("experiments", exp_id)
    rel = _safe_rel(name)
    if not rel:
        raise HTTPException(422, "非法文件名")
    p = ws_dir(exp_id) / rel
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    if p.stat().st_size > 400_000:
        raise HTTPException(422, "文件过大（>400KB），请让 Agent 拆分后再看")
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise HTTPException(500, f"读取失败：{e}")
    return {"name": rel, "size": p.stat().st_size, "content": text}


def _build_context(exp: dict, history: list[dict], files: list[dict]) -> str:
    results = query("SELECT * FROM exp_results WHERE experiment_id=? ORDER BY id DESC LIMIT 10", (exp["id"],))
    runs = query("SELECT * FROM exp_runs WHERE experiment_id=? ORDER BY id DESC LIMIT 5", (exp["id"],))
    res_lines = [
        f"- case={r['case_name']} | 成功={bool(r['success'])} | 指标={r['metrics_json'] or '{}'}"
        for r in results
    ]
    run_lines = [f"- {r['command']} -> {r['status']}" for r in runs]
    file_lines = [f"- {f['name']}（{f['size']}B）" for f in files[:40]] or ["（空工作区）"]
    hist = []
    for m in history[-10:]:
        c = (m["content"] or "")[:MAX_MSG_CHARS]
        hist.append(f"{'用户' if m['role'] == 'user' else 'Agent'}：{c}")
    return f"""实验「{exp['name']}」
假设：{exp.get('hypothesis') or '（未填写）'}
设计：{exp.get('design') or '（未填写）'}

工作区已有文件：
{chr(10).join(file_lines)}

最近结果记录（{len(results)} 条）：
{chr(10).join(res_lines) if res_lines else "（无）"}

最近运行：
{chr(10).join(run_lines) if run_lines else "（无）"}

对话历史（最近 {len(hist)} 条）：
{chr(10).join(hist) if hist else "（新会话）"}"""


_AGENT_PROMPT = """你是科研工作台的实验 Agent，直接替用户干活：写实验代码、执行、把真实结果落账。当前时间戳目录已就绪，输出必须写进 `runs/{ts_dir}/` 下（重跑会开新目录，旧结果永不被覆盖）。

{context}

用户最新消息：{message}

只输出 JSON（不要 markdown 代码块包裹）：
{{
  "reply": "给用户看的中文说明（markdown）：做了什么、怎么跑的、关键数字、下一步建议。简洁，说人话。",
  "files": [{{"name": "相对路径.py", "content": "完整文件内容"}}],
  "command": "要执行的命令（可选；不给就不执行）。在工作区目录执行，Windows 环境，python 可直接调用",
  "record_result": {{"case_name": "...", "method": "...", "success": 1, "metrics_json": "{{\\"acc\\": 0.9}}", "provenance": "measured", "notes": "出处：哪次 run 的哪个输出文件"}}（可选）
}}

硬规则：
1. files 只写工作区相对路径，禁止绝对路径与 ..；单文件 ≤300 行；一次 ≤{max_files} 个文件。已有文件可直接复用/修改（同名覆盖）
2. 脚本必须把指标打印到 stdout 并写入 runs/{ts_dir}/ 下的 JSON 文件（文件即产物，可溯源）
3. record_result 只允许在 command 真实执行、数字确实来自真实输出时给出，provenance=measured；数字是模拟/推演出来的必须标 provenance=simulated 并在 notes 里说清楚——严禁把编的数字标成实测
4. 命令失败时如实报告，不要假装成功；超时 {timeout_s} 秒会被强杀
5. 不需要跑代码时就只回 reply（比如讨论设计、解释结果），别硬凑 files/command"""


def _sanitize_plan(data) -> tuple[str, list[dict], str | None, dict | None]:
    if not isinstance(data, dict):
        return "", [], None, None
    reply = str(data.get("reply") or "").strip()
    files: list[dict] = []
    for f in (data.get("files") or [])[:MAX_FILES]:
        if not isinstance(f, dict):
            continue
        rel = _safe_rel(str(f.get("name") or ""))
        content = str(f.get("content") or "")
        if not rel or not content:
            continue
        files.append({"name": rel, "content": content[:MAX_FILE_CHARS * 4]})
    command = str(data.get("command") or "").strip() or None
    if command and len(command) > 2000:
        command = None
    rec = data.get("record_result")
    record = None
    if isinstance(rec, dict) and str(rec.get("case_name") or "").strip():
        prov = str(rec.get("provenance") or "measured")
        record = {
            "case_name": str(rec.get("case_name")).strip()[:120],
            "method": str(rec.get("method") or "").strip()[:120] or None,
            "success": 1 if rec.get("success") in (1, True, "1", "true") else 0,
            "metrics_json": str(rec.get("metrics_json") or "").strip()[:600] or None,
            "provenance": prov if prov in PROV_LEVELS else "measured",
            "notes": str(rec.get("notes") or "").strip()[:400] or None,
        }
    return reply[:8000], files, command, record


def _register_run(exp_id: int, command: str, status: str, wall_ms: int,
                  code_paths: list[str], output_paths: list[str], notes: str) -> dict:
    """复用运行溯源协议：逐文件 sha1 钉码 + 输出路径不可变。"""
    import hashlib
    from routers.research import _file_entry, _norm_path

    code = [e for e in (_file_entry(p) for p in code_paths) if e]
    outs = [e for e in (_file_entry(p) for p in output_paths) if e]
    if outs:
        used: set[str] = set()
        for prev in query("SELECT output_json FROM exp_runs WHERE experiment_id=?", (exp_id,)):
            try:
                for f in json.loads(prev["output_json"] or "[]"):
                    used.add(_norm_path(f.get("path", "")))
            except Exception:
                pass
        conflict = sorted({f["path"] for f in outs if _norm_path(f["path"]) in used})
        if conflict:
            # Agent 违规复用了旧输出路径：run 照常登记，但输出不落账——旧结果不可覆盖
            outs = []
            notes = (notes + " ｜ 输出路径撞车未登记（重跑须开新目录）： " + "；".join(conflict[:3])).strip(" ｜")
    ts = now()
    run_id = hashlib.sha1(f"{exp_id}|{ts}|{command}".encode()).hexdigest()[:16]
    rid = execute(
        """INSERT INTO exp_runs (experiment_id, run_id, command, surface, status, host,
           wall_ms, notes, code_json, output_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (exp_id, run_id, command, "local", status, "本机", wall_ms, notes,
         json.dumps(code, ensure_ascii=False), json.dumps(outs, ensure_ascii=False), ts),
    )
    return {"id": rid, "run_id": run_id, "status": status, "outputs": outs}


@router.post("/experiments/{exp_id}/agent")
async def agent_turn(exp_id: int, body: AgentIn):
    exp = row_or_404("experiments", exp_id)
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(422, "消息不能为空")
    msg = msg[:4000]

    execute(
        "INSERT INTO exp_messages (experiment_id, role, content, created_at) VALUES (?,?,?,?)",
        (exp_id, "user", msg, now()),
    )
    history = query("SELECT * FROM exp_messages WHERE experiment_id=? ORDER BY id DESC LIMIT 12", (exp_id,))
    history.reverse()
    files_before = list_ws_files(exp_id)
    context = _build_context(exp, history, files_before) + chat_prefs.system_from(body)

    ts_dir = time.strftime("run-%Y%m%d-%H%M%S")
    prompt = _AGENT_PROMPT.format(
        context=context, message=msg, ts_dir=ts_dir,
        max_files=MAX_FILES, timeout_s=RUN_TIMEOUT_S,
    )
    data, env = await llm.complete_json_result(
        prompt, mode="fast", task="exp-agent", max_tokens=8192,
        model_override=chat_prefs.model_override(body),
    )
    if not env["ok"]:
        return {"ok": False, "error": env["error"]}

    reply, files, command, record = _sanitize_plan(data)
    root = ws_dir(exp_id)
    root.mkdir(parents=True, exist_ok=True)

    # 1) 写产物文件（同名覆盖=迭代工作区，符合 Open Science「文件即产物」）
    written: list[str] = []
    for f in files:
        p = root / f["name"]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f["content"], encoding="utf-8")
        written.append(str(p))

    # 2) 执行：快照前后 diff 定位产出文件；输出固定落 runs/<新时间戳>/
    run_info = None
    if command:
        (root / ts_dir).mkdir(exist_ok=True)
        pre = _snapshot(root)
        t0 = time.monotonic()
        def _run():
            return subprocess.run(
                command, shell=True, cwd=str(root), capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=RUN_TIMEOUT_S,
                env=_sub_env(),
            )

        try:
            proc = await asyncio.to_thread(_run)
            wall_ms = int((time.monotonic() - t0) * 1000)
            exit_code, status = proc.returncode, ("ok" if proc.returncode == 0 else "failed")
            tail = ((proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr else ""))[-MAX_OUTPUT_CHARS:]
        except subprocess.TimeoutExpired:
            wall_ms = RUN_TIMEOUT_S * 1000
            exit_code, status = -9, "failed"
            tail = f"[超时] 超过 {RUN_TIMEOUT_S}s 被强杀"
        except Exception as e:
            wall_ms = int((time.monotonic() - t0) * 1000)
            exit_code, status = -1, "failed"
            tail = f"[执行异常] {e}"
        if not tail.strip():
            tail = f"[退出码 {exit_code}]（无输出——可能是命令不存在或立即崩溃）"
        post = _snapshot(root)
        changed = [k for k, v in post.items() if pre.get(k) != v]
        out_paths = [str(root / k) for k in changed
                     if k.startswith(ts_dir) or k not in {f["name"] for f in files}]
        run_info = _register_run(exp_id, command, status, wall_ms, written, out_paths, None)
        run_info.update({"exit_code": exit_code, "wall_ms": wall_ms, "tail": tail, "command": command})
    else:
        out_paths = []

    # 3) 结果落账（只有命令真实跑完才可能给出；run 失败时机械降级为示意口径，
    #    防「假数字以实测身份进结论」——口径契约不由模型自觉保证）
    recorded = None
    if record:
        note_suffix = ""
        if command and run_info and run_info.get("status") != "ok":
            record["provenance"] = "illustrative"
            note_suffix = " ｜（本轮命令执行失败，系统强制降级为示意口径，不得进结论）"
        elif not command:
            record["provenance"] = "illustrative"
            note_suffix = " ｜（Agent 未执行命令，无 run 背书，不得进结论）"
        record["notes"] = ((record.get("notes") or "") + note_suffix).strip() or None
        rid = execute(
            """INSERT INTO exp_results (experiment_id, case_name, method, success,
               metrics_json, notes, provenance, created_at) VALUES (?,?,?,?,?,?,?,?)""",
            (exp_id, record["case_name"], record["method"], record["success"],
             record["metrics_json"], record["notes"], record["provenance"], now()),
        )
        recorded = {**record, "id": rid}

    meta = {
        "files": [f["name"] for f in files],
        "run": run_info,
        "recorded": recorded,
    }
    if not reply:
        reply = "（模型没有给出说明，但操作已执行——见下方产物与运行记录）"
    execute(
        "INSERT INTO exp_messages (experiment_id, role, content, meta_json, created_at) VALUES (?,?,?,?,?)",
        (exp_id, "assistant", reply, json.dumps(meta, ensure_ascii=False), now()),
    )
    return {
        "ok": True, "reply": reply, "meta": meta, "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }
