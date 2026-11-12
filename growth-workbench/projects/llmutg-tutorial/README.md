# 教程项目：用研流生成《基于 LLM 的 AI 单元测试生成》英文论文

> 这是一个**工作台内教程项目**：教读者一步步在本工作台里，把一条真实的科研线（LLM 驱动的单元测试生成）
> 走完「调研 → 选题 → 创新 → 实验 → 数据后处理 → 写作」，并最终通过工作台的 LaTeX 编译产出英文论文 PDF。

## 这份教程在讲什么
- **产品**：研流（growth-workbench）—— 一个把科研工作流做成可操作资产（文献 / 创新点 / 实验 / 画布 / 论文）的工具。
- **案例论文**：*LLM-Driven Unit Test Generation with a Dynamic Multi-Source Feedback Graph and Jev Typed Decision*（方法内核：动态多源反馈图 + Jev 类型化决策，τ=0.5）。
- **目标读者**：第一次用工作台的研究者 / 新组员；看完能照着把一条研究线跑成论文。

## 怎么跟着做
按 `notes/` 的六步顺序阅读，每一步都给出：
1. 工作台里**去哪做**（左侧导航入口 / API 路径）；
2. **怎么做**（操作示例，含真实 curl）；
3. 本教程已经**做好的真实资产**（文献 ID、创新点 ID、画布 ID、已编译 PDF），你可以直接在库里核对。

| 步骤 | 文件 | 对应论文章节 |
|---|---|---|
| 1 论文调研 | `notes/001_survey.md` | Related Work |
| 2 选题确定 | `notes/002_topic.md` | Motivation / RQ |
| 3 创新点总结 | `notes/003_innovation.md` | Method（主张） |
| 4 实施实验 | `notes/004_experiment.md` | Experimental Design |
| 5 数据后处理 | `notes/005_postprocess.md` | Data Post-processing |
| 6 论文撰写 | `notes/006_writing.md` | 全文 + 编译 |
| 7 日常推进与复盘 | —（对应「今日 / 计划复盘 / 共识」页） | 论文之外的工作流 |

> 应用内教程页（`/tutorial/llmutg`）把上面六步 + 复盘扩成 7 个阶段，每阶段给「去哪做 / 怎么做 / 经验与坑 / 本阶段产出」四段，
> 并配 12 张带编号标注框的真实界面实拍。论文已扩写到 8 页（补充了 Introduction 贡献列表、Related Work 两条支线、
> Method 的公式与复杂度、实验配置与消融计划、Discussion 四个专题、Conclusion 的未来工作）。

## 关键资产（已在工作台里真实生成）
- **文献**：REFLEX(库ID `4`，填实了原「待补」占位)、TestPilot(`455`)、ChatUniTest(`456`)、Pynguin(`457`)、EvoSuite(`458`)、AthenaTest(`459`)；库中原已有 CodaMosa(`16`)、TESTEVAL(`21`)、CoverUp(`24`)。
- **创新点**：三条可证伪主张 `31 / 32 / 33`。
- **架构画布**：`/api/canvas/25`（动态多源反馈图 + Jev 决策）。
- **英文论文**：`sources/llmutg_paper.tex`（源码） → `exports/llmutg_paper.pdf`（已用工作台 `tex/compile` 编译，含 TikZ 架构图与结果图）。

## 硬边界（必读）
- 论文内**所有实验数值均为合成演示数据（DEMO）**：由 `scripts/generate_demo_results.py` 用固定种子 `20261112` 生成（486 模块 × 3 方法），统计量（中位 + bootstrap CI、配对 Wilcoxon、Cliff's δ）是**在演示数据上真实计算**的，但数据本身不是实测。论文正文、图注、页脚、教程页均已显式标注。
- `telpa` / `Undermind` 基线出自本地 harness，引用出处需在提交前核实（见论文 Threats to Validity）。
- 文献条目中个别作者/arXiv 编号标了「待核实」，以最终发表版为准。

## 怎么打开（入口页）
- **应用内入口（唯一推荐）**：侧栏「更多 → 案例教程」，或直接访问 `http://127.0.0.1:8000/tutorial/llmutg`
  （路由见 `App.tsx`，页面为 `features/tutorial/TutorialFrame.tsx` 原生 React 页面：左侧步骤导航 + 中间教学 + 右侧内嵌 PDF；顶栏面包屑「更多 / 案例教程」）。
- **静态页（保留，作无登录分享用）**：`http://127.0.0.1:8000/tutorial/llmutg/index.html`

## 截图与标注（可复现）
配图是**真实界面实拍**，不是示意图：

| 文件 | 内容 |
|---|---|
| `web/public/tutorial/llmutg/shots/NN-*.png` | 2× 无标注原图（1440×900 @ deviceScaleFactor 2） |
| `web/public/tutorial/llmutg/shots/NN-*-annotated.png` | 叠加编号框后的成品（教程页实际引用这张） |
| `web/public/tutorial/llmutg/shots/boxes.json` | 每个框的真实元素坐标（CSS px）与标签文案 |

重跑方式（后端需在跑）：

```bash
# 1) 实拍 + 读取真实元素 bbox
NODE_PATH=<node_workspace>/node_modules node projects/llmutg-tutorial/scripts/capture_shots.js <session_token>
# 2) 按 bbox 画框 + 编号徽章 + 标签气泡
python projects/llmutg-tutorial/scripts/annotate_shots.py   # 需在 growth-workbench 根目录执行
```

> 说明：`capture_shots.js` 用 playwright-core 驱动本机 Chrome，注入 `wb:app.tourSeen=true` 关掉新手引导；
> `annotate_shots.py` 把框画在**元素真实位置**（不用手工估比例），编号徽章贴框外侧、标签气泡自动避让框与其它气泡。
