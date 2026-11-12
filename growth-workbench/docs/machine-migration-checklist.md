# 换电脑部署清单（2026-11-13）

新机器上按顺序执行，即可完整恢复科研工作台 + 全部依赖数据。

## 1. 主仓库（代码 + 运行时数据）

```bash
git clone https://github.com/GW19ddd/ResearchPlatform.git
```

- 已包含：`growth-workbench/` 全部代码、`data/workbench.db`（主数据库，含账号）、
  `data/paperfeed_figs/`、`data/workspace/`
- 后端启动：`python -m uvicorn server.main:app --port 8000`（或双击 `bin/launch.vbs`）
- 注意：`server/skills/github/` 按 .gitignore 不入库，首次需要在应用内
  「设置 → 技能库 → 克隆仓库」重新拉取。

## 2. 绘图工作室 · 参考画廊（AgentFigureGallery）

画廊不走 `data/`，是独立仓库，默认读本机路径：

```
D:/01-App/06_Academic/AgentFigureGallery   （环境变量 AGENT_FIGURE_GALLERY_ROOT 可覆盖）
```

已推送（含偏好与全部参考会话 outputs/reference_sessions）：

```bash
git clone https://github.com/GW19ddd/AgentFigureGallery.git D:/01-App/06_Academic/AgentFigureGallery
```

若克隆到别的路径，需设置环境变量 `AGENT_FIGURE_GALLERY_ROOT` 指向该目录后重启后端。

## 3. Gloss（论文精读，可选模块）

默认读 `D:\03-Codes\gloss`（设置里 gloss.dir / gloss.port 可覆盖）：

```bash
git clone https://github.com/GW19ddd/Gloss.git D:/03-Codes/gloss
```

## 4. 本机安装类（无法 git 同步）

| 依赖 | 说明 |
| --- | --- |
| Python venv | 按原机重建（pandas/matplotlib/scipy/openpyxl） |
| MiKTeX / TeX Live | 装 TeX 后在论文工作室设置里填 bin 目录（后端会自动探测常见路径） |
| Node.js | 前端构建用 |
| Zotero PDF 目录 | 换机后在文献抽屉设置里重填（原指向本机 Zotero storage） |

## 5. 推送注意事项（本机经验）

- 环境变量里有代理（127.0.0.1:51291），git 推送前先清掉：
  `http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= git push ...`
- 若 git-credential-manager 卡死（无输出挂起），改用 gh 提供凭据：
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main`
