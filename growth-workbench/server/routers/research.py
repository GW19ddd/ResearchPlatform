"""科研一站式流程：创新点 / 文献 / 实验。"""
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import llm
import points_core
from crud import (
    bounded_score,
    delete_row,
    patch_row,
    row_or_404,
)
from db import execute, now, query
from schemas import Score

router = APIRouter(prefix="/api", tags=["research"])

# 评分字段统一 1-5：创建由 pydantic 拦（422），局部更新由校验器拦（400）
SCORE_VALIDATORS = {k: bounded_score(1, 5, 3, k) for k in ("novelty", "feasibility", "impact", "effort")}
RATING_VALIDATOR = {"rating": bounded_score(1, 5, 3, "rating")}


class IdsIn(BaseModel):
    """批量操作的 id 列表（前端多选后一次提交）。"""

    ids: list[int] = []


def _delete_where(table: str, col: str, ids: list[int]) -> int:
    """按 id 集合批量删。占位符按个数生成，值一律走参数绑定，不拼字符串。"""
    ids = [int(i) for i in ids if i is not None]
    if not ids:
        return 0
    ph = ",".join("?" * len(ids))
    execute(f"DELETE FROM {table} WHERE {col} IN ({ph})", tuple(ids))
    return len(ids)


# ============================ 创新点 ============================


class IdeaIn(BaseModel):
    title: str
    one_liner: str | None = None
    direction: str | None = None
    novelty: Score = 3
    feasibility: Score = 3
    impact: Score = 3
    effort: Score = 3
    status: str = "captured"
    category: str | None = None
    notes: str | None = None


@router.get("/ideas")
def list_ideas(status: str | None = None, category: str | None = None):
    if status and category:
        return query(
            "SELECT * FROM ideas WHERE status=? AND category=? ORDER BY id DESC", (status, category)
        )
    if status:
        return query("SELECT * FROM ideas WHERE status=? ORDER BY id DESC", (status,))
    if category:
        return query("SELECT * FROM ideas WHERE category=? ORDER BY id DESC", (category,))
    return query("SELECT * FROM ideas ORDER BY id DESC")


@router.get("/ideas/categories")
def idea_categories():
    """创新点按分类分组统计（分类是用户自建的，用来分方向管理想法）。"""
    rows = query("SELECT id, category, status, novelty, feasibility, impact FROM ideas")
    buckets: dict[str, dict] = {}
    for r in rows:
        key = (r.get("category") or "").strip() or "未分类"
        b = buckets.setdefault(
            key, {"name": key, "count": 0, "selected": 0, "avg_score": 0.0, "_sum": 0}
        )
        b["count"] += 1
        b["_sum"] += (r.get("novelty") or 0) + (r.get("feasibility") or 0) + (r.get("impact") or 0)
        if r.get("status") == "selected":
            b["selected"] += 1
    out = []
    for b in buckets.values():
        b["avg_score"] = round(b.pop("_sum") / (3 * b["count"]), 2) if b["count"] else 0
        out.append(b)
    out.sort(key=lambda x: (-x["count"], x["name"]))
    return {"groups": out}


@router.post("/ideas")
def create_idea(body: IdeaIn):
    ts = now()
    iid = execute(
        """INSERT INTO ideas (title, one_liner, direction, novelty, feasibility,
           impact, effort, status, category, notes, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            body.title,
            body.one_liner,
            body.direction,
            body.novelty,
            body.feasibility,
            body.impact,
            body.effort,
            body.status,
            body.category or None,
            body.notes,
            ts,
            ts,
        ),
    )
    return row_or_404("ideas", iid)


_IDEA_FIELDS = {
    "title",
    "one_liner",
    "direction",
    "novelty",
    "feasibility",
    "impact",
    "effort",
    "status",
    "category",
    "notes",
}


@router.patch("/ideas/{idea_id}")
def update_idea(idea_id: int, body: dict):
    before, after = patch_row("ideas", idea_id, body, _IDEA_FIELDS, SCORE_VALIDATORS)
    points_core.earn_on_transition(
        before, after, "status", "validated", "idea_validated",
        f"创新点验证通过：{after['title']}", "idea", idea_id,
    )
    return after


@router.delete("/ideas/{idea_id}")
def delete_idea(idea_id: int):
    row_or_404("ideas", idea_id)
    execute("DELETE FROM idea_reviews WHERE idea_id=?", (idea_id,))
    return delete_row("ideas", idea_id)


@router.post("/ideas/bulk-delete")
def bulk_delete_ideas(body: IdsIn):
    """批量删创新点：连带的质疑记录一起清掉，不存在的 id 直接跳过。"""
    ids = [int(i) for i in body.ids if i is not None]
    if not ids:
        return {"deleted": 0}
    _delete_where("idea_reviews", "idea_id", ids)
    _delete_where("ideas", "id", ids)
    return {"deleted": len(ids)}


class BrainstormIn(BaseModel):
    direction: str
    context: str | None = None
    count: int = 5
    categories: list[str] = []


@router.post("/ideas/brainstorm")
async def brainstorm(body: BrainstormIn):
    existing = [c.strip() for c in (body.categories or []) if c.strip()]
    cat_hint = (
        "已有分类（优先从里面挑一个，实在都不合适才新造，新分类控制在 4-6 字）："
        + "、".join(existing)
        if existing
        else "给每个创新点一个 4-6 字的分类名，同一类的用同一个名字，分类总数不要超过 3 个。"
    )
    prompt = f"""研究方向：{body.direction}

已有背景/现状：{body.context or "（未提供）"}

{cat_hint}

请产出 {body.count} 个候选创新点。严格输出一个 JSON 数组，每个元素包含字段：
- "title": 短标题（12 字以内）
- "one_liner": 一句话主张（必须具体到可验证，禁止"提升性能"这类空话）
- "defect": 解决了现有方法的什么具体缺陷
- "mve": 最小可行验证路径（做什么实验、看什么指标就能证伪）
- "novelty"/"feasibility"/"impact"/"effort": 新颖性/可行性/影响力/工作量，1-5 整数，effort 越大越费劲
- "category": 分类名（见上面的分类要求）
- "risk": 最可能失败的地方

只输出 JSON 数组本身，不要任何解释、围栏或多余文字。"""
    data, env = await llm.complete_json_result(
        prompt, mode="reason", task="brainstorm", max_tokens=4096
    )

    def _score(v, default=3):
        try:
            return max(1, min(5, int(v)))
        except (TypeError, ValueError):
            return default

    candidates = []
    if isinstance(data, list):
        for x in data:
            if not isinstance(x, dict) or not str(x.get("title") or "").strip():
                continue
            candidates.append(
                {
                    "title": str(x.get("title")).strip()[:80],
                    "one_liner": str(x.get("one_liner") or ""),
                    "defect": str(x.get("defect") or ""),
                    "mve": str(x.get("mve") or ""),
                    "risk": str(x.get("risk") or ""),
                    "novelty": _score(x.get("novelty")),
                    "feasibility": _score(x.get("feasibility")),
                    "impact": _score(x.get("impact")),
                    "effort": _score(x.get("effort")),
                    "category": str(x.get("category") or "").strip()[:20],
                }
            )

    if candidates:
        return {
            "ok": True,
            "candidates": candidates,
            "result": "",
            "error": None,
            "source": "json",
            "provider": env["provider"],
            "model": env["model"],
            "tokens_in": env["tokens_in"],
            "tokens_out": env["tokens_out"],
        }

    # JSON 解析失败 → 退回 Markdown 模式，至少给可用文本。
    # 这一步也是一次真实调用：失败必须如实返回，绝不能把错误文案伪装成候选创新点。
    md_prompt = f"""研究方向：{body.direction}

已有背景/现状：{body.context or "（未提供）"}

请产出 {body.count} 个候选创新点。每个创新点给出：
1. 一句话主张（必须具体到可验证）
2. 它解决了现有方法的什么具体缺陷
3. 最小可行验证路径（MVE）
4. 新颖性 / 可行性 / 预期影响力 各 1-5 分
5. 最可能失败的地方

用 Markdown 分条输出，不要客套。"""
    md_env = await llm.complete_result(
        md_prompt, mode="reason", task="brainstorm", max_tokens=4096
    )
    if not md_env["ok"]:
        return {"ok": False, "candidates": [], "result": "", "error": md_env["error"],
                "source": "markdown", "provider": md_env["provider"], "model": md_env["model"]}
    return {
        "ok": True,
        "candidates": [],
        "result": md_env["content"],
        "error": None,
        "source": "markdown",
        "provider": md_env["provider"],
        "model": md_env["model"],
        "tokens_in": md_env["tokens_in"],
        "tokens_out": md_env["tokens_out"],
    }


class ReviewIn(BaseModel):
    role: str = "reviewer"


@router.post("/ideas/{idea_id}/review")
async def review_idea(idea_id: int, body: ReviewIn):
    idea = row_or_404("ideas", idea_id)
    role_desc = {
        "reviewer": "一位挑剔的顶会审稿人（Reviewer #2）",
        "mentor": "一位务实、时间有限、关心能否毕业的导师",
        "rival": "一位做同方向竞争的同行，想抢先发表",
    }.get(body.role, "一位挑剔的审稿人")
    prompt = f"""你现在是{role_desc}。

下面这个创新点请你狠狠质疑：
- 标题：{idea['title']}
- 一句话主张：{idea.get('one_liner') or '（无）'}
- 方向：{idea.get('direction') or '（无）'}
- 自评：新颖性 {idea['novelty']}/5，可行性 {idea['feasibility']}/5，影响力 {idea['impact']}/5，工作量 {idea['effort']}/5
- 备注：{idea.get('notes') or '（无）'}

输出三部分：
1. 致命问题（最可能被拒稿/做不出来的 3 条，写清楚为什么）
2. 与已有工作最可能的撞车点，该去查什么关键词验证
3. 补救建议：最小改动怎么让它站得住"""
    env = await llm.complete_result(prompt, mode="reason", task="idea-review", max_tokens=3072)
    if not env["ok"]:
        # 失败就如实返回：不写 idea_reviews，避免错误文案被当成历史质疑意见
        return {"ok": False, "result": "", "saved": False, "error": env["error"]}
    execute(
        "INSERT INTO idea_reviews (idea_id, role, content, created_at) VALUES (?,?,?,?)",
        (idea_id, body.role, env["content"], now()),
    )
    return {
        "ok": True,
        "result": env["content"],
        "saved": True,
        "reviews": list_reviews(idea_id),
        "provider": env["provider"],
        "model": env["model"],
        "tokens_in": env["tokens_in"],
        "tokens_out": env["tokens_out"],
    }


@router.get("/ideas/{idea_id}/reviews")
def list_reviews(idea_id: int):
    return query(
        "SELECT * FROM idea_reviews WHERE idea_id=? ORDER BY id DESC", (idea_id,)
    )


# ============================ 文献 ============================


class LitIn(BaseModel):
    title: str
    authors: str | None = None
    year: int | None = None
    venue: str | None = None
    url: str | None = None
    status: str = "todo"
    rating: Score = 3
    relevance: str | None = None
    notes: str | None = None
    tags: str | None = None
    idea_id: int | None = None


_LIT_SQL = """
SELECT l.*, (SELECT COUNT(*) FROM lit_notes n WHERE n.literature_id = l.id) AS note_count
FROM literature l
"""


@router.get("/literature")
def list_literature(status: str | None = None):
    if status:
        return query(
            _LIT_SQL + "WHERE l.status=? ORDER BY l.id DESC", (status,)
        )
    return query(_LIT_SQL + "ORDER BY l.id DESC")


@router.post("/literature")
def create_literature(body: LitIn):
    ts = now()
    lid = execute(
        """INSERT INTO literature (title, authors, year, venue, url, status, rating,
           relevance, notes, tags, idea_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            body.title,
            body.authors,
            body.year,
            body.venue,
            body.url,
            body.status,
            body.rating,
            body.relevance,
            body.notes,
            body.tags,
            body.idea_id,
            ts,
            ts,
        ),
    )
    return row_or_404("literature", lid)


_LIT_FIELDS = {
    "title",
    "authors",
    "year",
    "venue",
    "url",
    "status",
    "rating",
    "relevance",
    "notes",
    "tags",
    "idea_id",
    "pdf_path",
    "gloss_id",
}


@router.patch("/literature/{lit_id}")
def update_literature(lit_id: int, body: dict):
    before, after = patch_row("literature", lit_id, body, _LIT_FIELDS, RATING_VALIDATOR)
    points_core.earn_on_transition(
        before, after, "status", "done", "paper_read_done",
        f"读完文献：{after['title']}", "literature", lit_id,
    )
    return after


@router.delete("/literature/{lit_id}")
def delete_literature(lit_id: int):
    row_or_404("literature", lit_id)
    execute("DELETE FROM lit_matrix WHERE literature_id=?", (lit_id,))
    execute("DELETE FROM lit_notes WHERE literature_id=?", (lit_id,))
    execute("DELETE FROM literature WHERE id=?", (lit_id,))
    return {"ok": True}


@router.post("/literature/bulk-delete")
def bulk_delete_literature(body: IdsIn):
    """批量删文献：连带清掉它的笔记与对比矩阵单元格。"""
    ids = [int(i) for i in body.ids if i is not None]
    if not ids:
        return {"deleted": 0}
    _delete_where("lit_matrix", "literature_id", ids)
    _delete_where("lit_notes", "literature_id", ids)
    _delete_where("literature", "id", ids)
    return {"deleted": len(ids)}


class KeywordsIn(BaseModel):
    topic: str
    constraints: str | None = None


@router.post("/literature/keywords")
async def gen_keywords(body: KeywordsIn):
    prompt = f"""研究主题：{body.topic}
限定条件：{body.constraints or '（无）'}

请给出一套可直接拿去检索的文献检索方案：
1. 3 组英文检索式（含布尔运算符与引号，可直接粘到 Google Scholar / IEEE Xplore / arXiv）
2. 5 个必追的关键词 / 术语（含常见同义写法与缩写）
3. 3-5 位最可能相关的作者或课题组（说明判断依据，不要杜撰具体人名，可给方向性描述）
4. 2-3 个应重点扫的会议/期刊
5. 一条"反向检索"建议：从哪篇综述的引用链倒推"""
    env = await llm.complete_result(prompt, mode="fast", task="lit-keywords", max_tokens=2048)
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


# 阅读笔记的固定小节：分段存、分段看，避免一次糊成一大段
NOTE_SECTIONS = [
    "一句话贡献",
    "方法核心",
    "实验与结果",
    "局限与缺口",
    "与我的研究的关系",
    "值得追的引用",
]

_JSON_HINT = """严格输出一个 JSON 对象（不要围栏、不要解释）：
{"sections":[{"title":"小节名","content":"正文（Markdown，150 字以内，写不出来就写“标题信息不足，需读原文确认”）"}]}"""


def _save_sections(lit_id: int, sections: list[dict], source: str = "ai"):
    """按小节名 upsert：同名小节覆盖，新小节追加到末尾。"""
    ts = now()
    saved = []
    for i, s in enumerate(sections):
        title = str(s.get("title") or "").strip()
        content = str(s.get("content") or "").strip()
        if not title or not content:
            continue
        rows = query(
            "SELECT id FROM lit_notes WHERE literature_id=? AND section=?", (lit_id, title)
        )
        if rows:
            execute(
                "UPDATE lit_notes SET content=?, source=?, updated_at=? WHERE id=?",
                (content, source, ts, rows[0]["id"]),
            )
            saved.append(rows[0]["id"])
        else:
            nid = execute(
                """INSERT INTO lit_notes (literature_id, section, content, sort_order,
                   source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)""",
                (lit_id, title, content, i, source, ts, ts),
            )
            saved.append(nid)
    return saved


class DigestIn(BaseModel):
    section: str | None = None  # 只重新生成某一节
    focus: str | None = None  # 附加要求，例：重点看它怎么用 LLM 修 OpenFOAM 报错


@router.post("/literature/{lit_id}/digest")
async def digest(lit_id: int, body: DigestIn | None = None):
    """生成结构化阅读笔记：每一小节单独存一条，前端分段展示、可单独重生成。"""
    lit = row_or_404("literature", lit_id)
    want = (body.section if body else None) or ""
    sections_to_ask = [s for s in NOTE_SECTIONS if s == want] if want else list(NOTE_SECTIONS)

    header = f"""请为下面这篇文献生成阅读笔记：

标题：{lit['title']}
作者：{lit.get('authors') or '（未填）'}
年份：{lit.get('year') or '（未填）'}
发表处：{lit.get('venue') or '（未填）'}
已有备注：{lit.get('notes') or '（无）'}
{f"额外要求：{body.focus}" if body and body.focus else ""}

需要输出的小节（title 必须原样使用）：{('、'.join(sections_to_ask))}
每节 150 字以内，只写标题能支撑的内容，信息不足就明说，不要编造具体数字。"""

    data, env = await llm.complete_json_result(
        header + "\n\n" + _JSON_HINT, mode="fast", task="lit-digest", max_tokens=3072
    )
    sections: list[dict] = []
    if isinstance(data, dict) and isinstance(data.get("sections"), list):
        for x in data["sections"]:
            if isinstance(x, dict) and str(x.get("content") or "").strip():
                sections.append(
                    {
                        "title": str(x.get("title") or "笔记").strip()[:40],
                        "content": str(x.get("content")).strip(),
                    }
                )

    # 两种取巧都拿不到结构化结果时才退回纯文本：Markdown 按二级标题切一刀。
    # 只要 env 是失败态就立刻返回 —— 不要把「调用失败」写进阅读笔记。
    if not sections:
        if not env["ok"]:
            return {"ok": False, "sections": [], "notes": list_notes(lit_id), "error": env["error"]}
        text = await llm.complete_result(
            header + "\n\n用 Markdown 分小节输出，每节用 ## 开头。",
            mode="fast",
            task="lit-digest",
            max_tokens=3072,
        )
        if not text["ok"]:
            return {"ok": False, "sections": [], "notes": list_notes(lit_id), "error": text["error"]}
        sections = _split_markdown(text["content"])

    _save_sections(lit_id, sections)
    return {
        "ok": True,
        "sections": sections,
        "notes": list_notes(lit_id),
        "error": None,
        "provider": env["provider"],
        "model": env["model"],
    }


def _split_markdown(text: str) -> list[dict]:
    """把「## 小节」格式的文本拆成 sections，拆不动就整段兜底。"""
    out: list[dict] = []
    cur: dict | None = None
    for line in str(text or "").splitlines():
        if line.lstrip().startswith("## "):
            if cur:
                out.append(cur)
            cur = {"title": line.lstrip()[3:].strip()[:40], "content": ""}
        elif cur is not None:
            cur["content"] = (cur["content"] + "\n" + line).strip()
    if cur:
        out.append(cur)
    if not out and text.strip():
        out = [{"title": "阅读笔记", "content": text.strip()}]
    return out


@router.get("/literature/{lit_id}/notes")
def list_notes(lit_id: int):
    return query(
        "SELECT * FROM lit_notes WHERE literature_id=? ORDER BY sort_order, id", (lit_id,)
    )


class NoteIn(BaseModel):
    section: str
    content: str = ""


@router.post("/literature/{lit_id}/notes")
def add_note(lit_id: int, body: NoteIn):
    """手动加一节；同名小节视为保存草稿。"""
    _save_sections(lit_id, [{"title": body.section, "content": body.content}], source="me")
    return list_notes(lit_id)


@router.patch("/lit_notes/{note_id}")
def update_note(note_id: int, body: dict):
    sets, vals = [], []
    for k in ("section", "content"):
        if k in body:
            sets.append(f"{k}=?")
            vals.append(body[k])
    if not sets:
        raise HTTPException(400, "no valid field")
    sets.append("updated_at=?")
    vals.append(now())
    vals.append(note_id)
    execute(f"UPDATE lit_notes SET {','.join(sets)} WHERE id=?", vals)
    rows = query("SELECT * FROM lit_notes WHERE id=?", (note_id,))
    return rows[0] if rows else {"ok": True}


@router.delete("/lit_notes/{note_id}")
def delete_note(note_id: int):
    execute("DELETE FROM lit_notes WHERE id=?", (note_id,))
    return {"ok": True}


@router.get("/literature/matrix")
def get_matrix():
    papers = query("SELECT id, title, year, venue FROM literature ORDER BY id")
    rows = query("SELECT * FROM lit_matrix ORDER BY sort_order, id")
    dims: list[str] = []
    for r in rows:
        if r["dim_name"] not in dims:
            dims.append(r["dim_name"])
    cells: dict[tuple[int, str], str] = {}
    for r in rows:
        cells[(r["literature_id"], r["dim_name"])] = r["dim_value"]
    return {
        "dimensions": dims,
        "papers": [
            {
                "id": p["id"],
                "title": p["title"],
                "year": p["year"],
                "venue": p["venue"],
                "cells": {d: cells.get((p["id"], d), "") for d in dims},
            }
            for p in papers
        ],
    }


class MatrixCellIn(BaseModel):
    literature_id: int
    dim_name: str
    dim_value: str


@router.post("/literature/matrix")
def set_matrix_cell(body: MatrixCellIn):
    rows = query(
        "SELECT id FROM lit_matrix WHERE literature_id=? AND dim_name=?",
        (body.literature_id, body.dim_name),
    )
    if rows:
        execute(
            "UPDATE lit_matrix SET dim_value=? WHERE id=?",
            (body.dim_value, rows[0]["id"]),
        )
        return {"ok": True, "id": rows[0]["id"]}
    iid = execute(
        "INSERT INTO lit_matrix (literature_id, dim_name, dim_value, sort_order) VALUES (?,?,?,?)",
        (body.literature_id, body.dim_name, body.dim_value, 0),
    )
    return {"ok": True, "id": iid}


class MatrixDimIn(BaseModel):
    dim_name: str


def _require_dim_name(v: object) -> str:
    s = str(v or "").strip()
    if not s:
        raise HTTPException(400, "维度名不能为空")
    return s[:40]


@router.post("/literature/matrix/dimension")
def add_dimension(body: MatrixDimIn):
    name = _require_dim_name(body.dim_name)
    for p in query("SELECT id FROM literature"):
        rows = query(
            "SELECT id FROM lit_matrix WHERE literature_id=? AND dim_name=?",
            (p["id"], name),
        )
        if not rows:
            execute(
                "INSERT INTO lit_matrix (literature_id, dim_name, dim_value, sort_order) VALUES (?,?,?,?)",
                (p["id"], name, "", 0),
            )
    return {"ok": True}


@router.delete("/literature/matrix/dimension/{dim_name}")
def delete_dimension(dim_name: str):
    execute("DELETE FROM lit_matrix WHERE dim_name=?", (dim_name,))
    return {"ok": True}


# ============================ 实验 ============================


class ExpIn(BaseModel):
    name: str
    hypothesis: str | None = None
    design: str | None = None
    status: str = "planned"
    idea_id: int | None = None
    config_json: str | None = None
    conclusion: str | None = None


@router.get("/experiments")
def list_experiments():
    return query("SELECT * FROM experiments ORDER BY id DESC")


@router.post("/experiments")
def create_experiment(body: ExpIn):
    ts = now()
    eid = execute(
        """INSERT INTO experiments (name, hypothesis, design, status, idea_id,
           config_json, conclusion, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            body.name,
            body.hypothesis,
            body.design,
            body.status,
            body.idea_id,
            body.config_json,
            body.conclusion,
            ts,
            ts,
        ),
    )
    return row_or_404("experiments", eid)


_EXP_FIELDS = {"name", "hypothesis", "design", "status", "idea_id", "config_json", "conclusion"}


@router.patch("/experiments/{exp_id}")
def update_experiment(exp_id: int, body: dict):
    before, after = patch_row("experiments", exp_id, body, _EXP_FIELDS)
    points_core.earn_on_transition(
        before, after, "status", "done", "experiment_done",
        f"实验完成：{after['name']}", "experiment", exp_id,
    )
    return after


@router.delete("/experiments/{exp_id}")
def delete_experiment(exp_id: int):
    row_or_404("experiments", exp_id)
    execute("DELETE FROM exp_results WHERE experiment_id=?", (exp_id,))
    execute("DELETE FROM experiments WHERE id=?", (exp_id,))
    return {"ok": True}


@router.post("/experiments/bulk-delete")
def bulk_delete_experiments(body: IdsIn):
    """批量删实验：连带清掉下面的结果记录。"""
    ids = [int(i) for i in body.ids if i is not None]
    if not ids:
        return {"deleted": 0}
    _delete_where("exp_results", "experiment_id", ids)
    _delete_where("experiments", "id", ids)
    return {"deleted": len(ids)}


class ResultIn(BaseModel):
    case_name: str
    method: str | None = None
    success: int = 0
    metrics_json: str | None = None
    notes: str | None = None


@router.get("/experiments/{exp_id}/results")
def list_results(exp_id: int):
    rows = query("SELECT * FROM exp_results WHERE experiment_id=? ORDER BY id", (exp_id,))
    for r in rows:
        try:
            r["metrics"] = json.loads(r["metrics_json"] or "{}")
        except Exception:
            r["metrics"] = {}
    return rows


@router.post("/experiments/{exp_id}/results")
def add_result(exp_id: int, body: ResultIn):
    rid = execute(
        """INSERT INTO exp_results (experiment_id, case_name, method, success,
           metrics_json, notes, created_at) VALUES (?,?,?,?,?,?,?)""",
        (
            exp_id,
            body.case_name,
            body.method,
            body.success,
            body.metrics_json,
            body.notes,
            now(),
        ),
    )
    return {"ok": True, "id": rid}


@router.delete("/results/{result_id}")
def delete_result(result_id: int):
    execute("DELETE FROM exp_results WHERE id=?", (result_id,))
    return {"ok": True}


@router.post("/experiments/{exp_id}/analysis")
async def analyze_experiment(exp_id: int):
    exp = row_or_404("experiments", exp_id)
    results = query("SELECT * FROM exp_results WHERE experiment_id=?", (exp_id,))
    lines = [
        f"- {r['case_name']} | 方法={r['method'] or '-'} | 成功={bool(r['success'])} | "
        f"指标={r['metrics_json'] or '{}'} | 备注={r['notes'] or '-'}"
        for r in results
    ]
    prompt = f"""实验名称：{exp['name']}
假设：{exp.get('hypothesis') or '（无）'}
设计：{exp.get('design') or '（无）'}

结果明细（{len(results)} 条）：
{chr(10).join(lines) if lines else "（暂无结果）"}

请输出：
1. 假设是否成立，依据是什么（只对上面数据负责，不要外推）
2. 失败样本的共同特征与可能根因（分条，按可能性排序）
3. 结果汇总表（Markdown 表格）
4. 下一步该补的最小实验（具体、可在 1-2 天内做完）
5. 这段结果可以直接写进论文 Results 的 2-3 句话"""
    env = await llm.complete_result(prompt, mode="reason", task="exp-analysis", max_tokens=3072)
    if not env["ok"]:
        # 失败不写 experiments.conclusion —— 结论是科研成果，不是错误日志的垃圾桶
        return {"ok": False, "result": "", "saved": False, "error": env["error"]}
    execute(
        "UPDATE experiments SET conclusion=?, updated_at=? WHERE id=?",
        (env["content"], now(), exp_id),
    )
    return {
        "ok": True,
        "result": env["content"],
        "saved": True,
        "provider": env["provider"],
        "model": env["model"],
        "tokens_in": env["tokens_in"],
        "tokens_out": env["tokens_out"],
    }
