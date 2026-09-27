"""LLM 调用层。

支持三类后端，配置来自数据库（设置页可改）：
- openai   : OpenAI 兼容 /chat/completions —— DeepSeek、本地 Qwen、各类中转
- responses: OpenAI Responses API —— Codex / GPT 系列
- ollama   : Ollama 原生 /api/chat

调用结果一律返回**统一信封**：

    {"ok": True,  "content": "...", "provider": ..., "model": ..., "tokens_in": n, "tokens_out": m, "error": None}
    {"ok": False, "content": "",    "provider": ..., "model": ..., "tokens_in": 0, "tokens_out": 0,
     "error": {"kind": "...", "message": "...", "detail": "...", "hint": "..."}}

失败时 `content` 恒为空字符串 —— 错误文本不会再被上层当成模型产出写进
创新点 / 文献笔记 / 实验结论。`error.detail` 里的密钥在出库前会被脱敏。
"""
import json
import re
from typing import Any, Literal

import httpx

from db import execute, now
from llm_config import load_config, resolve

RESEARCH_SYSTEM = (
    "你是一位严谨的科研助手，服务于一位做 OpenFOAM/CFD 与 LLM 智能体方向研究的博士生。"
    "回答用简体中文，结构化、具体、可执行，拒绝空话套话。"
    "涉及方法对比时优先用表格。不要臆造文献、数字或引用。"
)

# 错误分类 → 给用户的一句话建议
KIND_HINTS = {
    "no_provider": "去「设置」页添加一个 provider：DeepSeek / OpenAI(Codex) / Ollama / 本地 Qwen / 任意兼容端点。",
    "no_key": "去「设置」页给这个 provider 填 API Key，或改用 Ollama / 本地 Qwen 这类不需要 key 的端点。",
    "auth": "API Key 无效或已过期，去「设置」页点「测试连接」确认。",
    "http_error": "端点返回了错误状态码，去「设置」页点「测试连接」看具体原因。",
    "timeout": "请求超时。可以减少输入长度或换更快的模型后重试。",
    "network": "连不上端点。检查网络 / Tailscale / 本地服务是否在运行。",
    "empty_output": "模型没有输出内容（推理过程可能耗尽了输出上限），重试或换用非推理模型。",
    "parse": "模型返回的内容不是需要的格式，重试即可。",
    "unknown": "未知错误。重试一次，或到「设置」页检查 provider 配置。",
}

KIND_LABELS = {
    "no_provider": "没有可用的模型服务",
    "no_key": "未配置 API Key",
    "auth": "密钥校验失败",
    "http_error": "服务端返回错误",
    "timeout": "请求超时",
    "network": "网络不通",
    "empty_output": "模型未输出内容",
    "parse": "返回内容无法解析",
    "unknown": "调用失败",
}


class LLMError(Exception):
    """一次 LLM 调用的业务级失败：带机器可读的 kind 与人可读的 message。"""

    def __init__(self, kind: str, message: str, detail: str = ""):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.detail = detail or ""


# ---------------------------------------------------------------- 密钥脱敏

# 常见密钥形态兜底：即使某个 key 没登记在配置里，也尽量不让它出现在界面/日志中
_SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{6,}"),
    re.compile(r"\bapp-[A-Za-z0-9]{6,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{6,}"),
    re.compile(r"(?i)(api[_-]?key|authorization|token)[\"'\s:=]{1,4}[A-Za-z0-9._\-]{8,}"),
]


def _known_secrets() -> list[str]:
    """配置里登记过的明文密钥（LLM provider + Dify 应用）。"""
    vals: list[str] = []
    try:
        for p in load_config().get("providers", []):
            v = (p or {}).get("api_key") or ""
            if len(v) >= 6:
                vals.append(v)
    except Exception:  # noqa: BLE001 —— 配置读取失败不应该掩盖真正的错误
        pass
    try:
        import dify_config

        for a in dify_config.load_config().get("apps", []):
            v = (a or {}).get("api_key") or ""
            if len(v) >= 6:
                vals.append(v)
    except Exception:  # noqa: BLE001
        pass
    return vals


def redact(text: Any) -> str:
    """把文本里可能出现的密钥换成 ***。

    错误详情要给用户看、要写日志，但绝不能把明文 key 带出去。
    """
    s = str(text or "")
    for secret in _known_secrets():
        if secret and secret in s:
            s = s.replace(secret, "***")
    for pat in _SECRET_PATTERNS:
        s = pat.sub(lambda m: _mask_match(m.group(0)), s)
    return s


def _mask_match(m: str) -> str:
    head = m.split()[-1] if " " in m else m
    return "***"


# ---------------------------------------------------------------- 信封


def ok_env(content: str, p: dict, model: str, tin: Any, tout: Any) -> dict:
    return {
        "ok": True,
        "content": content or "",
        "provider": (p or {}).get("name", ""),
        "provider_id": (p or {}).get("id", ""),
        "model": model or "",
        "tokens_in": int(tin or 0),
        "tokens_out": int(tout or 0),
        "error": None,
    }


def fail_env(err: Exception | LLMError, p: dict | None = None) -> dict:
    """把任意异常收敛成失败信封。kind / message / detail / hint 四件套。"""
    if isinstance(err, LLMError):
        kind, message, detail = err.kind, err.message, redact(err.detail)
    else:
        kind, message, detail = _classify(err)
    return {
        "ok": False,
        "content": "",
        "provider": (p or {}).get("name", "") if p else "",
        "provider_id": (p or {}).get("id", "") if p else "",
        "model": "",
        "tokens_in": 0,
        "tokens_out": 0,
        "error": {
            "kind": kind,
            "label": KIND_LABELS.get(kind, "调用失败"),
            "message": redact(message),
            "detail": detail,
            "hint": KIND_HINTS.get(kind, ""),
        },
    }


def _classify(exc: Exception) -> tuple[str, str, str]:
    """把 httpx / 其他异常翻译成 (kind, message, detail)。"""
    detail = redact(f"{type(exc).__name__}: {exc}")
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code if exc.response is not None else 0
        kind = "auth" if status in (401, 403) else "http_error"
        return kind, f"服务端返回 HTTP {status}", detail
    if isinstance(exc, httpx.TimeoutException):
        return "timeout", "等待模型响应超时", detail
    if isinstance(exc, httpx.ConnectError):
        return "network", "连不上模型服务地址", detail
    if isinstance(exc, httpx.HTTPError):
        return "network", "与模型服务的通信失败", detail
    return "unknown", f"{type(exc).__name__}: {exc}"[:200], detail


# ---------------------------------------------------------------- provider


def _model_of(p: dict, mode: str) -> str:
    return p.get("model_reason") if mode == "reason" else p.get("model_fast") or p.get("model_reason")


def _headers(p: dict) -> dict:
    h = {"Content-Type": "application/json"}
    if p.get("api_key"):
        h["Authorization"] = f"Bearer {p['api_key']}"
    return h


def _base(p: dict) -> str:
    return (p.get("base_url") or "").rstrip("/")


def pick_provider(provider_id: str | None, mode: str) -> dict:
    """选 provider；没得选就抛 LLMError(no_provider)。"""
    p = None
    if provider_id:
        cfg = load_config()
        p = next((x for x in cfg["providers"] if x["id"] == provider_id), None)
    if p is None:
        p = resolve(mode)
    if p is None:
        raise LLMError(
            "no_provider",
            "没有可用的 LLM provider",
            "设置页里所有 provider 都是禁用状态，或还没有添加任何 provider。",
        )
    return p


def require_key(p: dict):
    if not p.get("api_key") and p.get("type") in ("openai", "responses"):
        raise LLMError(
            "no_key",
            f"provider「{p.get('name')}」未填 API Key",
            f"provider_id={p.get('id')} base_url={p.get('base_url')}",
        )


# ---------------------------------------------------------------- 底层调用


async def _call_openai(p: dict, model: str, messages: list, max_tokens: int, temperature: float):
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=300.0) as client:
        r = await client.post(f"{_base(p)}/chat/completions", json=payload, headers=_headers(p))
        r.raise_for_status()
        data = r.json()
    choice = (data.get("choices") or [{}])[0]
    content = ((choice.get("message") or {}).get("content")) or ""
    if not content.strip():
        usage = data.get("usage", {}) or {}
        detail = (usage.get("completion_tokens_details") or {}) if isinstance(usage, dict) else {}
        raise LLMError(
            "empty_output",
            "模型未输出任何内容",
            f"finish_reason={choice.get('finish_reason')} "
            f"completion_tokens={usage.get('completion_tokens', 0)} "
            f"reasoning_tokens={detail.get('reasoning_tokens', '未知')}",
        )
    usage = data.get("usage", {}) or {}
    return content, usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)


async def _call_responses(p: dict, model: str, messages: list, max_tokens: int):
    """OpenAI Responses API —— Codex / GPT 系列走这条。"""
    payload = {
        "model": model,
        "input": [{"role": m["role"], "content": m["content"]} for m in messages],
        "max_output_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=300.0) as client:
        r = await client.post(f"{_base(p)}/responses", json=payload, headers=_headers(p))
        r.raise_for_status()
        data = r.json()
    text = data.get("output_text")
    if not text:
        chunks = []
        for item in data.get("output", []) or []:
            for c in item.get("content", []) or []:
                if c.get("type") in ("output_text", "text") and c.get("text"):
                    chunks.append(c["text"])
        text = "\n".join(chunks)
    usage = data.get("usage", {}) or {}
    return text or "", usage.get("input_tokens", 0), usage.get("output_tokens", 0)


async def _call_ollama(p: dict, model: str, messages: list, max_tokens: int, temperature: float):
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": max_tokens, "temperature": temperature},
    }
    async with httpx.AsyncClient(timeout=300.0) as client:
        r = await client.post(f"{_base(p)}/api/chat", json=payload, headers=_headers(p))
        r.raise_for_status()
        data = r.json()
    content = ((data.get("message") or {}).get("content")) or ""
    return (
        content,
        data.get("prompt_eval_count", 0) or 0,
        data.get("eval_count", 0) or 0,
    )


async def _dispatch(p: dict, messages: list, mode: str, max_tokens: int, temperature: float):
    model = _model_of(p, mode)
    kind = p.get("type", "openai")
    if kind == "responses":
        return await _call_responses(p, model, messages, max_tokens)
    if kind == "ollama":
        return await _call_ollama(p, model, messages, max_tokens, temperature)
    return await _call_openai(p, model, messages, max_tokens, temperature)


def _effective_max_tokens(mode: str, max_tokens: int) -> int:
    """reason 模式下 max_tokens 覆盖 CoT + 最终回答，太小会被推理吃光导致输出为空。"""
    if mode == "reason":
        return max(max_tokens, 8192)
    return max_tokens


async def _log_usage(p: dict, task: str, tin: Any, tout: Any):
    try:
        execute(
            "INSERT INTO llm_usage (provider, task, tokens_in, tokens_out, created_at) VALUES (?,?,?,?,?)",
            (p.get("id"), task, int(tin or 0), int(tout or 0), now()),
        )
    except Exception:  # noqa: BLE001 —— 用量统计失败不该影响主流程
        pass


# ---------------------------------------------------------------- 对外 API


async def complete_result(
    prompt: str,
    system: str = RESEARCH_SYSTEM,
    mode: Literal["fast", "reason"] = "fast",
    task: str = "generic",
    max_tokens: int = 2048,
    provider_id: str | None = None,
    messages: list[dict] | None = None,
) -> dict:
    """一次调用，返回带 ok / error 的信封。失败不抛，交由调用方决定如何展示。"""
    p = None
    try:
        p = pick_provider(provider_id, mode)
        require_key(p)
        msgs = messages if messages is not None else [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
        content, tin, tout = await _dispatch(
            p, msgs, mode, _effective_max_tokens(mode, max_tokens),
            0.3 if mode == "fast" else 0.0,
        )
        await _log_usage(p, task, tin, tout)
        return ok_env(content, p, _model_of(p, mode), tin, tout)
    except Exception as exc:  # noqa: BLE001 —— 任何失败都要变成信封，而不是 500
        return fail_env(exc, p)


async def complete_json_result(prompt: str, **kwargs) -> tuple[Any, dict]:
    """期望模型回 JSON。返回 (数据 | None, 信封)。

    解析失败时 ok 也为 False —— 上层不能拿着「假 JSON」当成果用。
    """
    env = await complete_result(
        prompt + "\n\n请只输出合法 JSON，不要包含解释文字或代码块围栏。", **kwargs
    )
    if not env["ok"]:
        return None, env
    raw = (env["content"] or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        raw = raw.split("\n", 1)[-1]
    try:
        return json.loads(raw), env
    except Exception as exc:  # noqa: BLE001
        return None, fail_env(
            LLMError("parse", "返回内容不是合法 JSON", redact(raw[:200])), None
        )


async def chat_result(
    messages: list[dict],
    system: str = RESEARCH_SYSTEM,
    mode: Literal["fast", "reason"] = "fast",
    task: str = "chat",
    max_tokens: int = 4096,
    provider_id: str | None = None,
) -> dict:
    """多轮对话：messages 已含历史 [{'role','content'}...]。"""
    msgs = [{"role": m.get("role", "user"), "content": m.get("content", "")} for m in messages]
    return await complete_result(
        None, system=system, mode=mode, task=task,
        max_tokens=max_tokens, provider_id=provider_id, messages=msgs,
    )


# 兼容旧名：画布模块原本用的是 complete_with_meta
complete_with_meta = complete_result


async def test_connection(p: dict) -> dict:
    """设置页的「测试连接」：发一条极短消息，返回是否可用。"""
    try:
        content, _tin, _tout = await _dispatch(
            p,
            [
                {"role": "system", "content": "你是连通性测试助手。"},
                {"role": "user", "content": "请只回复两个字：可用"},
            ],
            "fast",
            64,
            0.0,
        )
        return {
            "ok": True,
            "message": redact(
                f"连通正常 · 模型 {_model_of(p, 'fast')} 回复：{(content or '').strip()[:40]}"
            ),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": redact(f"{type(exc).__name__}: {exc}")}


async def list_models(p: dict) -> dict:
    """拉取 provider 的可用模型列表（Ollama / OpenAI 兼容端点支持）。"""
    kind = p.get("type", "openai")
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            if kind == "ollama":
                r = await client.get(f"{_base(p)}/api/tags", headers=_headers(p))
                r.raise_for_status()
                names = [m.get("name") for m in (r.json().get("models") or [])]
            else:
                r = await client.get(f"{_base(p)}/models", headers=_headers(p))
                r.raise_for_status()
                names = [m.get("id") for m in (r.json().get("data") or [])]
        names = [n for n in names if n]
        return {"ok": True, "models": sorted(names)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": redact(f"{type(exc).__name__}: {exc}"), "models": []}
