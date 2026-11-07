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
    env = await llm.complete_result(prompt, mode="fast", task="unblock", max_tokens=3072)
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


# ============================ AI：诊断 / 提纲 / 准入 ============================


class DiagnoseIn(BaseModel):
    extra: str | None = None  # 用户补充说明（比如「导师催了」「算力没了」）


@router.post("/stages/{stage_id}/diagnose")
async def diagnose_stage(stage_id: int, body: DiagnoseIn | None = None):
    """卡点诊断：先分类（没想清/没数据/没时间/不敢下手），再给对应打法。"""
    stage = row_or_404("paper_stages", stage_id)
    prompt = f"""论文写作卡点诊断。

阶段：{stage['name']}（已停留 {_days_since(stage.get('updated_at'))} 天）
卡点描述：{stage.get('blocker') or '（未填写，请基于阶段名与「下一步动作」推断）'}
原计划下一步：{stage.get('next_action') or '（未填写）'}
{('补充情况：' + body.extra) if body and body.extra else ''}

请输出：
1. 卡点定性：这个卡点本质上是哪一类——「没想清楚」「没数据/没材料」「没时间」「不敢下手（完美主义/畏难）」，给出判断依据；如果是混合型，说明各占多少
2. 定性后的对症打法：每类卡点的解法完全不同（没想清→先写最烂的一版；没数据→先跑最小实验/换公开数据；没时间→砍范围；不敢下手→15 分钟启动法），按你的定性给具体方案
3. 伪装检查：这个卡点是不是在替别的真问题背锅（比如「数据不好」其实是「故事没讲清」）
4. 一个今天就能做的 15 分钟动作

务实、具体、不要鸡汤。"""
    env = await llm.complete_result(prompt, mode="fast", task="stage-diagnose", max_tokens=2560)
    if not env["ok"]:
        return {"ok": False, "result": "", "error": env["error"]}
    return {
        "ok": True, "result": env["content"], "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }


class OutlineIn(BaseModel):
    extra: str | None = None  # 用户补充：目标会议/字数/想强调的点


@router.post("/sections/{sec_id}/outline")
async def section_outline(sec_id: int, body: OutlineIn | None = None):
    """章节提纲生成：基于真实实验数据与流水线进度，不是空对空。"""
    sec = row_or_404("paper_sections", sec_id)
    stages = query("SELECT name, status, blocker, next_action FROM paper_stages ORDER BY sort_order, id")
    exps = query("SELECT name, hypothesis, design, status, conclusion FROM experiments ORDER BY id DESC LIMIT 8")
    stage_lines = [f"- {s['name']}（{s['status']}）卡点：{s['blocker'] or '无'}" for s in stages]
    exp_lines = [
        f"- {e['name']}（{e['status']}）：假设={e.get('hypothesis') or '无'}；已有结论摘要={(e.get('conclusion') or '')[:200]}"
        for e in exps
    ]
    prompt = f"""为论文章节「{sec['name']}」生成写作提纲。

论文流水线进度：
{chr(10).join(stage_lines) or '（未建阶段）'}

已有的实验素材（真实数据，提纲必须围绕它们展开，禁止虚构实验）：
{chr(10).join(exp_lines) or '（暂无实验）'}
{('补充要求：' + body.extra) if body and body.extra else ''}

请输出：
1. 本章的 3-5 个小节（编号 + 小节标题 + 一句话说明该小节承载什么论证任务）
2. 每个小节下列出：①要用上哪些真实实验/数据（点名上面列的）②还没有的数据缺口，标注「待补」
3. 本章第一段的前 2 句话草稿（直接可用的中文，学术语气）
4. 本章与其他章节的边界：哪些内容属于别章，这里一笔带过即可

数据缺口必须显式标注，不许把「待补」的东西写成已有结论。"""
    env = await llm.complete_result(prompt, mode="fast", task="section-outline", max_tokens=3072)
    if not env["ok"]:
        return {"ok": False, "result": "", "error": env["error"]}
    return {
        "ok": True, "result": env["content"], "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }


@router.get("/readiness")
def readiness():
    """阶段准入检查：数据驱动的规则检查（不花钱），AI 部分由前端按需触发。"""
    stages = [_with_days(r) for r in query("SELECT * FROM paper_stages ORDER BY sort_order, id")]
    sections = query("SELECT * FROM paper_sections ORDER BY sort_order, id")
    exps = query("SELECT name, status, conclusion FROM experiments ORDER BY id DESC")
    exp_done = [e for e in exps if e["status"] == "done" and e.get("conclusion")]
    no_conclusion = [e["name"] for e in exps if e["status"] == "done" and not e.get("conclusion")]
    empty_sections = [s["name"] for s in sections if (s["word_count"] or 0) == 0]
    total_words = sum(s["word_count"] or 0 for s in sections)
    target = sum(s["target_words"] or 0 for s in sections)
    checks = [
        {"key": "stages", "ok": len(stages) > 0,
         "label": "流水线已建阶段" if stages else "还没有建论文阶段"},
        {"key": "no_blocked", "ok": not any(s["status"] == "blocked" for s in stages),
         "label": "无阻塞阶段" if not any(s["status"] == "blocked" for s in stages)
         else f"{sum(1 for s in stages if s['status'] == 'blocked')} 个阶段阻塞中"},
        {"key": "exp_conclusion", "ok": not no_conclusion,
         "label": "已完成实验都有结论" if not no_conclusion
         else f"{len(no_conclusion)} 个完成实验还没写 AI 结论：{'、'.join(no_conclusion[:3])}"},
        {"key": "exp_evidence", "ok": len(exp_done) >= 1,
         "label": f"有 {len(exp_done)} 个带结论的实验可作 Results 素材"
         if exp_done else "还没有任何「已完成+有结论」的实验"},
        {"key": "sections", "ok": not empty_sections,
         "label": "所有章节都动笔了" if not empty_sections
         else f"这些章节还是 0 字：{'、'.join(empty_sections[:4])}"},
        {"key": "words", "ok": target == 0 or total_words / target >= 0.3,
         "label": f"字数进度 {total_words}/{target}"
         if target else "章节没设目标字数，进度条不可用"},
    ]
    passed = sum(1 for c in checks if c["ok"])
    return {"checks": checks, "passed": passed, "total": len(checks)}


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
