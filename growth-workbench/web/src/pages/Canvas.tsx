import '@xyflow/react/dist/style.css'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
} from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Btn, IconBtn, Input, Loading, MdBlock, Modal, Segmented, Select, StatusTag } from '../components/ui'
import { AiError } from '../components/AiError'
import { chatEnvelope } from '../features/chat/prefs'
import { toast } from '../components/toast'
import { Icon, type IconName } from '../components/Icon'
import { ResizeHandle } from '../components/ResizeHandle'
import { api, get, patch, post } from '../lib/api'
import { postSse } from '../lib/sse'
import { usePersist } from '../lib/state'
import SkillPalette from '../features/canvas/SkillPalette'
import FixedFlow from '../features/canvas/FixedFlow'
import CanvasAccess from '../features/canvas/CanvasAccess'
import CanvasLogs from '../features/canvas/CanvasLogs'
import CanvasMonitor from '../features/canvas/CanvasMonitor'
import NodeInspector, { type RunInfo } from '../features/canvas/NodeInspector'
import TemplateManager, { type TemplateInfo } from '../features/canvas/TemplateManager'
import {
  nodeTypes,
  NODE_ICON,
  nodeChip,
  TYPE_LABEL,
  TYPE_TILE,
  type CData,
  type CNode,
  type Skill,
} from '../features/canvas/canvas-shared'
import { skillLabel } from '../features/canvas/skill-meta'
import ChatPanel, { type ChatMsg, type ChipConf } from '../features/canvas/ChatPanel'
import SkillMarket from '../features/skills/SkillMarket'
import { pickResumableRun } from '../lib/canvasRun'

/** 画布对话的快捷操作与示例（面板通用化后由调用方注入） */
const CANVAS_CHIPS: ChipConf[] = [
  { icon: 'wand', label: '搭流水线', text: '搭一个「选题 → 文献综述 → 论文骨架」的流水线', tag: '搭流水线' },
  { icon: 'plus', label: '加节点', text: '加一个文献综述节点，连到选题后面', tag: '加节点' },
  { icon: 'pipeline', label: '跑整图', text: '把整个画布跑一遍，跑完给我一句结果摘要', tag: '运行任务' },
]
const CANVAS_SAMPLES = [
  '搭一个「选题 → 文献综述 → 论文骨架」的流程',
  '加一个文献综述节点，连到选题后面',
  '把输出节点改名为「最终报告」',
  '在综述后面加一个「创新点评估」，然后跑整图',
]

/**
 * 把 fitView 从 ReactFlow 内部递给外层工具栏。
 * 工具栏在 provider 外面（要横跨左右面板），所以只能靠 ref 桥接。
 */
function FitBridge({ fitRef }: { fitRef: React.MutableRefObject<(() => void) | null> }) {
  const { fitView } = useReactFlow()
  useEffect(() => {
    fitRef.current = () => fitView({ padding: 0.18, duration: 260 })
    return () => {
      fitRef.current = null
    }
  }, [fitView, fitRef])
  return null
}

/**
 * 技能库收缩后的 36px 图标条：只留「展开」和四个常用节点入口，点一下即可加节点。
 * 技能本体的浏览 / 拖拽仍在展开态里做，细条不复制那套列表逻辑。
 */
function SkillRail({
  onExpand,
  onHide,
  onAddNode,
}: {
  onExpand: () => void
  onHide: () => void
  onAddNode: (t: string) => void
}) {
  const items: { t: string; l: string }[] = [
    { t: 'input', l: '输入节点' },
    { t: 'prompt', l: '自定义节点' },
    { t: 'output', l: '输出节点' },
    { t: 'tool', l: 'Dify 节点' },
  ]
  return (
    <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] py-2">
      <IconBtn icon="chevronsRight" title="展开技能库" ariaLabel="展开技能库" onClick={onExpand} />
      <div className="my-1 h-px w-4 bg-[color:var(--wb-border)]" />
      {items.map((it) => (
        <button
          key={it.t}
          type="button"
          title={`添加「${it.l}」`}
          aria-label={`添加「${it.l}」`}
          onClick={() => onAddNode(it.t)}
          className="wb-press-strong flex h-7 w-7 items-center justify-center rounded-[7px] transition hover:bg-[color:var(--wb-bg-subtle)]"
        >
          <span
            className="flex h-6 w-6 items-center justify-center rounded-[7px]"
            style={nodeChip(TYPE_TILE[it.t]?.bg || '#475569')}
          >
            <Icon name={NODE_ICON[it.t] || 'hexagon'} size={13} strokeWidth={2.1} />
          </span>
        </button>
      ))}
      <div className="mt-auto">
        <IconBtn
          icon="close"
          title="隐藏技能库（工具栏「技能」可再打开）"
          ariaLabel="隐藏技能库"
          onClick={onHide}
        />
      </div>
    </div>
  )
}

/** ReactFlow 画布本体。只有它需要 useReactFlow，所以单独一层。 */
function Flow({
  nodes,
  setNodes,
  edges,
  setEdges,
  onSelect,
  onDropSkill,
  onNodeContext,
  onPaneContext,
}: {
  nodes: CNode[]
  setNodes: any
  edges: Edge[]
  setEdges: any
  onSelect: (key: string | null) => void
  onDropSkill: (skillId: string, x: number, y: number) => void
  onNodeContext: (e: React.MouseEvent, key: string) => void
  /** 右键空白处：e 用于浮层定位，pos 是换算好的画布坐标（直接喂 addNode） */
  onPaneContext: (e: React.MouseEvent | MouseEvent, pos: { x: number; y: number }) => void
}) {
  const { screenToFlowPosition } = useReactFlow()
  const { zoom } = useViewport()

  /** 连线跟随源节点的识别色：深色实线 + 同色箭头端点，浅背景上清晰，贴近 n8n 观感 */
  const styledEdges: Edge[] = edges.map((e) => {
    const src = nodes.find((n) => n.id === e.source)
    const color = (src && TYPE_TILE[src.data.ntype]?.bg) || '#94a3b8'
    return {
      ...e,
      animated: false,
      style: { stroke: color, strokeWidth: 2.2 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
    }
  })

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds: Edge[]) => addEdge({ ...c, animated: true }, eds)),
    [setEdges],
  )

  return (
    <div
      className="relative h-full w-full"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(e) => {
        e.preventDefault()
        const sid = e.dataTransfer.getData('application/skill')
        if (!sid) return
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        onDropSkill(sid, pos.x, pos.y)
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={(ch) => setNodes((nds: CNode[]) => applyNodeChanges(ch, nds) as CNode[])}
        onEdgesChange={(ch) => setEdges((eds: Edge[]) => applyEdgeChanges(ch, eds))}
        onConnect={onConnect}
        onNodeClick={(e, n) => onSelect(n.id)}
        onNodeContextMenu={(e, n) => {
          e.preventDefault()
          onNodeContext(e, n.id)
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault()
          const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
          onPaneContext(e, pos)
        }}
        onPaneClick={() => onSelect(null)}
        fitView
        proOptions={{ hideAttribution: true }}
        className="bg-[color:var(--wb-bg-subtle)]"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="#d3d9e3" />
        <Controls className="!bottom-3 !left-3" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => TYPE_TILE[(n.data as CData)?.ntype]?.bg || '#94a3b8'}
          className="!bottom-3 !right-3 !h-16 !w-24 !rounded-[10px] !border !border-[color:var(--wb-border)]"
          maskColor="rgba(16,24,40,0.08)"
        />
      </ReactFlow>
      {/* 真实缩放比例（useViewport），不写死 77% 这种参考图里的数字 */}
      <div className="pointer-events-none absolute bottom-3 right-[116px] z-10 rounded-[7px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-2 py-1 text-[10.5px] tabular-nums text-[color:var(--wb-text-soft)] shadow-[var(--wb-shadow-xs)]">
        {Math.round(zoom * 100)}%
      </div>
    </div>
  )
}

/** 编排视图（原画布工作台）：四个视图之一，?tab=build 或缺省时渲染。 */
function CanvasBoard() {
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const [skills, setSkills] = useState<Skill[]>([])
  const [cats, setCats] = useState<{ name: string; skills: Skill[] }[]>([])
  const [canvases, setCanvases] = useState<any[]>([])
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [cid, setCid] = usePersist<number | null>('canvas.cid', null)
  // 始终持有最新 cid：pollRun 据此判断「这次运行是否属于当前正在查看的画布」，
  // 避免切到别的画布时，别的画布的运行进度 / 失败信息串到当前画布界面。
  const cidRef = useRef(cid)
  cidRef.current = cid
  const [name, setName] = useState('')
  /** 最近一次落库的画布名：重命名时只在真的改了名字才发请求 */
  const nameSyncRef = useRef('')
  const [nodes, setNodes] = useState<CNode[]>([])
  // 始终持有最新 nodes，供轮询闭包在不进依赖数组的情况下读节点数（续跑时估算进度）
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const [edges, setEdges] = useEdgesState<Edge>([]) as any
  const [sel, setSel] = useState<string | null>(null)
  // 运行结果按画布分区持久化：切换菜单回来仍在（固定 key 的大 map，避免切画布时写错分区）
  const [outMap, setOutMap] = usePersist<Record<string, Record<string, string>>>('canvas.out', {})
  const [metaMap, setMetaMap] = usePersist<Record<string, Record<string, any>>>('canvas.meta', {})
  const outKey = String(cid ?? 0)
  const outputs = outMap[outKey] || {}
  const metas = metaMap[outKey] || {}
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [running, setRunning] = useState(false)
  /** 本次运行的状态：等待 / 执行中 / 成功 / 失败 / 已取消 —— 前端必须显示真实状态 */
  const [runId, setRunId] = useState<number | null>(null)
  const [runStatus, setRunStatus] = useState<string>('')
  const [runDone, setRunDone] = useState(0)
  const [runTotal, setRunTotal] = useState(0)
  const [runErrors, setRunErrors] = useState<Record<string, any>>({})
  const [runErr, setRunErr] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 布局：固定框（默认，轻量）/ 自由画布（高级，可拖拽缩放） */
  // v2：按用户「还是保留那种画布」把默认改回自由画布；换 key 让上一轮写死的 fixed 不残留
  const [layout, setLayout] = usePersist<'fixed' | 'free'>('canvas.layout.v2', 'free')
  const [tipSeen, setTipSeen] = usePersist('canvas.tipSeen', false)
  // 面板折叠：宽屏要的是更大的画布，不是更长的正文
  // v2：换 key 让上一轮误关的 leftOpen=false 复位（用户反馈「左边可拖拽的节点找不到了」）
  const [leftOpen, setLeftOpen] = usePersist('canvas.leftOpen.v2', true)
  const [rightOpen, setRightOpen] = usePersist('canvas.rightOpen', true)
  /** 左栏可收缩成 36px 图标条；两栏宽度都能拖，刷新 / 切菜单后仍记得 */
  const [leftRail, setLeftRail] = usePersist('canvas.leftRail', false)
  const [leftW, setLeftW] = usePersist('canvas.leftW', 208)
  const [rightW, setRightW] = usePersist('canvas.rightW', 368)
  /** 浏览器全屏专注模式：刻意不持久化，刷新后一律回到常规三栏 */
  const [focus, setFocus] = useState(false)
  // 对话操作面板（Undermind 式：自然语言指挥画布）
  const [chatOpen, setChatOpen] = usePersist('canvas.chatOpen', false)
  const [chatInput, setChatInput] = usePersist('canvas.chatInput', '')
  const [messages, setMessages] = usePersist<ChatMsg[]>('canvas.chatMsgs.v2', [])
  const [chatBusy, setChatBusy] = useState(false)
  /** 画布对话的 SSE 阶段文本（解析画布 / AI 生成操作 / 应用改动），点亮在忙碌态里 */
  const [chatStage, setChatStage] = useState('')
  // 输出展开成居中大窗（侧栏 23rem 装不下长文本）
  const [bigOut, setBigOut] = useState(false)
  // 底部「查看缓存」：把当前画布所有节点的真实输出集中看一遍
  const [cacheOpen, setCacheOpen] = useState(false)
  // 右键节点菜单（Dify 式：运行此步骤 / 复制 / 展开输出 / 删除）
  const [ctx, setCtx] = useState<{ x: number; y: number; key: string } | null>(null)
  // 右键空白处菜单：就地添加节点（不用拖拽），fx/fy 是画布坐标
  const [paneCtx, setPaneCtx] = useState<{ x: number; y: number; fx: number; fy: number } | null>(null)
  // 顶部「更多」「发布的应用」「技能库」下拉（发布的应用只收在画布里，不进主菜单）
  const [moreOpen, setMoreOpen] = useState(false)
  const [appsOpen, setAppsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [autoOpen, setAutoOpen] = usePersist('canvas.autoOpen', false)
  const moreRef = useRef<HTMLDivElement | null>(null)
  const appsRef = useRef<HTMLDivElement | null>(null)
  const skillsRef = useRef<HTMLDivElement | null>(null)
  // 点外部关闭下拉
  useEffect(() => {
    if (!moreOpen && !appsOpen && !skillsOpen) return
    const close = (e: MouseEvent) => {
      const t = e.target as Node
      if (moreRef.current && !moreRef.current.contains(t)) setMoreOpen(false)
      if (appsRef.current && !appsRef.current.contains(t)) setAppsOpen(false)
      if (skillsRef.current && !skillsRef.current.contains(t)) setSkillsOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [moreOpen, appsOpen, skillsOpen])
  const [providers, setProviders] = useState<any[]>([])
  const [difyApps, setDifyApps] = useState<any[]>([])
  const [difyBase, setDifyBase] = useState('')
  const [difyEnabled, setDifyEnabled] = useState(false)
  const [err, setErr] = useState('')
  // 一句话选题 → 自动搭画布
  const [autoTopic, setAutoTopic] = usePersist('canvas.auto.topic', '')
  const [autoConstraint, setAutoConstraint] = usePersist(
    'canvas.auto.constraint',
    '1-3 个月出结果，单机可跑',
  )
  const [autoing, setAutoing] = useState(false)
  const [autoWhy, setAutoWhy] = usePersist('canvas.auto.why', '')
  // GitHub 原版技能（原样加载，不改 SKILL.md）
  const [srcTab, setSrcTab] = usePersist<'all' | 'github' | 'builtin'>('canvas.srcTab', 'all')
  const [ghInfo, setGhInfo] = useState<{ count: number; repos: any[] }>({ count: 0, repos: [] })
  const [marketOpen, setMarketOpen] = useState(false)
  const [tplOpen, setTplOpen] = useState(false)
  const [viewer, setViewer] = useState<{
    id: string
    name: string
    repo: string
    body: string
    files: any[]
    file: string
    fileText: string
  } | null>(null)
  const [vbusy, setVbusy] = useState('')
  const keyRef = useRef(1)
  const fitRef = useRef<(() => void) | null>(null)
  /**
   * Dify 式撤销 / 重做：只在「增删移复制」这些明确的编辑动作上打快照。
   * 拖拽节点位置由 ReactFlow 每帧更新，不入历史，否则一步操作会塞进几十条记录。
   */
  const histRef = useRef<{ past: CNode[][]; future: CNode[][] }>({ past: [], future: [] })
  const [, setHistTick] = useState(0)
  const pushHist = () => {
    histRef.current.past.push(nodesRef.current)
    if (histRef.current.past.length > 40) histRef.current.past.shift()
    histRef.current.future = []
    setHistTick((v) => v + 1)
  }
  const undo = () => {
    const prev = histRef.current.past.pop()
    if (!prev) return
    histRef.current.future.push(nodesRef.current)
    setNodes(prev)
    setHistTick((v) => v + 1)
  }
  const redo = () => {
    const next = histRef.current.future.pop()
    if (!next) return
    histRef.current.past.push(nodesRef.current)
    setNodes(next)
    setHistTick((v) => v + 1)
  }
  // 保存 / 发布状态：本机工具没有云端自动保存，这里显示的是「上次成功保存到本机」的真实时间
  const [savedAt, setSavedAt] = useState('')
  const [publishedAt, setPublishedAt] = usePersist<Record<string, string>>('canvas.published', {})
  // 同一时刻只有 pollTokenRef 指向的那次轮询有效：发起新运行 / 卸载 / 切画布会作废旧 token，
  // 避免多个轮询闭包互相覆盖状态（以前「切走再回来状态错乱」的根因之一）
  const pollTokenRef = useRef(0)
  // 组件挂载标记：卸载后置 false，轮询闭包据此安全退出（不再对卸载后的组件 setState / 崩溃）
  const mountedRef = useRef(true)

  const flash = (t: string, tone: 'ok' | 'error' | 'info' = 'info') => toast(t, tone)

  /** 装/卸技能后刷新左侧技能库（内置 + GitHub）与仓库统计 */
  const reloadSkills = useCallback(async () => {
    try {
      const s = await get<any>('/canvas/skills')
      setSkills(s.skills || [])
      setCats(s.categories || [])
      const g = await get<any>('/canvas/skills/github')
      setGhInfo({ count: g.count || 0, repos: g.repos || [] })
    } catch (e: any) {
      flash('刷新技能库失败：' + (e?.message || e), 'error')
    }
  }, [])

  const openSource = async (sid: string, sname: string) => {
    setVbusy('open')
    try {
      const src = await get<any>(`/canvas/skills/github/${sid}/source`)
      const fs = await get<any>(`/canvas/skills/github/${sid}/files`)
      setViewer({
        id: sid,
        name: sname,
        repo: src.repo || '',
        body: src.body || '',
        files: fs.files || [],
        file: '',
        fileText: '',
      })
    } catch (e: any) {
      flash('读取原文失败：' + (e?.message || e), 'error')
    }
    setVbusy('')
  }

  const openFile = async (rel: string) => {
    if (!viewer) return
    setVbusy('file')
    try {
      const r = await get<any>(
        `/canvas/skills/github/${viewer.id}/file?rel=${encodeURIComponent(rel)}`,
      )
      setViewer({ ...viewer, file: rel, fileText: r.content || '' })
    } catch {
      setViewer({ ...viewer, file: rel, fileText: '（读取失败）' })
    }
    setVbusy('')
  }

  // ---------------------------------------------------------------- 加载

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const s = await get<any>('/canvas/skills')
        if (!alive) return
        setSkills(s.skills || [])
        setCats(s.categories || [])
        const l = await get<any>('/canvas')
        if (!alive) return
        setCanvases(l.canvases || [])
        setTemplates(l.templates || [])
        setErr('')
      } catch (e: any) {
        if (!alive) return
        setErr(
          `连不上后端：${e?.message || e}\n\n在 server 目录下启动：python -m uvicorn main:app --reload --port 8000`,
        )
      }
      try {
        const g = await get<any>('/canvas/skills/github')
        if (alive) setGhInfo({ count: g.count || 0, repos: g.repos || [] })
      } catch {
        /* 没克隆仓库时静默 */
      }
      try {
        const p = await get<any>('/settings/llm')
        if (alive) setProviders(p.providers || [])
      } catch {
        if (alive) setProviders([])
      }
      try {
        const d = await get<any>('/settings/dify')
        if (alive) {
          setDifyApps(d.apps || [])
          setDifyBase(d.base_url || '')
          setDifyEnabled(!!d.enabled)
        }
      } catch {
        /* 设置页没配 Dify 也不影响画布 */
      }
      if (alive) setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  /** 只刷新产出与运行记录，不动节点位置/配置 —— 跑完一次不该把画布重置 */
  const refreshOutputs = useCallback(
    async (id: number) => {
      const d = await get<any>(`/canvas/${id}`)
      const o: Record<string, string> = {}
      const m: Record<string, any> = {}
      ;(d.latest || []).forEach((r: any) => {
        o[r.node_key] = r.output_text || ''
        m[r.node_key] = {
          provider: r.provider,
          model: r.model,
          elapsed_ms: r.elapsed_ms,
          tokens_in: r.tokens_in,
          tokens_out: r.tokens_out,
          at: r.created_at,
        }
      })
      setOutMap((p) => ({ ...p, [String(id)]: o }))
      setMetaMap((p) => ({ ...p, [String(id)]: m }))
      setRuns(d.runs || [])
    },
    [setOutMap, setMetaMap],
  )

  const loadCanvas = useCallback(
    async (id: number) => {
      const d = await get<any>(`/canvas/${id}`)
      setCid(id)
      setName(d.canvas.name)
      nameSyncRef.current = String(d.canvas.name || '')
      const raw: CNode[] = (d.nodes || []).map((n: any) => ({
        id: n.node_key,
        type: 'cnode',
        position: { x: n.x || 0, y: n.y || 0 },
        data: {
          key: n.node_key,
          title: n.title || '',
          ntype: n.type || 'skill',
          skillId: n.skill_id || '',
          config: n.config || {},
          status: 'idle',
        },
      }))
      // 固定框时期保存的画布节点都在原点，回到自由画布时铺开，避免叠成一坨
      const stacked = raw.length > 1 && raw.every((n) => !n.position.x && !n.position.y)
      const ns = stacked
        ? raw.map((n, i) => ({
            ...n,
            position: { x: 80 + (i % 4) * 210, y: 80 + Math.floor(i / 4) * 170 },
          }))
        : raw
      setNodes(ns)
      setEdges(
        (d.edges || []).map((e: any, i: number) => ({
          id: `e${i}`,
          source: e.source_key,
          target: e.target_key,
          animated: true,
        })),
      )
      await refreshOutputs(id)
      ns.forEach((n) => {
        const num = parseInt(n.id.replace(/\D/g, ''), 10)
        if (num && num >= keyRef.current) keyRef.current = num + 1
      })
      setSel(ns[0]?.id || null)
    },
    [setCid, setEdges, refreshOutputs],
  )

  // 进入编排面板：?cid= 是唯一入口（调度器保证有 cid 才渲染 CanvasBoard）；cid 无效则回落并回写 URL
  const bootedRef = useRef(false)
  useEffect(() => {
    if (loading || bootedRef.current || !canvases.length) return
    bootedRef.current = true
    const qsCid = Number(sp.get('cid') || 0)
    const target =
      qsCid && canvases.some((c) => c.id === qsCid)
        ? qsCid
        : cid !== null && canvases.some((c) => c.id === cid)
          ? cid
          : canvases[0].id
    loadCanvas(target)
    // 回落路径（cid 无效/缺失）时把最终打开的画布回写到 URL，保持「URL 即状态」
    if (qsCid !== target) nav(`/canvas?tab=build&cid=${target}`, { replace: true })
  }, [loading, canvases, cid, loadCanvas, sp, nav])

  // 引导完成后再点侧栏「发布的应用」/ 工作室卡片：?cid= 变了就切换画布
  useEffect(() => {
    if (!bootedRef.current || !canvases.length) return
    const qsCid = Number(sp.get('cid') || 0)
    if (qsCid && qsCid !== cidRef.current && canvases.some((c) => c.id === qsCid)) loadCanvas(qsCid)
  }, [sp, canvases, loadCanvas])

  // 组件卸载时标记：轮询闭包据此安全退出，不在已卸载的组件上 setState（避免 React 警告 / 内存泄漏）
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 切到另一块画布时，把「运行态」整体重置：上一块画布的运行进度 / 失败信息不能串到当前画布。
  // 真正的续接由下方 re-attach effect 基于后端 runs 重新拉起（若新画布确有在途运行）。
  useEffect(() => {
    setRunning(false)
    setRunStatus('')
    setRunDone(0)
    setRunTotal(0)
    setRunErrors({})
    setRunErr(null)
    setRunId(null)
  }, [cid])

  // 切回画布（或导航回来）时，若后端还有「在跑」的运行，自动续接轮询 —— 见下方 run/pollRun 定义之后的 re-attach effect

  // ---------------------------------------------------------------- 节点操作

  /** 固定框：按当前展示顺序生成链式连线。只在保存/运行时写入后端，不静默改写已加载的画布 */
  const chainEdges = (ns: CNode[]): Edge[] =>
    ns.slice(1).map((n, i) => ({
      id: `e${i}`,
      source: ns[i].id,
      target: n.id,
      animated: true,
    }))

  const effectiveEdges = (): Edge[] => (layout === 'fixed' ? chainEdges(nodes) : edges)

  const switchLayout = (v: 'fixed' | 'free') => {
    if (v === 'free' && layout === 'fixed') {
      setEdges(chainEdges(nodes))
      // 固定框里节点都堆在原点，切回自由画布时铺开，免得叠在一起
      setNodes((nds: CNode[]) =>
        nds.map((n, i) => ({
          ...n,
          position: { x: 80 + (i % 3) * 280, y: 80 + Math.floor(i / 3) * 180 },
        })),
      )
    }
    setLayout(v)
  }

  /** 固定框：上下移动步骤只改展示顺序，保存时由 effectiveEdges 生成新连线 */
  const moveNode = (key: string, dir: -1 | 1) => {
    pushHist()
    setNodes((nds: CNode[]) => {
      const i = nds.findIndex((n) => n.id === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= nds.length) return nds
      const next = [...nds]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const addNode = (ntype: string, skillId: string, x: number, y: number) => {
    pushHist()
    const key = `n${keyRef.current++}`
    const sk = skills.find((s) => s.id === skillId)
    const cfg: Record<string, any> = {}
    if (ntype === 'input') cfg.text = ''
    if (ntype === 'prompt') Object.assign(cfg, { system: '', prompt: '', text: '', mode: 'fast', max_ctx: 4000 })
    if (ntype === 'skill') cfg.inputs = {}
    if (ntype === 'tool') Object.assign(cfg, { tool: 'dify', app_id: '', inputs: {} })
    setNodes((nds) => [
      ...nds,
      {
        id: key,
        type: 'cnode',
        position: { x, y },
        selected: true,
        data: {
          key,
          title: sk ? skillLabel(sk) : `${TYPE_LABEL[ntype] || '节点'}节点`,
          ntype: ntype as any,
          skillId: ntype === 'skill' ? skillId : '',
          config: cfg,
          status: 'idle',
        },
      },
    ])
    setSel(key)
  }

  const patch = (key: string, fn: (d: CData) => CData) => {
    setNodes((nds) => nds.map((n) => (n.id === key ? { ...n, data: fn(n.data) } : n)))
  }

  const delNode = (key: string) => {
    pushHist()
    setNodes((nds) => nds.filter((n) => n.id !== key))
    setEdges((eds: Edge[]) => eds.filter((e) => e.source !== key && e.target !== key))
    setSel(null)
  }

  /** 复制节点（Dify 式）：配置原样带走，位置偏移一点，名字加「副本」 */
  const dupNode = (key: string) => {
    const src = nodes.find((n) => n.id === key)
    if (!src) return
    pushHist()
    const k = `n${keyRef.current++}`
    setNodes((nds: CNode[]) => [
      ...nds,
      {
        ...src,
        id: k,
        selected: true,
        position: { x: src.position.x + 48, y: src.position.y + 48 },
        data: {
          ...src.data,
          key: k,
          title: src.data.title ? `${src.data.title} 副本` : '',
          status: 'idle',
        },
      },
    ] as CNode[])
    setSel(k)
    flash('已复制节点', 'ok')
  }

  // ---------------------------------------------------------------- 持久化 / 运行

  const save = async () => {
    if (!cid) return
    setSaving(true)
    try {
      await post(`/canvas/${cid}/save`, {
        name,
        nodes: nodes.map((n) => ({
          node_key: n.id,
          type: n.data.ntype,
          skill_id: n.data.skillId,
          title: n.data.title,
          x: n.position.x,
          y: n.position.y,
          config: n.data.config,
        })),
        edges: effectiveEdges().map((e: Edge) => ({ source_key: e.source, target_key: e.target })),
      })
      const l = await get<any>('/canvas')
      setCanvases(l.canvases || [])
      setTemplates(l.templates || [])
      setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    } finally {
      setSaving(false)
    }
  }

  const saveOnly = async () => {
    await save()
    flash('已保存', 'ok')
  }

  /** 就地重命名：失焦 / 回车触发，只改名字不动节点（PATCH /canvas/{id}），和「保存」分开 */
  const renameCanvas = async () => {
    if (!cid) return
    const n = name.trim()
    if (!n) {
      flash('画布名不能为空', 'error')
      setName(nameSyncRef.current)
      return
    }
    if (n === nameSyncRef.current) return
    try {
      await api.patch(`/canvas/${cid}`, { name: n }, { silent: true })
      nameSyncRef.current = n
      setCanvases((l: any[]) => l.map((c) => (c.id === cid ? { ...c, name: n } : c)))
      flash('已重命名', 'ok')
    } catch {
      /* patch 失败时 lib/api 已弹错误反馈 */
    }
  }

  /**
   * 轮询单个画布运行直到终态（done/failed/cancelled）。
   *
   * 关键：轮询循环独立于组件挂载状态 —— 导航离开画布时组件卸载置 mountedRef=false，循环随即
   * 安全退出（不再 setState、不崩溃）；后端后台任务不受影响、继续跑。切回画布时由 re-attach
   * effect 用 pickResumableRun 找到在途运行再调一次本函数续接，进度不丢。
   *
   * 同一时刻只有 pollTokenRef 指向的那次轮询有效：发起新运行 / 卸载 / 切画布都会把旧 token 作废，
   * 避免多个轮询闭包互相覆盖状态（以前「切走再回来状态错乱」的根因之一）。
   */
  const pollRun = useCallback(
    async (rid: number, targetCid: number, token: number, total?: number) => {
      setRunning(true)
      setRunErr(null)
      setRunErrors({})
      setRunStatus('running')
      if (total != null) setRunTotal(total)
      setRunDone(0)

      const apply = (outs: any[]) => {
        const st: Record<string, 'done' | 'error' | 'running'> = {}
        const errs: Record<string, any> = {}
        outs.forEach((o: any) => {
          st[o.node_key] = o.ok === false ? 'error' : 'done'
          if (o.ok === false) errs[o.node_key] = o.error || {}
        })
        if (mountedRef.current && pollTokenRef.current === token && cidRef.current === targetCid) {
          setNodes((nds) =>
            nds.map((n) => (st[n.id] ? { ...n, data: { ...n.data, status: st[n.id] } } : n)),
          )
          setRunErrors((p) => ({ ...p, ...errs }))
          setRunDone(Object.keys(st).length)
        }
        return st
      }

      let detail: any = null
      let last: Record<string, string> = {}
      const deadline = Date.now() + 30 * 60 * 1000
      try {
        while (mountedRef.current && pollTokenRef.current === token && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 700))
          if (!mountedRef.current || pollTokenRef.current !== token) break
          detail = await get<any>(`/canvas/runs/${rid}`)
          if (!mountedRef.current || pollTokenRef.current !== token) break
          const st = apply(detail.outputs || [])
          last = st
          if (
            mountedRef.current &&
            pollTokenRef.current === token &&
            cidRef.current === targetCid
          ) {
            setRunStatus(detail.run?.status || 'running')
          }
          if (['done', 'failed', 'cancelled'].includes(detail.run?.status)) break
        }

        if (
          mountedRef.current &&
          pollTokenRef.current === token &&
          cidRef.current === targetCid
        ) {
          await refreshOutputs(targetCid)
          if (detail?.run?.stale) {
            flash(detail.run.message || '上次运行没有留下结果，重跑一次', 'error')
            setRunErr({ label: '运行中断', message: detail.run.message || '上次运行随服务中断结束了' })
          } else {
            const bad = Object.values(last).filter((s) => s === 'error').length
            const total0 = Object.keys(last).length
            const status = detail?.run?.status
            if (status === 'cancelled') flash('已取消这次运行', 'info')
            else if (bad) flash(`运行结束 · ${total0} 个节点 · ${bad} 个失败`, 'error')
            else flash(`运行完成 · ${total0} 个节点`, 'ok')
          }
        }
      } catch (e: any) {
        if (
          mountedRef.current &&
          pollTokenRef.current === token &&
          cidRef.current === targetCid
        ) {
          setRunErr({ label: '运行失败', message: e?.message || String(e) })
          flash(`运行失败：${e?.message || e}`, 'error')
          setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, status: 'idle' } })))
        }
      } finally {
        if (
          mountedRef.current &&
          pollTokenRef.current === token &&
          cidRef.current === targetCid
        )
          setRunning(false)
      }
    },
    [setNodes, setRunErrors, setRunDone, setRunStatus, setRunErr, setRunTotal, refreshOutputs, flash],
  )

  /**
   * 运行：后端是后台任务，这里负责发起并轮询真实状态。
   * 期间可取消、可见第几个节点在跑；导航离开画布也不会让运行本身中断。
   */
  const run = async (nodeKey?: string) => {
    if (!cid) return
    if (!nodes.length) return flash('画布是空的', 'error')
    if (running) return
    await save()
    setRunning(true)
    setRunErr(null)
    setRunErrors({})
    setRunStatus('queued')
    setRunDone(0)
    const keys = nodeKey ? [nodeKey] : nodes.map((n) => n.id)
    setRunTotal(keys.length)
    setNodes((nds) =>
      nds.map((n) => (keys.includes(n.id) ? { ...n, data: { ...n.data, status: 'running' } } : n)),
    )

    try {
      const r = await post<any>(
        `/canvas/${cid}/run`,
        { node_key: nodeKey || null },
        { silent: true },
      )
      const rid = Number(r.run_id)
      setRunId(rid)
      setRunStatus('running')
      const token = ++pollTokenRef.current
      await pollRun(rid, cid, token, keys.length)
    } catch (e: any) {
      setRunErr({ label: '运行失败', message: e?.message || String(e) })
      flash(`运行失败：${e?.message || e}`, 'error')
      setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, status: 'idle' } })))
      setRunning(false)
    }
  }

  // 切回画布（或导航回来）时，若后端还有「在跑」的运行，自动续接轮询 —— 导航离开不会丢进度
  useEffect(() => {
    if (!cid || running) return
    const resumable = pickResumableRun(runs)
    if (!resumable) return
    const token = ++pollTokenRef.current
    setRunId(resumable.id) // 让续接的运行也能被取消
    pollRun(resumable.id, cid, token, nodesRef.current.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, runs, running, pollRun])

  const cancelRun = async () => {
    if (!runId) return
    const r = await post<any>(`/canvas/runs/${runId}/cancel`, undefined, { silent: true })
    flash(r?.message || '已请求取消', r?.ok ? 'info' : 'error')
  }

  const createCanvas = async (tpl?: string) => {
    const n = tpl ? templates.find((t) => t.key === tpl)?.name : '新画布'
    const r = await post<any>('/canvas', { name: n || '新画布', template: tpl || null })
    const l = await get<any>('/canvas')
    setCanvases(l.canvases || [])
    await loadCanvas(r.id)
    // 新建即进入编排：URL 同步带上 cid（调度器按 cid 决定是否渲染面板）
    nav(`/canvas?tab=build&cid=${r.id}`, { replace: true })
    flash('已创建', 'ok')
  }

  const autoBuild = async () => {
    if (!autoTopic.trim()) return flash('先填个选题，例如「ai单元测试」', 'error')
    setAutoing(true)
    try {
      const r = await post<any>('/canvas/auto', {
        topic: autoTopic,
        constraint: autoConstraint,
        max_nodes: 6,
        save: true,
      }, { silent: true })
      const l = await get<any>('/canvas')
      setCanvases(l.canvases || [])
      await loadCanvas(r.id)
      const fb = r.fallback ? '（AI 未编排成功，用了保底流水线）' : ''
      // 编排器会剔掉不存在的 skill / 成环连线；别让用户以为 AI 提的节点全都搭上了
      const dropped: string[] = Array.isArray(r.dropped) ? r.dropped : []
      const dropMsg = dropped.length ? ` · 剔除 ${dropped.length} 个无效节点` : ''
      flash(`已搭好「${r.name}」· ${r.nodes.length} 节点${fb}${dropMsg}`, 'ok')
      setAutoWhy(
        [r.rationale, dropped.length ? `已剔除：${dropped.join('；')}` : '']
          .filter(Boolean)
          .join(' · '),
      )
    } catch (e: any) {
      flash(`搭建失败：${e?.message || e}`, 'error')
    }
    setAutoing(false)
  }

  const saveAsTemplate = async () => {
    if (!cid || !nodes.length) return flash('空画布没有可存的模板', 'error')
    const tplName = window.prompt('模板名称（以后可以一键复用这套流水线）', name)
    if (!tplName) return
    await save()
    const r = await post<any>(`/canvas/${cid}/save-as-template`, { name: tplName })
    const l = await get<any>('/canvas')
    setTemplates(l.templates || [])
    flash(`已存为模板「${r.name}」· ${r.node_count} 节点`, 'ok')
  }

  /**
   * 发布：本机语义 = 把当前画布保存为对外生效的版本。
   * 访问点、运行、日志读的都是数据库里这份，所以「发布」不是装饰按钮；发布时间按画布记录。
   */
  const publish = async () => {
    if (!cid) return flash('先新建或选中一块画布', 'error')
    if (!nodes.length) return flash('空画布不能发布', 'error')
    await save()
    const t = new Date().toLocaleString('zh-CN', { hour12: false })
    setPublishedAt((p) => ({ ...p, [String(cid)]: t }))
    flash('已发布当前版本，访问点与运行读的都是这份', 'ok')
  }

  /** 退出全屏专注：同时退出浏览器全屏，避免 Esc 后只剩一个「藏了侧栏」的页面 */
  const exitFocus = () => {
    if (!focus) return
    setFocus(false)
    if (document.fullscreenElement) {
      try {
        void document.exitFullscreen?.().catch(() => {})
      } catch {
        /* 浏览器不允许退出时忽略，应用内布局已恢复 */
      }
    }
  }
  /** 进入 / 退出全屏画布。requestFullscreen 必须留在点击的同步调用栈里，
      挪进 useEffect 会丢掉用户手势，浏览器会拒绝；失败时应用内专注模式仍生效。 */
  const toggleFocus = () => {
    if (focus) return exitFocus()
    setFocus(true)
    try {
      void document.documentElement.requestFullscreen?.().catch(() => {})
    } catch {
      /* 不支持浏览器全屏时只做应用内全屏 */
    }
  }
  /** 全屏下点面板开关：先回到常规三栏，再执行开关，否则改了状态也看不见 */
  const toggleLeft = () => {
    exitFocus()
    if (!leftOpen) {
      setLeftOpen(true)
      setLeftRail(false)
    } else if (leftRail) setLeftRail(false)
    else setLeftRail(true)
  }
  const toggleRight = () => {
    exitFocus()
    setRightOpen(!rightOpen)
  }
  const toggleChat = () => {
    exitFocus()
    setChatOpen(!chatOpen)
  }

  /** 图 2 顶栏标注的 Alt+R 预览运行：真的绑上，不写假快捷键 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        if (!running) run()
      }
      if (e.key === 'Escape' && focus) {
        // 有弹层时 Esc 归弹层用（Modal 自己也监听 Esc），别顺手把全屏退掉
        const dialogOpen = bigOut || cacheOpen || tplOpen || marketOpen || ctx || moreOpen
        if (!dialogOpen) {
          e.preventDefault()
          exitFocus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** 全屏专注只改 body 上的 class，左右面板 / 对话面板由 JSX 条件隐藏，
      退出时原样恢复，不需要备份还原各面板的开关状态。 */
  useEffect(() => {
    document.body.classList.toggle('wb-canvas-focus', focus)
    // 布局重排后补一次 fitView；ReactFlow 自己会 resize，这里只负责把节点收回视野
    const t = window.setTimeout(() => fitRef.current?.(), 200)
    return () => {
      window.clearTimeout(t)
      document.body.classList.remove('wb-canvas-focus')
    }
  }, [focus])

  /** 用户直接按 F11 / Esc 退出浏览器全屏时，专注状态要跟着回落 */
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFocus(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const delTemplate = async (key: string) => {
    await api.del(`/canvas/templates/${encodeURIComponent(key)}`)
    const l = await get<any>('/canvas')
    setTemplates(l.templates || [])
    flash('模板已删除', 'ok')
  }

  const delCanvas = async () => {
    if (!cid) return
    if (!window.confirm(`删除画布「${name}」及其运行记录？此操作不可撤销。`)) return
    await api.del(`/canvas/${cid}`)
    const l = await get<any>('/canvas')
    setCanvases(l.canvases || [])
    setCid(null)
    setNodes([])
    setEdges([])
    setOutMap((p) => ({ ...p, [outKey]: {} }))
    setRuns([])
    if (l.canvases?.length) loadCanvas(l.canvases[0].id)
    flash('画布已删除', 'ok')
  }

  const saveOutput = async (target: string) => {
    if (!cid || !sel) return
    try {
      await post(`/canvas/${cid}/output/save`, { node_key: sel, target })
      flash('已存入' + ({ idea: '创新点', literature: '文献', paper: '论文' } as any)[target], 'ok')
    } catch (e: any) {
      flash(e?.message || '存入失败', 'error')
    }
  }

  /** 画布 → 对话联动：把选中节点的输出立项成新 quest，跳到科研工作区接着推进 */
  const makeQuest = async () => {
    if (!cid || !sel) return
    const out = (outputs[sel] || '').trim()
    if (!out) return
    try {
      const s = await post<any>(
        '/chat/sessions',
        {
          title: `${name || '画布成果'} · Quest`.slice(0, 40),
          role: 'assistant',
          mode: 'fast',
          context_keys: [],
        },
        { ok: false },
      )
      await post(
        `/chat/sessions/${s.id}/messages`,
        {
          content: [
            `【研究目标】\n以下是我用编排画布流水线得到的成果，请基于它继续推进：评估可行性、找出漏洞、给出下一步可执行计划。\n\n${out.slice(0, 6000)}`,
            '请按以下规则推进：\n1. 先输出分阶段研究计划（每阶段有可验证产出），等我确认后再逐步执行；\n2. 每个阶段结束时给「阶段小结：做了什么 / 结论 / 下一步」；\n3. 执行中要改动上述任何边界，先说明再动手。',
          ].join('\n\n'),
          mode: 'fast',
          regenerate: false,
        },
        { ok: false },
      )
      localStorage.setItem('wb:chat.sid', String(s.id))
      flash('已立项，正在切到「课题 Quest」…', 'ok')
      setTimeout(() => nav(`/chat?quest=${s.id}`), 400)
    } catch (e: any) {
      flash(e?.message || '立项失败', 'error')
    }
  }

  /** 对话操作画布：把自然语言指令发给后端，AI 解析成节点操作并落库，前端实时刷新。
   *  可带 tag（指令来源：快捷操作 / 追问 / 手输），显示在用户消息上方的小签里。 */
  const sendChat = async (raw?: string, tag?: string) => {
    const text = (raw ?? chatInput).trim()
    if (!cid || !text || chatBusy) return
    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    setMessages((ms) => [...ms, { role: 'user', content: text, skillTag: tag }])
    setChatInput('')
    setChatBusy(true)
    setChatStage('')
    const t0 = Date.now()
    try {
      // 流式：阶段事件实时反馈（解析画布 → AI 生成操作 → 应用改动）
      let done: any = null
      await postSse(`/api/canvas/${cid}/chat/stream`, { instruction: text, history, ...chatEnvelope() }, (ev: any) => {
        if (ev.type === 'stage') {
          setChatStage(`${ev.label}${ev.detail ? ` · ${ev.detail}` : ''}`)
        } else if (ev.type === 'done') {
          done = ev
        }
      })
      if (!done) throw new Error('流已结束，但没有收到完成事件')
      const r = done
      setMessages((ms) => [
        ...ms,
        {
          role: 'assistant',
          content: r.reply || '',
          applied: r.applied || [],
          plan: r.plan || [],
          suggests: r.suggests || [],
          elapsed: r.elapsed_ms || Date.now() - t0,
        },
      ])
      if (r.applied && r.applied.length) flash('画布已更新', 'ok')
      // 实时刷新画布，让 AI 的改动立刻可见
      await loadCanvas(cid)
      if (r.run) run()
    } catch (e: any) {
      setMessages((ms) => [
        ...ms,
        { role: 'assistant', content: `（操作失败：${e?.message || e}）` },
      ])
      flash('对话操作失败：' + (e?.message || e), 'error')
    } finally {
      setChatBusy(false)
      setChatStage('')
    }
  }

  const selNode = nodes.find((n) => n.id === sel) || null

  const shownCats =
    srcTab === 'all'
      ? cats
      : cats
          .map((c) => ({
            name: c.name,
            skills: c.skills.filter((s) =>
              srcTab === 'github' ? (s as any).source === 'github' : (s as any).source !== 'github',
            ),
          }))
          .filter((c) => c.skills.length > 0)

  if (loading) return <Loading text="正在加载画布…" />
  if (err)
    return (
      <div className="p-6">
        <div className="rounded-[12px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] p-4">
          <div className="flex items-start gap-2">
            <Icon name="alert" size={15} className="mt-[1px] text-[color:var(--wb-danger)]" />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[color:var(--wb-danger)]">
                画布加载失败
              </div>
              <pre className="mt-2 whitespace-pre-wrap break-words text-[12px] text-[color:var(--wb-text-soft)]">
                {err}
              </pre>
              <div className="mt-3 flex items-center gap-2">
                <Btn onClick={() => location.reload()}>重试</Btn>
                <span className="text-[11.5px] text-[color:var(--wb-muted)]">
                  已保存的画布与运行记录都在本地数据库里，刷新不会影响它们
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
      {!focus && leftOpen && (leftRail ? (
        <SkillRail
          onExpand={() => setLeftRail(false)}
          onHide={() => setLeftOpen(false)}
          onAddNode={(t) => addNode(t, '', 120 + Math.random() * 120, 120 + Math.random() * 120)}
        />
      ) : (
        <>
          <SkillPalette
            cats={shownCats}
            srcTab={srcTab}
            setSrcTab={setSrcTab}
            ghInfo={ghInfo}
            onOpenSource={openSource}
            onAddNode={addNode}
            onPickSkill={(sid) => addNode('skill', sid, 120, 120)}
            onOpenMarket={() => setMarketOpen(true)}
            onInstalled={reloadSkills}
            width={leftW}
            onCollapse={() => setLeftRail(true)}
            onHide={() => setLeftOpen(false)}
          />
          <ResizeHandle
            width={leftW}
            onResize={setLeftW}
            onReset={() => setLeftW(208)}
            min={168}
            max={420}
            label="调整技能库宽度"
          />
        </>
      ))}

      {/* 中：画布 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]" data-tour="tour-canvas-toolbar">
          {/* 第一行：画布本身的操作 */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Segmented
              value={layout}
              onChange={switchLayout}
              options={[
                { value: 'free', label: '自由画布' },
                { value: 'fixed', label: '固定框' },
              ]}
            />
            <Select
              value={cid ? String(cid) : ''}
              onChange={(v) => v && loadCanvas(Number(v))}
              options={[
                { value: '', label: '选择画布…' },
                ...canvases.map((c) => ({ value: String(c.id), label: c.name })),
              ]}
            />
            <Input
              value={name}
              onChange={setName}
              onBlur={renameCanvas}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="!w-44"
              placeholder="画布名称"
              ariaLabel="画布名称"
            />
            {/* 状态只报真实事件：上次成功保存到本机的时间、上次发布当前版本的时间 */}
            <span className="hidden items-center gap-1.5 whitespace-nowrap text-[11px] text-[color:var(--wb-muted)] xl:flex">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--wb-ok)]" />
              {savedAt ? `已保存 ${savedAt}` : '尚未保存'}
              {cid && publishedAt[String(cid)] ? ` · 已发布 ${publishedAt[String(cid)]}` : ''}
            </span>
            <Btn onClick={saveOnly} loading={saving}>
              保存
            </Btn>
            <Btn
              variant="primary"
              onClick={() => run()}
              disabled={running}
              loading={running}
              title="预览运行（Alt+R）"
            >
              <Icon name="play" size={12} />
              预览运行
            </Btn>
            <Btn onClick={publish} title="保存当前画布为对外生效版本（访问点与运行读这份）">
              发布
            </Btn>
            {running && (
              <Btn variant="danger" onClick={cancelRun} title="停止后续尚未开始的节点">
                取消运行
              </Btn>
            )}
            {running && (
              <StatusTag tone="busy">
                {runStatus === 'queued' ? '排队中' : `执行中 · ${runDone}/${runTotal} 节点`}
              </StatusTag>
            )}
            {!running && runStatus === 'cancelled' && <StatusTag tone="warn">已取消</StatusTag>}
            {!running && runStatus === 'failed' && <StatusTag tone="danger">有节点失败</StatusTag>}
            {!running && runStatus === 'done' && <StatusTag tone="ok">运行完成</StatusTag>}
            <span className="mx-1 hidden h-4 w-px bg-[color:var(--wb-border)] sm:block" />
            <span className="mx-1 hidden h-4 w-px bg-[color:var(--wb-border)] sm:block" />
            {/* 技能库：独立下拉（与发布的应用并排），点技能直接落一个节点，不必拖拽 */}
            <div ref={skillsRef} className="relative">
              <Btn onClick={() => setSkillsOpen(!skillsOpen)}>
                <Icon name="wand" size={13} />
                技能库
                <Icon name="chevronDown" size={12} />
              </Btn>
              {skillsOpen && (
                <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] py-1 shadow-[var(--wb-shadow-md)]">
                  {/* 快捷：三种基础节点也能就地加，不等拖拽 */}
                  <div className="flex items-center gap-1 px-2.5 pb-1.5 pt-1">
                    {(
                      [
                        { t: 'input', l: '输入', icon: 'file' },
                        { t: 'prompt', l: '自定义', icon: 'pencil' },
                        { t: 'output', l: '输出', icon: 'send' },
                      ] as const
                    ).map((o) => (
                      <button
                        key={o.t}
                        type="button"
                        onClick={() => {
                          setSkillsOpen(false)
                          addNode(o.t, '', 160 + Math.random() * 120, 160 + Math.random() * 120)
                        }}
                        className="wb-press-soft flex flex-1 items-center justify-center gap-1 rounded-[8px] border border-[color:var(--wb-border)] py-1 text-[11.5px] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-accent)] hover:text-[color:var(--wb-accent)]"
                      >
                        <Icon name={o.icon} size={12} />
                        {o.l}
                      </button>
                    ))}
                  </div>
                  {cats.length === 0 && (
                    <div className="px-3 py-2 text-[11.5px] text-[color:var(--wb-muted)]">技能加载中…</div>
                  )}
                  {cats.map((g) => (
                    <div key={g.name}>
                      <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
                        {g.name}
                      </div>
                      {g.skills.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          title={s.desc || s.name}
                          onClick={() => {
                            setSkillsOpen(false)
                            addNode('skill', s.id, 160 + Math.random() * 120, 160 + Math.random() * 120)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[color:var(--wb-text)] hover:bg-[color:var(--wb-bg-subtle)]"
                        >
                          <span className="min-w-0 flex-1 truncate">{s.name}</span>
                          <Icon name="plus" size={12} className="shrink-0 text-[color:var(--wb-muted)]" />
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* 发布的应用：只收在编排画布里（不进主菜单），点一条切换到对应画布 */}
            <div ref={appsRef} className="relative">
              <Btn onClick={() => setAppsOpen(!appsOpen)}>
                <Icon name="layers" size={13} />
                发布的应用
                <Icon name="chevronDown" size={12} />
              </Btn>
              {appsOpen && (
                <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] py-1 shadow-[var(--wb-shadow-md)]">
                  {canvases.length === 0 && (
                    <div className="px-3 py-2 text-[11.5px] text-[color:var(--wb-muted)]">还没有画布</div>
                  )}
                  {canvases.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setAppsOpen(false)
                        if (c.id !== cid) loadCanvas(c.id)
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
                        c.id === cid
                          ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
                          : 'text-[color:var(--wb-text)] hover:bg-[color:var(--wb-bg-subtle)]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{String(c.name || '未命名画布')}</span>
                      <span className="shrink-0 text-[10.5px] tabular-nums text-[color:var(--wb-muted)]">
                        {Number(c.node_count) > 0 ? `${c.node_count} 节点` : '空'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* 低频操作收进「更多」，还工具栏一条干净的主线（Dify 式） */}
            <div ref={moreRef} className="relative">
              <Btn onClick={() => setMoreOpen(!moreOpen)}>
                <Icon name="menu" size={13} />
                更多
                <Icon name="chevronDown" size={12} />
              </Btn>
              {moreOpen && (
                <div className="absolute left-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] py-1 shadow-[var(--wb-shadow-md)]">
                  {[
                    {
                      icon: 'plus',
                      label: '新建画布',
                      onClick: () => createCanvas(),
                    },
                    {
                      icon: 'layers',
                      label: `模板库（${templates.length}）`,
                      onClick: () => setTplOpen(true),
                    },
                    {
                      icon: 'copy',
                      label: '存为模板',
                      onClick: saveAsTemplate,
                      title: '把当前这套流水线冻结成模板',
                    },
                    ...(layout === 'free'
                      ? [
                          {
                            icon: 'scan',
                            label: '适合视图',
                            onClick: () => fitRef.current?.(),
                            title: '把所有节点缩放到可视范围',
                          },
                        ]
                      : []),
                  ].map((it) => (
                    <button
                      key={it.label}
                      type="button"
                      title={it.title}
                      onClick={() => {
                        setMoreOpen(false)
                        it.onClick()
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[color:var(--wb-text)] hover:bg-[color:var(--wb-bg-subtle)]"
                    >
                      <Icon name={it.icon as any} size={13} className="text-[color:var(--wb-text-soft)]" />
                      {it.label}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-[color:var(--wb-border)]" />
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      delCanvas()
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[color:var(--wb-danger)] hover:bg-[color:var(--wb-danger-soft)]"
                  >
                    <Icon name="trash" size={13} />
                    删除画布
                  </button>
                </div>
              )}
            </div>
            <Btn
              onClick={toggleLeft}
              title={!leftOpen ? '展开技能库' : leftRail ? '展开技能库' : '把技能库收缩成图标条'}
            >
              {!leftOpen ? '▶ 技能' : leftRail ? '▶ 展开技能' : '◀ 收起技能'}
            </Btn>
            <Btn
              onClick={toggleRight}
              title={rightOpen ? '收起节点面板' : '展开节点面板'}
            >
              {rightOpen ? '节点 ▶' : '◀ 节点'}
            </Btn>
            <Btn
              onClick={toggleChat}
              title={chatOpen ? '收起对话面板' : '打开对话面板（用自然语言指挥画布）'}
              className={chatOpen ? '!border-[color:var(--wb-accent)] !bg-[color:var(--wb-accent-soft)] !text-[color:var(--wb-accent)]' : ''}
            >
              <Icon name="sparkle" size={13} />
              {chatOpen ? '收起对话' : '对话'}
            </Btn>
            <Btn
              onClick={toggleFocus}
              title={focus ? '退出浏览器全屏（Esc）' : '浏览器全屏：收起导航与左右面板，Esc 退出'}
              className={focus ? '!border-[color:var(--wb-accent)] !bg-[color:var(--wb-accent-soft)] !text-[color:var(--wb-accent)]' : ''}
            >
              <Icon name={focus ? 'minimize' : 'maximize'} size={13} />
              {focus ? '退出全屏' : '浏览器全屏'}
            </Btn>
          </div>

          {/* 第二行：一句话搭画布（低频，默认折叠；浏览器全屏时不占画布高度） */}
          {!focus && (autoOpen ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2">
              <span className="text-[11.5px] font-medium text-[color:var(--wb-accent)]">
                <Icon name="sparkle" size={13} />
                一句话搭画布
              </span>
              <Input
                value={autoTopic}
                onChange={setAutoTopic}
                className="!w-40"
                placeholder="选题，如 ai单元测试"
              />
              <Input
                value={autoConstraint}
                onChange={setAutoConstraint}
                className="!w-52"
                placeholder="约束（时间 / 算力）"
              />
              <Btn onClick={autoBuild} loading={autoing}>
                {autoing ? '搭建中…' : '自动编排'}
              </Btn>
              <Select
                value=""
                onChange={(v) => v && createCanvas(v)}
                options={[
                  { value: '', label: '从模板新建…' },
                  ...templates.map((t) => ({
                    value: t.key,
                    label: `${t.name}${t.builtin === false ? '（我存的）' : ''}`,
                  })),
                ]}
              />
              <Btn size="sm" onClick={() => setAutoOpen(false)} title="收起这一行">
                <Icon name="chevronUp" size={12} />
                收起
              </Btn>
            </div>
          ) : (
            <div className="flex items-center justify-end border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-1">
              <button
                type="button"
                onClick={() => setAutoOpen(true)}
                className="flex items-center gap-1 text-[11.5px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-accent)]"
              >
                <Icon name="sparkle" size={12} />
                一句话搭画布 / 从模板新建
                <Icon name="chevronDown" size={11} />
                <span className="ml-3">
                  {nodes.length} {layout === 'fixed' ? '步骤' : '节点'}
                  {autoWhy ? ` · ${autoWhy}` : ''}
                </span>
              </button>
            </div>
          ))}
        </div>

        {runErr && (
          <div className="shrink-0 border-b border-[color:var(--wb-border)] px-3 py-2">
            <AiError
              error={runErr}
              onRetry={() => run()}
              retrying={running}
              title={runErr.label}
            />
          </div>
        )}
        {!runErr && Object.keys(runErrors).length > 0 && (
          <div className="shrink-0 border-b border-[color:var(--wb-border)] px-3 py-2">
            <div className="rounded-[10px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-3 py-2">
              <div className="text-[12px] font-medium text-[color:var(--wb-danger)]">
                有 {Object.keys(runErrors).length} 个节点运行失败
              </div>
              <div className="mt-1 flex flex-col gap-1">
                {Object.entries(runErrors)
                  .slice(0, 3)
                  .map(([k, e]: any) => (
                    <div key={k} className="text-[11.5px] text-[color:var(--wb-text-soft)]">
                      <span className="mr-1 rounded bg-[color:var(--wb-surface)] px-1.5 py-[1px] text-[10.5px]">
                        {k}
                      </span>
                      {e?.label || '失败'}：{e?.message || '未知原因'}
                    </div>
                  ))}
              </div>
              <div className="mt-1.5">
                <Btn size="sm" variant="danger" onClick={() => run()} loading={running}>
                  整图重跑
                </Btn>
              </div>
            </div>
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {/* Dify 式浮动工具条：六个按钮都调真实动作，不摆纯装饰 */}
          <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-0.5 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-1 shadow-[var(--wb-shadow-sm)]">
            {(
              [
                { icon: 'plus', label: '添加自定义节点', run: () => addNode('prompt', '', 120, 120) },
                { icon: 'refresh', label: '适合视图', run: () => fitRef.current?.() },
                {
                  icon: 'search',
                  label: leftOpen && !leftRail ? '收缩技能库' : '展开技能库',
                  run: toggleLeft,
                  active: leftOpen && !leftRail,
                },
                {
                  icon: 'pencil',
                  label: '一句话搭画布',
                  run: () => setAutoOpen(!autoOpen),
                  active: autoOpen,
                },
                { icon: 'layers', label: '模板库', run: () => setTplOpen(true) },
                { icon: 'file', label: '新建画布', run: () => createCanvas() },
                {
                  icon: focus ? 'minimize' : 'maximize',
                  label: focus ? '退出浏览器全屏' : '浏览器全屏画布',
                  run: toggleFocus,
                  active: focus,
                },
              ] as { icon: IconName; label: string; run: () => void; active?: boolean }[]
            ).map((t) => (
              <button
                key={t.label}
                type="button"
                title={t.label}
                aria-label={t.label}
                onClick={t.run}
                className={`wb-press-strong flex h-7 w-7 items-center justify-center rounded-[6px] transition ${
                  t.active
                    ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                    : 'text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'
                }`}
              >
                <Icon name={t.icon} size={14} />
              </button>
            ))}
          </div>

          {/* 运行时中央状态胶囊：对应参考图的「同步数据中」，但显示的是真实节点进度 */}
          {running && (
            <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-1.5 text-[11px] text-[color:var(--wb-text-soft)] shadow-[var(--wb-shadow-sm)]">
              <span className="wb-spinner" />
              {runStatus === 'queued' ? '排队中' : `运行中 · ${runDone}/${runTotal} 节点`}
            </div>
          )}
          {/* 右侧悬浮助手：打开「用自然语言指挥画布」的对话面板，不是装饰按钮 */}
          <button
            type="button"
            onClick={toggleChat}
            title={chatOpen ? '收起对话' : '用自然语言指挥画布'}
            aria-label="画布助手"
            className="wb-press-strong absolute right-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-accent)] shadow-[var(--wb-shadow-md)]"
          >
            <Icon name="sparkle" size={15} />
          </button>

          {/* 底部：撤销 / 重做 + 输出缓存。撤销只覆盖增删移复制，拖拽位置不入历史 */}
          <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-1 text-[11px] shadow-[var(--wb-shadow-sm)]">
            <button
              type="button"
              onClick={undo}
              disabled={!histRef.current.past.length}
              title="撤销上一步新增 / 删除 / 移动 / 复制（拖拽位置不入历史）"
              className="wb-press-soft flex items-center gap-1 text-[color:var(--wb-text-soft)] hover:text-[color:var(--wb-accent)] disabled:opacity-35"
            >
              <Icon name="reply" size={12} />
              撤销
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!histRef.current.future.length}
              title="重做"
              className="wb-press-soft flex items-center gap-1 text-[color:var(--wb-text-soft)] hover:text-[color:var(--wb-accent)] disabled:opacity-35"
            >
              <Icon name="arrowRight" size={12} />
              重做
            </button>
            <button
              type="button"
              onClick={() => nav('/canvas?tab=logs')}
              title="运行历史"
              aria-label="运行历史"
              className="wb-press-strong flex h-5 w-5 items-center justify-center rounded text-[color:var(--wb-muted)] hover:text-[color:var(--wb-accent)]"
            >
              <Icon name="clock" size={12} />
            </button>
            <span className="mx-1 h-3 w-px bg-[color:var(--wb-border)]" />
            <button
              type="button"
              onClick={() => setCacheOpen(true)}
              className="wb-press-soft text-[color:var(--wb-accent)] hover:underline"
            >
              查看缓存{Object.keys(outputs).length ? ` (${Object.keys(outputs).length})` : ''}
            </button>
            <button
              type="button"
              onClick={() => {
                setOutMap((p) => {
                  const next = { ...p }
                  delete next[outKey]
                  return next
                })
                flash('已清除当前画布的输出缓存', 'ok')
              }}
              className="wb-press-soft text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]"
            >
              清除
            </button>
          </div>

          {layout === 'fixed' ? (
            <FixedFlow
              nodes={nodes}
              sel={sel}
              outputs={outputs}
              metas={metas}
              runErrors={runErrors}
              running={running}
              tipSeen={tipSeen}
              onDismissTip={() => setTipSeen(true)}
              onSelect={setSel}
              onAdd={(ntype, skillId) => addNode(ntype, skillId, 0, 0)}
              onMove={moveNode}
              onDelete={delNode}
              onRun={(key) => run(key)}
              onExpandOutput={(key) => {
                setSel(key)
                setBigOut(true)
              }}
            />
          ) : (
            <ReactFlowProvider>
              <FitBridge fitRef={fitRef} />
              <Flow
                nodes={nodes}
                setNodes={setNodes}
                edges={edges}
                setEdges={setEdges}
                onSelect={(k) => {
                  setSel(k)
                  setCtx(null)
                }}
                onDropSkill={(sid, x, y) => addNode('skill', sid, x, y)}
                onNodeContext={(e, key) => {
                  setPaneCtx(null)
                  setCtx({ x: e.clientX, y: e.clientY, key })
                }}
                onPaneContext={(e, pos) => {
                  setCtx(null)
                  setPaneCtx({ x: e.clientX, y: e.clientY, fx: pos.x, fy: pos.y })
                }}
              />
            </ReactFlowProvider>
          )}
          {/* 空态浮层只属于自由画布：固定框有自己内置的「还没有步骤」空态，别叠在一起 */}
          {layout !== 'fixed' && nodes.length === 0 && !chatOpen && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className="pointer-events-auto max-w-md rounded-[16px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]/95 p-5 text-center shadow-[var(--wb-shadow-md)]">
                <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-[10px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
                  <Icon name="layers" size={17} />
                </div>
                <div className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">
                  这块画布还是空的
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--wb-muted)]">
                  从左侧技能面板拖节点进来，或点右上「对话」用自然语言让我帮你搭一条流水线。
                </p>
                <Btn className="mt-3" onClick={toggleChat}>
                  <Icon name="sparkle" size={13} />
                  打开对话搭画布
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右：节点配置与输出。左边缘可拖宽（双击复位），标题栏 × 直接关掉 */}
      {!focus && rightOpen && (
        <>
          <ResizeHandle
            width={rightW}
            onResize={setRightW}
            onReset={() => setRightW(368)}
            edge="before"
            min={280}
            max={640}
            label="调整节点面板宽度"
          />
          <div
            className="flex shrink-0 flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]"
            style={{ width: rightW }}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2">
              <span className="text-[12px] font-semibold text-[color:var(--wb-text)]">节点</span>
              <div className="flex items-center gap-1">
                {sel && (outputs[sel] || '') && (
                  <Btn size="sm" onClick={() => setBigOut(true)} title="在大窗口里读完整输出">
                    展开输出
                  </Btn>
                )}
                <IconBtn
                  icon="close"
                  title="关闭节点面板（工具栏「节点」可再打开）"
                  ariaLabel="关闭节点面板"
                  onClick={() => setRightOpen(false)}
                />
              </div>
            </div>
            <NodeInspector
              node={selNode}
              skills={skills}
              providers={providers}
              difyApps={difyApps}
              difyBase={difyBase}
              difyEnabled={difyEnabled}
              output={sel ? outputs[sel] || '' : ''}
              meta={sel ? metas[sel] : null}
              running={running}
              runs={runs}
              error={sel ? runErrors[sel] || null : null}
              onPatch={(fn) => sel && patch(sel, fn)}
              onRun={() => sel && run(sel)}
              onDelete={() => sel && delNode(sel)}
              onSaveOutput={saveOutput}
              onMakeQuest={makeQuest}
              onOpenSource={openSource}
              onExpandOutput={() => setBigOut(true)}
            />
          </div>
        </>
      )}

      {/* 对话操作面板（Undermind 版式：消息胶囊 + Worked for/Thinking 折叠 + 快捷操作 + 圆角输入框） */}
      {!focus && chatOpen && (
        <ChatPanel
          title={name ? `画布对话 · ${name}` : '画布对话'}
          messages={messages}
          busy={chatBusy}
          busyNote={chatStage || undefined}
          input={chatInput}
          onInput={setChatInput}
          onSend={sendChat}
          onClose={() => setChatOpen(false)}
          onClear={() => setMessages([])}
          chips={CANVAS_CHIPS}
          samples={CANVAS_SAMPLES}
          exportName={`画布对话-${name || '未命名'}`}
        />
      )}

      {/* 输出展开：侧栏 23rem 装不下长结果，这里给一个居中的大窗口 */}
      <Modal
        open={bigOut && !!sel}
        onClose={() => setBigOut(false)}
        title={`输出 · ${selNode?.data?.title || sel || ''}`}
        width="max-w-4xl"
        footer={
          <Btn onClick={() => setBigOut(false)}>关闭</Btn>
        }
      >
        {sel && runErrors[sel] ? (
          <AiError
            error={runErrors[sel]}
            onRetry={() => run(sel)}
            retrying={running}
            title="这个节点运行失败"
          />
        ) : (
          <div className="max-h-[60vh] overflow-y-auto rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2">
            <MdBlock text={sel ? outputs[sel] || '' : ''} />
          </div>
        )}
      </Modal>

      {/* 查看缓存：列出当前画布每个节点的真实输出（来自运行落库 / 本地 outMap） */}
      <Modal
        open={cacheOpen}
        onClose={() => setCacheOpen(false)}
        title="节点输出缓存"
        width="max-w-4xl"
        footer={<Btn onClick={() => setCacheOpen(false)}>关闭</Btn>}
      >
        {Object.keys(outputs).length === 0 ? (
          <div className="py-8 text-center text-[12px] leading-relaxed text-[color:var(--wb-muted)]">
            还没有节点输出。运行一次画布后，每个节点的结果会缓存在这里。
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {Object.entries(outputs).map(([k, v]) => (
              <div
                key={k}
                className="rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2"
              >
                <div className="mb-1 font-mono text-[11px] text-[color:var(--wb-text-soft)]">
                  {k} · {nodes.find((n) => n.id === k)?.data.title || ''}
                </div>
                <MdBlock text={String(v)} />
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* 右键空白处菜单：就地添加节点，不必拖拽 */}
      {paneCtx && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setPaneCtx(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setPaneCtx(null)
          }}
          onWheel={() => setPaneCtx(null)}
        >
          <div
            className="absolute w-52 overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] py-1.5 shadow-[var(--wb-shadow-lg)]"
            style={{
              left: Math.min(paneCtx.x, window.innerWidth - 224),
              top: Math.min(paneCtx.y, window.innerHeight - 300),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 border-b border-[color:var(--wb-border)] px-3 pb-1.5 text-[11px] text-[color:var(--wb-muted)]">
              添加节点
            </div>
            {[
              {
                icon: 'file',
                label: '输入节点',
                run: () => addNode('input', '', paneCtx.fx, paneCtx.fy),
              },
              {
                icon: 'pencil',
                label: '自定义节点',
                run: () => addNode('prompt', '', paneCtx.fx, paneCtx.fy),
              },
              {
                icon: 'wand',
                label: '技能节点（稍后在右侧选技能）',
                run: () => addNode('skill', '', paneCtx.fx, paneCtx.fy),
              },
              {
                icon: 'send',
                label: '输出节点',
                run: () => addNode('output', '', paneCtx.fx, paneCtx.fy),
              },
            ].map((it) => (
              <button
                key={it.label}
                type="button"
                onClick={() => {
                  setPaneCtx(null)
                  it.run()
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[color:var(--wb-text)] hover:bg-[color:var(--wb-bg-subtle)]"
              >
                <Icon name={it.icon as any} size={13} className="text-[color:var(--wb-text-soft)]" />
                {it.label}
              </button>
            ))}
            <div className="my-1 h-px bg-[color:var(--wb-border)]" />
            <button
              type="button"
              onClick={() => {
                setPaneCtx(null)
                fitRef.current?.()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[color:var(--wb-text)] hover:bg-[color:var(--wb-bg-subtle)]"
            >
              <Icon name="scan" size={13} className="text-[color:var(--wb-text-soft)]" />
              适合视图
            </button>
            <button
              type="button"
              onClick={() => {
                setPaneCtx(null)
                setTplOpen(true)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[color:var(--wb-text)] hover:bg-[color:var(--wb-bg-subtle)]"
            >
              <Icon name="layers" size={13} className="text-[color:var(--wb-text-soft)]" />
              模板库
            </button>
          </div>
        </div>
      )}

      {/* 节点右键菜单（Dify 式）：任意点击 / 滚轮即关闭 */}
      {ctx && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setCtx(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setCtx(null)
          }}
          onWheel={() => setCtx(null)}
        >
          <div
            className="absolute w-52 overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] py-1.5 shadow-[var(--wb-shadow-lg)]"
            style={{
              left: Math.min(ctx.x, window.innerWidth - 224),
              top: Math.min(ctx.y, window.innerHeight - 260),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 truncate border-b border-[color:var(--wb-border)] px-3 pb-1.5 text-[11px] text-[color:var(--wb-muted)]">
              {nodes.find((n) => n.id === ctx.key)?.data.title || ctx.key}
            </div>
            {[
              {
                icon: 'refresh',
                label: '运行此步骤',
                disabled: running,
                onClick: () => run(ctx.key),
              },
              {
                icon: 'gear',
                label: '打开配置',
                disabled: false,
                onClick: () => setSel(ctx.key),
              },
              {
                icon: 'file',
                label: '展开输出',
                disabled: !(outputs[ctx.key] || '').trim(),
                onClick: () => {
                  setSel(ctx.key)
                  setBigOut(true)
                },
              },
              {
                icon: 'copy',
                label: '复制节点',
                disabled: false,
                onClick: () => dupNode(ctx.key),
              },
            ].map((it) => (
              <button
                key={it.label}
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setCtx(null)
                  it.onClick()
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
                  it.disabled
                    ? 'cursor-not-allowed text-[color:var(--wb-muted)]'
                    : 'text-[color:var(--wb-text)] hover:bg-[color:var(--wb-bg-subtle)]'
                }`}
              >
                <Icon name={it.icon as any} size={13} className="text-[color:var(--wb-text-soft)]" />
                {it.label}
              </button>
            ))}
            <div className="my-1 h-px bg-[color:var(--wb-border)]" />
            <button
              type="button"
              onClick={() => {
                setCtx(null)
                delNode(ctx.key)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[color:var(--wb-danger)] hover:bg-[color:var(--wb-danger-soft)]"
            >
              <Icon name="trash" size={13} />
              删除节点
            </button>
          </div>
        </div>
      )}

      <TemplateManager
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        templates={templates}
        onUse={async (key) => {
          setTplOpen(false)
          await createCanvas(key)
        }}
        onDelete={delTemplate}
      />

      <SkillMarket
        open={marketOpen}
        onClose={() => setMarketOpen(false)}
        onInstalled={reloadSkills}
      />

      {/* GitHub 原版 SKILL.md 查看器 */}
      {viewer && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-[rgba(16,24,40,0.32)]"
          onClick={() => setViewer(null)}
        >
          <div
            className="wb-anim-slide flex h-full w-[46rem] max-w-[92vw] flex-col bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[color:var(--wb-border)] px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--wb-text)]">
                  <span className="truncate">{viewer.name}</span>
                  <span className="shrink-0 rounded-full bg-[color:var(--wb-ok-soft)] px-2 py-[1px] text-[11.5px] text-[color:var(--wb-ok)]">
                    GitHub 原版 · 未改写
                  </span>
                </div>
                <div className="truncate text-[11.5px] text-[color:var(--wb-muted)]">
                  {viewer.repo} / {viewer.id} · {viewer.files.length} 个文件 · SKILL.md 原文{' '}
                  {viewer.body.length} 字
                </div>
              </div>
              <Btn onClick={() => setViewer(null)}>关闭</Btn>
            </div>

            <div className="flex min-h-0 flex-1">
              <div className="w-52 shrink-0 overflow-y-auto border-r border-[color:var(--wb-border)] p-2">
                <div
                  className={`mb-1 cursor-pointer rounded-[7px] px-2 py-1 text-[11.5px] ${
                    !viewer.file
                      ? 'bg-[color:var(--wb-accent)] text-white'
                      : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                  }`}
                  onClick={() => setViewer({ ...viewer, file: '', fileText: '' })}
                >
                  SKILL.md
                </div>
                {viewer.files.map((f: any) => (
                  <div
                    key={f.path}
                    className={`mb-0.5 cursor-pointer truncate rounded-[7px] px-2 py-1 text-[11.5px] ${
                      viewer.file === f.path
                        ? 'bg-[color:var(--wb-accent)] text-white'
                        : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                    }`}
                    title={f.path}
                    onClick={() => openFile(f.path)}
                  >
                    {f.path}
                  </div>
                ))}
              </div>
              <div className="min-w-0 flex-1 overflow-y-auto p-4">
                {vbusy ? (
                  <div className="text-[12px] text-[color:var(--wb-muted)]">读取中…</div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                    {viewer.file ? viewer.fileText : viewer.body}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

/** 头像色板与 App.tsx 同源：选择页卡片图标瓦片按 id 区分 */
const PICKER_HUES = [240, 268, 300, 336, 12, 32, 152, 190]

/**
 * 编排入口的「发布的应用」选择页：/canvas 无 ?cid= 时先看小卡片，点具体应用才进编排面板。
 * 卡片 = 一块画布，点卡片 → /canvas?tab=build&cid=N；也可就地新建。
 */
function CanvasPicker() {
  const nav = useNavigate()
  const [items, setItems] = useState<any[] | null>(null)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  // 新建先命名：弹一个小框让用户起名，别默默塞一个「新画布」
  const [createOpen, setCreateOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  useEffect(() => {
    let alive = true
    get<any>('/canvas')
      .then((d) => {
        if (alive) setItems(Array.isArray(d) ? d : d?.canvases || [])
      })
      .catch(() => {
        if (alive) setItems([])
      })
    return () => {
      alive = false
    }
  }, [])

  const create = async () => {
    const n = nameDraft.trim() || '新画布'
    setCreating(true)
    try {
      const r = await post<any>('/canvas', { name: n, template: null })
      setCreateOpen(false)
      setNameDraft('')
      nav(`/canvas?tab=build&cid=${r.id}`)
    } finally {
      setCreating(false)
    }
  }

  const shown = (items || []).filter((c) =>
    q.trim() ? String(c.name || '').toLowerCase().includes(q.trim().toLowerCase()) : true,
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-7 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[17px] font-semibold tracking-[-0.01em] text-[color:var(--wb-text)]">
              发布的应用
            </div>
            <div className="mt-0.5 text-[11.5px] text-[color:var(--wb-muted)]">
              点一个应用进入它的编排画布；每块画布就是一个应用
            </div>
          </div>
          <Btn variant="primary" onClick={() => { setNameDraft(''); setCreateOpen(true) }}>
            <Icon name="plus" size={13} />
            新建画布
          </Btn>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Input value={q} onChange={setQ} placeholder="搜索应用…" className="!w-64" />
          <span className="text-[11.5px] text-[color:var(--wb-muted)]">按最近修改排序</span>
        </div>

        {items === null ? (
          <Loading text="正在加载应用列表…" />
        ) : items.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[color:var(--wb-border)] py-14 text-center">
            <Icon name="layers" size={26} className="text-[color:var(--wb-muted)]" />
            <div className="text-[13px] font-medium text-[color:var(--wb-text)]">还没有发布的应用</div>
            <div className="text-[11.5px] text-[color:var(--wb-muted)]">
              每块画布就是一个应用；点右上「新建画布」，或用模板 / 一句话搭画布生成流水线。
            </div>
            <Btn variant="primary" onClick={() => { setNameDraft(''); setCreateOpen(true) }}>
              <Icon name="plus" size={13} />
              创建第一块画布
            </Btn>
          </div>
        ) : shown.length === 0 ? (
          <div className="mt-8 text-center text-[12px] text-[color:var(--wb-muted)]">
            没有匹配「{q}」的应用，换个关键词试试。
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {shown.map((c) => {
              const hue = PICKER_HUES[(c.id || 0) % PICKER_HUES.length]
              const name = String(c.name || '未命名画布')
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => nav(`/canvas?tab=build&cid=${c.id}`)}
                  title={`进入「${name}」的编排画布`}
                  className="wb-press-soft flex flex-col rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-2.5 text-left shadow-[var(--wb-shadow-xs)] transition hover:border-[color:var(--wb-accent)]/55 hover:shadow-[var(--wb-shadow-sm)]"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-[12px] font-bold text-white"
                      style={{
                        backgroundImage: `linear-gradient(145deg, hsl(${hue} 62% 58%), hsl(${(hue + 34) % 360} 64% 42%))`,
                      }}
                    >
                      {name.slice(0, 1)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-[color:var(--wb-text)]">{name}</div>
                      <div className="truncate text-[10.5px] text-[color:var(--wb-muted)]">
                        {Number(c.node_count) > 0 ? `${c.node_count} 节点` : '空画布'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-1 border-t border-[color:var(--wb-border)] pt-1.5 text-[10.5px] text-[color:var(--wb-muted)]">
                    <Icon name="pencil" size={10} />
                    进入编排
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* 新建先命名：起个名字再进编排，避免一串「新画布」分不清 */}
        <Modal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          title="新建画布"
          width="max-w-sm"
          footer={
            <>
              <Btn onClick={() => setCreateOpen(false)}>取消</Btn>
              <Btn variant="primary" loading={creating} onClick={create}>
                创建并进入编排
              </Btn>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Input
              value={nameDraft}
              onChange={setNameDraft}
              placeholder="给画布起个名字，如：ai 单元测试流水线"
              ariaLabel="画布名称"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating) create()
              }}
            />
            <div className="text-[11px] text-[color:var(--wb-muted)]">
              进了编排之后随时可以在工具栏重命名；回车直接创建。
            </div>
          </div>
        </Modal>
      </div>
    </div>
  )
}

/**
 * 画布应用入口：四个视图（编排 / 访问点 / 日志 / 监测）共用 /canvas 路由，
 * ?tab= 是唯一真源，与文献页的分区约定一致；左侧主导航直接链到各 tab。
 * 编排视图两级进入：无 ?cid= 先看「发布的应用」小卡片，点具体应用才渲染编排面板。
 */
export default function Canvas() {
  const [params] = useSearchParams()
  const tab = params.get('tab') || 'build'
  if (tab === 'access') return <CanvasAccess />
  if (tab === 'logs') return <CanvasLogs />
  if (tab === 'monitor') return <CanvasMonitor />
  if (!params.get('cid')) return <CanvasPicker />
  return <CanvasBoard />
}
