"""GitHub 技能市场：搜索 / 探测 / 稀疏下载。

和 skill_fs.py 的分工：
  skill_fs  —— 已经落在本地磁盘上的 skill，怎么读出来喂给模型
  skill_market —— 还没落地的 skill，怎么从 GitHub 上找出来并取下来

设计取舍（都是踩过的坑）：
1. **不整仓 clone**。GitHub 上含 SKILL.md 的仓库动辄几百 MB（agents/、evals/、图片），
   用户真正要用的往往只是一个目录。所以这里走 codeload 的 tarball + tarfile.stream，
   边下边挑，命中 SKILL.md 的目录才落盘，其余直接跳过不占磁盘。
2. **不做代码搜索**。GitHub 的 /search/code 必须带 token，匿名一律 403。
   所以市场搜索 = 仓库搜索（关键词 + topic）→ 对候选仓库读 git/trees 判断有没有 SKILL.md。
3. **匿名配额很紧**（核心 60 次/小时、搜索 10 次/分钟）。所以：搜索结果落 settings 缓存（6 小时），
   仓库是否含 skill 的探测结果也缓存；一次搜索最多探测 PROBE_LIMIT 个仓库，不够就分页慢慢来。
   填了 token 就一切顺畅，额度 5000/小时。
4. **限流要说实话**。403 时把 GitHub 的原始 message 透出去（含 X-RateLimit-Reset），
   绝不说成「没有结果」—— 那会让用户以为这个技能不存在。
"""
import io
import json
import os
import re
import shutil
import tarfile
import time
import urllib.parse

import httpx

from db import execute, query

SET_KEY_TOKEN = "skill_market_github_token"
SET_KEY_SEARCH = "skill_market_search_cache"
SET_KEY_PROBE = "skill_market_probe_cache"

API = "https://api.github.com"
CACHE_SEARCH_SEC = 6 * 3600
CACHE_PROBE_SEC = 7 * 24 * 3600
PROBE_LIMIT = 12           # 一次搜索最多探测多少个仓库（匿名额度只有 60/小时）
TARBALL_MAX = 120 * 1024 * 1024   # 单仓 tarball 上限，超了不下载
MAX_SKILL_FILES = 400      # 单个 skill 目录最多取多少个文件
MAX_FILE_BYTES = 2 * 1024 * 1024
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip",
            ".gz", ".tar", ".mp4", ".mp3", ".woff", ".woff2", ".ttf", ".so", ".dll"}


# ---------------------------------------------------------------- settings 存取

def _get(key: str, default=""):
    rows = query("SELECT value FROM settings WHERE key=?", (key,))
    if not rows:
        return default
    try:
        return json.loads(rows[0]["value"])
    except (ValueError, TypeError):
        return default


def _set(key: str, value):
    execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def get_token() -> str:
    return str(_get(SET_KEY_TOKEN, "") or "")


def mask_token(tok: str) -> str:
    tok = (tok or "").strip()
    if not tok:
        return ""
    return "••••" + tok[-4:] if len(tok) > 4 else "••••"


def save_token(tok: str) -> dict:
    """保存 token。前端传来脱敏串（••••）表示「没改」，保持原值。"""
    tok = (tok or "").strip()
    if tok.startswith("••••"):
        return {"ok": True, "masked": mask_token(get_token()), "token_set": bool(get_token())}
    _set(SET_KEY_TOKEN, tok)
    _set(SET_KEY_PROBE, {})   # token 变了，配额口径也变了，探测缓存清掉重来
    return {"ok": True, "masked": mask_token(tok), "token_set": bool(tok)}


# ---------------------------------------------------------------- GitHub 请求

def _headers() -> dict:
    h = {"Accept": "application/vnd.github+json", "User-Agent": "growth-workbench"}
    tok = get_token()
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def _rate_hint(r: httpx.Response) -> str:
    reset = r.headers.get("X-RateLimit-Reset") or ""
    try:
        reset_at = time.strftime("%H:%M", time.localtime(int(reset))) if reset else ""
    except (ValueError, OSError):
        reset_at = ""
    return f"（额度 {reset_at} 重置）" if reset_at else ""


def gh_get(path: str, params: dict | None = None, timeout: float = 25.0) -> dict:
    """GET GitHub API。返回 {ok, data} 或 {ok:False, kind, message}。

    kind 区分三种失败，前端提示完全不同：
      rate   —— 配额用尽（该去填 token，而不是换关键词）
      auth   —— token 无效
      http   —— 其它（仓库不存在 / 网络）
    """
    url = path if path.startswith("http") else f"{API}{path}"
    try:
        with httpx.Client(timeout=timeout, headers=_headers(), follow_redirects=True) as c:
            r = c.get(url, params=params)
    except Exception as exc:  # noqa: BLE001 —— 网络异常同样要变成可展示的错误
        return {"ok": False, "kind": "http", "message": f"{type(exc).__name__}: {exc}"}

    if r.status_code == 200:
        try:
            return {"ok": True, "data": r.json()}
        except ValueError:
            return {"ok": False, "kind": "http", "message": "GitHub 返回了非 JSON 内容"}
    if r.status_code == 404:
        return {"ok": False, "kind": "http", "message": "仓库或路径不存在（可能是私有库，或默认分支名不是 main）"}
    if r.status_code in (401, 403):
        try:
            msg = (r.json() or {}).get("message") or ""
        except ValueError:
            msg = ""
        if r.status_code == 401 or "Bad credentials" in msg:
            return {"ok": False, "kind": "auth", "message": "GitHub Token 无效或已过期，去设置页重新填一个"}
        remain = r.headers.get("X-RateLimit-Remaining")
        if remain == "0" or "rate limit" in msg.lower():
            tps = "填一个 GitHub Token（无需任何权限勾选）" if not get_token() else "换用额度更大的 Token"
            return {
                "ok": False,
                "kind": "rate",
                "message": f"GitHub 匿名额度已用尽{_rate_hint(r)}，请{tps}后重试",
            }
        return {"ok": False, "kind": "http", "message": msg or "GitHub 拒绝了这次请求"}
    return {"ok": False, "kind": "http", "message": f"GitHub 返回 HTTP {r.status_code}"}


def rate_info() -> dict:
    r = gh_get("/rate_limit")
    if not r.get("ok"):
        return {"ok": False, "message": r.get("message"), "token_set": bool(get_token())}
    res = (r["data"].get("resources") or {})
    core = res.get("core") or {}
    search = res.get("search") or {}
    return {
        "ok": True,
        "token_set": bool(get_token()),
        "core": {"limit": core.get("limit", 0), "remaining": core.get("remaining", 0)},
        "search": {"limit": search.get("limit", 0), "remaining": search.get("remaining", 0)},
    }


# ---------------------------------------------------------------- 仓库名解析

_REPO_RE = re.compile(r"^(?:https?://github\.com/)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")


def parse_repo(text: str) -> tuple[str, str] | None:
    """'owner/repo' 或完整 URL → (owner, repo)。"""
    t = (text or "").strip()
    t = re.sub(r"^git@github\.com:", "https://github.com/", t)
    m = _REPO_RE.match(t)
    if not m:
        return None
    return m.group(1), m.group(2)


# ---------------------------------------------------------------- 仓库内 SKILL.md 探测

def probe_repo(owner: str, repo: str) -> dict:
    """读 git/trees 判断仓库内含哪些 SKILL.md。结果缓存 7 天。

    返回 {ok, full_name, default_branch, stars, desc, updated, skills:[{path,name,desc}]}
    """
    cache = _get(SET_KEY_PROBE, {}) or {}
    full = f"{owner}/{repo}"
    hit = cache.get(full)
    if isinstance(hit, dict) and time.time() - (hit.get("_at") or 0) < CACHE_PROBE_SEC:
        return hit.get("v") or {"ok": False, "message": "缓存损坏"}

    meta = gh_get(f"/repos/{owner}/{repo}")
    if not meta.get("ok"):
        return {"ok": False, "kind": meta.get("kind"), "message": meta.get("message"), "full_name": full}
    m = meta["data"]
    branch = m.get("default_branch") or "main"
    tree = gh_get(f"/repos/{owner}/{repo}/git/trees/{branch}", {"recursive": "1"})
    if not tree.get("ok"):
        return {"ok": False, "kind": tree.get("kind"), "message": tree.get("message"), "full_name": full}

    paths = [n["path"] for n in tree["data"].get("tree", [])
             if n.get("type") == "blob" and n["path"].endswith("SKILL.md")]
    skills = []
    for p in paths[:60]:
        d = os.path.dirname(p).replace("\\", "/")
        name = d.split("/")[-1] if d else repo
        skills.append({"path": p, "dir": d or ".", "name": name, "desc": ""})

    v = {
        "ok": True,
        "full_name": full,
        "owner": owner,
        "repo": repo,
        "default_branch": branch,
        "stars": m.get("stargazers_count", 0),
        "desc": (m.get("description") or "").strip(),
        "updated": (m.get("pushed_at") or "")[:10],
        "topics": m.get("topics") or [],
        "html_url": m.get("html_url") or f"https://github.com/{full}",
        "skills": skills,
        "skill_count": len(skills),
        "path_total": len(paths),
    }
    cache[full] = {"_at": time.time(), "v": v}
    # 缓存放不下就一直长，裁剪到最近 300 条
    if len(cache) > 300:
        keep = sorted(cache.items(), key=lambda kv: kv[1].get("_at", 0), reverse=True)[:300]
        cache = dict(keep)
    _set(SET_KEY_PROBE, cache)
    return v


# ---------------------------------------------------------------- 搜索

# 关键词按「这个人在做什么」组织，而不是按 GitHub 的标签体系。
# 市场上真正能当画布节点/对话技能用的，基本都落在 claude-skills / agent-skills 生态里。
PRESETS = [
    {"key": "all", "label": "全部", "q": "claude skills agent skill SKILL.md", "topic": "claude-skills"},
    {"key": "research", "label": "科研与写作", "q": "academic research paper writing skill"},
    {"key": "lit", "label": "文献检索", "q": "literature search citation arxiv skill"},
    {"key": "code", "label": "代码与测试", "q": "coding test generation skill agent"},
    {"key": "data", "label": "数据与实验", "q": "data analysis experiment statistics skill"},
    {"key": "write", "label": "论文润色", "q": "paper polish reviewer revision skill"},
    {"key": "slide", "label": "图表与汇报", "q": "slides ppt figure diagram skill"},
    {"key": "mcp", "label": "Agent 工具集", "q": "agent-skills mcp tools collection"},
]


def search(q: str = "", preset: str = "all", page: int = 1, force: bool = False) -> dict:
    """仓库搜索 → 探测含 SKILL.md 的仓库 → 摊平成「可安装的仓库」列表。

    返回 {ok, repos:[...], page, total, probed, note}
    """
    q = (q or "").strip()
    preset_def = next((p for p in PRESETS if p["key"] == preset), None)
    if not q and preset_def:
        q = preset_def["q"]
    if not q:
        q = PRESETS[0]["q"]
    page = max(1, int(page or 1))
    cache_key = f"{q}|{preset if not (q and preset_def and q == preset_def['q']) else preset}|{page}"
    cache = _get(SET_KEY_SEARCH, {}) or {}
    hit = cache.get(cache_key)
    if not force and isinstance(hit, dict) and time.time() - (hit.get("_at") or 0) < CACHE_SEARCH_SEC:
        return {**hit["v"], "cached": True}

    params = {"q": q, "sort": "stars", "order": "desc", "per_page": 20, "page": page}
    r = gh_get("/search/repositories", params)
    if not r.get("ok"):
        return {"ok": False, "kind": r.get("kind"), "message": r.get("message"), "repos": []}

    items = r["data"].get("items") or []
    repos: list[dict] = []
    probed = 0
    note = ""
    rate_hit = ""
    for it in items:
        if probed >= PROBE_LIMIT:
            note = f"本次只探测了前 {PROBE_LIMIT} 个仓库（GitHub 匿名额度限制），可以翻页继续找"
            break
        owner = (it.get("owner") or {}).get("login") or ""
        name = it.get("name") or ""
        if not owner or not name:
            continue
        probed += 1
        p = probe_repo(owner, name)
        if not p.get("ok"):
            if p.get("kind") == "rate":
                rate_hit = p.get("message") or "GitHub 额度用尽"
                note = rate_hit
                break
            continue
        if not p.get("skill_count"):
            continue
        repos.append({**p, "builtin_repo": it.get("full_name") == p.get("full_name")})

    # 一个都没探测成功 + 撞上限额 → 这不是「没找到」，是「没查成」。
    # 必须报错，否则用户会以为 GitHub 上真没有这个技能。
    if rate_hit and not repos:
        return {"ok": False, "kind": "rate", "message": rate_hit, "repos": []}

    out = {
        "ok": True,
        "repos": repos,
        "page": page,
        "total": r["data"].get("total_count", 0),
        "probed": probed,
        "q": q,
        "note": note,
        "token_set": bool(get_token()),
    }
    cache[cache_key] = {"_at": time.time(), "v": out}
    if len(cache) > 40:
        cache = dict(sorted(cache.items(), key=lambda kv: kv[1].get("_at", 0), reverse=True)[:40])
    _set(SET_KEY_SEARCH, cache)
    return {**out, "cached": False}


# ---------------------------------------------------------------- 稀疏下载（不整仓 clone）

def _safe_dirname(repo: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", repo)[:60] or "skill_repo"


def _already_local(owner: str, repo: str) -> bool:
    from skill_fs import GITHUB_DIR

    d = os.path.join(GITHUB_DIR, _safe_dirname(repo))
    return os.path.isdir(d)


def _fetch_tarball(url: str) -> bytes:
    """下载 tarball 到内存。超过上限直接抛错（不是截断 —— 截断的 tar 解出来是坏数据）。"""
    buf = io.BytesIO()
    size = 0
    with httpx.Client(timeout=httpx.Timeout(30.0, read=180.0), follow_redirects=True,
                      headers={"User-Agent": "growth-workbench"}) as c:
        with c.stream("GET", url) as r:
            if r.status_code != 200:
                raise RuntimeError(f"下载 tarball 失败：HTTP {r.status_code}")
            for chunk in r.iter_bytes(256 * 1024):
                size += len(chunk)
                if size > TARBALL_MAX:
                    raise RuntimeError(
                        f"仓库压缩包超过 {TARBALL_MAX // 1024 // 1024}MB，太大，改用「整仓克隆」"
                    )
                buf.write(chunk)
    return buf.getvalue()


def extract_skills(blob: bytes, dest: str, want_dirs: set[str] | None = None,
                   counter: dict | None = None) -> int:
    """把 tarball 里命中的文本文件落到 dest，返回写入文件数。

    want_dirs 为空 = 整仓（仍跳过二进制与超大文件）；
    非空 = 只取这些目录（含其 SKILL.md）。
    counter 用来把统计数字带出去（written / bytes）。
    """
    written = 0
    total = 0
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            # tarball 顶层是 "<repo>-<branch>/"
            parts = m.name.split("/", 1)
            if len(parts) < 2:
                continue
            rel = parts[1].replace("\\", "/")
            if want_dirs:
                # 目录本身也要放行：references/ 下的文件是 SKILL.md 引用的附属材料
                if not any(rel == f"{d}/SKILL.md" or rel.startswith(f"{d}/") for d in want_dirs):
                    continue
            if os.path.splitext(rel)[1].lower() in SKIP_EXT:
                continue
            if m.size > MAX_FILE_BYTES:
                continue
            if written >= MAX_SKILL_FILES:
                break
            rel = rel.lstrip("/")
            if ".." in rel.split("/"):
                continue
            dst = os.path.normpath(os.path.join(dest, rel))
            if not dst.startswith(os.path.normpath(dest) + os.sep):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            fh = tf.extractfile(m)
            if fh is None:
                continue
            with open(dst, "wb") as out:
                shutil.copyfileobj(fh, out)
            written += 1
            total += m.size
    if counter is not None:
        counter["written"] = written
        counter["bytes"] = total
    return written


def install(owner: str, repo: str, paths: list[str] | None = None, name: str = "",
            tarball: bytes | None = None) -> dict:
    """下载一个仓库里指定目录的 skill（paths 为 SKILL.md 的相对路径列表；空=全部）。

    走 codeload tarball 流式过滤，只落盘命中目录里的文本文件，其它一律不写。
    落盘后目录结构与原仓库一致（SKILL.md、references/、assets 的相对引用不会断）。

    tarball 参数只给测试用（注入本地压缩包，避免依赖网络与 GitHub 配额）。
    """
    from skill_fs import GITHUB_DIR, reload

    if not owner or not repo:
        return {"ok": False, "message": "仓库名不合法"}
    target_name = _safe_dirname(name or repo)
    target = os.path.join(GITHUB_DIR, target_name)
    if os.path.exists(target):
        return {"ok": False, "message": f"本地已经有 {target_name} 了（在技能库「GitHub」页里能看到）。"
                                      "要更新请先删掉这个目录再装。"}

    branch = "main"
    if tarball is None:
        meta = gh_get(f"/repos/{owner}/{repo}")
        if not meta.get("ok"):
            return {"ok": False, "message": meta.get("message") or "读不到仓库信息"}
        branch = meta["data"].get("default_branch") or "main"

    want_dirs: set[str] = set()
    if paths:
        for p in paths:
            d = os.path.dirname(p or "").replace("\\", "/").strip("/")
            if d:
                want_dirs.add(d)

    os.makedirs(GITHUB_DIR, exist_ok=True)
    tmp = target + ".__tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    counter: dict = {}
    try:
        if tarball is None:
            url = f"https://codeload.github.com/{owner}/{repo}/tar.gz/refs/heads/{branch}"
            tarball = _fetch_tarball(url)
        extract_skills(tarball, tmp, want_dirs or None, counter)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(tmp, ignore_errors=True)
        return {"ok": False, "message": f"下载失败：{type(exc).__name__}: {exc}"}

    written = counter.get("written", 0)
    if written == 0:
        shutil.rmtree(tmp, ignore_errors=True)
        return {"ok": False, "message": "这个仓库里没有找到可用的 SKILL.md（可能路径已变化）"}

    # 只留了某个子目录时，去掉多余的目录层级，避免出现 skills/github/repo/skills/xxx/SKILL.md
    if want_dirs and len(want_dirs) == 1:
        only = next(iter(want_dirs))
        deep = os.path.join(tmp, only)
        if os.path.isdir(deep) and os.path.isfile(os.path.join(deep, "SKILL.md")):
            shutil.rmtree(target, ignore_errors=True)
            shutil.move(deep, target)
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            shutil.rmtree(target, ignore_errors=True)
            shutil.move(tmp, target)
    else:
        shutil.rmtree(target, ignore_errors=True)
        shutil.move(tmp, target)

    found = reload()
    mine = [s for s in found if s["repo"] == target_name]
    return {
        "ok": True,
        "name": target_name,
        "path": target,
        "files": written,
        "bytes": counter.get("bytes", 0),
        "skills_found": len(mine),
        "message": f"已安装 {target_name}：{len(mine)} 个技能、{written} 个文件",
    }


def uninstall(name: str) -> dict:
    """删掉整个仓库目录（只允许删 skills/github 下的直接子目录）。"""
    from skill_fs import GITHUB_DIR, reload

    safe = _safe_dirname(name)
    if safe != name:
        return {"ok": False, "message": "仓库名不合法"}
    target = os.path.join(GITHUB_DIR, safe)
    root = os.path.normpath(GITHUB_DIR)
    if os.path.dirname(os.path.normpath(target)) != root or not os.path.isdir(target):
        return {"ok": False, "message": "本地没有这个仓库"}
    shutil.rmtree(target, ignore_errors=True)
    reload()
    return {"ok": True, "message": f"已卸载 {safe}"}
