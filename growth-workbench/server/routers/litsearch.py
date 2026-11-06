"""在线文献检索：走 OpenAlex（免费、无 key），覆盖 arXiv / PubMed / 主流出版社。

只做检索与 OA 链接透出，入库仍走原 POST /literature —— 复用去重、
对比矩阵、AI 笔记整条链路，不另起炉灶。
"""
import httpx
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["litsearch"])


@router.get("/litsearch")
async def litsearch(q: str, limit: int = 20):
    """搜 OpenAlex。输入长得像 DOI 就按 DOI 精确查，否则全文检索。"""
    q = (q or "").strip()
    if not q:
        return {"ok": True, "results": []}

    params: dict = {
        "per-page": max(1, min(int(limit), 100)),
        "mailto": "workbench@local",  # polite pool，仅提速用
    }
    if q.lower().startswith("10.") and "/" in q:
        params["filter"] = f"doi:{q}"
    else:
        params["search"] = q

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get("https://api.openalex.org/works", params=params)
            r.raise_for_status()
            data = r.json()
    except Exception as e:  # noqa: BLE001 —— 网络错误原样带回给前端展示
        return {"ok": False, "error": f"OpenAlex 请求失败：{e}", "results": []}

    results = []
    for w in data.get("results", []):
        oa = w.get("open_access") or {}
        best = w.get("best_oa_location") or {}
        landing = (w.get("primary_location") or {}).get("landing_page_url") or ""
        results.append(
            {
                "title": w.get("display_name") or "(无标题)",
                "authors": ", ".join(
                    a["author"]["display_name"]
                    for a in (w.get("authorships") or [])[:5]
                    if a.get("author")
                ),
                "year": w.get("publication_year"),
                "venue": ((w.get("primary_location") or {}).get("source") or {}).get(
                    "display_name"
                ),
                "cited_by": w.get("cited_by_count"),
                "oa": bool(oa.get("is_oa")),
                "pdf_url": best.get("pdf_url") or oa.get("oa_url") or "",
                "url": w.get("doi") or landing or best.get("pdf_url") or "",
            }
        )
    return {"ok": True, "total": (data.get("meta") or {}).get("count"), "results": results}
