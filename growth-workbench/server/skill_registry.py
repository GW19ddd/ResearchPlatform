"""技能注册表：内置 skills/registry.json + 用户自定义 skills/custom/*.json。

一个 skill = 一个带输入槽的 prompt 模板：
  id / name / category / desc / mode(fast|reason) / inputs[{key,label,placeholder}] / system / prompt
prompt 中可用占位符：{{输入槽key}}、{{upstream}}（上游输出）、{{input}}（节点直接输入）
"""
import json
import os
from functools import lru_cache

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REGISTRY_PATH = os.path.join(BASE_DIR, "skills", "registry.json")
CUSTOM_DIR = os.path.join(BASE_DIR, "skills", "custom")

BUILTIN_FLAG = "__builtin__"


def _load_file(path: str) -> list[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    if isinstance(data, dict):
        data = [data]
    out = []
    for s in data:
        if not isinstance(s, dict) or not s.get("id"):
            continue
        s.setdefault("name", s["id"])
        s.setdefault("category", "自定义")
        s.setdefault("icon", "◇")
        s.setdefault("desc", "")
        s.setdefault("mode", "fast")
        s.setdefault("inputs", [])
        s.setdefault("system", "你是严谨的科研助手，回答用简体中文，结构化、具体、可执行。")
        s.setdefault("prompt", "{{input}}\n\n上游输入：\n{{upstream}}")
        out.append(s)
    return out


@lru_cache(maxsize=1)
def _load_all() -> tuple:
    skills = _load_file(REGISTRY_PATH)
    for s in skills:
        s["builtin"] = True
        s.setdefault("source", "builtin")
    if os.path.isdir(CUSTOM_DIR):
        for fn in sorted(os.listdir(CUSTOM_DIR)):
            if fn.endswith(".json"):
                for s in _load_file(os.path.join(CUSTOM_DIR, fn)):
                    s["builtin"] = False
                    s.setdefault("source", "custom")
                    skills.append(s)
    # GitHub 克隆下来的真实 skill（原样加载，只读不改写）
    try:
        from skill_fs import list_github_skills
        for s in list_github_skills():
            s["builtin"] = False
            s["source"] = "github"
            skills.append(s)
    except Exception as exc:  # 目录不存在或解析失败不影响内置技能
        print(f"[skill_registry] github skills skipped: {exc}")
    return tuple(skills)


def reload():
    _load_all.cache_clear()
    try:
        from skill_fs import reload as _gh
        _gh()
    except Exception:
        pass
    return list_skills()


def list_skills() -> list[dict]:
    return [dict(s) for s in _load_all()]


def get_skill(skill_id: str) -> dict | None:
    for s in _load_all():
        if s["id"] == skill_id:
            return dict(s)
    return None


def categories() -> list[dict]:
    order: list[str] = []
    grouped: dict[str, list[dict]] = {}
    for s in list_skills():
        c = s.get("category", "其他")
        if c not in grouped:
            grouped[c] = []
            order.append(c)
        grouped[c].append(s)
    return [{"name": c, "skills": grouped[c]} for c in order]


def save_custom(skill: dict) -> dict:
    os.makedirs(CUSTOM_DIR, exist_ok=True)
    path = os.path.join(CUSTOM_DIR, f"{skill['id']}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(skill, f, ensure_ascii=False, indent=2)
    reload()
    return skill


def delete_custom(skill_id: str) -> bool:
    path = os.path.join(CUSTOM_DIR, f"{skill_id}.json")
    if os.path.exists(path):
        os.remove(path)
        reload()
        return True
    return False
