"""备份与恢复的最小可用方案。

路由刻意做得保守：
- 「隔离验证」不需要任何代价，随时可跑
- 「覆盖正式库」必须显式传 confirm，且会先自动再打一份安全快照
"""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import backup

router = APIRouter(prefix="/api/backup", tags=["backup"])


@router.get("")
def api_list():
    items = backup.list_backups()
    live = backup.db_path()
    return {
        "backups": items,
        "dir": str(backup.backup_dir()),
        "live_db": str(live),
        "live_counts": backup.counts_of(live) if live.exists() else {},
    }


class CreateIn(BaseModel):
    label: str = "manual"


@router.post("/create")
def api_create(body: CreateIn):
    label = "".join(c for c in (body.label or "manual") if c.isalnum() or c in "-_")[:24] or "manual"
    return backup.create_backup(label)


@router.get("/{name}/verify")
def api_verify(name: str):
    """只读打开备份做完整性校验 + 行数统计（不动任何数据）。"""
    try:
        return backup.inspect(name)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc))


class RestoreIn(BaseModel):
    mode: str = "isolated"  # isolated | live
    confirm: bool = False


@router.post("/{name}/restore")
def api_restore(name: str, body: RestoreIn):
    """isolated = 恢复到临时目录验证；live = 覆盖当前库（需要 confirm=true）。"""
    try:
        if body.mode == "live":
            if not body.confirm:
                raise HTTPException(
                    400,
                    "覆盖正式库需要在请求体里传 confirm=true。"
                    "覆盖前会自动再打一份安全快照，但此操作仍不可逆，请先跑一次隔离验证。",
                )
            return backup.restore_to_live(name)
        return backup.restore_to_isolated(name)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"恢复失败：{type(exc).__name__}: {exc}")


@router.delete("/{name}")
def api_delete(name: str):
    try:
        backup.delete_backup(name)
        return {"ok": True}
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
