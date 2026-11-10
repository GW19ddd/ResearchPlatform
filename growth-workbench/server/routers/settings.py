"""设置：LLM provider 的增删改查、连通测试、模型列表。"""
import os
import uuid

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import dify_config
import llm
from llm_config import (
    PROVIDER_TYPES,
    delete_provider,
    get_provider,
    keep_stored_keys,
    load_config,
    mask_config,
    save_config,
    upsert_provider,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("/llm")
def get_llm():
    """回给设置页。api_key 一律脱敏 —— 明文密钥不出现在任何前端响应里，
    用户不动这一栏就保持原值（见 llm_config.keep_stored_keys）。"""
    cfg = load_config()
    return {**mask_config(cfg), "types": PROVIDER_TYPES}


class ConfigIn(BaseModel):
    default_provider: str | None = None
    providers: list[dict] = []


@router.put("/llm")
def put_llm(body: ConfigIn):
    providers = [keep_stored_keys(p) for p in (body.providers or [])]
    cfg = {"default_provider": body.default_provider or "", "providers": providers}
    return {**mask_config(save_config(cfg)), "types": PROVIDER_TYPES}


@router.post("/llm/providers")
def add_provider(body: dict):
    body.setdefault("id", "p-" + uuid.uuid4().hex[:8])
    saved = keep_stored_keys(body)
    return {"config": mask_config(upsert_provider(saved)), "provider": mask_config({"providers": [saved]})["providers"][0]}


@router.put("/llm/providers/{pid}")
def update_provider(pid: str, body: dict):
    body["id"] = pid
    saved = keep_stored_keys(body)
    return {"config": mask_config(upsert_provider(saved)), "provider": mask_config({"providers": [saved]})["providers"][0]}


@router.delete("/llm/providers/{pid}")
def remove_provider(pid: str):
    return {"config": mask_config(delete_provider(pid))}


@router.post("/llm/providers/{pid}/default")
def set_default(pid: str):
    cfg = load_config()
    if not get_provider(pid):
        raise HTTPException(404, "provider not found")
    cfg["default_provider"] = pid
    return {"config": save_config(cfg)}


@router.post("/llm/test")
async def test(body: dict):
    """body 可以是一个完整 provider 草稿，也可以只带 id。"""
    p = body if body.get("base_url") else get_provider(body.get("id", ""))
    if not p:
        raise HTTPException(404, "provider not found")
    res = await llm.test_connection(p)
    return res


@router.post("/llm/models")
async def models(body: dict):
    p = body if body.get("base_url") else get_provider(body.get("id", ""))
    if not p:
        raise HTTPException(404, "provider not found")
    return await llm.list_models(p)


@router.get("/llm/usage")
def usage():
    from db import query

    rows = query(
        "SELECT provider, COUNT(*) n, SUM(tokens_in) tin, SUM(tokens_out) tout "
        "FROM llm_usage GROUP BY provider ORDER BY n DESC"
    )
    return rows


# ---------- OpenAlex（文献检索数据源） ----------


def _mask_key(k: str) -> str:
    if not k:
        return ""
    return k[:4] + "…" + k[-4:] if len(k) > 10 else "已配置"


@router.get("/openalex")
def get_openalex():
    """只回脱敏 key + 最近一次请求看到的额度，明文密钥不出现在响应里。"""
    import openalex as oa

    q = oa.snapshot()
    q["key_masked"] = _mask_key(oa.api_key())
    q["from_env"] = bool(os.getenv("OPENALEX_API_KEY", "").strip())
    q["signup_url"] = "https://openalex.org/settings/api"
    return q


class OpenAlexKeyIn(BaseModel):
    api_key: str = ""


@router.put("/openalex")
def put_openalex(body: OpenAlexKeyIn):
    """空串视为「保持原值」，清空请走 DELETE。"""
    import openalex as oa

    if body.api_key.strip():
        oa.save_key(body.api_key.strip())
    q = oa.snapshot()
    q["key_masked"] = _mask_key(oa.api_key())
    q["from_env"] = bool(os.getenv("OPENALEX_API_KEY", "").strip())
    q["signup_url"] = "https://openalex.org/settings/api"
    return q


@router.delete("/openalex")
def clear_openalex():
    import openalex as oa

    oa.save_key("")
    q = oa.snapshot()
    q["key_masked"] = ""
    q["from_env"] = bool(os.getenv("OPENALEX_API_KEY", "").strip())
    q["signup_url"] = "https://openalex.org/settings/api"
    return q


@router.post("/openalex/test")
async def test_openalex():
    """用一次详情请求（1 credit）探活，顺便把额度状态带回来。"""
    import openalex as oa

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await oa.get(client, url=f"{oa.BASE}/W2626778328", cache=False)
        return {"ok": True, "message": "OpenAlex 可达，额度正常", **oa.snapshot()}
    except oa.OAError as e:
        return {"ok": False, "message": e.message, "hint": e.hint, **oa.snapshot()}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"{type(e).__name__}: {e}"}



# ---------- Dify ----------


@router.get("/dify")
def get_dify():
    cfg = dify_config.load_config()
    return {**dify_config.mask(cfg), "modes": dify_config.APP_MODES}


class DifyIn(BaseModel):
    enabled: bool = False
    base_url: str = ""
    apps: list[dict] = []


@router.put("/dify")
def put_dify(body: DifyIn):
    old = dify_config.load_config()
    kept = {a["id"]: a for a in old.get("apps", [])}
    apps = []
    for a in body.apps:
        # 前端拿到的是脱敏 key，未改动的保留原值
        if a.get("api_key") in ("", None) and a.get("id") in kept:
            a["api_key"] = kept[a["id"]].get("api_key", "")
        apps.append(a)
    cfg = {"enabled": body.enabled, "base_url": body.base_url, "apps": apps}
    return {**dify_config.mask(dify_config.save_config(cfg)), "modes": dify_config.APP_MODES}


@router.post("/dify/apps")
def add_dify_app(body: dict):
    body.setdefault("id", "d-" + uuid.uuid4().hex[:8])
    return {"config": dify_config.mask(dify_config.upsert_app(body)), "app": dify_config.mask_app(body)}


@router.delete("/dify/apps/{app_id}")
def del_dify_app(app_id: str):
    return {"config": dify_config.mask(dify_config.delete_app(app_id))}


@router.post("/dify/test")
async def test_dify(body: dict):
    """两段测试：先探地址可达，再用某个应用（或临时 key）调 Dify 的参数接口。"""
    base = (body.get("base_url") or "").rstrip("/")
    if not base:
        return {"ok": False, "message": "先填 Dify 的 API 地址，例如 http://localhost/v1"}
    root = base[:-3] if base.endswith("/v1") else base
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            r = await client.get(root)
        reachable = f"地址可达 · HTTP {r.status_code}"
    except Exception as exc:
        return {"ok": False, "message": f"地址不通：{type(exc).__name__}: {exc}"}

    app_id = body.get("app_id") or ""
    key = body.get("api_key") or ""
    if not key and app_id:
        app = dify_config.get_app(app_id)
        key = (app or {}).get("api_key", "")
    if not key:
        return {"ok": True, "message": f"{reachable}（未填 API Key，只验证了地址）"}

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(
                f"{base}/parameters", headers={"Authorization": f"Bearer {key}"}
            )
        if r.status_code == 200:
            data = r.json() or {}
            fields = [f.get("label") or list(f.values())[0] for f in (data.get("user_input_form") or [])]
            names = ", ".join(str(x) for x in fields[:8]) if fields else "（该应用无需入参）"
            return {"ok": True, "message": f"{reachable} · Key 有效 · 入参：{names}"}
        return {"ok": False, "message": f"{reachable} · 但 Key 校验失败：HTTP {r.status_code} {r.text[:160]}"}
    except Exception as exc:
        return {"ok": False, "message": f"{reachable} · 参数接口调用失败：{type(exc).__name__}: {exc}"}
