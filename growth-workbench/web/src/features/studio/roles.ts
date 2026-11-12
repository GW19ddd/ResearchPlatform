import type { IconName } from '../../components/Icon'

/**
 * 工作台「角色带」：8 个能力入口，不是 8 个自治智能体。
 *
 * 口径（见 docs/workbench-architecture-2026-11-11.md）：不新建后端 agent，
 * 每个角色只把「一句话想做的事」映射到已有模块或新建的工作室页面。
 * 前 6 个是既有能力的直达入口，后 2 个（论文写作 / 科研绘图）指向 P0 新建工作室。
 */
export type StudioRole = {
  key: string
  label: string
  hint: string
  icon: IconName
  to: string
  /** true = P0 新建的能力工作室，侧栏「工具」组也会挂一份 */
  studio?: boolean
}

export const STUDIO_ROLES: StudioRole[] = [
  { key: 'lit', label: '文献调研', hint: '检索 → 入库 → 证据表', icon: 'book', to: '/literature?tab=search' },
  { key: 'deep', label: '深度检索', hint: '带引用的研究报告', icon: 'scan', to: '/research' },
  { key: 'paper', label: '论文写作', hint: '.tex 编辑与 LaTeX 编译', icon: 'quill', to: '/studio/paper', studio: true },
  { key: 'figure', label: '科研绘图', hint: '图表 spec 实时渲染', icon: 'chart', to: '/studio/figure', studio: true },
  { key: 'analysis', label: '数据分析', hint: 'CSV/XLSX 真实 pandas 分析', icon: 'sigma', to: '/studio/analysis', studio: true },
  { key: 'exp', label: '实验执行', hint: 'Agent 对话跑实验', icon: 'beaker', to: '/experiments' },
  { key: 'flow', label: '编排流水线', hint: '多步 AI 连成画布', icon: 'layers', to: '/canvas?tab=build' },
  { key: 'review', label: '独立评审', hint: '契约 → 四阶段门禁', icon: 'clipboardCheck', to: '/chat' },
]
