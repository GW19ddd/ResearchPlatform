# 阶段 6 · 论文撰写（Paper Writing & Compilation）

> 目标：把前五阶段的资产**组装成英文论文**，并**在工作台里编译出 PDF**。
> 这一阶段的产出 = `exports/llmutg_paper.pdf`（已真实编译）。

## 在工作台里去哪做
- **论文章节 Paper Sections**（`/api/paper/sections`、`/api/paper/stages`）做大纲与进度；
- **LaTeX 编译工作室** `/api/workspace/tex/compile`：把 `.tex` 写进工作区 → 编译 → 取回 PDF。
- 对应 API：`PUT /api/workspace/file` → `POST /api/workspace/tex/compile` → `GET /api/workspace/artifact`。

## 怎么把 .tex 写进工作台并编译（真实调用，本教程已执行）
```bash
# 1) 上传 .tex 到工作区（kind=tex, owner=default）
curl -b "wb_session=$TOK" -X PUT http://127.0.0.1:8000/api/workspace/file \
  -H 'Content-Type: application/json' \
  -d '{"kind":"tex","owner":"default","name":"llmutg_paper.tex","content":"<整篇 LaTeX 源码>"}'
# 2) 编译（xelatex，连跑两次解析交叉引用）
curl -b "wb_session=$TOK" -X POST http://127.0.0.1:8000/api/workspace/tex/compile \
  -H 'Content-Type: application/json' -d '{"name":"llmutg_paper.tex","engine":"xelatex"}'
# 3) 取回 PDF
curl -b "wb_session=$TOK" "http://127.0.0.1:8000/api/workspace/artifact?kind=tex&name=llmutg_paper.pdf&owner=default" -o llmutg_paper.pdf
```
> 我们就是靠这三步在工作台里**真实产出**了 `exports/llmutg_paper.pdf`。

## 论文结构（已落成文，英文）
1. Introduction · 2. Related Work · 3. Motivation & RQ · 4. Method (DMF-Jev) · 5. Experimental Design · 6. Data Post-processing · 7. Results · 8. Discussion · 9. Threats · 10. Conclusion。
- **架构图**：用 TikZ 自绘（六源反馈图 + Jev 决策），零外部依赖、保证编译通过；同图也导出为 `exports/architecture.svg`。
- **结果图**：TikZ 柱状图（`exports/fig_results.svg`），数值 **illustrative**。

## 本教程已做好的真实资产
- `sources/llmutg_paper.tex`：英文论文 LaTeX 源码（已写好，实验数值占位）。
- `exports/llmutg_paper.pdf`：**已用工作台编译**，13 页左右。
- `exports/architecture.svg`、`exports/fig_results.svg`：配套图。

## 提交前必须做的
1. 把所有 `illustrative` 数值替换为你在阶段 4/5 跑出的实测值；
2. 删除文中 `[Author Name]` / 单位 / 邮箱占位，填真实署名；
3. 核实 REFLEX 标题与 `telpa` / `Undermind` 引用出处；
4. 补 CRediT / 基金 / 数据可用性声明。

## 落到论文
全文见 `exports/llmutg_paper.pdf`。这就是「在工作台里跑完一条研究线、直接出论文」的闭环示范。
