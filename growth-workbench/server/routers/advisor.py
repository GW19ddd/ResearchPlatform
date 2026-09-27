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
- 中文，语气自然，像博士生对导师说话，不像公文"""
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
