"""重置数据库并灌入一份贴合当前课题的示例数据。

用法： python seed_demo.py
警告：会清空 data/workbench.db
"""
import json
import os
import sqlite3
from datetime import datetime, timedelta

from config import DB_PATH
from db import get_conn, init_db

if os.path.exists(DB_PATH):
    os.remove(DB_PATH)

init_db()
conn = get_conn()


def ago(days: int) -> str:
    return (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")


# ---- 创新点 ----
conn.executemany(
    """INSERT INTO ideas (title, one_liner, direction, novelty, feasibility, impact, effort,
       status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
    [
        (
            "分层评价体系驱动的错误归因",
            "把 OpenFOAM 故障分成执行/数值/物理三层，让智能体先定位层再修，而不是直接改字典",
            "LLM agent for OpenFOAM",
            4,
            4,
            4,
            3,
            "selected",
            "对应 OF-FaultBench 的评价分层，也是目前 method 部分的主线",
            ago(20),
            ago(3),
        ),
        (
            "反馈驱动迭代修复 Feedback-driven Refinement",
            "把求解器报错与残差曲线当作反馈信号，让 agent 多轮自我修正而非一次性生成",
            "LLM agent for OpenFOAM",
            4,
            3,
            5,
            4,
            "screening",
            "导师周会提过，可考虑作为第二篇的切入点",
            ago(12),
            ago(2),
        ),
        (
            "基于 454 个 tutorial 的案例检索增强",
            "用内置 tutorial 库做 few-shot 检索源，替代纯参数记忆",
            "LLM agent for OpenFOAM",
            2,
            5,
            2,
            2,
            "captured",
            "TerminalCFD 已有案例库，实现成本低但新颖性不足",
            ago(8),
            ago(8),
        ),
    ],
)

# ---- 文献 ----
conn.executemany(
    """INSERT INTO literature (title, authors, year, venue, url, status, rating, relevance,
       notes, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
    [
        (
            "OpenFOAM 2406 官方文档与 tutorial 库",
            "OpenFOAM Foundation",
            2024,
            "openfoam.org",
            "https://www.openfoam.org/documentation/",
            "done",
            4,
            "工具基础",
            "454 个 tutorial 是案例检索的来源，也是 foamCheck 语法校验的对照基准",
            "基础,工具",
            ago(25),
            ago(10),
        ),
        (
            "ChatCFD（TerminalCFD 的上游 fork）",
            "—",
            2024,
            "GitHub",
            "",
            "done",
            4,
            "直接相关",
            "TerminalCFD 由其 fork 而来，重点对比它在错误定位上的策略差异",
            "基线,对比",
            ago(25),
            ago(10),
        ),
        (
            "【待补】LLM agent 自动修复 CFD 案例相关工作",
            "待检索",
            None,
            "待定",
            "",
            "todo",
            3,
            "Related Work 核心",
            "",
            "Related Work",
            ago(5),
            ago(5),
        ),
        (
            "【待补】Feedback-driven Refinement 方法论文",
            "待检索",
            None,
            "待定",
            "",
            "todo",
            3,
            "第二篇的可能锚点",
            "",
            "Refinement",
            ago(5),
            ago(5),
        ),
    ],
)

# 相关工作矩阵
dims = ["是否开源", "评测集", "错误分层归因", "是否需要人工", "支持 OpenFOAM 2406"]
lits = [r[0] for r in conn.execute("SELECT id FROM literature ORDER BY id").fetchall()]
matrix = {
    "是否开源": ["是", "是", "—", "—"],
    "评测集": ["454 tutorial", "自研小规模", "—", "—"],
    "错误分层归因": ["无", "单层", "—", "—"],
    "是否需要人工": ["需要", "需要", "—", "—"],
    "支持 OpenFOAM 2406": ["是", "部分", "—", "—"],
}
for i, d in enumerate(dims):
    for j, lid in enumerate(lits):
        conn.execute(
            "INSERT INTO lit_matrix (literature_id, dim_name, dim_value, sort_order) VALUES (?,?,?,?)",
            (lid, d, matrix[d][j] if j < len(matrix[d]) else "", i),
        )

# ---- 实验 ----
conn.execute(
    """INSERT INTO experiments (name, hypothesis, design, status, config_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)""",
    (
        "OF-FaultBench Phase 1：5 方法 × 15 故障样本",
        "引入错误分层归因后，diagnosis_correct 应显著高于纯 LLM 方法",
        "方法：Rule-based / LLM-only / RAG-LLM / Log-guided / PhyLog-Repair；样本：F1 边界语法、F2 数值设置、F3 物理模型；指标：修复成功率、diagnosis_correct、耗时",
        "analyzing",
        '{"faults":["F1","F2","F3"],"methods":5,"samples":15}',
        ago(15),
        ago(1),
    ),
)
exp_id = conn.execute("SELECT id FROM experiments ORDER BY id DESC LIMIT 1").fetchone()[0]

conn.executemany(
    """INSERT INTO exp_results (experiment_id, case_name, method, success, metrics_json, notes, created_at)
       VALUES (?,?,?,?,?,?,?)""",
    [
        (exp_id, "F1 边界语法", "Rule-based", 0, '{"success_rate":0.0,"time_s":0.3}', "全方法 0/24，语法错误之外的盲区", ago(10)),
        (exp_id, "F1 边界语法", "Log-guided", 0, '{"success_rate":0.0,"time_s":12.4}', "日志信息不足以定位边界条件", ago(10)),
        (exp_id, "F2 数值设置", "Rule-based", 1, '{"success_rate":1.0,"time_s":0.4}', "规则覆盖充分", ago(9)),
        (exp_id, "F3 物理模型", "PhyLog-Repair", 1, '{"success_rate":0.8,"time_s":31.2}', "物理层归因有效，样本偏少", ago(8)),
        (exp_id, "F2 数值设置", "LLM-only", 1, '{"success_rate":0.6,"time_s":18.7}', "偶发过度修改", ago(8)),
    ],
)

# ---- 论文阶段 ----
stage_updates = {
    "选题与定位": ("done", None, None, ago(30)),
    "实验设计与跑批": ("done", None, None, ago(6)),
    "数据整理与图表": (
        "blocked",
        "F1 边界语法全方法 0/24，diagnosis_correct 全部方法为 0，缺一个能站住的解释",
        "补一组消融实验，把失败归因写成一张对比表",
        ago(5),
    ),
    "正文写作": ("doing", None, "先写 Method 与 Experiments 两节", ago(1)),
}
for name, (status, blocker, nxt, ts) in stage_updates.items():
    conn.execute(
        "UPDATE paper_stages SET status=?, blocker=?, next_action=?, updated_at=? WHERE name=?",
        (status, blocker, nxt, ts, name),
    )

# 章节字数
section_words = {
    "Introduction": (320, "doing"),
    "Related Work": (0, "todo"),
    "Method": (860, "doing"),
    "Experiments": (640, "doing"),
    "Results": (0, "todo"),
    "Discussion": (0, "todo"),
    "Conclusion": (0, "todo"),
}
for name, (w, st) in section_words.items():
    conn.execute(
        "UPDATE paper_sections SET word_count=?, status=?, updated_at=? WHERE name=?",
        (w, st, ago(1), name),
    )

# ---- 本周计划 ----
today = datetime.now().date()
week_start = today - timedelta(days=today.weekday())
conn.execute(
    "INSERT INTO weekly_plans (week_start, outcomes_json, status, created_at) VALUES (?,?,?,?)",
    (
        week_start.isoformat(),
        '["补齐 F1 失败归因的消融实验","写完 Experiments 章节初稿","整理 Related Work 矩阵"]',
        "active",
        ago(2),
    ),
)
plan_id = conn.execute("SELECT id FROM weekly_plans ORDER BY id DESC LIMIT 1").fetchone()[0]

conn.executemany(
    "INSERT INTO tasks (plan_id, title, status, points, due_date, created_at) VALUES (?,?,?,?,?,?)",
    [
        (plan_id, "跑 F1 消融实验：固定 prompt，只改是否给错误分层提示", "doing", 20, (today + timedelta(days=2)).isoformat(), ago(2)),
        (plan_id, "把 5 方法 × 3 故障画成一张对比表", "todo", 15, (today + timedelta(days=3)).isoformat(), ago(2)),
        (plan_id, "Experiments 章节补到 1200 字", "todo", 20, (today + timedelta(days=5)).isoformat(), ago(1)),
        (plan_id, "给导师发本周进度", "todo", 10, (today + timedelta(days=1)).isoformat(), ago(1)),
    ],
)

# ---- 打卡 ----
for d in range(9, 0, -1):
    day = today - timedelta(days=d)
    conn.execute(
        "INSERT OR IGNORE INTO daily_checkins (date, sleep_h, exercise_min, focus_min, mood, note) VALUES (?,?,?,?,?,?)",
        (
            day.isoformat(),
            round(6.5 + (d % 3) * 0.4, 1),
            20 + (d % 4) * 15,
            120 + (d % 5) * 60,
            3 + (d % 3),
            ["实验跑批", "写 Method", "读文献", "改 agent 提示词", "组会"][d % 5],
        ),
    )

# ---- 导师承诺 ----
conn.executemany(
    """INSERT INTO advisor_notes (date, scene, advisor_said, my_commitment, due_date, status)
       VALUES (?,?,?,?,?,?)""",
    [
        (
            (today - timedelta(days=13)).isoformat(),
            "组会",
            "F1 全军覆没要给出解释，不能只报成功率",
            "补一组消融实验说明 F1 失败归因",
            (today + timedelta(days=2)).isoformat(),
            "open",
        ),
        (
            (today - timedelta(days=13)).isoformat(),
            "组会",
            "可以考虑 Feedback-driven Refinement 这条线",
            "调研 Feedback-driven Refinement 并给一页总结",
            (today - timedelta(days=1)).isoformat(),
            "open",
        ),
        (
            (today - timedelta(days=27)).isoformat(),
            "微信",
            "先把 Phase 1 数据整理好再谈第二篇",
            "整理 Phase 1 完整结果表",
            (today + timedelta(days=6)).isoformat(),
            "closed",
        ),
    ],
)

# ---- 积分流水 ----
conn.executemany(
    "INSERT INTO points_ledger (delta, reason, ref_type, ref_id, created_at) VALUES (?,?,?,?,?)",
    [
        (100, "周成果完成：补齐实验数据", "plan", plan_id, ago(9)),
        (10, "完成任务：跑 F1 消融实验", "task", None, ago(7)),
        (5, "日打卡", "checkin", None, ago(6)),
        (50, "论文阶段推进：实验设计与跑批", "paper_stage", None, ago(6)),
        (20, "读完文献：OpenFOAM 2406 官方文档与 tutorial 库", "literature", None, ago(5)),
        (30, "完成周复盘", "plan", plan_id, ago(4)),
        (-60, "周成果未完成 1 项", "plan", plan_id, ago(2)),
        (40, "创新点验证通过：分层评价体系驱动的错误归因", "idea", None, ago(3)),
    ],
)

# ---- 科研画布：从模板建两张示例画布 ----
from routers.canvas import TEMPLATES  # noqa: E402

for tpl_key in ("topic", "write"):
    tpl = TEMPLATES[tpl_key]
    ts = datetime.now().isoformat(timespec="seconds")
    cur = conn.execute(
        "INSERT INTO canvases (name, template, created_at, updated_at) VALUES (?,?,?,?)",
        (tpl["name"], tpl_key, ts, ts),
    )
    cvid = cur.lastrowid
    for n in tpl["nodes"]:
        conn.execute(
            """INSERT INTO canvas_nodes (canvas_id, node_key, type, skill_id, title, x, y, config_json)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                cvid,
                n["node_key"],
                n.get("type", "skill"),
                n.get("skill_id"),
                n.get("title", ""),
                n.get("x", 0),
                n.get("y", 0),
                json.dumps(n.get("config", {}), ensure_ascii=False),
            ),
        )
    for e in tpl["edges"]:
        conn.execute(
            "INSERT INTO canvas_edges (canvas_id, source_key, target_key) VALUES (?,?,?)",
            (cvid, e["source_key"], e["target_key"]),
        )

conn.commit()
conn.close()

print("示例数据已写入：", DB_PATH)
print("阶段、实验、文献、承诺、积分均已填充。启动后端后刷新前端即可看到。")
