# 科研画布（Research Canvas）开发计划

> 科研版 Dify：节点 = skill，边 = 数据流，画布 = 可保存、可重跑的科研流水线。
> 日期：2026-09-20 ｜ 归属：growth-workbench 的新一级页面 `/canvas`

---

## 0. 关键决策：自研画布，而不是集成 Dify

| 维度 | 自研画布（选定） | 嵌入 Dify |
|---|---|---|
| 本质 | 15 个 skill 本质是 prompt 模板 + 拓扑执行，引擎 ~200 行 | 通用 workflow 平台，Docker 全家桶，重 |
| Skill 接入 | skill = JSON prompt 模板，拖入即跑 | 每个 skill 要改写成 Dify DSL，工作量大 |
| 数据打通 | 与 Ideas/文献/论文模块同库，输出直接落库 | 隔离在 Dify 库，打通要走 API |
| 未来兼容 | 预留「外部工具」节点，未来可把 Dify workflow 当一个节点调用 | 现在就背上全部复杂度 |

**结论**：Phase 1-2 自研；Phase 3 如需真 tool-calling / 多 agent 协作，再把 Dify（自托管）作为外部工具节点接入，两不耽误。

---

## 1. 核心概念模型

- **节点（Node）**：四种类型
  1. `input` — 输入节点：研究方向 / 一段文本 / 上传文件
  2. `skill` — 技能节点：一个带输入槽的 prompt 模板（核心）
  3. `tool` — 外部工具节点（Phase 2）：arXiv 检索、Zotero、Dify workflow API
  4. `output` — 输出节点：结果存入 Ideas / 文献矩阵 / 论文模块
- **边（Edge）**：上游输出自动注入下游 prompt 的 `{{upstream}}` 槽位
- **画布（Canvas）**：节点+边+布局的整体，可保存多张（如「选题流水线」「组会汇报流水线」）
- **运行（Run）**：按拓扑序执行，每个节点的输入/输出/耗时/所用模型全部留痕，可单节点重跑

## 2. Skill 注册表（截图 8 类全量录入，共 15 个）

| 分类 | skill | 输入槽 | 输出 |
|---|---|---|---|
| 1 选题与框架 | academic-research-suite | 研究方向、约束 | 科研框架、假设、方法设计 |
| 1 选题与框架 | latex-paper-skills | 研究主题 | 从零到论文框架的路线 |
| 2 文献与综述 | literature-survey-skill | 主题、已有文献 | 综述、研究空白、领域脉络 |
| 2 文献与综述 | nature-academic-search | 关键词 | 扩展检索词、补漏引用 |
| 3 主线与论证 | paper-writing | 论文素材 | 主线、科学问题、创新点 |
| 3 主线与论证 | paper-spine | 动机、结果 | 论证链与证据链诊断 |
| 4 写作与表达 | nature-writing | 草稿 | 摘要/引言/结果重构 |
| 4 写作与表达 | nature-polishing | 段落 | 学术润色、中英转换 |
| 5 引用核查 | citation-check-skill | 引用列表+正文 | 虚假/缺失引用诊断 |
| 5 引用核查 | nature-citation | 段落+引用 | 证据支撑核查 |
| 6 图表与汇报 | nature-figure | 图+数据 | 图注、图文对应检查 |
| 6 图表与汇报 | nature-paper2ppt | 论文 | 组会汇报提纲与页结构 |
| 6 图表与汇报 | presentation-skill | 提纲 | slide deck 设计与检查 |
| 7 模拟评审 | nature-reviewer | 论文草稿 | major/minor concerns |
| 8 返修回复 | nature-response | 审稿意见+论文 | 逐条回复信 |

- 存放：`server/skills/*.json`（name、category、prompt 模板、输入槽、建议 model mode: fast/reason）
- 每个模板里写明该 skill 的「真实性提示」——非官方 skill 的输出一律标注"AI 生成，需人工核验"

## 3. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 画布前端 | **React Flow（@xyflow/react）** | 节点拖拽/连线/缩放的全套现成方案，Dify 前端同源思路，AI 生成代码质量高 |
| 节点面板 | 复用现有 Tailwind + ui.tsx 组件 | 风格统一 |
| 执行引擎 | FastAPI + asyncio，拓扑排序 | 单机单人，顺序执行足够；节点间上下文用内存传递 |
| 模型分派 | 复用 `llm_config.resolve(mode)` | 轻量 skill 走 fast，综述/评审走 reason，设置页零改动 |
| 存储 | SQLite 新增 5 张表 | canvases / canvas_nodes / canvas_edges / runs / node_outputs |

## 4. 数据模型（5 张表）

```sql
canvases(id, name, created_at, updated_at)
canvas_nodes(id, canvas_id, node_key, type, skill_id, title, x, y, config_json)
canvas_edges(id, canvas_id, source_key, target_key)
runs(id, canvas_id, status, started_at, finished_at)
node_outputs(id, run_id, node_key, input_text, output_text, provider, model,
             prompt_tokens, completion_tokens, elapsed_ms, created_at)
```

## 5. 与现有模块打通（这是画布相对 Dify 的独有优势）

- 输出节点 →「存入 Ideas」：一键把创新点写入 Ideas 模块参与 AI 质疑
- 输出节点 →「存入文献矩阵」：综述结果直接进对比矩阵
- 输入节点 ←「从论文模块拉取」：paper-spine / nature-reviewer 直接读当前论文阶段内容
- 输入节点 ←「从实验模块拉取」：nature-figure 可引用实验记录
- 双周汇总联动（Phase 2）：组会周自动跑 `nature-paper2ppt` 生成汇报提纲

## 6. 三阶段交付计划

### Phase 1：画布 MVP（预计 1 个工作日）
1. 后端：skill 注册表加载（15 个 JSON）+ 5 张表 + `/api/canvas` CRUD + `/api/canvas/{id}/run` 拓扑执行器
2. 前端：React Flow 画布页，左侧 8 分类技能库（拖拽入画布），连线，点击节点弹侧栏（配置输入槽 → 运行 → 看输出 → 单节点重跑）
3. 三张预置画布模板：「选题→综述→论证」「草稿→润色→模拟评审」「论文→组会汇报」
4. 冒烟测试扩展到 canvas 全部接口（无 key 时降级，同现有约定）

### Phase 2：工具节点与打通（预计 1 个工作日）
1. `tool` 节点：arXiv 检索（无 key）、Zotero（走已连接的 MCP）、任意 OpenAI 兼容/Dify workflow API
2. 输出节点与 Ideas / 文献矩阵 / 论文模块的双向打通
3. 运行历史页：每次 run 的 DAG 回放、耗时、token 消耗统计
4. 组会周自动触发 paper2ppt 流水线（挂到现有双周节拍器）

### Phase 3：进阶（按需）
1. 条件分支与循环节点（某节点输出不合格自动重跑）
2. 画布版本历史与 diff
3. Dify 自托管接入为外部工具节点；多 agent 节点（对话式）

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 长链条 run 超 3 分钟 | 节点级异步 + 前端轮询 run 状态；先同步后异步，Phase 1 允许最长 180s |
| 非官方 skill 幻觉 | 每个 skill 输出强制带"需人工核验"标注；引用类 skill 强制要求贴入真实文献列表 |
| 上下文超长 | 下游注入默认截断上游输出前 4000 字，可在节点配置调 |
| React Flow 学习成本 | 它是纯前端库，与现有栈无冲突，API 面向声明式 JSON，AI 辅助迭代友好 |
