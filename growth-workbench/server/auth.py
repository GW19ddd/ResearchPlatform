"""本地账户与会话。

设计取舍：
- 这是跑在本机的单用户工作台，不需要用户体系，但需要「锁屏」——
  电脑借给同门/家人时，科研数据和导师承诺不该裸奔。
- 密码只存 PBKDF2-SHA256(盐 16B, 210k 轮) 的十六进制串，永不落明文。
- 登录凭证走 HttpOnly Cookie：pdf.js、SSE 流式对话、静态资源全部同源，
  不用给每条请求手工塞 header，也就不会漏掉某个 fetch。
- 服务端只存 token 的 sha256，库被拷走也拿不到可用凭证。
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta

from db import execute, now, query

SESSION_COOKIE = "wb_session"
SESSION_DAYS = 30
_ITERATIONS = 210_000


# ------------------------------------------------------------------ 密码

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return f"pbkdf2_sha256${_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt_hex, digest_hex = (stored or "").split("$")
        if algo != "pbkdf2_sha256":
            return False
        calc = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds)
        )
        return secrets.compare_digest(calc.hex(), digest_hex)
    except Exception:  # noqa: BLE001 —— 格式坏了就当作验证失败，不要 500
        return False


# ------------------------------------------------------------------ 用户

def has_user() -> bool:
    try:
        return bool(query("SELECT 1 FROM users LIMIT 1"))
    except Exception:  # noqa: BLE001 —— 迁移还没跑完时不要拦住首屏
        return False


def public_user(row) -> dict:
    if not row:
        return {}
    name = (row["display_name"] or row["username"] or "").strip()
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": name,
        "initial": (name[:1] or "研").upper(),
        "avatar_hue": int(row["avatar_hue"] or 240),
        "created_at": row["created_at"],
        "last_login_at": row["last_login_at"],
        # 会员档位：free / pro，缺省一律按 free（兼容尚未迁移的老库）
        "plan": (row.get("plan") or "free"),
        # 是否关联了云端账户（WorkBuddy 云服务登录）
        "cloud_linked": bool(row.get("cloud_uid")),
    }


def create_user(username: str, password: str, display_name: str = "", avatar_hue: int = 240):
    username = (username or "").strip()
    if len(username) < 2:
        raise ValueError("账号至少 2 个字符")
    if len(password or "") < 6:
        raise ValueError("密码至少 6 位")
    if has_user():
        raise ValueError("本机已有账户")
    execute(
        "INSERT INTO users (username, display_name, password_hash, avatar_hue, created_at) "
        "VALUES (?,?,?,?,?)",
        (username, (display_name or username).strip(), hash_password(password), int(avatar_hue), now()),
    )
    return query("SELECT * FROM users WHERE username=?", (username,))[0]


def get_user(user_id: int):
    rows = query("SELECT * FROM users WHERE id=?", (user_id,))
    return rows[0] if rows else None


def authenticate(username: str, password: str):
    rows = query("SELECT * FROM users WHERE username=?", ((username or "").strip(),))
    if not rows:
        return None
    row = rows[0]
    if not verify_password(password or "", row["password_hash"]):
        return None
    execute("UPDATE users SET last_login_at=? WHERE id=?", (now(), row["id"]))
    return get_user(row["id"])


# ------------------------------------------------------------------ 云端账户映射

def find_user_by_cloud_uid(uid: str):
    rows = query("SELECT * FROM users WHERE cloud_uid=?", ((uid or "").strip(),))
    return rows[0] if rows else None


def has_linkable_local_user() -> bool:
    """还有没挂云端账户的本机用户吗（用于首次云登录时提供「关联」选项）。"""
    return bool(query("SELECT 1 FROM users WHERE cloud_uid IS NULL LIMIT 1"))


def list_linkable_users() -> list[dict]:
    """可关联的本机账户：只回 id / 账号 / 称呼，不回任何密码或联系方式。"""
    rows = query(
        "SELECT id, username, display_name FROM users WHERE cloud_uid IS NULL ORDER BY id LIMIT 20"
    )
    return [
        {
            "id": r["id"],
            "username": r["username"],
            "display_name": (r["display_name"] or "").strip(),
        }
        for r in rows
    ]


def _unique_cloud_username(ident: dict) -> str:
    base = ""
    email = ident.get("email")
    if email and "@" in email:
        base = email.split("@")[0]
    elif ident.get("phone"):
        base = ident["phone"]
    base = "".join(ch for ch in base if ch.isalnum() or ch in "-_")[:24] or "cloud"
    username, n = base, 2
    while query("SELECT 1 FROM users WHERE username=?", (username,)):
        username = f"{base}-{n}"
        n += 1
    return username


def create_cloud_user(ident: dict):
    """云端账户首次登录且不关联本机账户时，开一个空白工作台用户。

    密码哈希存一个随机串 —— 云端账户没有本机密码，本机密码登录永远进不来这个用户。
    """
    if find_user_by_cloud_uid(ident["uid"]):
        raise ValueError("该云端账户已关联本机用户")
    username = _unique_cloud_username(ident)
    display = (ident.get("name") or ident.get("email") or ident.get("phone") or username).strip()
    execute(
        "INSERT INTO users (username, display_name, password_hash, avatar_hue, created_at, "
        "cloud_uid, cloud_email, cloud_phone) VALUES (?,?,?,?,?,?,?,?)",
        (
            username,
            display[:40],
            hash_password(secrets.token_urlsafe(24)),
            secrets.randbelow(360),
            now(),
            ident["uid"],
            ident.get("email"),
            ident.get("phone"),
        ),
    )
    row = get_user_by_username(username)
    execute("UPDATE users SET last_login_at=? WHERE id=?", (now(), row["id"]))
    return row


def get_user_by_username(username: str):
    rows = query("SELECT * FROM users WHERE username=?", ((username or "").strip(),))
    return rows[0] if rows else None


def link_cloud_uid(user_id: int, ident: dict):
    """把云端账户挂到已有本机用户上；该本机账户若已挂别的云端账号则拒绝。"""
    row = get_user(user_id)
    if not row:
        raise ValueError("本机账户不存在")
    existing_uid = row.get("cloud_uid")
    if existing_uid and existing_uid != ident["uid"]:
        raise ValueError("该本机账户已关联其它云端账号")
    if find_user_by_cloud_uid(ident["uid"]):
        raise ValueError("该云端账户已关联本机用户")
    execute(
        "UPDATE users SET cloud_uid=?, cloud_email=?, cloud_phone=?, last_login_at=? WHERE id=?",
        (ident["uid"], ident.get("email"), ident.get("phone"), now(), user_id),
    )
    return get_user(user_id)


def update_profile(user_id: int, display_name: str | None = None, avatar_hue: int | None = None):
    sets, args = [], []
    if display_name is not None:
        clean = display_name.strip()
        if not clean:
            raise ValueError("显示名称不能为空")
        sets.append("display_name=?")
        args.append(clean[:40])
    if avatar_hue is not None:
        sets.append("avatar_hue=?")
        args.append(max(0, min(359, int(avatar_hue))))
    if not sets:
        return get_user(user_id)
    args.append(user_id)
    execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", tuple(args))
    return get_user(user_id)


def change_password(user_id: int, old_password: str, new_password: str):
    row = get_user(user_id)
    if not row or not verify_password(old_password or "", row["password_hash"]):
        raise ValueError("原密码不正确")
    if len(new_password or "") < 6:
        raise ValueError("新密码至少 6 位")
    execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_password), user_id))
    # 改密后踢掉其它设备上的会话，只保留当前这条
    execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


# ------------------------------------------------------------------ 会话

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires = (datetime.now() + timedelta(days=SESSION_DAYS)).isoformat(timespec="seconds")
    execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
        (_token_hash(token), user_id, now(), expires),
    )
    return token


def resolve_session(token: str | None):
    """token → 用户行；过期/不存在返回 None，并顺手清理过期记录。"""
    if not token:
        return None
    th = _token_hash(token)
    rows = query("SELECT * FROM sessions WHERE token_hash=?", (th,))
    if not rows:
        return None
    row = rows[0]
    if str(row["expires_at"] or "") < now():
        execute("DELETE FROM sessions WHERE token_hash=?", (th,))
        return None
    return get_user(row["user_id"])


def revoke_session(token: str | None):
    if token:
        execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))


def purge_expired():
    try:
        execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------------------ 兜底：命令行重置
if __name__ == "__main__":  # pragma: no cover
    import sys

    if "--reset" in sys.argv:
        execute("DELETE FROM sessions")
        execute("DELETE FROM users")
        print("已清除本机账户，下次打开工作台会进入「创建账户」。")
    else:
        print("用法: python auth.py --reset   # 忘记密码时清空账户")
