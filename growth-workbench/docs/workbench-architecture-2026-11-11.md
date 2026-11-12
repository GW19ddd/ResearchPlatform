# 工作台架构设计：角色分工 + 四大能力工作室 + 全局任务带

> 参照：立理 S1 首页截图（8 个智能体角色 + 底部「运行中」任务卡片）
> 需求：支持 LaTeX 编译、`.tex` 文件、科研绘图实时渲染、数据分析等
> 数据出处：`growth-workbench` 现有代码与 `data/workbench.db`，2026-11-11 只读排查
> 文档性质：**设计稿，本次未改任何代码与业务数据**。标「已有」= 代码里真实存在；标「新增」= 待做。

---

## 0. 结论先行

截图里那 8 个「智能体」和底部任务卡片，拆开看是两件事：**能力分区的入口** + **统一的任务执行状态**。这两件我们都能在不推翻现有信息架构的前提下做出来，因为底层已经有一半：

| 需要的能力 | 现状 |
|---|---|
| 真实跑代码 / 产物留痕 | **已有**：`server/routers/expagent.py` 的 `subprocess.run`（工作区隔离、快照 diff 定位产物、`runs/<ts>/` 归档、`_register_run` 留痕、失败降级 `provenance=illustrative` 防假数字） |
| LaTeX 编译 | **本机已有 MiKTeX**：`xelatex` / `pdflatex` / `latexmk` 在 `D:/01-App/06_Academic/MiKTeX/miktex/bin/x64/`，但不在服务进程 PATH，需要显式配置 |
| PDF 预览 | **已有**：`features/literature/PdfModal.tsx` + `pdfjs-dist 4.0.379` |
| 前端图表 | **已有**：`recharts ^2.12.7`、`POST /experiments/{id}/chart`（AI 把**已入库的真实数字**组织成图表 spec，带「禁止推算/补全」硬规则） |
| 论文写作 / 评审 / 绘图技能 | **已有**：技能库 15 条，含 `latex-paper-skills`、`nature-figure`、`paper-writing`、`paper-spine`、`nature-reviewer`、`citation-check-skill` |
| 可回退的多节点流水线 | **已有**：画布 4 视图、`POST /canvas/{id}/run` 支持 `scope` 单节点重跑 |
| `.tex` 文件管理 / 编译端点 | **缺** |
| 科研绘图实时渲染（代码→图） | **缺**（现有 chart 是「数字→图表 spec」，不是「代码→真实渲染」） |
| 数据分析工作台 | **缺** |
| 全局「运行中任务」面板 | **缺**（画布 run 与实验 run 各记各的，无统一视图） |
| Python 科学栈 | 隔离 venv 里只有 `numpy`，缺 `pandas` / `matplotlib` / `scipy` / `plotly` |
| 代码编辑器 | 前端无 Monaco / CodeMirror / KaTeX |

**设计主张**：不做 8 个自治智能体（我们没有长程 multi-agent 与算力沙箱，不对外宣称），而是做 **1 个启动面 + 1 条角色入口带 + 4 个能力工作室 + 1 条全局任务带 + 1 个共用执行底座**。角色是「一键进入某能力」的入口，任务带是截图底部那张卡片的产品化。

---

## 1. 五个部分总览

```
① 启动面  /                    保留现有 Workbench.tsx，不动
② 角色带  8 个入口             新增，纯前端入口映射，不新建后端 agent
③ 能力工作室 4 个             新增，共用 ⑤
   ├ 论文工作室  .tex + LaTeX 编译 + PDF
   ├ 绘图工作室  实时渲染
   ├ 分析工作室  数据分析
   └ 代码工作室  通用工作区 / 运行
④ 全局任务带                  新增，对应截图底部「运行中 3/11」卡片
⑤ 共用执行底座 workspace.py   从 expagent 抽出，泛化为通用服务
```

### ① 启动面（锁定，不改）

`/` 维持现有 WorkBuddy 式启动面：问候 + 对话/调研/实验三模式 + 大输入框 + 底栏工具条 + 最近对话/实验。**素底，不加背景图**（见项目约定）。角色带作为启动面下方的一行入口 chip 叠加，不替换大输入框。

### ② 角色带：8 个角色 → 已有能力映射

| 截图角色 | 落到哪里 | 说明 |
|---|---|---|
| S1 科研助理 | `/` 对话模式 | 现有启动面 |
| 课题规划师 | `/chat` 课题 Quest | 契约 → 四阶段门禁 → 成文 |
| **编程工程师** | **代码工作室（新）** | 通用工作区 + 运行 + 产物 |
| 技术评审专家 | 画布 `paper-spine`（验论证） | 已真实跑过，判定过「论证链不成立」 |
| 方案评审专家 | 画布 `nature-reviewer`（模拟审） | 已真实跑过 |
| **科研写作专家** | **论文工作室（新）** | `.tex` + 编译 + PDF，联动 `paper_sections` / 7 阶段 |
| 定稿提醒助理 | 7 阶段阻塞红警 + `/dashboard` 待办 | 现有能力，补一个入口 |
| 工作总结助理 | `/plan` 周计划 / 周复盘 | 现有能力，补一个入口 |

> 诚实边界：这些是**能力入口**，不是 8 个独立自治智能体。文案上写「角色 / 能力」，不要写「多智能体协作」。

### ③ 四个能力工作室（核心新增）

#### 3.1 论文工作室 · `/paper` 扩展

**能力**：`.tex` 文件树（新建 / 上传 / 版本快照 / 重命名 / 删除）、编辑、编译、PDF 预览、编译日志、与论文 7 阶段和 `paper_sections` 联动、`.bib` 管理。

**技术路径**：
- 文件统一存 `data/ws/paper/<paper_id>/`，DB 新增 `paper_files` 表（path、size、updated_at、version）；路径校验复用 `_safe_rel` 防目录穿越。
- 编译命令走白名单：`latexmk -xelatex -interaction=nonstopmode -halt-on-error -no-shell-escape main.tex`（或 `xelatex` 单步）。**TeX bin 路径写入 settings**（`latex.bin_dir`），由 `_sub_env` 注入 PATH——服务进程是计划任务启动的，PATH 里没有 MiKTeX，这是必须显式做的一步。
- 编译在**工作区内**执行，产物 `main.pdf` 落到 `runs/<ts>/`，前端复用 `PdfModal` 居中大窗预览（`h-[94vh] w-[min(1500px,96vw)]`）。
- 失败解析 `.log`：抽取 `! ` 开头的错误行与行号回显，**编译失败绝不返回成功**。
- 与 `paper_sections` 双向：章节草稿可「导出为 .tex 片段」插入；编译产物可挂到对应阶段。

**验证标准**：退出码非 0 或 PDF 未生成即判失败；超时 120s 强杀；禁止 `--shell-escape`；每个编译作业写一条 run 记录（命令、退出码、耗时、产物路径、日志尾部）。

#### 3.2 绘图工作室 · `/figures`

「实时渲染」分两条路线，先做不装依赖的那条：

- **P0 前端直出（立刻可跑）**：左侧编辑图表 spec（或粘贴数据）→ debounce 600ms → 右侧 Recharts 即时渲染。复用 `/experiments/{id}/chart` 的 spec 结构与「只准用真实数字、禁止推算/补全/平滑」硬规则。适合柱状/折线/散点，秒级反馈，零后端执行。
- **P1 真实 Python 绘图**：装 `matplotlib` 到隔离 venv，代码在通用工作区执行 → 输出 SVG/PNG → 前端预览；TikZ / PGFPlots 走 3.1 的 LaTeX 编译链路，产物 PDF 转图。
- 图可「存为图表资产」并挂到论文章节或实验结果，形成闭环。

**验证标准**：图中数值只能来自已入库结果记录或真实运行输出；`nature-figure` 技能只做版式建议，不得凭空生成数据点。

#### 3.3 数据分析工作室 · `/analysis`

**能力**：CSV / Excel 上传 → 列类型推断 → 描述统计 → 分组对比 / 相关性 → 表格 + 图 → **一键「存为实验结果」回流 `exp_results`**（这样 `/experiments/{id}/chart` 能直接画，闭环到实验与论文）。

**技术路径**：`pandas` / `scipy` 装进隔离 venv（`C:\Users\Amber\.workbuddy\binaries\python\envs\default`，按项目隔离规则，不污染用户环境）；脚本由工作区服务执行，输出 JSON 表格 + 图文件；大文件限制行数与超时。

**验证标准**：任何统计结论必须附「数据来源 + 运行记录 id」；运行失败时产物标 `illustrative`，不得以实测身份进入结论（沿用 expagent 现有契约）。

#### 3.4 代码工作室 · `/workspace`（编程工程师）

把 `expagent.ws_dir(exp_id)` 泛化成 `workspace_dir(kind, owner_id)`，提供：文件树、代码编辑、运行按钮、stdout/stderr 终端面板、产物列表与下载、历史 run 列表。实验 Agent 对话仍复用 `ChatPanel` 版式，只是工作区来源换成通用服务。

### ④ 全局任务带（截图底部卡片的产品化）

统一任务模型 `workspace_runs`（或聚合 `canvas_runs` + expagent runs + 新 compile/analysis 作业），在底栏上方渲染一条常驻任务条，卡片字段对齐截图：

```
角色/来源   任务名              文件                 资源/规模     进度   状态
编程工程师  在沙箱里跑第 3 组实验  models/ldm_to3d.py   4×A100       3/11   运行中
```

我们的版本（不虚构算力）：

```
来源        任务名              主文件            耗时      进度    状态    产物
论文工作室  编译 main.tex        main.tex         2.4s      —      成功    main.pdf
绘图工作室  生成图 2            fig2.py          1.1s      —      成功    fig2.svg
画布        AI生成单测流水线     canvas/8         66s      6/6    成功    11 条产物
```

- 点击展开看命令、退出码、stdout/stderr 尾部、产物路径；可取消运行中的任务。
- 任务带读 ⑤ 的统一 run 记录，**不新造第二套状态**。

### ⑤ 共用执行底座 `server/workspace.py`（关键重构，但最小）

从 `expagent.py` 抽出并泛化，不推翻现有实验逻辑：

| 抽出项 | 现状 | 泛化后 |
|---|---|---|
| `ws_dir(exp_id)` | `data/exp_ws/<exp_id>` | `workspace_dir(kind, owner_id)` |
| `_safe_rel` | 已有，防 `..` / 绝对路径 / 盘符 | 原样保留，全工作室共用 |
| `_sub_env` | 注入当前解释器 PATH | 追加注入 `latex.bin_dir` |
| `_snapshot` diff | 已有，定位新增/变更产物 | 原样复用 |
| `_register_run` | 已有，落 run 记录 | 统一记录，供任务带读取 |
| `provenance=illustrative` 降级 | 已有（运行失败时防假数字） | 全工作室强制 |
| 常量 | `MAX_FILES=4` / `MAX_FILE_CHARS=12000` / `MAX_OUTPUT_CHARS=6000` / `RUN_TIMEOUT_S=300` | 按任务类型可配（编译 120s / 分析 300s） |
| 命令执行 | `subprocess.run(command, shell=True, ...)` | **改为白名单 + `shlex.split` + `shell=False`**，只放行 `python` / `xelatex` / `pdflatex` / `latexmk` / `bibtex` |

> ⚠️ 安全边界（项目约定里已写明）：审批模式是 system 软约束 + 留痕，**不是命令执行闸门**，`expagent` 无审批。所以真正的闸门必须落在这里：命令白名单、超时、工作区隔离、路径校验、产物大小限制。设计里不要对外宣称「审批已拦截命令」。

---

## 2. 依赖清单（明确要装什么）

| 类别 | 项 | 状态 / 动作 |
|---|---|---|
| 系统 | MiKTeX（xelatex/pdflatex/latexmk） | **已装**，路径 `D:/01-App/06_Academic/MiKTeX/miktex/bin/x64/`，写入 settings |
| 系统 | tectonic | 不装；MiKTeX 够用，避免两套 TeX |
| Python venv | `numpy` | 已有 |
| Python venv | `pandas`、`matplotlib`、`scipy` | **新增**，装进 `.../envs/default`，不全局安装 |
| 前端 | `pdfjs-dist`、`recharts`、`react-markdown` | 已有 |
| 前端 | 代码编辑器（建议 CodeMirror 6，比 Monaco 轻） | **新增** |
| 前端 | `katex`（公式即时渲染，可选） | **新增**（若 Markdown 里要渲染公式） |
| 后端 | FastAPI + 一个新 router `workspace.py` | 无新框架 |

---

## 3. 分阶段落地

### P0 · 不装任何依赖，先把「架子 + 闭环」跑通（推荐先做）

1. 角色带 8 个入口（纯前端，映射到现有路由 / 画布节点）
2. 全局任务带（聚合现有 `canvas_runs` 与 expagent run，先只读展示）
3. 抽出 `server/workspace.py`，命令白名单 + TeX bin 注入 + 统一 run 记录
4. 论文工作室最小版：`.tex` 文件树 + 编译 + PDF 预览 + 失败日志
5. 绘图工作室前端直出版（Recharts spec 实时预览，复用现有 chart spec）

> 这档结束时，「支持 LaTeX 编译 / .tex 文件 / 科研绘图实时渲染」三件事就都是真的了，且不依赖新增 Python 包。

### P1 · 装科学栈，把「数据分析」和真实绘图补上

6. 隔离 venv 装 `pandas` / `matplotlib` / `scipy`
7. 数据分析工作室（上传 → 统计 → 表格/图 → 回流 `exp_results`）
8. 绘图工作室真实 Python 渲染 + 产物挂章节
9. 任务带补齐取消、产物下载、历史 run

### P2 · 加固与体验

10. 资源限额（内存/输出大小）、增量编译、多文件项目、`.bib` 管理、TikZ
11. 版本 diff、导出「复现包」（.tex + 数据 + 脚本 + 图 + run 日志）
12. 与工作流 SOP 文档（`docs/workflows-and-case-2026-11-11.md`）里的 WF-04/05/06 打通，把「编译/绘图/分析」固化成画布节点类型

---

## 4. 明确不做 / 锁定不变

- **不改** `/` 启动面结构、不重建 Studio/Apps、不把首页换成多智能体大屏。
- **不动** 画布入口（侧栏「画布 → 编排」）、`?cid=` URL 即状态、TopBar 40px + 底栏 22px、页面无大标题、工作台素底。
- **不做** 长程自治 multi-agent、GPU 算力池、秒级沙箱预热、独立评审智能体进程——我们没有这些，文案不宣称。
- **不加** 背景图 / 装饰插画（项目约定）。
- **不把** 审批模式说成命令执行闸门；真闸门是白名单 + 超时 + 隔离。

---

## 5. 与上一份文档的关系

`docs/workflows-and-case-2026-11-11.md` 解决「科研流程怎么封装成 SOP、成果怎么按证据链展示」；本文解决「工作台由哪几部分组成、四件硬能力怎么落」。两者不冲突：工作流 SOP 是**方法层**，本文是**产品分区与执行层**。上一份建议的 A 档只读展示页，可以并入本文 P0 的角色带 + 任务带一起做。

**本次交付仅本文档**（未修改任何页面、后端或业务数据）。是否按 P0 开工、以及是否把「角色带」放在 `/` 启动面下方还是单独做一页，请确认。
