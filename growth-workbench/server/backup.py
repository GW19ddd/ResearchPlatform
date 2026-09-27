"""数据库备份与恢复。

设计原则（P0 数据保护）：
- 备份用 sqlite3 的 backup API 生成**一致快照**，不是裸拷文件（拷半个 WAL 会拿到坏库）
- 恢复默认走「隔离模式」：先恢复到临时文件、校验行数，用户确认后才允许覆盖正式库
- 覆盖正式库前会再自动打一份安全快照，永远留一条退路
- 绝不主动清理用户的正式数据

路径一律在调用时解析（见 backup_dir / db_path）：测试会把 config 里的路径
换到临时目录，模块级常量会 stale，进而把备份写进（甚至恢复到）真实数据目录。
"""
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

import config

# 业务表清单：校验备份是否「真的能读」时逐表计数
TABLES = [
    "ideas", "idea_reviews", "literature", "lit_notes", "lit_matrix",
    "experiments", "exp_results", "paper_stages", "paper_sections",
    "weekly_plans", "tasks", "daily_checkins", "advisor_notes",
    "points_ledger", "rewards", "bets", "llm_usage", "idempotency_keys",
    "canvases", "canvas_nodes", "canvas_edges", "canvas_runs", "canvas_node_outputs",
    "chat_sessions", "chat_messages", "settings",
]


def backup_dir() -> Path:
    d = Path(config.DATA_DIR) / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return Path(config.DB_PATH)


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def create_backup(label: str = "manual", max_keep: int | None = None) -> dict:
    """生成一份一致快照。返回 {name, path, size, created_at}。"""
    d = backup_dir()
    label = "".join(c for c in (label or "manual") if c.isalnum() or c in "-_")[:24] or "manual"
    name = f"workbench-{_stamp()}-{label}.db"
    target = d / name

    src = sqlite3.connect(str(db_path()))
    dst = sqlite3.connect(str(target))
    try:
        with dst:
            src.backup(dst)
    finally:
        dst.close()
        src.close()

    if max_keep:
        _prune(max_keep)
    return {
        "name": name,
        "label": label,
        "path": str(target),
        "size": target.stat().st_size,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }


def list_backups() -> list[dict]:
    items = []
    for p in sorted(backup_dir().glob("*.db"), key=lambda x: x.stat().st_mtime, reverse=True):
        st = p.stat()
        items.append(
            {
                "name": p.name,
                "size": st.st_size,
                "created_at": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                "label": p.name.rsplit("-", 1)[-1].removesuffix(".db"),
            }
        )
    return items


def _prune(keep: int):
    items = sorted(backup_dir().glob("*.db"), key=lambda x: x.stat().st_mtime, reverse=True)
    for p in items[keep:]:
        try:
            p.unlink()
        except OSError:
            pass


def _resolve(name: str) -> Path:
    d = backup_dir()
    p = (d / name).resolve()
    if not str(p).startswith(str(d.resolve())):
        raise ValueError("备份名不合法")
    if not p.is_file():
        raise FileNotFoundError(f"没有这个备份：{name}")
    return p


def counts_of(db_file: Path) -> dict:
    """逐表计数。用来回答「这份备份到底恢复得出数据吗」。"""
    conn = sqlite3.connect(str(db_file))
    out: dict[str, int] = {}
    try:
        for t in TABLES:
            try:
                out[t] = int(conn.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()[0])
            except sqlite3.Error:
                out[t] = -1  # 表不存在
    finally:
        conn.close()
    return out


def inspect(name: str) -> dict:
    """只读打开备份做完整性校验 + 行数统计（不动任何数据）。"""
    p = _resolve(name)
    conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        ]
        return {
            "name": name,
            "ok": integrity == "ok",
            "integrity": integrity,
            "tables": tables,
            "counts": counts_of(p),
        }
    finally:
        conn.close()


def restore_to_isolated(name: str, target_dir: Path | None = None) -> dict:
    """把备份恢复到**隔离目录**（不动正式库），验证它真的可读。"""
    src = _resolve(name)
    target_dir = Path(target_dir) if target_dir else (backup_dir() / "_restore_test")
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"restored-{name}"

    source = sqlite3.connect(str(src))
    dst = sqlite3.connect(str(target))
    try:
        with dst:
            source.backup(dst)
    finally:
        dst.close()
        source.close()

    info = counts_of(target)
    return {
        "ok": True,
        "target": str(target),
        "mode": "isolated",
        "counts": info,
        "total_rows": sum(v for v in info.values() if v > 0),
    }


def restore_to_live(name: str) -> dict:
    """覆盖正式库。调用前路由层已要求显式确认，这里再自动打一份安全快照。"""
    src = _resolve(name)
    info = inspect(name)
    if not info["ok"]:
        raise RuntimeError(f"备份文件自检未通过：{info['integrity']}")

    safety = create_backup("pre-restore")
    d = backup_dir()
    tmp = d / f".restoring-{_stamp()}.db"

    source = sqlite3.connect(str(src))
    dst = sqlite3.connect(str(tmp))
    try:
        with dst:
            source.backup(dst)
    finally:
        dst.close()
        source.close()

    # 先把还原好的库放在正式位置旁边，再换名，避免半途中断留下半个库
    live = db_path()
    final = d / ".restored-final.db"
    shutil.move(str(tmp), str(final))
    old = live.with_name(live.name + ".pre-restore")
    if old.exists():
        old.unlink()
    shutil.move(str(live), str(old))
    shutil.move(str(final), str(live))

    return {
        "ok": True,
        "mode": "live",
        "restored_from": name,
        "safety_backup": safety["name"],
        "previous_db": old.name,
        "counts": counts_of(live),
    }


def delete_backup(name: str) -> bool:
    p = _resolve(name)
    p.unlink()
    return True
