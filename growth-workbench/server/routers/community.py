"""科研社区：发帖 / 读帖 / 评论 / 点赞 / 收藏。

设计取舍：
- 本地单用户工作台，作者与点赞人仍按 user_id 存，将来接多用户或导出不用重写表。
- 列表接口不返回正文（正文最长 2 万字，60 条一起拉太浪费）；详情才带 content。
- 内置示例帖一律 is_sample=1，前端在卡片上标「示例」，不把演示内容伪装成真实交流。
- 写操作都由 main.py 的 Idempotency-Key 中间件兜底，这里不重复造轮子。
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth as auth_core
from crud import patch_row, row_or_404
from db import execute, now, query

router = APIRouter(prefix="/api/community", tags=["community"])

# 「全部」只是前端筛选态，不是落库的分类
CATEGORIES = [
    "论文速递",
    "研究笔记",
    "方法讨论",
    "实验复盘",
    "数据集",
    "工具与代码",
    "投稿与审稿",
    "组会纪要",
    "资源分享",
    "求助问答",
    "学术动态",
]
KINDS = {"discussion": "讨论", "note": "笔记", "question": "提问", "share": "分享", "review": "复盘"}
COVER_STYLES = {"paper", "grid", "chart", "nodes", "quote", "code", "formula", "wave"}

LIST_COLS = """p.id, p.title, p.summary, p.category, p.kind, p.tags, p.cover_style, p.cover_url,
               p.author_id, p.author_name, p.author_hue, p.is_sample, p.views, p.likes,
               p.favorites, p.comments_count, p.pinned, p.created_at, p.updated_at"""

ORDERS = {
    "latest": "p.pinned DESC, p.created_at DESC, p.id DESC",
    "hot": "p.pinned DESC, (p.likes*2 + p.comments_count*3 + p.views) DESC, p.id DESC",
    "views": "p.pinned DESC, p.views DESC, p.id DESC",
    "comments": "p.pinned DESC, p.comments_count DESC, p.id DESC",
}


# ------------------------------------------------------------------ 身份 / 工具


def _actor(request: Request) -> dict:
    """当前操作者。没建账户时（require_login 全放行）退回匿名本机身份。"""
    token = request.cookies.get(auth_core.SESSION_COOKIE) or ""
    if not token:
        h = request.headers.get("authorization") or ""
        if h.lower().startswith("bearer "):
            token = h[7:].strip()
    u = auth_core.resolve_session(token)
    if not u:
        return {"id": 0, "name": "本机研究者", "hue": 240}
    return {
        "id": int(u["id"]),
        "name": (u["display_name"] or u["username"] or "本机研究者").strip(),
        "hue": int(u["avatar_hue"] or 240),
    }


def _public(row: dict) -> dict:
    """把 SQLite 的 0/1 反应标记转成布尔，前端不用再判 ==1。"""
    out = dict(row)
    if "liked" in out:
        out["liked"] = bool(out["liked"])
    if "favorited" in out:
        out["favorited"] = bool(out["favorited"])
    out["is_sample"] = bool(out.get("is_sample"))
    return out


def _as_dict(body: BaseModel, partial: bool = False) -> dict:
    """pydantic v1 / v2 都能用。partial=True 时只取真正传了的字段。"""
    if hasattr(body, "model_dump"):
        return body.model_dump(exclude_unset=partial)
    return body.dict(exclude_unset=partial)


def _clean_post(raw: dict, partial: bool = False) -> dict:
    """发帖 / 改帖的字段约束集中在这里，不信任前端传进来的枚举值。"""
    out: dict = {}
    for k in ("title", "summary", "content", "tags", "cover_url"):
        if partial and k not in raw:
            continue
        v = raw.get(k)
        out[k] = str(v or "").strip()

    if not partial or "title" in raw:
        if not out["title"]:
            raise HTTPException(400, "标题不能为空")
        out["title"] = out["title"][:120]
    if not partial or "content" in raw:
        if not out["content"]:
            raise HTTPException(400, "正文不能为空")
        out["content"] = out["content"][:20000]
    out["summary"] = out.get("summary", "")[:300]
    out["tags"] = out.get("tags", "")[:200]
    out["cover_url"] = out.get("cover_url", "")[:500]

    if not partial or "category" in raw:
        cat = str(raw.get("category") or "方法讨论")
        out["category"] = cat if cat in CATEGORIES else "方法讨论"
    if not partial or "kind" in raw:
        kind = str(raw.get("kind") or "discussion")
        out["kind"] = kind if kind in KINDS else "discussion"
    if not partial or "cover_style" in raw:
        style = str(raw.get("cover_style") or "paper")
        out["cover_style"] = style if style in COVER_STYLES else "paper"
    return out


def _owner(post_id: int, request: Request) -> dict:
    """示例帖谁都能清理；真实帖只有作者本人能改 / 删。"""
    post = row_or_404("community_posts", post_id)
    if post["author_id"] != _actor(request)["id"] and not post["is_sample"]:
        raise HTTPException(403, "只能编辑或删除自己发布的帖子")
    return post


# ------------------------------------------------------------------ 读


@router.get("/posts")
def list_posts(
    request: Request,
    q: str = "",
    category: str = "全部",
    sort: str = "latest",
    favorites: bool = False,
    mine: bool = False,
    limit: int = 60,
    offset: int = 0,
):
    uid = _actor(request)["id"]
    where: list[str] = []
    args: list = []

    kw = (q or "").strip().lower()
    if kw:
        like = f"%{kw}%"
        where.append(
            "(lower(p.title) LIKE ? OR lower(coalesce(p.summary,'')) LIKE ? "
            "OR lower(p.content) LIKE ? OR lower(coalesce(p.tags,'')) LIKE ?)"
        )
        args.extend([like] * 4)
    if category and category != "全部":
        if category not in CATEGORIES:
            raise HTTPException(400, "未知分类")
        where.append("p.category = ?")
        args.append(category)
    if favorites:
        where.append(
            "EXISTS(SELECT 1 FROM community_reactions r WHERE r.post_id=p.id "
            "AND r.user_id=? AND r.kind='favorite')"
        )
        args.append(uid)
    if mine:
        where.append("p.author_id = ?")
        args.append(uid)

    clause = (" WHERE " + " AND ".join(where)) if where else ""
    total = query("SELECT COUNT(*) c FROM community_posts p" + clause, tuple(args))[0]["c"]
    limit = max(1, min(120, int(limit or 60)))
    offset = max(0, int(offset or 0))
    order = ORDERS.get(sort, ORDERS["latest"])

    rows = query(
        f"""SELECT {LIST_COLS},
                   EXISTS(SELECT 1 FROM community_reactions r
                          WHERE r.post_id=p.id AND r.user_id=? AND r.kind='like') AS liked,
                   EXISTS(SELECT 1 FROM community_reactions r2
                          WHERE r2.post_id=p.id AND r2.user_id=? AND r2.kind='favorite') AS favorited
            FROM community_posts p {clause}
            ORDER BY {order} LIMIT ? OFFSET ?""",
        tuple([uid, uid] + args + [limit, offset]),
    )
    counts = {
        r["category"]: r["c"]
        for r in query("SELECT category, COUNT(*) c FROM community_posts GROUP BY category")
    }
    return {
        "items": [_public(r) for r in rows],
        "total": total,
        "counts": counts,
        "categories": CATEGORIES,
        "kinds": KINDS,
    }


@router.get("/posts/{post_id}")
def get_post(post_id: int, request: Request):
    """打开详情即记一次阅读。列表不会被这个计数影响（列表不调本接口）。"""
    row_or_404("community_posts", post_id)
    execute("UPDATE community_posts SET views = views + 1 WHERE id=?", (post_id,))
    uid = _actor(request)["id"]
    rows = query(
        """SELECT p.*,
                  EXISTS(SELECT 1 FROM community_reactions r
                         WHERE r.post_id=p.id AND r.user_id=? AND r.kind='like') AS liked,
                  EXISTS(SELECT 1 FROM community_reactions r2
                         WHERE r2.post_id=p.id AND r2.user_id=? AND r2.kind='favorite') AS favorited
           FROM community_posts p WHERE p.id=?""",
        (uid, uid, post_id),
    )
    comments = query(
        "SELECT * FROM community_comments WHERE post_id=? ORDER BY created_at ASC, id ASC",
        (post_id,),
    )
    return {"post": _public(rows[0]), "comments": comments}


# ------------------------------------------------------------------ 帖子的写


class PostIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=20000)
    summary: str = Field(default="", max_length=300)
    category: str = "方法讨论"
    kind: str = "discussion"
    tags: str = Field(default="", max_length=200)
    cover_style: str = "paper"
    cover_url: str = Field(default="", max_length=500)


class PostPatch(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    content: str | None = Field(default=None, max_length=20000)
    summary: str | None = Field(default=None, max_length=300)
    category: str | None = None
    kind: str | None = None
    tags: str | None = Field(default=None, max_length=200)
    cover_style: str | None = None
    cover_url: str | None = Field(default=None, max_length=500)


@router.post("/posts")
def create_post(body: PostIn, request: Request):
    d = _clean_post(_as_dict(body))
    a = _actor(request)
    ts = now()
    pid = execute(
        """INSERT INTO community_posts
           (title, summary, content, category, kind, tags, cover_style, cover_url,
            author_id, author_name, author_hue, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            d["title"], d["summary"], d["content"], d["category"], d["kind"],
            d["tags"], d["cover_style"], d["cover_url"],
            a["id"], a["name"], a["hue"], ts, ts,
        ),
    )
    return {"ok": True, "id": pid}


@router.patch("/posts/{post_id}")
def update_post(post_id: int, body: PostPatch, request: Request):
    _owner(post_id, request)
    d = _clean_post(_as_dict(body, partial=True), partial=True)
    _, after = patch_row("community_posts", post_id, d, allowed=set(d))
    return {"ok": True, "post": after}


@router.delete("/posts/{post_id}")
def delete_post(post_id: int, request: Request):
    _owner(post_id, request)
    execute("DELETE FROM community_comments WHERE post_id=?", (post_id,))
    execute("DELETE FROM community_reactions WHERE post_id=?", (post_id,))
    execute("DELETE FROM community_posts WHERE id=?", (post_id,))
    return {"ok": True}


# ------------------------------------------------------------------ 点赞 / 收藏


def _toggle(post_id: int, request: Request, kind: str) -> dict:
    row_or_404("community_posts", post_id)
    uid = _actor(request)["id"]
    hit = query(
        "SELECT id FROM community_reactions WHERE post_id=? AND user_id=? AND kind=?",
        (post_id, uid, kind),
    )
    if hit:
        execute("DELETE FROM community_reactions WHERE id=?", (hit[0]["id"],))
        active = False
    else:
        execute(
            "INSERT INTO community_reactions (post_id, user_id, kind, created_at) VALUES (?,?,?,?)",
            (post_id, uid, kind, now()),
        )
        active = True
    col = "likes" if kind == "like" else "favorites"
    execute(
        f"UPDATE community_posts SET {col}=MAX(0, {col}+?) WHERE id=?",
        (1 if active else -1, post_id),
    )
    n = query(f"SELECT {col} n FROM community_posts WHERE id=?", (post_id,))[0]["n"]
    return {"ok": True, "kind": kind, "active": active, "count": n}


@router.post("/posts/{post_id}/like")
def toggle_like(post_id: int, request: Request):
    return _toggle(post_id, request, "like")


@router.post("/posts/{post_id}/favorite")
def toggle_favorite(post_id: int, request: Request):
    return _toggle(post_id, request, "favorite")


# ------------------------------------------------------------------ 评论


class CommentIn(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    parent_id: int | None = None


@router.post("/posts/{post_id}/comments")
def add_comment(post_id: int, body: CommentIn, request: Request):
    row_or_404("community_posts", post_id)
    text = (body.content or "").strip()
    if not text:
        raise HTTPException(400, "评论不能为空")
    parent = int(body.parent_id or 0) or None
    if parent:
        p = query("SELECT post_id FROM community_comments WHERE id=?", (parent,))
        if not p or p[0]["post_id"] != post_id:
            raise HTTPException(400, "被回复的评论不在这篇帖子里")
    a = _actor(request)
    cid = execute(
        """INSERT INTO community_comments
           (post_id, parent_id, author_id, author_name, author_hue, content, created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (post_id, parent, a["id"], a["name"], a["hue"], text[:2000], now()),
    )
    execute("UPDATE community_posts SET comments_count=comments_count+1 WHERE id=?", (post_id,))
    row = query("SELECT * FROM community_comments WHERE id=?", (cid,))[0]
    return {"ok": True, "comment": row}


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: int, request: Request):
    row = row_or_404("community_comments", comment_id)
    uid = _actor(request)["id"]
    post = query("SELECT is_sample FROM community_posts WHERE id=?", (row["post_id"],))
    # 内置示例帖下的示例评论谁都能清掉，真实评论只有作者本人能删
    sample = bool(post and post[0]["is_sample"])
    if row["author_id"] != uid and not sample:
        raise HTTPException(403, "只能删除自己的评论")
    execute("DELETE FROM community_comments WHERE id=?", (comment_id,))
    execute(
        "UPDATE community_posts SET comments_count=MAX(0, comments_count-1) WHERE id=?",
        (row["post_id"],),
    )
    return {"ok": True}


# ------------------------------------------------------------------ 内置示例


SEED_POSTS: list[dict] = [
    {
        "title": "把一篇论文的「痛点」整理成可验证的创新点",
        "summary": "读完就忘是常态。用一张表把局限、证据、可验证假设钉住，再决定值不值得立项。",
        "category": "研究笔记", "kind": "note", "tags": "文献,创新点,痛点表", "cover_style": "paper",
        "content": "## 为什么单独记一张痛点表\n\n读文献时最容易被「作者自己说的局限」带跑，但那往往只是未来工作的一句话。真正能变成选题的痛点，至少要能回答三件事：\n\n1. **现象**：在哪个数据集 / 哪类任务上能观察到？\n2. **证据**：论文里的哪一段、哪张表支持这个判断？\n3. **可验证假设**：换一种做法后，用什么指标能看出差别？\n\n## 落地格式\n\n| 局限 | 证据位置 | 可能的原因 | 可验证假设 | 对应实验 |\n|---|---|---|---|---|\n| … | §4.2 / Table 3 | … | … | … |\n\n写不进「可验证假设」那一列的，先留在 backlog，不要硬凑成创新点。",
    },
    {
        "title": "组会汇报的金字塔结构：结论先行怎么落地",
        "summary": "不是把结论放到第一页就行，而是让每页的标题本身连成一条论证链。",
        "category": "组会纪要", "kind": "note", "tags": "组会,汇报,表达", "cover_style": "quote",
        "content": "## 一个可复用的检查法\n\n把每页标题单独抄出来，连成一段话读一遍。如果读起来不像一个完整的论证，说明缺的是结构，不是动画。\n\n- 第 1 页：这周结论是什么（一句话，可被质疑）\n- 第 2 页：支撑结论的证据在哪（真实 / 模拟 / 示意，口径写清楚）\n- 第 3 页：还缺什么、下周补什么\n\n## 常见坑\n\n把「做了什么」当结论。「跑了 3 组消融」是工作，「消融显示 X 模块贡献主要来自 Y」才是结论。",
    },
    {
        "title": "文献对比矩阵该记哪几列",
        "summary": "列太多记不动，列太少比不出差异。一份够用的最小列集。",
        "category": "方法讨论", "kind": "discussion", "tags": "文献矩阵,对比,模板", "cover_style": "grid",
        "content": "## 最小列集\n\n| 列 | 作用 |\n|---|---|\n| 问题设定 | 保证在比同一件事 |\n| 核心机制 | 一句话说清方法差异 |\n| 数据 / 基准 | 可比性的前提 |\n| 指标口径 | 分母是什么、是否同种子 |\n| 主要局限 | 后面接痛点表 |\n\n## 使用建议\n\n矩阵不是文献笔记的替代品，它只回答「这几篇之间差在哪」。细节回原文，别在矩阵里抄摘要。",
    },
    {
        "title": "消融实验设计清单：变量、基线、种子与口径",
        "summary": "开跑之前先花十分钟把这张清单填完，能省下重跑两轮的时间。",
        "category": "实验复盘", "kind": "review", "tags": "消融,基线,复现", "cover_style": "chart",
        "content": "## 开跑前\n\n- [ ] 一次只改一个变量，变量名写进结果文件名\n- [ ] 基线集合固定，别中途加新的\n- [ ] 随机种子、运行次数、置信区间口径写死\n- [ ] 输出目录按时间戳新建，禁止覆盖旧结果\n\n## 落盘时\n\n结果文件要能自证来源：命令、环境、代码版本、输入文件各留一份摘要。事后补记的记录，可信度永远低于当场记的。",
    },
    {
        "title": "检索式怎么写：从关键词到去重入库",
        "summary": "关键词堆得越多不代表越全，先固定同义词表再扩检索面。",
        "category": "论文速递", "kind": "note", "tags": "检索,OpenAlex,去重", "cover_style": "nodes",
        "content": "## 三步\n\n1. **同义词表**：把主题词、缩写、旧称列成一张表，检索式由它生成，不靠临时想。\n2. **分层扩检**：先精确短语，再放宽到主题字段，最后才用引文滚雪球。\n3. **去重**：DOI 优先，其次标题规范化 + 年份；把命中来源记下来，方便回溯为什么收了这篇。\n\n## 别忘了\n\n检索式本身要存档。三个月后想复现「当时搜到 87 篇」，没有检索式就只能靠回忆。",
    },
    {
        "title": "Zotero 本地 API 与 PDF 归档的联动",
        "summary": "条目、附件、阅读状态分三处存，靠一个稳定的键串起来。",
        "category": "工具与代码", "kind": "share", "tags": "Zotero,PDF,工具链", "cover_style": "code",
        "content": "## 一条可用的链路\n\n`Zotero 本地 API → 条目元数据 → 文献库`\n`附件路径 → PDF 阅读器 → 笔记回写`\n\n## 注意\n\n- 本地 API 取顶层条目要用 `/items/top`，否则子附件会混进列表。\n- PDF 路径可能因迁移失效，存相对路径 + 一个候选搜索比存绝对路径稳。\n- 阅读状态属于工作台，不要写回 Zotero，避免两边互相覆盖。",
    },
    {
        "title": "投稿前自查：图表口径与真实 / 模拟数据标注",
        "summary": "每张图都要能回答「这个数字从哪来」，并在图注里写清数据性质。",
        "category": "投稿与审稿", "kind": "review", "tags": "投稿,图表,可复现", "cover_style": "formula",
        "content": "## 逐图自查\n\n- 数据来源：真实测量 / 模拟 / 示意，图注显式标注\n- 指标定义：分子分母、平均方式、误差棒含义\n- 样本量 n：写清是任务数、模块数还是重复次数\n- 图与代码：生成脚本可定位，图不是手工改过的\n\n## 一句话原则\n\n读者不该靠猜来判断一个数字是不是真的。",
    },
    {
        "title": "求助：多 provider 调用超时该怎么分流？",
        "summary": "慢模型排队、快模型兜底，但重试策略一不小心就把错误放大。",
        "category": "求助问答", "kind": "question", "tags": "LLM,超时,工程", "cover_style": "wave",
        "content": "## 现状\n\n同一个任务会走不同 provider，有的偶发超时，有的返回空内容。想请教大家怎么定重试边界：\n\n- 哪些错误值得重试，哪些应当直接降级？\n- 超时后的重试要不要换 provider？\n- 怎么避免「重试一次写两条记录」？\n\n欢迎在评论里贴自己踩过的坑。",
    },
    {
        "title": "开放获取资源清单：预印本、索引与全文",
        "summary": "按用途分三类，找全文时少走弯路。",
        "category": "资源分享", "kind": "share", "tags": "OA,arXiv,OpenAlex", "cover_style": "grid",
        "content": "## 按用途分\n\n- **找线索**：arXiv、OpenAlex、Semantic Scholar\n- **找全文**：PMC、DOAJ、Unpaywall、机构仓储\n- **找代码与数据**：Papers With Code、GitHub、Hugging Face\n\n## 使用顺序\n\n先查 OA 版本再考虑其它渠道；把「找过但没找到」也记下来，下次不用重复劳动。",
    },
    {
        "title": "数据集版本管理：给每次跑批留一份可追溯记录",
        "summary": "同一份数据换了切片，结果就不可比。版本号比文件名更可靠。",
        "category": "数据集", "kind": "note", "tags": "数据集,版本,溯源", "cover_style": "chart",
        "content": "## 最小记录\n\n| 字段 | 说明 |\n|---|---|\n| version | 内容 hash 或语义化版本 |\n| split | 训练 / 验证 / 测试的划分规则与种子 |\n| source | 原始来源与获取时间 |\n| run_ref | 哪些实验结果引用了它 |\n\n改了数据就换版本，不要原地覆盖。结果表里只存版本号，不存「最新版」这种会漂移的指代。",
    },
    {
        "title": "近期 LLM 单元测试生成方向的阅读清单",
        "summary": "按「生成 → 反馈 → 修复 → 评估」四段整理，便于找自己那一步的位置。",
        "category": "学术动态", "kind": "discussion", "tags": "LLM,测试生成,综述", "cover_style": "paper",
        "content": "## 四段框架\n\n1. **生成**：提示策略、上下文构造、覆盖率引导\n2. **反馈**：编译 / 执行 / 变异 / 覆盖信号如何回灌\n3. **修复**：定位到语句级还是模块级，是否需要训练\n4. **评估**：指标口径、基准规模、统计显著性\n\n## 读的时候记什么\n\n每篇只记三件事：它改进了哪一段、用了什么信号、评估口径是否和自己的设定可比。详见评论区补充。",
    },
    {
        "title": "画布流水线的上下文裁剪：头尾都别丢",
        "summary": "上游输出一长就爆窗口，全截中间会同时丢掉动机和结论。",
        "category": "工具与代码", "kind": "review", "tags": "画布,上下文,裁剪", "cover_style": "code",
        "content": "## 一个稳妥的默认\n\n超长上游文本按「头 60% + 尾 40%」裁剪，中间用一行省略提示衔接。开头的任务描述和结尾的结论往往比中间的推导更重要。\n\n## 别忘同步\n\n裁剪逻辑放在一处，凡是构造 prompt 的入口都调同一个函数；两处各写一遍，迟早一边忘了更新。",
    },
    {
        "title": "发帖公约：把问题写成别人能回答的样子",
        "summary": "置顶。发帖前花一分钟交代背景、已试过的做法和想要的结果，回复质量会完全不同。",
        "category": "资源分享", "kind": "discussion", "tags": "社区,公约,提问", "cover_style": "paper", "pinned": 1,
        "content": "## 一个好帖子至少有四行\n\n1. **背景**：我在做什么、卡在哪一步\n2. **已试过**：哪些做法没用、报了什么错\n3. **想要什么**：一个可验证的答案、一个反例、还是只要有人指条路\n4. **口径**：涉及数字时，写清是真实测量、模拟还是示意\n\n## 关于这个社区\n\n- 内容是存在本机的，没有云端同步，也不代表任何真实团队的交流记录。\n- 标了「示例」的卡片是内置演示帖，可以直接删掉，删掉后重启也不会再冒出来。\n- 不要贴真实实验数据当示例；讨论方法、流程、踩坑和判断标准，比贴一个没有出处的百分比有用得多。\n\n## 交流的默认值\n\n不同意就写清不同意的那一句，并给出一个能检验它的做法。「感觉不太对」没法推进任何讨论。",
    },
    {
        "title": "预印本更新怎么追：给关注方向做一个最小订阅清单",
        "summary": "不靠刷首页。把方向、作者、关键词分成三张短表，每周固定十分钟过一遍。",
        "category": "论文速递", "kind": "note", "tags": "预印本,检索,订阅", "cover_style": "nodes",
        "content": "## 三张短表\n\n| 表 | 放什么 | 更新频率 |\n|---|---|---|\n| 方向 | 3-5 个稳定主题词 + 同义词 | 一季度一次 |\n| 作者 | 持续在做这个方向的人 | 看到新合作再加 |\n| 沉淀 | 已经读了且值得跟的线索 | 每周 |\n\n## 为什么不用「每日推送」\n\n每天推一堆，两周后就变成不点开的红点。固定一个时间批量过一遍，反而能记住哪些线索是新的。\n\n## 判重\n\n同一篇换了版本、换了标题，按 DOI / 预印本编号归并，别按标题字符串。",
    },
    {
        "title": "读 related work 先画方法族谱，再读正文",
        "summary": "先把「谁沿用了谁、谁替换了哪一步」画出来，正文里的定位句就不用猜了。",
        "category": "论文速递", "kind": "discussion", "tags": "related work,综述,脉络", "cover_style": "grid",
        "content": "## 一张草图胜过十段摘要\n\n读一组论文时，先只做一件事：把每篇的**输入、关键一步、输出**写成三栏，再用箭头标出「沿用了谁的那一步」。画完通常会发现，十几篇其实只分两三个分支。\n\n## 常见误判\n\n- 把「引用了」当成「沿用了」：引用可能只是为了对比或反驳。\n- 把「同一数据集」当成「同一问题设定」：任务定义可能完全不同。\n- 把作者自己写的分类当结论：那是论文的叙事，不是方法间的真实差异。\n\n## 收尾\n\n族谱里标不进任何分支的那一篇，往往才是值得细读的。",
    },
    {
        "title": "文献笔记三层：摘录、转述、判断",
        "summary": "只做摘录等于没读。加一层「我怎么理解」，再加一层「我同不同意」。",
        "category": "研究笔记", "kind": "note", "tags": "笔记,阅读,模板", "cover_style": "quote",
        "content": "## 三层分别写什么\n\n| 层 | 内容 | 校验方式 |\n|---|---|---|\n| 摘录 | 原文关键句 + 页码 / 章节 | 能回原文定位 |\n| 转述 | 用自己的话讲一遍机制 | 不看原文也能说清 |\n| 判断 | 哪里成立、哪里存疑、和我有什么关系 | 至少写一条可检验的疑问 |\n\n## 一个纪律\n\n「判断」层不许写「很有启发」。写清楚是哪一步让你改了看法，或者哪个条件一换结论就不成立。\n\n## 和痛点表接上\n\n判断层里反复出现的疑问，直接搬进痛点表，别让它们散在十几篇笔记里。",
    },
    {
        "title": "一周读完一批论文后的归档顺序",
        "summary": "先归档再开工：把标题、来源、一句话结论、待验证疑问各归各位。",
        "category": "研究笔记", "kind": "share", "tags": "归档,Zotero,流程", "cover_style": "paper",
        "content": "## 十分钟的收尾流程\n\n1. 元数据进文献库：标题、年份、来源、DOI 一次填完\n2. 每篇写一句话结论，不写摘要\n3. 待验证疑问进痛点表，标上证据位置\n4. 需要对比的几篇进对比矩阵\n5. 剩下的只留链接，不再复制正文\n\n## 为什么不先整理高亮\n\n高亮是「当时觉得重要」，隔一周就失去语境。先固定结论与疑问，高亮留到真要用的时候再回原文找。\n\n## 命名\n\n文件名带年份 + 第一作者 + 短标题，别用 `paper_final_v3.pdf` 这种以后自己都认不出的名字。",
    },
    {
        "title": "创新点评审该问的五个问题",
        "summary": "不评「新不新」，改评「能不能被检验」。五个问题问完，多数想法会自己分层。",
        "category": "方法讨论", "kind": "discussion", "tags": "创新点,评审,选题", "cover_style": "chart",
        "content": "## 五个问题\n\n1. 和哪条已有做法直接比较？说出具体对象，不要说「现有方法」。\n2. 换掉这一步之后，什么指标会变、往哪个方向变？\n3. 在什么条件下这个优势会消失？\n4. 最小验证需要哪几样东西：数据、代码、还是只要一个反例？\n5. 如果结论是「没差别」，这个想法还剩什么价值？\n\n## 排序\n\n按「最小验证成本」排，不按「听起来多激动人心」排。第 2 问答不上来的，先回去补定义，别急着立项。\n\n## 记录\n\n五个答案落成一页，评审时只对着这一页谈，避免每次会都从头讲一遍背景。",
    },
    {
        "title": "基线选不全，结论就站不住：最小基线集怎么定",
        "summary": "基线不是越多越好，但必须覆盖「不用我这套也能做到」的几条典型路径。",
        "category": "方法讨论", "kind": "review", "tags": "基线,消融,评测", "cover_style": "grid",
        "content": "## 最小三类\n\n| 类别 | 回答什么 |\n|---|---|\n| 下界 | 不做任何处理会怎样 |\n| 朴素替代 | 用最简单的方法能不能达到类似效果 |\n| 同族最强 | 同一思路里已有做法的上限在哪 |\n\n## 定完就冻结\n\n基线集合、版本、参数在开跑前写死并存档。中途因为结果不好看临时加一条，等于把选择权交给了结论。\n\n## 报告里写清\n\n每条基线的来源、复现方式、是否重新跑过。用别人论文里的数字当基线时，标注口径与自己的设定是否可比，不要直接并列。",
    },
    {
        "title": "跑批失败的记录模板：先写事实，不写结论",
        "summary": "失败当天最容易把猜测当事实记下来。用一张表把观测和推断分开。",
        "category": "实验复盘", "kind": "review", "tags": "失败记录,复现,模板", "cover_style": "code",
        "content": "## 模板\n\n| 字段 | 要求 |\n|---|---|\n| 命令 / 入口 | 原样贴，不重写 |\n| 环境 | 解释器、依赖版本、设备 |\n| 观测 | 报错原文 / 退出码 / 卡在哪一步 |\n| 已排除 | 试过什么、结果如何 |\n| 推断 | 明确标「推断」，并写一条能证伪它的检查 |\n\n## 为什么分开\n\n「应该是显存不够」这句话写在观测栏，一周后就会被当成结论。放在推断栏并配一条检查，才知道下一步该做什么。\n\n## 落盘\n\n一次失败一条记录，别覆盖上一条。输出目录带时间戳，和成功跑批同等对待。",
    },
    {
        "title": "负结果要不要写进论文",
        "summary": "不是所有负结果都值得写，但能改变读者判断的那类必须写。",
        "category": "实验复盘", "kind": "discussion", "tags": "负结果,写作,判断", "cover_style": "wave",
        "content": "## 值得写的三类\n\n1. 读者按常识会以为有效、但实际没有的做法\n2. 会影响别人选基线或选参数的边界条件\n3. 能界定方法适用范围的失败案例\n\n## 不值得写的\n\n只反映自己实现细节的失败、没有对照的观察、以及无法排除环境因素的异常。这些留在实验日志里，不进正文。\n\n## 怎么写\n\n写清条件与口径，别用「效果不佳」这种没有信息量的话。给出可复现的设置，并说明这个结果改变了哪个判断。",
    },
    {
        "title": "公开数据集的许可证与引用规范速查",
        "summary": "下载之前先记三件事：许可、原始出处、版本；否则复现时说不清用的是哪一份。",
        "category": "数据集", "kind": "share", "tags": "数据集,许可,引用", "cover_style": "formula",
        "content": "## 下载当场记三条\n\n- **许可**：能否再分发、能否商用、是否需要署名\n- **原始出处**：官方页面 / 仓库，而不是二手网盘链接\n- **版本与获取时间**：有 release 号就写号，没有就记下载日期 + 文件摘要\n\n## 引用\n\n按数据集官方指定的引用条目来，不要只引一篇用它做过实验的论文。若同时用了多个来源，说明各取自哪里。\n\n## 派生数据\n\n做过清洗、重划分或过滤的，当成一个新版本单独记，别在原地覆盖后还沿用旧版本号。",
    },
    {
        "title": "实验配置与结果怎么进 Git，不把大文件塞进仓库",
        "summary": "配置进仓库，产物进目录；用一份清单把两者对上。",
        "category": "工具与代码", "kind": "share", "tags": "Git,配置,复现", "cover_style": "code",
        "content": "## 分工\n\n| 内容 | 放哪 |\n|---|---|\n| 配置、脚本、种子 | Git 仓库 |\n| 原始数据、大体积产物 | 数据目录 / 对象存储 |\n| 结果与对应关系 | 结果清单（文本，进仓库） |\n\n## 结果清单至少四列\n\n`run_id` / 配置版本 / 输入数据的版本或摘要 / 产物路径。清单是文本，能在 diff 里看清哪次跑了什么。\n\n## 别做的事\n\n别把输出目录整个加进仓库，也别用 `latest` 当路径——它会漂移，半年后没人知道那次结果对应哪份代码。",
    },
    {
        "title": "rebuttal 的结构：先给意见分类，再排证据",
        "summary": "逐条回容易写成辩护。先把意见归成「误解 / 缺实验 / 真局限」三类，再决定回法。",
        "category": "投稿与审稿", "kind": "note", "tags": "rebuttal,审稿,写作", "cover_style": "quote",
        "content": "## 三类三种回法\n\n| 类别 | 回法 |\n|---|---|\n| 误解 | 引用原文位置，补一句更清楚的表述，不争辩 |\n| 缺实验 / 缺对比 | 能补就补，补不了就明确写进限制并说明代价 |\n| 真局限 | 承认，并给出边界条件或后续方向 |\n\n## 排证据的顺序\n\n先放能被直接核验的东西：原文位置、表格、可复现的设置。解释性文字放后面。\n\n## 一个纪律\n\n不写「我们认为 reviewer 没有理解」。所有分歧都落到「哪一处表述导致了什么读法」，并给出改后的文本。",
    },
    {
        "title": "审稿人问「和 X 比如何」时该怎么回",
        "summary": "先判断 X 是不是同一问题设定，再决定是补对比、解释不可比，还是补一段定位。",
        "category": "投稿与审稿", "kind": "discussion", "tags": "审稿,对比,定位", "cover_style": "nodes",
        "content": "## 三步判断\n\n1. **同设定吗**：输入、任务定义、评估口径是否一致\n2. **可比吗**：实现、数据划分、指标分母是否对得上\n3. **能补吗**：在现有条件下能不能真跑，还是要引用原论文数字\n\n## 三种回答\n\n- 可比且能跑 → 补一组对比，写清复现设置\n- 可比但跑不了 → 说明原因，引用时标注口径差异\n- 不同设定 → 不硬比，补一段方法定位说明差异在哪一步\n\n## 别做\n\n为了「有对比」把不同口径的数字并排放进一张表。那不是回答，是制造新的问题。",
    },
    {
        "title": "组会后 10 分钟，把承诺落成可执行条目",
        "summary": "「回去看看」不是承诺。写成「做什么、什么时候、怎么算做完」才算。",
        "category": "组会纪要", "kind": "note", "tags": "组会,承诺,执行", "cover_style": "paper",
        "content": "## 三条字段\n\n| 字段 | 例子式写法 |\n|---|---|\n| 动作 | 补一组对照，写清变量与口径 |\n| 时间 | 下次组会前 |\n| 完成判据 | 结果文件 + 一页结论，能指给别人看 |\n\n## 当场就记\n\n散会后再回忆，承诺会自动变轻。当场把模糊说法翻成一个可检查的动作，顺手确认是不是真的要做。\n\n## 复盘时\n\n没闭合的条目不删，标一句卡在哪。连续两次卡在同一处的，说明该改的是方法而不是排期。",
    },
    {
        "title": "可复现实验的模板仓库该有哪几件东西",
        "summary": "不用很全，但入口、环境、结果口径、许可这四件缺一件就会卡住别人。",
        "category": "资源分享", "kind": "share", "tags": "复现,模板,仓库", "cover_style": "grid",
        "content": "## 最小四件\n\n1. **入口**：一条能从头跑到尾的命令，写在最显眼的地方\n2. **环境**：依赖清单 + 版本钉死，别只写 `pip install -r` 而不给版本\n3. **结果口径**：指标定义、随机数种子、输出目录约定\n4. **许可与引用**：代码许可、数据许可、应引用的条目\n\n## 顺手加两件\n\n- 一个最小样例（小数据、几分钟能跑完），让别人先验证环境再跑全量\n- 一份「哪里可能跑不通」的短说明，把已知的平台差异写前面\n\n## 判断标准\n\n找一个没参与过这个项目的人，按 README 从头跑一遍。他卡住的地方就是模板还缺的东西。",
    },
    {
        "title": "求助：覆盖率上去了但另一个指标没动，该往哪查？",
        "summary": "两个指标不同步时，先查口径与分母，再查是不是只有容易的那部分被覆盖了。",
        "category": "求助问答", "kind": "question", "tags": "指标,口径,调试", "cover_style": "chart",
        "content": "## 已经确认的\n\n- 两个指标的分母不是同一个集合\n- 覆盖相关的改动只落在部分样本上\n\n## 想请教的排查顺序\n\n1. 先按样本分层看，是不是增益只集中在容易的那一层\n2. 再检查指标计算有没有把未执行的样本算进分母\n3. 最后才怀疑「方法对这些样本无效」\n\n大家遇到指标不同步时，一般从哪一步开始查？欢迎贴排查清单。",
    },
    {
        "title": "求助：多篇论文指标口径不一致，怎么归一化对比？",
        "summary": "直接并列数字会误导。想找一套「先判可比、再标注差异」的做法。",
        "category": "求助问答", "kind": "question", "tags": "对比,指标,综述", "cover_style": "formula",
        "content": "## 卡住的地方\n\n同一个名字的指标，在不同论文里可能分母不同、平均方式不同、样本集也不同；有的还只给相对提升。\n\n## 目前想到的两档\n\n- 能重算 → 统一口径后重算，写清用了哪份原始数据\n- 不能重算 → 不并列，改成表格逐篇标注口径，只在口径一致的子集里做对比\n\n## 想问\n\n写综述时你们怎么处理「数字看着能比但其实不能比」的情况？是保留原数字加脚注，还是干脆不列表？",
    },
    {
        "title": "近期阅读：测试时反馈闭环的几种组织方式",
        "summary": "不点名具体工作，只按「信号从哪来、回到哪一步」把读到的做法归成四类。",
        "category": "学术动态", "kind": "discussion", "tags": "反馈闭环,阅读,分类", "cover_style": "nodes",
        "content": "## 四种组织方式\n\n| 方式 | 信号来源 | 回灌位置 |\n|---|---|---|\n| 单轮重试 | 执行结果 | 重新生成 |\n| 多轮累积 | 历史失败 | 下一轮上下文 |\n| 结构化定位 | 代码结构 / 依赖 | 定位到具体位置再改 |\n| 受控选择 | 多个候选 + 打分 | 先选再做 |\n\n## 读的时候只记两件事\n\n信号是否可核验、回灌是否有边界（最多几轮、超了怎么办）。这两点不写清楚，流程图看着都一样。\n\n## 说明\n\n这是阅读时的归类笔记，不含任何实测数据，也不代表对具体工作的评价。",
    },
    {
        "title": "把新论文按「问题 / 方法 / 评估」三栏速记",
        "summary": "每篇只填三行，五分钟判断值不值得精读，攒够一批再决定读哪几篇。",
        "category": "学术动态", "kind": "note", "tags": "速记,阅读,筛选", "cover_style": "wave",
        "content": "## 三栏\n\n| 问题 | 方法 | 评估 |\n|---|---|---|\n| 想解决什么，前提是什么 | 关键一步换了什么 | 在哪测、指标口径、对照是谁 |\n\n## 填不出来的栏\n\n「评估」栏填不出来，通常不是论文写得差，而是自己还没建立可比的口径。这时候先标一个问号，别硬填。\n\n## 一周后回看\n\n三行还读不懂的那几篇，才是需要精读的；一眼看懂的大多是已有做法的变体。",
    },
]

SEED_COMMENTS: list[tuple[int, str]] = [
    (0, "痛点表里「证据位置」这列确实关键，之前只记结论，回头完全想不起出处。"),
    (0, "补一条：写不进可验证假设的痛点，我一般会标个 parked，过一个月再看。"),
    (3, "输出目录加时间戳这条太真实了，重跑覆盖旧结果之后根本说不清哪版是哪版。"),
    (7, "我们的做法是只对「空输出 + 长度截断」重试一次，其它错误直接降级，不换 provider。"),
    # 下面这批只挂在新帖（索引 >= 12）上：老库升级时已有帖子一个字段都不动
    (12, "第 4 条口径太重要了，没有出处和口径的数字在讨论里基本没有信息量。"),
    (12, "「不同意就写清不同意的那一句」这条直接存进我的提问模板了。"),
    (13, "同义词表由它生成检索式这句点了关键，临时想关键词每次都会漏。"),
    (14, "「引用了」不等于「沿用了」，这个区分值得写在综述方法那一节里。"),
    (15, "判断层不许写「很有启发」——这条可以直接贴到笔记模板顶部。"),
    (16, "先固定结论与疑问再回原文找高亮，这个顺序比反过来省时间。"),
    (17, "第 3 问「优势在什么条件下消失」比前两问更难答，但也最能筛掉伪创新点。"),
    (18, "基线集合开跑前冻结，中途加一条确实等于让结论自己挑对手。"),
    (19, "观测和推断分栏这个设计好，我以前的失败记录全是混在一起的猜测。"),
    (20, "「只反映自己实现细节的失败」留在日志里，这个边界划得很清楚。"),
    (21, "派生数据当新版本单独记，别覆盖后沿用旧号，这条吃过亏。"),
    (22, "结果清单是文本能进 diff，这比在 README 里手写一段靠谱。"),
    (23, "把分歧落到「哪处表述导致什么读法」，比争「有没有理解」有效太多。"),
    (24, "不同设定就补定位说明、不硬比，省得制造一张误导性的对照表。"),
    (25, "完成判据写成「能指给别人看的结果」，比「做完」清楚多了。"),
    (26, "让别人按 README 从头跑一遍，卡住的地方就是模板缺的东西，很实在。"),
    (27, "先分层看增益是不是只集中在容易样本，这步通常就能解释大半的不同步。"),
    (28, "我倾向保留原数字加口径脚注，但只在口径一致的子集里做对比，不并列全表。"),
    (29, "四种组织方式里「回灌有没有边界」最容易被漏掉，流程图上通常不画。"),
    (30, "评估栏填不出来其实是自己的口径没建立，这个提醒比模板本身有用。"),
]


SEED_VERSION = 2
_SEED_KEY = "community_seed_version"


def _seed_version(conn) -> int:
    row = conn.execute("SELECT value FROM settings WHERE key=?", (_SEED_KEY,)).fetchone()
    try:
        return int(row["value"]) if row else 0
    except (TypeError, ValueError):
        return 0


def seed_community(conn) -> None:
    """增量补齐示例内容，不改任何已有帖子。

    以前是「表为空才写一次」，导致后续新增的示例帖在已有库里永远看不到。
    现在用 settings 里的版本号做一次性闸门：

    - 全新库：写入全部示例帖与评论
    - 已有库：只补标题还没出现过的示例帖，评论按 (帖子, 正文) 去重
    - 版本达标后直接返回：用户删掉的示例帖不会被重启补回来

    以后再加示例内容，把 SEED_VERSION 加一即可，老库会再增量补一次。
    """
    if _seed_version(conn) >= SEED_VERSION:
        return

    base = datetime.now()
    existing = {
        r["title"]: int(r["id"])
        for r in conn.execute(
            "SELECT id, title FROM community_posts WHERE is_sample=1"
        ).fetchall()
    }

    added = 0
    for i, p in enumerate(SEED_POSTS):
        if p["title"] in existing:
            continue
        # 新增帖落在最近几小时（比上一批 1-12 天前的示例帖新），默认按最新排序能先看到
        ts = (base - timedelta(minutes=25 + added * 23)).isoformat(timespec="seconds")
        cur = conn.execute(
            """INSERT INTO community_posts
               (title, summary, content, category, kind, tags, cover_style, cover_url,
                author_id, author_name, author_hue, is_sample, views, likes, favorites,
                comments_count, pinned, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,'',0,?,240,1,?,?,?,0,?,?,?)""",
            (
                p["title"], p["summary"], p["content"], p["category"], p["kind"],
                p["tags"], p["cover_style"], "工作台示例",
                18 + (i * 13) % 76, 2 + (i * 7) % 17, (i * 3) % 6,
                int(p.get("pinned", 0)), ts, ts,
            ),
        )
        existing[p["title"]] = int(cur.lastrowid)
        added += 1

    new_comments = 0
    for n, (idx, text) in enumerate(SEED_COMMENTS):
        pid = existing.get(SEED_POSTS[idx]["title"])
        if not pid:
            continue
        hit = conn.execute(
            "SELECT 1 FROM community_comments WHERE post_id=? AND content=?", (pid, text)
        ).fetchone()
        if hit:
            continue
        conn.execute(
            """INSERT INTO community_comments
               (post_id, parent_id, author_id, author_name, author_hue, content, created_at)
               VALUES (?,NULL,0,?,240,?,?)""",
            (
                pid, "工作台示例", text,
                (base - timedelta(hours=1 + n % 12)).isoformat(timespec="seconds"),
            ),
        )
        conn.execute(
            "UPDATE community_posts SET comments_count=comments_count+1 WHERE id=?", (pid,)
        )
        new_comments += 1

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)",
        (_SEED_KEY, str(SEED_VERSION)),
    )
    print(f"[seed] 社区示例内容 v{SEED_VERSION}：新增 {added} 篇帖子 / {new_comments} 条评论")
