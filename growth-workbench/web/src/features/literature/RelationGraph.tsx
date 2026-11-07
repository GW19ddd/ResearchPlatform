/**
 * 文献关联图：类似 ResearchRabbit。
 *
 * 选一篇种子文献 → 点「展开」从 OpenAlex 拉引用/被引 → 图谱化展示 →
 * 点击新节点继续展开，逐步发现相关文献。也可以拖拽两个节点手动建边。
 *
 * 数据层：lit_edges 表（source cites target），后端 /literature/graph 返回 nodes + edges + papers。
 * 可视化：@xyflow/react（已安装，画布模块在用），力导向布局纯前端算。
 */
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { Btn, Empty, LoadError, Loading, SearchInput } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { del, get, post } from '../../lib/api'

// ---- types ----

type Paper = {
  id: number
  title: string
  authors: string | null
  year: number | null
  venue: string | null
  status: string
  doi: string | null
  openalex_id: string | null
  note_count: number
  tags?: string | null
}

type LitEdge = {
  id: number
  source_id: number
  target_id: number
  edge_type: string
}

type PaperNodeData = Paper & { expanded: boolean }
type RFNode = Node<PaperNodeData, 'paper'>

// ---- constants ----

const STATUS_BAR: Record<string, string> = {
  todo: '#6b7280',
  reading: '#a15c07',
  done: '#067a45',
}

const STATUS_LABEL: Record<string, string> = {
  todo: '待读',
  reading: '在读',
  done: '已读',
}

const EDGE_COLOR = '#c5c9d0'
const ARROW_COLOR = '#8a94a6'

// ---- force-directed layout (pure, no deps) ----

function forceLayout(
  ids: string[],
  edges: { source: string; target: string }[],
  existing: Map<string, { x: number; y: number }>,
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>()
  for (const id of ids) {
    const ex = existing.get(id)
    pos.set(id, ex
      ? { x: ex.x, y: ex.y, vx: 0, vy: 0 }
      : { x: width / 2 + (Math.random() - 0.5) * 140, y: height / 2 + (Math.random() - 0.5) * 140, vx: 0, vy: 0 },
    )
  }
  const arr = Array.from(pos.keys())
  for (let iter = 0; iter < 250; iter++) {
    // repulsion
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = pos.get(arr[i])!
        const b = pos.get(arr[j])!
        const dx = a.x - b.x
        const dy = a.y - b.y
        const distSq = dx * dx + dy * dy || 1
        const dist = Math.sqrt(distSq)
        const f = 14000 / distSq
        a.vx += (dx / dist) * f
        a.vy += (dy / dist) * f
        b.vx -= (dx / dist) * f
        b.vy -= (dy / dist) * f
      }
    }
    // attraction (edges)
    for (const e of edges) {
      const a = pos.get(e.source)
      const b = pos.get(e.target)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (dist - 220) * 0.05
      a.vx += (dx / dist) * f
      a.vy += (dy / dist) * f
      b.vx -= (dx / dist) * f
      b.vy -= (dy / dist) * f
    }
    // apply + bounds + damping
    for (const [, p] of pos) {
      p.x += p.vx * 0.1
      p.y += p.vy * 0.1
      p.x = Math.max(100, Math.min(width - 100, p.x))
      p.y = Math.max(80, Math.min(height - 80, p.y))
      p.vx *= 0.85
      p.vy *= 0.85
    }
  }
  const out = new Map<string, { x: number; y: number }>()
  for (const [id, p] of pos) out.set(id, { x: p.x, y: p.y })
  return out
}

// ---- custom node ----

function PaperNode({ data, selected }: NodeProps<RFNode>) {
  const d = data as unknown as PaperNodeData
  const bar = STATUS_BAR[d.status || 'todo'] || STATUS_BAR.todo
  const stLabel = STATUS_LABEL[d.status || 'todo'] || d.status || '未知'
  const firstAuthor = d.authors ? d.authors.split(',')[0].trim() + (d.authors.includes(',') ? ' 等' : '') : ''

  return (
    <div
      className="relative rounded-[10px] border bg-[color:var(--wb-surface)] px-2.5 py-2 shadow-[var(--wb-shadow-sm)] transition hover:shadow-[var(--wb-shadow-md)]"
      style={{
        borderColor: selected ? 'var(--wb-accent)' : 'var(--wb-border)',
        borderWidth: selected ? 2 : 1,
        borderLeftWidth: 3,
        borderLeftColor: bar,
        width: 210,
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5" style={{ background: ARROW_COLOR, border: '2px solid #fff' }} />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5" style={{ background: ARROW_COLOR, border: '2px solid #fff' }} />

      <div className="line-clamp-2 text-[12px] font-medium leading-snug text-[color:var(--wb-text)]">
        {d.title}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[color:var(--wb-text-soft)]">
        {firstAuthor && <span className="truncate">{firstAuthor}</span>}
        {d.year && <span className="shrink-0">{'\u00b7'} {d.year}</span>}
      </div>
      {d.venue && (
        <div className="mt-0.5 truncate text-[10.5px] text-[color:var(--wb-muted)]">{d.venue}</div>
      )}
      <div className="mt-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] text-[color:var(--wb-muted)]">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: bar }} />
          {stLabel}
        </span>
        {d.expanded && (
          <span className="text-[10px] text-[color:var(--wb-accent)]">已展开</span>
        )}
      </div>
    </div>
  )
}

// import Handle + Position here to avoid circular issues

const nodeTypes = { paper: PaperNode }

// ---- main component ----

export default function RelationGraph({ onChanged }: { onChanged?: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [papers, setPapers] = useState<Paper[]>([])
  const [nodes, setNodes] = useState<RFNode[]>([])
  const [edges, setEdges] = useEdgesState<Edge>([]) as any
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [expanding, setExpanding] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  // ---- load graph data ----

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const g = await get('/literature/graph')
      setPapers(g.papers || [])
      rebuildGraph(g.nodes || [], g.edges || [], g.papers || [])
    } catch (e: any) {
      setError(e?.message || '关联图加载失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rebuildGraph = useCallback((
    graphNodes: Paper[],
    graphEdges: LitEdge[],
    allPapers: Paper[],
  ) => {
    // 节点 = 有边的文献 + 当前选中的种子文献（可能在 papers 里但没边）
    const nodeIds = new Set(graphNodes.map((n) => n.id))
    if (selectedId) nodeIds.add(selectedId)
    // 补上 papers 里有但 graphNodes 里缺的（手动加入但还没边的）
    const nodeMap = new Map<number, Paper>()
    for (const p of allPapers) nodeMap.set(p.id, p)
    for (const n of graphNodes) nodeMap.set(n.id, n)

    // 已展开 = 有出边（作为 source）的节点
    const exp = new Set<number>()
    for (const e of graphEdges) exp.add(e.source_id)
    // 也保留前端之前标记的（即使没有出边也标记过）
    for (const id of expanded) if (nodeIds.has(id)) exp.add(id)
    setExpanded(exp)

    // 力导向布局：保留已有位置，新节点随机放
    const width = containerRef.current?.clientWidth || 900
    const height = containerRef.current?.clientHeight || 560
    const existing = new Map<string, { x: number; y: number }>()
    for (const n of nodes) existing.set(n.id, n.position)

    const idStrs = Array.from(nodeIds).map(String)
    const eList = graphEdges.map((e) => ({ source: String(e.source_id), target: String(e.target_id) }))
    const positions = forceLayout(idStrs, eList, existing, width, height)

    const rfNodes: RFNode[] = Array.from(nodeIds).map((pid) => {
      const p = nodeMap.get(pid)!
      return {
        id: String(pid),
        type: 'paper',
        position: positions.get(String(pid)) || { x: width / 2, y: height / 2 },
        data: { ...p, expanded: exp.has(pid) } as PaperNodeData,
      }
    })

    const rfEdges: Edge[] = graphEdges.map((e) => ({
      id: `e${e.id}`,
      source: String(e.source_id),
      target: String(e.target_id),
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: ARROW_COLOR },
      style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
    }))

    setNodes(rfNodes)
    setEdges(rfEdges)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, selectedId, expanded])

  // ---- expand: fetch citation relationships from OpenAlex ----

  const expand = useCallback(async (id: number) => {
    setExpanding(true)
    try {
      const r: any = await post(`/literature/${id}/expand`, undefined, { ok: false })
      if (!r || r.ok === false) return
      toast(`展开完成：新增 ${r.created} 篇文献、${r.new_edges} 条关联`, 'ok')
      setExpanded((prev) => new Set(prev).add(id))
      await load()
      onChanged?.()
    } catch (e: any) {
      toast(e?.message || '展开失败', 'error')
    } finally {
      setExpanding(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, onChanged])

  // ---- add seed paper from sidebar ----

  const addSeed = useCallback((paper: Paper) => {
    const nid = String(paper.id)
    if (nodes.find((n) => n.id === nid)) {
      setSelectedId(paper.id)
      return
    }
    const width = containerRef.current?.clientWidth || 900
    const height = containerRef.current?.clientHeight || 560
    const newNode: RFNode = {
      id: nid,
      type: 'paper',
      position: { x: width / 2 - 105, y: height / 2 - 50 },
      data: { ...paper, expanded: expanded.has(paper.id) } as PaperNodeData,
    }
    setNodes((prev) => [...prev, newNode])
    setSelectedId(paper.id)
  }, [nodes, expanded])

  // ---- manual edge (drag handle to handle) ----

  const onConnect = useCallback(async (conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return
    const srcId = parseInt(conn.source)
    const tgtId = parseInt(conn.target)
    try {
      await post('/literature/graph/edges', { source_id: srcId, target_id: tgtId, edge_type: 'cites' })
      toast('已添加关联', 'ok')
      await load()
    } catch (e: any) {
      toast(e?.message || '添加关联失败', 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // ---- delete edge ----

  const removeEdge = useCallback(async (edgeRfId: string) => {
    const numId = parseInt(edgeRfId.replace('e', ''))
    if (!numId) return
    try {
      await del(`/literature/graph/edges/${numId}`)
      await load()
    } catch (e: any) {
      toast(e?.message || '删除关联失败', 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // ---- sidebar filtered papers ----

  const filteredPapers = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = needle
      ? papers.filter((p) =>
          [p.title, p.authors, p.venue, p.year, p.tags].filter(Boolean).join(' ').toLowerCase().includes(needle),
        )
      : papers
    return list.slice(0, 80)
  }, [papers, search])

  // ---- selected paper detail ----

  const selectedPaper = useMemo<PaperNodeData | null>(() => {
    if (!selectedId) return null
    const n = nodes.find((n) => parseInt(n.id) === selectedId)
    return (n?.data as unknown as PaperNodeData) || null
  }, [selectedId, nodes])

  const connectedEdges = useMemo(() => {
    if (!selectedId) return []
    const sid = String(selectedId)
    return edges.filter((e: Edge) => e.source === sid || e.target === sid)
  }, [edges, selectedId])

  // ---- init ----

  useEffect(() => {
    load()
  }, [load])

  // ---- render ----

  return (
    <div className="flex gap-3" style={{ height: 'calc(100vh - 200px)' }}>
      {/* 左侧：文献选择器 */}
      <div className="hidden w-60 shrink-0 flex-col rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-2.5 lg:flex">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--wb-text)]">
          <Icon name="book" size={15} />
          文献库
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder="搜索文献加入图谱" />
        <div className="mt-1 text-[10.5px] text-[color:var(--wb-muted)]">
          点击文献将其加入图谱，再点「展开」拉取引用关系
        </div>
        <div className="mt-2 flex-1 overflow-y-auto overscroll-contain">
          {filteredPapers.length === 0 ? (
            <p className="px-1 py-4 text-center text-[11.5px] text-[color:var(--wb-muted)]">
              {papers.length === 0 ? '文献库为空' : '无匹配文献'}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filteredPapers.map((p) => {
                const active = selectedId === p.id
                const inGraph = nodes.some((n) => parseInt(n.id) === p.id)
                return (
                  <button
                    key={p.id}
                    onClick={() => addSeed(p)}
                    className="rounded-[7px] px-2 py-1.5 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
                    style={{ background: active ? 'var(--wb-accent-soft)' : undefined }}
                  >
                    <div className="line-clamp-2 text-[11.5px] font-medium leading-snug text-[color:var(--wb-text)]">
                      {p.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[color:var(--wb-muted)]">
                      {p.year && <span>{p.year}</span>}
                      {inGraph && <span className="text-[color:var(--wb-accent)]">{'\u00b7 已在图中'}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 中间：React Flow 画布 */}
      <div
        ref={containerRef}
        className="relative min-w-0 flex-1 overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)]"
      >
        {loading ? (
          <Loading text="加载关联图..." />
        ) : error ? (
          <LoadError error={error} onRetry={load} what="关联图" />
        ) : nodes.length === 0 ? (
          <Empty text="还没有关联数据。从左侧选一篇文献加入图谱，然后点「展开引用」从 OpenAlex 拉取引用关系。" />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(ch) => setNodes((nds: RFNode[]) => applyNodeChanges(ch, nds) as RFNode[])}
            onEdgesChange={(ch) => setEdges((eds: Edge[]) => applyEdgeChanges(ch, eds))}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(parseInt(n.id))}
            onPaneClick={() => setSelectedId(null)}
            onEdgeClick={(_, e) => {
              if (e.id && window.confirm('删除这条关联？')) removeEdge(e.id)
            }}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
            proOptions={{ hideAttribution: true }}
            className="bg-[color:var(--wb-bg-subtle)]"
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="#d3d9e3" />
            <Controls className="!bottom-3 !left-3" showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => STATUS_BAR[(n.data as any)?.status] || '#94a3b8'}
              className="!bottom-3 !right-3 !h-16 !w-24 !rounded-[10px] !border !border-[color:var(--wb-border)]"
              maskColor="rgba(16,24,40,0.08)"
            />
          </ReactFlow>
        )}
      </div>

      {/* 右侧：选中节点详情 */}
      {selectedPaper && (
        <div className="w-64 shrink-0 overflow-y-auto rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-3">
          <div className="mb-2 text-[12px] font-medium text-[color:var(--wb-text)]">
            {selectedPaper.title}
          </div>

          {selectedPaper.authors && (
            <div className="mb-1 text-[11.5px] text-[color:var(--wb-text-soft)]">
              {selectedPaper.authors}
            </div>
          )}
          <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-[color:var(--wb-muted)]">
            {selectedPaper.year && <span>{selectedPaper.year}</span>}
            {selectedPaper.venue && <span>{'\u00b7'} {selectedPaper.venue}</span>}
          </div>

          <div className="mb-3 flex items-center gap-2">
            <span
              className="rounded-full px-2 py-[1px] text-[10.5px]"
              style={{
                background: `${STATUS_BAR[selectedPaper.status || 'todo']}18`,
                color: STATUS_BAR[selectedPaper.status || 'todo'],
              }}
            >
              {STATUS_LABEL[selectedPaper.status || 'todo'] || selectedPaper.status}
            </span>
            {selectedPaper.openalex_id && (
              <span className="text-[10px] text-[color:var(--wb-muted)]">OpenAlex: {selectedPaper.openalex_id}</span>
            )}
          </div>

          {selectedPaper.doi && (
            <a
              href={`https://doi.org/${selectedPaper.doi}`}
              target="_blank"
              rel="noreferrer"
              className="mb-3 block text-[11px] text-[color:var(--wb-accent)] underline underline-offset-2"
            >
              DOI: {selectedPaper.doi}
            </a>
          )}

          {/* 连接数 */}
          <div className="mb-3 flex gap-3 text-[11px] text-[color:var(--wb-text-soft)]">
            <span>关联：{connectedEdges.length} 条</span>
          </div>

          {/* 展开按钮 */}
          <Btn
            variant={selectedPaper.expanded ? 'default' : 'primary'}
            size="sm"
            onClick={() => expand(selectedPaper.id)}
            loading={expanding}
            disabled={expanding}
            className="w-full"
          >
            {selectedPaper.expanded ? '重新展开引用' : '展开引用关系'}
          </Btn>

          <p className="mt-2 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
            从 OpenAlex 拉取本文引用的文献（前 15 篇）和引用本文的文献（前 15 篇），自动入库并建立关联。
          </p>

          {/* 关联列表 */}
          {connectedEdges.length > 0 && (
            <div className="mt-3 border-t border-[color:var(--wb-border)] pt-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-[color:var(--wb-text)]">关联文献</div>
              <div className="flex flex-col gap-1">
                {connectedEdges.slice(0, 12).map((e: Edge) => {
                  const isSource = e.source === String(selectedId)
                  const otherId = parseInt(isSource ? e.target : e.source)
                  const other = nodes.find((n) => parseInt(n.id) === otherId)
                  if (!other) return null
                  const d = other.data as unknown as PaperNodeData
                  return (
                    <button
                      key={e.id}
                      onClick={() => setSelectedId(otherId)}
                      className="rounded-[6px] px-1.5 py-1 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
                    >
                      <div className="flex items-center gap-1">
                        <span className="shrink-0 text-[9.5px] text-[color:var(--wb-muted)]">
                          {isSource ? '引用' : '被引'}
                        </span>
                        <span className="line-clamp-1 text-[10.5px] text-[color:var(--wb-text-soft)]">
                          {d.title}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
