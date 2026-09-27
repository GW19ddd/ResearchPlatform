# 科研画布可行性验证报告

## 1. 健康检查

```json
{'name': '科研一站式工作台', 'docs': '/docs', 'status': 'ok'}
```
- PASS · 服务健康

## 2. 建一张空画布

canvas id = `16`

## 3. 创作者自搭流水线：输入 → 自定义指令节点 → 输出

关键字：`ask` 节点是 `type=prompt`，**没有任何 skill_id**，system 与 prompt 全部由使用者自己写，只通过 `{{upstream}}` 接上游。
- PASS · 3 个自建节点落库

## 4. 运行整张画布（真实 LLM 调用）

- PASS · 运行接口返回 200
- PASS · 返回了逐节点结果

| 节点 | 类型 | 耗时 | 输出前 60 字 |
|---|---|---|---|
| `src` | input | 0ms | 课题：在 OpenFOAM 2406 中开发带 Skill 机制的 LLM 智能体，并用自研 OF-FaultBench… |
| `ask` | prompt | 953ms | 结论：LLM 智能体在 F1 边界语法故障上完全失效，且诊断正确率为零，说明瓶颈在故障定位而非修复生成。   动作：两周… |
| `out` | output | 0ms | ## 画布产出 【我的分析指令】 结论：LLM 智能体在 F1 边界语法故障上完全失效，且诊断正确率为零，说明瓶颈在故障… |

## 5. 运行证据：provider / model / token


| 节点 | provider | model | tokens_in | tokens_out | 耗时 |
|---|---|---|---|---|---|
| `src` | — | — | 0 | 0 | 0ms |
| `ask` | DeepSeek | deepseek-chat | 169 | 68 | 953ms |
| `out` | — | — | 0 | 0 | 0ms |
- PASS · 自定义节点确实调用了模型（provider 非空）
- PASS · 上游文本进了 prompt、回答有 token 计数

## 6. 最终产出正文

```
## 画布产出
【我的分析指令】
结论：LLM 智能体在 F1 边界语法故障上完全失效，且诊断正确率为零，说明瓶颈在故障定位而非修复生成。  
动作：两周内对 24 个 F1 样本做人工诊断标注，对比 LLM 诊断输出，定位是解析器缺陷还是提示缺失。
```
- PASS · 输出节点汇总到了真内容

## 7. 存为模板 → 用模板一键复刻

save-as-template → `{'key': 'u1', 'name': '我的分析流水线', 'node_count': 3}`
- PASS · 拿到用户模板 key
复刻节点：`[('ask', 'prompt'), ('out', 'output'), ('src', 'input')]`
复刻连线：`[('src', 'ask'), ('ask', 'out')]`
- PASS · 节点全量还原
复刻出的 ask.prompt = `'下面是实验结果。请指出其中最有论文价值的一个结论，并给出一个可以在两周内做完的验证动作。\n要求：不超过 120 字，先结论后动作。\n\n{{upstream}}'`
- PASS · 自定义指令原文逐字还原（{{upstream}} 占位符没丢）
- PASS · 自定义 system 提示词也一并还原

## 8. 单节点重跑（只跑 ask，复用上游缓存）

本次实际执行的节点：`['ask']`
- PASS · 增量运行只跑了目标节点，没有重跑 input

## 9. 清理

- clone: 200 · canvas: 200 · template: 200

## 结论

**PASS** — 画布全链路可跑通：使用者自己写的指令节点被真实执行，产出由 DeepSeek 生成，可存为模板并一键复刻，支持单节点增量重跑。
