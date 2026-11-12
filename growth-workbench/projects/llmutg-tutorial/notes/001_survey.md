# 阶段 1 · 论文调研（Literature Survey）

> 目标：把「LLM 单元测试生成」领域的文献收进工作台的**文献库**，并标注与本研究的关联。
> 这一阶段的产出 = 论文第 2 章 Related Work 的素材。

## 在工作台里去哪做
- 左侧导航 **文献 Literature**（`/literature`）；批量检索可用 **litsearch / OpenAlex / Zotero**；论文喂送用 **paperfeed**。
- 对应 API：`POST /api/literature`、`GET /api/literature`、`/api/litsearch`、`/api/zotero`。

## 怎么做（示例）
单篇入库（带 notes 标注关联）：
```bash
curl -b "wb_session=$TOK" -X POST http://127.0.0.1:8000/api/literature \
  -H 'Content-Type: application/json' \
  -d '{"title":"TestPilot: An LLM-Based Developer Tool for Authoring Tests",
       "authors":"Schäfer, M. et al.","year":2023,"venue":"arXiv:2308.16521",
       "url":"https://arxiv.org/abs/2308.16521","status":"read","rating":5,
       "relevance":"high","tags":"test-generation,llm",
       "notes":"生成-修复闭环范式；本研究 agent 接口参考它。"}'
```
已有条目（如某条是占位）可直接 `PATCH /api/literature/{id}` 填实。

## 本教程已做好的真实资产（去库里核对）
库里**原本就有**这条线的核心文献：CodaMosa(`16`)、TESTEVAL(`21`)、CoverUp(`24`)、mutation-guided(`29`)、feedback/agentic TestForge(`20`)。
本教程**补录 / 填实**了：
| 库 ID | 论文 | 角色 |
|---|---|---|
| `4` | REFLEX (Wu & Lim, 2026) | **Jev 机制源**，填实了原「【待补】Feedback-driven Refinement」占位 |
| `455` | TestPilot (2023) | 开发者测试工具范式 |
| `456` | ChatUniTest (2024) | 生成-校验流水线 |
| `457` | Pynguin (2022) | 搜索式 Python 测试基线 |
| `458` | EvoSuite (2017) | 全测试套件搜索基线 |
| `459` | AthenaTest (2022) | 纯 LLM 基线 |

> 调研要点：先建**检索—筛选—矩阵**（用 `/api/literature/matrix`），再提炼「主张 vs 已有工作」的差距表。REFLEX 是方法内核出处；CodaMosa/TestEval/CoverUp 是基线与基准。

## 落到论文
Related Work 按三组写：搜索式/LLM 生成、基准与基线、决策门控（REFLEX）。
详见 `exports/llmutg_paper.pdf` 第 2 节。
