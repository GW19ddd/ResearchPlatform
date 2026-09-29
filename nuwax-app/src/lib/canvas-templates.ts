/**
 * 画布模板（Canvas Templates）数据。
 *
 * 数据来源：growth-workbench/server/canvas_templates.py 中的 BUILTIN 字典（只读源）。
 * 节点坐标、config、连线均逐字照抄，未做任何数值改动。
 *
 * 用户自定义模板存于 localStorage（键 'canvas_user_templates'），
 * 本文件只负责内置模板；用户模板由调用方读 localStorage 后自行合并。
 */

/** 画布节点 */
export interface TemplateNode {
  node_key: string
  type: string // input | skill | tool | output | prompt
  skill_id?: string | null
  title: string
  x: number
  y: number
  config: Record<string, any>
}

/** 画布连线 */
export interface TemplateEdge { source_key: string; target_key: string }

/** 一张画布模板 */
export interface CanvasTemplate {
  key: string
  name: string
  nodes: TemplateNode[]
  edges: TemplateEdge[]
  builtin: boolean
  created_at?: string
}

/** 内置的 3 张画布模板：topic / write / slides */
export const BUILTIN_TEMPLATES: Record<string, CanvasTemplate> = {
  "topic": {
    key: "topic",
    name: "选题 → 综述 → 论证",
    nodes: [
      {
        node_key: "n1",
        type: "input",
        skill_id: null,
        title: "研究方向",
        x: 40,
        y: 120,
        config: {"text": "在 OpenFOAM 2406 中开发具备 Skill 机制的 LLM 智能体，并构建故障基准评测其修复能力"},
      },
      {
        node_key: "n2",
        type: "skill",
        skill_id: "academic-research-suite",
        title: "科研框架",
        x: 320,
        y: 40,
        config: {"inputs": {"constraint": "1 个月交小论文，单机，两周一次组会"}},
      },
      {
        node_key: "n3",
        type: "skill",
        skill_id: "nature-academic-search",
        title: "扩展检索",
        x: 620,
        y: 40,
        config: {"inputs": {"keywords": "LLM agent, OpenFOAM, CFD repair, fault benchmark", "venue": "ASE / FSE"}},
      },
      {
        node_key: "n4",
        type: "skill",
        skill_id: "literature-survey-skill",
        title: "综述与空白",
        x: 620,
        y: 200,
        config: {"inputs": {"known": "ChatCFD\nTerminalCFD\n（待补充）"}},
      },
      {
        node_key: "n5",
        type: "skill",
        skill_id: "paper-spine",
        title: "论证链诊断",
        x: 920,
        y: 200,
        config: {"inputs": {"motivation": "现有 LLM CFD 智能体缺乏分层评价体系", "result": "5 方法 × 15 故障样本，Rule-based 60%，LLM 方法在 F1 边界语法故障 0/24"}},
      },
      {
        node_key: "n6",
        type: "output",
        skill_id: null,
        title: "存入 Ideas",
        x: 1200,
        y: 200,
        config: {"prefix": "## 画布产出"},
      },
    ],
    edges: [
      { source_key: "n1", target_key: "n2" },
      { source_key: "n2", target_key: "n3" },
      { source_key: "n3", target_key: "n4" },
      { source_key: "n4", target_key: "n5" },
      { source_key: "n5", target_key: "n6" },
    ],
    builtin: true,
  },
  "write": {
    key: "write",
    name: "草稿 → 润色 → 模拟评审",
    nodes: [
      {
        node_key: "n1",
        type: "input",
        skill_id: null,
        title: "论文草稿",
        x: 40,
        y: 120,
        config: {"text": "（贴入你当前的草稿或要点）"},
      },
      {
        node_key: "n2",
        type: "skill",
        skill_id: "paper-writing",
        title: "主线与创新点",
        x: 320,
        y: 40,
        config: {"inputs": {"target": "短文，偏评测"}},
      },
      {
        node_key: "n3",
        type: "skill",
        skill_id: "nature-writing",
        title: "学术表达重构",
        x: 620,
        y: 40,
        config: {"inputs": {"section": "Introduction"}},
      },
      {
        node_key: "n4",
        type: "skill",
        skill_id: "nature-polishing",
        title: "润色",
        x: 620,
        y: 220,
        config: {"inputs": {"style": "顶会系统论文"}},
      },
      {
        node_key: "n5",
        type: "skill",
        skill_id: "nature-reviewer",
        title: "模拟审稿",
        x: 920,
        y: 130,
        config: {"inputs": {"venue": "FSE 2026"}},
      },
      {
        node_key: "n6",
        type: "output",
        skill_id: null,
        title: "评审结论",
        x: 1200,
        y: 130,
        config: {},
      },
    ],
    edges: [
      { source_key: "n1", target_key: "n2" },
      { source_key: "n2", target_key: "n3" },
      { source_key: "n3", target_key: "n4" },
      { source_key: "n4", target_key: "n5" },
      { source_key: "n5", target_key: "n6" },
    ],
    builtin: true,
  },
  "slides": {
    key: "slides",
    name: "论文 → 组会汇报",
    nodes: [
      {
        node_key: "n1",
        type: "input",
        skill_id: null,
        title: "本双周进展",
        x: 40,
        y: 120,
        config: {"text": "（贴入这两周做完的事与卡点）"},
      },
      {
        node_key: "n2",
        type: "skill",
        skill_id: "nature-paper2ppt",
        title: "汇报提纲",
        x: 320,
        y: 80,
        config: {"inputs": {"minutes": "15 分钟，面向导师与同门"}},
      },
      {
        node_key: "n3",
        type: "skill",
        skill_id: "presentation-skill",
        title: "幻灯片设计",
        x: 640,
        y: 80,
        config: {"inputs": {"constraint": "最多 12 页"}},
      },
      {
        node_key: "n4",
        type: "output",
        skill_id: null,
        title: "汇报材料",
        x: 940,
        y: 80,
        config: {},
      },
    ],
    edges: [
      { source_key: "n1", target_key: "n2" },
      { source_key: "n2", target_key: "n3" },
      { source_key: "n3", target_key: "n4" },
    ],
    builtin: true,
  },
}

/**
 * 全部模板（内置 + 用户自定义）。
 * 用户模板存于 localStorage（键 'canvas_user_templates'），本文件只返回内置，
 * 用户模板由调用方读取后自行合并。
 */
export function allTemplates(): CanvasTemplate[] {
  return Object.values(BUILTIN_TEMPLATES)
}

/** 按 key 查找模板，找不到返回 null */
export function getTemplate(key: string): CanvasTemplate | null {
  if (!key) return null
  return BUILTIN_TEMPLATES[key] ?? null
}

/** 模板摘要列表：key / 名称 / 节点数 / 是否内置 / 创建时间 */
export function templateList(): { key: string; name: string; node_count: number; builtin: boolean; created_at: string }[] {
  return allTemplates().map((t) => ({
    key: t.key,
    name: t.name,
    node_count: t.nodes.length,
    builtin: t.builtin,
    created_at: t.created_at ?? '',
  }))
}
