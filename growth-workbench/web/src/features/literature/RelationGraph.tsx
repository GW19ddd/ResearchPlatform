/**
 * 文献关联图 —— ResearchRabbit「Network 视图」逆向版。
 *
 *  - 布局：力导向网络（斥力 + 连边弹簧 + 中心引力），关系密切的论文自然聚成一簇，
 *    与 RR 的 Network 图一致；初始位置由 id 哈希决定，同数据每次渲染结果一致。
 *  - 节点：实心圆（半径随图内被引数增大），绿色 = 种子/选中论文，蓝色 = 关联发现，
 *    圆内标注「第一作者 + 年份」。
 *  - 连边：细灰直线、无箭头（RR 风格），选中时高亮邻居、淡化无关。
 *  - 空态：中央配插画 + 底部三张说明卡（加种子 / 展开引用 / 发现关联）。
 *
 * 数据层不变：lit_edges 表（source cites target），/literature/graph，/literature/{id}/expand。
 * 可视化：@xyflow/react，坐标计算纯前端。
 */
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BaseEdge,
  Controls,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { Btn, LoadError, Loading, SearchInput, Segmented } from '../../components/ui'
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

type PaperNodeData = Paper & {
  r: number
  cites: number
  expanded: boolean
  dim: boolean
  isSeed: boolean
}
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

const EDGE_COLOR = '#e2e7ed'
const EDGE_ACTIVE = '#0ea5a4'
const NODE_STROKE = '#b9c3cf'
const RR_ACCENT = '#0ea5a4'
const RR_TEXT = '#3d4652'
const RR_MUTED = '#8a94a0'

// ---- force-directed layout（RR Network 式：斥力 + 连边弹簧 + 中心引力） ----

type LayoutItem = { id: string; cites: number }
type Pos = { x: number; y: number; r: number }

// 由 id 决定的确定性抖动（同数据每次渲染结果一致，不随机）
function hashJitter(id: string, salt: string): number {
  let h = 2166136261
  const s = id + salt
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000 - 0.5 // -0.5 ~ 0.5
}

function forceLayout(
  items: LayoutItem[],
  edges: { source: string; target: string }[],
  width: number,
  height: number,
): Map<string, Pos> {
  const out = new Map<string, Pos>()
  if (items.length === 0) return out

  const rOf = (cites: number) => 14 + Math.min(12, Math.round(Math.sqrt(cites) * 2.8))

  // 初始：中心圆环摆放 + 确定性抖动（比全部堆在中心更容易展开）
  const cx = width / 2
  const cy = height / 2
  const ringR = Math.min(width, height) * 0.28
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>()
  items.forEach((it, i) => {
    const ang = (i / items.length) * Math.PI * 2
    pos.set(it.id, {
      x: cx + Math.cos(ang) * ringR + hashJitter(it.id, 'fx') * 60,
      y: cy + Math.sin(ang) * ringR + hashJitter(it.id, 'fy') * 60,
      vx: 0,
      vy: 0,
    })
  })

  // 邻接表（弹簧只作用于有连边的节点对）
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!pos.has(e.source) || !pos.has(e.target)) continue
    const a = adj.get(e.source)
    if (a) a.push(e.target)
    else adj.set(e.source, [e.target])
    const b = adj.get(e.target)
    if (b) b.push(e.source)
    else adj.set(e.target, [e.source])
  }

  const clampX = (x: number) => Math.max(70, Math.min(width - 70, x))
  const clampY = (y: number) => Math.max(60, Math.min(height - 60, y))
  const rById = new Map(items.map((it) => [it.id, rOf(it.cites)]))

  const ITER = 300
  for (let iter = 0; iter < ITER; iter++) {
    const t = 1 - iter / ITER // 温度：前期大幅展开、后期收敛

    // 1) 全对斥力（强度随时间衰减，让弹簧有机会把聚簇拉出来）
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = pos.get(items[i].id)!
        const b = pos.get(items[j].id)!
        const dx = a.x - b.x
        const dy = a.y - b.y
        const distSq = Math.max(dx * dx + dy * dy, 100)
        const dist = Math.sqrt(distSq)
        const f = Math.min(8, 26000 / distSq) * (0.35 + 0.65 * t)
        const ux = dx / dist
        const uy = dy / dist
        a.vx += ux * f
        a.vy += uy * f
        b.vx -= ux * f
        b.vy -= uy * f
      }
    }

    // 2) 连边弹簧：把相连节点拉到目标距离（rA + rB + 70）
    for (const [src, targets] of adj) {
      for (const dst of targets) {
        if (src >= dst) continue // 每对只算一次
        const a = pos.get(src)!
        const b = pos.get(dst)!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const rest = (rById.get(src) || 16) + (rById.get(dst) || 16) + 70
        const f = ((dist - rest) / dist) * 0.06
        a.vx += dx * f
        a.vy += dy * f
        b.vx -= dx * f
        b.vy -= dy * f
      }
    }

    // 3) 中心引力（弱）：防止整体飘走
    for (const it of items) {
      const p = pos.get(it.id)!
      p.vx += (cx - p.x) * 0.008
      p.vy += (cy - p.y) * 0.008
    }

    // 4) 积分 + 温度限幅
    const maxV = 6 + 18 * t
    for (const it of items) {
      const p = pos.get(it.id)!
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1
      const scale = Math.min(1, maxV / v)
      p.x = clampX(p.x + p.vx * scale)
      p.y = clampY(p.y + p.vy * scale)
      p.vx *= 0.6
      p.vy *= 0.6
    }
  }

  // 重叠解除：强制推开仍重叠的圆
  for (let pass = 0; pass < 40; pass++) {
    let moved = false
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = pos.get(items[i].id)!
        const b = pos.get(items[j].id)!
        const ra = rById.get(items[i].id)!
        const rb = rById.get(items[j].id)!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const min = ra + rb + 16
        if (dist < min) {
          const push = (min - dist) / 2
          const ux = dx / dist
          const uy = dy / dist
          a.x = clampX(a.x - ux * push)
          a.y = clampY(a.y - uy * push)
          b.x = clampX(b.x + ux * push)
          b.y = clampY(b.y + uy * push)
          moved = true
        }
      }
    }
    if (!moved) break
  }

  for (const it of items) {
    const p = pos.get(it.id)!
    out.set(it.id, { x: p.x, y: p.y, r: rById.get(it.id)! })
  }
  return out
}

// ---- paper node（RR 式：白底细描边圆点，标签在下方，选中/种子加 teal 环） ----

function PaperNode({ data, selected }: NodeProps<RFNode>) {
  const d = data as unknown as PaperNodeData
  const r = d.r
  const emphasized = d.isSeed || selected
  const stroke = emphasized ? RR_ACCENT : NODE_STROKE
  const dimOpacity = d.dim ? 0.3 : 1
  const firstAuthor = d.authors
    ? (d.authors.split(/[,，]/)[0].trim().split(/\s+/)[0] || d.authors.slice(0, 8))
    : ''

  return (
    <div style={{ width: r * 2, height: r * 2 + 30, opacity: dimOpacity }} className="relative">
      {/* Handle 仅用于「手动拉边」交互，渲染层用圆心直线，故此处隐藏锚点 */}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5"
        style={{ top: r, background: NODE_STROKE, border: 'none', opacity: 0 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5"
        style={{ top: r, background: NODE_STROKE, border: 'none', opacity: 0 }}
      />

      <div
        className="absolute cursor-pointer rounded-full transition-shadow"
        style={{
          left: 0,
          top: 0,
          width: r * 2,
          height: r * 2,
          background: '#ffffff',
          border: emphasized ? `2px solid ${stroke}` : `1.4px solid ${stroke}`,
          boxShadow: selected
            ? `0 0 0 4px ${RR_ACCENT}22, var(--wb-shadow-sm)`
            : 'var(--wb-shadow-sm)',
        }}
      >
        {/* 已展开标记：右上 teal 小点 */}
        {d.expanded && (
          <span
            className="absolute rounded-full"
            style={{ width: 6, height: 6, right: 1, top: 1, background: RR_ACCENT, opacity: 0.9 }}
          />
        )}
      </div>

      {/* 下方标签：第一作者 + 年份（RR 式灰色小字） */}
      <div
        className="pointer-events-none absolute left-1/2 top-full -translate-x-1/2 whitespace-nowrap text-center"
        style={{ marginTop: 2 }}
      >
        <div
          className="text-[10.5px] font-medium leading-tight"
          style={{ color: emphasized ? RR_ACCENT : RR_MUTED }}
        >
          {firstAuthor}
        </div>
        {d.year && (
          <div className="text-[9.5px] leading-tight" style={{ color: RR_MUTED }}>
            {d.year}
          </div>
        )}
      </div>
    </div>
  )
}

const nodeTypes = { paper: PaperNode }

// ---- 圆心到圆心的直线边（数据里直接带两端坐标，画在节点下层，圆内段被白圆盖住） ----

function CenterEdge({ id, data, style, markerEnd }: EdgeProps) {
  const d = data as unknown as { sx: number; sy: number; tx: number; ty: number }
  const [path] = getStraightPath({
    sourceX: d.sx,
    sourceY: d.sy,
    targetX: d.tx,
    targetY: d.ty,
  })
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
}

const edgeTypes = { center: CenterEdge }

// ---- 空态插画（星座涂鸦，呼应 ResearchRabbit 的科学家插画位） ----

function EmptyDoodle() {
  return (
    <svg width="230" height="150" viewBox="0 0 230 150" fill="none" aria-hidden>
      <line x1="45" y1="55" x2="110" y2="92" stroke="#c7ccd6" strokeWidth="1.5" strokeDasharray="4 4" />
      <line x1="110" y1="92" x2="182" y2="48" stroke="#c7ccd6" strokeWidth="1.5" strokeDasharray="4 4" />
      <line x1="110" y1="92" x2="150" y2="126" stroke="#c7ccd6" strokeWidth="1.5" strokeDasharray="4 4" />
      <circle cx="45" cy="55" r="16" fill="#fff" stroke={NODE_STROKE} strokeWidth="1.5" />
      <circle cx="182" cy="48" r="12" fill="#fff" stroke={NODE_STROKE} strokeWidth="1.5" />
      <circle cx="150" cy="126" r="9" fill="#fff" stroke={NODE_STROKE} strokeWidth="1.5" />
      <circle cx="110" cy="92" r="20" fill="#fff" stroke={RR_ACCENT} strokeWidth="2" />
      <circle cx="205" cy="112" r="4" fill={NODE_STROKE} />
      <circle cx="24" cy="112" r="3" fill={NODE_STROKE} />
    </svg>
  )
}

// ---- main component ----

export default function RelationGraph({ onChanged }: { onChanged?: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [papers, setPapers] = useState<Paper[]>([])
  const [graphNodes, setGraphNodes] = useState<Paper[]>([])
  const [graphEdges, setGraphEdges] = useState<LitEdge[]>([])
  const [extraIds, setExtraIds] = useState<number[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [expanding, setExpanding] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'todo' | 'reading' | 'done'>('all')
  const containerRef = useRef<HTMLDivElement>(null)

  // ---- load graph data ----

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const g = await get('/literature/graph')
      setPapers(g.papers || [])
      setGraphNodes(g.nodes || [])
      setGraphEdges(g.edges || [])
    } catch (e: any) {
      setError(e?.message || '关联图加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ---- derived: paper map / degree / cites ----

  const paperMap = useMemo(() => {
    const m = new Map<number, Paper>()
    for (const p of papers) m.set(p.id, p)
    for (const n of graphNodes) m.set(n.id, n)
    return m
  }, [papers, graphNodes])

  const { citesOf, outOf } = useMemo(() => {
    const c = new Map<number, number>()
    const o = new Map<number, number>()
    for (const e of graphEdges) {
      c.set(e.target_id, (c.get(e.target_id) || 0) + 1)
      o.set(e.source_id, (o.get(e.source_id) || 0) + 1)
    }
    return { citesOf: c, outOf: o }
  }, [graphEdges])

  // ---- derived: 一次布局，节点与「圆心连线」共用 ----

  const layoutMap = useMemo(() => {
    const ids = new Set<number>(graphNodes.map((n) => n.id))
    for (const id of extraIds) ids.add(id)
    if (selectedId) ids.add(selectedId)
    const items = Array.from(ids)
      .map((id) => paperMap.get(id))
      .filter((p): p is Paper => !!p)
      .map((p) => ({ id: String(p.id), cites: citesOf.get(p.id) || 0 }))
    const W = containerRef.current?.clientWidth || 900
    const H = containerRef.current?.clientHeight || 560
    const edgePairs = graphEdges.map((e) => ({
      source: String(e.source_id),
      target: String(e.target_id),
    }))
    return forceLayout(items, edgePairs, W, H)
  }, [graphNodes, extraIds, selectedId, paperMap, citesOf, graphEdges])

  const nodes = useMemo<RFNode[]>(() => {
    const neighborIds = new Set<number>()
    if (selectedId) {
      for (const e of graphEdges) {
        if (e.source_id === selectedId) neighborIds.add(e.target_id)
        if (e.target_id === selectedId) neighborIds.add(e.source_id)
      }
    }
    return Array.from(layoutMap.entries()).map(([id, pos]) => {
      const p = paperMap.get(Number(id))!
      const isSel = selectedId === Number(id)
      const dim = !!selectedId && !isSel && !neighborIds.has(Number(id))
      return {
        id,
        type: 'paper' as const,
        position: { x: pos.x - pos.r, y: pos.y - pos.r },
        draggable: false,
        data: {
          ...p,
          r: isSel ? pos.r + 3 : pos.r,
          cites: citesOf.get(p.id) || 0,
          expanded: expanded.has(Number(id)) || (outOf.get(Number(id)) || 0) > 0,
          dim,
          isSeed: isSel || extraIds.includes(Number(id)),
        } as PaperNodeData,
      }
    })
  }, [layoutMap, selectedId, paperMap, citesOf, outOf, expanded, extraIds, graphEdges])

  // 连边：直线、圆心到圆心（两端中心坐标直接写进 data，绘制于圆下方）
  const edges = useMemo<Edge[]>(() => {
    return graphEdges.map((e) => {
      const active =
        !!selectedId && (e.source_id === selectedId || e.target_id === selectedId)
      const dim = !!selectedId && !active
      const s = layoutMap.get(String(e.source_id))
      const t = layoutMap.get(String(e.target_id))
      return {
        id: `e${e.id}`,
        source: String(e.source_id),
        target: String(e.target_id),
        type: 'center',
        data: {
          sx: s?.x ?? 0,
          sy: s?.y ?? 0,
          tx: t?.x ?? 0,
          ty: t?.y ?? 0,
        },
        style: {
          stroke: active ? EDGE_ACTIVE : EDGE_COLOR,
          strokeWidth: active ? 2 : 1.2,
          opacity: dim ? 0.12 : 0.9,
        },
      }
    })
  }, [graphEdges, selectedId, layoutMap])

  // ---- expand: fetch citation relationships from OpenAlex ----

  const expand = useCallback(
    async (id: number) => {
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
    },
    [load, onChanged],
  )

  // ---- add seed paper from sidebar ----

  const addSeed = useCallback((paper: Paper) => {
    setExtraIds((prev) => (prev.includes(paper.id) ? prev : [...prev, paper.id]))
    setSelectedId(paper.id)
  }, [])

  // ---- manual edge (drag handle to handle) ----

  const onConnect = useCallback(
    async (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return
      try {
        await post('/literature/graph/edges', {
          source_id: parseInt(conn.source),
          target_id: parseInt(conn.target),
          edge_type: 'cites',
        })
        toast('已添加关联', 'ok')
        await load()
      } catch (e: any) {
        toast(e?.message || '添加关联失败', 'error')
      }
    },
    [load],
  )

  // ---- delete edge ----

  const removeEdge = useCallback(
    async (edgeRfId: string) => {
      const numId = parseInt(edgeRfId.replace('e', ''))
      if (!numId) return
      try {
        await del(`/literature/graph/edges/${numId}`)
        await load()
      } catch (e: any) {
        toast(e?.message || '删除关联失败', 'error')
      }
    },
    [load],
  )

  // ---- sidebar filtered papers（RR 式左栏） ----

  const filteredPapers = useMemo(() => {
    const needle = search.trim().toLowerCase()
    let list = papers
    if (statusFilter !== 'all') list = list.filter((p) => (p.status || 'todo') === statusFilter)
    if (needle)
      list = list.filter((p) =>
        [p.title, p.authors, p.venue, p.year, p.tags].filter(Boolean).join(' ').toLowerCase().includes(needle),
      )
    return list.slice(0, 80)
  }, [papers, search, statusFilter])

  // ---- selected paper detail ----

  const selectedPaper = useMemo<Paper | null>(() => {
    if (!selectedId) return null
    return paperMap.get(selectedId) || null
  }, [selectedId, paperMap])

  const connectedEdges = useMemo(() => {
    if (!selectedId) return []
    const sid = String(selectedId)
    return edges.filter((e: Edge) => e.source === sid || e.target === sid)
  }, [edges, selectedId])

  const selectedCites = selectedId ? citesOf.get(selectedId) || 0 : 0

  // ---- render ----

  return (
    <div className="flex gap-3" style={{ height: 'calc(100vh - 200px)' }}>
      {/* 左侧：RR 式文献列表（白底 + Add/Grow/Analyze 式计数头） */}
      <div className="hidden w-72 shrink-0 flex-col overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-white lg:flex">
        <div className="border-b border-[color:var(--wb-border)] px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            {[
              { icon: 'plus' as const, label: '添加', n: papers.length },
              { icon: 'book' as const, label: '在图', n: graphNodes.length },
              { icon: 'gitBranch' as const, label: '关联', n: graphEdges.length },
            ].map((b, i) => (
              <span
                key={b.label}
                className="flex items-center gap-1 rounded-full border px-2 py-[3px] text-[10.5px] font-medium"
                style={{
                  borderColor: i === 0 ? `${RR_ACCENT}55` : 'var(--wb-border)',
                  color: i === 0 ? RR_ACCENT : RR_TEXT,
                  background: i === 0 ? `${RR_ACCENT}0d` : '#fff',
                }}
              >
                <Icon name={b.icon} size={11} />
                {b.label} {b.n}
              </span>
            ))}
          </div>
          <div className="mt-2">
            <SearchInput value={search} onChange={setSearch} placeholder="搜索文献..." />
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <Segmented
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'todo', label: '待读' },
                { value: 'reading', label: '在读' },
                { value: 'done', label: '已读' },
              ]}
            />
            <span className="text-[10px]" style={{ color: RR_MUTED }}>
              {filteredPapers.length} 篇
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain bg-[#fafbfc] p-1.5">
          {filteredPapers.length === 0 ? (
            <p className="px-1 py-6 text-center text-[11.5px]" style={{ color: RR_MUTED }}>
              {papers.length === 0 ? '文献库为空' : '无匹配文献'}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filteredPapers.map((p) => {
                const active = selectedId === p.id
                const inGraph =
                  graphNodes.some((n) => n.id === p.id) || extraIds.includes(p.id)
                const firstAuthor = p.authors
                  ? p.authors.split(/[,，]/)[0].trim().split(/\s+/)[0]
                  : ''
                const cites = citesOf.get(p.id) || 0
                return (
                  <button
                    key={p.id}
                    onClick={() => addSeed(p)}
                    className="rounded-[8px] border bg-white px-2.5 py-2 text-left transition hover:shadow-[var(--wb-shadow-md)]"
                    style={{
                      borderColor: active ? RR_ACCENT : 'var(--wb-border)',
                      boxShadow: active ? `0 0 0 2px ${RR_ACCENT}22` : undefined,
                    }}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="text-[11.5px] font-semibold" style={{ color: RR_TEXT }}>
                        {firstAuthor}
                        {p.year ? `, ${p.year}` : ''}
                      </div>
                      {inGraph && (
                        <span
                          className="mt-[1px] shrink-0 rounded-full px-1.5 py-[1px] text-[9px]"
                          style={{ background: `${RR_ACCENT}14`, color: RR_ACCENT }}
                        >
                          在图
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug" style={{ color: RR_TEXT }}>
                      {p.title}
                    </div>
                    {p.venue && (
                      <div className="mt-0.5 truncate text-[10.5px]" style={{ color: RR_ACCENT }}>
                        {p.venue}
                      </div>
                    )}
                    {cites > 0 && (
                      <div className="mt-1 text-[9.5px]" style={{ color: RR_MUTED }}>
                        被引 {cites}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 中间：力导向网络画布 */}
      <div
        ref={containerRef}
        className="relative min-w-0 flex-1 overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]"
      >
        {loading ? (
          <Loading text="加载关联图..." />
        ) : error ? (
          <LoadError error={error} onRetry={load} what="关联图" />
        ) : nodes.length === 0 ? (
          /* RR 式空态：插画 + 引导 + 三张说明卡 */
          <div className="flex h-full flex-col items-center justify-center gap-6 px-6 pb-4">
            <EmptyDoodle />
            <div className="text-center">
              <div className="text-[14px] font-medium text-[color:var(--wb-text)]">
                这里还什么都没有 —— 先加几颗种子吧！
              </div>
              <div className="mt-1 text-[12px] text-[color:var(--wb-muted)]">
                从左侧文献库点选论文作为种子，再展开引用关系
              </div>
            </div>
            <div className="grid w-full max-w-[720px] grid-cols-3 gap-3">
              {[
                {
                  bg: 'var(--wb-accent-soft)',
                  fg: 'var(--wb-accent)',
                  title: '加入',
                  desc: '种子决定图谱从哪开始。从文献库点选论文加入图谱。',
                },
                {
                  bg: 'var(--wb-ok-soft)',
                  fg: 'var(--wb-ok)',
                  title: '展开',
                  desc: '选中种子后一键拉取引用与被引，持续壮大你的文献网络。',
                },
                {
                  bg: 'var(--wb-warn-soft)',
                  fg: 'var(--wb-warn)',
                  title: '发现',
                  desc: '连线越多聚得越紧——关系密切的论文自然抱团，圆点越大被引越多。',
                },
              ].map((c) => (
                <div
                  key={c.title}
                  className="rounded-[10px] px-3 py-2.5 text-left"
                  style={{ background: c.bg }}
                >
                  <div className="text-[12px] font-semibold" style={{ color: c.fg }}>
                    {c.title}
                  </div>
                  <div className="mt-0.5 text-[10.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                    {c.desc}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onConnect={onConnect}
              onNodeClick={(_, n) => setSelectedId(parseInt(n.id))}
              onNodeDoubleClick={(_, n) => expand(parseInt(n.id))}
              onPaneClick={() => setSelectedId(null)}
              onEdgeClick={(_, e) => {
                if (e.id && window.confirm('删除这条关联？')) removeEdge(e.id)
              }}
              nodesDraggable={false}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.05 }}
              minZoom={0.15}
              proOptions={{ hideAttribution: true }}
              className="bg-white"
            >
              <Controls className="!bottom-3 !left-1/2 !-translate-x-1/2" showInteractive={false} />
            </ReactFlow>

            {/* 顶部筛选 chips（RR 式：All / Seeds / Results 计数） */}
            <div className="pointer-events-none absolute left-1/2 top-2.5 flex -translate-x-1/2 items-center gap-1.5">
              {[
                { label: '全部', n: nodes.length },
                { label: '种子', n: nodes.filter((x) => (x.data as unknown as PaperNodeData).isSeed).length },
                { label: '关联', n: graphEdges.length },
              ].map((c) => (
                <span
                  key={c.label}
                  className="rounded-full border border-[color:var(--wb-border)] bg-white px-2 py-[2px] text-[10px]"
                  style={{ color: RR_TEXT }}
                >
                  {c.label} <span className="font-semibold">{c.n}</span>
                </span>
              ))}
            </div>

            {/* 图例（右下，RR 式极简） */}
            <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col items-end gap-1 text-[9.5px]" style={{ color: RR_MUTED }}>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-3 rounded-full bg-white"
                  style={{ border: `2px solid ${RR_ACCENT}` }}
                />
                种子 / 选中
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-3 rounded-full bg-white"
                  style={{ border: `1.4px solid ${NODE_STROKE}` }}
                />
                图内文献
              </span>
              <span>圆点大小 = 图内被引数</span>
            </div>
          </>
        )}
      </div>

      {/* 右侧：选中节点详情 */}
      {selectedPaper && (
        <div className="w-64 shrink-0 overflow-y-auto rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-3">
          <div className="mb-2 text-[12.5px] font-medium leading-snug text-[color:var(--wb-text)]">
            {selectedPaper.title}
          </div>

          {selectedPaper.authors && (
            <div className="mb-1 text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
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
            <span className="text-[10.5px] text-[color:var(--wb-text-soft)]">
              图内被引 {selectedCites}
            </span>
          </div>

          {selectedPaper.doi && (
            <a
              href={`https://doi.org/${selectedPaper.doi}`}
              target="_blank"
              rel="noreferrer"
              className="mb-3 block truncate text-[11px] text-[color:var(--wb-accent)] underline underline-offset-2"
            >
              DOI: {selectedPaper.doi}
            </a>
          )}

          <Btn
            variant={(outOf.get(selectedPaper.id) || 0) > 0 ? 'default' : 'primary'}
            size="sm"
            onClick={() => expand(selectedPaper.id)}
            loading={expanding}
            disabled={expanding}
            className="w-full"
          >
            {(outOf.get(selectedPaper.id) || 0) > 0 ? '重新展开引用' : '展开引用关系'}
          </Btn>

          <p className="mt-2 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
            从 OpenAlex 拉取本文引用的文献（前 15 篇）和引用本文的文献（前 15 篇），自动入库并建立关联。双击圆点也可以直接展开。
          </p>

          {connectedEdges.length > 0 && (
            <div className="mt-3 border-t border-[color:var(--wb-border)] pt-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-[color:var(--wb-text)]">
                关联文献（{connectedEdges.length}）
              </div>
              <div className="flex flex-col gap-1">
                {connectedEdges.slice(0, 12).map((e: Edge) => {
                  const isSource = e.source === String(selectedId)
                  const otherId = parseInt(isSource ? e.target : e.source)
                  const other = paperMap.get(otherId)
                  if (!other) return null
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
                          {other.title}
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
