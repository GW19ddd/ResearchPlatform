"""科研一站式工作台 · FastAPI 入口"""
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from db import execute, init_db, now, query
from routers import (
    activity,
    advisor,
    ai_guard,
    backup,
    canvas,
    chat,
    dashboard,
    gloss,
    paper,
    plan,
    points,
    research,
    settings,
    zotero,
)

# 幂等键保留时长：客户端重试一般在几秒内，留一天足够兜住网络重发
@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    # 进程重启后旧的幂等键没有意义了（不存在跨进程重发同一把 key 的场景），全清最省事
    try:
        execute("DELETE FROM idempotency_keys")
    except Exception:  # noqa: BLE001
        pass
    yield


app = FastAPI(title="科研一站式工作台", version="0.1.0", lifespan=lifespan)

# pdf.js 的 worker 产物是 .mjs，系统 mime 表常把它当 text/plain，
# 浏览器会拒绝把它当模块脚本加载（Worker / 动态 import 直接失败）。
for _ext in (".mjs", ".js", ".mjs.map"):
    mimetypes.add_type("text/javascript", _ext)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def idempotency(request: Request, call_next):
    """同一次业务操作只写一次库。

    前端每次写请求都会带上 Idempotency-Key：双击按钮、网络重试、success-
    timeout 后自动重发，都会命中同一把 key 并拿回第一次的响应，
    而不是再 INSERT 一条。GET 与不带 key 的请求直接放行。
    """
    key = (request.headers.get("idempotency-key") or "").strip()
    if not key or request.method in ("GET", "HEAD", "OPTIONS"):
        return await call_next(request)

    rows = query(
        "SELECT status_code, content_type, response FROM idempotency_keys WHERE key=?", (key,)
    )
    if rows:
        return Response(
            content=rows[0]["response"] or "",
            status_code=rows[0]["status_code"] or 200,
            media_type=rows[0]["content_type"] or "application/json",
        )

    response = await call_next(request)
    # 要在返回给客户端的同时把 body 留一份，只能完整读出来再重建 Response
    body = b"".join([chunk async for chunk in response.body_iterator])
    text = body.decode("utf-8", errors="replace")
    if 200 <= response.status_code < 300 and len(text) < 512_000:
        try:
            execute(
                """INSERT OR REPLACE INTO idempotency_keys
                   (key, endpoint, status_code, content_type, response, created_at)
                   VALUES (?,?,?,?,?,?)""",
                (
                    key,
                    request.url.path,
                    response.status_code,
                    response.headers.get("content-type", "application/json"),
                    text,
                    now(),
                ),
            )
        except Exception:  # noqa: BLE001 —— 幂等记录写不进去也不能把业务响应吞了
            pass
    headers = {
        k: v
        for k, v in response.headers.items()
        if k.lower() not in ("content-length", "content-encoding", "transfer-encoding")
    }
    return Response(
        content=body,
        status_code=response.status_code,
        headers=headers,
        media_type=response.headers.get("content-type"),
    )


# ---- 前端静态托管：把 web/dist 挂在根路径，单进程跑全部 ----
# 注意：catch-all 必须在 include_router 之后注册（见文件末尾）
_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"


@app.get("/")
def root():
    """`/` 直接回前端页面（dist 已构建时）。"""
    if (_DIST / "index.html").is_file():
        from fastapi.responses import FileResponse

        return FileResponse(_DIST / "index.html")
    return {"name": "科研一站式工作台", "docs": "/docs", "status": "ok"}


@app.get("/api/health")
def health():
    return {"name": "科研一站式工作台", "docs": "/docs", "status": "ok"}


app.include_router(research.router)
app.include_router(paper.router)
app.include_router(plan.router)
app.include_router(advisor.router)
app.include_router(points.router)
app.include_router(dashboard.router)
app.include_router(settings.router)
app.include_router(canvas.router)
app.include_router(zotero.router)
app.include_router(chat.router)
app.include_router(activity.router)
app.include_router(gloss.router)
app.include_router(ai_guard.router)
app.include_router(backup.router)

if _DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    from fastapi.responses import FileResponse

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        # API 路径漏到这里说明路由没匹配上，返回 404 JSON 而不是 index.html
        if full_path.startswith("api/") or full_path == "api":
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        candidate = _DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_DIST / "index.html")
else:

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_missing(full_path: str):
        if full_path.startswith("api/") or full_path == "api":
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return JSONResponse(
            {"detail": "前端未构建：先在 web/ 目录运行 npm run build，或用 dev.ps1 启动"},
            status_code=404,
        )
