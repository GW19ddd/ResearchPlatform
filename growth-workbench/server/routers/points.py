"""积分：余额、流水、规则、奖励兑换、押注。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import execute, now, query
from points_core import award, balance, get_rules, set_rule, week_net
from schemas import PosInt

router = APIRouter(prefix="/api/points", tags=["points"])


@router.get("/summary")
def summary():
    return {
        "balance": balance(),
        "week_net": week_net(),
        "rules": get_rules(),
        "ledger": query(
            "SELECT * FROM points_ledger ORDER BY id DESC LIMIT 50"
        ),
        "trend": trend(),
    }


def trend(days: int = 30):
    rows = query(
        "SELECT substr(created_at,1,10) d, SUM(delta) s FROM points_ledger "
        "GROUP BY d ORDER BY d"
    )
    cumulative, total = [], 0
    for r in rows[-days:]:
        total += int(r["s"])
        cumulative.append({"date": r["d"], "delta": int(r["s"]), "total": total})
    return cumulative


@router.get("/rules")
def rules():
    return get_rules()


class RuleIn(BaseModel):
    key: str
    value: int


@router.post("/rules")
def update_rule(body: RuleIn):
    set_rule(body.key, body.value)
    return get_rules()


# ---------------- 奖励 ----------------


class RewardIn(BaseModel):
    name: str
    cost: PosInt  # 成本为 0 的奖励等于无限刷分入口，必须拦在创建时


@router.get("/rewards")
def list_rewards():
    return query("SELECT * FROM rewards ORDER BY cost")


@router.post("/rewards")
def create_reward(body: RewardIn):
    rid = execute("INSERT INTO rewards (name, cost) VALUES (?,?)", (body.name, body.cost))
    return query("SELECT * FROM rewards WHERE id=?", (rid,))[0]


@router.delete("/rewards/{reward_id}")
def delete_reward(reward_id: int):
    execute("DELETE FROM rewards WHERE id=?", (reward_id,))
    return {"ok": True}


@router.post("/rewards/{reward_id}/redeem")
def redeem(reward_id: int):
    rows = query("SELECT * FROM rewards WHERE id=?", (reward_id,))
    if not rows:
        raise HTTPException(404, "reward not found")
    reward = rows[0]
    if balance() < reward["cost"]:
        raise HTTPException(400, f"积分不足，还差 {reward['cost'] - balance()} 分")
    award(-int(reward["cost"]), f"兑换奖励：{reward['name']}", "reward", reward_id)
    execute(
        "UPDATE rewards SET redeemed_count = redeemed_count + 1 WHERE id=?", (reward_id,)
    )
    return {"ok": True, "balance": balance()}


# ---------------- 押注 ----------------


class BetIn(BaseModel):
    title: str
    amount: int = 100
    due_date: str | None = None


@router.get("/bets")
def list_bets():
    return query("SELECT * FROM bets ORDER BY id DESC")


@router.post("/bets")
def create_bet(body: BetIn):
    bid = execute(
        "INSERT INTO bets (title, amount, due_date, status, created_at) VALUES (?,?,?,?,?)",
        (body.title, body.amount, body.due_date, "open", now()),
    )
    award(-int(body.amount), f"押注：{body.title}", "bet", bid)
    return {"ok": True, "id": bid, "balance": balance()}


@router.post("/bets/{bet_id}/settle")
def settle_bet(bet_id: int, body: dict):
    rows = query("SELECT * FROM bets WHERE id=?", (bet_id,))
    if not rows:
        raise HTTPException(404, "bet not found")
    bet = rows[0]
    result = body.get("result")
    if result not in ("won", "lost"):
        raise HTTPException(400, "result must be won or lost")
    execute("UPDATE bets SET status=? WHERE id=?", (result, bet_id))
    if result == "won":
        award(int(bet["amount"]) * 2, f"押注达成：{bet['title']}", "bet", bet_id)
    else:
        award(0, f"押注失败：{bet['title']}", "bet", bet_id)
    return {"ok": True, "balance": balance()}
