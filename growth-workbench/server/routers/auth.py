"""登录 / 首次创建账户 / 账户资料。"""
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

import auth
from db import now

router = APIRouter(prefix="/api/auth", tags=["auth"])

_COOKIE_MAX_AGE = auth.SESSION_DAYS * 24 * 3600


def _set_cookie(response: Response, token: str):
    response.set_cookie(
        key=auth.SESSION_COOKIE,
        value=token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
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
def setup(body: SetupBody, response: Response):
    """首次使用：创建本机唯一账户，并直接登录。已有账户时拒绝。"""
    if auth.has_user():
        raise HTTPException(400, "本机已有账户，请直接登录")
    try:
        row = auth.create_user(body.username, body.password, body.display_name, body.avatar_hue)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    _set_cookie(response, auth.issue_session(row["id"]))
    return {"user": auth.public_user(row)}


@router.post("/login")
def login(body: Credentials, response: Response):
    row = auth.authenticate(body.username, body.password)
    if not row:
        # 不区分「账号不存在」和「密码错」，避免被用来探测账号
        raise HTTPException(401, "账号或密码不正确")
    _set_cookie(response, auth.issue_session(row["id"]))
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
    _set_cookie(response, auth.issue_session(user["id"]))
    return {"ok": True, "changed_at": now()}
