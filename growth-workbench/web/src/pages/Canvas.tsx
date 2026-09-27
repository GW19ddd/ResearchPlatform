import '@xyflow/react/dist/style.css'
import {
  Background,
  Controls,
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
import { Btn, Input, Loading, MdBlock, Modal, Select, StatusTag } from '../components/ui'
import { AiError } from '../components/AiError'
import { toast } from '../components/toast'
import { api, get, post } from '../lib/api'
import { usePersist } from '../lib/state'
import SkillPalette from '../features/canvas/SkillPalette'
import NodeInspector, { type RunInfo } from '../features/canvas/NodeInspector'
import TemplateManager, { type TemplateInfo } from '../features/canvas/TemplateManager'
import { nodeTypes, TYPE_LABEL, type CData, type CNode, type Skill } from '../features/canvas/canvas-shared'

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
        edges={edges}
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
        <Background gap={16} size={1} color="#dce1ea" />
        <Controls className="!bottom-3 !left-3" />
        <MiniMap
          pannable
          zoomable
          className="!bottom-3 !right-3 !h-20 !w-32 !rounded-[10px] !border !border-[color:var(--wb-border)]"
          maskColor="rgba(16,24,40,0.08)"
        />
      </ReactFlow>
    </div>
  )
}

export default function Canvas() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [cats, setCats] = useState<{ name: string; skills: Skill[] }[]>([])
  const [canvases, setCanvases] = useState<any[]>([])
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [cid, setCid] = usePersist<number | null>('canvas.cid', null)
  const [name, setName] = useState('')
  const [nodes, setNodes] = useState<CNode[]>([])
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
  // 面板折叠：宽屏要的是更大的画布，不是更长的正文
  const [leftOpen, setLeftOpen] = usePersist('canvas.leftOpen', true)
  const [rightOpen, setRightOpen] = usePersist('canvas.rightOpen', true)
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

  const flash = (t: string, tone: 'ok' | 'error' | 'info' = 'info') => toast(t, tone)

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
      const ns: CNode[] = (d.nodes || []).map((n: any) => ({
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

  // ---------------------------------------------------------------- 节点操作

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
          title: sk ? sk.name : `${TYPE_LABEL[ntype] || '节点'}节点`,
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
        edges: edges.map((e: Edge) => ({ source_key: e.source, target_key: e.target })),
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
   * 运行：后端是后台任务，这里负责轮询真实状态。
   *
   * 以前这个接口是同步阻塞的，前端只能干等；现在改成「发起 → 轮询 → 逐个节点更新状态」，
   * 期间可以取消，也能看到第几个节点正在跑。
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

    const apply = (outs: any[]) => {
      const st: Record<string, 'done' | 'error' | 'running'> = {}
      const errs: Record<string, any> = {}
      outs.forEach((o: any) => {
        st[o.node_key] = o.ok === false ? 'error' : 'done'
        if (o.ok === false) errs[o.node_key] = o.error || {}
      })
      setNodes((nds) =>
        nds.map((n) => (st[n.id] ? { ...n, data: { ...n.data, status: st[n.id] } } : n)),
      )
      setRunErrors((p) => ({ ...p, ...errs }))
      setRunDone(Object.keys(st).length)
      return st
    }

    try {
      const r = await post<any>(
        `/canvas/${cid}/run`,
        { node_key: nodeKey || null },
        { silent: true },
      )
      const rid = Number(r.run_id)
      setRunId(rid)
      setRunStatus('running')

      let detail: any = null
      let last: Record<string, string> = {}
      const deadline = Date.now() + 30 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 700))
        detail = await get<any>(`/canvas/runs/${rid}`)
        const st = apply(detail.outputs || [])
        last = st
        setRunStatus(detail.run?.status || 'running')
        if (['done', 'failed', 'cancelled'].includes(detail.run?.status)) break
      }

      await refreshOutputs(cid)
      if (detail?.run?.stale) {
        flash(detail.run.message || '上次运行没有留下结果，重跑一次', 'error')
        setRunErr({ label: '运行中断', message: detail.run.message || '上次运行随服务中断结束了' })
      } else {
        const bad = Object.values(last).filter((s) => s === 'error').length
        const total = Object.keys(last).length
        const status = detail?.run?.status
        if (status === 'cancelled') flash('已取消这次运行', 'info')
        else if (bad) flash(`运行结束 · ${total} 个节点 · ${bad} 个失败`, 'error')
        else flash(`运行完成 · ${total} 个节点`, 'ok')
      }
    } catch (e: any) {
      setRunErr({ label: '运行失败', message: e?.message || String(e) })
      flash(`运行失败：${e?.message || e}`, 'error')
      setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, status: 'idle' } })))
    } finally {
      setRunning(false)
    }
  }

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
      flash(`已搭好「${r.name}」· ${r.nodes.length} 节点${fb}`, 'ok')
      if (r.rationale) setAutoWhy(r.rationale)
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
            <span aria-hidden className="text-[13px] text-[color:var(--wb-danger)]">
              ✕
            </span>
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
    <div className="flex h-full">
      {leftOpen && (
      <SkillPalette
        cats={shownCats}
        srcTab={srcTab}
        setSrcTab={setSrcTab}
        ghInfo={ghInfo}
        onOpenSource={openSource}
        onAddNode={addNode}
        onClone={async (url) => {
          const r = await post<any>('/canvas/skills/github/clone', { url }, { silent: true })
          flash(r.message || `已导入 ${r.skills_found} 个 skill`, 'ok')
          const s = await get<any>('/canvas/skills')
          setSkills(s.skills || [])
          setCats(s.categories || [])
          const g = await get<any>('/canvas/skills/github')
          setGhInfo({ count: g.count || 0, repos: g.repos || [] })
        }}
      />
      )}

      {/* 中：画布 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
          {/* 第一行：画布本身的操作 */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
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
            <Btn onClick={() => fitRef.current?.()} title="把所有节点缩放到可视范围">
              适合视图
            </Btn>
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
          </div>

          {/* 第二行：一句话搭画布 */}
          <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2">
            <span className="text-[11px] font-medium text-[color:var(--wb-accent)]">
              ✦ 一句话搭画布
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
            <span className="ml-auto truncate text-[11px] text-[color:var(--wb-muted)]">
              {nodes.length} 节点 / {edges.length} 连线 · 点节点看配置与输出
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

        <div className="min-h-0 flex-1">
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
          onOpenSource={openSource}
          onExpandOutput={() => setBigOut(true)}
        />
      </div>
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
                  <span className="shrink-0 rounded-full bg-[color:var(--wb-ok-soft)] px-2 py-[1px] text-[10px] text-[color:var(--wb-ok)]">
                    GitHub 原版 · 未改写
                  </span>
                </div>
                <div className="truncate text-[11px] text-[color:var(--wb-muted)]">
                  {viewer.repo} / {viewer.id} · {viewer.files.length} 个文件 · SKILL.md 原文{' '}
                  {viewer.body.length} 字
                </div>
              </div>
              <Btn onClick={() => setViewer(null)}>关闭</Btn>
            </div>

            <div className="flex min-h-0 flex-1">
              <div className="w-52 shrink-0 overflow-y-auto border-r border-[color:var(--wb-border)] p-2">
                <div
                  className={`mb-1 cursor-pointer rounded-[7px] px-2 py-1 text-[11px] ${
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
                    className={`mb-0.5 cursor-pointer truncate rounded-[7px] px-2 py-1 text-[11px] ${
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
  )
}
