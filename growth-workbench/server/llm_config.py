"""LLM provider 配置的 CRUD 与解析。

配置存 settings 表（key='llm_config'），设置页可改；环境变量只作为首次种子。
一个 provider 的形态：
{
  "id": "deepseek",
  "name": "DeepSeek",
  "type": "openai" | "responses" | "ollama",
  "base_url": "https://api.deepseek.com/v1",
  "api_key": "sk-xxx",
  "model_fast": "deepseek-chat",
  "model_reason": "deepseek-reasoner",
  "routing": "all" | "fast" | "reason",
  "enabled": true
}
"""
import json

from config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_FAST_MODEL,
    DEEPSEEK_REASON_MODEL,
    LLM_CONFIG_KEY,
    LOCAL_QWEN_BASE_URL,
    LOCAL_QWEN_MODEL,
    OLLAMA_BASE_URL,
    OLLAMA_MODEL,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
    OPENAI_FAST_MODEL,
    OPENAI_REASON_MODEL,
)
from db import execute, query

PROVIDER_TYPES = [
    {"value": "openai", "label": "OpenAI 兼容 /chat/completions"},
    {"value": "responses", "label": "OpenAI Responses API（Codex / GPT）"},
    {"value": "ollama", "label": "Ollama 本地 /api/chat"},
]


def default_config() -> dict:
    return {
        "default_provider": "deepseek",
        "providers": [
            {
                "id": "deepseek",
                "name": "DeepSeek",
                "type": "openai",
                "base_url": DEEPSEEK_BASE_URL,
                "api_key": DEEPSEEK_API_KEY,
                "model_fast": DEEPSEEK_FAST_MODEL,
                "model_reason": DEEPSEEK_REASON_MODEL,
                "routing": "all",
                "enabled": True,
            },
            {
                "id": "openai-codex",
                "name": "OpenAI / Codex",
                "type": "responses",
                "base_url": OPENAI_BASE_URL,
                "api_key": OPENAI_API_KEY,
                "model_fast": OPENAI_FAST_MODEL,
                "model_reason": OPENAI_REASON_MODEL,
                "routing": "all",
                "enabled": bool(OPENAI_API_KEY),
            },
            {
                "id": "ollama",
                "name": "Ollama（本机）",
                "type": "ollama",
                "base_url": OLLAMA_BASE_URL,
                "api_key": "",
                "model_fast": OLLAMA_MODEL,
                "model_reason": OLLAMA_MODEL,
                "routing": "all",
                "enabled": False,
            },
            {
                "id": "local-qwen",
                "name": "本地 Qwen（Tailscale）",
                "type": "openai",
                "base_url": LOCAL_QWEN_BASE_URL,
                "api_key": "",
                "model_fast": LOCAL_QWEN_MODEL,
                "model_reason": LOCAL_QWEN_MODEL,
                "routing": "all",
                "enabled": False,
            },
        ],
    }


def load_config() -> dict:
    rows = query("SELECT value FROM settings WHERE key=?", (LLM_CONFIG_KEY,))
    if rows:
        try:
            cfg = json.loads(rows[0]["value"])
            if isinstance(cfg, dict) and cfg.get("providers"):
                return cfg
        except (ValueError, TypeError):
            pass
    return default_config()


def save_config(cfg: dict) -> dict:
    execute(
        "INSERT INTO settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (LLM_CONFIG_KEY, json.dumps(cfg, ensure_ascii=False)),
    )
    return load_config()


def upsert_provider(provider: dict) -> dict:
    cfg = load_config()
    if not provider.get("id"):
        provider["id"] = f"p{len(cfg['providers']) + 1}"
    for i, p in enumerate(cfg["providers"]):
        if p["id"] == provider["id"]:
            cfg["providers"][i] = provider
            break
    else:
        cfg["providers"].append(provider)
    return save_config(cfg)


def delete_provider(pid: str) -> dict:
    cfg = load_config()
    cfg["providers"] = [p for p in cfg["providers"] if p["id"] != pid]
    if cfg.get("default_provider") == pid:
        cfg["default_provider"] = cfg["providers"][0]["id"] if cfg["providers"] else ""
    return save_config(cfg)


def get_provider(pid: str) -> dict | None:
    for p in load_config()["providers"]:
        if p["id"] == pid:
            return p
    return None


# --------------------------- 密钥脱敏 ---------------------------

_MASK = "••••"


def mask_key(key: str) -> str:
    """给前端看的占位值。带一点尾缀方便用户认出是哪个 key，但不足以复用。"""
    k = (key or "").strip()
    if not k:
        return ""
    tail = k[-4:] if len(k) >= 12 else ""
    return f"{_MASK}{tail}"


def is_masked(value: str) -> bool:
    """前端把脱敏值原样回传时用它判定「用户没改这一项」。"""
    return _MASK in (value or "")


def mask_config(cfg: dict) -> dict:
    """回给设置页的副本：不含明文 api_key。"""
    out = json.loads(json.dumps(cfg or {}, ensure_ascii=False))
    for p in out.get("providers", []):
        raw = p.get("api_key") or ""
        p["api_key"] = mask_key(raw)
        p["api_key_set"] = bool(raw)
    return out


def keep_stored_keys(incoming: dict) -> dict:
    """保存前调用：脱敏值或空值表示「沿用库里已有的 key」。

    否则用户只是改了个模型名，就会把密钥清空掉。
    """
    p = dict(incoming or {})
    if p.get("id"):
        old = get_provider(p["id"])
        if old and (not p.get("api_key") or is_masked(p.get("api_key") or "")):
            p["api_key"] = old.get("api_key", "")
    return p


def resolve(mode: str = "fast") -> dict | None:
    """按任务类型选 provider：优先精确匹配的 routing，其次默认 provider。"""
    cfg = load_config()
    pool = [p for p in cfg["providers"] if p.get("enabled", True)]
    if not pool:
        return None
    for p in pool:
        if p.get("routing", "all") == mode:
            return p
    default_id = cfg.get("default_provider")
    for p in pool:
        if p["id"] == default_id:
            return p
    for p in pool:
        if p.get("routing", "all") == "all":
            return p
    return pool[0]
