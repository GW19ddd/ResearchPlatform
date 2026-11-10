"""在线文献检索：走 OpenAlex（免费、无 key），覆盖 arXiv / PubMed / 主流出版社。

两条链路：
1. GET /litsearch —— 关键词 / DOI 检索，返回可一键入库的命中列表（老接口，字段向后兼容）。
2. GET /litsearch/discover —— SSE 流式「关联文献发现」：以一篇种子文献为起点，
   拉 referenced_works（参考文献）与 cites:（施引文献），回传真实进度 + 引文网络。
   对应 Litmaps 式「搜索 → 检索过程 → 检索结果」三段体验。

检索到的文献不自动落库；入库仍走原 POST /literature，复用去重、对比矩阵、
AI 笔记整条链路，不另起炉灶。
"""
import json
import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

import openalex

router = APIRouter(prefix="/api", tags=["litsearch"])

# 请求统一走 openalex.get()：自带 API key、15 分钟缓存、429 人话兜底。
_OA = openalex.BASE


def _short_id(full: str) -> str:
    """https://openalex.org/W123 → W123"""
    return (full or "").replace("https://openalex.org/", "").replace(
        "http://openalex.org/", ""
    )


def _strip_doi(doi: str) -> str:
    d = doi or ""
    for pfx in ("https://doi.org/", "http://doi.org/"):
        if d.startswith(pfx):
            return d[len(pfx):]
    return d


def _meta(w: dict) -> dict:
    """OpenAlex work → 前端统一结构。

    _ref_ids 是内部字段（用于还原跨节点引用边），发到前端前由 _public 剥掉。
    citations / references 都是 OpenAlex 原始计数，不是估算值。
    """
    authors = ", ".join(
        a["author"]["display_name"]
        for a in (w.get("authorships") or [])[:5]
        if a.get("author")
    )
    primary = w.get("primary_location") or {}
    src = primary.get("source") or {}
    oa = w.get("open_access") or {}
    best = w.get("best_oa_location") or {}
    return {
        "oa_id": _short_id(w.get("id", "")),
        "title": w.get("display_name") or "(无标题)",
        "authors": authors,
        "year": w.get("publication_year"),
        "venue": src.get("display_name") or "",
        "doi": _strip_doi(w.get("doi") or ""),
        "url": w.get("doi") or primary.get("landing_page_url") or "",
        "citations": int(w.get("cited_by_count") or 0),
        "references": int(w.get("referenced_works_count") or 0),
        "oa": bool(oa.get("is_oa")),
        "pdf_url": best.get("pdf_url") or oa.get("oa_url") or "",
        "_ref_ids": [_short_id(r) for r in (w.get("referenced_works") or [])],
    }


def _public(m: dict) -> dict:
    return {k: v for k, v in m.items() if not k.startswith("_")}


@router.get("/litsearch")
async def litsearch(q: str, limit: int = 20):
    """搜 OpenAlex。输入长得像 DOI 就按 DOI 精确查，否则全文检索。

    结果额外带 oa_id / references，供「关联文献发现」直接从建议项启动，
    老字段（title/authors/year/venue/cited_by/oa/pdf_url/url）保持不变。
    """
    q = (q or "").strip()
    if not q:
        return {"ok": True, "results": []}

    params: dict = {
        "per-page": max(1, min(int(limit), 100)),
    }
    if q.lower().startswith("10.") and "/" in q:
        params["filter"] = f"doi:{q}"
    else:
        params["search"] = q

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            data = await openalex.get(client, params)
    except openalex.OAError as e:  # 限流 / 网络 / 上游错误：原样带回给前端展示
        return {
            "ok": False,
            "error": e.message,
            "code": e.code,
            "hint": e.hint,
            "reset_in": e.reset_in,
            "results": [],
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"OpenAlex 请求失败：{e}", "results": []}

    results = []
    for w in data.get("results", []):
        m = _meta(w)
        results.append(
            {
                "title": m["title"],
                "authors": m["authors"],
                "year": m["year"],
                "venue": m["venue"],
                "cited_by": m["citations"],
                "oa": m["oa"],
                "pdf_url": m["pdf_url"],
                "url": m["url"],
                # 新增：发现流程用的种子标识与参考文献数
                "oa_id": m["oa_id"],
                "references": m["references"],
                "doi": m["doi"],
            }
        )
    return {"ok": True, "total": (data.get("meta") or {}).get("count"), "results": results}


# ---------------------------------------------------------------- 关联文献发现（SSE）


def _sse(ev: dict) -> str:
    return "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"


@router.get("/litsearch/discover")
async def discover(q: str = "", oa_id: str = "", limit: int = 20):
    """以种子文献为起点检索关联文献，按真实阶段流式回传进度与结果。

    事件类型：
      stage —— {stage, progress, label, detail, seed?}，progress 是后端真实完成的百分比
      done  —— {result: {seed, papers, edges, source, stats}}
      error —— {message}

    边语义：source cites target（A → B 表示 A 引用了 B）。边全部来自 OpenAlex
    referenced_works，不臆造、不按相似度猜。
    """
    n = max(1, min(int(limit), 30))

    async def gen():
        try:
            yield _sse(
                {
                    "type": "stage",
                    "stage": "resolve",
                    "progress": 8,
                    "label": "正在定位种子文献…",
                    "detail": "在 OpenAlex 中匹配标题 / DOI",
                }
            )
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                if oa_id:
                    sid = _short_id(oa_id)
                    seed_w = await openalex.get(
                        client, url=f"{_OA}/{sid}", ttl=86400
                    )
                else:
                    params: dict = {"per-page": 1}
                    if q.lower().startswith("10.") and "/" in q:
                        params["filter"] = f"doi:{q}"
                    else:
                        params["search"] = q
                    found = (await openalex.get(client, params)).get("results", [])
                    if not found:
                        yield _sse(
                            {
                                "type": "error",
                                "message": "OpenAlex 中没有找到匹配的文献，换个关键词或粘贴 DOI 试试",
                                "code": "not_found",
                            }
                        )
                        return
                    sid = _short_id(found[0].get("id", ""))
                    if not sid:
                        yield _sse({"type": "error", "message": "命中结果缺少 OpenAlex ID"})
                        return
                    # 命中结果里已带 referenced_works 时不必再拉详情（一次详情也要计费）
                    seed_w = found[0]
                    if not seed_w.get("referenced_works"):
                        try:
                            seed_w = await openalex.get(
                                client, url=f"{_OA}/{sid}", ttl=86400
                            )
                        except openalex.OAError:
                            seed_w = found[0]

                seed_id = _short_id(seed_w.get("id", "")) or sid
                yield _sse(
                    {
                        "type": "stage",
                        "stage": "seed",
                        "progress": 24,
                        "label": "已锁定种子文献",
                        "detail": seed_w.get("display_name") or "",
                        "seed": _public(_meta(seed_w)),
                    }
                )

                yield _sse(
                    {
                        "type": "stage",
                        "stage": "references",
                        "progress": 42,
                        "label": "正在检索数千条引文与参考文献…",
                        "detail": "读取 referenced_works",
                    }
                )
                ref_ids = _meta(seed_w)["_ref_ids"][:n]
                ref_works: list[dict] = []
                for i in range(0, len(ref_ids), 50):
                    batch = ref_ids[i : i + 50]
                    data = await openalex.get(
                        client,
                        {
                            "filter": "openalex_id:" + "|".join(batch),
                            "per-page": 50,
                        },
                        ttl=86400,
                    )
                    ref_works.extend(data.get("results", []))

                yield _sse(
                    {
                        "type": "stage",
                        "stage": "citing",
                        "progress": 64,
                        "label": "正在检索引用了它的论文…",
                        "detail": "按被引次数取最相关的施引论文",
                    }
                )
                citing_works = (
                    await openalex.get(
                        client,
                        {
                            "filter": f"cites:{seed_id}",
                            "per-page": n,
                            "sort": "cited_by_count:desc",
                        },
                        ttl=3600,
                    )
                ).get("results", [])

                yield _sse(
                    {
                        "type": "stage",
                        "stage": "graph",
                        "progress": 86,
                        "label": "正在构建引文网络…",
                        "detail": "合并节点、还原引用方向",
                    }
                )

                # 合并去重：种子 + 参考文献 + 施引文献
                all_works: dict[str, dict] = {seed_id: seed_w}
                for w in ref_works + citing_works:
                    wid = _short_id(w.get("id", ""))
                    if wid:
                        all_works.setdefault(wid, w)
                ref_set = set(ref_ids)

                papers = []
                for wid, w in all_works.items():
                    m = _meta(w)
                    m["relation"] = (
                        "seed" if wid == seed_id
                        else "reference" if wid in ref_set
                        else "citing"
                    )
                    papers.append(_public(m))

                # 真实引用边：只连「出现在本次结果集里」的引用关系，不猜相似边
                edges: list[dict] = []
                seen: set[tuple[str, str]] = set()
                for wid, w in all_works.items():
                    for raw in w.get("referenced_works") or []:
                        tgt = _short_id(raw)
                        if tgt in all_works and tgt != wid and (wid, tgt) not in seen:
                            seen.add((wid, tgt))
                            edges.append({"source": wid, "target": tgt})

                yield _sse(
                    {
                        "type": "done",
                        "result": {
                            "seed": _public(_meta(seed_w)),
                            "papers": papers,
                            "edges": edges,
                            "source": "OpenAlex",
                            "stats": {
                                "references": len(ref_works),
                                "citing": len(citing_works),
                                "edges": len(edges),
                            },
                        },
                    }
                )
        except openalex.OAError as e:
            yield _sse(
                {
                    "type": "error",
                    "message": e.message,
                    "code": e.code,
                    "hint": e.hint,
                    "reset_in": e.reset_in,
                }
            )
        except httpx.HTTPStatusError as e:
            yield _sse(
                {
                    "type": "error",
                    "message": f"OpenAlex 返回 {e.response.status_code}，稍后重试",
                    "code": "upstream",
                }
            )
        except Exception as e:  # noqa: BLE001 —— 流里不能抛裸异常，否则前端只看到连接断开
            yield _sse({"type": "error", "message": f"检索失败：{e}", "code": "unknown"})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
