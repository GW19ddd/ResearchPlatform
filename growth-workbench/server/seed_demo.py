"""重置数据库并灌入一份贴合当前课题的示例数据。

用法： python seed_demo.py --yes-reset
警告：会清空 data/workbench.db

安全闸（2026-11-12 加）：库里已有真实数据时，必须显式加 --yes-reset 才会执行；
执行前自动把现有库备份到 data/backups/，误跑也能原样退回。
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta

from config import DB_PATH
from db import get_conn, init_db

if os.path.exists(DB_PATH):
    import shutil
    from backup import create_backup

    # 有数据却没带确认参数 → 拒绝，不许静默清库
    _n_users = 0
    try:
        _c = sqlite3.connect(str(DB_PATH))
        _n_users = _c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        _c.close()
    except Exception:
        pass
    if _n_users and "--yes-reset" not in sys.argv:
        print(
            f"[seed_demo] 拒绝执行：{DB_PATH} 里有 {_n_users} 个真实账户。\n"
            "  确认要清空请运行： python seed_demo.py --yes-reset"
        )
        raise SystemExit(1)

    try:
        snap = create_backup("pre-seed-demo")
        print(f"[seed_demo] 已备份现有库到 {snap['name']}")
    except Exception as exc:  # noqa: BLE001
        print(f"[seed_demo] 备份失败，已中止：{type(exc).__name__}: {exc}")
        raise SystemExit(1)

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
from canvas_templates import get_template  # noqa: E402

for tpl_key in ("topic", "write"):
    tpl = get_template(tpl_key)
    if not tpl:
        continue
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

# ---- 课题 Quest 对话（/chat）：预置示例会话，防止对话列表空着 ----
def seed_chat():
    def mk(title, role, mode, context_keys, msgs, age_days):
        sid = conn.execute(
            """INSERT INTO chat_sessions (title, role, mode, context, created_at, updated_at)
               VALUES (?,?,?,?,?,?)""",
            (
                title, role, mode,
                json.dumps({"keys": context_keys}, ensure_ascii=False),
                (ts - timedelta(days=age_days)).isoformat(timespec="seconds"),
                (ts - timedelta(days=age_days, hours=1)).isoformat(timespec="seconds"),
            ),
        ).lastrowid
        for i, (role_, content) in enumerate(msgs):
            conn.execute(
                """INSERT INTO chat_messages (session_id, role, content, provider, model, tokens_in, tokens_out, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    sid, role_, content, "demo", "demo-seed", 120 + i * 30, 80 + i * 20,
                    (ts - timedelta(days=age_days, hours=1, minutes=i * 3)).isoformat(timespec="seconds"),
                ),
            )
        return sid

    ts = datetime.now()
    sid1 = mk(
        "分层错误归因的下一步", "researcher", "fast", ["ideas", "experiments"],
        [
            ("user", "F1 边界语法全方法 0/24，下一步是先补一组消融实验，还是先改分层归因的提示词？"),
            ("assistant", "建议两步走：先用现有 5 方法固定 prompt、只加「是否给出错误分层提示」这一个变量跑消融，确认分层归因确实带来 diagnosis_correct 提升；再据此重写 Method 的分层描述。这样归因结论有数据支撑，导师周会也好讲。"),
            ("user", "那就先消融。样本量用多少合适？"),
            ("assistant", "先用 15 个 F1 类样本即可（现有实验每方法样本偏少）。重点看加/不加分层提示的 diagnosis_correct 差，而不是修复成功率——F1 本来成功率就接近 0。"),
        ],
        1,
    )
    # Findings Memory：沉淀一条已确认结论
    conn.execute(
        "INSERT INTO chat_findings (session_id, content, source_msg_id, created_at) VALUES (?,?,?,?)",
        (
            sid1,
            "F1 边界语法修复成功率天然接近 0，评价重心应放在 diagnosis_correct 而非 success_rate（演示占位结论，非实测）",
            None,
            (ts - timedelta(days=1)).isoformat(timespec="seconds"),
        ),
    )

    mk(
        "Feedback-driven Refinement 可行性", "researcher", "deep", ["literature", "ideas"],
        [
            ("user", "导师提到 Feedback-driven Refinement 可作为第二篇切入点，先帮我评估可行性。"),
            ("assistant", "可行但有前提：反馈信号必须可解析（求解器报错、残差曲线），不能只靠「再试一次」。建议把它定位成「多轮自我修正」而非「一次性生成」，和现有分层归因互补——分层管定位，反馈管修正。"),
            ("user", "那和 Codamosa 的反馈循环有什么差异？"),
            ("assistant", "Codamosa 的反馈来自测试执行（pass/fail + coverage），我们额外引入编译/数值/物理三层信号，反馈粒度更细，这是差异点。（以上为演示占位内容，非实测）"),
        ],
        3,
    )

    mk(
        "组会预演：F1 失败归因怎么说", "researcher", "fast", ["experiments", "advisor_notes"],
        [
            ("user", "组会要讲 F1 全军覆没，导师要求给解释，帮我组织口径。"),
            ("assistant", "口径三句：① F1 是边界条件类故障，不在任何方法的覆盖范围内，所以全 0 是设计使然不是实现缺陷；② 我们据此把评价从 success_rate 切到 diagnosis_correct；③ 已用消融把「是否给分层提示」作为唯一变量，证明分层归因能定位到这一层。"),
        ],
        5,
    )


seed_chat()


# ---- 研究对话（/research 对话·调研）：预置示例会话（含报告/检索） ----
def seed_rchat():
    ts = datetime.now()

    def mk(title, msgs, age_days):
        sid = conn.execute(
            "INSERT INTO rchat_sessions (title, created_at, updated_at) VALUES (?,?,?)",
            (
                title,
                (ts - timedelta(days=age_days)).isoformat(timespec="seconds"),
                (ts - timedelta(days=age_days, hours=2)).isoformat(timespec="seconds"),
            ),
        ).lastrowid
        for i, (role, kind, content, meta) in enumerate(msgs):
            conn.execute(
                """INSERT INTO rchat_messages (session_id, role, kind, content, meta, provider, model, elapsed_ms, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    sid, role, kind, content, json.dumps(meta, ensure_ascii=False),
                    "demo", "demo-seed", 1500 + i * 400,
                    (ts - timedelta(days=age_days, hours=2, minutes=i * 5)).isoformat(timespec="seconds"),
                ),
            )
        return sid

    mk(
        "LLM 自动修复 CFD 案例的综述",
        [
            ("user", "text", "帮我写一份 LLM 自动修复 CFD 案例的综述，覆盖错误定位与多轮修正。", {"tag": "综述撰写"}),
            (
                "assistant", "report",
                "# LLM 自动修复 CFD 案例：定位与修正\n\n"
                "## 1 背景\nCFD 案例（如 OpenFOAM tutorial）配置繁琐，边界条件、数值格式、物理模型任一设置错误都会导致求解失败或结果失真。\n\n"
                "## 2 方法谱系\n- 规则式（Rule-based）：覆盖已知错误，盲区大；\n- LLM-only：偶发过度修改；\n- RAG-LLM：借案例库做 few-shot；\n- 日志/物理引导：引入残差与物理一致性信号。\n\n"
                "## 3 结论\n错误分层归因 + 反馈驱动修正 是当前最稳的组合。\n\n"
                "> 注：以下为演示占位内容，非真实实验数据。",
                {
                    "citations": [
                        {"n": 1, "title": "ChatCFD: LLM Agent for CFD", "authors": "—", "year": 2024, "venue": "GitHub", "url": "https://example.org/demo/chatcfd"},
                        {"n": 2, "title": "Feedback-driven Refinement for Solver Config", "authors": "Demo et al.", "year": 2025, "venue": "arXiv", "url": "https://example.org/demo/fdr"},
                        {"n": 3, "title": "PhyLog-Repair: Physics-guided Repair", "authors": "Demo", "year": 2025, "venue": "arXiv", "url": "https://example.org/demo/phylog"},
                    ]
                },
            ),
        ],
        2,
    )

    mk(
        "错误分层归因方法调研",
        [
            ("user", "text", "检索「错误分层归因」相关的 LLM 修复工作，给出关键论文。", {"tag": "深度检索"}),
            (
                "assistant", "deep",
                "已检索 OpenAlex，命中 3 篇相关工作的核心文献，并自动入库到「文献库」。\n\n"
                "关键发现：现有方法多在单层（执行/数值）归因，物理层归因稀缺，这正是我们的切入点。\n\n"
                "> 注：演示占位，检索结果为示例，非真实 OpenAlex 命中。",
                {
                    "citations": [
                        {"n": 1, "title": "Layered Fault Attribution for Scientific Agents", "authors": "Demo", "year": 2025, "venue": "arXiv", "cited_by": 12, "url": "https://example.org/demo/layered"},
                        {"n": 2, "title": "Execution vs Physics: Where LLM Repairs Fail", "authors": "Demo", "year": 2024, "venue": "NeurIPS WS", "cited_by": 34, "url": "https://example.org/demo/exevsphys"},
                        {"n": 3, "title": "Self-Correcting Solver Configurations", "authors": "Demo", "year": 2025, "venue": "ICLR", "cited_by": 8, "url": "https://example.org/demo/selfcorr"},
                    ],
                    "queries": ["fault attribution LLM solver", "scientific agent error localization", "CFD configuration repair"],
                },
            ),
        ],
        4,
    )

    mk(
        "本周文献快读",
        [
            ("user", "text", "用一句话总结本周读的三篇文献。", {"tag": "研究对话"}),
            ("assistant", "text", "① OpenFOAM 2406 文档：454 tutorial 是案例检索基础；② ChatCFD：错误定位策略差异大；③ Feedback-driven：可作第二篇锚点。三篇共同指向「分层归因 + 反馈修正」。", {}),
        ],
        6,
    )


seed_rchat()


# ---- 论文速递（/paperfeed）：演示占位卡片，避免打开是空流 ----
_pf_rows = [
    (
        "2406.12345", "LLM Agents for Automated CFD Case Repair", "Demo A, Demo B",
        "We propose a layered fault attribution framework that localizes CFD configuration errors into execution, numerical, and physics layers before repair.",
        "cs.AI,physics.comp-ph", "cs.AI", "https://arxiv.org/abs/2406.12345", "2024-06-18",
        "面向 CFD 案例修复的 LLM 智能体", "我们提出分层错误归因框架，在修复前把 CFD 配置错误定位到执行/数值/物理三层。【演示占位 · 非实测】",
    ),
    (
        "2407.23456", "Feedback-driven Refinement of Solver Configurations", "Demo C",
        "A multi-round self-correction loop driven by solver errors and residual curves, reducing over-modification common in LLM-only baselines.",
        "cs.LG,cs.SE", "cs.LG", "https://arxiv.org/abs/2407.23456", "2024-07-09",
        "基于反馈驱动的求解器配置精修", "以求解器报错与残差曲线为反馈的多轮自修正循环，缓解 LLM-only 常见的过度修改。【演示占位 · 非实测】",
    ),
    (
        "2408.34567", "PhyLog-Repair: Physics-guided Program Repair", "Demo D, Demo E",
        "We inject physics-consistency signals (conservation, boundary behavior) into the repair search, improving correctness on physics-layer faults.",
        "cs.AI,physics.flu-dyn", "physics.flu-dyn", "https://arxiv.org/abs/2408.34567", "2024-08-21",
        "PhyLog-Repair：物理引导的程序修复", "将物理一致性信号（守恒、边界行为）注入修复搜索，提升物理层故障的修复正确率。【演示占位 · 非实测】",
    ),
    (
        "2409.45678", "RAG-LLM for Scientific Case Retrieval", "Demo F",
        "A retrieval-augmented agent that grounds code generation in a curated tutorial corpus, lowering hallucination on out-of-distribution cases.",
        "cs.CL,cs.AI", "cs.CL", "https://arxiv.org/abs/2409.45678", "2024-09-03",
        "面向科学案例检索的 RAG-LLM", "基于精选 tutorial 语料的检索增强智能体，降低分布外案例的幻觉。【演示占位 · 非实测】",
    ),
    (
        "2410.56789", "Benchmarking LLM Repair on 454 Tutorials", "Demo G, Demo H",
        "We release a 454-case CFD tutorial benchmark and show that error-layered attribution consistently outperforms flat prompting.",
        "cs.SE", "cs.SE", "https://arxiv.org/abs/2410.56789", "2024-10-15",
        "在 454 个 tutorial 上评测 LLM 修复", "发布 454 案例 CFD benchmark，显示错误分层归因稳定优于扁平提示。【演示占位 · 非实测】",
    ),
    (
        "2411.67890", "Self-Correcting Agent Loops for Simulation", "Demo I",
        "An analysis of when self-correction helps vs. harms in simulation-agent loops, with a stopping criterion based on residual convergence.",
        "cs.AI", "cs.AI", "https://arxiv.org/abs/2411.67890", "2024-11-02",
        "面向仿真的自修正智能体循环", "分析自修正在仿真智能体循环中的收益与风险，并提出基于残差收敛的停止准则。【演示占位 · 非实测】",
    ),
]
for i, r in enumerate(_pf_rows):
    conn.execute(
        """INSERT INTO paperfeed_papers
           (arxiv_id, title, authors, abstract, cats, primary_cat, link, published, source,
            title_zh, abstract_zh, figure_kind, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], "arxiv",
            r[8], r[9], "none",
            (datetime.now() - timedelta(days=i)).isoformat(timespec="seconds"),
        ),
    )


# ---- 计划复盘补充「周末办」示例任务，让本周成果/支撑任务/周末办三块都有内容 ----
_weekday = today.weekday()  # Mon=0 .. Sun=6
_days_to_sat = (5 - _weekday) % 7 or 7
_saturday = today + timedelta(days=_days_to_sat)
conn.execute(
    "INSERT INTO tasks (plan_id, title, status, points, due_date, created_at) VALUES (?,?,?,?,?,?)",
    (
        plan_id, "周末办：归档本周实验数据并整理文献笔记", "todo", 15,
        _saturday.isoformat(), ago(1),
    ),
)


# ---- 本机账户：单用户工作台必须有账户才能进，reseed 会清空 users，这里补建 amber ----
# 避免 reseed 后卡在登录页、看不到任何已填充内容。密码可在「设置」里改。
# 注意：auth.create_user 走 db.execute() 另开连接，必须先提交本脚本主连接上的写事务，
# 否则会撞上 database is locked。
conn.commit()
try:
    import auth as _auth

    if not _auth.has_user():
        _auth.create_user("amber", "amber123", "Amber", 248)
        print("已创建本机账户：amber / amber123（可在「设置 → 账户」改密码）")
except Exception as _e:  # noqa: BLE001
    print("账户创建跳过：", _e)


conn.commit()
conn.close()

print("示例数据已写入：", DB_PATH)
print("阶段、实验、文献、承诺、积分、课题Quest对话、研究对话、论文速递、周末任务、本机账户均已填充。启动后端后刷新前端即可看到。")
