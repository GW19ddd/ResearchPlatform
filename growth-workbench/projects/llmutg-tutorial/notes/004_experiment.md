# 阶段 4 · 实施实验（Experiment Implementation）

> 目标：把方法落成**可复现的实验框架**——基准、基线、指标显式定义。
> 这一阶段的产出 = 论文第 5 章 Experimental Design；实际 LLM 跑批由你执行。

## 在工作台里去哪做
- **实验 Experiments**（`/api/experiments`、`/api/experiments/{id}/runs`、`/api/experiments/{id}/results`）。
- 指标与图表：`/api/experiments/{id}/chart`、`/api/experiments/{id}/analysis`。
- 数据流工作室：`/api/workspace/analysis`、`/api/workspace/code/run`。

## 实验设计（写进论文 §5）
- **基准**：CodaMosa 486 模块套件（"CM"）+ TestEval 210 项。
- **基线**：`codamosa`、`coverup`、`telpa`、`Undermind`（后两者出处待核实，见论文 Threats）。
- **指标（显式定义，避免含糊）**：
  - 覆盖率 `C`（line/branch %）
  - 有效测试比 `V`（编译且通过的比例）
  - LLM 调用降幅 `Δ_LLM`（相对 LLM-only 基线）
  - 节点级定位成功率 `L`

## 怎么落地实验（示例）
```bash
# 1) 建实验
curl -b "wb_session=$TOK" -X POST http://127.0.0.1:8000/api/experiments \
  -H 'Content-Type: application/json' -d '{"name":"DMF-Jev on CM486","benchmark":"cm"}'
# 2) 登记一次运行结果（实际来自你的跑批日志）
curl -b "wb_session=$TOK" -X POST http://127.0.0.1:8000/api/experiments/{id}/results \
  -H 'Content-Type: application/json' -d '{"method":"DMF-Jev","coverage":74.9,"valid_ratio":0.88}'
```

## 本教程已做好的真实资产
- 架构已在工作台画布落地：`/api/canvas/25`（动态多源反馈图 + Jev 决策，13 节点 / 20 边）。
- 实验框架（基准/基线/指标）已在论文 §5 写成文；**真实数值待你跑批后填入**。

## 落到论文
Experimental Design（§5）。注意：指标必须先定义再测，绝不允许事后改口径。
