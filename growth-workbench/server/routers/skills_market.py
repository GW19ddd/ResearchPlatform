"""技能市场 API：GitHub 搜索 / 探测 / 安装 / 卸载 / 对话技能同步。

放在独立模块里而不是塞进 canvas.py：
  canvas.py 已经是 1500 行，而且这些接口和「画布」这个对象没有关系 ——
  它们管的是「本地 skills 目录里有什么、还能从外面拿什么」，对话页和画布页都要用。
"""
import os
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import skill_market
import skill_registry
from db import execute, query

router = APIRouter(prefix="/api/skills", tags=["skills"])

SET_KEY_CHAT = "chat_skills"   # 对话页可见的 GitHub 技能（文件级白名单）


class SearchIn(BaseModel):
    q: str = ""
    preset: str = "all"
    page: int = 1
    force: bool = False


class InstallIn(BaseModel):
    repo: str = ""          # owner/repo 或完整 URL
    paths: list[str] = []   # SKILL.md 相对路径；空 = 整个仓库
    name: str = ""
    use: Literal["canvas", "chat", "both"] = "both"
    origin: str = ""        # "search" = 来自市场搜索；"clone" = 直接粘 URL 克隆，走 git clone


class TokenIn(BaseModel):
    token: str = ""


# ---------------------------------------------------------------- 市场搜索

@router.get("/market/presets")
def api_presets():
    return {"presets": skill_market.PRESETS, "token_set": bool(skill_market.get_token()),
            "token_masked": skill_market.mask_token(skill_market.get_token())}


@router.post("/market/search")
def api_search(body: SearchIn):
    r = skill_market.search(body.q, body.preset, body.page, body.force)
    if not r.get("ok"):
        # 搜索失败一律 200 + ok:false：前端要区分「量额用尽」和「没有结果」，
        # 抛 4xx 只会被 toast 成一句笼统的失败。
        return r
    installed = {s["repo"] for s in skill_registry.list_skills() if s.get("source") == "github"}
    for repo in r.get("repos", []):
        repo["installed"] = repo.get("repo") in installed
    return r


@router.get("/market/rate")
def api_rate():
    return skill_market.rate_info()


@router.post("/market/token")
def api_token(body: TokenIn):
    return skill_market.save_token(body.token)


# ---------------------------------------------------------------- 安装 / 卸载

@router.post("/market/install")
def api_install(body: InstallIn):
    name = (body.name or "").strip()
    parsed = skill_market.parse_repo(body.repo)
    if not parsed:
        raise HTTPException(400, "仓库格式应为 owner/repo 或 https://github.com/owner/repo")

    if body.origin == "clone":
        # 老路径：整仓 git clone。保留给「仓库里有构建脚本 / 需要完整目录」的情况
        from skill_fs import clone_repo

        owner, repo = parsed
        r = clone_repo(f"https://github.com/{owner}/{repo}", name)
        if not r.get("ok"):
            raise HTTPException(400, r.get("message") or "克隆失败")
        skill_registry.reload()
        out_dir = r["name"]
    else:
        owner, repo = parsed
        r = skill_market.install(owner, repo, body.paths, name)
        if not r.get("ok"):
            raise HTTPException(400, r.get("message") or "安装失败")
        skill_registry.reload()
        out_dir = r["name"]

    # 安装后把该仓库下的 GitHub 技能写进对话白名单（画布那边本来就能看到全部）
    added: list[str] = []
    if body.use in ("chat", "both"):
        ids = [s["id"] for s in skill_registry.list_skills()
               if s.get("source") == "github" and s.get("repo") == out_dir]
        cur = get_chat_ids()
        for sid in ids:
            if sid not in cur:
                cur.append(sid)
                added.append(sid)
        set_chat_ids(cur)
    skills = [s for s in skill_registry.list_skills()
              if s.get("source") == "github" and s.get("repo") == out_dir]
    return {"ok": True, "dir": out_dir, "message": r.get("message"), "skills": skills,
            "chat_added": len(added), "use": body.use}


@router.post("/market/uninstall")
def api_uninstall(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "缺少仓库名")
    # 卸载会先把目录删掉，这里必须在删除前把 id 记下来
    gone = {s["id"] for s in skill_registry.list_skills()
            if s.get("source") == "github" and s.get("repo") == name}
    r = skill_market.uninstall(name)
    if not r.get("ok"):
        raise HTTPException(400, r.get("message") or "卸载失败")
    set_chat_ids([x for x in get_chat_ids() if x not in gone])
    skill_registry.reload()
    return r


# ---------------------------------------------------------------- 本机技能

@router.get("/local")
def api_local_skills():
    """本机 WorkBuddy skills（~/.workbuddy/skills/<name>/SKILL.md）。

    只读解析 frontmatter，不返回全文 —— 全文在发消息时由 chat.py 按需读取，
    免得一次拉 86 个 SKILL.md 把前端撑爆。
    """
    import local_skills

    return {"ok": True, "root": local_skills.root_str(), "skills": local_skills.list_skills()}


# ---------------------------------------------------------------- 对话技能白名单

def get_chat_ids() -> list[str]:
    from skill_market import _get  # 复用 settings 存取（同一张表）

    v = _get(SET_KEY_CHAT, [])
    return [str(x) for x in v] if isinstance(v, list) else []


def set_chat_ids(ids: list[str]):
    from skill_market import _set

    _set(SET_KEY_CHAT, ids[:300])


class ChatSkillsIn(BaseModel):
    ids: list[str] = []


@router.get("/chat")
def api_chat_skills():
    """对话页能用的 GitHub 技能（白名单 + 完整正文，前端点卡片就能直接用）。"""
    from skill_fs import build_prompt as _gh_prompt

    enabled = set(get_chat_ids())
    out = []
    for s in skill_registry.list_skills():
        if s.get("source") != "github" or s["id"] not in enabled:
            continue
        system, _user = _gh_prompt(s["id"], {}, "", "")
        out.append({
            "id": s["id"],
            "name": s.get("name") or s["id"],
            "desc": s.get("desc") or "",
            "category": s.get("category") or "GitHub 技能",
            "repo": s.get("repo") or "",
            "rel": s.get("rel") or ".",
            "system": system or "",
        })
    return {"ok": True, "skills": out, "all_ids": sorted(enabled)}


@router.put("/chat")
def api_set_chat_skills(body: ChatSkillsIn):
    set_chat_ids([x for x in body.ids if isinstance(x, str) and x.strip()])
    return {"ok": True, "ids": get_chat_ids()}
