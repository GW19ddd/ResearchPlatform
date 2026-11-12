"""登录 / 首次创建账户 / 账户资料 / 云端账户登录。"""
import threading
import time

import cloud_auth
from cloud_auth import CloudAuthError
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

import auth
from db import now

router = APIRouter(prefix="/api/auth", tags=["auth"])

_COOKIE_MAX_AGE = auth.SESSION_DAYS * 24 * 3600

# 工作台可以被 Tailscale Funnel 暴露到公网，登录必须挡住暴力尝试。
# 故意做得很土：进程内字典 + 固定窗口，够用且不引入依赖（重启即清零）。
_FAIL_WINDOW = 600  # 10 分钟内累计失败次数
_FAIL_LIMIT = 8  # 超过就锁
_fails: dict[str, list[float]] = {}
_fails_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    """Funnel / 反向代理时真实来源在 X-Forwarded-For 首位。"""
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if fwd:
        return fwd
    return request.client.host if request.client else "unknown"


def _limit_guard(ip: str) -> int:
    """返回还需等待的秒数；0 表示放行。"""
    ts = time.time()
    with _fails_lock:
        hits = [t for t in _fails.get(ip, []) if ts - t < _FAIL_WINDOW]
        if hits:
            _fails[ip] = hits
        else:
            _fails.pop(ip, None)
        # 顺手回收，避免长期运行把字典撑大
        if len(_fails) > 512:
            for k in [k for k, v in _fails.items() if not v or ts - v[-1] > _FAIL_WINDOW]:
                _fails.pop(k, None)
        if len(hits) >= _FAIL_LIMIT:
            return int(_FAIL_WINDOW - (ts - hits[0])) + 1
    return 0


def _note_fail(ip: str) -> None:
    with _fails_lock:
        _fails.setdefault(ip, []).append(time.time())


def _clear_fail(ip: str) -> None:
    with _fails_lock:
        _fails.pop(ip, None)


def _set_cookie(response: Response, token: str, request: Request | None = None):
    # 反代（Tailscale Funnel / Cloudflare）终结 TLS 后转发的是 http，
    # 靠 X-Forwarded-Proto 判断是否该加 Secure；本机 http 访问则不加，否则 cookie 存不下。
    proto = ""
    if request is not None:
        proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    response.set_cookie(
        key=auth.SESSION_COOKIE,
        value=token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=proto.startswith("https"),
        path="/",
    )


def _current(request: Request):
    return auth.resolve_session(request.cookies.get(auth.SESSION_COOKIE))


class Credentials(BaseModel):
    username: str = ""
    password: str = ""


class SetupBody(BaseModel):
    username: str = ""
    password: str = ""
    display_name: str = ""
    avatar_hue: int = 240


class ProfileBody(BaseModel):
    display_name: str | None = None
    avatar_hue: int | None = None


class PasswordBody(BaseModel):
    old_password: str = ""
    new_password: str = ""


@router.get("/state")
def state(request: Request):
    """前端启动时问一次：有没有账户、当前有没有登录。不需要鉴权。"""
    auth.purge_expired()
    user = _current(request)
    return {"has_user": auth.has_user(), "user": auth.public_user(user) if user else None}


@router.post("/setup")
def setup(body: SetupBody, response: Response, request: Request):
    """首次使用：创建本机唯一账户，并直接登录。已有账户时拒绝。"""
    if auth.has_user():
        raise HTTPException(400, "本机已有账户，请直接登录")
    try:
        row = auth.create_user(body.username, body.password, body.display_name, body.avatar_hue)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    _set_cookie(response, auth.issue_session(row["id"]), request)
    return {"user": auth.public_user(row)}


@router.post("/login")
def login(body: Credentials, response: Response, request: Request):
    ip = _client_ip(request)
    wait = _limit_guard(ip)
    if wait:
        raise HTTPException(
            429,
            f"尝试过于频繁，请 {wait} 秒后再试",
            headers={"Retry-After": str(wait)},
        )
    row = auth.authenticate(body.username, body.password)
    if not row:
        _note_fail(ip)
        # 不区分「账号不存在」和「密码错」，避免被用来探测账号
        raise HTTPException(401, "账号或密码不正确")
    _clear_fail(ip)
    _set_cookie(response, auth.issue_session(row["id"]), request)
    return {"user": auth.public_user(row)}


@router.post("/logout")
def logout(request: Request, response: Response):
    auth.revoke_session(request.cookies.get(auth.SESSION_COOKIE))
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    user = _current(request)
    if not user:
        raise HTTPException(401, "未登录")
    return {"user": auth.public_user(user)}


@router.patch("/profile")
def profile(body: ProfileBody, request: Request):
    user = _current(request)
    if not user:
        raise HTTPException(401, "未登录")
    try:
        row = auth.update_profile(user["id"], body.display_name, body.avatar_hue)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"user": auth.public_user(row)}


@router.post("/password")
def password(body: PasswordBody, request: Request, response: Response):
    user = _current(request)
    if not user:
        raise HTTPException(401, "未登录")
    try:
        auth.change_password(user["id"], body.old_password, body.new_password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    # 其它设备的会话已清空；给当前这台续一条，用户不用重新登录
    _set_cookie(response, auth.issue_session(user["id"]), request)
    return {"ok": True, "changed_at": now()}


# ------------------------------------------------------------------ 云端账户登录

class CloudExchangeBody(BaseModel):
    """云端登录凭证 + 绑定策略。

    mode:
      auto   —— 已关联就直接登录；没关联时按是否还有空位本机账户决定下一步
      link   —— 把云端账户挂到指定本机账户上（首次关联，保留原有数据）
      create —— 开一个空白工作台（不沿用任何本机已有数据）
    """
    access_token: str = ""
    mode: str = "auto"
    link_user_id: int | None = None


@router.get("/cloud/status")
def cloud_status():
    """前端判断云端登录是否可用（配置存在）+ 本机是否还有可关联的空位账户。"""
    return {
        "enabled": True,
        "linkable": auth.has_linkable_local_user(),
        "has_user": auth.has_user(),
    }


@router.get("/cloud/local-users")
def cloud_local_users():
    """云端登录首次关联时，列出可关联的本机账户（只给最小信息，不含邮箱手机号）。"""
    return {"users": auth.list_linkable_users()}


@router.post("/cloud/exchange")
def cloud_exchange(body: CloudExchangeBody, response: Response, request: Request):
    """云端会话 → 本机会话。

    前端在云端 SDK 登录成功后把 access token 交过来；本机向云端 Auth 数据平面
    校验它，通过后按 cloud_uid 关到本机用户，再发本机 HttpOnly Cookie。
    验证不了就不发 Cookie —— 绝不信任前端自报的身份。
    """
    try:
        ident = cloud_auth.validate_cloud_token(body.access_token)
    except CloudAuthError as e:
        raise HTTPException(401, str(e)) from e

    mode = (body.mode or "auto").strip().lower()
    row = auth.find_user_by_cloud_uid(ident["uid"])

    if row is None and mode == "link":
        if body.link_user_id is None:
            raise HTTPException(400, "请选择要关联的本机账户")
        try:
            row = auth.link_cloud_uid(int(body.link_user_id), ident)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    elif row is None and mode == "create":
        try:
            row = auth.create_cloud_user(ident)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    elif row is None and mode == "auto":
        # 还没关联：本机一个账户都没有就直接建；有账户则让前端选择关联还是新建
        if not auth.has_user():
            row = auth.create_cloud_user(ident)
        else:
            return {
                "needs_binding": True,
                "cloud_email": ident.get("email"),
                "cloud_phone": ident.get("phone"),
                "linkable": auth.has_linkable_local_user(),
            }

    if row is None:
        raise HTTPException(400, "无法建立本机账户")

    _set_cookie(response, auth.issue_session(row["id"]), request)
    return {"user": auth.public_user(row)}

