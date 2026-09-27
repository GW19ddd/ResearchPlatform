"""通用数据访问助手：把各 router 里重复了六遍的「取行 / 打补丁 / 删行」收敛到一处。

约定：
- 读单行统一走 `row_or_404`，不存在就是 404，不再让上层各写一遍
- 局部更新统一走 `patch_row`：字段白名单 + 可选校验 + 自动维护 updated_at
- 删除统一走 `delete_row`，删不存在的 id 返回 404 而不是假装成功

这样新增模块时只需要声明「哪些字段可改、怎么校验」，不再复制粘贴 SQL 拼接。
"""
from typing import Callable, Iterable

from fastapi import HTTPException

from db import execute, now, query

# 需要自动维护 updated_at 的表；没列出的表只改业务字段
TABLES_WITH_UPDATED_AT = {
    "ideas",
    "literature",
    "lit_notes",
    "experiments",
    "advisor_notes",
    "paper_stages",
    "paper_sections",
    "canvases",
}


def row_or_404(table: str, id_: int) -> dict:
    rows = query(f"SELECT * FROM {table} WHERE id = ?", (int(id_),))
    if not rows:
        raise HTTPException(404, f"{table} {id_} not found")
    return rows[0]


def delete_row(table: str, id_: int) -> dict:
    """删行；id 不存在时 404（历史上会返回 ok 骗过调用方）。"""
    row_or_404(table, id_)
    execute(f"DELETE FROM {table} WHERE id=?", (int(id_),))
    return {"ok": True}


def patch_row(
    table: str,
    id_: int,
    body: dict,
    allowed: Iterable[str],
    validators: dict[str, Callable[[object], object]] | None = None,
    touch: bool = True,
) -> tuple[dict, dict]:
    """白名单局部更新。返回 (更新前, 更新后)。

    - allowed 之外的字段静默忽略（前端经常整包回传）
    - validators 用于在落库前做类型/范围约束，返回规范化后的值
    - touch=True 且表有 updated_at 时自动更新时间戳
    """
    before = row_or_404(table, id_)
    sets: list[str] = []
    vals: list = []
    for k, v in (body or {}).items():
        if k not in allowed:
            continue
        if validators and k in validators:
            v = validators[k](v)
        sets.append(f"{k}=?")
        vals.append(v)
    if not sets:
        raise HTTPException(400, "no valid field")
    if touch and table in TABLES_WITH_UPDATED_AT:
        sets.append("updated_at=?")
        vals.append(now())
    vals.append(int(id_))
    execute(f"UPDATE {table} SET {','.join(sets)} WHERE id=?", vals)
    return before, row_or_404(table, id_)


# --------------------------- 常用校验器 ---------------------------


def clamp_score(lo: int = 1, hi: int = 5, default: int = 3) -> Callable[[object], int]:
    """1-5 分制评分：越界收敛、非数字回落默认值。用于 AI 产出这类「尽力而为」的场景。"""

    def _f(v: object) -> int:
        try:
            n = int(v)
        except (TypeError, ValueError):
            return default
        return max(lo, min(hi, n))

    return _f


def bounded_score(
    lo: int = 1, hi: int = 5, default: int = 3, field: str = "评分"
) -> Callable[[object], int]:
    """用户提交的评分：越界直接 400，不静默改写用户数据。"""

    def _f(v: object) -> int:
        try:
            n = int(v)
        except (TypeError, ValueError):
            return default
        if n < lo or n > hi:
            raise HTTPException(400, f"{field}需在 {lo}-{hi} 之间，收到 {n}")
        return n

    return _f


def non_negative(default: int = 0) -> Callable[[object], int]:
    """字数 / 计数类字段：负数一律归零。"""

    def _f(v: object) -> int:
        try:
            n = int(v)
        except (TypeError, ValueError):
            return default
        return max(0, n)

    return _f


def require_text(field: str = "该字段") -> Callable[[object], str]:
    """去空白后必须非空，否则 400。"""

    def _f(v: object) -> str:
        s = str(v or "").strip()
        if not s:
            raise HTTPException(400, f"{field}不能为空")
        return s

    return _f


def nullable_text(v: object) -> object:
    if v is None:
        return None
    s = str(v).strip()
    return s or None
