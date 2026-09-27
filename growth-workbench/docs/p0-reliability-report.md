# P0 可靠性改造报告（2026-09-22）

> 目标：AI 失败不污染研究数据、写操作幂等、状态单一、加载失败有出口、数据可备份可恢复。
> 本轮只做 P0，P1 设计方向在文末给出方案，未动工。

---

## 一、现状盘点（改造前）

| 模块 | 已实现 | 部分实现 | 待验证 / 缺口 |
|---|---|---|---|
| 创新点 | 捕获/评分/分类/AI 头脑风暴/三角色质疑 | — | **AI 失败文本会被当成果保存** |
| 文献 | Zotero 同步/树状分类/PDF 阅读/对比矩阵/AI 笔记 | — | **摘要失败写空笔记、开抽屉** |
| 实验 | 设计/结果记录/AI 分析 | — | **分析失败会覆盖用户手写结论** |
| 论文 | 阶段流水线/章节字数/AI 解锁 | — | 统计口径不明、单位缺失 |
| 计划复盘 | 周成果/任务/复盘 | 复盘互斥只在前端 | 后端未校验 |
| 导师 | 记承诺/写话术/逾期提醒 | — | 重复提交无保护 |
| 积分 | 双向加减/奖励/对赌 | — | — |
| 科研画布 | 节点/模板/GitHub skill/落库 | 运行是**同步阻塞** | 无取消、无真实状态、失败输出可存 |
| 对话 | 多轮/角色预设/上下文注入 | — | 失败提示过于笼统 |
| 设置 | 多 provider/Dify/统计 | 密钥明文回前端 | **无备份恢复能力** |

---

## 二、本轮完成

### A. AI 调用与成果保存

| 项 | 做法 |
|---|---|
| 统一失败信封 | `server/llm.py` 重写：所有调用返回 `{ok, content, error{kind,label,message,detail,hint}}`，**失败时 content 恒为 `""`** |
| 错误分类 | 9 类（no_provider / no_key / auth / http_error / timeout / network / empty_output / parse / unknown），每类带人话说明 + 可行动建议 |
| 落库前校验 | 头脑风暴、质疑、文献摘要、实验分析、解锁方案、话术、双周汇报 **7 条写路径全部先判 `ok` 再写** |
| 实验结论保护 | 分析失败不再 `UPDATE experiments.conclusion`，用户手写结论原样保留 |
| 密钥脱敏 | `llm.redact()` 抹掉登记过的 key 与常见形态（sk-/app-/Bearer/api_key=…）；设置接口只回 `api_key_set`，回传脱敏值 = 不修改 |
| 输入保留 | 前端 `useAiTask` 失败只置 error，不清表单、不关弹层 |
| 失败展示 | `AiError` 组件：标题 + 原因 + 建议 + 重试按钮 + 可折叠「技术详情」 |
| 异步任务状态 | 画布运行改为后台任务：排队 / 执行中 / 成功 / 失败 / 已取消，逐个节点实时更新，可取消 |

### B. 数据一致性

| 项 | 做法 |
|---|---|
| 幂等 | `Idempotency-Key` 请求头 + `main.py` http 中间件（非 GET、仅缓存 2xx），重复提交回放首次响应 |
| 前端防重 | `post(..., { idem })` 自动带 key，并对飞行中同 key 请求复用 Promise；按钮 loading 期间禁用 |
| 不误伤同名 | key 生命周期 = 一次提交，成功后换 key；换 key 建同名记录正常放行 |
| 复盘单状态 | 后端 400 拒绝「同一条成果同时 done + missed」，并去重重复项；响应回传归一化后的结果 |
| 统计口径 | 双周汇报接口返回 `scope`（窗口起止、天数、各表实际条数、哪些表是全量/取最近 N 条），前端可展开自查 |
| 写反馈 | 成功/失败/未保存修改分别有明确提示（沿用 `lib/api.ts` 的统一反馈机制） |

### C. 界面

| 项 | 做法 |
|---|---|
| 逐字换行 | `Btn` / `Pill` / `Field` label 全部 `whitespace-nowrap`（中文无词边界，窄容器会退化成一字一行） |
| 状态不只靠颜色 | 新增 `StatusTag`：图标（✓ ! ✕ i ◌）+ 文字 + 颜色 |
| 加载失败 | 新增 `LoadError`（原因 + 重试），文献 / 论文 / 计划 / 设置 / 画布 / 首页全部接上 |
| 画布 | 真实运行状态 + 进度（n/N 节点）+ 取消按钮 + 失败节点原因列表 + 整图重跑；新增**适合视图**、左右面板**折叠**、输出**展开大窗**；卡死的孤儿 run 会被判死并提示重跑 |
| 单位与图例 | 首页四指标分别写「分 / % / 篇 / 项」；论文页字数补「字」、阻塞补「个」；图表左右轴显式写单位；热力图说明统计范围与「灰色 = 无记录」 |
| 宽屏 | 内容区保持居中定宽（不靠拉长正文填空白）；画布用折叠面板把宽度让给画布本身 |

### D. 数据保护

| 项 | 做法 |
|---|---|
| 备份 | `server/backup.py`：sqlite3 在线备份 API 生成一致快照（不是裸拷文件），非破坏性 |
| 隔离验证 | `POST /api/backup/{name}/restore {mode:"isolated"}` 恢复到临时目录并逐表计数，随时可跑 |
| 覆盖保护 | 覆盖正式库必须 `confirm=true`；覆盖前自动再打安全快照，旧库另存 `.pre-restore` |
| 迁移前备份 | `db.init_db()` 检测到待补列时先 `create_backup("pre-migrate")`（本次重启已实际触发，产出 `pre-migrate.db`） |
| 兼容迁移 | 只做 `ADD COLUMN` 加法，不删表不改列类型 |
| 密钥 | 导出、设置接口、错误详情三处均已脱敏，有测试覆盖 |
| 历史污染 | `/api/ai/suspects` 只**列出**疑似被错误文本污染的记录（本次扫描到 6 条），清理必须带 `confirm=true` + 明确条目清单，绝不自动删 |

---

## 三、修改文件

**后端（server/）**
- `llm.py`（重写）、`llm_config.py`、`main.py`、`db.py`
- `backup.py`（新增）、`routers/backup.py`（新增）、`routers/ai_guard.py`（新增）
- `routers/research.py`、`paper.py`、`plan.py`、`advisor.py`、`canvas.py`、`chat.py`、`settings.py`
- `tests/test_ai_reliability.py`（新增 20 例）、`tests/helpers.py`（新增）、`tests/conftest.py`、`test_canvas.py`、`test_chat.py`、`test_paper_plan_points.py`
- `smoke_p0.py`（新增，对运行中服务）、`smoke_cleanup.py`（新增）

**前端（web/src/）**
- `components/AiError.tsx`（新增）、`components/ui.tsx`（+StatusTag / Details / LoadError / nowrap 修复）
- `lib/api.ts`（幂等 + 飞行中复用）、`lib/hooks.ts`（+useAiTask / useIdemKey）
- `features/settings/BackupCard.tsx`（新增）、`features/settings/SuspectsCard.tsx`（新增）
- `features/canvas/NodeInspector.tsx`（输出展开 / 失败原因 / error 优先于空输出）
- `pages/`：`Ideas.tsx`、`Literature.tsx`、`Experiments.tsx`、`Advisor.tsx`、`Paper.tsx`、`Plan.tsx`、`Dashboard.tsx`、`Canvas.tsx`、`Settings.tsx`、`Chat.tsx`

---

## 四、验证结果

| 验证项 | 方式 | 结果 |
|---|---|---|
| AI 调用失败不新增成果、输入保留、可重试 | 单元测试（无 provider + 401 + 不可达端点） | ✅ 通过 |
| 错误详情不含密钥 | 单测：构造含 `sk-` 的 401 响应后 dump 整个信封 | ✅ 通过 |
| 重复提交只写一次 | 单测 + 运行中服务冒烟 | ✅ 通过（同一 id） |
| 换 key 仍可建同名记录 | 冒烟 | ✅ 通过 |
| 同一复盘成果不能同时完成/未完成 | 单测 + 冒烟 | ✅ 400 拒绝 |
| 画布失败输出不能存成果 | 单测（`output/save` 返回 409） | ✅ 通过 |
| 画布可取消、取消后不再跑后续节点 | 单测（6 个慢节点，取消后状态 = cancelled 且未跑满） | ✅ 通过 |
| 加载失败有出口 | `LoadError` 覆盖 6 个页面 + 画布加载失败重试 | ✅ 已实现 |
| 备份可在隔离环境恢复 | 单测 + 冒烟（自检 ok、560 行可读） | ✅ 通过 |
| 迁移后原数据仍可读 | 服务器实际重启触发迁移，数据完好 | ✅ 通过 |
| 按钮/标签不逐字换行 | `whitespace-nowrap` 加在原语层，全站生效 | ✅ 已改（未做像素级目检） |
| 全量回归 | `pytest server/tests` | ✅ **118 passed**（基线 105 + 新增 13；另有 20 例 P0 用例） |
| 前端编译 | `tsc --noEmit && vite build` | ✅ 通过 |
| 运行中服务冒烟 | `smoke_p0.py` 15 项 | ✅ **0 失败** |

---

## 五、未解决 / 需你确认

1. **`data/backups/` 下有 4 个 `pytest-*.db`**：是修复 `backup.py` 路径解析之前测试写进真实目录的产物（14:13 那次）。已确认修复后测试不再污染，这 4 个文件可以直接删，我没动它们。`pre-migrate.db` 是迁移前的自动备份，建议留着。
2. **视觉复核未完成**：按「网页任务只保证编译与冒烟」的约定，没做像素级目检。按钮换行问题是从原语层修的（全站生效），但个别密集工具栏在窄屏仍可能拥挤，你看到了指出来我再收。
3. **未接入真实 Dify 端点验证**：`dify:error` 分支按代码路径覆盖，没有真实 Dify 服务可连。
4. **AI 成功路径依赖真实 provider**：本机已配 provider，头脑风暴成功；失败路径全部是模拟（monkeypatch），不是真实断网。
5. **画布取消的粒度**：只能作用在「节点之间」，单个 HTTP 请求发出后拦不回来——这是后端能力的边界，已在 UI 文案里写明。

---

## 六、P1 下一阶段方案（结合现有代码）

| # | 方向 | 落点 | 依赖 |
|---|---|---|---|
| 1 | **课题归属** | `topics` 表 + `idea.topic_id / literature.topic_id`；文献多对多走 `literature_topics`；旧数据全部迁入默认课题（迁移前自动备份已就位） | 无 |
| 2 | **证据链列表** | 新表 `evidence_links(src_type, src_id, dst_type, dst_id, note)`；先在创新点/文献/实验/论文四页加「关联」区块做双向跳转，不做图谱 | #1（课题后更好用，但不强依赖） |
| 3 | **统一任务** | 抽出 `unified_tasks(source, source_id, title, due_date, status)`；导师承诺 / 周计划任务 / 论文 next_action / 实验待办都写一条，状态单向同步，避免四处各记各的 | #2 |
| 4 | **实验设计与运行分离** | `experiments` 保留设计字段（方法/基线/变量/指标），新增 `exp_runs(params_json, code_version, result_json, attachments)`；现有 `exp_results` 数据迁移进去 | 无 |
| 5 | **首页重排** | 今日三项行动 / 当前阻塞 / 临近截止 / 继续上次工作置顶，积分与热力图折叠到下方辅助区 | #3（任务统一后才有可靠来源） |
| 6 | **AI 成果采纳流程** | 新增 `ai_drafts(kind, source, content, model, provider, created_at, status)`；产出先入草稿箱，带来源与预览，编辑后采纳或放弃，默认不标「已验证」 | #2（采纳时要能挂证据） |
| 7 | **论文章节 = 主张 + 证据** | `paper_sections` 增加 `claim` 字段，并复用 #2 的 `evidence_links` 挂证据；字数进度与阶段进度拆成两条独立进度条 | #2 |

建议顺序：**1 → 3 → 5**（数据模型与首页，收益最直接），再 2 → 6 → 7，最后 4。
