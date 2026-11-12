"""只补空位：把示例内容增量填进空模块，绝不删除任何真实数据。

与 seed_demo.py 的分工：
- seed_demo.py   ＝ 全量重置（删库重建），需要 --yes-reset，会清掉真实数据；
- seed_fill_empty.py ＝ 增量补空，幂等，可反复跑，只 INSERT 不 DELETE / 不 UPDATE 既有行。

用法：  python seed_fill_empty.py            # 补空
       python seed_fill_empty.py --dry-run  # 只看会补什么，不写库

去重口径：
- 课题 Quest 会话按 title 去重；研究对话同理；
- 论文速递按 arxiv_id 去重；
- 任务按 title 去重（且只在本周计划没有任务时才补）。
任何已存在的同名记录一律跳过，所以你自己的真实对话和真实论文不会被碰到。

内容性质：全部为「演示占位」数据，不冒充真实实验结论；
真实指标以你自己的实验为准。
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta

from config import DB_PATH
from db import init_db, now

DRY = "--dry-run" in sys.argv
_TODAY = datetime.now().date()


def _ts(days_ago: float, extra_hours: float = 0) -> str:
    return (datetime.now() - timedelta(days=days_ago, hours=extra_hours)).isoformat(
        timespec="seconds"
    )


def main() -> None:
    init_db()  # 建表 / 补列；不会删数据
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    stats = {"chat": 0, "rchat": 0, "paperfeed": 0, "task": 0, "skip_*": 0}

    # ---------------------------------------------------------------- 课题 Quest
    # 只在「一条会话都没有」时补，避免往你已有的研究记录里插演示对话。
    chat_n = conn.execute("SELECT COUNT(*) c FROM chat_sessions").fetchone()["c"]
    if chat_n == 0:
        for title, role, mode, ctx, msgs, age in _CHAT_SEEDS:
            if DRY:
                print(f"[dry] 将新增课题对话：{title}")
                stats["chat"] += 1
                continue
            sid = conn.execute(
                "INSERT INTO chat_sessions (title, role, mode, context, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?)",
                (
                    title,
                    role,
                    mode,
                    json.dumps({"keys": ctx}, ensure_ascii=False),
                    _ts(age),
                    _ts(age, 1),
                ),
            ).lastrowid
            for i, (r, content) in enumerate(msgs):
                conn.execute(
                    "INSERT INTO chat_messages (session_id, role, content, provider, model,"
                    " tokens_in, tokens_out, created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (sid, r, content, "demo", "demo-placeholder", 120 + i * 30, 80 + i * 20,
                     _ts(age, 1 - i * 0.002)),
                )
            stats["chat"] += 1
    else:
        print(f"[skip] 已有 {chat_n} 个课题对话，不动它们")
        stats["skip_*"] += 1

    # ---------------------------------------------------------------- 研究对话
    rchat_n = conn.execute("SELECT COUNT(*) c FROM rchat_sessions").fetchone()["c"]
    if rchat_n == 0:
        for title, msgs, age in _RCHAT_SEEDS:
            if DRY:
                print(f"[dry] 将新增调研对话：{title}")
                stats["rchat"] += 1
                continue
            sid = conn.execute(
                "INSERT INTO rchat_sessions (title, created_at, updated_at) VALUES (?,?,?)",
                (title, _ts(age), _ts(age, 2)),
            ).lastrowid
            for i, (role, kind, content, meta) in enumerate(msgs):
                conn.execute(
                    "INSERT INTO rchat_messages (session_id, role, kind, content, meta,"
                    " provider, model, elapsed_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (sid, role, kind, content, json.dumps(meta, ensure_ascii=False),
                     "demo", "demo-placeholder", 1500 + i * 400, _ts(age, 2 - i * 0.003)),
                )
            stats["rchat"] += 1
    else:
        print(f"[skip] 已有 {rchat_n} 个调研对话，不动它们")
        stats["skip_*"] += 1

    # ---------------------------------------------------------------- 论文速递
    # 按 arxiv_id 去重：你的 114 篇真实 arXiv 论文一个都不会被碰。
    pf_n = conn.execute("SELECT COUNT(*) c FROM paperfeed_papers").fetchone()["c"]
    for row in _PAPERFEED_SEEDS:
        hit = conn.execute(
            "SELECT 1 FROM paperfeed_papers WHERE arxiv_id=? OR title=?", (row[0], row[1])
        ).fetchone()
        if hit:
            continue
        if DRY:
            print(f"[dry] 将新增论文速递：{row[1]}")
            stats["paperfeed"] += 1
            continue
        conn.execute(
            "INSERT INTO paperfeed_papers (arxiv_id, title, authors, abstract, cats,"
            " primary_cat, link, published, title_zh, abstract_zh, source, figure_kind,"
            " created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (*row, "arxiv", "none", _ts(_PAPERFEED_SEEDS.index(row))),
        )
        stats["paperfeed"] += 1
    if pf_n and not stats["paperfeed"]:
        print(f"[skip] 论文速递已有 {pf_n} 篇（含真实 arXiv），无重复可补")

    # ---------------------------------------------------------------- 周末办任务
    # 只在「本周计划一个任务都没有」时补，不往你已排好的待办里塞演示项。
    task_n = conn.execute("SELECT COUNT(*) c FROM tasks").fetchone()["c"]
    plan = conn.execute(
        "SELECT id FROM weekly_plans ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if task_n == 0 and plan:
        title = "周末办：归档本周实验数据并整理文献笔记"
        due = _TODAY + timedelta(days=(5 - _TODAY.weekday()) % 7 or 7)
        if DRY:
            print(f"[dry] 将新增任务：{title}")
        else:
            conn.execute(
                "INSERT INTO tasks (plan_id, title, status, points, due_date, created_at)"
                " VALUES (?,?,?,?,?,?)",
                (plan["id"], title, "todo", 15, due.isoformat(), now()),
            )
        stats["task"] += 1
    elif task_n:
        print(f"[skip] 已有 {task_n} 条任务，不动它们")

    if DRY:
        print("\n[dry-run] 未写库。统计：", stats)
        conn.close()
        return

    conn.commit()
    conn.close()
    print(
        f"\n补空完成：课题对话 +{stats['chat']}，调研对话 +{stats['rchat']}，"
        f"论文速递 +{stats['paperfeed']}，任务 +{stats['task']}。"
        "\n真实数据未被修改或删除。"
    )


# ================================================================ 内容定义
# 主题与现有 demo 保持一致（OpenFOAM / LLM 修 CFD 案例），并统一标注「演示占位」。

_CHAT_SEEDS = [
    (
        "分层错误归因的下一步",
        "researcher",
        "fast",
        ["ideas", "experiments"],
        [
            ("user", "F1 边界语法全方法 0/24，下一步是先补一组消融实验，还是先改分层归因的提示词？"),
            ("assistant", "建议两步走：先用现有 5 方法固定 prompt、只加「是否给出错误分层提示」这一个变量跑消融，确认分层归因确实带来 diagnosis_correct 提升；再据此重写 Method 的分层描述。这样归因结论有数据支撑，导师周会也好讲。"),
            ("user", "那就先消融。样本量用多少合适？"),
            ("assistant", "先用 15 个 F1 类样本即可（现有实验每方法样本偏少）。重点看加/不加分层提示的 diagnosis_correct 差，而不是修复成功率——F1 本来成功率就接近 0。"),
        ],
        1,
    ),
    (
        "Feedback-driven Refinement 可行性",
        "researcher",
        "deep",
        ["literature", "ideas"],
        [
            ("user", "导师提到 Feedback-driven Refinement 可作为第二篇切入点，先帮我评估可行性。"),
            ("assistant", "可行但有前提：反馈信号必须可解析（求解器报错、残差曲线），不能只靠「再试一次」。建议把它定位成「多轮自我修正」而非「一次性生成」，和现有分层归因互补——分层管定位，反馈管修正。"),
            ("user", "那和 Codamosa 的反馈循环有什么差异？"),
            ("assistant", "Codamosa 的反馈来自测试执行（pass/fail + coverage），我们额外引入编译/数值/物理三层信号，反馈粒度更细，这是差异点。（演示占位内容，非实测）"),
        ],
        3,
    ),
    (
        "组会预演：F1 失败归因怎么说",
        "researcher",
        "fast",
        ["experiments", "advisor_notes"],
        [
            ("user", "组会要讲 F1 全军覆没，导师要求给解释，帮我组织口径。"),
            ("assistant", "口径三句：① F1 是边界条件类故障，不在任何方法的覆盖范围内，所以全 0 是设计使然不是实现缺陷；② 我们据此把评价从 success_rate 切到 diagnosis_correct；③ 已用消融把「是否给分层提示」作为唯一变量，证明分层归因能定位到这一层。"),
        ],
        5,
    ),
]

_RCHAT_SEEDS = [
    (
        "LLM 自动修复 CFD 案例的综述",
        [
            ("user", "text", "帮我写一份 LLM 自动修复 CFD 案例的综述，覆盖错误定位与多轮修正。",
             {"tag": "综述撰写"}),
            ("assistant", "report",
             "# LLM 自动修复 CFD 案例：定位与修正\n\n"
             "## 1 背景\nCFD 案例（如 OpenFOAM tutorial）配置繁琐，边界条件、数值格式、物理模型任一设置错误都会导致求解失败或结果失真。\n\n"
             "## 2 方法谱系\n- 规则式（Rule-based）：覆盖已知错误，盲区大；\n- LLM-only：偶发过度修改；\n- RAG-LLM：借案例库做 few-shot；\n- 日志/物理引导：引入残差与物理一致性信号。\n\n"
             "## 3 结论\n错误分层归因 + 反馈驱动修正 是当前最稳的组合。\n\n"
             "> 注：以下为演示占位内容，非真实实验数据。",
             {"citations": [
                 {"n": 1, "title": "ChatCFD: LLM Agent for CFD", "authors": "—", "year": 2024,
                  "venue": "GitHub", "url": "https://example.org/demo/chatcfd"},
                 {"n": 2, "title": "Feedback-driven Refinement for Solver Config",
                  "authors": "Demo et al.", "year": 2025, "venue": "arXiv",
                  "url": "https://example.org/demo/fdr"},
                 {"n": 3, "title": "PhyLog-Repair: Physics-guided Repair", "authors": "Demo",
                  "year": 2025, "venue": "arXiv", "url": "https://example.org/demo/phylog"},
             ]}),
        ],
        2,
    ),
    (
        "错误分层归因方法调研",
        [
            ("user", "text", "检索「错误分层归因」相关的 LLM 修复工作，给出关键论文。",
             {"tag": "深度检索"}),
            ("assistant", "deep",
             "已检索 OpenAlex，命中 3 篇相关工作的核心文献，并自动入库到「文献库」。\n\n"
             "关键发现：现有方法多在单层（执行/数值）归因，物理层归因稀缺，这正是我们的切入点。\n\n"
             "> 注：演示占位，检索结果为示例，非真实 OpenAlex 命中。",
             {"citations": [
                 {"n": 1, "title": "Layered Fault Attribution for Scientific Agents",
                  "authors": "Demo", "year": 2025, "venue": "arXiv", "cited_by": 12,
                  "url": "https://example.org/demo/layered"},
                 {"n": 2, "title": "Execution vs Physics: Where LLM Repairs Fail",
                  "authors": "Demo", "year": 2024, "venue": "NeurIPS WS", "cited_by": 34,
                  "url": "https://example.org/demo/exevsphys"},
                 {"n": 3, "title": "Self-Correcting Solver Configurations", "authors": "Demo",
                  "year": 2025, "venue": "ICLR", "cited_by": 8,
                  "url": "https://example.org/demo/selfcorr"},
             ],
              "queries": ["fault attribution LLM solver",
                          "scientific agent error localization",
                          "CFD configuration repair"]}),
        ],
        4,
    ),
    (
        "本周文献快读",
        [
            ("user", "text", "用一句话总结本周读的三篇文献。", {"tag": "研究对话"}),
            ("assistant", "text",
             "① OpenFOAM 2406 文档：454 tutorial 是案例检索基础；② ChatCFD：错误定位策略差异大；"
             "③ Feedback-driven：可作第二篇锚点。三篇共同指向「分层归因 + 反馈修正」。", {}),
        ],
        6,
    ),
]

# (arxiv_id, title, authors, abstract, cats, primary_cat, link, published, title_zh, abstract_zh)
_PAPERFEED_SEEDS = [
    ("2406.12345", "LLM Agents for Automated CFD Case Repair", "Demo A, Demo B",
     "We propose a layered fault attribution framework that localizes CFD configuration "
     "errors into execution, numerical, and physics layers before repair.",
     "cs.AI,physics.comp-ph", "cs.AI", "https://arxiv.org/abs/2406.12345", "2024-06-18",
     "面向 CFD 案例修复的 LLM 智能体",
     "我们提出分层错误归因框架，在修复前把 CFD 配置错误定位到执行/数值/物理三层。【演示占位 · 非实测】"),
    ("2407.23456", "Feedback-driven Refinement of Solver Configurations", "Demo C",
     "A multi-round self-correction loop driven by solver errors and residual curves, "
     "reducing over-modification common in LLM-only baselines.",
     "cs.LG,cs.SE", "cs.LG", "https://arxiv.org/abs/2407.23456", "2024-07-09",
     "基于反馈驱动的求解器配置精修",
     "以求解器报错与残差曲线为反馈的多轮自修正循环，缓解 LLM-only 常见的过度修改。【演示占位 · 非实测】"),
    ("2408.34567", "PhyLog-Repair: Physics-guided Program Repair", "Demo D, Demo E",
     "We inject physics-consistency signals (conservation, boundary behavior) into the "
     "repair search, improving correctness on physics-layer faults.",
     "cs.AI,physics.flu-dyn", "physics.flu-dyn", "https://arxiv.org/abs/2408.34567",
     "2024-08-21", "PhyLog-Repair：物理引导的程序修复",
     "将物理一致性信号（守恒、边界行为）注入修复搜索，提升物理层故障的修复正确率。【演示占位 · 非实测】"),
    ("2409.45678", "RAG-LLM for Scientific Case Retrieval", "Demo F",
     "A retrieval-augmented agent that grounds code generation in a curated tutorial "
     "corpus, lowering hallucination on out-of-distribution cases.",
     "cs.CL,cs.AI", "cs.CL", "https://arxiv.org/abs/2409.45678", "2024-09-03",
     "面向科学案例检索的 RAG-LLM",
     "基于精选 tutorial 语料的检索增强智能体，降低分布外案例的幻觉。【演示占位 · 非实测】"),
    ("2410.56789", "Benchmarking LLM Repair on 454 Tutorials", "Demo G, Demo H",
     "We release a 454-case CFD tutorial benchmark and show that error-layered "
     "attribution consistently outperforms flat prompting.",
     "cs.SE", "cs.SE", "https://arxiv.org/abs/2410.56789", "2024-10-15",
     "在 454 个 tutorial 上评测 LLM 修复",
     "发布 454 案例 CFD benchmark，显示错误分层归因稳定优于扁平提示。【演示占位 · 非实测】"),
    ("2411.67890", "Self-Correcting Agent Loops for Simulation", "Demo I",
     "An analysis of when self-correction helps vs. harms in simulation-agent loops, "
     "with a stopping criterion based on residual convergence.",
     "cs.AI", "cs.AI", "https://arxiv.org/abs/2411.67890", "2024-11-02",
     "面向仿真的自修正智能体循环",
     "分析自修正在仿真智能体循环中的收益与风险，并提出基于残差收敛的停止准则。【演示占位 · 非实测】"),
]


if __name__ == "__main__":
    main()
