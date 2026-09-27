"""论文流水线：阶段 + 章节 + 阻塞告警 + AI 解锁建议。"""
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import llm
import points_core
from crud import delete_row, non_negative, patch_row, row_or_404
from db import execute, now, query

router = APIRouter(prefix="/api/paper", tags=["paper"])

# 阶段推进顺序：用于判断「是不是往前走了一步」。自定义状态不在里面就不加分，也不能让接口 500
STAGE_ORDER = ["todo", "doing", "blocked", "done"]


def _days_since(ts: str | None) -> int:
    if not ts:
        return 0
    try:
        d = datetime.fromisoformat(ts)
    except ValueError:
        return 0
    return (datetime.now() - d).days


def _with_days(row: dict) -> dict:
    row = dict(row)
    row["stuck_days"] = _days_since(row.get("updated_at")) if row.get("status") == "blocked" else 0
    return row


# ============================ 阶段 ============================


class StageIn(BaseModel):
    name: str
    sort_order: int = 0
    status: str = "todo"
    blocker: str | None = None
    next_action: str | None = None


@router.get("/stages")
def list_stages():
    return [_with_days(r) for r in query("SELECT * FROM paper_stages ORDER BY sort_order, id")]


@router.post("/stages")
def create_stage(body: StageIn):
    sid = execute(
        """INSERT INTO paper_stages (name, sort_order, status, blocker, next_action, updated_at)
           VALUES (?,?,?,?,?,?)""",
        (body.name, body.sort_order, body.status, body.blocker, body.next_action, now()),
    )
    return _with_days(row_or_404("paper_stages", sid))


_STAGE_FIELDS = {"name", "sort_order", "status", "blocker", "next_action"}


@router.patch("/stages/{stage_id}")
def update_stage(stage_id: int, body: dict):
    before, after = patch_row("paper_stages", stage_id, body, _STAGE_FIELDS)
    # 自定义状态（不在 STAGE_ORDER 里）不分推进分，也不能让 .index 抛 ValueError 打成 500
    if body.get("status") in STAGE_ORDER and before.get("status") in STAGE_ORDER:
        if STAGE_ORDER.index(body["status"]) > STAGE_ORDER.index(before["status"]):
            points_core.earn(
                "paper_stage_advance", f"论文阶段推进：{after['name']}", "paper_stage", stage_id
            )
    return _with_days(after)


@router.delete("/stages/{stage_id}")
def delete_stage(stage_id: int):
    return delete_row("paper_stages", stage_id)


@router.post("/stages/{stage_id}/unblock")
async def unblock(stage_id: int):
    stage = row_or_404("paper_stages", stage_id)
    prompt = f"""论文当前卡在这个阶段：

阶段：{stage['name']}
卡点描述：{stage.get('blocker') or '（未填写）'}
原计划的下一步：{stage.get('next_action') or '（未填写）'}
已卡住 {_days_since(stage.get('updated_at'))} 天

请给出解锁方案：
1. 先把卡点拆开：它到底是「没想清楚」「没数据」「没时间」还是「不敢下手」？给出判断依据
2. 给出 3 条具体出路，每条标注耗时（小时）与风险
3. 推荐一条，并写出今天下午就能开始的第一个动作（颗粒度到"打开什么、做什么、产出什么"）
4. 如果这个阶段其实可以绕过或降级完成，说明怎么绕过"""
    env = await llm.complete_result(prompt, mode="reason", task="unblock", max_tokens=3072)
    if not env["ok"]:
        return {"ok": False, "result": "", "error": env["error"]}
    return {
        "ok": True,
        "result": env["content"],
        "error": None,
        "provider": env["provider"],
        "model": env["model"],
        "tokens_in": env["tokens_in"],
        "tokens_out": env["tokens_out"],
    }


# ============================ 章节 ============================


class SectionIn(BaseModel):
    name: str
    sort_order: int = 0
    target_words: int = 0
    status: str = "todo"


@router.get("/sections")
def list_sections():
    return query("SELECT * FROM paper_sections ORDER BY sort_order, id")


@router.post("/sections")
def create_section(body: SectionIn):
    sid = execute(
        """INSERT INTO paper_sections (name, sort_order, word_count, target_words, status, updated_at)
           VALUES (?,?,0,?,?,?)""",
        (body.name, body.sort_order, body.target_words, body.status, now()),
    )
    return row_or_404("paper_sections", sid)


_SECTION_FIELDS = {"name", "sort_order", "word_count", "target_words", "status"}
# 字数不可能为负；前端偶尔会算差值时溢出成负数，落库前归零
_SECTION_VALIDATORS = {
    "word_count": non_negative(0),
    "target_words": non_negative(0),
}


@router.patch("/sections/{sec_id}")
def update_section(sec_id: int, body: dict):
    _, after = patch_row("paper_sections", sec_id, body, _SECTION_FIELDS, _SECTION_VALIDATORS)
    return after


@router.delete("/sections/{sec_id}")
def delete_section(sec_id: int):
    return delete_row("paper_sections", sec_id)


# ============================ 总览 ============================


@router.get("/overview")
def overview():
    stages = [_with_days(r) for r in query("SELECT * FROM paper_stages ORDER BY sort_order, id")]
    sections = query("SELECT * FROM paper_sections ORDER BY sort_order, id")
    done = [s for s in stages if s["status"] == "done"]
    blocked = [s for s in stages if s["status"] == "blocked"]
    current = next((s for s in stages if s["status"] == "blocked"), None) or next(
        (s for s in stages if s["status"] == "doing"), None
    )
    words = sum(s["word_count"] or 0 for s in sections)
    target = sum(s["target_words"] or 0 for s in sections)
    return {
        "current": current,
        "blocked": blocked,
        "progress": round(len(done) / len(stages) * 100) if stages else 0,
        "stages": stages,
        "words": words,
        "target_words": target,
        "word_progress": round(words / target * 100) if target else 0,
    }
