/**
 * 技能显示层：把后端的英文 id / SKILL.md frontmatter 名映射成中文标签 + 独立图标 + 分类色。
 *
 * 只影响展示，不改 skill_id、不改 SKILL.md 原文（GitHub 仓库里的文件绝对不动）。
 * 配色与 canvas-shared.tsx 的 TYPE_TILE 是同一套色系，保证左侧技能库与画布节点视觉一致。
 * 每个技能一个专属图标（39 个互不重复）；没匹配到的新技能自动按分类上色，不会白屏。
 */
import type { IconName } from '../../components/Icon'
import type { Skill } from './canvas-shared'

type Meta = { label: string; icon: IconName }

/** 内置技能（server/skills/registry.json，15 条）：按 id 映射，图标各不相同 */
const BUILTIN: Record<string, Meta> = {
  'academic-research-suite': { label: '科研框架设计', icon: 'compass' },
  'latex-paper-skills': { label: '从零到论文', icon: 'map' },
  'literature-survey-skill': { label: '文献综述梳理', icon: 'library' },
  'nature-academic-search': { label: '检索式扩展', icon: 'radar' },
  'paper-writing': { label: '论文写作', icon: 'quill' },
  'paper-spine': { label: '论证主线', icon: 'gitBranch' },
  'nature-writing': { label: '学术写作', icon: 'pencil' },
  'nature-polishing': { label: '论文润色', icon: 'wand' },
  'citation-check-skill': { label: '引用核查', icon: 'link' },
  'nature-citation': { label: '文献引用匹配', icon: 'quote' },
  'nature-figure': { label: '科研图表', icon: 'chart' },
  'nature-paper2ppt': { label: '论文转汇报', icon: 'slides' },
  'presentation-skill': { label: '汇报设计', icon: 'panel' },
  'nature-reviewer': { label: '投稿前审稿', icon: 'clipboardCheck' },
  'nature-response': { label: '返修回复', icon: 'reply' },
}

/** GitHub 原版技能（按 SKILL.md 的 frontmatter name 映射，24 条），图标各不相同 */
const GITHUB: Record<string, Meta> = {
  'nature-reviewer': { label: '期刊审稿模拟', icon: 'scan' },
  'nature-polishing': { label: '论文语言润色', icon: 'sparkle' },
  'nature-response': { label: '审稿意见回复', icon: 'message' },
  'nature-paper-card': { label: '论文速览卡片', icon: 'layers' },
  'nature-literature-pipeline': { label: '文献处理流水线', icon: 'pipeline' },
  'nature-data': { label: '数据整理', icon: 'database' },
  'nature-image2ppt': { label: '图片转汇报', icon: 'image' },
  'nature-citation': { label: '引文核查', icon: 'checkSquare' },
  'nature-experiment-log': { label: '实验记录', icon: 'notebook' },
  'nature-downloader': { label: '文献下载', icon: 'inbox' },
  'nature-academic-search': { label: '学术检索', icon: 'search' },
  'nature-figure': { label: '论文配图', icon: 'grid' },
  'deep-research': { label: '深度研究', icon: 'target' },
  'academic-pipeline': { label: '论文全流程', icon: 'route' },
  'academic-paper-reviewer': { label: '多角色审稿', icon: 'network' },
  'nature-ref-verifier': { label: '参考文献校验', icon: 'shield' },
  'academic-paper': { label: '学术论文写作', icon: 'award' },
  'nature-writing': { label: '学术写作', icon: 'bookOpen' },
  'nature-reader': { label: '文献阅读', icon: 'book' },
  'nature-statistics': { label: '统计分析', icon: 'sigma' },
  'nature-paper2ppt': { label: '论文转 PPT', icon: 'refresh' },
  researchwrite: { label: '基金申请写作', icon: 'lightbulb' },
  'nature-shared': { label: '通用写作规范', icon: 'file' },
  'nature-paper-to-patent': { label: '论文转专利', icon: 'hexagon' },
}

type Tile = { bg: string; edge: string; icon: IconName }

/** 分类 → 颜色 + 图标（用于分组标题与兜底）；关键词匹配，顺序敏感 */
const CATEGORIES: { test: RegExp; tile: Tile }[] = [
  { test: /文献|检索|综述|阅读|引用|引文|参考/, tile: { bg: '#1d4ed8', edge: '#bfdbfe', icon: 'library' } },
  { test: /数据|实验|统计/, tile: { bg: '#0e7490', edge: '#a5f3fc', icon: 'database' } },
  { test: /图表|汇报|PPT|卡片|图片/, tile: { bg: '#b45309', edge: '#fde68a', icon: 'chart' } },
  { test: /审稿|返修|回复|核查|校验/, tile: { bg: '#047857', edge: '#a7f3d0', icon: 'clipboardCheck' } },
  { test: /选题|框架|pipeline|全流程|深度研究/, tile: { bg: '#6d28d9', edge: '#ddd6fe', icon: 'compass' } },
  { test: /写作|论证|润色|表达|主线|专利|基金|申请/, tile: { bg: '#4338ca', edge: '#c7d2fe', icon: 'quill' } },
]

const FALLBACK: Tile = { bg: '#475569', edge: '#cbd5e1', icon: 'hexagon' }

/** hex + 透明度 → rgba()；左侧技能图标用透明底 + 分类色线性描边，不塞实心方块 */
export function soft(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export const categoryTile = (cat: string): Tile =>
  CATEGORIES.find((c) => c.test.test(cat || ''))?.tile || FALLBACK

/** 中文显示名：内置查 id，GitHub 查 frontmatter name，兜底保留原名 */
export const skillLabel = (s: Skill): string =>
  s.source === 'github' ? GITHUB[s.name]?.label || s.name : BUILTIN[s.id]?.label || s.name

/** 每个技能一个专属图标；未收录的新技能按分类兜底 */
export const skillIcon = (s: Skill): IconName => {
  const meta = s.source === 'github' ? GITHUB[s.name] : BUILTIN[s.id]
  return meta?.icon || categoryTile(s.category).icon
}

/** 小方块底色：按分类走，和画布节点同色系 */
export const skillTile = (s: Skill): Tile => categoryTile(s.category)
