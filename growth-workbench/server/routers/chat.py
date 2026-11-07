"""对话模块：多轮会话 + 角色预设 + 可注入工作台上下文。

会话与消息都存在本地 SQLite，换页面/重启都不丢。
上下文注入让对话能直接引用创新点、文献、实验、论文进度，而不是从零复述背景。
"""
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import llm
from db import execute, now, query

router = APIRouter(prefix="/api/chat", tags=["chat"])

# Quest 阶段（DeepScientist 的受控推进节奏：调研 → 计划 → 实验 → 成文）。
# 每个阶段都带 SOP（标准作业流程）、交付物（必须有）、门禁（越过前必须等用户确认），
# 后端每轮把这些信息拼进 system prompt，让对话「严格按方法推进」而非随意闲聊。
STAGES: list[dict] = [
    {
        "value": "survey",
        "label": "调研",
        "brief": "梳理研究现状：关键工作、主流方法、已知缺口，产出调研小结",
        "sop": (
            "系统梳理研究现状：关键工作、主流方法、已知缺口、潜在 baseline 与可复用数据集/指标。"
            "优先用工作台已注入的文献与创新点；需要外部文献时给出检索式与优先级，绝不臆造文献、数字或引用。"
        ),
        "deliverables": (
            "①研究地图（主干技术脉络 2-4 条）②关键工作对比表（方法/优缺点/适用条件）"
            "③缺口与机会点清单 ④推荐 baseline 候选 + 评估契约（指标与判据）⑤待确认的研究问题。"
        ),
        "gate": (
            "「调研→计划」门前，必须向用户呈现研究地图与缺口，等用户确认研究方向与 baseline 后再进入计划，"
            "不得自行假定研究问题。"
        ),
    },
    {
        "value": "plan",
        "label": "计划",
        "brief": "输出分阶段研究计划：每阶段有可验证产出与判据，等我确认后执行",
        "sop": (
            "基于已确认的调研，建立可信 baseline 与分阶段研究计划。采用发散-收敛-精炼：先列多个候选方向，"
            "再给选择理由与证据强度，最后收敛到一个方向，拆成可验证的分阶段计划。"
        ),
        "deliverables": (
            "①baseline 复现/对齐方案（同数据/同预算/同调参的公平前提）②分阶段计划（每阶段有可验证产出与判据）"
            "③选定方向 + 取舍理由 ④风险与所需资源清单。"
        ),
        "gate": (
            "「计划→实验」门前，必须呈现分阶段计划与选定方向，等用户确认后才细化实验设计、动代码或跑实验，"
            "不得在门禁前执行主实验。"
        ),
    },
    {
        "value": "experiment",
        "label": "实验",
        "brief": "把当前计划的第一步细化成可执行任务/实验设计；需要我提供数据时明确列出格式",
        "sop": (
            "把计划第一步细化为可执行实验：变量与控制、随机化/重复、样本量依据、指标与判据、混淆因素。"
            "需要用户提供数据时，明确列出格式与字段，绝不伪造数据。每轮只推进执行清单中一项「进行中」。"
        ),
        "deliverables": (
            "①实验协议（设计+参数+判据）②主实验结果（与 baseline 可比的指标）"
            "③消融/鲁棒性切片（证据账本）④与计划的偏差说明。"
        ),
        "gate": (
            "主实验产出达到计划判据后，才可进入成文；未达则先回到计划或补实验，并说明原因，"
            "不得把未达标的实验当结论写进论文。"
        ),
    },
    {
        "value": "write",
        "label": "成文",
        "brief": "基于已确认的发现，整理研究报告/论文骨架与核心论证",
        "sop": (
            "基于已确认发现整理研究报告/论文骨架。证据优先：每个主张必须能追溯到一条实验/调研产物；"
            "整理后从审稿人视角自检（新颖性/严谨性/说服力），预判 3 个最可能被追问的点。"
        ),
        "deliverables": (
            "①论文骨架（标题候选/摘要/各节要点与字数）②核心论证链（每环对应证据）"
            "③图表方案与 caption 草稿 ④局限性与下一步。"
        ),
        "gate": (
            "成稿后必须做一次苛刻自审（Reviewer 视角），标出致命漏洞与补救，再交付给用户；"
            "无证据支撑的声明一律标注「待验证」。"
        ),
    },
]

# DeepScientist 方法宪章：每轮注入 system prompt，把「随意对话」升级为「按方法受控推进」。
METHOD_CHARTER = """你是 DeepScientist 式自治科研智能体。一个 quest = 一个长期研究课题，沿「调研 → 计划 → 实验 → 成文」的研究图推进。严格遵守以下运行纪律：

1. 三层待办契约（防上下文漂移）：
   - 课题根计划：全局研究地图与循环追踪，开题时由契约确定。
   - 阶段契约：当前阶段的活跃契约，写明本阶段目标、交付物、判据。
   - 执行清单：当前执行前沿，一次只推进一项「进行中」。
   每进入新阶段或每轮推进，先对齐这三层，再动手。

2. 阶段门禁（gate）：调研→计划、计划→实验 之间设有确认门。门未由用户明确确认前，不得越过门进入下一阶段的核心执行；只能在当前阶段内做准备工作。

3. 证据优先写作：成文阶段每个主张必须能追溯到一条实验/调研产物；没有证据的断言标注为「待验证」，不得当作结论。

4. 发现记忆：已被用户沉淀为「发现」的结论，后续每轮自动带入，不得遗忘或重复质疑。

5. 受控自治：可在阶段内连续自主推进，但遇门禁、证据不足或需用户提供数据时，主动停下并明确列出所需输入，而不是编造或假装完成。"""


def _stage_or_default(stage: str | None) -> str:
    return stage if stage in {s["value"] for s in STAGES} else "survey"

# 角色预设：一句话人设 + system prompt
ROLES: dict[str, dict[str, str]] = {
    "assistant": {
        "label": "科研助手",
        "system": (
            "你是一位严谨的科研助手，服务于一位做 OpenFOAM/CFD 与 LLM 智能体方向研究的博士生。"
            "回答用简体中文，结构化、具体、可执行，拒绝空话套话。涉及对比优先用表格。"
            "不要臆造文献、数字或引用；不确定就明说。追问时先复述你的理解再回答。"
        ),
    },
    "reviewer": {
        "label": "挑剔审稿人",
        "system": (
            "你是一位顶会审稿人（Reviewer #2），苛刻但讲理。用户的每个想法你都要找漏洞："
            "实验设计是否站得住、基线是否公平、指标是否有说服力、与已有工作是否撞车。"
            "每次回答给出 3 条最致命的问题 + 1 条补救建议。不要为了挑刺而挑刺，必须给出理由。"
        ),
    },
    "mentor": {
        "label": "务实导师",
        "system": (
            "你是一位务实、时间有限的导师，最关心学生能否按时毕业、工作能否落地。"
            "回答时优先关注：工作量可控吗、一个月内能出结果吗、风险在哪、下一步做什么。"
            "直接给优先级排序和可执行动作，少讲理论。"
        ),
    },
    "writer": {
        "label": "论文写作教练",
        "system": (
            "你是一位论文写作教练，擅长把粗糙的研究想法整理成可发表的叙述。"
            "帮助用户：理清 contribution 与 story、设计实验叙事、改写段落使其更学术严谨。"
            "给具体改写示例，指出哪些说法会被审稿人质疑。"
        ),
    },
    "cfd": {
        "label": "OpenFOAM/CFD 专家",
        "system": (
            "你是 OpenFOAM 与 CFD 方向的资深工程师，熟悉 OpenFOAM 2406 的求解器、字典文件、"
            "边界条件、湍流模型、网格无关性验证与残差分析。"
            "回答时给出具体的字典配置片段、命令与排查步骤。指出常见坑（量纲、离散格式、松弛因子、并行分解）。"
        ),
    },
}


def _role_system(role: str) -> str:
    return (ROLES.get(role) or ROLES["assistant"])["system"]


# ------------------------------ 上下文 ------------------------------


def _ctx_ideas() -> str:
    rows = query("SELECT title, one_liner, category, direction, status, novelty, feasibility, impact, effort FROM ideas ORDER BY id DESC LIMIT 30")
    if not rows:
        return ""
    lines = ["【创新点池】"]
    for r in rows:
        lines.append(
            f"- {r['title']}"
            + (f"（分类：{r['category']}）" if r.get("category") else "")
            + f"｜状态 {r['status']}｜评分 新{r['novelty']}/可{r['feasibility']}/影{r['impact']}/工{r['effort']}"
        )
        if r.get("one_liner"):
            lines.append(f"  主张：{r['one_liner'][:200]}")
    return "\n".join(lines)


def _ctx_literature() -> str:
    rows = query("SELECT title, year, venue, status, collections, tags FROM literature ORDER BY id DESC LIMIT 40")
    if not rows:
        return ""
    lines = ["【文献库】"]
    for r in rows:
        meta = " · ".join([x for x in (str(r["year"]) if r.get("year") else "", r.get("venue") or "") if x])
        lines.append(f"- {r['title']}" + (f"（{meta}）" if meta else "") + f"｜{r['status']}")
    return "\n".join(lines)


def _ctx_experiments() -> str:
    rows = query("SELECT name, hypothesis, status, conclusion FROM experiments ORDER BY id DESC LIMIT 20")
    if not rows:
        return ""
    lines = ["【实验】"]
    for r in rows:
        lines.append(f"- {r['name']}｜{r['status']}")
        if r.get("hypothesis"):
            lines.append(f"  假设：{str(r['hypothesis'])[:200]}")
        if r.get("conclusion"):
            lines.append(f"  结论：{str(r['conclusion'])[:200]}")
    return "\n".join(lines)


def _ctx_paper() -> str:
    stages = query("SELECT name, status FROM paper_stages ORDER BY sort_order")
    sections = query("SELECT name, status, target_words FROM paper_sections ORDER BY sort_order")
    if not stages and not sections:
        return ""
    lines = ["【论文进度】"]
    lines.append("阶段：" + "、".join(f"{s['name']}({s['status']})" for s in stages))
    lines.append("章节：" + "、".join(f"{s['name']}({s['status']})" for s in sections))
    return "\n".join(lines)


def _ctx_plan() -> str:
    # weekly_plans 只有 week_start / outcomes_json / review_json 三列业务字段，
    # 早期版本在这里查了 focus / done_summary / blocker —— 列不存在，查询直接抛错，
    # 被 build_context 的 try/except 吞掉，表现为「周计划上下文永远是空的」。
    rows = query(
        "SELECT week_start, outcomes_json, review_json, status FROM weekly_plans "
        "ORDER BY week_start DESC LIMIT 4"
    )
    if not rows:
        return ""

    def _as_list(raw: str | None) -> list[str]:
        try:
            v = json.loads(raw or "[]")
        except (ValueError, TypeError):
            return []
        return [str(x) for x in v] if isinstance(v, list) else []

    def _as_dict(raw: str | None) -> dict:
        try:
            v = json.loads(raw or "null")
        except (ValueError, TypeError):
            return {}
        return v if isinstance(v, dict) else {}

    lines = ["【近期周计划】"]
    for r in rows:
        outcomes = _as_list(r.get("outcomes_json"))
        review = _as_dict(r.get("review_json"))
        lines.append(f"- {r['week_start']}（{r.get('status') or 'active'}）")
        if outcomes:
            lines.append("  计划产出：" + "；".join(outcomes[:6]))
        if review.get("done"):
            lines.append("  已完成：" + "；".join(str(x) for x in review["done"][:6]))
        if review.get("missed"):
            lines.append("  未完成：" + "；".join(str(x) for x in review["missed"][:6]))
        if review.get("blockers"):
            lines.append(f"  卡点：{str(review['blockers'])[:200]}")
        if review.get("next_min_action"):
            lines.append(f"  下一步：{str(review['next_min_action'])[:200]}")
    return "\n".join(lines)


CONTEXT_BUILDERS = {
    "ideas": _ctx_ideas,
    "literature": _ctx_literature,
    "experiments": _ctx_experiments,
    "paper": _ctx_paper,
    "plan": _ctx_plan,
}


def build_context(keys: list[str], extra: str = "") -> str:
    parts = []
    for k in keys or []:
        fn = CONTEXT_BUILDERS.get(k)
        if not fn:
            continue
        try:
            txt = fn()
        except Exception:
            txt = ""
        if txt:
            parts.append(txt)
    if (extra or "").strip():
        parts.append("【用户补充背景】\n" + extra.strip())
    if not parts:
        return ""
    return (
        "下面是用户工作台里的真实数据，回答时请据此作答，不要凭空假设：\n\n"
        + "\n\n".join(parts)
    )


@router.get("/stages")
def stages():
    return {"stages": STAGES}


@router.get("/roles")
def roles():
    return {"roles": [{"value": k, "label": v["label"]} for k, v in ROLES.items()]}


@router.get("/context/options")
def context_options():
    return {
        "options": [
            {"value": "ideas", "label": "创新点池"},
            {"value": "literature", "label": "文献库"},
            {"value": "experiments", "label": "实验记录"},
            {"value": "paper", "label": "论文进度"},
            {"value": "plan", "label": "近期周计划"},
        ]
    }


@router.post("/context/preview")
def context_preview(body: dict):
    return {"text": build_context(body.get("keys") or [], body.get("extra") or "")}


# ------------------------------ 会话 ------------------------------


class SessionIn(BaseModel):
    title: str = ""
    role: str = "assistant"
    mode: str = "fast"
    context_keys: list[str] = []
    context_extra: str = ""
    stage: str = "survey"


@router.get("/sessions")
def list_sessions():
    rows = query(
        """SELECT s.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.id) AS msg_count,
           (SELECT m.content FROM chat_messages m WHERE m.session_id=s.id ORDER BY m.id LIMIT 1) AS first_msg
           FROM chat_sessions s ORDER BY s.updated_at DESC"""
    )
    return rows


@router.post("/sessions")
def create_session(body: SessionIn):
    ts = now()
    sid = execute(
        "INSERT INTO chat_sessions (title, role, mode, context, stage, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (
            body.title or "新对话",
            body.role,
            body.mode,
            build_context(body.context_keys, body.context_extra),
            _stage_or_default(body.stage),
            ts,
            ts,
        ),
    )
    return _session(sid)


def _session(sid: int) -> dict:
    rows = query("SELECT * FROM chat_sessions WHERE id=?", (sid,))
    if not rows:
        raise HTTPException(404, "会话不存在")
    s = rows[0]
    s["messages"] = query(
        "SELECT id, role, content, provider, model, tokens_in, tokens_out, created_at "
        "FROM chat_messages WHERE session_id=? ORDER BY id",
        (sid,),
    )
    return s


@router.get("/sessions/{sid}")
def get_session(sid: int):
    return _session(sid)


class SessionPatch(BaseModel):
    title: str | None = None
    role: str | None = None
    mode: str | None = None
    context_keys: list[str] | None = None
    context_extra: str | None = None
    stage: str | None = None


@router.patch("/sessions/{sid}")
def update_session(sid: int, body: SessionPatch):
    rows = query("SELECT * FROM chat_sessions WHERE id=?", (sid,))
    if not rows:
        raise HTTPException(404, "会话不存在")
    cur = rows[0]
    sets, vals = [], []
    if body.title is not None:
        sets.append("title=?")
        vals.append(body.title)
    if body.role is not None:
        sets.append("role=?")
        vals.append(body.role)
    if body.mode is not None:
        sets.append("mode=?")
        vals.append(body.mode)
    if body.stage is not None:
        sets.append("stage=?")
        vals.append(_stage_or_default(body.stage))
    if body.context_keys is not None or body.context_extra is not None:
        keys = body.context_keys
        if keys is None:
            keys = ["ideas"]
        sets.append("context=?")
        vals.append(build_context(keys, body.context_extra or ""))
    if not sets:
        return _session(sid)
    sets.append("updated_at=?")
    vals.append(now())
    vals.append(sid)
    execute(f"UPDATE chat_sessions SET {','.join(sets)} WHERE id=?", vals)
    return _session(sid)


@router.delete("/sessions/{sid}")
def delete_session(sid: int):
    execute("DELETE FROM chat_messages WHERE session_id=?", (sid,))
    execute("DELETE FROM chat_findings WHERE session_id=?", (sid,))
    execute("DELETE FROM chat_sessions WHERE id=?", (sid,))
    return {"ok": True}


# ------------------------------ 发现沉淀（Findings Memory） ------------------------------
# DeepScientist 的核心机制之一：quest 里确认过的结论被沉淀下来，
# 后续每一轮都自动注入 system prompt，模型不会「忘」早期结论。


def _findings_text(sid: int) -> str:
    rows = query(
        "SELECT content FROM chat_findings WHERE session_id=? ORDER BY id LIMIT 40",
        (sid,),
    )
    if not rows:
        return ""
    return "【本课题已确认的发现（Findings Memory）】\n" + "\n".join(
        f"- {r['content']}" for r in rows
    )


class FindingIn(BaseModel):
    content: str
    source_msg_id: int | None = None


@router.get("/sessions/{sid}/findings")
def list_findings(sid: int):
    return query(
        "SELECT * FROM chat_findings WHERE session_id=? ORDER BY id DESC", (sid,)
    )


@router.post("/sessions/{sid}/findings")
def create_finding(sid: int, body: FindingIn):
    if not query("SELECT id FROM chat_sessions WHERE id=?", (sid,)):
        raise HTTPException(404, "会话不存在")
    text = (body.content or "").strip()
    if not text:
        raise HTTPException(400, "发现内容为空")
    fid = execute(
        "INSERT INTO chat_findings (session_id, content, source_msg_id, created_at) VALUES (?,?,?,?)",
        (sid, text[:2000], body.source_msg_id, now()),
    )
    return {"ok": True, "id": fid}


@router.delete("/findings/{fid}")
def delete_finding(fid: int):
    execute("DELETE FROM chat_findings WHERE id=?", (fid,))
    return {"ok": True}


# ------------------------------ 发消息 ------------------------------


class MessageIn(BaseModel):
    content: str
    mode: str | None = None
    history_limit: int = 20
    regenerate: bool = False


@router.post("/sessions/{sid}/messages")
async def send_message(sid: int, body: MessageIn):
    s, text, hist, system, mode = _prepare(sid, body)

    env = await llm.chat_result(hist, system=system, mode=mode, task="chat", max_tokens=4096)

    if not env["ok"]:
        # 失败不写入 assistant 消息：它会在历史里留下一句假回复，
        # 下一次请求还会把它当上下文喂回去。用户提问已入库，重发即可重试。
        return {
            "ok": False,
            "reply": "",
            "title": s.get("title") or "",
            "error": env["error"],
        }

    content = (env.get("content") or "").strip()
    execute(
        """INSERT INTO chat_messages (session_id, role, content, provider, model, tokens_in, tokens_out, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            sid,
            "assistant",
            content,
            env.get("provider") or "",
            env.get("model") or "",
            int(env.get("tokens_in") or 0),
            int(env.get("tokens_out") or 0),
            now(),
        ),
    )

    # 首轮之后自动起个标题，免得会话列表全是「新对话」
    title = s.get("title") or ""
    if not title or title == "新对话":
        n = int(query("SELECT COUNT(*) c FROM chat_messages WHERE session_id=?", (sid,))[0]["c"])
        if n <= 2:
            title = await _auto_title(text)
            execute("UPDATE chat_sessions SET title=? WHERE id=?", (title, sid))

    execute("UPDATE chat_sessions SET updated_at=? WHERE id=?", (now(), sid))
    return {
        "ok": True,
        "reply": content,
        "title": title,
        "error": None,
        "provider": env.get("provider"),
        "model": env.get("model"),
        "tokens_in": env.get("tokens_in"),
        "tokens_out": env.get("tokens_out"),
    }


def _prepare(sid: int, body: MessageIn):
    """发消息（流式/非流式共用）：校验会话、处理重跑、落库用户消息、组历史与 system。"""
    rows = query("SELECT * FROM chat_sessions WHERE id=?", (sid,))
    if not rows:
        raise HTTPException(404, "会话不存在")
    s = rows[0]
    text = (body.content or "").strip()

    # 重跑：复用上一条 user 内容，只删掉它之后的 assistant 回复，不再插一条新的 user
    if body.regenerate:
        last_user = query(
            "SELECT id, content FROM chat_messages WHERE session_id=? AND role='user' "
            "ORDER BY id DESC LIMIT 1",
            (sid,),
        )
        if last_user:
            text = last_user[0]["content"]
            execute(
                "DELETE FROM chat_messages WHERE session_id=? AND role='assistant' AND id>?",
                (sid, last_user[0]["id"]),
            )
    if not text:
        raise HTTPException(400, "消息内容为空")

    if not body.regenerate:
        execute(
            "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?,?,?,?)",
            (sid, "user", text, now()),
        )

    hist = query(
        "SELECT role, content FROM chat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?",
        (sid, int(body.history_limit or 20)),
    )
    hist.reverse()

    system = _role_system(s.get("role") or "assistant")
    if s.get("context"):
        system += "\n\n" + s["context"]
    # DeepScientist 方法宪章：每轮注入，让对话严格按方法推进而非随意闲聊
    system += "\n\n" + METHOD_CHARTER
    # Findings Memory：已确认的发现注入每一轮，模型不会「忘」
    findings_txt = _findings_text(sid)
    if findings_txt:
        system += "\n\n" + findings_txt
    # 阶段契约：当前阶段 SOP + 交付物 + 门禁，逐轮约束 AI 行为（而非一句「你处于 X 阶段」）
    stage = _stage_or_default(s.get("stage"))
    st = next((x for x in STAGES if x["value"] == stage), None)
    if st:
        system += (
            f"\n\n【当前 quest 阶段：{st['label']}】\n"
            f"阶段 SOP：{st['sop']}\n"
            f"本阶段交付物：{st['deliverables']}\n"
            f"阶段门禁：{st['gate']}\n"
            "请先给出本阶段产出结构，确认方向无误后再展开内容；越过本阶段门禁前必须等用户明确确认，不得自行跳阶段执行。"
        )

    mode = body.mode or s.get("mode") or "fast"
    return s, text, hist, system, mode


@router.post("/sessions/{sid}/messages/stream")
async def send_message_stream(sid: int, body: MessageIn):
    """流式发消息（SSE）。

    事件流：delta（增量文本）→ done（落库完成的 meta）或 error（信封错误）。
    注意：本接口不能用 Idempotency-Key —— 幂等中间件会把响应体整个缓存，
    流式就被破坏了；前端 raw fetch 时不要带该头。
    """
    s, text, hist, system, mode = _prepare(sid, body)

    async def gen():
        live: list[str] = []
        try:
            async for ev in llm.stream_chat_events(hist, system=system, mode=mode, task="chat", max_tokens=4096):
                if ev["type"] == "delta":
                    live.append(ev["text"])
                    yield f"data: {json.dumps({'type': 'delta', 'text': ev['text']}, ensure_ascii=False)}\n\n"
                elif ev["type"] == "error":
                    # 失败不落库：任何已显示的部分内容都只是草稿，重发即可重试
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    return
                else:  # meta：落库 assistant 消息
                    content = ev["content"]
                    mid = execute(
                        """INSERT INTO chat_messages (session_id, role, content, provider, model, tokens_in, tokens_out, created_at)
                           VALUES (?,?,?,?,?,?,?,?)""",
                        (
                            sid,
                            "assistant",
                            content,
                            ev.get("provider") or "",
                            ev.get("model") or "",
                            int(ev.get("tokens_in") or 0),
                            int(ev.get("tokens_out") or 0),
                            now(),
                        ),
                    )
                    title = s.get("title") or ""
                    if not title or title == "新对话":
                        n = int(query("SELECT COUNT(*) c FROM chat_messages WHERE session_id=?", (sid,))[0]["c"])
                        if n <= 2:
                            title = await _auto_title(text)
                            execute("UPDATE chat_sessions SET title=? WHERE id=?", (title, sid))
                    execute("UPDATE chat_sessions SET updated_at=? WHERE id=?", (now(), sid))
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "type": "done",
                                "id": mid,
                                "title": title,
                                "provider": ev.get("provider") or "",
                                "model": ev.get("model") or "",
                                "tokens_in": int(ev.get("tokens_in") or 0),
                                "tokens_out": int(ev.get("tokens_out") or 0),
                            },
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    )
        except Exception as exc:  # noqa: BLE001 —— 生成器自己炸了也要给前端一个信封事件
            yield (
                "data: "
                + json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "kind": "unknown",
                            "label": "流式输出中断",
                            "message": llm.redact(f"{type(exc).__name__}: {exc}"),
                            "detail": "",
                            "hint": "重试即可；若反复中断，去设置页换一个 provider。",
                        },
                    },
                    ensure_ascii=False,
                )
                + "\n\n"
            )

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _auto_title(first_user_msg: str) -> str:
    fallback = (first_user_msg or "").strip().replace("\n", " ")[:18] or "新对话"
    try:
        prompt = (
            "给下面这段对话起一个 12 字以内的中文标题。只输出标题本身，"
            "不要引号、不要解释、不要换行。\n\n" + (first_user_msg or "")[:500]
        )
        env = await llm.complete_result(prompt, mode="fast", task="chat-title", max_tokens=64)
        t = (env.get("content") or "").strip().splitlines()[:1]
        t = (t[0].strip("「」\"'#* ") if t else "")
    except Exception:
        t = ""
    # 模型偶尔不配合，输出一大段话 —— 太长就退回用提问原文
    if not t or len(t) > 18:
        return fallback
    return t


@router.post("/sessions/{sid}/clear")
def clear_messages(sid: int):
    execute("DELETE FROM chat_messages WHERE session_id=?", (sid,))
    return {"ok": True}


@router.post("/sessions/{sid}/export")
def export_session(sid: int) -> dict:
    s = _session(sid)
    lines = [f"# {s.get('title') or '对话'}", "", f"- 角色：{(ROLES.get(s.get('role') or '') or {}).get('label', '')}"]
    for m in s["messages"]:
        who = "我" if m["role"] == "user" else "AI"
        lines.append(f"\n## {who}\n\n{m['content']}")
    return {"markdown": "\n".join(lines), "title": s.get("title")}


class QuickIn(BaseModel):
    content: str
    role: str = "assistant"
    mode: str = "fast"
    context_keys: list[str] = []


@router.post("/quick")
async def quick(body: QuickIn):
    """不建会话的单次提问（用于其它页面内嵌的小问答）。"""
    system = _role_system(body.role)
    ctx = build_context(body.context_keys)
    if ctx:
        system += "\n\n" + ctx
    env = await llm.chat_result(
        [{"role": "user", "content": body.content}],
        system=system,
        mode=body.mode,
        task="chat-quick",
        max_tokens=4096,
    )
    return env


@router.get("/usage")
def usage():
    rows = query(
        "SELECT provider, task, SUM(tokens_in) tin, SUM(tokens_out) tout, COUNT(*) n "
        "FROM llm_usage GROUP BY provider, task ORDER BY n DESC LIMIT 20"
    )
    return {"rows": rows}
