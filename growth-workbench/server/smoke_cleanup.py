"""清掉冒烟测试写进真实库的一条周成果（其余冒烟数据已自删）。"""
import httpx

c = httpx.Client(base_url="http://127.0.0.1:8000", timeout=30)
w = c.get("/api/plan/current").json()
outs = [o for o in w.get("outcomes", []) if "冒烟" not in o]
r = c.post("/api/plan/week", json={"outcomes": outs})
print("outcomes ->", r.json().get("outcomes") if isinstance(r.json(), dict) else r.text[:200])
print("ideas 残留:", [i["title"] for i in c.get("/api/ideas").json() if "冒烟" in i["title"]])
print("backups:", [b["name"] for b in c.get("/api/backup").json()["backups"]])
