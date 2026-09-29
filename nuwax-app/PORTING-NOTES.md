# 移植说明：从 FastAPI 全栈 → 女娲智能体 OS 前端应用

本目录是 [growth-workbench](../growth-workbench) 的**平台移植版**，用于参加
2026 年四川省大学生"智能体+"大赛（初赛要求作品基于女娲智能体 OS 开发并提交可访问的
智能体作品链接）。

原项目是 **React 前端 + FastAPI/SQLite 后端**的本地全栈应用，而比赛平台
只托管前端静态资源、没有 Python 运行时，因此后端能力被整体替换。

## 架构替换对照

| 原能力 | 位置 | 新实现 |
|---|---|---|
| SQLite 26 张表 | `server/db.py` | `src/lib/db.ts` —— localStorage 存储层，保留自增 id / DEFAULT / 级联删除语义 |
| FastAPI 146 个接口 | `server/routers/*.py` | `src/lib/api/*.ts` —— 前端路由表，前端实际调用的 124 个接口全部实现 |
| 服务端 llm.py 调模型 | `server/llm.py` | `src/lib/llm.ts` —— 浏览器直连 provider（DeepSeek 已确认返回 CORS 头） |
| 画布拓扑执行引擎 | `server/routers/canvas.py` | `src/lib/api/canvas.ts` —— 前端异步执行 + 页面轮询，保留上游注入与单节点重跑缓存 |
| 15 个学术 skill | `server/skills/registry.json` | `src/lib/skills.ts` —— prompt 逐字保留 |
| 3 张画布模板 | `server/canvas_templates.py` | `src/lib/canvas-templates.ts` |
| 建库种子 + 演示数据 | `server/db.py` / `server/seed_demo.py` | `src/lib/seed.ts` —— 首次进入自动灌入 |

## 适配平台模版的改动

- `BrowserRouter` → **`HashRouter`**（平台以静态资源托管，不支持 server rewrite）
- pdfjs-dist 改用 **legacy 构建**（`pdfjs-dist/legacy/build/pdf.mjs`），
  标准构建含 top-level await，在 Vite 默认构建目标下会直接构建失败
- `esbuild` / `optimizeDeps.esbuildOptions` / `build` 三处目标统一为 `es2022`
- 合并依赖（`@xyflow/react`、`recharts`、`react-markdown`、`remark-gfm`、`pdfjs-dist`）
  与 Tailwind / ESLint / tsconfig 配置

## 浏览器端无法实现、已做优雅降级的功能

以下能力依赖服务端或本地进程，浏览器物理上做不到，因此保留接口形状 + 明确提示，
**不抛错、不崩溃**（实现见 `src/lib/api/misc.ts`）：

- Zotero 文献同步（需要服务端代理与密钥）
- Gloss 本地 PDF 阅读器（需要拉起本地 Python 服务）
- GitHub skill 克隆（需要服务端 git 能力）
- SQLite 备份 / 恢复（存储已改为 localStorage，不再需要）
- 画布「AI 自动编排」（不影响手动拖拽与 3 张预置模板）

## ⚠️ 运行前必须配置 LLM API Key

AI 能力走**使用自带 Key**（比赛平台 token 额度不足以支撑演示）。默认 provider 为
DeepSeek，`api_key` 初始为空。

- 配置入口：应用内「设置」页 → LLM provider → 填 API Key → 「测试连接」
- 未配置时 AI 功能会返回明确的「未配置 API Key」提示并给出操作指引，不会崩溃

## 本地运行

```bash
pnpm install
pnpm dev        # 开发
pnpm check      # 类型检查 + ESLint（提交前必过）
pnpm build      # 生产构建
```

## 验证状态

- `pnpm check` / `pnpm build` 通过
- 数据层冒烟测试 31 项通过（含画布整图执行、LLM 调用、积分保护下限）
- 接口覆盖核对：前端调用的 124 个接口全部实现
- 首页 / 画布 / 创新点页浏览器实测渲染正常
