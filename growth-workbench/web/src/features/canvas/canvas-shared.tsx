/** 画布模块共享的类型与常量；节点渲染器也放这里，页面只管编排。 */
import type { CSSProperties } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Icon, isIconName, type IconName } from '../../components/Icon'

export type NodeType = 'input' | 'prompt' | 'skill' | 'tool' | 'output'

export type Skill = {
  id: string
  name: string
  category: string
  icon: string
  desc: string
  mode: 'fast' | 'reason'
  inputs: { key: string; label: string; placeholder: string }[]
  builtin: boolean
  source?: string
}

export type CData = {
  title: string
  ntype: NodeType
  skillId: string
  config: Record<string, any>
  status: 'idle' | 'running' | 'done' | 'error'
  key: string
}

export type CNode = Node<CData, 'cnode'>

/** 每种节点一套配色：左侧竖条 + 淡色底，一眼能分清画布上是什么 */
export const TYPE_STYLE: Record<string, { box: string; bar: string; chip: string }> = {
  input: {
    box: 'border-sky-200 bg-sky-50/80',
    bar: 'bg-sky-400',
    chip: 'bg-sky-100 text-sky-700',
  },
  prompt: {
    box: 'border-violet-200 bg-violet-50/80',
    bar: 'bg-violet-400',
    chip: 'bg-violet-100 text-violet-700',
  },
  skill: {
    box: 'border-indigo-200 bg-indigo-50/80',
    bar: 'bg-indigo-400',
    chip: 'bg-indigo-100 text-indigo-700',
  },
  tool: {
    box: 'border-emerald-200 bg-emerald-50/80',
    bar: 'bg-emerald-400',
    chip: 'bg-emerald-100 text-emerald-700',
  },
  output: {
    box: 'border-amber-200 bg-amber-50/80',
    bar: 'bg-amber-400',
    chip: 'bg-amber-100 text-amber-700',
  },
}

export const TYPE_LABEL: Record<string, string> = {
  input: '输入',
  prompt: '自定义',
  skill: '技能',
  tool: '工具',
  output: '输出',
}

/**
 * 固定框布局的五类识别色（hex 字面量，只在这里定义，供内联 style 使用）。
 * 全站禁止裸 Tailwind 调色板，这张表与 TYPE_STYLE 一样是 canvas-shared.tsx 内的例外。
 */
export const TYPE_ACCENT: Record<string, { line: string; soft: string; text: string }> = {
  input: { line: '#7dd3fc', soft: 'rgba(56,189,248,0.13)', text: '#0369a1' },
  prompt: { line: '#c4b5fd', soft: 'rgba(167,139,250,0.13)', text: '#6d28d9' },
  skill: { line: '#a5b4fc', soft: 'rgba(129,140,248,0.13)', text: '#4338ca' },
  tool: { line: '#6ee7b7', soft: 'rgba(52,211,153,0.13)', text: '#047857' },
  output: { line: '#fcd34d', soft: 'rgba(251,191,36,0.15)', text: '#92400e' },
}

/** 每类节点的默认图标；节点可在右侧面板单独覆盖（存 config.icon） */
export const NODE_ICON: Record<string, IconName> = {
  input: 'file',
  prompt: 'sparkle',
  skill: 'hexagon',
  tool: 'send',
  output: 'download',
}

/** 右侧面板「节点图标」可选清单 */
export const ICON_CHOICES: { value: IconName; label: string }[] = [
  { value: 'file', label: '文档' },
  { value: 'sparkle', label: '灵感' },
  { value: 'hexagon', label: '模块' },
  { value: 'book', label: '文献' },
  { value: 'beaker', label: '实验' },
  { value: 'message', label: '对话' },
  { value: 'search', label: '检索' },
  { value: 'pencil', label: '写作' },
  { value: 'send', label: '调用' },
  { value: 'refresh', label: '循环' },
  { value: 'download', label: '输出' },
  { value: 'gear', label: '设置' },
  { value: 'compass', label: '方向' },
  { value: 'map', label: '路线' },
  { value: 'library', label: '资料库' },
  { value: 'radar', label: '扫描' },
  { value: 'quill', label: '撰稿' },
  { value: 'wand', label: '润色' },
  { value: 'chart', label: '图表' },
  { value: 'slides', label: '汇报' },
  { value: 'pipeline', label: '流程' },
  { value: 'layers', label: '层次' },
  { value: 'lightbulb', label: '创意' },
  { value: 'target', label: '目标' },
]

/** n8n 风格彩色实底：深色底 + 白字（对比度均 >= 4.5:1）；edge 用作连线与端点色 */
export const TYPE_TILE: Record<string, { bg: string; edge: string }> = {
  input: { bg: '#1d4ed8', edge: '#93c5fd' },
  prompt: { bg: '#6d28d9', edge: '#c4b5fd' },
  skill: { bg: '#4338ca', edge: '#a5b4fc' },
  tool: { bg: '#047857', edge: '#6ee7b7' },
  output: { bg: '#b45309', edge: '#fcd34d' },
}

/** 节点图标：优先用户自配（只要图库里有就认可，扩充图标不会让旧配置失效），否则按类型 */
export const nodeIcon = (d: CData): IconName => {
  const custom = d.config?.icon
  if (isIconName(custom)) return custom
  return NODE_ICON[d.ntype] || 'hexagon'
}

/** hex + 透明度 → rgba()；画布节点与左侧技能库共用同一套「浅底 + 同色线框」的视觉语言 */
const hexA = (hex: string, a: number): string => {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

/**
 * 画布节点的浅底芯片：白底 + 分类色线性图标 + 同色细线框，和左侧技能库的图标框一致。
 * 不再用实心彩色方块，改为轻盈的「白底 + 同色描边」，避免大色块发闷。
 */
export function nodeChip(bg: string, active = false): CSSProperties {
  return {
    backgroundColor: 'var(--wb-surface)',
    color: bg,
    boxShadow: `inset 0 0 0 1.5px ${hexA(bg, active ? 0.5 : 0.3)}`,
    outline: active ? `3px solid ${bg}` : 'none',
    outlineOffset: '3px',
  }
}

/** 节点副标题：一句话说清这个节点「拿什么当输入」 */
export function subtitle(data: CData): string {
  const c = data.config || {}
  switch (data.ntype) {
    case 'input':
      return (c.text || '').trim().slice(0, 40) || '空文本输入'
    case 'prompt':
      return (c.prompt || '').trim().split('\n')[0].slice(0, 40) || '还没写指令'
    case 'skill':
      return data.skillId || '未选技能'
    case 'tool':
      return c.tool === 'http' ? c.url || 'HTTP 未填 URL' : `Dify · ${c.app_id || '默认应用'}`
    case 'output':
      return c.prefix ? `前缀：${String(c.prefix).slice(0, 24)}` : '汇总上游输出'
    default:
      return ''
  }
}

/**
 * n8n 风格图形节点：彩色圆角方块 + 居中大图标 + 节点标题。
 * 自由画布与固定框共用同一个 NodeTile，视觉完全一致。
 */
export function NodeTile({
  data,
  size = 'md',
  label = false,
  active = false,
}: {
  data: CData
  size?: 'sm' | 'md'
  label?: boolean
  active?: boolean
}) {
  const tile = TYPE_TILE[data.ntype] || TYPE_TILE.skill
  const sm = size === 'sm'
  const st = data.status || 'idle'
  // 浅底芯片上，状态点用实色；空闲态用中性灰，避免白底上白点看不见
  const dot =
    st === 'running' ? '#f59e0b' : st === 'done' ? '#16a34a' : st === 'error' ? '#ef4444' : 'rgba(100,116,139,0.4)'
  return (
    <span
      className={`relative flex shrink-0 flex-col items-center justify-center gap-1 transition ${sm ? 'h-11 w-11 rounded-[13px]' : 'h-[92px] w-[92px] rounded-[20px]'} ${st === 'running' ? 'wb-anim-pulse' : ''}`}
      style={nodeChip(tile.bg, !!active)}
    >
      <Icon name={nodeIcon(data)} size={sm ? 21 : 32} strokeWidth={sm ? 1.9 : 1.8} />
      {label && (
        <span className="max-w-[80px] truncate px-1 text-[10.5px] font-medium leading-tight">
          {data.title || data.key}
        </span>
      )}
      {!sm && (
        <span
          className="absolute right-2 top-2 h-2 w-2 rounded-full ring-2 ring-[color:var(--wb-surface)]"
          style={{ background: dot }}
          title={st === 'running' ? '运行中' : st === 'done' ? '已完成' : st === 'error' ? '出错' : '未运行'}
        />
      )}
    </span>
  )
}

export function CanvasNode({ data, selected }: NodeProps<CNode>) {
  const tile = TYPE_TILE[data.ntype] || TYPE_TILE.skill
  const st = data.status || 'idle'
  return (
    <div className="group relative">
      <NodeTile data={data} label active={!!selected} />
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3"
        style={{ background: tile.edge, border: '3px solid #ffffff' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3"
        style={{ background: tile.edge, border: '3px solid #ffffff' }}
      />
      {/* hover 详情走 absolute 浮层，不占文档流，避免节点高度抖动 */}
      <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-2.5 py-1.5 text-[11px] text-[color:var(--wb-text-soft)] shadow-[var(--wb-shadow-md)] group-hover:block">
        <span className="font-medium text-[color:var(--wb-text)]">{TYPE_LABEL[data.ntype]}</span>
        {' · '}{subtitle(data)}
        {st === 'done' ? ' · 已完成' : st === 'error' ? ' · 出错' : st === 'running' ? ' · 运行中' : ''}
      </div>
    </div>
  )
}

export const nodeTypes = { cnode: CanvasNode }

/** 自定义节点的占位提示：告诉创作者哪些占位符会被替换 */
export const PROMPT_HINT = '{{upstream}} = 上游全部输出；{{input}} = 右侧「直接补充要求」；也可以自造槽位名'
