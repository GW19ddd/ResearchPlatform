"""科研一站式流程：创新点 / 文献 / 实验。"""
import hashlib
import json
import os
from pathlib import Path

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
        prompt, mode="fast", task="brainstorm", max_tokens=4096
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
        md_prompt, mode="fast", task="brainstorm", max_tokens=4096
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
    env = await llm.complete_result(prompt, mode="fast", task="idea-review", max_tokens=3072)
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


@router.post("/ideas/{idea_id}/to-experiment")
async def idea_to_experiment(idea_id: int):
    """创新点 → 实验假设（fast 模式）：LLM 从创新点起草可证伪假设与实验设计，落库并回填 idea_id。"""
    idea = row_or_404("ideas", idea_id)
    scores = (
        f"新颖 {idea.get('novelty') or 3} / 可行 {idea.get('feasibility') or 3} / "
        f"影响 {idea.get('impact') or 3} / 工作量 {idea.get('effort') or 3}"
    )
    prompt = f"""你是一名严谨的方法论研究者。下面是一个候选创新点，请把它转成一个可证伪、可执行的实验方案。

创新点标题：{idea.get('title') or ''}
一句话主张：{idea.get('one_liner') or '（无）'}
方向：{idea.get('direction') or '（无）'}
分类：{idea.get('category') or '（无）'}
评分：{scores}
备注（缺陷 / 验证路径 / 风险）：{idea.get('notes') or '（无）'}

严格输出一个 JSON 对象（不要 markdown 包裹）：
{{"name": "实验短名（<=20 字，体现被测方法 + 核心变量）",
  "hypothesis": "可证伪假设（一句话：如果做了 X，则在 Y 上显著优于/不同于 Z，因为…）",
  "design": "实验设计要点（3-6 条：数据集 / 基线 / 变量控制 / 评价指标 / 所需算力或工具，具体到可落地）"}}

硬规则：
1. 假设必须可证伪、可量化，禁止「提升效果」这类空话
2. design 必须具体到能在 1-2 周内跑通，禁止泛泛而谈
3. 只用创新点里真实给出的信息，不编造数据或结论
4. 只输出 JSON 对象本身"""
    data, env = await llm.complete_json_result(
        prompt, mode="fast", task="idea-to-exp", max_tokens=2048
    )
    if not env["ok"]:
        return {"ok": False, "error": env["error"]}
    if not isinstance(data, dict):
        return {
            "ok": False,
            "error": {"kind": "bad_format", "label": "格式错误", "message": "模型未返回有效 JSON"},
        }
    name = (
        str(data.get("name") or idea.get("title") or f"实验 #{idea_id}").strip()[:80]
        or f"实验 #{idea_id}"
    )
    hypothesis = str(data.get("hypothesis") or "").strip()[:2000] or None
    design = str(data.get("design") or "").strip()[:4000] or None
    eid = execute(
        """INSERT INTO experiments (name, hypothesis, design, status, idea_id,
           config_json, conclusion, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)""",
        (name, hypothesis, design, "planned", idea_id, None, None, now(), now()),
    )
    # 创新点进入「已选定」态（selected 不触发积分，直接 UPDATE；更高状态不回退）
    if idea.get("status") in ("captured", "screening"):
        execute("UPDATE ideas SET status='selected' WHERE id=?", (idea_id,))
    exp = dict(row_or_404("experiments", eid))
    exp["ok"] = True
    exp["provider"] = env["provider"]
    exp["model"] = env["model"]
    exp["tokens_in"] = env["tokens_in"]
    exp["tokens_out"] = env["tokens_out"]
    return exp


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
    doi: str | None = None
    openalex_id: str | None = None
    # 在线检索入库时附带的真实引用边（OpenAlex 短 ID）：
    # cites = 本文引用的馆藏文献；cited_by = 馆藏中引用本文的文献
    cites: list[str] | None = None
    cited_by: list[str] | None = None


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
           relevance, notes, tags, idea_id, doi, openalex_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
            body.doi,
            body.openalex_id,
            ts,
            ts,
        ),
    )
    # 在线检索入库：把快照里与馆藏已有文献的真实引用边落到 lit_edges
    for oa, as_target in ((body.cites, False), (body.cited_by, True)):
        for short_id in (oa or [])[:40]:
            if not short_id or short_id == body.openalex_id:
                continue
            other = query(
                "SELECT id FROM literature WHERE openalex_id=? LIMIT 1", (short_id,)
            )
            if other:
                src, tgt = (other[0]["id"], lid) if as_target else (lid, other[0]["id"])
                _ensure_edge(src, tgt)
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
    "doi",
    "openalex_id",
    "abstract",
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
    execute("DELETE FROM lit_painpoints WHERE literature_id=?", (lit_id,))
    execute("DELETE FROM lit_edges WHERE source_id=? OR target_id=?", (lit_id, lit_id))
    execute("DELETE FROM literature WHERE id=?", (lit_id,))
    return {"ok": True}


@router.post("/literature/bulk-delete")
def bulk_delete_literature(body: IdsIn):
    """批量删文献：连带清掉它的笔记、痛点与对比矩阵单元格。"""
    ids = [int(i) for i in body.ids if i is not None]
    if not ids:
        return {"deleted": 0}
    _delete_where("lit_matrix", "literature_id", ids)
    _delete_where("lit_notes", "literature_id", ids)
    _delete_where("lit_painpoints", "literature_id", ids)
    placeholders = ",".join("?" * len(ids))
    execute(f"DELETE FROM lit_edges WHERE source_id IN ({placeholders}) OR target_id IN ({placeholders})", (*ids, *ids))
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


# ---- 文献痛点（阶段③：文献 → 痛点表 → 备选创新点） ----


class PainpointIn(BaseModel):
    focus: str | None = None  # 用户指定的提炼侧重（如「关注训练效率的局限」）


@router.post("/literature/{lit_id}/painpoints")
async def extract_painpoints(lit_id: int, body: PainpointIn | None = None):
    """AI 从一篇文献提炼「研究机会视角」的痛点，逐条带原文证据；落库 status=new。"""
    lit = row_or_404("literature", lit_id)
    notes = query(
        "SELECT section, content FROM lit_notes WHERE literature_id=? ORDER BY sort_order", (lit_id,)
    )
    note_lines = [f"- [{n['section']}] {(n['content'] or '')[:400]}" for n in notes[:20]]
    abstract = (lit.get("abstract") or "")[:2000]
    focus_line = f"\n用户侧重点：{body.focus.strip()[:200]}" if body and body.focus and body.focus.strip() else ""
    prompt = f"""文献：{lit.get('title') or ''}
摘要/总结：{abstract or '（无）'}

阅读笔记（如有）：
{chr(10).join(note_lines) if note_lines else '（无）'}{focus_line}

请从「研究机会」视角提炼这篇文献描述或暴露的现有方法痛点。只输出 JSON（不要 markdown 包裹）：
{{"items": [
  {{"content": "痛点描述（一句话，具体到方法/场景/问题）", "evidence": "原文证据（引述或转述一句，注明出自哪个部分）", "direction": "可能的突破方向（可选）"}}
]}}

硬规则：
1. 只准提炼摘要/笔记里实际有支撑的痛点，禁止虚构文献没提的局限
2. ≤5 条，按研究价值排序；文献确实没有真实痛点就输出空列表
3. 痛点要具体到「可辨识」层级，禁止「泛化性差」这类空话"""
    data, env = await llm.complete_json_result(prompt, mode="fast", task="lit-painpoints", max_tokens=2048)
    if not env["ok"]:
        return {"ok": False, "items": [], "error": env["error"]}
    saved = []
    raw_items = data.get("items") if isinstance(data, dict) else None
    for it in (raw_items or [])[:5]:
        if not isinstance(it, dict):
            continue
        content = str(it.get("content") or "").strip()[:300]
        if not content:
            continue
        pid = execute(
            "INSERT INTO lit_painpoints (literature_id, content, evidence, direction, status, created_at) VALUES (?,?,?,?,?,?)",
            (
                lit_id,
                content,
                str(it.get("evidence") or "").strip()[:300] or None,
                str(it.get("direction") or "").strip()[:200] or None,
                "new",
                now(),
            ),
        )
        saved.append({"id": pid, "content": content})
    return {
        "ok": True, "items": saved, "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }


@router.get("/painpoints")
def list_painpoints(status: str | None = None):
    if status:
        return query(
            """SELECT p.*, l.title AS lit_title FROM lit_painpoints p
               LEFT JOIN literature l ON l.id=p.literature_id
               WHERE p.status=? ORDER BY p.id DESC""",
            (status,),
        )
    return query(
        """SELECT p.*, l.title AS lit_title FROM lit_painpoints p
           LEFT JOIN literature l ON l.id=p.literature_id
           ORDER BY p.id DESC"""
    )


@router.delete("/painpoints/{pp_id}")
def delete_painpoint(pp_id: int):
    row_or_404("lit_painpoints", pp_id)
    execute("DELETE FROM lit_painpoints WHERE id=?", (pp_id,))
    return {"ok": True}


@router.post("/painpoints/{pp_id}/to-idea")
def painpoint_to_idea(pp_id: int):
    """痛点 → 创新点（captured 态，notes 里保留文献出处与证据，可溯源）。"""
    pp = row_or_404("lit_painpoints", pp_id)
    lit = query("SELECT title FROM literature WHERE id=?", (pp["literature_id"],))
    src = f"来自文献：{lit[0]['title'] if lit else '#' + str(pp['literature_id'])}"
    ts = now()
    iid = execute(
        """INSERT INTO ideas (title, one_liner, direction, novelty, feasibility,
           impact, effort, status, category, notes, created_at, updated_at)
           VALUES (?,?,?,3,3,3,3,'captured','痛点',?,?,?)""",
        (
            (pp["direction"] or pp["content"])[:80],
            pp["content"],
            pp["direction"],
            f"{src} ｜ 痛点：{pp['content']} ｜ 证据：{pp['evidence'] or '无'}",
            ts,
            ts,
        ),
    )
    execute("UPDATE lit_painpoints SET status='converted' WHERE id=?", (pp_id,))
    return row_or_404("ideas", iid)


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


# ============================ 关联图 ============================
# 类似 ResearchRabbit：选一篇种子文献 → 从 OpenAlex 拉引用关系 →
# 图谱化展示引用/被引，点击节点继续展开。

import re
import httpx

_OA_BASE = "https://api.openalex.org/works"
_OA_MAILTO = "workbench@local"


def _norm_title(t: str) -> str:
    """归一化标题用于去重：小写 + 只留字母数字。"""
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


def _oa_short_id(full: str) -> str:
    """https://openalex.org/W123 → W123"""
    return (full or "").replace("https://openalex.org/", "").replace(
        "http://openalex.org/", ""
    )


def _strip_doi(doi: str) -> str:
    """https://doi.org/10.xxx → 10.xxx"""
    d = (doi or "").strip()
    for pfx in ("https://doi.org/", "http://doi.org/"):
        if d.startswith(pfx):
            return d[len(pfx):]
    return d


def _oa_abstract(w: dict) -> str:
    """把 OpenAlex 的 abstract_inverted_index 还原成可读摘要；接口没给就返回空串（不编造）。"""
    inv = w.get("abstract_inverted_index")
    if not isinstance(inv, dict) or not inv:
        return ""
    pairs: list[tuple[int, str]] = []
    for word, poses in inv.items():
        if not isinstance(poses, list):
            continue
        for pos in poses:
            if isinstance(pos, int):
                pairs.append((pos, str(word)))
    pairs.sort(key=lambda t: t[0])
    return " ".join(word for _, word in pairs)[:4000]


def _parse_oa_work(w: dict) -> dict:
    """从 OpenAlex work 对象提取文献字段。"""
    authors = ", ".join(
        a["author"]["display_name"]
        for a in (w.get("authorships") or [])[:5]
        if a.get("author")
    )
    primary = w.get("primary_location") or {}
    src = primary.get("source") or {}
    return {
        "openalex_id": _oa_short_id(w.get("id", "")),
        "title": w.get("display_name") or "(无标题)",
        "authors": authors or None,
        "year": w.get("publication_year"),
        "venue": src.get("display_name"),
        "doi": _strip_doi(w.get("doi") or ""),
        "url": w.get("doi") or primary.get("landing_page_url") or "",
        "cited_by_count": w.get("cited_by_count") or 0,
        "ref_count": int(w.get("referenced_works_count") or 0),
        "abstract": _oa_abstract(w) or None,
    }


def _fill_abstract(lit_id: int, abstract: str | None) -> None:
    """命中已有文献时只补空摘要，绝不覆盖用户自己写的内容。"""
    if not abstract:
        return
    execute(
        "UPDATE literature SET abstract=? WHERE id=? AND (abstract IS NULL OR abstract='')",
        (abstract, lit_id),
    )


def _fill_cited(lit_id: int, n: int | None, refs: int | None = None) -> None:
    """OpenAlex 的被引数 / 参考文献数是事实指标，取到就写入（顺带回填旧数据）。"""
    if n is not None:
        execute(
            "UPDATE literature SET cited_by_count=? WHERE id=? AND (cited_by_count IS NULL OR cited_by_count!=?)",
            (n, lit_id, n),
        )
    if refs is not None:
        execute(
            "UPDATE literature SET ref_count=? WHERE id=? AND (ref_count IS NULL OR ref_count!=?)",
            (refs, lit_id, refs),
        )


def _find_or_create_lit(meta: dict) -> tuple[int, bool]:
    """按 DOI 或归一化标题去重，找不到就新建 todo 文献。返回 (id, is_new)。"""
    doi = meta.get("doi") or ""
    if doi:
        rows = query("SELECT id FROM literature WHERE doi=?", (doi,))
        if rows:
            execute(
                "UPDATE literature SET openalex_id=? WHERE id=? AND openalex_id IS NULL",
                (meta["openalex_id"], rows[0]["id"]),
            )
            _fill_abstract(rows[0]["id"], meta.get("abstract"))
            _fill_cited(rows[0]["id"], meta.get("cited_by_count"), meta.get("ref_count"))
            return rows[0]["id"], False
    norm = _norm_title(meta["title"])
    if norm:
        for r in query("SELECT id, title FROM literature"):
            if _norm_title(r["title"]) == norm:
                if meta["openalex_id"]:
                    execute(
                        "UPDATE literature SET openalex_id=? WHERE id=? AND openalex_id IS NULL",
                        (meta["openalex_id"], r["id"]),
                    )
                _fill_abstract(r["id"], meta.get("abstract"))
                _fill_cited(r["id"], meta.get("cited_by_count"), meta.get("ref_count"))
                return r["id"], False
    ts = now()
    lid = execute(
        """INSERT INTO literature (title, authors, year, venue, url, doi, openalex_id, abstract,
           cited_by_count, ref_count, status, rating, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'todo', 3, ?, ?)""",
        (
            meta["title"],
            meta["authors"],
            meta["year"],
            meta["venue"],
            meta["url"],
            meta["doi"],
            meta["openalex_id"],
            meta.get("abstract"),
            meta.get("cited_by_count"),
            meta.get("ref_count"),
            ts,
            ts,
        ),
    )
    return lid, True


def _ensure_edge(src: int, tgt: int, etype: str = "cites") -> int | None:
    """创建边（如不存在）。返回新 edge id，或 None（已存在）。"""
    existing = query(
        "SELECT id FROM lit_edges WHERE source_id=? AND target_id=? AND edge_type=?",
        (src, tgt, etype),
    )
    if existing:
        return None
    return execute(
        "INSERT INTO lit_edges (source_id, target_id, edge_type, created_at) VALUES (?,?,?,?)",
        (src, tgt, etype, now()),
    )


async def _oa_find_id(client: httpx.AsyncClient, lit: dict) -> str | None:
    """按 DOI 或标题在 OpenAlex 找 work ID（短形 W123...）。"""
    import openalex

    doi = _strip_doi(lit.get("doi") or "")
    params: dict = {"per-page": 1}
    if doi.startswith("10."):
        params["filter"] = f"doi:{doi}"
    else:
        params["search"] = lit.get("title", "")
    results = (await openalex.get(client, params, ttl=86400)).get("results", [])
    if not results:
        return None
    return _oa_short_id(results[0].get("id", ""))


async def _oa_fetch_work(client: httpx.AsyncClient, oa_id: str) -> dict | None:
    """获取单个 work 的完整信息（含 referenced_works）。"""
    import openalex

    try:
        return await openalex.get(client, url=f"{_OA_BASE}/{oa_id}", ttl=86400)
    except openalex.OAError:
        return None


async def _oa_fetch_citing(
    client: httpx.AsyncClient, oa_id: str, limit: int = 15
) -> list[dict]:
    """获取引用了该 work 的文献列表，按被引次数降序。"""
    import openalex

    data = await openalex.get(
        client,
        {
            "filter": f"cites:{oa_id}",
            "per-page": limit,
            "sort": "cited_by_count:desc",
        },
        ttl=3600,
    )
    return data.get("results", [])


async def _oa_batch_works(
    client: httpx.AsyncClient, oa_ids: list[str]
) -> list[dict]:
    """批量获取 works 元数据（每批 50）。"""
    import openalex

    metas: list[dict] = []
    for i in range(0, len(oa_ids), 50):
        batch = oa_ids[i : i + 50]
        data = await openalex.get(
            client,
            {"filter": "openalex_id:" + "|".join(batch), "per-page": 50},
            ttl=86400,
        )
        metas.extend(data.get("results", []))
    return metas


class EdgeIn(BaseModel):
    source_id: int
    target_id: int
    edge_type: str = "cites"


@router.get("/literature/graph")
def get_graph():
    """关联图数据：有边的文献 + 所有边 + 全部文献（供侧边栏选择）。"""
    edges = query("SELECT * FROM lit_edges ORDER BY id")
    ids: set[int] = set()
    for e in edges:
        ids.add(e["source_id"])
        ids.add(e["target_id"])
    if ids:
        ph = ",".join("?" * len(ids))
        nodes = query(f"{_LIT_SQL}WHERE l.id IN ({ph})", tuple(ids))
    else:
        nodes = []
    return {
        "nodes": nodes,
        "edges": edges,
        "papers": query(_LIT_SQL + "ORDER BY l.id DESC"),
    }


@router.post("/literature/{lit_id}/expand")
async def expand_literature(lit_id: int):
    """从 OpenAlex 拉取引用关系，自动创建关联文献与边。

    - references（本文引用了谁）：取前 15 篇
    - cited_by（谁引用了本文）：取前 15 篇，按被引次数降序
    """
    lit = row_or_404("literature", lit_id)

    # 1. 确定 OpenAlex ID
    oa_id = lit.get("openalex_id")
    if not oa_id:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                oa_id = await _oa_find_id(client, lit)
        except Exception as e:
            raise HTTPException(502, f"OpenAlex 查询失败：{e}")
        if not oa_id:
            raise HTTPException(
                404, "在 OpenAlex 未找到该文献，请确认标题或 DOI 是否准确"
            )
        execute("UPDATE literature SET openalex_id=? WHERE id=?", (oa_id, lit_id))

    # 2. 拉取引用数据并建边
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            created, new_edges = await _expand_oa_edges(client, lit_id, oa_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"OpenAlex 请求失败：{e}")

    return {
        "ok": True,
        "created": created,
        "new_edges": new_edges,
    }


async def _expand_oa_edges(
    client: httpx.AsyncClient, lit_id: int, oa_id: str
) -> tuple[int, int]:
    """拉取 lit_id 的 references + cited_by 并建边；返回 (新建文献数, 新建边数)。

    expand 与 graph/seed 共用这一套，保证两条入口生成的图口径一致。
    """
    work = await _oa_fetch_work(client, oa_id)
    if not work:
        raise HTTPException(502, "OpenAlex work 请求失败")
    # 中心文献自己的被引数也回填（节点大小按被引次数渲染）
    w0 = _parse_oa_work(work)
    _fill_cited(lit_id, w0.get("cited_by_count"), w0.get("ref_count"))
    ref_ids = [_oa_short_id(r) for r in (work.get("referenced_works") or [])][:15]
    citing = await _oa_fetch_citing(client, oa_id, limit=15)
    ref_metas = await _oa_batch_works(client, ref_ids) if ref_ids else []

    created = 0
    new_edges = 0
    for w in ref_metas:
        meta = _parse_oa_work(w)
        tid, is_new = _find_or_create_lit(meta)
        if is_new:
            created += 1
        if _ensure_edge(lit_id, tid, "cites"):
            new_edges += 1

    for w in citing:
        meta = _parse_oa_work(w)
        sid, is_new = _find_or_create_lit(meta)
        if is_new:
            created += 1
        if _ensure_edge(sid, lit_id, "cites"):
            new_edges += 1

    return created, new_edges


class SeedIn(BaseModel):
    query: str


@router.post("/literature/graph/seed")
async def seed_graph(body: SeedIn):
    """按 DOI 或标题搜一篇文献，入库并生成它的引用图（Litmaps 式加载）。

    流程：OpenAlex 解析（DOI 精确优先，标题检索兜底）→ 命中已有条目则复用并补
    被引数/摘要 → 拉前 15 篇参考文献 + 15 篇引用者建边。返回种子文献 id 供前端选中。
    """
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(400, "请输入 DOI 或标题")
    doi = _strip_doi(q)
    try:
        import openalex

        async with httpx.AsyncClient(timeout=30.0) as client:
            work: dict | None = None
            # DOI 精确查询优先（10.xxx 或 doi.org 链接）
            if doi.startswith("10."):
                results = (
                    await openalex.get(
                        client, {"filter": f"doi:{doi}", "per-page": 1}, ttl=86400
                    )
                ).get("results", [])
                if results:
                    work = results[0]
            # 标题检索兜底
            if work is None:
                results = (
                    await openalex.get(
                        client, {"search": q, "per-page": 1}, ttl=3600
                    )
                ).get("results", [])
                if results:
                    work = results[0]
            if not work:
                raise HTTPException(
                    404, "OpenAlex 没找到这篇文献，试试完整 DOI（10.xxx）或英文标题"
                )
            meta = _parse_oa_work(work)
            lit_id, _ = _find_or_create_lit(meta)
            created, new_edges = await _expand_oa_edges(client, lit_id, meta["openalex_id"])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"OpenAlex 请求失败：{e}")

    return {
        "ok": True,
        "lit_id": lit_id,
        "created": created,
        "new_edges": new_edges,
    }


@router.post("/literature/graph/edges")
def add_graph_edge(body: EdgeIn):
    """手动添加一条关联边。"""
    eid = _ensure_edge(body.source_id, body.target_id, body.edge_type)
    if eid is None:
        raise HTTPException(409, "该关联已存在")
    return {"ok": True, "id": eid}


@router.delete("/literature/graph/edges/{edge_id}")
def delete_graph_edge(edge_id: int):
    """删除一条关联边。"""
    execute("DELETE FROM lit_edges WHERE id=?", (edge_id,))
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
    execute("DELETE FROM exp_runs WHERE experiment_id=?", (exp_id,))
    execute("DELETE FROM exp_messages WHERE experiment_id=?", (exp_id,))
    _drop_ws(exp_id)
    execute("DELETE FROM experiments WHERE id=?", (exp_id,))
    return {"ok": True}


def _drop_ws(exp_id: int):
    """连 Agent 工作区一起清（data/exp_ws/{id}/，纯本实验的产物）。"""
    import shutil

    import config

    shutil.rmtree(config.DATA_DIR / "exp_ws" / str(exp_id), ignore_errors=True)


@router.post("/experiments/bulk-delete")
def bulk_delete_experiments(body: IdsIn):
    """批量删实验：连带清掉下面的结果记录与运行记录。"""
    ids = [int(i) for i in body.ids if i is not None]
    if not ids:
        return {"deleted": 0}
    _delete_where("exp_results", "experiment_id", ids)
    _delete_where("exp_runs", "experiment_id", ids)
    _delete_where("exp_messages", "experiment_id", ids)
    for i in ids:
        _drop_ws(i)
    _delete_where("experiments", "id", ids)
    return {"deleted": len(ids)}


# 数据口径三分层（借鉴 Open Science experiment-suite 的 provenance 契约）：
# measured=真实测得 / simulated=模拟(须可复现) / illustrative=示意(不能进结论)
PROV_LEVELS = {"measured", "simulated", "illustrative"}
PROV_LABELS = {"measured": "实测", "simulated": "模拟", "illustrative": "示意"}


class ResultIn(BaseModel):
    case_name: str
    method: str | None = None
    success: int = 0
    metrics_json: str | None = None
    notes: str | None = None
    provenance: str = "measured"


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
    prov = body.provenance if body.provenance in PROV_LEVELS else "measured"
    rid = execute(
        """INSERT INTO exp_results (experiment_id, case_name, method, success,
           metrics_json, notes, provenance, created_at) VALUES (?,?,?,?,?,?,?,?)""",
        (
            exp_id,
            body.case_name,
            body.method,
            body.success,
            body.metrics_json,
            body.notes,
            prov,
            now(),
        ),
    )
    return {"ok": True, "id": rid}


@router.delete("/results/{result_id}")
def delete_result(result_id: int):
    execute("DELETE FROM exp_results WHERE id=?", (result_id,))
    return {"ok": True}


# ---- AI 科研图表：读结果记录 → 图表 spec（图与数据表同源） ----
CHART_TYPES = {"bar", "line", "scatter"}


def _numeric_metrics(metrics_json: str | None) -> dict[str, float]:
    try:
        raw = json.loads(metrics_json or "{}")
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f == f:  # 拒绝 NaN
            out[str(k)[:40]] = f
    return out


def _sanitize_chart(data) -> dict | None:
    """图表 spec 校验：数值强转、维度对齐、超限截断；不合格一律返回 None。"""
    if not isinstance(data, dict):
        return None
    ctype = str(data.get("type") or "")
    if ctype == "none":
        reason = str(data.get("reason") or "").strip()[:300]
        return {"type": "none", "reason": reason} if reason else None
    if ctype not in CHART_TYPES:
        return None
    title = str(data.get("title") or "").strip()[:120] or "实验图表"
    x_label = str(data.get("x_label") or "").strip()[:60]
    y_label = str(data.get("y_label") or "").strip()[:60]
    note = str(data.get("note") or "").strip()[:300]

    def _num(v) -> float | None:
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if f == f else None

    if ctype == "scatter":
        pts = []
        for p in (data.get("points") or [])[:200]:
            if not isinstance(p, dict):
                continue
            x, y = _num(p.get("x")), _num(p.get("y"))
            if x is None or y is None:
                continue
            pts.append({"x": x, "y": y, "label": str(p.get("label") or "").strip()[:60] or None})
        if len(pts) < 2:
            return None
        return {"type": ctype, "title": title, "x_label": x_label, "y_label": y_label,
                "note": note, "points": pts}

    cats = [str(c).strip()[:40] for c in (data.get("categories") or []) if str(c).strip()][:20]
    if not cats:
        return None
    series = []
    for s in (data.get("series") or [])[:4]:
        if not isinstance(s, dict):
            continue
        vals_raw = s.get("values")
        if not isinstance(vals_raw, list) or len(vals_raw) != len(cats):
            continue
        vals = [_num(v) for v in vals_raw]
        if any(v is None for v in vals):
            continue
        series.append({"name": str(s.get("name") or "系列").strip()[:60], "values": vals})
    if not series:
        return None
    return {"type": ctype, "title": title, "x_label": x_label, "y_label": y_label,
            "note": note, "categories": cats, "series": series}


@router.post("/experiments/{exp_id}/chart")
async def experiment_chart(exp_id: int):
    """AI 科研图表：结果记录 → Recharts spec。只准用记录里真实存在的数字。"""
    exp = row_or_404("experiments", exp_id)
    results = query("SELECT * FROM exp_results WHERE experiment_id=? ORDER BY id", (exp_id,))
    rows_src = []
    for r in results:
        m = _numeric_metrics(r["metrics_json"])
        if m:
            rows_src.append({
                "n": r["id"],
                "case": r["case_name"],
                "method": r["method"] or "-",
                "口径": PROV_LABELS.get(r.get("provenance") or "measured", "实测"),
                "指标": m,
            })
    if len(rows_src) < 2:
        return {"ok": False, "chart": None, "error": {
            "kind": "no_data", "label": "可画的数据点不足",
            "message": f"共 {len(rows_src)} 条含数值指标的结果记录，至少需要 2 条才能成图。",
            "hint": "在结果记录里补几条带指标 JSON 的记录（如 {\"acc\": 0.87}）再生成图表。",
        }}
    data_lines = [json.dumps(r, ensure_ascii=False) for r in rows_src]
    prompt = f"""实验「{exp['name']}」（假设：{exp.get('hypothesis') or '（无）'}）

结果记录（n=记录 id）：
{chr(10).join(data_lines)}

请为这些结果设计一张论文风格的科研图表。只输出 JSON（不要 markdown 包裹）：
{{
  "type": "bar" 或 "line" 或 "scatter",
  "title": "图表标题（中文、简短）",
  "x_label": "x 轴含义", "y_label": "y 轴含义（带单位或 %）",
  "categories": ["x 轴各刻度标签"],
  "series": [{{"name": "系列名", "values": [与 categories 等长的数值数组]}}],
  "points": [{{"x": 数值, "y": 数值, "label": "点标注（可选）"}}],
  "note": "一句话说明数据来源与口径（如：仅含实测口径 n=3,5,6）"
}}

字段取舍：bar/line 填 categories+series（points 留空数组）；scatter 只填 points。
硬规则：
1. 只准用上面结果记录里真实存在的数字，禁止推算/补全/平滑出记录里没有的数据点
2. 系列数 ≤4，刻度 ≤20；不同口径（实测/模拟/示意）的数据禁止混进同一系列，必须在 note 里分开说明
3. 分组对比用 bar；趋势用 line；两组数值指标的相关性（如 参数量 vs acc）用 scatter
4. 数据确实不适合画图时输出 {{"type": "none", "reason": "原因"}}"""
    data, env = await llm.complete_json_result(prompt, mode="fast", task="exp-chart", max_tokens=3072)
    if not env["ok"]:
        return {"ok": False, "chart": None, "error": env["error"]}
    chart = _sanitize_chart(data)
    return {
        "ok": chart is not None, "chart": chart, "error": None if chart else {
            "kind": "bad_spec", "label": "图表数据校验没通过",
            "message": "AI 返回的图表 spec 缺少必需字段或数值与记录对不上，请重试。",
            "hint": "重试一次通常就好；若反复失败，检查结果记录的指标 JSON 是否都是数值。",
        },
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }


@router.post("/experiments/{exp_id}/analysis")
async def analyze_experiment(exp_id: int):
    exp = row_or_404("experiments", exp_id)
    results = query("SELECT * FROM exp_results WHERE experiment_id=?", (exp_id,))
    lines = [
        f"- {r['case_name']} | 方法={r['method'] or '-'} | 成功={bool(r['success'])} | "
        f"口径={PROV_LABELS.get(r.get('provenance') or 'measured', '实测')} | "
        f"指标={r['metrics_json'] or '{}'} | 备注={r['notes'] or '-'}"
        for r in results
    ]
    prov_warn = ""
    non_measured = [r for r in results if (r.get("provenance") or "measured") != "measured"]
    if non_measured:
        prov_warn = (
            f"\n注意：其中 {len(non_measured)} 条是模拟/示意口径的数据，"
            "不是真实测得——分析时必须与实测数据分开评估，禁止混在一个口径里下结论。"
        )
    prompt = f"""实验名称：{exp['name']}
假设：{exp.get('hypothesis') or '（无）'}
设计：{exp.get('design') or '（无）'}

结果明细（{len(results)} 条）：
{chr(10).join(lines) if lines else "（暂无结果）"}{prov_warn}

请输出：
1. 假设是否成立，依据是什么（只对上面数据负责，不要外推；若含模拟/示意数据，结论只基于实测口径）
2. 失败样本的共同特征与可能根因（分条，按可能性排序）
3. 结果汇总表（Markdown 表格）
4. 下一步该补的最小实验（具体、可在 1-2 天内做完）
5. 这段结果可以直接写进论文 Results 的 2-3 句话"""
    env = await llm.complete_result(prompt, mode="fast", task="exp-analysis", max_tokens=3072)
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


@router.post("/experiments/{exp_id}/failures")
async def experiment_failures(exp_id: int):
    """失败模式归因：只看失败样本，给可行动的根因假设。"""
    exp = row_or_404("experiments", exp_id)
    results = query("SELECT * FROM exp_results WHERE experiment_id=?", (exp_id,))
    failed = [r for r in results if not r["success"]]
    if not failed:
        return {"ok": False, "result": "", "error": {
            "kind": "no_data", "label": "没有失败样本",
            "message": "当前实验的所有结果记录都是成功，无需归因。",
            "hint": "失败归因只对「失败」的结果记录生效，先录入几条失败 case 再试。",
        }}
    lines = [
        f"- case={r['case_name']} | 方法={r['method'] or '-'} | "
        f"指标={r['metrics_json'] or '{}'} | 备注={r['notes'] or '-'}"
        for r in failed
    ]
    ok_lines = [
        f"- case={r['case_name']} | 方法={r['method'] or '-'} | 指标={r['metrics_json'] or '{}'}"
        for r in results if r["success"]
    ]
    prompt = f"""实验「{exp['name']}」的假设：{exp.get('hypothesis') or '（无）'}
设计：{exp.get('design') or '（无）'}

失败样本（{len(failed)} 条）：
{chr(10).join(lines)}

成功样本对照（{len(ok_lines)} 条）：
{chr(10).join(ok_lines) if ok_lines else "（无成功样本）"}

请做失败模式归因，输出：
1. 失败模式分类：把失败样本按「看起来是同一种死法」分成 2-4 组，每组起个名字并给出组内证据
2. 每组的根因假设：按可能性排序，说明「依据哪个字段/哪条记录」
3. 每组一条验证动作：花 <半天 就能确认/排除该假设的最小操作
4. 红旗：如果失败样本少到无法归因（<3 条）或信息缺失严重，直说，不要硬编

只基于给出的数据分析，禁止编造数据里不存在的细节。"""
    env = await llm.complete_result(prompt, mode="fast", task="exp-failures", max_tokens=3072)
    if not env["ok"]:
        return {"ok": False, "result": "", "error": env["error"]}
    return {
        "ok": True, "result": env["content"], "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }


class DesignReviewIn(BaseModel):
    extra: str | None = None  # 用户补充的上下文（预算/时间/算力约束等）


@router.post("/experiments/{exp_id}/design-review")
async def experiment_design_review(exp_id: int, body: DesignReviewIn | None = None):
    """实验设计预审：跑之前先挑毛病，省下白跑一周的代价。"""
    exp = row_or_404("experiments", exp_id)
    prompt = f"""你是一位方法论严苛但务实的实验方法学审稿人。请预审下面这个还没跑的实验设计：

实验名称：{exp['name']}
假设：{exp.get('hypothesis') or '（未填写）'}
设计（方法 × 样本 × 指标）：{exp.get('design') or '（未填写）'}
{('补充约束：' + body.extra) if body and body.extra else ''}

请输出：
1. 一句话总评：这个设计能不能直接开跑（能 / 小改后能 / 大改后才能）
2. 致命问题清单：会导致结论不可信或白跑的设计缺陷，每条给出「为什么致命 + 怎么改」
3. 缺失项检查：样本量、基线、随机性/重复次数、评价指标、消融项、数据泄漏风险——缺哪个点哪个，没缺的别硬凑
4. 最便宜的先行版本：如果只有 1/3 的预算，这个实验最简化但仍有说服力的跑法
5. 开跑前 checklist：3-5 条勾选项

务实一点：这是个人科研工作台的实验，不是顶会投稿评审，别拿「创新性不足」说事，只看方法学。"""
    env = await llm.complete_result(prompt, mode="fast", task="exp-design-review", max_tokens=3072)
    if not env["ok"]:
        return {"ok": False, "result": "", "error": env["error"]}
    return {
        "ok": True, "result": env["content"], "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }


# ============================ 运行溯源 Runs（借鉴 Open Science record_run） ============================

_RUN_SURFACES = {"local": "本地", "ssh": "SSH", "slurm": "Slurm", "modal": "Modal 云"}
_RUN_STATUSES = {"ok": "成功", "failed": "失败", "running": "运行中"}


def _norm_path(p: str) -> str:
    """Windows 大小写不敏感，归一化后比较输出路径是否撞车。"""
    return os.path.normcase(os.path.normpath(p))


def _file_entry(raw: str) -> dict | None:
    """逐文件钉码：存在则记 {path,size,sha1[:16]}；缺失记 size=0 + missing（抓取被跳过的信号）。"""
    p = (raw or "").strip().strip('"').strip("'")
    if not p:
        return None
    f = Path(p)
    try:
        if f.is_file():
            data = f.read_bytes()
            return {"path": p, "size": len(data), "sha1": hashlib.sha1(data).hexdigest()[:16]}
    except OSError:
        pass
    return {"path": p, "size": 0, "sha1": "", "missing": True}


class RunIn(BaseModel):
    command: str
    surface: str = "local"        # local / ssh / slurm / modal
    status: str = "ok"            # ok / failed / running
    host: str | None = None
    job_id: str | None = None
    wall_ms: int | None = None
    notes: str | None = None
    env_text: str | None = None   # pip freeze 全文；落库存 sha1 内容寻址 hash
    code_paths: list[str] = []    # 参与本 run 的代码/脚本路径
    output_paths: list[str] = []  # 本 run 产出的结果文件路径（登记后不可复用）


@router.get("/experiments/{exp_id}/runs")
def list_runs(exp_id: int):
    return query("SELECT * FROM exp_runs WHERE experiment_id=? ORDER BY id DESC", (exp_id,))


@router.post("/experiments/{exp_id}/runs")
def register_run(exp_id: int, body: RunIn):
    row_or_404("experiments", exp_id)
    if body.surface not in _RUN_SURFACES:
        raise HTTPException(422, f"surface 只支持：{' / '.join(_RUN_SURFACES)}")
    if body.status not in _RUN_STATUSES:
        raise HTTPException(422, f"status 只支持：{' / '.join(_RUN_STATUSES)}")
    if not body.command.strip():
        raise HTTPException(422, "command 不能为空")

    code = [e for e in (_file_entry(x) for x in body.code_paths) if e]
    outs = [e for e in (_file_entry(x) for x in body.output_paths) if e]

    # 不可变输出路径：新 run 不得登记到本实验已用过的输出路径上——
    # 「重跑悄悄覆盖旧结果」在机制上被禁止，要重跑就开新目录。
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
            raise HTTPException(
                409,
                "输出路径已被旧 run 占用，禁止覆盖旧结果（重跑请换新目录）："
                + "；".join(conflict[:6]),
            )

    ts = now()
    run_id = hashlib.sha1(f"{exp_id}|{ts}|{body.command}".encode()).hexdigest()[:16]
    env_text = (body.env_text or "").strip()
    env_hash = hashlib.sha1(env_text.encode()).hexdigest()[:16] if env_text else None
    rid = execute(
        """INSERT INTO exp_runs (experiment_id, run_id, command, surface, status, host, job_id,
           wall_ms, notes, env_text, env_hash, code_json, output_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            exp_id, run_id, body.command.strip(), body.surface, body.status,
            body.host, body.job_id, body.wall_ms, body.notes,
            env_text or None, env_hash,
            json.dumps(code, ensure_ascii=False), json.dumps(outs, ensure_ascii=False), ts,
        ),
    )
    return row_or_404("exp_runs", rid)


@router.delete("/exp_runs/{run_id}")
def delete_run(run_id: int):
    execute("DELETE FROM exp_runs WHERE id=?", (run_id,))
    return {"ok": True}


# ============================ 结果审查（借鉴 Open Science reviewer） ============================

_AUDIT_CHECKS = {"traceability", "stats", "domain", "integrity", "coverage"}
_AUDIT_LABELS = {
    "traceability": "溯源",
    "stats": "统计",
    "domain": "领域",
    "integrity": "完整性",
    "coverage": "覆盖",
}


def _sanitize_findings(data) -> tuple[str, list[dict]]:
    """结构化 findings 契约：最多 8 条，level/check 白名单，evidence 必填——没有证据就降级成 ok note。"""
    if not isinstance(data, dict):
        return "", []
    note = str(data.get("note") or "").strip()[:300]
    out: list[dict] = []
    for f in (data.get("findings") or [])[:8]:
        if not isinstance(f, dict):
            continue
        level = str(f.get("level") or "").strip().lower()
        if level not in {"error", "warn", "ok"}:
            continue
        check = str(f.get("check") or "").strip().lower()
        if check not in _AUDIT_CHECKS:
            check = "traceability"
        title = str(f.get("title") or "").strip()[:200]
        evidence = str(f.get("evidence") or "").strip()[:600]
        if not title:
            continue
        if not evidence:
            # Evidence or silence：没有证据的 finding 不配独立成条
            level = "ok"
            evidence = "（未给出证据）"
        out.append({"level": level, "check": check, "title": title, "evidence": evidence})
    out.sort(key=lambda x: {"error": 0, "warn": 1, "ok": 2}[x["level"]])
    return note, out


@router.post("/experiments/{exp_id}/audit")
async def audit_experiment(exp_id: int):
    """结果审查：验证可溯源性与内部一致性，never truth。只基于工作台内记录，缺证据直说。"""
    exp = row_or_404("experiments", exp_id)
    results = query("SELECT * FROM exp_results WHERE experiment_id=?", (exp_id,))
    runs = query(
        "SELECT * FROM exp_runs WHERE experiment_id=? ORDER BY id DESC LIMIT 20", (exp_id,)
    )

    res_lines = [
        f"- [{PROV_LABELS.get(r.get('provenance') or 'measured', '实测')}] "
        f"case={r['case_name']} | 方法={r['method'] or '-'} | 成功={bool(r['success'])} | "
        f"指标={r['metrics_json'] or '{}'} | 备注={r['notes'] or '-'}"
        for r in results
    ]
    run_lines = []
    for r in runs:
        try:
            outs = json.loads(r["output_json"] or "[]")
        except Exception:
            outs = []
        missing = [f["path"] for f in outs if f.get("missing")]
        run_lines.append(
            f"- run={r['run_id']} | surface={r['surface']} | status={r['status']} | "
            f"command={r['command']} | 输出文件={len(outs)} 个"
            + (f" | 缺失文件={missing}" if missing else "")
        )

    prompt = f"""你是科研工作台的结果审查员。职责是 verify traceability and internal consistency, never truth——
你只检查「记录是否可溯源、数字是否自洽」，绝不宣称实验本身正确。

实验「{exp['name']}」
假设：{exp.get('hypothesis') or '（未填写）'}
设计：{exp.get('design') or '（未填写）'}

结果记录（{len(results)} 条，口径已标注）：
{chr(10).join(res_lines) if res_lines else "（无结果记录）"}

运行溯源记录（{len(runs)} 条，含 sha1 文件指纹）：
{chr(10).join(run_lines) if run_lines else "（无运行记录）"}

按以下五类检查（只查有记录可对照的项，没记录的项直接跳过，不要硬凑）：
- traceability 溯源：结论数字是否都能在结果记录里找到出处；运行记录里的输出文件是否真的有 sha1（missing=抓取被跳过）；声称跑了 A 方法但记录里没有对应 run
- stats 统计：成功率/指标汇总是否与明细一致；样本量是否支撑结论；有没有拿模拟口径的数据当实测用
- domain 领域：指标单位/量纲是否自洽；成功判定标准是否前后一致
- integrity 完整性：同一 case 名重复记录且数字打架；指标 JSON 语法是否可解析
- coverage 覆盖：设计里写了但结果里完全没有的 case/基线/消融项

只基于上面的记录，禁止编造记录里不存在的数字。输出 JSON：
{{"note": "一句话说明检查了什么、跳过了什么",
  "findings": [
    {{"level": "error|warn|ok", "check": "traceability|stats|domain|integrity|coverage",
      "title": "问题一句话", "evidence": "具体证据：哪条记录/哪个字段+原文数字"}}
  ]}}
要求：≤8 条按严重度排序；每条 finding 必须带 evidence（引用记录原文数字/字段名），没有证据就不要单独立条；
没问题就少输出，可以用 level=ok 报一条「已检查、未发现」；不奉承不凑数。"""
    data, env = await llm.complete_json_result(prompt, mode="fast", task="exp-audit", max_tokens=3072)
    if not env["ok"]:
        return {"ok": False, "note": "", "findings": [], "error": env["error"]}
    note, findings = _sanitize_findings(data)
    return {
        "ok": True,
        "note": note or "（模型未给出说明）",
        "findings": findings,
        "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }


class CompareIn(BaseModel):
    ids: list[int] = []


@router.post("/experiments/compare")
async def experiments_compare(body: CompareIn):
    """跨实验对比：把勾选的 2-6 个实验放在一起，让 AI 找模式。"""
    ids = [int(i) for i in body.ids if i is not None]
    if len(ids) < 2:
        return {"ok": False, "result": "", "error": {
            "kind": "no_data", "label": "至少勾选 2 个实验",
            "message": "跨实验对比需要 2-6 个实验，在列表里多选后再点对比。",
            "hint": None,
        }}
    ids = ids[:6]
    blocks = []
    for eid in ids:
        e = row_or_404("experiments", eid)
        results = query("SELECT * FROM exp_results WHERE experiment_id=?", (eid,))
        n_ok = sum(1 for r in results if r["success"])
        rl = [
            f"    - {r['case_name']} | {r['method'] or '-'} | {'成功' if r['success'] else '失败'} | {r['metrics_json'] or '{}'}"
            for r in results[:20]
        ]
        blocks.append(
            f"### 实验 {e['name']}（状态：{e['status']}）\n"
            f"假设：{e.get('hypothesis') or '（无）'}\n"
            f"设计：{e.get('design') or '（无）'}\n"
            f"结果（{n_ok}/{len(results)} 成功）：\n" + ("\n".join(rl) if rl else "    （无记录）")
        )
    prompt = f"""下面是 {len(blocks)} 个实验的完整档案，请做横向对比分析：

{chr(10).join(blocks)}

请输出：
1. 对比总表（Markdown 表格）：实验名 × 假设 × 方法要点 × 成功率 × 关键指标
2. 模式发现：哪个实验的结果支持/反驳了哪个假设？有没有跨实验重复出现的现象？
3. 冲突与矛盾：结果之间有没有互相打架的地方？指出具体是哪两个实验的哪个指标
4. 下一步：基于全部证据，最值得投入的下一个实验是什么（合并/分支/放弃哪个方向）
5. 可直接写进论文的一段话：用 3-4 句话概述这组实验共同支撑的结论

只基于给出的数据分析，禁止编造。"""
    env = await llm.complete_result(prompt, mode="fast", task="exp-compare", max_tokens=3584)
    if not env["ok"]:
        return {"ok": False, "result": "", "error": env["error"]}
    return {
        "ok": True, "result": env["content"], "error": None,
        "provider": env["provider"], "model": env["model"],
        "tokens_in": env["tokens_in"], "tokens_out": env["tokens_out"],
    }
