"""GitHub skill 原样加载器。

设计原则：**只读，绝不改写**。
克隆下来的仓库保持 git 原状（SKILL.md / references/ / agents/ / manifest.yaml 一个字都不动），
本模块只负责在运行时把这些原文读出来，原封不动地拼进 LLM 的 system prompt 与上下文，
从而让每个 GitHub skill 文件夹直接变成画布上的一个节点。

一个 GitHub skill = 一个含 SKILL.md 的目录。
  - frontmatter（name/description）→ 节点标题与说明
  - SKILL.md 正文           → system prompt（原文照搬）
  - 正文里引用到的相对文件     → 作为"附属文件原文"附在用户输入末尾
                             （因为节点里的 LLM 无法真的 Read 文件，只能把原文贴给它）
"""
import os
import re
from functools import lru_cache

import yaml

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GITHUB_DIR = os.path.join(BASE_DIR, "skills", "github")

# 扫描时跳过的目录（不是 skill 本体，或体积大且非指令）
SKIP_DIRS = {
    ".git", ".github", ".agents", ".codex-plugin", ".claude", ".claude-plugin",
    "node_modules", "__pycache__", ".venv", "venv", "tests", "evals",
    "plugin-evals", "plugin-evals-citation-check", "audits", "hooks",
    "examples", "docs", "shared", "tools", "pi", "commands", "scripts",
}
MAX_SCAN_DEPTH = 5
MAX_SKILL_MD = 120_000      # SKILL.md 本体上限（一般远小于此）
MAX_ATTACH_TOTAL = 32_000   # 附属文件总字数上限（SKILL.md 原文另算，不受此限）
MAX_ATTACH_ONE = 12_000     # 单个附属文件上限
MAX_ATTACH_FILES = 12       # 最多附带的文件数
ATTACH_SUFFIX = {".md", ".yaml", ".yml", ".json", ".txt", ".toml", ".tex"}


# ---------- frontmatter ----------

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """拆出 YAML frontmatter 与正文。解析失败时返回空 meta + 全文。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    raw = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    try:
        meta = yaml.safe_load(raw) or {}
        if not isinstance(meta, dict):
            meta = {}
    except Exception:
        meta = {}
    return meta, body


# ---------- 引用文件提取 ----------

_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
_PATH_RE = re.compile(r"(?<![\w/.-])((?:[\w.-]+/)*[\w.-]+\.(?:md|yaml|yml|json|txt|toml|tex))")


def referenced_files(body: str, skill_dir: str) -> list[str]:
    """从 SKILL.md 正文里提取它自己引用到的相对文件路径（按出现顺序去重）。"""
    found: list[str] = []
    seen: set[str] = set()

    def _add(p: str):
        p = p.strip().strip("`\"'")
        if not p or p.startswith(("http://", "https://", "#", "/")):
            return
        p = p.split("#")[0]
        if not p or p in seen:
            return
        if os.path.splitext(p)[1].lower() not in ATTACH_SUFFIX:
            return
        full = os.path.join(skill_dir, p)
        if not os.path.isfile(full):
            return
        seen.add(p)
        found.append(p)

    for m in _LINK_RE.finditer(body):
        _add(m.group(1))
    for m in _PATH_RE.finditer(body):
        _add(m.group(1))
    return found


def read_attachments(skill_dir: str, rels: list[str]) -> list[dict]:
    """读取附属文件原文。返回 [{path, content}]，超预算则截断。"""
    out, total = [], 0
    for rel in rels:
        if total >= MAX_ATTACH_TOTAL or len(out) >= MAX_ATTACH_FILES:
            break
        full = os.path.join(skill_dir, rel)
        try:
            if os.path.getsize(full) > MAX_ATTACH_ONE * 3:
                continue
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                content = f.read(MAX_ATTACH_ONE)
        except Exception:
            continue
        out.append({"path": rel, "content": content})
        total += len(content)
    return out


# ---------- 扫描 ----------

def _walk_skills() -> list[dict]:
    """扫描 GITHUB_DIR 下所有含 SKILL.md 的目录。"""
    if not os.path.isdir(GITHUB_DIR):
        return []
    results: list[dict] = []
    repos = sorted(
        d for d in os.listdir(GITHUB_DIR)
        if os.path.isdir(os.path.join(GITHUB_DIR, d)) and not d.startswith(".")
    )
    for repo in repos:
        repo_root = os.path.join(GITHUB_DIR, repo)
        for cur, dirs, files in os.walk(repo_root):
            rel = os.path.relpath(cur, repo_root).replace("\\", "/")
            depth = 0 if rel == "." else len(rel.split("/"))
            if depth > MAX_SCAN_DEPTH:
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            if "SKILL.md" not in files:
                continue
            results.append({"repo": repo, "rel": "" if rel == "." else rel, "dir": cur})
    return results


def _make_id(repo: str, rel: str, used: set[str]) -> str:
    name = rel.split("/")[-1] if rel else repo
    base = f"gh.{name}"
    sid = base
    n = 2
    while sid in used:
        sid = f"gh.{repo}.{name}" if n == 2 else f"{base}.{n}"
        n += 1
    used.add(sid)
    return sid


def _category(repo: str, name: str, desc: str = "") -> str:
    n = name.lower()
    d = (desc or "").lower()
    if "search" in n or "citation" in n or "ref-verifier" in n:
        return "文献检索与引用"
    if "reader" in n or "literature" in n or "downloader" in n:
        return "文献检索与阅读"
    if "writ" in n or "polish" in n or "proposal" in n or "paper" in n or "pipeline" in n:
        return "论文写作与润色"
    if "review" in n or "response" in n or "verifier" in n:
        return "审稿与返修"
    if "figure" in n or "ppt" in n or "card" in n or "image" in n:
        return "图表与汇报"
    if "data" in n or "statistic" in n or "experiment" in n:
        return "数据与实验"
    if "patent" in n or "research" in d:
        return "深度研究"
    return "GitHub 技能"


@lru_cache(maxsize=1)
def _scan() -> tuple:
    used: set[str] = set()
    out: list[dict] = []
    for item in _walk_skills():
        path = os.path.join(item["dir"], "SKILL.md")
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read(MAX_SKILL_MD)
        except Exception:
            continue
        meta, body = parse_frontmatter(text)
        name = str(meta.get("name") or (item["rel"].split("/")[-1] if item["rel"] else item["repo"]))
        sid = _make_id(item["repo"], item["rel"], used)
        files = referenced_files(body, item["dir"])
        # 目录内其它 markdown（references/ 下的核心说明）也登记，便于前端查看
        out.append(
            {
                "id": sid,
                "name": name,
                "repo": item["repo"],
                "rel": item["rel"] or ".",
                "dir": item["dir"],
                "source": "github",
                "builtin": False,
                "category": _category(item["repo"], name, str(meta.get("description") or "")),
                "desc": str(meta.get("description") or "").strip(),
                "icon": "⌘",
                "mode": "reason" if len(body) > 9000 else "fast",
                "body_len": len(body),
                "refs": files[:20],
                "inputs": [
                    {
                        "key": "task",
                        "label": "任务说明",
                        "placeholder": "这一步要这个 skill 做什么（可留空，直接使用上游输出）",
                    }
                ],
                "system": "",   # 运行时按原文拼装，不落库
                "prompt": "",
            }
        )
    return tuple(out)


def reload():
    _scan.cache_clear()
    return list_github_skills()


def list_github_skills() -> list[dict]:
    return [dict(s) for s in _scan()]


def get_github_skill(skill_id: str) -> dict | None:
    for s in _scan():
        if s["id"] == skill_id:
            return dict(s)
    return None


def clone_repo(url: str, name: str = "") -> dict:
    """git clone 一个 skill 仓库到 GITHUB_DIR 下。原样保存，不做任何改写。"""
    import re
    import subprocess

    url = (url or "").strip()
    if not re.match(r"^https?://", url):
        return {"ok": False, "message": "只支持 http(s) 仓库地址"}
    if not name:
        name = url.rstrip("/").split("/")[-1]
        if name.endswith(".git"):
            name = name[:-4]
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:60]
    if not name:
        return {"ok": False, "message": "无法确定仓库名"}
    target = os.path.join(GITHUB_DIR, name)
    if os.path.exists(target):
        return {"ok": False, "message": f"目录已存在：{name}（如需更新请删掉后重新克隆）"}
    os.makedirs(GITHUB_DIR, exist_ok=True)
    try:
        p = subprocess.run(
            ["git", "clone", "--depth", "1", url, target],
            capture_output=True,
            text=True,
            timeout=600,
        )
    except Exception as exc:
        return {"ok": False, "message": f"{type(exc).__name__}: {exc}"}
    if p.returncode != 0:
        return {"ok": False, "message": (p.stderr or p.stdout or "")[:600]}
    reload()
    found = [s for s in list_github_skills() if s["repo"] == name]
    return {
        "ok": True,
        "name": name,
        "path": target,
        "skills_found": len(found),
        "message": f"已克隆 {name}，识别到 {len(found)} 个 skill",
    }


def reload_all():
    """同时刷新 github 与内置注册表。"""
    reload()
    try:
        from skill_registry import reload as _r
        _r()
    except Exception:
        pass
    return list_github_skills()


# ---------- 读取原文件 ----------

def read_skill_md(skill_id: str) -> dict:
    """返回某个 github skill 的 SKILL.md 原文（含 frontmatter）。"""
    s = get_github_skill(skill_id)
    if not s:
        return {"ok": False, "message": "not found"}
    path = os.path.join(s["dir"], "SKILL.md")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(MAX_SKILL_MD)
    except Exception as exc:
        return {"ok": False, "message": f"{type(exc).__name__}: {exc}"}
    meta, body = parse_frontmatter(text)
    return {
        "ok": True,
        "id": skill_id,
        "repo": s["repo"],
        "rel": s["rel"],
        "frontmatter": meta,
        "body": body,
        "raw": text[:20000],
    }


def list_files(skill_id: str) -> dict:
    """列出 skill 目录的文件树（只读展示）。"""
    s = get_github_skill(skill_id)
    if not s:
        return {"ok": False, "files": []}
    root = s["dir"]
    files: list[dict] = []
    for cur, dirs, fs in os.walk(root):
        dirs[:] = [d for d in dirs if d != ".git" and not d.startswith(".")]
        for fn in fs:
            full = os.path.join(cur, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            try:
                size = os.path.getsize(full)
            except Exception:
                size = 0
            files.append({"path": rel, "size": size})
    files.sort(key=lambda x: x["path"])
    return {"ok": True, "id": skill_id, "repo": s["repo"], "root": root, "files": files[:400]}


def read_file(skill_id: str, rel: str) -> dict:
    """读取 skill 目录内任意文件的原文（防目录穿越）。"""
    s = get_github_skill(skill_id)
    if not s:
        return {"ok": False, "message": "not found"}
    rel = (rel or "").replace("\\", "/").lstrip("/")
    if ".." in rel.split("/"):
        return {"ok": False, "message": "非法路径"}
    full = os.path.normpath(os.path.join(s["dir"], rel))
    if not full.startswith(os.path.normpath(s["dir"])):
        return {"ok": False, "message": "非法路径"}
    if not os.path.isfile(full):
        return {"ok": False, "message": "文件不存在"}
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(60000)
    except Exception as exc:
        return {"ok": False, "message": f"{type(exc).__name__}: {exc}"}
    return {"ok": True, "path": rel, "content": content}


# ---------- 拼装 prompt（原文照搬） ----------

RUNNER_NOTE = """\
---
【运行环境说明】（本平台自动附加，不改动上面的 skill 原文）

你现在运行在一个科研画布（Dify 式编排）的单个节点里：
1. 上面的内容是该 skill 的 SKILL.md 原文，请严格按其规则执行。
2. 你无法真的读写磁盘文件，因此本 skill 引用到的附属文件原文已贴在下方「附属文件原文」里，
   请按 SKILL.md 的指示阅读并运用它们，不要再说"我需要先读取某文件"。
3. 本节点的实际任务在「任务输入」里；上游节点的产出在「上游输出」里。
4. 直接产出最终结果，不要输出等待确认的提问；若确实缺少关键信息，在末尾用「待补充：」列出。
5. 输出语言随任务输入；无明确要求时按 SKILL.md 的默认语言。
"""


def build_prompt(skill_id: str, slots: dict | None, upstream: str, direct: str = ""):
    """把 GitHub skill 原文拼成 (system, user)。"""
    s = get_github_skill(skill_id)
    if not s:
        return None, None
    path = os.path.join(s["dir"], "SKILL.md")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(MAX_SKILL_MD)
    except Exception:
        return None, None
    _meta, body = parse_frontmatter(text)

    system = body.strip() + "\n\n" + RUNNER_NOTE

    task = ""
    if isinstance(slots, dict):
        task = str(slots.get("task") or slots.get("input") or "").strip()
    if not task:
        task = (direct or "").strip()

    parts = []
    parts.append("## 任务输入\n" + (task or "（未指定，请依据上游输出与 skill 规则自行判断该做什么）"))
    if (upstream or "").strip():
        parts.append("## 上游节点输出\n" + upstream.strip()[:12000])
    atts = read_attachments(s["dir"], referenced_files(body, s["dir"]))
    if atts:
        buf = ["## 附属文件原文（SKILL.md 引用的文件，原文照贴）"]
        for a in atts:
            buf.append(f"\n### `{a['path']}`\n{a['content']}")
        parts.append("\n".join(buf))
    user = "\n\n".join(parts)
    return system, user
