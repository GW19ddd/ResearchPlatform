"""对运行中的后端做一轮 P0 冒烟：AI 失败不落库、幂等、备份、污染识别。

只读或写极少量数据（一个备份文件 + 一条待删的文献），不会动真实研究数据。
"""
import json
import sys

import httpx

BASE = "http://127.0.0.1:8000"
c = httpx.Client(base_url=BASE, timeout=60.0)
out = []


def show(name, ok, extra=""):
    out.append(f"{'PASS' if ok else 'FAIL'}  {name}{(' :: ' + extra) if extra else ''}")
    return ok


# 1) AI 失败信封
before = len(c.get("/api/ideas").json())
r = c.post("/api/ideas/brainstorm", json={"direction": "smoke", "count": 3})
b = r.json()
show("brainstorm 返回 200", r.status_code == 200)
show("响应带 ok 标记", isinstance(b.get("ok"), bool), f"ok={b.get('ok')}")
if b.get("ok") is False:
    show(
        "失败时 result 为空、error 四件套齐全",
        b.get("result") == ""
        and b.get("candidates") == []
        and all(k in (b.get("error") or {}) for k in ("label", "message", "hint")),
        json.dumps(b.get("error"), ensure_ascii=False)[:200],
    )
else:
    show("成功时给出候选或直接文本", bool(b.get("candidates")) or bool(b.get("result")))
show("头脑风暴不自动落库", len(c.get("/api/ideas").json()) == before, f"{before} -> {len(c.get('/api/ideas').json())}")

# 2) 幂等
key = "smoke-idem-" + __import__("uuid").uuid4().hex[:8]
r1 = c.post("/api/ideas", json={"title": "冒烟幂等"}, headers={"Idempotency-Key": key})
r2 = c.post("/api/ideas", json={"title": "冒烟幂等"}, headers={"Idempotency-Key": key})
show("重复提交返回同一条记录", r1.json().get("id") == r2.json().get("id"), f"{r1.json()} vs {r2.json()}")
iid = r1.json()["id"]
same = [x for x in c.get("/api/ideas").json() if x["title"] == "冒烟幂等"]
show("只写入一条", len(same) == 1 and same[0]["id"] == iid, str([x["id"] for x in same]))
c.delete(f"/api/ideas/{iid}", headers={"Idempotency-Key": key + "-del"})

# 换一把 key 再建同名记录：必须放行（用户有意建两条）
r3 = c.post("/api/ideas", json={"title": "冒烟幂等"}, headers={"Idempotency-Key": key + "-2"})
show("换 key 可以有意创建同名记录", r3.json().get("id") != iid, str(r3.json().get("id")))
c.delete(f"/api/ideas/{r3.json()['id']}")

# 3) 复盘互斥
c.post("/api/plan/week", json={"outcomes": ["冒烟成果A"]})
r = c.post("/api/plan/review", json={"done": ["冒烟成果A"], "missed": ["冒烟成果A"]})
show("同一成果同时完成/未完成被拒", r.status_code == 400, r.text[:120])

# 4) 备份
r = c.get("/api/backup")
show("备份列表可读", r.status_code == 200 and "backups" in r.json(), str(r.json().get("dir", "")))
r = c.post("/api/backup/create", json={"label": "smoke"})
snap = r.json()
show("创建备份成功", r.status_code == 200 and snap.get("name", "").endswith(".db"), snap.get("name", ""))
r = c.get(f"/api/backup/{snap['name']}/verify")
show("隔离自检通过", r.json().get("ok") is True, str(r.json().get("counts", {}).get("ideas")))
r = c.post(f"/api/backup/{snap['name']}/restore", json={"mode": "live"})
show("无 confirm 的覆盖被拒", r.status_code == 400, r.text[:100])
r = c.post(f"/api/backup/{snap['name']}/restore", json={"mode": "isolated"})
show("隔离恢复成功", r.status_code == 200 and r.json().get("mode") == "isolated", str(r.json().get("total_rows")))
c.delete(f"/api/backup/{snap['name']}")

# 5) 污染识别（只读）
r = c.get("/api/ai/suspects")
show("污染排查接口可用", r.status_code == 200 and "total" in r.json(), f"total={r.json().get('total')}")
r = c.post("/api/ai/suspects/cleanup", json={"items": []})
show("空清单清理被拒", r.status_code == 400)

# 6) 设置接口不回传明文 key
r = c.get("/api/settings/llm")
body = json.dumps(r.json(), ensure_ascii=False)
has_set = any("api_key_set" in p for p in r.json().get("providers", []))
show("设置接口只回传 api_key_set", has_set and "sk-" not in body, str([p.get("api_key_set") for p in r.json().get("providers", [])]))

print("\n".join(out))
print("----")
print("FAILS:", sum(1 for x in out if x.startswith("FAIL")))
sys.exit(0)
