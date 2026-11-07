"""导师沟通：承诺档案 + AI 话术生成。"""
from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import llm
from db import execute, now, query

router = APIRouter(prefix="/api/advisor", tags=["advisor"])

SCENES = ["周报", "求助", "要资源", "推进度", "请假或缓期"]


class NoteIn(BaseModel):
    date: str | None = None
    scene: str = "组会"
    advisor_said: str | None = None
    my_commitment: str | None = None
    due_date: str | None = None
    status: str = "open"


@router.get("/notes")
def list_notes():
    return query("SELECT * FROM advisor_notes ORDER BY id DESC")


@router.post("/notes")
def create_note(body: NoteIn):
    nid = execute(
        """INSERT INTO advisor_notes (date, scene, advisor_said, my_commitment, due_date, status)
           VALUES (?,?,?,?,?,?)""",
        (
            body.date or date.today().isoformat(),
            body.scene,
            body.advisor_said,
            body.my_commitment,
            body.due_date,
            body.status,
        ),
    )
    return query("SELECT * FROM advisor_notes WHERE id=?", (nid,))[0]


@router.patch("/notes/{note_id}")
def update_note(note_id: int, body: dict):
    allowed = {"date", "scene", "advisor_said", "my_commitment", "due_date", "status"}
    sets, vals = [], []
    for k, v in body.items():
        if k in allowed:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        raise HTTPException(400, "no valid field")
    vals.append(note_id)
    execute(f"UPDATE advisor_notes SET {','.join(sets)} WHERE id=?", vals)
    rows = query("SELECT * FROM advisor_notes WHERE id=?", (note_id,))
    if not rows:
        raise HTTPException(404, "note not found")
    return rows[0]


@router.delete("/notes/{note_id}")
def delete_note(note_id: int):
    execute("DELETE FROM advisor_notes WHERE id=?", (note_id,))
    return {"ok": True}


@router.get("/pending")
def pending():
    """未闭合承诺，逾期置顶。"""
    rows = query(
        "SELECT * FROM advisor_notes WHERE status='open' ORDER BY COALESCE(due_date,'9999'), id DESC"
    )
    today = date.today().isoformat()
    for r in rows:
        r = dict(r)
    out = []
    for r in rows:
        d = dict(r)
        d["overdue"] = bool(d.get("due_date") and d["due_date"] < today)
        out.append(d)
    out.sort(key=lambda x: (not x["overdue"], x.get("due_date") or "9999"))
    return out


class DraftIn(BaseModel):
    scene: str = "周报"
    progress: str | None = None
    blockers: str | None = None
    ask: str | None = None
    commitments: str | None = None


@router.post("/draft")
async def draft(body: DraftIn):
    prompt = f"""帮我写给导师的消息。

场景：{body.scene}
本周实际进展：{body.progress or '（未填写）'}
遇到的困难/卡点：{body.blockers or '（未填写）'}
我想向导师提出什么：{body.ask or '（未填写）'}
上次答应导师且已完成的事：{body.commitments or '（未填写）'}

请输出三个版本，每个版本独立成段，标注清楚：

【简洁版】适合微信直接发，5 句话以内，只讲结论和请求
【详细版】适合邮件，含进展-问题-请求三段，可附具体数字
【低姿态版】用于需要延期、没进展、或要资源时，诚恳但不卑微，主动给出补救方案

三个版本都要：
- 不甩锅、不找借口、不空喊努力
- 有明确的可执行请求（导师看完知道要做什么）
- 中文，语气自然，像博士生对导师说话，不像公文

每个版本之后单独加一行风险标注（⚠ 开头），指出这版话术里导师可能追问/反感的一句话，以及发送前建议先补齐什么。不要写「本话术仅供参考」之类的废话。"""
    env = await llm.complete_result(prompt, mode="fast", task="advisor-draft", max_tokens=2048)
    if not env["ok"]:
        return {"ok": False, "result": "", "scenes": SCENES, "error": env["error"]}
    return {
        "ok": True,
        "result": env["content"],
        "scenes": SCENES,
        "error": None,
        "provider": env["provider"],
        "model": env["model"],
        "tokens_in": env["tokens_in"],
        "tokens_out": env["tokens_out"],
    }


@router.post("/extract")
async def extract(body: dict):
    """沟通纪要抽取：一段流水账 → 结构化的「导师说的 / 我承诺的 / 截止日」。"""
    raw = (body or {}).get("raw", "").strip()
    if not raw:
        return {"ok": False, "result": "", "error": {
            "kind": "no_data", "label": "没有输入",
            "message": "把跟导师的聊天记录、会议速记或邮件原文贴进来再抽取。",
            "hint": None,
        }}
    prompt = f"""下面是一段和导师沟通的原始记录（可能是聊天记录、会议速记或邮件）。请抽取成结构化信息：

--- 原文开始 ---
{raw[:6000]}
--- 原文结束 ---

请输出严格的 JSON（不要包 markdown 代码块，不要加任何解释文字），字段：
{{
  "scene": "从这些里选一个最贴近的：组会/微信/邮件/走廊偶遇",
  "advisor_said": "导师提出的所有要求/意见/关注点，每条一行，保留原话关键部分；没有则空字符串",
  "my_commitment": "我答应过的所有事项，每条一行，动词开头；没有则空字符串",
  "due_date": "导师明确给出的截止日期，格式 YYYY-MM-DD；没给则空字符串",
  "risks": "沟通里的风险提示，比如：被追问的点、含糊的承诺、导师明显不满意的地方；没有则空字符串"
}}

抽取规则：
- 只抽原文里真实存在的内容，禁止脑补承诺或日期
- 「我答应了什么」以导师视角判断：哪怕原文里没说「我答应」，只要导师提出了要求且你没拒绝，都算
- 日期「下周五」「月底前」按今天为 {date.today().isoformat()} 换算成 YYYY-MM-DD"""
    env = await llm.complete_result(prompt, mode="fast", task="advisor-extract", max_tokens=1536)
    if not env["ok"]:
        return {"ok": False, "result": "", "error": env["error"]}
    import json as _json

    content = env["content"].strip()
    # 模型偶尔还是会包 ```json 围栏，剥一层再 parse
    if content.startswith("```"):
        content = content.split("```")[1]
        if content.startswith("json"):
            content = content[4:]
    try:
        data = _json.loads(content)
        if not isinstance(data, dict):
            raise ValueError("not a dict")
    except Exception:
        return {"ok": False, "result": "", "error": {
            "kind": "parse", "label": "抽取结果解析失败",
            "message": "模型没有返回合法 JSON，重试一次通常就好。",
            "hint": content[:200],
        }}
    return {
        "ok": True, "extracted": data, "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }
