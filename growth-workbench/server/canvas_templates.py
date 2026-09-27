"""画布模板：内置模板 + 用户自存模板。

为什么单独一个模块：canvas.py 已经承担「CRUD + 执行引擎 + 自动编排」，模板只是它的一条边角职责。
这里把「模板从哪来、怎么存、怎么列」收在一处，canvas.py 只问 all_templates() / get_template()。

用户模板存 settings 表（key='canvas_user_templates'，JSON 数组），
和 llm_config / dify_config 同一套持久化方式，不用改表结构。
"""
import json
import time

from db import execute, query

USER_TPL_KEY = "canvas_user_templates"

# ---------------------------------------------------------------- 内置模板

BUILTIN: dict[str, dict] = {
    "topic": {
        "name": "选题 → 综述 → 论证",
        "nodes": [
            {"node_key": "n1", "type": "input", "title": "研究方向", "x": 40, "y": 120,
             "config": {"text": "在 OpenFOAM 2406 中开发具备 Skill 机制的 LLM 智能体，并构建故障基准评测其修复能力"}},
            {"node_key": "n2", "skill_id": "academic-research-suite", "type": "skill", "title": "科研框架", "x": 320, "y": 40,
             "config": {"inputs": {"constraint": "1 个月交小论文，单机，两周一次组会"}}},
            {"node_key": "n3", "skill_id": "nature-academic-search", "type": "skill", "title": "扩展检索", "x": 620, "y": 40,
             "config": {"inputs": {"keywords": "LLM agent, OpenFOAM, CFD repair, fault benchmark", "venue": "ASE / FSE"}}},
            {"node_key": "n4", "skill_id": "literature-survey-skill", "type": "skill", "title": "综述与空白", "x": 620, "y": 200,
             "config": {"inputs": {"known": "ChatCFD\nTerminalCFD\n（待补充）"}}},
            {"node_key": "n5", "skill_id": "paper-spine", "type": "skill", "title": "论证链诊断", "x": 920, "y": 200,
             "config": {"inputs": {"motivation": "现有 LLM CFD 智能体缺乏分层评价体系", "result": "5 方法 × 15 故障样本，Rule-based 60%，LLM 方法在 F1 边界语法故障 0/24"}}},
            {"node_key": "n6", "type": "output", "title": "存入 Ideas", "x": 1200, "y": 200, "config": {"prefix": "## 画布产出"}},
        ],
        "edges": [
            {"source_key": "n1", "target_key": "n2"},
            {"source_key": "n2", "target_key": "n3"},
            {"source_key": "n3", "target_key": "n4"},
            {"source_key": "n4", "target_key": "n5"},
            {"source_key": "n5", "target_key": "n6"},
        ],
    },
    "write": {
        "name": "草稿 → 润色 → 模拟评审",
        "nodes": [
            {"node_key": "n1", "type": "input", "title": "论文草稿", "x": 40, "y": 120,
             "config": {"text": "（贴入你当前的草稿或要点）"}},
            {"node_key": "n2", "skill_id": "paper-writing", "type": "skill", "title": "主线与创新点", "x": 320, "y": 40,
             "config": {"inputs": {"target": "短文，偏评测"}}},
            {"node_key": "n3", "skill_id": "nature-writing", "type": "skill", "title": "学术表达重构", "x": 620, "y": 40,
             "config": {"inputs": {"section": "Introduction"}}},
            {"node_key": "n4", "skill_id": "nature-polishing", "type": "skill", "title": "润色", "x": 620, "y": 220,
             "config": {"inputs": {"style": "顶会系统论文"}}},
            {"node_key": "n5", "skill_id": "nature-reviewer", "type": "skill", "title": "模拟审稿", "x": 920, "y": 130,
             "config": {"inputs": {"venue": "FSE 2026"}}},
            {"node_key": "n6", "type": "output", "title": "评审结论", "x": 1200, "y": 130, "config": {}},
        ],
        "edges": [
            {"source_key": "n1", "target_key": "n2"},
            {"source_key": "n2", "target_key": "n3"},
            {"source_key": "n3", "target_key": "n4"},
            {"source_key": "n4", "target_key": "n5"},
            {"source_key": "n5", "target_key": "n6"},
        ],
    },
    "slides": {
        "name": "论文 → 组会汇报",
        "nodes": [
            {"node_key": "n1", "type": "input", "title": "本双周进展", "x": 40, "y": 120,
             "config": {"text": "（贴入这两周做完的事与卡点）"}},
            {"node_key": "n2", "skill_id": "nature-paper2ppt", "type": "skill", "title": "汇报提纲", "x": 320, "y": 80,
             "config": {"inputs": {"minutes": "15 分钟，面向导师与同门"}}},
            {"node_key": "n3", "skill_id": "presentation-skill", "type": "skill", "title": "幻灯片设计", "x": 640, "y": 80,
             "config": {"inputs": {"constraint": "最多 12 页"}}},
            {"node_key": "n4", "type": "output", "title": "汇报材料", "x": 940, "y": 80, "config": {}},
        ],
        "edges": [
            {"source_key": "n1", "target_key": "n2"},
            {"source_key": "n2", "target_key": "n3"},
            {"source_key": "n3", "target_key": "n4"},
        ],
    },
}


# ---------------------------------------------------------------- 用户模板


def list_user() -> list[dict]:
    """读用户模板；JSON 坏了就当作空，不连累整个画布页打不开。"""
    rows = query("SELECT value FROM settings WHERE key=?", (USER_TPL_KEY,))
    if not rows:
        return []
    try:
        data = json.loads(rows[0]["value"] or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [t for t in data if isinstance(t, dict) and t.get("key") and t.get("name")]


def _write_user(items: list[dict]) -> None:
    execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (USER_TPL_KEY, json.dumps(items, ensure_ascii=False)),
    )


def _next_key(items: list[dict]) -> str:
    used = {str(t.get("key")) for t in items}
    i = 1
    while f"u{i}" in used:
        i += 1
    return f"u{i}"


def save_from_canvas(name: str, nodes: list[dict], edges: list[dict]) -> dict:
    """把一张画布的节点/连线冻结成模板。同名则覆盖，避免点两次存出两份。"""
    items = list_user()
    name = (name or "未命名模板").strip()[:40] or "未命名模板"
    snapshot = {
        "name": name,
        "nodes": [
            {
                "node_key": n["node_key"],
                "type": n.get("type") or "skill",
                "skill_id": n.get("skill_id") or None,
                "title": n.get("title") or "",
                "x": n.get("x") or 0,
                "y": n.get("y") or 0,
                "config": n.get("config") or {},
            }
            for n in nodes
        ],
        "edges": [{"source_key": e["source_key"], "target_key": e["target_key"]} for e in edges],
    }
    for i, t in enumerate(items):
        if t["name"] == name:
            items[i] = {**snapshot, "key": t["key"], "created_at": t.get("created_at") or _ts()}
            _write_user(items)
            return items[i]
    created = {**snapshot, "key": _next_key(items), "created_at": _ts()}
    items.append(created)
    _write_user(items)
    return created


def delete_user(key: str) -> bool:
    items = list_user()
    kept = [t for t in items if t["key"] != key]
    if len(kept) == len(items):
        return False
    _write_user(kept)
    return True


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------- 对外


def all_templates() -> dict[str, dict]:
    """内置 + 用户，key 唯一；用户模板用 u* 前缀，不会和内置撞。"""
    out = {k: {**v, "builtin": True} for k, v in BUILTIN.items()}
    for t in list_user():
        out[t["key"]] = {
            "name": t["name"],
            "nodes": t.get("nodes") or [],
            "edges": t.get("edges") or [],
            "builtin": False,
            "created_at": t.get("created_at") or "",
        }
    return out


def template_list() -> list[dict]:
    return [
        {
            "key": k,
            "name": v["name"],
            "node_count": len(v["nodes"]),
            "builtin": v.get("builtin", True),
            "created_at": v.get("created_at", ""),
        }
        for k, v in all_templates().items()
    ]


def get_template(key: str | None) -> dict | None:
    if not key:
        return None
    return all_templates().get(key)
