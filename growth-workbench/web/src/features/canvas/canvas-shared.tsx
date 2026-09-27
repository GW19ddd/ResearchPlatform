/** 画布模块共享的类型与常量；节点渲染器也放这里，页面只管编排。 */
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

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

const STATUS_CHIP: Record<string, { cls: string; text: string }> = {
  running: { cls: 'bg-[color:var(--wb-warn-soft)] text-[color:var(--wb-warn)]', text: '运行中…' },
  done: { cls: 'bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]', text: '已完成' },
  error: { cls: 'bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]', text: '出错' },
  idle: { cls: 'text-[color:var(--wb-muted)]', text: '未运行' },
}

/** 节点副标题：一句话说清这个节点「拿什么当输入」 */
function subtitle(data: CData): string {
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

export function CanvasNode({ data, selected }: NodeProps<CNode>) {
  const st = data.status || 'idle'
  const style = TYPE_STYLE[data.ntype] || TYPE_STYLE.skill
  const chip = STATUS_CHIP[st] || STATUS_CHIP.idle
  return (
    <div
      className={`relative w-56 overflow-hidden rounded-[12px] border px-3 py-2 text-[12px] shadow-[var(--wb-shadow-sm)] transition ${style.box} ${
        selected
          ? 'ring-2 ring-[color:var(--wb-accent)] ring-offset-1 ring-offset-white'
          : ''
      } ${st === 'running' ? 'wb-anim-pulse' : ''}`}
    >
      <span className={`absolute left-0 top-0 h-full w-[3px] ${style.bar}`} />
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[color:var(--wb-accent)]"
      />
      <div className="flex items-start justify-between gap-1">
        <span className="truncate font-medium leading-snug text-[color:var(--wb-text)]">
          {data.title || data.key}
        </span>
        <span className={`shrink-0 rounded-full px-1.5 text-[10px] leading-[17px] ${style.chip}`}>
          {TYPE_LABEL[data.ntype]}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[10.5px] text-[color:var(--wb-text-soft)]" title={subtitle(data)}>
        {subtitle(data)}
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-[10px]">
        <span className={`rounded px-1.5 leading-[16px] ${chip.cls}`}>{chip.text}</span>
        <span className="ml-auto tabular-nums text-[color:var(--wb-muted)]">{data.key}</span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[color:var(--wb-accent)]"
      />
    </div>
  )
}

export const nodeTypes = { cnode: CanvasNode }

/** 自定义节点的占位提示：告诉创作者哪些占位符会被替换 */
export const PROMPT_HINT = '{{upstream}} = 上游全部输出；{{input}} = 右侧「直接补充要求」；也可以自造槽位名'
