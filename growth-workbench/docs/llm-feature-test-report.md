# 大模型功能点测试报告

生成时间：2026-11-08
对象：`growth-workbench`（研流）后端全部涉及大模型调用的功能点
方式：契约层（mock）+ 真实调用层（DeepSeek 实调）双轨，**两层结果严格分开记录**

---

## 一、结论

- 盘点出 **8 个 router 下 25 个 AI 端点**（含 2 个 SSE 流式端点、2 个设置连通性端点），以及 **llm 层 6 项核心 API**。
- 契约层测试矩阵 **覆盖上述全部端点**，每个端点在「LLM 成功 / LLM 失败」两种状态下各测一次，验证 **P0 红线：失败时错误文本不当成果、不落库、不覆盖用户已有内容、SSE 不落 assistant 消息**。失败态显式解析 502 响应体，成功态断言具体成果字段 + 预期 `task` 命中。
- 真实层用用户已启用的 DeepSeek / `deepseek-chat` 实调 **10/10 通过**，含流式输出、JSON 解析、多轮对话、业务端点与画布自动编排（真实生成 7 节点 6 边，`fallback=false`）。
- 经代码审查（见第八节）补了 **2 个 Critical 覆盖缺口**（画布 `POST /api/canvas/{id}/run` 节点执行、rchat `mode=deep` 全链路），并加固断言；现矩阵 **68 passed + 2 xfailed（已知 `canvas.auto`/`canvas.chat` 失败仍 `ok:true` 偏差，以 `xfail(strict)` 显式标注，不固化成合格）**。
- 发现 **1 个产品契约偏差**（`canvas/chat` 失败仍返回 `ok: true`）、**1 个测试基建缺陷**（已修）、**2 项设计说明**。产品业务代码本次未改动。

---

## 二、真实 vs 模拟边界（显式声明）

| 层 | 文件 | 是否真实调用模型 | 副作用 / 约束 |
|---|---|---|---|
| 契约层 | `server/tests/test_llm_feature_matrix.py` | **否**。monkeypatch 替换 `llm.complete_result` / `complete_with_meta` / `complete_json_result` / `chat_result` / `stream_chat_events`；`conftest.py` 禁用全部 provider 并拦截 `httpx.AsyncClient.post/get` | 只操作临时 SQLite（`tmp_db`），跑完不留痕；零网络请求、零 token |
| 真实层 | `server/tests/live_llm_smoke.py` | **是**。读取设置页真实配置，调用已启用的 DeepSeek | 真实 token 消耗；向真实库 `llm_usage` 写用量；临时会话签出后立即撤销，**不碰 users 表**；业务端点只选不落库入口 |
| 既有基线 | `server/tests/` 其余用例 | 否 | 临时库 |

- 真实层结果落盘 `docs/llm-live-smoke.json`，`kind = REAL_LLM_CALLS`。任一失败项如实记 `ok: false` 与错误文本，**未做任何补写或美化**。
- 契约层里的 `SENTINEL_OK_` / `SENTINEL_ERR_` 是哨兵串，仅用于断言数据流向，**不是模型产出**。
- 本报告中所有「模型回复」「生成 7 节点」等表述，凡带「真实」字样均来自真实层；契约层结果一律称「mock 契约验证」。

---

## 三、大模型功能点清单

| 模块 | 端点 | LLM 入口 | 失败时契约 | 是否落库 |
|---|---|---|---|---|
| research | `POST /api/ideas/brainstorm` | `complete_json_result` + `complete_result` | `ok:false`，`candidates=[]` | 否 |
| research | `POST /api/ideas/{id}/review` | `complete_result` | `ok:false`，不写 `idea_reviews` | 是（成功时） |
| research | `POST /api/literature/keywords` | `complete_result` | `ok:false` | 否 |
| research | `POST /api/literature/{id}/digest` | `complete_json_result` + `complete_result` | `ok:false`，不写 `lit_notes` | 是（成功时） |
| research | `POST /api/experiments/{id}/analysis` | `complete_result` | `ok:false`，不覆盖 `conclusion` | 是（成功时） |
| research | `POST /api/experiments/{id}/failures` | `complete_result` | `ok:false` | 否 |
| research | `POST /api/experiments/{id}/design-review` | `complete_result` | `ok:false` | 否 |
| research | `POST /api/experiments/compare` | `complete_result` | `ok:false` | 否 |
| paper | `POST /api/paper/stages/{id}/unblock` | `complete_result` | `ok:false` | 否 |
| paper | `POST /api/paper/stages/{id}/diagnose` | `complete_result` | `ok:false` | 否 |
| paper | `POST /api/paper/sections/{id}/outline` | `complete_result` | `ok:false` | 否 |
| plan | `GET /api/plan/biweekly` | `complete_result` | `ok:false`，仍返回 `scope` 统计口径 | 否 |
| advisor | `POST /api/advisor/draft` | `complete_result` | `ok:false` | 否 |
| advisor | `POST /api/advisor/extract` | `complete_result` + 自解析 | `ok:false`（空输入 / 解析失败） | 否 |
| chat | `POST /api/chat/sessions/{id}/messages` | `chat_result` | `ok:false`，不写 assistant 消息 | 是（成功时） |
| chat | `POST /api/chat/sessions/{id}/messages/stream` | `stream_chat_events` | SSE 仅 `error` 事件，不落库 | 是（成功时） |
| chat | `POST /api/chat/quick` | `chat_result` | 直接返回失败信封 | 否 |
| rchat | `POST /api/rchat/sessions/{id}/chat` | `complete_with_meta` | HTTP 502，不写 assistant 消息 | 是（成功时） |
| rchat | `POST /api/rchat/sessions/{id}/chat/stream` | `complete_with_meta` | SSE `error` 事件，不落库 | 是（成功时） |
| canvas | `POST /api/canvas/skills/{id}/run` | `complete_with_meta` | `ok:false`，`output=""` | 否 |
| canvas | `POST /api/canvas/auto` | `complete_with_meta` | 保底编排 + `fallback:true` + rationale 标注 | `save=true` 时 |
| canvas | `POST /api/canvas/{id}/chat` | `complete_with_meta` | reply 文案标注失败（**但 `ok` 仍为 true，见发现 1**） | 是（成功时） |
| canvas | `POST /api/canvas/{id}/run` | `_run_llm` → `complete_result` | 节点 `ok:false`，输出不可保存 | 是（节点输出） |
| settings | `POST /api/settings/llm/test` | `llm.test_connection` | `ok:false` | 否 |
| settings | `POST /api/settings/llm/models` | `llm.list_models` | `ok:false`，`models=[]` | 否 |

**llm 层核心 API**：`complete_result`、`complete_json_result`、`chat_result`、`complete_with_meta`（别名）、`stream_chat_events`、`test_connection` / `list_models` / `redact`。

**明确排除（不调用大模型）**：`/api/litsearch/discover`（SSE 阶段进度，走 OpenAlex）、`/api/literature/graph` 与 `/literature/{id}/expand`（本地 DB + OpenAlex）、`/api/gloss/*`（本地馆藏）、`/api/ai/suspects`（只识别历史污染文本，不调模型）。这些属于文献检索 / 关联图链路，不计入本次范围。

---

## 四、执行结果

| 项 | 命令 | 结果 |
|---|---|---|
| 既有基线（改动前） | `python _run_pytest.py` | **122 passed**（273.57s） |
| 新增矩阵（首跑） | `python _run_pytest.py server/tests/test_llm_feature_matrix.py` | 53 passed / 2 failed —— 均为测试代码自身缺陷，非产品问题 |
| 新增矩阵（修复后首轮） | 同上 | **55 passed**（126.84s） |
| 真实调用冒烟 | `python server/tests/live_llm_smoke.py` | **10/10 通过** |
| 全量回归（审查前） | `python _run_pytest.py` | **180 passed**（441.01s，见 `rpt-final.txt`） |
| 新增矩阵（审查后，补齐 C1/C2 + 断言加固） | `python _run_pytest.py server/tests/test_llm_feature_matrix.py` | **68 passed + 2 xfailed**（115.68s，见 `rpt-matrix3.txt`） |
| 全量回归（审查后） | `python _run_pytest.py` | **190 passed + 2 xfailed**（373.72s，RC=0，见 `rpt-final2.txt`） |

首次 2 个失败的原因与修复：
1. `_dispatch_with_recovery` 替身少返回一个值（真实返回 4 元组，替身返回 3 元组）→ 已修为 `(内容, tin, tout, mode)`；
2. `conftest.py` 清理列表缺 `rchat_messages` / `rchat_sessions` / `chat_findings`，上一用例残留 assistant 消息污染下一用例 → 已补 3 张表。

审查后补的 3 个失败（已修复）：`research.brainstorm` / `chat.quick` 的成功断言误用了 `result` / `reply` 空字段（矩阵册跑时用的仍是旧 `ok_probe`，编辑未重跑即被 429 打断）；`canvas.skills/{id}/run` 的 LLM `task` 实为 `skill:<id>` 而非 `canvas:<id>`。三处均在重跑后通过。

### 真实层 10 项明细（均为真实 DeepSeek 调用）

| 检查 | 结果 | 耗时 | 关键证据 |
|---|---|---|---|
| `settings.test_connection` | 通过 | 1192ms | 模型回复「可用」 |
| `settings.list_models` | 通过 | 322ms | 返回 2 个模型 |
| `complete_result(fast)` | 通过 | 940ms | `deepseek-chat`，78/32 tokens |
| `complete_result(reason)` | 通过 | 1076ms | 仍为 `deepseek-chat`，`same_model_as_fast=true`，`degraded=false` → FORCE_FAST 生效 |
| `complete_json_result` | 通过 | 1099ms | 解析为 `dict` |
| `chat_result` | 通过 | 1111ms | 多轮记忆正确返回「42」 |
| `stream_chat_events` | 通过 | 1311ms | 5 个 `delta` + 1 个 `meta`，无 `error` |
| `redact` | 通过 | 3ms | 密钥替换为 `***` |
| `POST /api/chat/quick` | 通过 | 931ms | 真实回复「可用」，HTTP 200 |
| `POST /api/canvas/auto (save=false)` | 通过 | 4218ms | **7 节点 / 6 边，`fallback=false`，`dropped=0`** —— 真实 AI 编排成功，非保底方案 |

---

## 五、发现的问题

### Important 1 — `canvas/chat` 在 LLM 失败时仍返回 `ok: true`（产品代码，本次未改）

`server/routers/canvas.py:1102-1110`：`api_canvas_chat` 在 `env.ok=False` 时把错误写进 `reply`（「（操作失败：…）」），但响应体固定 `"ok": True`。其余 AI 端点失败时一律 `ok:false`。前端若按 `ok` 判断一次对话是否成功，会把模型故障当成正常回复。

建议：失败时改为 `ok: false` 并附 `error` 字段（`reply` 文案可保留）。本次测试用 `_assert_chat_failed_reply` 把现状固定下来，**未擅自修改产品代码**。

### Important 2 — 测试基建：清理列表缺表（已修）

`server/tests/conftest.py` 的 `_clean_tables` 未包含 `rchat_messages` / `rchat_sessions` / `chat_findings`，RChat 用例之间数据残留，导致「失败不落库」断言误判（首次运行 `rchat.report-fail` 因此失败）。本次补入 3 张表；这是测试隔离缺陷，不是产品缺陷。

### Minor 1 — rchat 的 deep / report 模式不记录 provider / model

`server/routers/rchat.py:425` 中 `env: dict = {}`，deep（`:431`）与 report（`:436`）分支不回填 LLM 信封，`_store_assistant`（`:406`）落库的 `provider` / `model` 为空字符串。auto 模式正常。建议把 `_deep_search` / `_write_report` 的信封透传下来，便于运行证据溯源。

### Minor 2 — `FORCE_FAST` 使自愈降级分支休眠（设计说明，非缺陷）

`server/llm.py:365` `FORCE_FAST = True`，所有调用点的 `mode` 被 `_resolve_mode` 归一化为 `fast`，因此 `_dispatch_with_recovery`（`:320-357`）里「reason → fast 降级」与 `env["degraded"]` 标记恒不触发。这是用户明确要求的「全站 AI 调用统一 fast」的直接后果；恢复按任务分派只需把开关改回 `False`。`test_reason_empty_output_degrades_to_fast` 临时关闭开关，验证了该自愈逻辑本身完好（翻倍预算 → 降级 → `degraded=true` → model 如实变）。

### 说明 — 模型列表与配置名不一致

真实 `/models` 返回 `deepseek-flash, deepseek-v4-pro`，而配置里 `model_fast = deepseek-chat`。配置可手填、不影响调用，属正常；仅提示模型名可能已更新。

---

## 六、建议

1. 修 `canvas/chat` 的 `ok` 字段（最小 diff，一行 + 一个 error 字段）。
2. 让 rchat deep / report 透传 LLM 信封，补齐运行证据。
3. `live_llm_smoke.py` 保持独立手动执行，不并入 pytest 默认收集（避免联网、费用与 CI 不稳定）；可作为上线前 / 换 provider 后的验收清单。
4. 后续新增 AI 端点时，`test_matrix_covers_every_llm_endpoint_and_task`（端点级 + `task` 级双维度护栏）会先失败，提醒同步补用例：源码里新增的 `task="..."` 字面量必须被某个测试的 `expect_task` 声明、盘点出的端点必须出现在覆盖集合、且覆盖集合里的 URL 必须真实存在于源码，三道护栏缺一不可。

---

## 七、复现

```bash
# 契约层（不联网、不花钱）
cd growth-workbench
python _run_pytest.py server/tests/test_llm_feature_matrix.py

# 真实层（会产生真实 token）
python server/tests/live_llm_smoke.py

# 全量回归
python _run_pytest.py
```

产物：`docs/llm-live-smoke.json`（真实调用结果）、`../rpt-baseline.txt` / `../rpt-matrix.txt` / `../rpt-live.txt` / `../rpt-final.txt`（各次运行日志）。

---

## 八、代码审查反馈与处理

按 `requesting-code-review` 技能流程，矩阵与报告产出后派遣代码审查子代理复验，结论为 **「修完再合」**。逐条处理如下：

### Critical

- **C1 — 画布节点执行 `POST /api/canvas/{id}/run` 零覆盖** → 已补 `test_canvas_run_endpoint_contract`：端点立刻回 `run_id`，后台 `_exec_node → _run_llm` 跑完，轮询 `GET /api/canvas/runs/{id}` 校验 `canvas_node_outputs`——成功态 `status=done`、输出含哨兵、`provider/model` 如实；失败态 `output_text` 恒为空、`status=error`、`error_json` 有说明，绝不把错误文本当成果。
- **C2 — rchat `mode=deep` 整条链路零覆盖** → 已补 `test_rchat_deep_json_contract` 与 `test_rchat_deep_stream_contract`：mock `_oa_search` 返回确定假 OpenAlex work（不触网），验证 `rchat:qgen` + `rchat:deep` 两个 LLM 调用点、`stage`/`papers` SSE 事件；成功态把检索命中的真实元数据写入 `literature` 并落 assistant 消息，失败态 502、不落 assistant 消息、不把错误文本当成果。

### Important

- **I1 — 覆盖自检只到 router 文件级** → 升级为 `test_matrix_covers_every_llm_endpoint_and_task`：源码 `task="..."` 字面量必须被测试声明、盘点端点必须全覆盖、覆盖集合 URL 必须真实存在，三道护栏。
- **I2 — `canvas.auto`/`canvas.chat` 失败态把 `ok:true` 偏差固化成合格断言** → 主矩阵不再断言 `ok` 字段，改为 `xfail(strict=True)` 的 `test_known_deviation_canvas_failure_ok_flag` 显式标注已知偏差；产品修好后该用例会 XPASS(strict) 失败，提醒删除标记并收紧。
- **I3 — 失败态只看 `ERR` 哨兵、不看 502 响应体** → 失败态显式 `r.json()` 解析，断言 `ok` 不为 True（非 200 时）、`detail` 有说明、成果字段无哨兵、错误文案不泄露到非错误字段。
- **I4 — 成功态断言过弱、替身不记录 `task`** → 替身记录 `(入口, task)` 与调用次数，Cases 增加 `expect_task` 与 `ok_probe`，成功态断言具体成果字段 + 预期 task 命中；补 `chat-title` 自动标题失败降级用例。
- **I5 — 报告结论未完成且「数字待回填」、覆盖表述不实** → 本报告已回填矩阵 68 passed + 2 xfailed、全量回归数字待 `rpt-final2.txt` 生成后复核；覆盖表述改为如实清单（含 C1/C2 新增项与 2 个 xfailed 已知偏差）。

### Minor

- `conftest.py` 清理列表补 `lit_edges` 等表，避免 deep 链路落库残留污染。
- rchat deep / report 不记录 `provider`/`model`（见第五节 Important 3），属产品侧运行证据溯源建议，未改产品代码。

审查复验：修复后矩阵 **68 passed + 2 xfailed，0 failed**；全量回归 **190 passed + 2 xfailed**（373.72s，RC=0，见 `rpt-final2.txt`）。

### 二次复验结论（审查子代理）

**可以合并吗？—— 是。** 上一轮 C1/C2 与 I1–I4 反馈全部落实；矩阵实跑 **68 passed + 2 xfailed、RC=0**，端点级三道护栏经源码 `task="..."` 字面量与 `@router.xxx` 路径核对自洽。无 Critical / Important 残留。

**Minor（已记录，不阻塞，留待后续迭代）**：
- M1：覆盖自检正则抓不到 `task=f"skill:{skill_id}"` 这类动态 task，未来新增动态 task 端点可能静默放行；当前由 `test_canvas_skill_run_hits_llm` 单独兜底。
- M2：`real_endpoints` 仅识别字面量 `@router.xxx("path")`，计算路径 / 非字面 prefix 注册会逃出该护栏（当前验证通过，属脆弱假设）。
- M3：约半数 Case 未写显式 `ok_probe`，成功态回退到「全字段扫描」，只要任意字段混入哨兵即过；建议给「成果位置固定」的端点补显式 `ok_probe`。

**未亲验项说明**：复验子代理只重跑了矩阵（68+2），未独立重跑全量回归；全量 **190 passed + 2 xfailed（RC=0）** 由主流程在此前已实跑并落盘 `rpt-final2.txt`，数字有实证。
