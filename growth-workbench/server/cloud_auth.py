"""WorkBuddy 云端账户校验。

前端用 @tencent-ai/workbuddy-cloud-sdk 完成云端登录（短信验证码 / 邮箱密码 /
微信扫码），拿到 WorkBuddy 会话后把 access token 交给本机后端验证 ——
验证通过才发放本机会话 Cookie。这里只持有开通时下发的公开配置
（endpoint / publishableKey），不持有任何服务端密钥；真正的凭证校验
由云端 Auth 数据平面完成，本机只信任它的回答。
"""
from __future__ import annotations

import httpx

# 开通云服务时返回的 publicConfig（公开值，可随源码分发）
CLOUD_ENDPOINT = "https://growth-workbench-66823.app.workbuddy.host"
PUBLISHABLE_KEY = "wbpk_NQ2QLlIHOvJdrFUEBwKc2V_Cnx0n2HUHSWPJSS7UiSdax6FbphQu3BF"

_ME_URL = f"{CLOUD_ENDPOINT}/.cloud/auth/v1/user/me"
_TIMEOUT = 8.0


class CloudAuthError(Exception):
    """云端凭证校验失败（网络不可达 / token 过期 / 响应异常），文案可直接给前端。"""


def validate_cloud_token(token: str) -> dict:
    """Bearer token → 归一化身份 {uid, email, phone, name}；无效则抛 CloudAuthError。"""
    token = (token or "").strip()
    if not token:
        raise CloudAuthError("缺少云端登录凭证")

    try:
        resp = httpx.get(
            _ME_URL,
            headers={"Authorization": f"Bearer {token}"},
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as exc:  # 网络层失败：不是「凭证无效」，别让用户重新登录
        raise CloudAuthError("云端账户服务暂时不可达，请稍后再试") from exc

    if resp.status_code in (401, 403):
        raise CloudAuthError("云端登录已过期，请重新登录")
    if resp.status_code != 200:
        raise CloudAuthError(f"云端账户校验失败（HTTP {resp.status_code}）")

    try:
        data = resp.json()
    except ValueError as exc:
        raise CloudAuthError("云端账户响应格式异常") from exc

    # 响应可能是裸 user 对象，也可能包一层 {user: {...}}，两种都接住
    user = data.get("user") if isinstance(data, dict) and isinstance(data.get("user"), dict) else data
    if not isinstance(user, dict):
        raise CloudAuthError("云端账户响应格式异常")

    uid = ""
    for key in ("id", "uid", "sub", "user_id", "userId"):
        val = user.get(key)
        if isinstance(val, (str, int)) and str(val).strip():
            uid = str(val).strip()
            break
    if not uid:
        raise CloudAuthError("云端账户响应缺少用户标识")

    email = str(user.get("email") or "").strip() or None
    phone = str(user.get("phone") or user.get("phone_number") or "").strip() or None
    name = str(user.get("name") or user.get("nickname") or "").strip() or None
    return {"uid": uid, "email": email, "phone": phone, "name": name}
