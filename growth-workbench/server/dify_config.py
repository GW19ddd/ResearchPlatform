"""Dify 接入配置。

配置存 settings 表（key='dify_config'），在「设置」页填写，画布的 Dify 节点直接引用。

结构：
{
  "enabled": true,
  "base_url": "http://localhost/v1",
  "apps": [
    {"id": "d-xxxx", "name": "选题工作流", "api_key": "app-xxx", "mode": "workflow"},
    {"id": "d-yyyy", "name": "文献助手",   "api_key": "app-yyy", "mode": "chat"}
  ]
}

mode: workflow → POST {base}/workflows/run ；chat → POST {base}/chat-messages
"""
import json
import uuid

from config import DIFY_API_KEY, DIFY_BASE_URL, DIFY_CONFIG_KEY
from db import execute, query

APP_MODES = [
    {"value": "workflow", "label": "工作流 workflow（/workflows/run）"},
    {"value": "chat", "label": "对话应用 chat（/chat-messages）"},
]


def default_config() -> dict:
    return {
        "enabled": False,
        "base_url": DIFY_BASE_URL,
        "apps": ([{"id": "dify-default", "name": "默认应用", "api_key": DIFY_API_KEY, "mode": "workflow"}] if DIFY_API_KEY else []),
    }


def load_config() -> dict:
    rows = query("SELECT value FROM settings WHERE key=?", (DIFY_CONFIG_KEY,))
    if rows:
        try:
            cfg = json.loads(rows[0]["value"])
            if isinstance(cfg, dict):
                cfg.setdefault("enabled", False)
                cfg.setdefault("base_url", DIFY_BASE_URL)
                cfg.setdefault("apps", [])
                return cfg
        except (ValueError, TypeError):
            pass
    return default_config()


def save_config(cfg: dict) -> dict:
    cfg.setdefault("enabled", False)
    cfg.setdefault("base_url", DIFY_BASE_URL)
    cfg.setdefault("apps", [])
    execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (DIFY_CONFIG_KEY, json.dumps(cfg, ensure_ascii=False)),
    )
    return load_config()


def upsert_app(app: dict) -> dict:
    cfg = load_config()
    if not app.get("id"):
        app["id"] = "d-" + uuid.uuid4().hex[:8]
    for i, a in enumerate(cfg["apps"]):
        if a["id"] == app["id"]:
            cfg["apps"][i] = app
            break
    else:
        cfg["apps"].append(app)
    return save_config(cfg)


def delete_app(app_id: str) -> dict:
    cfg = load_config()
    cfg["apps"] = [a for a in cfg["apps"] if a["id"] != app_id]
    return save_config(cfg)


def get_app(app_id: str) -> dict | None:
    for a in load_config()["apps"]:
        if a["id"] == app_id:
            return a
    return None


def resolve(app_id: str = "") -> tuple[dict | None, str]:
    """节点运行时取用哪个应用。返回 (app, 错误说明)。

    节点里可以带自己的 app_id；没带就用配置里的第一个。
    """
    cfg = load_config()
    if not cfg.get("enabled", False):
        return None, (
            "[Dify 未启用]\n\n去「设置」页的 Dify 卡片：打开启用、填 API 地址、"
            "加一个应用并填它的 API Key。"
        )
    base = (cfg.get("base_url") or "").rstrip("/")
    if not base:
        return None, "[Dify 未配置 API 地址]\n\n去「设置」页填，本机一般是 http://localhost/v1"
    if app_id:
        app = get_app(app_id)
        if not app:
            return None, f"[找不到 Dify 应用 {app_id}]\n\n去「设置」页检查应用列表。"
    else:
        if not cfg["apps"]:
            return None, "[Dify 还没有配置任何应用]\n\n去「设置」页加一个，填它的 API Key。"
        app = cfg["apps"][0]
    if not app.get("api_key"):
        return None, f"[Dify 应用「{app.get('name')}」没填 API Key]\n\n去「设置」页填。"
    return {**app, "base_url": base}, ""


def mask(cfg: dict) -> dict:
    """给前端用的副本：不回传明文 api_key，只留一个尾缀提示字段。"""
    out = json.loads(json.dumps(cfg))
    for a in out.get("apps", []):
        k = a.get("api_key") or ""
        a["api_key_masked"] = (k[:4] + "…" + k[-4:]) if len(k) > 10 else ("已填" if k else "未填")
        a.pop("api_key", None)
    return out


def mask_app(app: dict) -> dict:
    """单个应用脱敏，用于「新增/更新后回显」。"""
    return mask({"enabled": False, "base_url": "", "apps": [app]})["apps"][0]
