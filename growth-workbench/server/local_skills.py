"""本机 WorkBuddy 技能（~/.workbuddy/skills/<name>/SKILL.md）只读加载。

浏览器不能直接读本机文件，所以由后端扫描目录、解析 frontmatter，供对话页
「@ 添加技能」浮层列出；真正发送时再由 chat.py 把 SKILL.md 原文注入本轮 system。

只读：这些目录是 WorkBuddy 客户端管理的原版 skill，绝不改写。
安全：只允许读取 ROOT 下、文件名为 SKILL.md 的文件，防止任意文件读取。
"""
from __future__ import annotations

import os
import re
from pathlib import Path

_ENV_ROOT = "WB_LOCAL_SKILLS_ROOT"

# 读盘上限（防御极端文件），不是注入预算
MAX_READ = 200000
# 单个技能注入 system 的预算；多个技能叠加的总预算由 chat.py 控制
MAX_INJECT = 16000


def root() -> Path:
    p = os.environ.get(_ENV_ROOT, "").strip()
    if p:
        return Path(p).expanduser()
    return Path.home() / ".workbuddy" / "skills"


def root_str() -> str:
    return str(root())


def _unquote(v: str) -> str:
    v = (v or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.strip()


def parse_frontmatter(text: str) -> dict[str, str]:
    """只取 SKILL.md frontmatter 的 name / description。

    不引 PyYAML：本机 86 个 skill 的 frontmatter 是 YAML 的一个很小子集
    （标量 + `>` 折叠块 + 一个嵌套 metadata 块），手写解析更轻也更可控。
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta: dict[str, str] = {}
    key = ""
    buf: list[str] = []
    folded = False
    for line in lines[1:]:
        if line.strip() in ("---", "..."):
            break
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if m:
            if key:
                meta[key] = " ".join(x for x in buf if x).strip()
            key = m.group(1).lower()
            v = m.group(2).strip()
            folded = v in (">", "|", ">-", "|-", ">+", "|+")
            buf = [] if folded else ([_unquote(v)] if v else [])
        elif key and folded and (line.startswith(" ") or line.startswith("\t")):
            buf.append(line.strip())
    if key:
        meta[key] = " ".join(x for x in buf if x).strip()
    return meta


def strip_frontmatter(text: str) -> str:
    """去掉 frontmatter，只留 SKILL.md 正文（注入 system 时不需要元数据）。"""
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() in ("---", "..."):
                return "\n".join(lines[i + 1:]).strip()
    return text.strip()


def list_skills() -> list[dict]:
    """扫描一级子目录里的 SKILL.md，返回列表给前端浮层。"""
    r = root()
    if not r.is_dir():
        return []
    out: list[dict] = []
    for d in sorted(r.iterdir(), key=lambda p: p.name.lower()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        md = d / "SKILL.md"
        if not md.is_file():
            continue
        try:
            head = md.read_text(encoding="utf-8", errors="replace")[:8000]
        except OSError:
            head = ""
        meta = parse_frontmatter(head)
        out.append({
            "id": "local:" + d.name,
            "name": meta.get("name") or d.name,
            "desc": meta.get("description") or "",
            "dir": d.name,
            "path": str(md),
        })
    return out


def _allowed_roots() -> set[Path]:
    """允许的根集合。

    注意 Windows 上 ~/.workbuddy/skills/<name> 常是 junction，真实指向
    .skills-manager/skills/<name>；resolve() 后路径会「跑出」ROOT。
    所以把 ROOT 本身和每个一级子目录的原始/真实路径都列为合法根。
    """
    r = root()
    roots: set[Path] = {r, r.resolve()}
    try:
        for d in r.iterdir():
            if d.is_dir() and not d.name.startswith("."):
                roots.add(d)
                roots.add(d.resolve())
    except OSError:
        pass
    return roots


def _safe_md(path_str: str) -> Path | None:
    """路径必须落在允许根内且文件名是 SKILL.md，否则拒绝（防任意文件读取）。"""
    raw = (path_str or "").strip().strip('"').strip("'")
    if not raw:
        return None
    try:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        if p.is_dir():
            p = p / "SKILL.md"
        if p.name.lower() != "skill.md" or not p.is_file():
            return None
        real = p.resolve()
    except (OSError, ValueError):
        return None
    roots = _allowed_roots()
    # 原始路径与真实路径任一落在允许根内即可（覆盖 junction / symlink）
    if not any(c.is_relative_to(r) for c in (p, real) for r in roots):
        return None
    return real


def clip_text(text: str, limit: int) -> str:
    """规程太长时保头又保尾。

    SKILL.md 的状态机、checkpoint 规则、reference 清单常在文件中后段；
    只切前 N 字会把这些全丢光，还会截出半句话。与画布 `_clip_upstream`
    同款约定：头 60% / 尾 40%，中间放显式省略标记，尽量落在换行边界。
    """
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    marker = "\n\n…（规程过长，中间部分已省略；以下保留结尾。完整原文请读取本机 SKILL.md）…\n\n"
    room = max(limit - len(marker), 200)
    head = int(room * 0.6)
    tail = room - head
    h = text[:head]
    cut = h.rfind("\n")
    if cut > head * 0.7:
        h = h[:cut]
    t = text[-tail:] if tail > 0 else ""
    cut = t.find("\n")
    if 0 < cut < tail * 0.3:
        t = t[cut + 1:]
    return h + marker + t


def _read(p: Path | None) -> str:
    if not p:
        return ""
    try:
        text = p.read_text(encoding="utf-8", errors="replace")[:MAX_READ]
    except OSError:
        return ""
    return clip_text(strip_frontmatter(text), MAX_INJECT)


def read_id(skill_id: str) -> str:
    """`local:<dirname>` → SKILL.md 正文。"""
    name = (skill_id or "").strip()
    if not name.startswith("local:"):
        return ""
    name = name[6:]
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        return ""
    return _read(_safe_md(str(root() / name / "SKILL.md")))


def read_path(path_str: str) -> str:
    """用户粘贴的 `@skill:"C:\\...\\SKILL.md"` → SKILL.md 正文。"""
    return _read(_safe_md(path_str))
