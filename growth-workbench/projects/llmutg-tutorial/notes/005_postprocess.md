# 阶段 5 · 实验数据后处理（Data Post-processing）

> 目标：把原始跑批日志变成**可信、可复现、带统计检验**的图表/表格。
> 这一阶段的产出 = 论文第 6 章 Data Post-processing + 第 7 章 Results 的素材。

## 在工作台里去哪做
- **数据分析工作室** `/api/workspace/analysis`：上传 CSV→`/analysis/upload`，跑模板 `/analysis/run`（`describe / compare / correlate`）。
- **代码运行** `/api/workspace/code/run`：跑你自己的 Python（pandas/scipy）做 bootstrap / Wilcoxon。
- 产物直出 `/api/workspace/artifact`。

## 固定后处理流水线（写进论文 §6）
1. **清洗**：丢弃超时模块，按内容哈希去重相同测试产物；
2. **异常值**：逐模块覆盖率在 1/99 分位 winsorize 后再聚合；
3. **统计检验**：中位数 + bootstrap 95% CI（1000 次重采样），`C`/`V` 用配对 Wilcoxon；
4. **效应量**：相对 `codamosa` 报 Cliff's δ；
5. **边界声明**：每张图/表标注数值是 **measured** 还是 **illustrative/simulated**。

## 示例：上传数据并跑描述统计
```bash
# 先把 CSV 用 multipart 上传
curl -b "wb_session=$TOK" -X POST http://127.0.0.1:8000/api/workspace/analysis/upload \
  -F "file=@sources/results_illustrative.csv"
curl -b "wb_session=$TOK" -X POST http://127.0.0.1:8000/api/workspace/analysis/run \
  -H 'Content-Type: application/json' -d '{"name":"results_illustrative.csv","template":"describe"}'
```

## 本教程已做好的真实资产
- `sources/results_illustrative.csv`：第 7 章表 1 的占位数据（明确 illustrative）。
- 流水线已在论文 §6 写成文；**真实日志请替换该 CSV 后重跑**。

## 硬规则（必读）
- 凡标注 `illustrative` 的数字**不得**写进结论；
- 真实/模拟数据边界必须在文中显式声明（论文 §6.5 + 图表 caption）。
