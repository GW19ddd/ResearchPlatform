"""AI 产出体检：把历史上被错误文本污染的记录找出来，交给用户决定怎么处理。

原则：**只识别、不自动清理**。
早期版本会把「[LLM 调用失败] …」「[Dify 调用失败] …」直接写进创新点备注、
文献笔记、实验结论。这些记录现在还在库里。它们不该被脚本默默删掉 ——
有的用户可能手动改过、有的旁边就写着有用的上下文。这里把它们列出来，
清理动作必须携带明确的条目清单才能执行。
"""
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import execute, now, query

router = APIRouter(prefix="/api/ai", tags=["ai-guard"])

# 历史错误文本的开头特征
ERROR_MARKERS = (
    "[LLM 调用失败]",
    "[Dify 调用失败]",
    "[HTTP 调用失败]",
    "[Dify 未启用]",
    "[Dify 未配置 API 地址]",
    "[没有可用的 LLM provider]",
    "[节点执行异常]",
    "[节点未配置]",
    "[找不到 Dify 应用",
    "[未找到 skill",
    "[读取 GitHub skill 失败",
    "[未知工具类型]",
)

KEY_MISSING = "[provider「"  # 「xxx 未填 API Key」


def _markers_in(text: str) -> str | None:
    s = (text or "").strip()
    if not s:
        return None
    for m in ERROR_MARKERS:
        if m in s:
            return m
    if s.startswith(KEY_MISSING) and "未填 API Key" in s:
        return KEY_MISSING
    return None


def _snippet(text: str, n: int = 120) -> str:
    s = (text or "").strip().replace("\n", " ")
    return s[:n] + ("…" if len(s) > n else "")


# 每个受检位置：(展示名, 表, id 列, 文本列, 标题列或 None)
SCAN_TARGETS = [
    ("创新点备注", "ideas", "id", "notes", "title"),
    ("创新点一句话主张", "ideas", "id", "one_liner", "title"),
    ("AI 质疑意见", "idea_reviews", "id", "content", None),
    ("文献笔记小节", "lit_notes", "id", "content", "section"),
    ("文献备注", "literature", "id", "notes", "title"),
    ("实验结论", "experiments", "id", "conclusion", "name"),
    ("画布节点输出", "canvas_node_outputs", "id", "output_text", "node_key"),
]


def scan(limit: int = 300) -> list[dict]:
    found: list[dict] = []
    for label, table, idcol, textcol, titlecol in SCAN_TARGETS:
        sel = f"SELECT * FROM {table}"
        rows = query(sel)
        for r in rows:
            text = r.get(textcol) or ""
            marker = _markers_in(text)
            # 画布输出另有一条显式失败标记
            if not marker and table == "canvas_node_outputs" and r.get("status") == "error":
                marker = "运行失败记录"
            if not marker:
                continue
            found.append(
                {
                    "kind": label,
                    "table": table,
                    "id": r.get(idcol),
                    "field": textcol,
                    "title": (r.get(titlecol) if titlecol else None) or f"#{r.get(idcol)}",
                    "marker": marker,
                    "snippet": _snippet(text),
                    "created_at": r.get("created_at") or r.get("updated_at") or "",
                }
            )
            if len(found) >= limit:
                return found
    return found


@router.get("/suspects")
def api_suspects(limit: int = 300):
    items = scan(limit)
    by_kind: dict[str, int] = {}
    for it in items:
        by_kind[it["kind"]] = by_kind.get(it["kind"], 0) + 1
    return {"items": items, "total": len(items), "by_kind": by_kind}


class ItemIn(BaseModel):
    table: str
    id: int
    field: str | None = None
    action: Literal["clear", "delete"] = "clear"


class CleanupIn(BaseModel):
    items: list[ItemIn]
    confirm: bool = False


# 允许被清理的目标：表 → 可操作的文本列。表外的任何东西都不动。
ALLOWED_TABLES = {
    "ideas": ("notes", "one_liner"),
    "idea_reviews": ("content",),
    "lit_notes": ("content",),
    "literature": ("notes",),
    "experiments": ("conclusion",),
    "canvas_node_outputs": ("output_text",),
}


@router.post("/suspects/cleanup")
def api_cleanup(body: CleanupIn):
    """按用户给定的条目清单处理。没有清单就什么都不做。"""
    if not body.items:
        raise HTTPException(400, "没有指定要处理的条目")
    if not body.confirm:
        raise HTTPException(400, "清理会改动已有记录，需要传 confirm=true")

    cleared = 0
    deleted = 0
    skipped: list[str] = []
    for it in body.items:
        allowed = ALLOWED_TABLES.get(it.table)
        if not allowed:
            skipped.append(f"{it.table}#{it.id}：不支持的表")
            continue
        field = it.field or allowed[0]
        if field not in allowed:
            skipped.append(f"{it.table}.{field}：字段不可改")
            continue
        rows = query(f"SELECT id FROM {it.table} WHERE id=?", (it.id,))
        if not rows:
            skipped.append(f"{it.table}#{it.id}：记录不存在")
            continue
        if it.action == "delete":
            execute(f"DELETE FROM {it.table} WHERE id=?", (it.id,))
            deleted += 1
        else:
            touch = ", updated_at=?" if it.table in ("ideas", "literature", "experiments") else ""
            args = [""]
            if touch:
                args.append(now())
            args.append(it.id)
            execute(f"UPDATE {it.table} SET {field}=?{touch} WHERE id=?", args)
            cleared += 1
    return {"ok": True, "cleared": cleared, "deleted": deleted, "skipped": skipped}
