"""真实大模型调用冒烟 —— 独立脚本，**不参与 pytest 收集**。

用法：
    python server/tests/live_llm_smoke.py

输出：
    growth-workbench/docs/llm-live-smoke.json
    stdout 里打印一份人类可读摘要

边界声明（务必与 test_llm_feature_matrix.py 区分）：
- 本脚本会**真实调用**设置页里启用的 provider（当前为 DeepSeek / deepseek-chat），
  产生真实 token 消耗，并向真实库的 llm_usage 表写用量记录。
- 业务端点只选不落库的入口（/api/chat/quick、/api/canvas/auto 且 save=false），
  不往 ideas / literature / experiments / chat_messages 等业务表写任何东西。
- 任何一步失败都如实记录 ok=false 与错误信息，绝不补写「看起来成功」的结果。
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import sys
import time
import traceback

ROOT = pathlib.Path(__file__).resolve().parents[2]  # growth-workbench
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))

import llm  # noqa: E402
import llm_config  # noqa: E402

OUT = ROOT / "docs" / "llm-live-smoke.json"
results: list[dict] = []


def clip(v, n: int = 240):
    s = str(v if v is not None else "")
    return s if len(s) <= n else s[:n] + "…"


def record(name: str, ok: bool, t0: float, **fields):
    row = {
        "name": name,
        "ok": bool(ok),
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
    }
    row.update({k: clip(v) if isinstance(v, str) else v for k, v in fields.items()})
    results.append(row)
    flag = "OK  " if ok else "FAIL"
    print(f"[{flag}] {name} ({row['elapsed_ms']}ms)" + (f" — {clip(fields.get('summary', ''), 90)}" if fields.get("summary") else ""))


async def step(name: str, coro_factory):
    t0 = time.monotonic()
    try:
        value = await coro_factory()
        return value, t0, None
    except Exception as exc:  # noqa: BLE001
        return None, t0, exc


async def main():
    cfg = llm_config.load_config()
    enabled = [p for p in cfg.get("providers", []) if p.get("enabled")]
    providers = [
        {
            "id": p.get("id"),
            "name": p.get("name"),
            "type": p.get("type"),
            "base_url": p.get("base_url"),
            "model_fast": p.get("model_fast"),
            "model_reason": p.get("model_reason"),
            "api_key_set": bool(p.get("api_key")),
            "enabled": True,
        }
        for p in enabled
    ]
    print(f"启用的 provider：{json.dumps(providers, ensure_ascii=False)}")
    print(f"FORCE_FAST = {llm.FORCE_FAST}\n")

    if not providers:
        record("provider_available", False, time.monotonic(), summary="没有启用的 provider，跳过全部真实调用")
        return

    p = llm_config.get_provider(cfg.get("default_provider") or providers[0]["id"]) or enabled[0]

    # 1. 设置页「测试连接」
    val, t0, err = await step("test_connection", lambda: llm.test_connection(p))
    record("settings.test_connection", err is None and bool(val and val.get("ok")), t0,
           summary=(val or {}).get("message") if not err else f"{type(err).__name__}: {err}")

    # 2. 设置页「拉取模型列表」
    val, t0, err = await step("list_models", lambda: llm.list_models(p))
    models = (val or {}).get("models", []) if not err else []
    record("settings.list_models", err is None and bool(val and val.get("ok")), t0,
           summary=f"共 {len(models)} 个模型：{', '.join(models[:6])}" if not err else f"{type(err).__name__}: {err}",
           model_count=len(models))

    # 3. complete_result（fast）
    val, t0, err = await step(
        "complete_result.fast",
        lambda: llm.complete_result("用一句话说明什么是单元测试生成。不要解释。",
                                    mode="fast", task="live-smoke", max_tokens=120),
    )
    env_fast = val or {}
    record("llm.complete_result(fast)", err is None and env_fast.get("ok") is True, t0,
           summary=env_fast.get("content") or (f"{type(err).__name__}: {err}" if err else ""),
           model=env_fast.get("model"), tokens_in=env_fast.get("tokens_in"),
           tokens_out=env_fast.get("tokens_out"),
           error_kind=(env_fast.get("error") or {}).get("kind") if not err else type(err).__name__)

    # 4. complete_result（reason）—— 验证 FORCE_FAST 是否真的把它压到 fast 模型
    val, t0, err = await step(
        "complete_result.reason",
        lambda: llm.complete_result("只回复两个字：收到", mode="reason",
                                    task="live-smoke", max_tokens=120),
    )
    env_reason = val or {}
    record("llm.complete_result(reason→FORCE_FAST)", err is None and env_reason.get("ok") is True, t0,
           summary=env_reason.get("content") or (f"{type(err).__name__}: {err}" if err else ""),
           model=env_reason.get("model"),
           same_model_as_fast=env_reason.get("model") == env_fast.get("model"),
           degraded=env_reason.get("degraded", False))

    # 5. complete_json_result（真实解析）
    val, t0, err = await step(
        "complete_json_result",
        lambda: llm.complete_json_result(
            "请只输出一个 JSON 对象，含字段 ok(boolean) 与 note(string)，不要解释、不要围栏。",
            mode="fast", task="live-smoke", max_tokens=160,
        ),
    )
    data, jenv = (val if isinstance(val, tuple) else (None, {}))
    record("llm.complete_json_result", err is None and bool(jenv.get("ok")) and isinstance(data, dict), t0,
           summary=json.dumps(data, ensure_ascii=False)[:200] if data is not None else
                   (f"{type(err).__name__}: {err}" if err else (jenv.get("error") or {}).get("message", "")),
           parsed_type=type(data).__name__,
           error_kind=(jenv.get("error") or {}).get("kind"))

    # 6. chat_result（多轮）
    val, t0, err = await step(
        "chat_result",
        lambda: llm.chat_result(
            [{"role": "user", "content": "记住数字 42。"},
             {"role": "user", "content": "刚才那个数字是多少？只回复数字。"}],
            system="你是精确的助手。", mode="fast", task="live-smoke", max_tokens=80,
        ),
    )
    cenv = val or {}
    record("llm.chat_result", err is None and cenv.get("ok") is True, t0,
           summary=cenv.get("content") or (f"{type(err).__name__}: {err}" if err else ""),
           model=cenv.get("model"))

    # 7. stream_chat_events（真实流式）
    t0 = time.monotonic()
    events = []
    try:
        async for ev in llm.stream_chat_events(
            [{"role": "user", "content": "数到三，用中文，只输出 1 2 3"}],
            system="你是简洁的助手。", mode="fast", task="live-smoke", max_tokens=80,
        ):
            events.append(ev)
        kinds = [e.get("type") for e in events]
        meta = next((e for e in events if e.get("type") == "meta"), {})
        record("llm.stream_chat_events", "meta" in kinds and "error" not in kinds, t0,
               summary=f"事件={kinds} 正文={clip(meta.get('content'), 100)}",
               event_types=kinds, model=meta.get("model"))
    except Exception as exc:  # noqa: BLE001
        record("llm.stream_chat_events", False, t0, summary=f"{type(exc).__name__}: {exc}")

    # 8. redact（本地函数，不联网，但属于密钥防护功能点）
    t0 = time.monotonic()
    masked = llm.redact("Bearer sk-should-be-hidden-123456 出错")
    record("llm.redact", "sk-should-be-hidden-123456" not in masked, t0, summary=masked)

    # 9/10. 真实业务端点（不落库）：/api/chat/quick 与 /api/canvas/auto?save=false
    # 本机启用了登录闸门（已有真实账户），验收时签一条临时会话，跑完立刻撤销，
    # 不碰 users 表，也不留下长期有效的 cookie。
    try:
        from fastapi.testclient import TestClient
        import auth
        import main
        from db import query as _q

        with TestClient(main.app) as c:
            users = _q("SELECT id FROM users LIMIT 1")
            token = auth.issue_session(users[0]["id"]) if users else None
            if token:
                c.cookies.set(auth.SESSION_COOKIE, token)
            try:
                t0 = time.monotonic()
                try:
                    r = c.post("/api/chat/quick", json={"content": "只回复两个字：可用", "mode": "fast"})
                    j = r.json()
                    record("endpoint.POST /api/chat/quick", r.status_code == 200 and j.get("ok") is True, t0,
                           summary=j.get("content") or (j.get("error") or {}).get("message", ""),
                           status_code=r.status_code, model=j.get("model"))
                except Exception as exc:  # noqa: BLE001
                    record("endpoint.POST /api/chat/quick", False, t0, summary=f"{type(exc).__name__}: {exc}")

                t0 = time.monotonic()
                try:
                    r = c.post("/api/canvas/auto", json={"topic": "LLM 单元测试生成", "save": False})
                    j = r.json()
                    record("endpoint.POST /api/canvas/auto (save=false)",
                           r.status_code == 200 and j.get("ok") is True and bool(j.get("nodes")), t0,
                           summary=f"nodes={len(j.get('nodes') or [])} edges={len(j.get('edges') or [])} "
                                   f"fallback={j.get('fallback')} dropped={len(j.get('dropped') or [])}",
                           status_code=r.status_code, fallback=j.get("fallback"),
                           node_count=len(j.get("nodes") or []))
                except Exception as exc:  # noqa: BLE001
                    record("endpoint.POST /api/canvas/auto (save=false)", False, t0,
                           summary=f"{type(exc).__name__}: {exc}")
            finally:
                if token:
                    auth.revoke_session(token)
    except Exception as exc:  # noqa: BLE001
        record("endpoint.harness", False, time.monotonic(),
               summary=f"TestClient 启动失败：{type(exc).__name__}: {exc}\n{traceback.format_exc()[:400]}")


if __name__ == "__main__":
    asyncio.run(main())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "kind": "REAL_LLM_CALLS",
        "note": "真实模型调用，非 mock；失败项如实记录，未做任何补写。",
        "results": results,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    ok_n = sum(1 for r in results if r["ok"])
    print(f"\n合计 {ok_n}/{len(results)} 项通过，结果已写入 {OUT}")
