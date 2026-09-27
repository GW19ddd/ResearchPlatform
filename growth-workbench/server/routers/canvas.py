"""科研画布：skill 注册表、画布 CRUD、拓扑执行引擎。

节点类型：
  input  —— 直接文本输入，输出即原文
  prompt —— 创作者自写的指令节点（system + prompt 都在节点里），不受技能库限制
  skill  —— 调用一个 skill prompt 模板（走 llm.py 的 provider 路由）
  tool   —— 外部工具：dify（workflow/chat）或 http
  output —— 汇总上游输出，可一键存入 Ideas / 文献 / 论文模块

模板（内置 + 用户自存）在 canvas_templates.py，这里只消费不生产。
"""
import asyncio
import json
import re
import time
from collections import deque
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import llm
import canvas_templates
import dify_config
from db import execute, now, query
from llm import redact
from skill_registry import categories, delete_custom, get_skill, list_skills, reload, save_custom

router = APIRouter(prefix="/api/canvas", tags=["canvas"])

MAX_CTX_DEFAULT = 4000


class CanvasCreate(BaseModel):
    name: str
    template: str | None = None


class NodeIn(BaseModel):
    node_key: str
    type: str = "skill"
    skill_id: str | None = None
    title: str = ""
    x: float = 0
    y: float = 0
    config: dict = {}


class EdgeIn(BaseModel):
    source_key: str
    target_key: str


class CanvasSave(BaseModel):
    name: str | None = None
    nodes: list[NodeIn]
    edges: list[EdgeIn]


class RunBody(BaseModel):
    node_key: str | None = None
    force: bool = False


class TemplateBody(BaseModel):
    name: str = ""


class SaveOutputBody(BaseModel):
    node_key: str
    target: Literal["idea", "literature", "paper"] = "idea"
    title: str = ""


def _canvas_or_404(canvas_id: int):
    rows = query("SELECT * FROM canvases WHERE id=?", (canvas_id,))
    if not rows:
        raise HTTPException(404, "canvas not found")
    return rows[0]


def _nodes(canvas_id: int) -> list[dict]:
    rows = query("SELECT * FROM canvas_nodes WHERE canvas_id=?", (canvas_id,))
    for r in rows:
        r["config"] = json.loads(r["config_json"] or "{}")
    return rows


def _edges(canvas_id: int) -> list[dict]:
    return query("SELECT * FROM canvas_edges WHERE canvas_id=?", (canvas_id,))


def _topo(nodes: list[dict], edges: list[dict]) -> list[dict]:
    by_key = {n["node_key"]: n for n in nodes}
    indeg = {k: 0 for k in by_key}
    adj: dict[str, list[str]] = {k: [] for k in by_key}
    for e in edges:
        s, t = e["source_key"], e["target_key"]
        if s not in by_key or t not in by_key:
            continue
        adj[s].append(t)
        indeg[t] += 1
    q = deque([k for k, v in indeg.items() if v == 0])
    order: list[str] = []
    while q:
        k = q.popleft()
        order.append(k)
        for t in adj[k]:
            indeg[t] -= 1
            if indeg[t] == 0:
                q.append(t)
    if len(order) != len(by_key):
        # 有环：剩余节点按 node_key 追加，避免整张图跑不起来
        for k in by_key:
            if k not in order:
                order.append(k)
    return [by_key[k] for k in order]


def _upstreams(node_key: str, edges: list[dict]) -> list[str]:
    return [e["source_key"] for e in edges if e["target_key"] == node_key]


def _render(tpl: str, slots: dict, upstream_text: str, direct: str, max_ctx: int) -> str:
    if len(upstream_text) > max_ctx:
        upstream_text = upstream_text[:max_ctx] + "\n\n…（上游输出过长已截断）"
    out = tpl or ""
    out = out.replace("{{upstream}}", upstream_text or "（无上游输入）")
    out = out.replace("{{input}}", direct or "")
    for k, v in (slots or {}).items():
        out = out.replace("{{" + k + "}}", str(v or ""))
    import re

    out = re.sub(r"\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}", "", out)
    return out


async def _run_tool(cfg: dict, upstream_text: str) -> tuple[str, str]:
    """外部工具节点。返回 (输出文本, 备注)。"""
    tool = (cfg.get("tool") or "").lower()
    if tool == "dify":
        # 地址与 Key 统一在「设置」页配置，节点只选应用
        app, err = dify_config.resolve(cfg.get("app_id") or "")
        if not app:
            return err, "dify:unconfigured"
        base = app["base_url"]
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {app['api_key']}"}
        raw_inputs = cfg.get("inputs") or {}
        if isinstance(raw_inputs, str):
            try:
                raw_inputs = json.loads(raw_inputs) if raw_inputs.strip() else {}
            except ValueError:
                raw_inputs = {"query": raw_inputs}
        inputs = {}
        for k, v in raw_inputs.items():
            inputs[k] = str(v).replace("{{upstream}}", upstream_text or "")
        mode = cfg.get("dify_mode") or app.get("mode") or "workflow"
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                if mode == "chat":
                    payload = {
                        "inputs": inputs,
                        "query": inputs.get("query") or upstream_text[:4000] or "开始",
                        "response_mode": "blocking",
                        "user": "workbench",
                    }
                    r = await client.post(f"{base}/chat-messages", json=payload, headers=headers)
                else:
                    payload = {
                        "inputs": inputs,
                        "response_mode": "blocking",
                        "user": "workbench",
                    }
                    r = await client.post(f"{base}/workflows/run", json=payload, headers=headers)
                r.raise_for_status()
                data = r.json()
        except Exception as exc:
            return (
                f"[Dify 调用失败] base={base} mode={mode} app={app.get('name')}\n{type(exc).__name__}: {exc}\n\n"
                "检查：1) Dify 是否已启动 2) 设置页地址是否为 http://localhost/v1 "
                "3) 该应用的 API Key 是否正确且 workflow 已发布",
                f"dify:error:{type(exc).__name__}",
            )
        data = (data.get("data") or data) if isinstance(data, dict) else {}
        outputs = data.get("outputs") or {}
        if isinstance(outputs, dict) and outputs:
            text = "\n".join(f"**{k}**\n{v}" for k, v in outputs.items())
        else:
            text = data.get("answer") or data.get("text") or json.dumps(data, ensure_ascii=False)[:2000]
        return text or "（Dify 返回空）", "dify:ok"
    if tool == "http":
        url = cfg.get("url") or ""
        if not url:
            return "[HTTP 节点未配置 url]", "http:unconfigured"
        try:
            body = cfg.get("body") or {}
            body = json.loads(json.dumps(body).replace("{{upstream}}", upstream_text or ""))
            async with httpx.AsyncClient(timeout=60.0) as client:
                r = await client.request(
                    (cfg.get("method") or "POST").upper(),
                    url,
                    json=body if body else None,
                    headers=cfg.get("headers") or {},
                )
                r.raise_for_status()
                return r.text[:8000], "http:ok"
        except Exception as exc:
            return f"[HTTP 调用失败] {url}\n{type(exc).__name__}: {exc}", f"http:error:{type(exc).__name__}"
    return "[未知工具类型] 支持 dify / http", "tool:unknown"


async def _run_llm(prompt: str, system: str, cfg: dict, task: str, meta: dict) -> tuple[str, dict]:
    """一次 LLM 调用 + 元信息回填。skill / prompt / 工具节点都走这里，避免三份重复。"""
    mode = cfg.get("mode") or "fast"
    t0 = time.time()
    res = await llm.complete_result(
        prompt,
        system=system,
        mode=mode,
        task=task,
        max_tokens=int(cfg.get("max_tokens") or 3000),
        provider_id=cfg.get("provider_id"),
    )
    meta.update(
        elapsed_ms=int((time.time() - t0) * 1000),
        mode=mode,
        provider=res.get("provider", ""),
        model=res.get("model", ""),
        tokens_in=res.get("tokens_in", 0),
        tokens_out=res.get("tokens_out", 0),
        ok=bool(res.get("ok")),
        error=res.get("error"),
    )
    # 失败时 content 恒为空 —— 上层不要拿空串当成果展示，而是读 meta.error
    return res.get("content", ""), meta


async def _exec_node(
    node: dict,
    upstream_text: str,
    outputs: dict,
    upstream_ok: dict | None = None,
) -> tuple[str, dict]:
    """执行单个节点，返回 (输出文本, 元信息)。元信息带 ok / error，供状态展示用。

    upstream_ok 是「本节点各上游的运行结果」。汇总节点靠它判断能不能把上游拼成
    一份可信成果 —— 上游挂了一半时，汇出来的东西不能当成成果存走。
    """
    cfg = node.get("config") or {}
    ntype = node.get("type") or "skill"
    meta: dict = {
        "provider": "",
        "model": "",
        "tokens_in": 0,
        "tokens_out": 0,
        "ok": True,
        "error": None,
    }

    if ntype == "input":
        return cfg.get("text") or "", meta

    if ntype == "tool":
        text, note = await _run_tool(cfg, upstream_text)
        meta["provider"] = note
        # note 形如 dify:ok / dify:error:ConnectError / http:unconfigured
        bad = note.startswith(("dify:error", "http:error", "tool:unknown")) or note.endswith(
            ("unconfigured",)
        )
        meta["ok"] = not bad
        if bad:
            meta["error"] = {
                "kind": "tool_error",
                "label": "工具调用失败",
                "message": note,
                "detail": text[:300],
                "hint": "检查工具配置（Dify 是否启用 / 地址与 Key / HTTP url）后重跑该节点。",
            }
        return text, meta

    if ntype == "output":
        bad = sorted(k for k, v in (upstream_ok or {}).items() if not v)
        if bad:
            meta["ok"] = False
            meta["error"] = {
                "kind": "upstream_failed",
                "label": "上游节点失败",
                "message": f"上游 {len(bad)} 个节点运行失败（{'、'.join(bad)}），汇总结果不完整",
                "detail": "",
                "hint": "先重跑失败的上游节点，成功后再跑这个汇总节点。",
            }
            return "", meta
        merged = upstream_text.strip()
        if not merged:
            meta["ok"] = False
            meta["error"] = {
                "kind": "empty_upstream",
                "label": "上游无内容",
                "message": "上游节点没有产出任何内容，没有可汇总的东西",
                "detail": "",
                "hint": "检查上游节点的输入与配置，重跑后再试。",
            }
            return "", meta
        prefix = cfg.get("prefix") or ""
        return (prefix + "\n" + merged if prefix else merged), meta

    # 创作者自定义节点：指令写在节点里，不依赖技能库，{{upstream}} / {{任意槽位}} 都可注入
    if ntype == "prompt":
        tpl = (cfg.get("prompt") or "").strip()
        if not tpl:
            meta["ok"] = False
            meta["error"] = {
                "kind": "not_configured",
                "label": "节点未配置",
                "message": "自定义节点还没写指令",
                "detail": "",
                "hint": "在右侧「指令」里写下你要模型做什么。",
            }
            return "", meta
        max_ctx = int(cfg.get("max_ctx") or MAX_CTX_DEFAULT)
        prompt = _render(tpl, cfg.get("inputs") or {}, upstream_text, cfg.get("text") or "", max_ctx)
        system = (cfg.get("system") or "").strip() or llm.RESEARCH_SYSTEM
        return await _run_llm(prompt, system, cfg, "canvas:custom", meta)

    skill_id = node.get("skill_id")
    from skill_registry import get_skill

    skill = get_skill(skill_id) if skill_id else None
    if not skill:
        meta["ok"] = False
        meta["error"] = {
            "kind": "not_configured",
            "label": "节点未配置",
            "message": f"未找到 skill：{skill_id}",
            "detail": "",
            "hint": "在节点配置里重新选择一个技能。",
        }
        return "", meta

    max_ctx = int(cfg.get("max_ctx") or MAX_CTX_DEFAULT)
    slots = cfg.get("inputs") or {}
    direct = cfg.get("text") or ""

    if (skill.get("source") or "") == "github":
        # GitHub 原样 skill：SKILL.md 原文当 system，引用的附属文件原文贴在 user 里
        from skill_fs import build_prompt as _gh_prompt

        system, prompt = _gh_prompt(skill["id"], slots, upstream_text, direct)
        if system is None:
            meta["ok"] = False
            meta["error"] = {
                "kind": "not_configured",
                "label": "技能读取失败",
                "message": f"读取 GitHub skill 失败：{skill['id']}",
                "detail": "",
                "hint": "确认仓库已克隆且 SKILL.md 存在，必要时在技能列表里重新导入。",
            }
            return "", meta
        meta["github"] = f"{skill.get('repo')}/{skill.get('rel')}"
    else:
        prompt = _render(skill.get("prompt", ""), slots, upstream_text, direct, max_ctx)
        system = skill.get("system") or llm.RESEARCH_SYSTEM

    cfg = {**cfg, "mode": cfg.get("mode") or skill.get("mode") or "fast"}
    return await _run_llm(prompt, system, cfg, f"canvas:{skill_id}", meta)


# ---------- skill 注册表 ----------


class PingBody(BaseModel):
    base_url: str = ""


@router.post("/dify/ping")
async def api_dify_ping(body: PingBody):
    """探测 Dify 是否可达：去掉 /v1 后 GET 根路径，只要拿到 HTTP 响应就算通。"""
    base = (body.base_url or "").rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    if not base:
        return {"ok": False, "message": "先填 Dify 的 API 地址，例如 http://localhost/v1"}
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            r = await client.get(base)
        return {
            "ok": True,
            "message": f"Dify 可达 · HTTP {r.status_code} · {base}",
        }
    except Exception as exc:
        return {"ok": False, "message": f"{type(exc).__name__}: {exc}"}


@router.get("/skills")
def api_skills():
    return {"skills": list_skills(), "categories": categories()}


@router.post("/skills")
def api_add_skill(body: dict):
    if not body.get("id"):
        raise HTTPException(400, "id required")
    return {"skill": save_custom(body), "skills": list_skills()}


@router.get("/skills/github")
def api_github_skills():
    """列出从 GitHub 克隆下来的真实 skill（原样加载，未做任何改写）。"""
    from skill_fs import GITHUB_DIR, list_github_skills

    items = list_github_skills()
    repos: dict[str, int] = {}
    for s in items:
        repos[s["repo"]] = repos.get(s["repo"], 0) + 1
    return {
        "ok": True,
        "root": GITHUB_DIR,
        "count": len(items),
        "repos": [{"name": k, "count": v} for k, v in repos.items()],
        "skills": items,
    }


class CloneIn(BaseModel):
    url: str
    name: str = ""


@router.post("/skills/github/clone")
def api_github_clone(body: CloneIn):
    """克隆一个含 SKILL.md 的 GitHub 仓库到 skills/github/ 下（原样保存，不改写任何文件）。"""
    from skill_fs import GITHUB_DIR, clone_repo

    url = (body.url or "").strip()
    if not url:
        raise HTTPException(400, "url required")
    r = clone_repo(url, body.name)
    if not r.get("ok"):
        raise HTTPException(400, r.get("message") or "clone failed")
    reload()
    return r


@router.post("/skills/github/reload")
def api_github_reload():
    from skill_fs import reload as _gh

    items = _gh()
    from skill_registry import reload as _r

    _r()
    return {"ok": True, "count": len(items)}


@router.get("/skills/github/{skill_id}/source")
def api_github_source(skill_id: str):
    """查看某个 GitHub skill 的 SKILL.md 原文。"""
    from skill_fs import read_skill_md

    r = read_skill_md(skill_id)
    if not r.get("ok"):
        raise HTTPException(404, r.get("message") or "not found")
    return r


@router.get("/skills/github/{skill_id}/files")
def api_github_files(skill_id: str):
    from skill_fs import list_files

    r = list_files(skill_id)
    if not r.get("ok"):
        raise HTTPException(404, "not found")
    return r


@router.get("/skills/github/{skill_id}/file")
def api_github_file(skill_id: str, rel: str = ""):
    from skill_fs import read_file

    r = read_file(skill_id, rel)
    if not r.get("ok"):
        raise HTTPException(404, r.get("message") or "not found")
    return r


@router.delete("/skills/{skill_id}")
def api_del_skill(skill_id: str):
    ok = delete_custom(skill_id)
    if not ok:
        raise HTTPException(404, "只能删除自定义 skill")
    return {"ok": True}


@router.post("/skills/reload")
def api_reload():
    return {"skills": reload()}


# ---------- 技能库对外暴露成 HTTP（供 Dify / 其它 Agent 调用） ----------

class SkillRunIn(BaseModel):
    inputs: dict = {}
    upstream: str = ""
    mode: str | None = None
    max_tokens: int = 3000


@router.post("/skills/{skill_id}/run")
async def api_skill_run(skill_id: str, body: SkillRunIn):
    """把单个 skill 当成 HTTP 接口跑一次。Dify 里注册成自定义工具后就能调它。"""
    sk = get_skill(skill_id)
    if not sk:
        raise HTTPException(404, f"没有这个技能：{skill_id}")
    mode = body.mode or sk.get("mode") or "fast"

    if (sk.get("source") or "") == "github":
        from skill_fs import build_prompt as _gh_prompt

        system, prompt = _gh_prompt(skill_id, body.inputs or {}, body.upstream or "", "")
        if system is None:
            return {"ok": False, "skill_id": skill_id, "error": "读取 GitHub skill 原文失败", "output": ""}
    else:
        prompt = _render(
            sk.get("prompt", ""),
            body.inputs or {},
            body.upstream or "",
            "",
            int(MAX_CTX_DEFAULT),
        )
        system = sk.get("system") or llm.RESEARCH_SYSTEM
    env = await llm.complete_with_meta(
        prompt,
        system=system,
        mode=mode,
        task=f"skill:{skill_id}",
        max_tokens=int(body.max_tokens or 3000),
    )
    if not env.get("ok"):
        return {
            "ok": False,
            "skill_id": skill_id,
            "output": "",
            "error": env.get("error") or {"kind": "unknown", "message": "调用失败"},
        }
    return {
        "ok": True,
        "skill_id": skill_id,
        "output": env.get("content") or "",
        "model": env.get("model") or "",
        "provider": env.get("provider") or "",
        "tokens_in": env.get("tokens_in") or 0,
        "tokens_out": env.get("tokens_out") or 0,
    }


@router.get("/dify/openapi")
def api_dify_openapi():
    """生成 Dify「自定义工具」可直接导入的 OpenAPI 3.0 schema。

    Dify 里：工具 → 创建自定义工具 → 粘贴本接口返回的 JSON（或导入下面的 yaml 文本）。
    导入后每个 skill 会成为一个独立工具，Agent / 工作流里都能拖着用。
    """
    paths: dict = {}
    for s in list_skills():
        props: dict = {"upstream": {"type": "string", "description": "上游输出（可选，会注入到提示词里）"}}
        for i in s.get("inputs") or []:
            props[i["key"]] = {
                "type": "string",
                "description": f"{i.get('label') or i['key']}——{i.get('placeholder') or ''}",
            }
        paths[f"/skills/{s['id']}/run"] = {
            "post": {
                "operationId": re.sub(r"[^a-zA-Z0-9_]", "_", s["id"]),
                "summary": s.get("name") or s["id"],
                "description": f"{s.get('desc') or ''}（类别：{s.get('category') or '自定义'}）",
                "requestBody": {
                    "required": False,
                    "content": {"application/json": {"schema": {"type": "object", "properties": props}}},
                },
                "responses": {
                    "200": {
                        "description": "技能输出",
                        "content": {"application/json": {
                            "schema": {"type": "object", "properties": {"output": {"type": "string"}}}
                        }},
                    }
                },
            }
        }
    return {
        "openapi": "3.0.1",
        "info": {"title": "科研技能库", "description": "个人科研工作台技能库，供 Dify 调用", "version": "1.0.0"},
        "servers": [{"url": "http://localhost:8000/api/canvas"}],
        "paths": paths,
    }


# ---------- 画布 CRUD ----------



# ---------- 一句话选题 → 自动编排画布 ----------

AUTO_SYSTEM = (
    "你是科研流水线编排专家。你要从给定的技能库里挑出最少的几个技能，"
    "连成一条能从「一个模糊选题」走到「可写进论文的结论」的有向无环图。"
    "只输出合法 JSON，不要解释、不要代码块围栏。"
)


def _skill_menu() -> str:
    lines = []
    for s in list_skills():
        slots = ", ".join(
            f"{i.get('key')}({i.get('label') or ''})" for i in (s.get("inputs") or [])
        )
        tag = "GitHub原版" if (s.get("source") or "") == "github" else "内置"
        lines.append(
            f"- id={s['id']} | [{tag}] {s.get('name')} | 类别={s.get('category')} | "
            f"作用={(s.get('desc') or '')[:140]} | 输入槽={slots or '无（只吃上游输出）'}"
        )
    return "\n".join(lines)


def _auto_prompt(topic: str, constraint: str, extra: str, max_nodes: int) -> str:
    return f"""用户只给了一个选题：{topic}
约束：{constraint or '（未给，按常规研究生节奏假设：1-3 个月出结果，单机可跑）'}
补充：{extra or '（无）'}

可用技能库（只能从里面挑 id，不要编造）：
{_skill_menu()}

请输出 JSON，格式如下（不要有任何额外文字）：
{{
  "name": "画布名称（10 字内）",
  "rationale": "一句话说明为什么这么排",
  "nodes": [
    {{"key": "n2", "skill_id": "库里的真实 id", "title": "节点显示名（6 字内）", "inputs": {{"槽key": "填好的具体值"}}, "why": "这一步解决什么"}}
  ],
  "edges": [["n2", "n3"], ["n3", "n4"]]
}}

硬性要求：
1. 节点总数（不含我自动补的首尾）不超过 {max_nodes} 个，宁少勿多
2. skill_id 必须是上面列表里存在的，否则整条流水线跑不出来
3. 顺序必须符合科研逻辑：先定问题/找空白 → 再设计方案/做实验 → 再论证 → 最后审视
4. 每个节点的 inputs 要填得具体，能直接跑；填不出就留空字符串
   注意：[GitHub原版] 的技能输入槽统一是 task（这一步要它做什么），请把具体要求写进 task
5. edges 必须是无环的链式或分叉结构，元素为 [源key, 目标key]
6. 优先挑选标记为 [GitHub原版] 的技能（它们是社区真实维护的完整 skill），内置技能作为补充
7. 只输出 JSON 本身"""


def _fallback_plan(topic: str, constraint: str) -> dict:
    """模型没给出合法结果时的保底编排：一条通用科研流水线。"""
    return {
        "name": f"{topic[:8]} · 通用流水线",
        "rationale": "AI 编排未返回合法结构，已用保底流水线：定问题 → 查空白 → 论证链 → 模拟审稿",
        "nodes": [
            {"key": "n2", "skill_id": "academic-research-suite", "title": "研究框架",
             "inputs": {"constraint": constraint or "1-3 个月出结果，单机可跑"}, "why": "把模糊选题收敛成可验证问题"},
            {"key": "n3", "skill_id": "literature-survey-skill", "title": "综述与空白",
             "inputs": {"known": "（待补充已知工作）"}, "why": "确认这个坑没人填过"},
            {"key": "n4", "skill_id": "paper-spine", "title": "论证链",
             "inputs": {"motivation": "（待填）", "result": "（待填）"}, "why": "检查动机到结论是否断链"},
            {"key": "n5", "skill_id": "nature-reviewer", "title": "模拟审稿",
             "inputs": {"venue": "（目标会议/期刊）"}, "why": "提前挨一遍打"},
        ],
        "edges": [["n2", "n3"], ["n3", "n4"], ["n4", "n5"]],
    }


def _auto_layout(nodes: list[dict], edges: list[dict]) -> None:
    """按拓扑层级自动排版：同一层纵向排开，避免节点叠在一起。"""
    indeg = {n["node_key"]: 0 for n in nodes}
    adj: dict[str, list[str]] = {n["node_key"]: [] for n in nodes}
    for e in edges:
        s, t = e["source_key"], e["target_key"]
        if s in indeg and t in indeg and s != t:
            adj[s].append(t)
            indeg[t] += 1
    depth: dict[str, int] = {k: 0 for k in indeg}
    q = deque([k for k, v in indeg.items() if v == 0])
    while q:
        k = q.popleft()
        for t in adj[k]:
            depth[t] = max(depth[t], depth[k] + 1)
            indeg[t] -= 1
            if indeg[t] == 0:
                q.append(t)
    levels: dict[int, list[str]] = {}
    for k, d in depth.items():
        levels.setdefault(d, []).append(k)
    for d, keys in levels.items():
        keys.sort()
        for i, k in enumerate(keys):
            for n in nodes:
                if n["node_key"] == k:
                    n["x"] = 40 + d * 300
                    n["y"] = 40 + i * 150


def _sanitize(plan: dict, topic: str, max_nodes: int) -> tuple[list[dict], list[dict], list[str]]:
    """校验模型给的编排：砍掉不存在的 skill、断掉的边、成环的边。"""
    dropped: list[str] = []
    valid_ids = {s["id"] for s in list_skills()}
    raw_nodes = plan.get("nodes") if isinstance(plan.get("nodes"), list) else []
    nodes: list[dict] = []
    seen: set[str] = set()
    for n in raw_nodes[: max_nodes + 2]:
        if not isinstance(n, dict):
            continue
        sid = (n.get("skill_id") or "").strip()
        key = (n.get("key") or "").strip()
        if not key or key in seen:
            continue
        if sid not in valid_ids:
            dropped.append(f"未知技能 {sid or '(空)'}（{n.get('title') or key}）已丢弃")
            continue
        seen.add(key)
        inputs = n.get("inputs") if isinstance(n.get("inputs"), dict) else {}
        inputs = {str(k): str(v) for k, v in inputs.items() if str(v).strip()}
        nodes.append({
            "node_key": key, "type": "skill", "skill_id": sid,
            "title": (n.get("title") or sid)[:24],
            "config": {"inputs": inputs},
            "why": n.get("why") or "",
        })
    if not nodes:
        return [], [], ["没有任何合法节点"]

    keys = {n["node_key"] for n in nodes}
    edges: list[dict] = []
    for e in (plan.get("edges") if isinstance(plan.get("edges"), list) else []):
        s, t = "", ""
        if isinstance(e, (list, tuple)) and len(e) == 2:
            s, t = str(e[0]), str(e[1])
        elif isinstance(e, dict):
            s, t = str(e.get("source_key") or e.get("from") or ""), str(e.get("target_key") or e.get("to") or "")
        if s in keys and t in keys and s != t:
            edges.append({"source_key": s, "target_key": t})

    # 去掉会成环的边（简单 DFS 判环）
    def has_cycle(es: list[dict]) -> bool:
        g: dict[str, list[str]] = {k: [] for k in keys}
        for x in es:
            g[x["source_key"]].append(x["target_key"])
        color: dict[str, int] = {k: 0 for k in keys}

        def dfs(u: str) -> bool:
            color[u] = 1
            for v in g[u]:
                if color[v] == 1 or (color[v] == 0 and dfs(v)):
                    return True
            color[u] = 2
            return False

        return any(color[k] == 0 and dfs(k) for k in keys)

    kept: list[dict] = []
    for e in edges:
        if has_cycle(kept + [e]):
            dropped.append(f"丢弃成环连线 {e['source_key']}→{e['target_key']}")
            continue
        kept.append(e)
    edges = kept

    # 串成链：如果有孤立节点（既不连入也不连出），接到前一个上，保证整图能跑
    linked = {e["source_key"] for e in edges} | {e["target_key"] for e in edges}
    chain = [n["node_key"] for n in nodes]
    for i, k in enumerate(chain):
        if k in linked:
            continue
        if i == 0:
            continue
        edges.append({"source_key": chain[i - 1], "target_key": k})
        linked.add(k)

    # 首尾补 input / output 节点
    head = {"node_key": "n_in", "type": "input", "skill_id": None, "title": "选题",
            "config": {"text": topic}, "why": "选题原文"}
    tail = {"node_key": "n_out", "type": "output", "skill_id": None, "title": "产出",
            "config": {"prefix": f"## {topic} · 画布产出"}, "why": "汇总"}
    nodes = [head] + nodes + [tail]
    has_in = any(e["target_key"] == nodes[1]["node_key"] for e in edges)
    if not has_in:
        edges.append({"source_key": "n_in", "target_key": nodes[1]["node_key"]})
    last = nodes[-2]["node_key"]
    if not any(e["source_key"] == last for e in edges):
        edges.append({"source_key": last, "target_key": "n_out"})
    _auto_layout(nodes, edges)
    return nodes, edges, dropped


class AutoIn(BaseModel):
    topic: str
    constraint: str = ""
    extra: str = ""
    max_nodes: int = 6
    save: bool = True


@router.post("/auto")
async def api_auto(body: AutoIn):
    """给一个选题名，自动编排整张画布并落库。"""
    topic = (body.topic or "").strip()
    if not topic:
        raise HTTPException(400, "先给个选题，例如「ai单元测试」")
    max_nodes = max(2, min(int(body.max_nodes or 6), 8))

    plan: dict = {}
    err = ""
    env = await llm.complete_with_meta(
        _auto_prompt(topic, body.constraint, body.extra, max_nodes),
        system=AUTO_SYSTEM,
        mode="fast",
        task="canvas:auto",
        max_tokens=2400,
    )
    if env.get("ok"):
        raw = (env.get("content") or "").strip()
        if raw.startswith("```"):
            raw = raw.strip("`")
            raw = raw.split("\n", 1)[-1] if "\n" in raw else raw
        i, j = raw.find("{"), raw.rfind("}")
        if i >= 0 and j > i:
            try:
                plan = json.loads(raw[i:j + 1])
            except ValueError:
                plan = {}
                err = "AI 返回的内容不是合法 JSON"
    else:
        e = env.get("error") or {}
        err = f"{e.get('label') or 'AI 编排失败'}：{e.get('message') or ''}".strip("：")
    used_fallback = not isinstance(plan, dict) or not plan.get("nodes")
    if used_fallback:
        plan = _fallback_plan(topic, body.constraint)

    nodes, edges, dropped = _sanitize(plan, topic, max_nodes)
    if not nodes:
        raise HTTPException(500, "编排失败且保底方案也不可用")

    name = (plan.get("name") or "").strip()[:40] or f"{topic[:12]} · 自动编排"
    rationale = plan.get("rationale") or ""
    if used_fallback:
        rationale = (rationale + " " if rationale else "") + (f"（AI 编排未成功：{err}）" if err else "（未用 AI 编排）")

    if not body.save:
        return {"ok": True, "name": name, "nodes": nodes, "edges": edges,
                "rationale": rationale, "dropped": dropped, "fallback": used_fallback, "id": None}

    ts = now()
    cid = execute(
        "INSERT INTO canvases (name, template, created_at, updated_at) VALUES (?,?,?,?)",
        (name, "auto", ts, ts),
    )
    for n in nodes:
        execute(
            """INSERT INTO canvas_nodes (canvas_id, node_key, type, skill_id, title, x, y, config_json)
               VALUES (?,?,?,?,?,?,?,?)""",
            (cid, n["node_key"], n["type"], n["skill_id"], n["title"],
             n.get("x", 0), n.get("y", 0), json.dumps(n["config"], ensure_ascii=False)),
        )
    for e in edges:
        execute(
            "INSERT INTO canvas_edges (canvas_id, source_key, target_key) VALUES (?,?,?)",
            (cid, e["source_key"], e["target_key"]),
        )
    return {
        "ok": True, "id": cid, "name": name, "rationale": rationale,
        "dropped": dropped, "fallback": used_fallback,
        "nodes": nodes, "edges": edges,
    }


@router.get("/templates")
def api_templates():
    """内置 + 用户自存模板，前端「从模板新建」直接用这个列表。"""
    return {"templates": canvas_templates.template_list()}


# 注意：这条必须注册在 DELETE /{canvas_id} 之前。
# 否则 DELETE /api/canvas/templates/u1 会先命中 /{canvas_id}，把 "templates" 交给 int 校验直接 422。
@router.delete("/templates/{key}")
def api_delete_template(key: str):
    """只允许删用户自存模板；内置模板删不掉，返回 404 让前端提示「内置不可删」。"""
    if not canvas_templates.delete_user(key):
        raise HTTPException(404, "模板不存在或为内置模板")
    return {"ok": True}


@router.get("")
def api_list():
    rows = query(
        """SELECT c.*, (SELECT COUNT(*) FROM canvas_nodes n WHERE n.canvas_id=c.id) node_count
           FROM canvases c ORDER BY c.updated_at DESC"""
    )
    return {"canvases": rows, "templates": canvas_templates.template_list()}


@router.post("")
def api_create(body: CanvasCreate):
    tpl = canvas_templates.get_template(body.template)
    if tpl and body.name in ("", "新画布"):
        body.name = tpl["name"]
    ts = now()
    cid = execute(
        "INSERT INTO canvases (name, template, created_at, updated_at) VALUES (?,?,?,?)",
        (body.name, body.template, ts, ts),
    )
    if tpl:
        for n in tpl["nodes"]:
            execute(
                """INSERT INTO canvas_nodes (canvas_id, node_key, type, skill_id, title, x, y, config_json)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    cid,
                    n["node_key"],
                    n.get("type", "skill"),
                    n.get("skill_id"),
                    n.get("title", ""),
                    n.get("x", 0),
                    n.get("y", 0),
                    json.dumps(n.get("config", {}), ensure_ascii=False),
                ),
            )
        for e in tpl["edges"]:
            execute(
                "INSERT INTO canvas_edges (canvas_id, source_key, target_key) VALUES (?,?,?)",
                (cid, e["source_key"], e["target_key"]),
            )
    return {"id": cid, "name": body.name}


@router.get("/{canvas_id}")
def api_get(canvas_id: int):
    c = _canvas_or_404(canvas_id)
    runs = query(
        """SELECT r.id, r.status, r.scope, r.started_at,
                  (SELECT COUNT(*) FROM canvas_node_outputs o WHERE o.run_id=r.id) out_count
           FROM canvas_runs r WHERE r.canvas_id=? ORDER BY r.id DESC LIMIT 10""",
        (canvas_id,),
    )
    latest = query(
        """SELECT o.node_key, o.output_text, o.provider, o.model, o.elapsed_ms,
                  o.tokens_in, o.tokens_out, o.created_at, o.status, o.error_json
           FROM canvas_node_outputs o
           WHERE o.run_id = (SELECT MAX(id) FROM canvas_runs WHERE canvas_id=?)
        """,
        (canvas_id,),
    )
    for r in latest:
        # sqlite 里没有 BOOL：status 列是 'done' / 'error'，前端按 ok 布尔取值
        r["ok"] = (r.get("status") or "done") != "error"
        if r.get("error_json"):
            try:
                r["error"] = json.loads(r["error_json"])
            except ValueError:
                r["error"] = None
    return {"canvas": c, "nodes": _nodes(canvas_id), "edges": _edges(canvas_id), "runs": runs, "latest": latest}


@router.post("/{canvas_id}/save")
def api_save(canvas_id: int, body: CanvasSave):
    _canvas_or_404(canvas_id)
    if body.name:
        execute("UPDATE canvases SET name=?, updated_at=? WHERE id=?", (body.name, now(), canvas_id))
    execute("DELETE FROM canvas_nodes WHERE canvas_id=?", (canvas_id,))
    execute("DELETE FROM canvas_edges WHERE canvas_id=?", (canvas_id,))
    for n in body.nodes:
        execute(
            """INSERT INTO canvas_nodes (canvas_id, node_key, type, skill_id, title, x, y, config_json)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                canvas_id,
                n.node_key,
                n.type,
                n.skill_id,
                n.title,
                n.x,
                n.y,
                json.dumps(n.config, ensure_ascii=False),
            ),
        )
    for e in body.edges:
        execute(
            "INSERT INTO canvas_edges (canvas_id, source_key, target_key) VALUES (?,?,?)",
            (canvas_id, e.source_key, e.target_key),
        )
    return {"ok": True, "saved": len(body.nodes)}


@router.post("/{canvas_id}/save-as-template")
def api_save_as_template(canvas_id: int, body: TemplateBody):
    """把当前画布冻结成模板。空画布存模板没有意义，直接 400。"""
    _canvas_or_404(canvas_id)
    nodes = _nodes(canvas_id)
    if not nodes:
        raise HTTPException(400, "空画布不能存为模板")
    tpl = canvas_templates.save_from_canvas(body.name, nodes, _edges(canvas_id))
    return {"key": tpl["key"], "name": tpl["name"], "node_count": len(tpl["nodes"])}


@router.delete("/{canvas_id}")
def api_delete(canvas_id: int):
    _canvas_or_404(canvas_id)
    execute("DELETE FROM canvas_node_outputs WHERE run_id IN (SELECT id FROM canvas_runs WHERE canvas_id=?)", (canvas_id,))
    execute("DELETE FROM canvas_runs WHERE canvas_id=?", (canvas_id,))
    execute("DELETE FROM canvas_nodes WHERE canvas_id=?", (canvas_id,))
    execute("DELETE FROM canvas_edges WHERE canvas_id=?", (canvas_id,))
    execute("DELETE FROM canvases WHERE id=?", (canvas_id,))
    return {"ok": True}


# ---------- 执行 ----------

# 被请求取消的 run_id。后台任务在每个节点之间检查一次：
# 真正能取消的地方只有「节点之间」，单个 HTTP 调用发出去了就拦不回来。
_CANCELLED: set[int] = set()
# 正在跑的 run_id。进程重启后这张表是空的 —— 据此把「卡在 running 的孤儿」判死，
# 否则前端会一直轮询一个永远不会结束的任务。
_ACTIVE: set[int] = set()


async def _execute_run(run_id: int, canvas_id: int, order: list[dict], edges: list[dict],
                       outputs: dict):
    """后台逐个跑节点。每跑完一个就把输出落库，前端轮询即可看到中间态。"""
    _ACTIVE.add(run_id)
    execute("UPDATE canvas_runs SET status='running' WHERE id=?", (run_id,))
    by_key = {n["node_key"]: n for n in order}
    failed = 0
    ok_map: dict[str, bool] = {}
    for node in order:
        key = node["node_key"]
        if run_id in _CANCELLED:
            execute(
                "UPDATE canvas_runs SET status='cancelled', finished_at=? WHERE id=?",
                (now(), run_id),
            )
            _CANCELLED.discard(run_id)
            _ACTIVE.discard(run_id)
            return
        ups = _upstreams(key, edges)
        ctx_parts = []
        for u in ups:
            if outputs.get(u):
                title = by_key.get(u, {}).get("title") or u
                ctx_parts.append(f"【{title}】\n{outputs[u]}")
        upstream_text = "\n\n".join(ctx_parts)
        upstream_ok = {u: ok_map.get(u, True) for u in ups if u in by_key or u in ok_map}
        t0 = time.time()
        try:
            text, meta = await _exec_node(node, upstream_text, outputs, upstream_ok)
        except Exception as exc:  # noqa: BLE001 —— 单个节点炸了不能让整张图失去记录
            text = ""
            meta = {
                "provider": "",
                "model": "",
                "tokens_in": 0,
                "tokens_out": 0,
                "ok": False,
                "error": {
                    "kind": "unknown",
                    "label": "节点执行异常",
                    "message": f"{type(exc).__name__}: {redact(exc)}",
                    "detail": "",
                    "hint": "重试该节点；反复失败就换个 provider 或简化输入。",
                },
            }
        outputs[key] = text
        ok = bool(meta.get("ok", True))
        ok_map[key] = ok
        if not ok:
            failed += 1
        elapsed = meta.get("elapsed_ms") or int((time.time() - t0) * 1000)
        execute(
            """INSERT INTO canvas_node_outputs
               (run_id, node_key, input_text, output_text, provider, model, tokens_in, tokens_out,
                elapsed_ms, status, error_json, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                run_id,
                key,
                upstream_text[:4000],
                text,
                meta.get("provider", ""),
                meta.get("model", ""),
                int(meta.get("tokens_in", 0)),
                int(meta.get("tokens_out", 0)),
                int(elapsed),
                "done" if ok else "error",
                json.dumps(meta.get("error") or {}, ensure_ascii=False) if not ok else None,
                now(),
            ),
        )

    _CANCELLED.discard(run_id)
    _ACTIVE.discard(run_id)
    execute(
        "UPDATE canvas_runs SET status=?, finished_at=? WHERE id=?",
        ("failed" if failed else "done", now(), run_id),
    )


@router.post("/{canvas_id}/run")
async def api_run(canvas_id: int, body: RunBody):
    """启动一次运行。立刻返回 run_id，实际执行在后台，用 GET /runs/{id} 轮询。

    以前这个接口是同步阻塞的：六个节点串行跑两分钟，前端只能干等着 spinner，
    期间既看不到进度也无法取消。
    """
    _canvas_or_404(canvas_id)
    nodes = _nodes(canvas_id)
    edges = _edges(canvas_id)
    if not nodes:
        raise HTTPException(400, "画布为空")

    order = _topo(nodes, edges)
    by_key = {n["node_key"]: n for n in nodes}
    outputs: dict[str, str] = {}

    # 单节点运行：把祖先的最新成功输出带进上下文；
    # force=true 时连祖先一起重跑，否则只跑这一个节点。
    if body.node_key:
        if body.node_key not in by_key:
            raise HTTPException(404, "node not found")

        def ancestors(k: str, seen: set[str], depth: int = 0):
            if depth > 20:
                return seen
            for u in _upstreams(k, edges):
                if u in by_key and u not in seen:
                    seen.add(u)
                    ancestors(u, seen, depth + 1)
            return seen

        ups = ancestors(body.node_key, set())
        if body.force:
            need = ups | {body.node_key}
            order = [n for n in order if n["node_key"] in need]
        else:
            for u in ups:
                cached = _latest_output(canvas_id, u)
                if cached:
                    outputs[u] = cached
            order = [n for n in order if n["node_key"] == body.node_key]

    plan_keys = [n["node_key"] for n in order]
    run_id = execute(
        "INSERT INTO canvas_runs (canvas_id, scope, status, started_at) VALUES (?,?,?,?)",
        (canvas_id, body.node_key or "all", "queued", now()),
    )
    # 先登记再起任务：否则「已入队但协程还没被调度」这一小段会被判成孤儿任务
    _ACTIVE.add(run_id)
    task = asyncio.create_task(_execute_run(run_id, canvas_id, order, edges, outputs))
    # 任务无论正常结束还是抛异常，都要从在跑清单里摘掉
    task.add_done_callback(lambda _t: _ACTIVE.discard(run_id))
    return {
        "run_id": run_id,
        "status": "queued",
        "nodes": plan_keys,
        "scope": body.node_key or "all",
    }


def _latest_output(canvas_id: int, node_key: str) -> str:
    rows = query(
        """SELECT output_text FROM canvas_node_outputs
           WHERE node_key=? AND status='done'
             AND run_id IN (SELECT id FROM canvas_runs WHERE canvas_id=?)
           ORDER BY id DESC LIMIT 1""",
        (node_key, canvas_id),
    )
    return rows[0]["output_text"] if rows else ""


@router.post("/runs/{run_id}/cancel")
def api_cancel_run(run_id: int):
    """请求取消：后台任务在下一个节点开始前退出，已完成的节点记录保留。"""
    rows = query("SELECT * FROM canvas_runs WHERE id=?", (run_id,))
    if not rows:
        raise HTTPException(404, "run not found")
    status = rows[0]["status"]
    if status in ("done", "failed", "cancelled"):
        return {"ok": False, "status": status, "message": "这次运行已经结束了"}
    _CANCELLED.add(run_id)
    return {"ok": True, "status": "cancelling", "message": "已请求取消，正在运行的节点结束后停止"}


@router.get("/{canvas_id}/runs")
def api_runs(canvas_id: int):
    _canvas_or_404(canvas_id)
    runs = query(
        """SELECT r.id, r.scope, r.status, r.started_at, r.finished_at,
                  (SELECT COUNT(*) FROM canvas_node_outputs o WHERE o.run_id=r.id) out_count
           FROM canvas_runs r WHERE r.canvas_id=? ORDER BY r.id DESC LIMIT 20""",
        (canvas_id,),
    )
    return {"runs": runs}


@router.get("/runs/{run_id}")
def api_run_detail(run_id: int):
    rows = query("SELECT * FROM canvas_runs WHERE id=?", (run_id,))
    if not rows:
        raise HTTPException(404, "run not found")
    outs = query("SELECT * FROM canvas_node_outputs WHERE run_id=? ORDER BY id", (run_id,))
    for o in outs:
        o["ok"] = (o.get("status") or "done") != "error"
        if o.get("error_json"):
            try:
                o["error"] = json.loads(o["error_json"])
            except ValueError:
                o["error"] = None
    run = dict(rows[0])
    # 后台任务被强杀 / 进程重启时 status 会卡在 running 或 queued。
    # 这种孤儿任务永远不会结束，必须在这里判死，否则前端会无限轮询。
    if run.get("status") in ("running", "queued") and run_id not in _ACTIVE:
        execute(
            "UPDATE canvas_runs SET status='failed', finished_at=? WHERE id=?",
            (now(), run_id),
        )
        run["status"] = "failed"
        run["stale"] = True
        run["message"] = "上次运行随服务中断结束了，没有留下结果。重跑一次即可。"
    run["node_count"] = len(outs)
    return {"run": run, "outputs": outs}


# ---------- 输出落库 ----------


@router.post("/{canvas_id}/output/save")
def api_save_output(canvas_id: int, body: SaveOutputBody):
    _canvas_or_404(canvas_id)
    row = query(
        """SELECT output_text, COALESCE(status,'done') AS status, error_json FROM canvas_node_outputs
           WHERE node_key=? AND run_id IN (SELECT id FROM canvas_runs WHERE canvas_id=?)
           ORDER BY id DESC LIMIT 1""",
        (body.node_key, canvas_id),
    )
    if not row:
        raise HTTPException(404, "该节点还没有运行输出")
    if row[0]["status"] == "error":
        # 这条输出是失败记录。存它会把「调用失败 / 未配置」当成科研成果写进库里，
        # 之后再想分辨哪条是真产出就得靠猜。
        detail = ""
        if row[0].get("error_json"):
            try:
                detail = (json.loads(row[0]["error_json"]) or {}).get("message") or ""
            except ValueError:
                detail = ""
        raise HTTPException(
            409,
            f"这个节点最后一次运行是失败的（{detail or '未知原因'}），没有可保存的成果。"
            "修好配置后重跑节点再存。",
        )
    if not (row[0]["output_text"] or "").strip():
        raise HTTPException(409, "这个节点的输出是空的，先重跑拿到结果再存")
    text = row[0]["output_text"] or ""
    ts = now()
    title = body.title or f"画布产出 · {body.node_key} · {ts[:10]}"
    if body.target == "idea":
        nid = execute(
            """INSERT INTO ideas (title, one_liner, direction, status, notes, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (title, text[:200], "画布", "captured", text, ts, ts),
        )
        return {"ok": True, "target": "idea", "id": nid}
    if body.target == "literature":
        nid = execute(
            """INSERT INTO literature (title, authors, notes, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?)""",
            (title, "画布产出", text, "todo", ts, ts),
        )
        return {"ok": True, "target": "literature", "id": nid}
    # paper：写进「当前阶段」（blocked 优先，其次 doing，都没有才退回第一个）
    rows = query(
        "SELECT id, status FROM paper_stages ORDER BY CASE status "
        "WHEN 'blocked' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END, sort_order, id LIMIT 1"
    )
    if rows:
        execute(
            "UPDATE paper_stages SET blocker=?, updated_at=? WHERE id=?",
            (text[:500], ts, rows[0]["id"]),
        )
        return {"ok": True, "target": "paper", "stage_id": rows[0]["id"]}
    raise HTTPException(400, "还没有论文阶段可以写入")
