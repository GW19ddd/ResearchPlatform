"""测试辅助：把异步接口收敛成同步调用。"""
import time

TERMINAL = {"done", "failed", "cancelled"}


def run_canvas(client, cid: int, body: dict | None = None, timeout: float = 15.0) -> dict:
    """POST run 之后轮询到终态，返回 GET /runs/{id} 的完整响应。

    画布运行是后台任务：一次调用可能跨越多个节点的真实请求。
    测试里不轮询就会读到「还没跑完」的中间态。
    """
    r = client.post(f"/api/canvas/{cid}/run", json=body or {})
    assert r.status_code == 200, r.text
    run_id = r.json()["run_id"]
    deadline = time.time() + timeout
    detail = None
    while time.time() < deadline:
        detail = client.get(f"/api/canvas/runs/{run_id}").json()
        if detail["run"]["status"] in TERMINAL:
            return detail
        time.sleep(0.05)
    raise AssertionError(f"画布运行未在 {timeout}s 内结束：{detail}")


def outputs_of(detail: dict) -> dict:
    return {o["node_key"]: o for o in detail.get("outputs", [])}
