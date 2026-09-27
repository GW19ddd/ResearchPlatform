# 科研一站式工作台

面向博士生的**科研全流程**工具：找创新点 → 查文献 → 做实验 → 写论文 → 汇报复盘 → 积分激励。
本地运行，数据存 SQLite 单文件，可一键导出 Markdown。

不是 All-in-One，是一条覆盖科研主线的流水线。

---

## 快速开始

**推荐：一键启动（单进程）**

```powershell
.\dev.ps1
```

脚本会自动构建前端（首次）、停掉旧进程、以**独立进程**启动服务。启动后只有一个地址：

- 工作台：<http://localhost:8000>（前端由 FastAPI 直接托管）
- 接口文档：<http://localhost:8000/docs>
- 停止：任务管理器结束 python.exe，或 `Get-NetTCPConnection -LocalPort 8000 | % { Stop-Process -Id $_.OwningProcess -Force }`

> 前端改动后需要 `.\dev.ps1 -Rebuild` 重新构建。后端改动重启服务即可。

**开发模式（前端热更新，两个终端）**

**终端 1 · 后端**

```powershell
cd server
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

**终端 2 · 前端**

```powershell
cd web
npm install
npm run dev
```

浏览器打开 <http://localhost:5173>，后端接口文档 <http://localhost:8000/docs>。

> 一键启动：`.\dev.ps1`（默认使用打包好的解释器路径；如需指定，改脚本顶部变量或设 `WORKBENCH_PYTHON` / `WORKBENCH_NPM`）。

---

## 八个页面分别干什么

| 页面 | 在流水线的位置 | 解决什么 |
|---|---|---|
| **今日** | 总览 | 一眼看到：积分、论文进度、逾期承诺、卡住没有 |
| **创新点** | 起点 | 捕获想法；四维打分；AI 头脑风暴；让 AI 扮演审稿人/导师/同行狠狠质疑 |
| **文献** | 调研 | 录入与管理；AI 生成可直接粘去检索的布尔检索式；AI 生成结构化阅读笔记；**相关工作对比矩阵** |
| **实验** | 验证 | 记录假设与设计；逐 case 记录结果；成功率统计；AI 分析失败根因 |
| **论文** | 产出 | 七阶段流水线 + 阻塞计时；AI 解锁方案；章节字数进度 |
| **计划复盘** | 节奏 | 周成果（只写 3 条）+ 任务 + 周复盘五问 + 一键生成双周组会汇报 |
| **导师** | 沟通 | 承诺档案与逾期提醒；AI 生成三版话术（简洁/详细/低姿态） |
| **积分** | 激励 | 双向加减分；押注；奖励兑换；规则可调 |
| **设置** | 后端配置 | 多 LLM provider（DeepSeek / Codex / Ollama / 本地 Qwen / 任意兼容端点），可按任务分派 |
| **科研画布** | 编排 | 科研版 Dify：把 skill 拖成节点、连线成流水线，逐个跑、看输出、存回其他模块 |

---

## 科研画布（/canvas）

**节点 = skill，边 = 数据流，画布 = 可保存的流水线。**

- 左侧 8 类共 15 个学术 skill，拖进画布即可用
- 连线后上游输出自动注入下游的 `{{upstream}}`，默认截断 4000 字（节点里可调）
- 点节点 → 填输入槽 → 运行；可整图运行，也可只跑单个节点（祖先节点有缓存输出就复用）
- 每次运行的输入/输出/所用模型/耗时全部留痕
- 输出可一键存回「创新点」或「文献」模块

**三张预置模板**：选题→综述→论证 / 草稿→润色→模拟评审 / 论文→组会汇报

**自定义 skill**：往 `server/skills/custom/` 放一个 JSON（字段同 `server/skills/registry.json`），或走 `POST /api/canvas/skills`。

### 把 Dify 接进来

**地址与 Key 都在「设置」页填一次，画布的 Dify 节点只管选应用。**

设置页 → Dify 接入卡片：

1. 勾「启用 Dify 节点」，**API 地址**填 `http://localhost/v1`
2. 点「测试连接」确认地址通不通
3. 点「新增应用」：填名称、选类型（工作流 / 对话应用）、填这个应用的 API Key
   - Key 在 Dify 里拿：打开应用 → 发布 → 右上角「访问 API」→ 创建密钥（形如 `app-xxxx`）
4. 点「测试这个应用」——它会真的调 `GET /v1/parameters`，顺带把这个 workflow 需要哪些入参列出来
5. 保存

画布里加一个 Dify 节点，下拉选应用，填 inputs（JSON，值里写 `{{upstream}}` 就能接上游输出）。

前置条件（Dify 本体）：

```powershell
cd D:\03-Codes\dify-main\docker
docker compose up -d          # 首次会拉镜像，需要几分钟
```

> 本机实测：Dify 的 nginx 发布在 80 端口，所以 `http://localhost/v1` 可用；`http://localhost:5001/v1` 直连 API 容器不通（Windows 侧未发布该端口）。没配 Key 时节点返回「去设置页配置」提示，不会崩。

没起 Dify 也不影响其他节点：该节点会返回一段「未配置」提示而不是报错。

---

## 几个刻意的设计

**1. 卡住会被看见。**
论文阶段一旦标为「阻塞」，首页立刻出现红色横幅并显示「已卡 N 天」。博士论文最常见的死法是卡住了但没人知道，包括你自己。

**2. 相关工作矩阵填满，Related Work 就写完了。**
文献页底部那张表：横轴是你自定义的对比维度（是否开源、评测集、要不要人工、能不能处理边界语法…），纵轴是论文。填满即可照着写。

**3. 周成果只写 3 条，且必须是可交付物。**
写「推进研究」等于没写。系统只认「完成 F2 组数据整理」这种能验证的东西。

**4. 积分有保护下限。**
周净分低于下限（默认 −100）后不再继续扣，避免连崩两周直接弃用整个系统。

**5. 导师模块优先级按见效速度排，不按难度排。**
「记承诺」零 AI 依赖但解决最高频的痛——组会当场听懂、回去就忘。话术生成第二，模拟对话（第二版）最后。

---

## LLM 配置（设置页，不用改代码）

打开侧栏 **设置**，四个预置 provider 已经在那儿了，改完点保存立即生效，不用重启：

| provider | 类型 | 说明 |
|---|---|---|
| DeepSeek | OpenAI 兼容 | `deepseek-chat` 跑轻量任务，`deepseek-reasoner` 跑推理 |
| OpenAI / Codex | Responses API | Codex / GPT 系列走 `/responses`；若用 ChatGPT 账号登录的 Codex，需要一个把它转成标准端点的本地代理 |
| Ollama（本机） | Ollama 原生 | 不需要 key，默认 `http://localhost:11434`，可点「拉取模型列表」自动填模型名 |
| 本地 Qwen（Tailscale） | OpenAI 兼容 | `http://gw-computer.tailcb2155.ts.net/v1`，零成本、数据不出内网 |

**想加别的中转站**：点「新增 provider」，类型选 `OpenAI 兼容`，填 base_url + key 即可。

**按任务分派**（这是最实用的一个）：每个 provider 可以设「用途」——
把 Ollama 设成「仅轻量任务」，DeepSeek 设成「仅推理任务」，系统会自动按任务类型选路。轻量任务（话术、文献笔记、归类）走本地不花钱，重推理（头脑风暴、实验分析、双周汇总）才走远端。

每个 provider 都有**测试连接**和**拉取模型列表**两个按钮，配完先测一下再保存。

环境变量（`DEEPSEEK_API_KEY` 等）现在只作为首次种子值，之后以设置页为准。设置里没配 key 时，AI 功能会返回明确提示而不是崩溃。

---

## 数据与备份

- 数据库：`data/workbench.db`（SQLite 单文件）
- 一键导出：`GET /api/export/all` 返回全库 Markdown，同时写入 `export/`
- 备份：把 `data/` 目录丢进 git 就行

---

## 目录结构

```
growth-workbench/
├── server/
│   ├── main.py              FastAPI 入口
│   ├── db.py                建表 + 种子 + 查询助手
│   ├── config.py            路径、LLM、默认积分规则
│   ├── llm.py               provider 抽象（DeepSeek / 本地 Qwen）
│   ├── points_core.py       积分引擎（含周净分保护下限）
│   ├── skill_registry.py    skill 注册表（内置 + custom 目录）
│   ├── skills/
│   │   ├── registry.json    15 个内置学术 skill 的 prompt 模板
│   │   └── custom/          你自己加的 skill（放 JSON 即可）
│   └── routers/
│       ├── canvas.py        科研画布：CRUD + 拓扑执行引擎 + Dify/HTTP 工具节点
│       ├── research.py      创新点 / 文献 / 实验
│       ├── paper.py         论文阶段与章节
│       ├── plan.py          周计划 / 打卡 / 复盘 / 双周汇总
│       ├── advisor.py       导师承诺 / 话术
│       ├── points.py        积分 / 奖励 / 押注
│       ├── dashboard.py     首页汇总 / 导出
│       └── settings.py      LLM provider 配置 / 测试 / 模型列表
├── web/
│   └── src/pages/           十个页面
├── data/                    SQLite（自动生成）
└── export/                  导出目录
```

---

## 下一步建议

先别急着加功能，用它跑两周真实数据，然后调两个参数：

1. **积分数值**（积分页可直接改）——拍脑袋定的一定不准
2. **打卡字段**——现在只有睡眠/运动/专注/心情，够不够只有你知道

第二版预留：健康趋势（与产出做相关性）、文献模块对接已连接的 Zotero MCP、人际与财务。
