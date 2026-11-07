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
  type Connection,
  type Edge,
} from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Btn, IconBtn, Input, Loading, MdBlock, Modal, Segmented, Select, StatusTag } from '../components/ui'
import { AiError } from '../components/AiError'
import { toast } from '../components/toast'
import { Icon } from '../components/Icon'
import { api, get, post } from '../lib/api'
import { usePersist } from '../lib/state'
import SkillPalette from '../features/canvas/SkillPalette'
import FixedFlow from '../features/canvas/FixedFlow'
import NodeInspector, { type RunInfo } from '../features/canvas/NodeInspector'
import TemplateManager, { type TemplateInfo } from '../features/canvas/TemplateManager'
import { nodeTypes, TYPE_LABEL, TYPE_TILE, type CData, type CNode, type Skill } from '../features/canvas/canvas-shared'
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

/** ReactFlow 画布本体。只有它需要 useReactFlow，所以单独一层。 */
function Flow({
  nodes,
  setNodes,
  edges,
  setEdges,
  onSelect,
  onDropSkill,
}: {
  nodes: CNode[]
  setNodes: any
  edges: Edge[]
  setEdges: any
  onSelect: (key: string | null) => void
  onDropSkill: (skillId: string, x: number, y: number) => void
}) {
  const { screenToFlowPosition } = useReactFlow()

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
      className="h-full w-full"
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
    </div>
  )
}

/** 编排画布工作台（/canvas）：独立路由，不再作为 Chat 的 tab；
 *  顶部工作台切换条由 App 层统一渲染。 */
export default function Canvas() {
  const nav = useNavigate()
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
  const [leftOpen, setLeftOpen] = usePersist('canvas.leftOpen', true)
  const [rightOpen, setRightOpen] = usePersist('canvas.rightOpen', true)
  // 对话操作面板（Undermind 式：自然语言指挥画布）
  const [chatOpen, setChatOpen] = usePersist('canvas.chatOpen', false)
  const [chatInput, setChatInput] = usePersist('canvas.chatInput', '')
  const [messages, setMessages] = usePersist<ChatMsg[]>('canvas.chatMsgs.v2', [])
  const [chatBusy, setChatBusy] = useState(false)
  // 输出展开成居中大窗（侧栏 23rem 装不下长文本）
  const [bigOut, setBigOut] = useState(false)
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

  // 进入页面时恢复上次打开的画布（cid 已持久化）；无效则打开第一个
  const bootedRef = useRef(false)
  useEffect(() => {
    if (loading || bootedRef.current || !canvases.length) return
    bootedRef.current = true
    const target = cid !== null && canvases.some((c) => c.id === cid) ? cid : canvases[0].id
    loadCanvas(target)
  }, [loading, canvases, cid, loadCanvas])

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
    setNodes((nds) => nds.filter((n) => n.id !== key))
    setEdges((eds: Edge[]) => eds.filter((e) => e.source !== key && e.target !== key))
    setSel(null)
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
    } finally {
      setSaving(false)
    }
  }

  const saveOnly = async () => {
    await save()
    flash('已保存', 'ok')
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
    const t0 = Date.now()
    try {
      const r = await post<any>(`/canvas/${cid}/chat`, { instruction: text, history }, { ok: false })
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
      {leftOpen && (
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
      />
      )}

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
            <Input value={name} onChange={setName} className="!w-44" placeholder="画布名称" />
            <Btn onClick={saveOnly} loading={saving}>
              保存
            </Btn>
            <Btn variant="primary" onClick={() => run()} disabled={running} loading={running}>
              运行整图
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
            <Btn onClick={() => createCanvas()}>新建</Btn>
            <Btn onClick={() => setTplOpen(true)}>模板库（{templates.length}）</Btn>
            <Btn onClick={saveAsTemplate} title="把当前这套流水线冻结成模板">
              存为模板
            </Btn>
            <Btn variant="danger" onClick={delCanvas}>
              删除画布
            </Btn>
            <span className="mx-1 hidden h-4 w-px bg-[color:var(--wb-border)] sm:block" />
            {layout === 'free' && (
              <Btn onClick={() => fitRef.current?.()} title="把所有节点缩放到可视范围">
                适合视图
              </Btn>
            )}
            <Btn
              onClick={() => setLeftOpen(!leftOpen)}
              title={leftOpen ? '收起技能面板' : '展开技能面板'}
            >
              {leftOpen ? '◀ 收起技能' : '▶ 技能'}
            </Btn>
            <Btn
              onClick={() => setRightOpen(!rightOpen)}
              title={rightOpen ? '收起节点面板' : '展开节点面板'}
            >
              {rightOpen ? '节点 ▶' : '◀ 节点'}
            </Btn>
            <Btn
              onClick={() => setChatOpen(!chatOpen)}
              title={chatOpen ? '收起对话面板' : '打开对话面板（用自然语言指挥画布）'}
              className={chatOpen ? '!border-[color:var(--wb-accent)] !bg-[color:var(--wb-accent-soft)] !text-[color:var(--wb-accent)]' : ''}
            >
              <Icon name="sparkle" size={13} />
              {chatOpen ? '收起对话' : '对话'}
            </Btn>
          </div>

          {/* 第二行：一句话搭画布 */}
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
            <span className="ml-auto truncate text-[11.5px] text-[color:var(--wb-muted)]">
              {nodes.length} {layout === 'fixed' ? '步骤' : '节点'} /{' '}
              {layout === 'fixed' ? Math.max(0, nodes.length - 1) : edges.length} 连线 ·{' '}
              {layout === 'fixed' ? '顺序即执行顺序' : '点节点看配置与输出'}
              {autoWhy ? ` · ${autoWhy}` : ''}
            </span>
          </div>
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
                onSelect={setSel}
                onDropSkill={(sid, x, y) => addNode('skill', sid, x, y)}
              />
            </ReactFlowProvider>
          )}
          {nodes.length === 0 && !chatOpen && (
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
                <Btn className="mt-3" onClick={() => setChatOpen(true)}>
                  <Icon name="sparkle" size={13} />
                  打开对话搭画布
                </Btn>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右：节点配置与输出 */}
      {rightOpen && (
      <div className="flex w-[23rem] shrink-0 flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2">
          <span className="text-[12px] font-semibold text-[color:var(--wb-text)]">节点</span>
          {sel && (outputs[sel] || '') && (
            <Btn size="sm" onClick={() => setBigOut(true)} title="在大窗口里读完整输出">
              展开输出
            </Btn>
          )}
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
      )}

      {/* 对话操作面板（Undermind 版式：消息胶囊 + Worked for/Thinking 折叠 + 快捷操作 + 圆角输入框） */}
      {chatOpen && (
        <ChatPanel
          title={name ? `画布对话 · ${name}` : '画布对话'}
          messages={messages}
          busy={chatBusy}
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
