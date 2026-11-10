/**
 * 关联图（Litmaps 式）—— UI 逐像素对照 Litmaps 复刻，用户锁定「必须一模一样」。
 *
 * 双栏两态：
 *   select  —— 左：搜索条（输入 + X + 蓝色搜索钮）+ 年份过滤 tab（最相关 / 2026 年起 /
 *              2025 年起 / 2022 年起 / 自定义）+ 文献卡列表（参考文献 / 被引 计数行）
 *              + 「N-M / 共 K 篇」分页脚；右：文章详情（大蓝按钮 探索相关文献 / 在新的引文图谱中、
 *              作者 chips、DOI）或「选择一篇文献」占位卡
 *   loading —— 左：旋转弧线 + "正在检索上千条引用与参考文献…" + 进度条；右：种子深色圆 + 淡蓝光晕
 *   explore —— 左：探索相关文献 标题 + 筛选 chips + 关联文献卡（相似文献 = 继续展开该节点）；
 *              右：引文图谱
 *
 * 图谱语义布局（Litmaps 灵魂，不是力导向）：
 *   x = 发表年份（左旧右新，底部轴 发表更近 →）
 *   y = 被引次数 log 刻度（上高被引，右侧轴 更多被引）
 *   节点 = 白底蓝描边圆（大小随 OpenAlex 被引 sqrt 比例），选中/种子节点 = 深色实心 + 淡蓝光晕；
 *   边 = 浅灰弧线 + 箭头指向被引文献（图例：连线表示引用关系；箭头指向被引文献）。
 *   缩放/平移只作用于 SVG 内部 <g transform>，容器不加 transform/filter/clip-path。
 *
 * 调色例外：本视图按用户要求照抄 Litmaps 配色（皇家蓝 #2563eb / 深板岩 #333d4b），
 * 不走全站靛蓝令牌 —— 与 canvas TYPE_STYLE 同级的局部例外，别扩散到其它页面。
 * 数据层：GET /literature/graph（lit_edges），POST /literature/{id}/expand（OpenAlex 引用/被引）。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { AiError } from '../../components/AiError'
import { Btn, Empty, IconBtn } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { get, post } from '../../lib/api'
import { useAiTask } from '../../lib/hooks'
import { downloadText, stamp, toBibtex } from '../../components/BulkBar'

const W = 1000
const H = 680

/* Litmaps 调色（本文件局部例外，hex 字面量） */
const LM_BLUE = '#2563eb'
const LM_BLUE_DEEP = '#1d4ed8'
const LM_NODE_STROKE = '#4285f4'
const LM_SEED_FILL = '#333d4b'
const LM_HALO = '#bcd2fa'
const LM_EDGE = '#d8dde5'
const LM_EDGE_HOT = '#a9c6f5'
const LM_ARROW = '#b9c2cc'
const LM_TITLE = '#16213a'
const LM_TEXT = '#3c4657'
const LM_MUTED = '#8a94a6'
const LM_BORDER = '#e7eaf0'
const LM_CARD_TITLE = '#1a2b4c'

type Pos = { id: number; x: number; y: number }

/** 统一的文章形状：文献库条目 / OpenAlex 检索命中 都映射到它 */
type Art = {
  id?: number
  title: string
  authors?: string | null
  year?: number | null
  venue?: string | null
  doi?: string | null
  url?: string | null
  openalex_id?: string | null
  cited_by_count?: number | null
  ref_count?: number | null
  pdf_url?: string | null
  pdf_path?: string | null
  inLib: boolean
}

const PAGE_SIZE = 20

function hash01(n: number): number {
  let h = 2166136261
  const s = String(n)
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10000) / 10000
}

function normTitle(s: any): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Litmaps 卡片头「Yue, 2026」：取第一作者姓氏 */
function surnameOf(authors: any): string {
  const first = String(authors || '').split(/[,;]/)[0].trim()
  if (!first) return ''
  const parts = first.split(/\s+/)
  return parts.length > 1 ? parts[parts.length - 1] : first
}

function authorYear(a: Art | any): string {
  const s = surnameOf(a.authors)
  return s ? `${s}, ${a.year || ''}` : String(a.title || '').slice(0, 26)
}

function nodeLabel(p: any): string {
  const s = surnameOf(p.authors)
  if (s) return `${s}, ${p.year || '—'}`
  const t = String(p.title || '').trim()
  return t.length > 18 ? t.slice(0, 18) + '…' : t
}

function doiFromUrl(url: any): string | null {
  const u = String(url || '')
  return u.startsWith('https://doi.org/') && u.length > 16 ? u.slice(16) : null
}

const hitToArt = (h: any): Art => ({
  title: h.title,
  authors: h.authors,
  year: h.year,
  venue: h.venue,
  doi: h.doi || doiFromUrl(h.url),
  url: h.url,
  openalex_id: h.oa_id || null,
  cited_by_count: h.cited_by ?? null,
  ref_count: h.references ?? null,
  pdf_url: h.pdf_url || null,
  inLib: false,
})

const toArt = (p: any, inLib: boolean): Art => ({
  id: p.id,
  title: p.title,
  authors: p.authors,
  year: p.year,
  venue: p.venue,
  doi: p.doi || doiFromUrl(p.url),
  url: p.url,
  openalex_id: p.openalex_id || null,
  cited_by_count: p.cited_by_count ?? null,
  ref_count: p.ref_count ?? null,
  pdf_url: null,
  pdf_path: p.pdf_path || null,
  inLib,
})

/**
 * Litmaps 式时间轴布局：x = 年份线性、y = 被引 log 刻度；
 * 同格重合的节点横向排开 + id 确定性微抖动，同一份数据每次渲染坐标一致。
 */
function timelineLayout(nodes: any[]): Pos[] {
  if (!nodes.length) return []
  const PAD_L = 96
  const PAD_R = 96
  const PAD_T = 64
  const PAD_B = 96
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B

  const validYears = nodes
    .map((p) => Number(p.year))
    .filter((v) => !isNaN(v) && v > 1400)
    .sort((a, b) => a - b)
  const medYear = validYears.length
    ? validYears[Math.floor(validYears.length / 2)]
    : 2020
  const yMin = Math.min(...validYears, medYear)
  const yMax = Math.max(...validYears, medYear)
  const yearSpan = Math.max(1, yMax - yMin)

  const logs = nodes.map((p) => Math.log10(Number(p.cited_by_count || 0) + 1))
  const maxLog = Math.max(...logs)

  const cells = new Map<string, any[]>()
  for (const p of nodes) {
    const yr = validYears.length && Number(p.year) > 1400 ? Number(p.year) : medYear
    const lg = Math.log10(Number(p.cited_by_count || 0) + 1)
    const xr = maxLog > 0 ? lg / maxLog : 0.5
    const key = `${Math.round(((yr - yMin) / yearSpan) * 48)}|${Math.round(xr * 48)}`
    const arr = cells.get(key) || []
    arr.push(p)
    cells.set(key, arr)
  }

  const out: Pos[] = []
  for (const arr of cells.values()) {
    arr.sort((a, b) => a.id - b.id)
    arr.forEach((p, i) => {
      const yr = Number(p.year) > 1400 ? Number(p.year) : medYear
      const lg = Math.log10(Number(p.cited_by_count || 0) + 1)
      const xg = (yr - yMin) / yearSpan
      const yg = maxLog > 0 ? lg / maxLog : 0.5
      const spread =
        arr.length > 1
          ? Math.max(-42, Math.min(42, (i - (arr.length - 1) / 2) * 30))
          : 0
      out.push({
        id: Number(p.id),
        x: PAD_L + xg * plotW + spread + (hash01(p.id) - 0.5) * 8,
        y: PAD_T + (1 - yg) * plotH + (hash01(p.id * 3) - 0.5) * 10,
      })
    })
  }
  return out
}

// ---------------------------------------------------------------- 小部件

const FunnelIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 5h18l-7 8v5l-4 2v-7z" />
  </svg>
)

/** Litmaps 加载态的旋转弧线 */
const SwirlSpinner = () => (
  <svg width="76" height="76" viewBox="0 0 76 76" className="animate-spin" style={{ animationDuration: '1.8s' }} aria-hidden="true">
    <g fill="none" stroke={LM_TITLE} strokeWidth="2.6" strokeLinecap="round">
      <circle cx="38" cy="38" r="27" strokeDasharray="70 100" opacity="0.9" />
      <circle cx="38" cy="38" r="19" strokeDasharray="46 74" opacity="0.55" transform="rotate(120 38 38)" />
      <circle cx="38" cy="38" r="11" strokeDasharray="26 44" opacity="0.3" transform="rotate(240 38 38)" />
    </g>
  </svg>
)

const TinySpinner = () => (
  <span
    className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#d3dae6]"
    style={{ borderTopColor: LM_BLUE }}
    aria-hidden="true"
  />
)

/** 「Select an Article」右侧的斜置预览卡：白卡 + 蓝边 + 迷你引文网络涂鸦 */
const PreviewCard = () => {
  const center = { x: 168, y: 92 }
  const dots: { x: number; y: number; r: number; label?: string }[] = [
    { x: 62, y: 58, r: 7, label: 'Char, 2002' },
    { x: 92, y: 76, r: 6, label: 'Wood, 2002' },
    { x: 40, y: 112, r: 6, label: 'Lower, 1990' },
    { x: 86, y: 118, r: 7, label: 'Saad, 2010' },
    { x: 158, y: 52, r: 7, label: 'Perkins, 2018' },
    { x: 222, y: 66, r: 8, label: 'Rhee, 2017' },
    { x: 196, y: 92, r: 7, label: 'Karaulia, 2018' },
    { x: 140, y: 122, r: 6, label: 'Toledano, 2016' },
    { x: 204, y: 118, r: 7, label: 'Balis, 2021' },
    { x: 238, y: 106, r: 6, label: 'Zheng, 2022' },
    { x: 66, y: 152, r: 5, label: 'Ponte, 2013' },
    { x: 106, y: 160, r: 6, label: 'Philipp, 2014' },
    { x: 196, y: 146, r: 6, label: 'Agohovn, 2018' },
    { x: 246, y: 146, r: 6, label: 'Cobeir, 2023' },
  ]
  return (
    <div className="relative mt-14 ml-10 h-[230px] w-[340px]">
      {/* 后面压着的第二张斜卡 */}
      <div className="absolute inset-0 rotate-[6deg] rounded-[18px] border-2 bg-white" style={{ borderColor: '#e3ebf7', boxShadow: '0 16px 36px -18px rgba(37,99,235,0.25)' }} />
      <div
        className="absolute inset-0 -rotate-[7deg] rounded-[18px] border-2 bg-white p-4"
        style={{ borderColor: '#c6d9fb', boxShadow: '0 24px 48px -20px rgba(37,99,235,0.35)' }}
      >
        <svg viewBox="0 0 300 180" className="h-full w-full">
          {dots.map((d, i) => {
            const dx = center.x - d.x
            const dy = center.y - d.y
            const dist = Math.max(1, Math.hypot(dx, dy))
            const bend = Math.min(24, dist * 0.16)
            const cx = (center.x + d.x) / 2 - (dy / dist) * bend
            const cy = (center.y + d.y) / 2 + (dx / dist) * bend
            return (
              <path key={i} d={`M ${d.x} ${d.y} Q ${cx} ${cy} ${center.x} ${center.y}`} fill="none" stroke="#e2e6ee" strokeWidth="1" />
            )
          })}
          {dots.map((d, i) => (
            <g key={`n${i}`}>
              <circle cx={d.x} cy={d.y} r={d.r} fill="#ffffff" stroke={LM_NODE_STROKE} strokeWidth="1.8" />
              {d.label && (
                <text x={d.x} y={d.y + d.r + 9} textAnchor="middle" fontSize="6.5" fill={LM_MUTED}>
                  {d.label}
                </text>
              )}
            </g>
          ))}
          <circle cx={center.x} cy={center.y} r={12} fill={LM_SEED_FILL} />
          <circle cx={center.x} cy={center.y} r={17} fill={LM_HALO} opacity="0.45" />
        </svg>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 卡片

function RefsCitesRow({ a, icon = false }: { a: Art; icon?: boolean }) {
  const refs = a.ref_count == null ? '—' : a.ref_count
  const cites = a.cited_by_count == null ? 0 : a.cited_by_count
  return (
    <div className="flex items-center justify-between text-[10.5px] font-medium tracking-[0.06em] text-[#6b7280]">
      <span className="flex items-center gap-1.5">
        {icon && <Icon name="file" size={13} className="text-[#8a94a6]" />}
        <span>{refs} 参考文献</span>
      </span>
      <span>{cites} 被引</span>
    </div>
  )
}

/** 左栏文献卡（Litmaps 样式）：作者,年份 / 下划线标题 / 来源 / REFERENCES·CITATIONS */
function ArtCard({
  a,
  active,
  onClick,
  explore,
  onMore,
  moreBusy,
}: {
  a: Art
  active: boolean
  onClick: () => void
  explore?: boolean
  onMore?: () => void
  moreBusy?: boolean
}) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      className="cursor-pointer rounded-[10px] border bg-white px-3.5 py-3 transition"
      style={{
        borderColor: active ? LM_BLUE : LM_BORDER,
        boxShadow: active ? 'inset 0 0 0 1px ' + LM_BLUE : undefined,
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[#4b5563]">{authorYear(a)}</span>
        {(a.pdf_path || a.pdf_url) && <Icon name="file" size={13} className="text-[#9aa3b2]" />}
      </div>
      <div
        className="mt-1 text-[13.5px] font-medium leading-snug underline decoration-[#c9d4e8] underline-offset-[3px]"
        style={{ color: LM_CARD_TITLE }}
      >
        {a.title}
      </div>
      {a.venue && <div className="mt-0.5 truncate text-[11.5px] text-[#8a94a6]">{a.venue}</div>}
      <div className="mt-2.5">
        <RefsCitesRow a={a} />
      </div>
      {explore && (
        <div className="mt-2.5 flex items-center gap-2">
          <span className="text-[11px] text-[#6b7280]">精筛：</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onMore?.()
            }}
            disabled={moreBusy}
            className="flex items-center gap-1 rounded-full px-2.5 py-[5px] text-[11.5px] font-medium text-white transition disabled:opacity-60"
            style={{ background: LM_BLUE }}
          >
            {moreBusy ? <TinySpinner /> : <Icon name="check" size={12} />}
            相似文献
          </button>
          <span
            title="隐藏该节点（暂未开放）"
            className="flex h-6 w-6 items-center justify-center rounded-full border text-[#9aa3b2]"
            style={{ borderColor: '#cfd6e0' }}
          >
            <Icon name="eyeOff" size={12} />
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 主组件

export default function GraphView({
  items,
  selectedId,
  onSelect,
  onOpenDetail,
  onOpenPdf,
  onMutated,
}: {
  items: any[]
  selectedId: number | null
  onSelect: (id: number | null) => void
  onOpenDetail: (id: number) => void
  onOpenPdf: (item: any) => void
  onMutated: () => void | Promise<void>
}) {
  const [stage, setStage] = useState<'select' | 'loading' | 'explore'>('select')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Art[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [yearTab, setYearTab] = useState<'rel' | 'y2026' | 'y2025' | 'y2022' | 'custom'>('rel')
  const [customYear, setCustomYear] = useState(2020)
  const [page, setPage] = useState(1)
  const [selArt, setSelArt] = useState<Art | null>(null)
  const [graph, setGraph] = useState<{ nodes: any[]; edges: any[] } | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [seedId, setSeedId] = useState<number | null>(null)
  const [mltId, setMltId] = useState<number | null>(null)
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const dgTask = useAiTask<any>()

  // 从文献库列表点进来时带 selectedId：预选那张卡并直接给详情
  useEffect(() => {
    if (selectedId != null) {
      const it = items.find((p) => Number(p.id) === Number(selectedId))
      if (it) setSelArt(toArt(it, true))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const refresh = () => {
      get('/literature/graph')
        .then((g: any) => setGraph({ nodes: g.nodes || [], edges: g.edges || [] }))
        .catch(() => {})
    }
    window.addEventListener('wb:data-changed', refresh)
    return () => window.removeEventListener('wb:data-changed', refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- 数据

  const loadGraph = async () => {
    const g = await get('/literature/graph')
    setGraph({ nodes: g.nodes || [], edges: g.edges || [] })
    setLoadErr(null)
  }

  const runSearch = async () => {
    const query = q.trim()
    if (!query) return
    setSearching(true)
    try {
      const r: any = await get(`/litsearch?q=${encodeURIComponent(query)}&limit=50`)
      if (r.ok === false) {
        toast(r.error || '检索失败', 'error')
        return
      }
      setHits((r.results || []).map(hitToArt))
      setPage(1)
    } catch (e: any) {
      toast(e?.message || '检索失败', 'error')
    } finally {
      setSearching(false)
    }
  }

  const matchLib = (a: Art): any | null =>
    items.find(
      (p) =>
        (a.openalex_id && p.openalex_id === a.openalex_id) ||
        (a.doi && p.doi && String(p.doi).toLowerCase() === String(a.doi).toLowerCase()) ||
        normTitle(p.title) === normTitle(a.title),
    ) || null

  /** Litmaps 主流程：选文章 → Explore Related Articles → loading → 图谱 */
  const explore = async (art: Art) => {
    setSelArt(art)
    setStage('loading')
    setProgress(5)
    const timer = setInterval(
      () => setProgress((p) => (p >= 92 ? p : p + 2 + Math.random() * 4)),
      260,
    )
    try {
      let id = art.id ?? null
      if (id == null || !art.inLib) {
        const m = matchLib(art)
        if (m) id = Number(m.id)
        else {
          const created: any = await post(
            '/literature',
            {
              title: art.title,
              authors: art.authors || null,
              year: art.year ?? null,
              venue: art.venue || null,
              url: art.url || null,
              doi: art.doi || null,
              openalex_id: art.openalex_id || null,
              status: 'todo',
            },
            { silent: true },
          )
          id = Number(created.id)
        }
      }
      setSeedId(id)
      onSelect(id) // 种子节点 = 深色实心
      await post(`/literature/${id}/expand`, undefined, { silent: true })
      await loadGraph()
      setProgress(100)
      await onMutated()
      setTimeout(() => setStage('explore'), 380)
    } catch (e: any) {
      toast(e?.body?.error?.message || e?.message || 'OpenAlex 没找到这篇文献', 'error')
      setStage('select')
    } finally {
      clearInterval(timer)
    }
  }

  /** More Like This = 展开该节点的引用/被引（真实 OpenAlex 数据，不是猜的相似度） */
  const moreLike = async (id: number) => {
    setMltId(id)
    try {
      await post(`/literature/${id}/expand`, undefined, { silent: true })
      await loadGraph()
      await onMutated()
      toast('已把该节点的引用关系加进图谱', 'ok')
    } catch (e: any) {
      toast(e?.body?.error?.message || e?.message || '展开失败', 'error')
    } finally {
      setMltId(null)
    }
  }

  const doDigest = async () => {
    const id = selArt?.id
    if (!id) return
    const r: any = await dgTask.run(() => post(`/literature/${id}/digest`, undefined, { ok: false }))
    if (!r || r.ok === false) return
    toast('AI 笔记已生成，点笔记图标查看', 'ok')
    await onMutated()
  }

  const exportBib = () => {
    const it = items.find((p) => Number(p.id) === Number(selArt?.id))
    if (!it) return
    downloadText(`${stamp('文献')}.bib`, toBibtex([it]), 'application/x-bibtex;charset=utf-8')
    toast('已导出 BibTeX', 'ok')
  }

  const openPdf = () => {
    if (!selArt) return
    if (selArt.pdf_path && selArt.id != null) {
      const it = items.find((p) => Number(p.id) === Number(selArt.id))
      if (it) onOpenPdf(it)
      return
    }
    if (selArt.pdf_url) window.open(selArt.pdf_url, '_blank', 'noopener')
  }

  // ---------------------------------------------------------------- 列表

  const baseList: Art[] = useMemo(
    () => (hits ?? items.map((p) => toArt(p, true))) as Art[],
    [hits, items],
  )
  const yearMin =
    yearTab === 'y2026' ? 2026 : yearTab === 'y2025' ? 2025 : yearTab === 'y2022' ? 2022 : yearTab === 'custom' ? customYear : null
  const list = useMemo(
    () => (yearMin == null ? baseList : baseList.filter((a) => (a.year ?? 0) >= yearMin)),
    [baseList, yearMin],
  )
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const cur = Math.min(page, totalPages)
  const pageList = list.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE)

  const activeId = selectedId ?? seedId
  const selDetail = useMemo(() => {
    if (!selArt) return null
    if (selArt.inLib && selArt.id != null) {
      const it = items.find((p) => Number(p.id) === Number(selArt.id))
      if (it) return toArt(it, true)
    }
    return selArt
  }, [selArt, items])

  const exploreList = useMemo(() => {
    const ns = [...(graph?.nodes || [])]
    ns.sort((a: any, b: any) => {
      const sa = Number(a.id) === Number(activeId) ? -1 : 0
      const sb = Number(b.id) === Number(activeId) ? -1 : 0
      return sa - sb || Number(b.cited_by_count || 0) - Number(a.cited_by_count || 0)
    })
    return ns
  }, [graph, activeId])

  // ---------------------------------------------------------------- 图谱几何与交互

  const positions = useMemo(() => {
    if (!graph) return new Map<number, Pos>()
    return new Map(timelineLayout(graph.nodes).map((p) => [p.id, p]))
  }, [graph])

  const nodeR = useMemo(() => {
    const m = new Map<number, number>()
    const nodes = graph?.nodes || []
    const max = Math.max(1, ...nodes.map((p) => Number(p.cited_by_count || 0)))
    for (const p of nodes) {
      const c = Number(p.cited_by_count || 0)
      m.set(Number(p.id), 9 + 12 * Math.sqrt(c / max))
    }
    return (id: number) => m.get(id) ?? 9
  }, [graph])

  const neighbors = useMemo(() => {
    const s = new Set<number>()
    if (activeId == null || !graph) return s
    for (const e of graph.edges) {
      if (Number(e.source_id) === Number(activeId)) s.add(Number(e.target_id))
      if (Number(e.target_id) === Number(activeId)) s.add(Number(e.source_id))
    }
    return s
  }, [activeId, graph])

  // React 的 onWheel 是 passive，preventDefault 无效；挂原生非 passive 监听
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      setScale((s) => Math.max(0.45, Math.min(2.6, s * (e.deltaY > 0 ? 0.9 : 1.1))))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [graph, stage])

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest('[data-node]')) return
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
    ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const rect = svgRef.current?.getBoundingClientRect()
    const kx = rect ? W / rect.width : 1
    const ky = rect ? H / rect.height : 1
    setPan({ x: d.px + (e.clientX - d.x) * kx, y: d.py + (e.clientY - d.y) * ky })
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const resetView = () => {
    setScale(1)
    setPan({ x: 0, y: 0 })
  }
  const fullscreen = () => {
    wrapRef.current?.requestFullscreen?.()
  }

  // ---------------------------------------------------------------- 渲染块

  const tabDefs: { key: typeof yearTab; label: string }[] = [
    { key: 'rel', label: '最相关' },
    { key: 'y2026', label: '2026 年起' },
    { key: 'y2025', label: '2025 年起' },
    { key: 'y2022', label: '2022 年起' },
    { key: 'custom', label: '自定义' },
  ]

  const PaginationFooter = ({ total }: { total: number }) => {
    if (total === 0) return null
    const start = (cur - 1) * PAGE_SIZE + 1
    const end = Math.min(cur * PAGE_SIZE, total)
    return (
      <div
        className="flex shrink-0 items-center justify-center gap-3 border-t px-3 py-2.5 text-[11.5px] text-[#8a94a6]"
        style={{ borderColor: LM_BORDER }}
      >
        <button
          className="rounded p-0.5 disabled:opacity-30"
          disabled={cur <= 1}
          onClick={() => setPage(cur - 1)}
          aria-label="上一页"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="tabular-nums">
          {start}-{end} / 共 {total} 篇
        </span>
        <button
          className="rounded p-0.5 disabled:opacity-30"
          disabled={cur >= totalPages}
          onClick={() => setPage(cur + 1)}
          aria-label="下一页"
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    )
  }

  const searchHeader = (
    <>
      <div className="flex gap-2 px-4 pt-4">
        <div className="relative flex-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch()
            }}
            placeholder="搜索文献…"
            className="h-10 w-full rounded-[8px] border px-3 pr-8 text-[13px] text-[#1f2b45] outline-none transition placeholder:text-[#9aa3b2] focus:border-[#2563eb]"
            style={{ borderColor: '#cfd6e0' }}
          />
          {q && (
            <button
              onClick={() => {
                setQ('')
                setHits(null)
                setPage(1)
              }}
              className="absolute right-2 top-2.5 text-[#9aa3b2] hover:text-[#4b5563]"
              aria-label="清除搜索"
            >
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
        <button
          onClick={runSearch}
          disabled={searching || !q.trim()}
          className="flex h-10 w-11 shrink-0 items-center justify-center rounded-[8px] text-white transition hover:brightness-110 disabled:opacity-60"
          style={{ background: LM_BLUE }}
          aria-label="搜索"
        >
          {searching ? <TinySpinner /> : <Icon name="search" size={17} className="text-white" />}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-1 pt-2.5">
        {tabDefs.map((t) => {
          const on = yearTab === t.key
          return (
            <button
              key={t.key}
              onClick={() => {
                setYearTab(t.key)
                setPage(1)
              }}
              className="rounded-[7px] px-2.5 py-1 text-[12px] transition"
              style={
                on
                  ? { background: '#e9eef5', border: '1px solid #c9d3e0', color: '#1f2b45', fontWeight: 500 }
                  : { border: '1px solid transparent', color: '#6b7280' }
              }
            >
              {t.label}
            </button>
          )
        })}
        {yearTab === 'custom' && (
          <input
            type="number"
            value={customYear}
            onChange={(e) => {
              setCustomYear(Number(e.target.value) || 0)
              setPage(1)
            }}
            className="h-7 w-16 rounded-[7px] border px-2 text-[12px] outline-none"
            style={{ borderColor: '#cfd6e0' }}
            aria-label="自定义起始年份"
          />
        )}
      </div>
    </>
  )

  const exploreHeader = (
    <div className="px-4 pb-1 pt-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setStage('select')}
          className="flex h-7 w-7 items-center justify-center rounded-[7px] text-[#6b7280] transition hover:bg-[#eef1f6]"
          title="返回搜索"
          aria-label="返回搜索"
        >
          <Icon name="chevronLeft" size={15} />
        </button>
        <h2 className="text-[19px] font-bold" style={{ color: LM_TITLE }}>
          探索相关文献
        </h2>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => seedId != null && moreLike(seedId)}
          disabled={seedId == null || mltId === seedId}
          className="flex h-7 w-7 items-center justify-center rounded-full border text-[#4b5563] transition hover:bg-[#eef1f6] disabled:opacity-50"
          style={{ borderColor: '#cfd6e0' }}
          title="重新检索种子文献的引用关系"
          aria-label="重新检索"
        >
          {mltId === seedId ? <TinySpinner /> : <Icon name="refresh" size={13} />}
        </button>
        <span
          className="flex items-center gap-1.5 rounded-full border px-3 py-[5px] text-[11.5px] text-[#374151]"
          style={{ borderColor: '#d7dde8' }}
        >
          <span className="text-[#4b5563]">
            筛选 <i className="text-[#4b5563]">按日期、关键词、期刊等…</i>
          </span>
          <FunnelIcon />
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-between text-[11px] italic text-[#9aa3b2]">
        <span>这些结果是怎么算出来的？</span>
        <span className="not-italic text-[#6b7280]">高级</span>
      </div>
    </div>
  )

  const loadingPanel = (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 pb-16">
      <SwirlSpinner />
      <div className="text-center text-[14px] leading-relaxed text-[#374151]">
        正在检索上千条
        <br />
        引用与参考文献…
      </div>
      <div className="flex w-[320px] max-w-full items-center gap-2.5">
        <TinySpinner />
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-[#e5e9f0]">
          <div
            className="h-full rounded-full transition-all duration-200"
            style={{ width: `${progress}%`, background: LM_BLUE }}
          />
        </div>
        <span className="w-9 text-right text-[11px] tabular-nums text-[#8a94a6]">
          {Math.round(progress)}%
        </span>
      </div>
    </div>
  )

  const detailPanel = (a: Art) => {
    const authorsArr = String(a.authors || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const chips =
      authorsArr.length <= 3
        ? authorsArr
        : [authorsArr[0], `+${authorsArr.length - 2}`, authorsArr[authorsArr.length - 1]]
    return (
      <div className="h-full overflow-y-auto px-8 py-6">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-[#4b5563]">{authorYear(a)}</span>
          <div className="flex items-center gap-0.5 text-[#6b7280]">
            {(a.pdf_path || a.pdf_url) && (
              <IconBtn icon="file" size="sm" title="读 PDF" ariaLabel="读 PDF" onClick={openPdf} />
            )}
            {a.id != null && a.inLib && (
              <IconBtn
                icon="sparkle"
                size="sm"
                title="AI 笔记"
                ariaLabel="AI 笔记"
                onClick={doDigest}
              />
            )}
            {a.id != null && a.inLib && (
              <IconBtn
                icon="notebook"
                size="sm"
                title="完整详情 / 笔记"
                ariaLabel="完整详情"
                onClick={() => onOpenDetail(Number(a.id))}
              />
            )}
            {a.id != null && a.inLib && (
              <IconBtn icon="download" size="sm" title="导出 BibTeX" ariaLabel="导出 BibTeX" onClick={exportBib} />
            )}
          </div>
        </div>

        <h2 className="mt-2.5 max-w-[560px] text-[19px] font-semibold leading-snug" style={{ color: LM_TITLE }}>
          {a.title}
        </h2>
        {a.venue && <div className="mt-1 text-[12.5px] text-[#6b7280]">{a.venue}</div>}

        <div className="mt-4 max-w-[560px]">
          <RefsCitesRow a={a} icon />
        </div>

        <button
          onClick={() => explore(a)}
          className="mt-4 flex w-full max-w-[560px] items-center justify-between rounded-[10px] px-4 py-3.5 text-left transition hover:brightness-110"
          style={{ background: LM_BLUE }}
        >
          <span>
            <span className="block text-[15px] font-semibold text-white">探索相关文献</span>
            <span className="mt-0.5 block text-[11.5px] text-white/80">在新的引文图谱中</span>
          </span>
          <Icon name="arrowRight" size={16} className="shrink-0 text-white" />
        </button>

        {chips.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {chips.map((c, i) => (
              <span
                key={`${c}-${i}`}
                className="rounded-[6px] border px-2.5 py-1 text-[11.5px] text-[#374151]"
                style={{ borderColor: '#d7dde8', background: i === 1 && c.startsWith('+') ? '#eef1f6' : '#ffffff' }}
              >
                {c}
              </span>
            ))}
          </div>
        )}

        {a.doi && (
          <div className="mt-4 text-[12px] text-[#4b5563]">
            DOI:{' '}
            <a
              className="underline underline-offset-2"
              style={{ color: LM_TITLE }}
              href={`https://doi.org/${a.doi}`}
              target="_blank"
              rel="noreferrer"
            >
              {a.doi}
            </a>
          </div>
        )}

        {dgTask.error && a.id != null && (
          <div className="mt-4 max-w-[560px]">
            <AiError error={dgTask.error} onRetry={doDigest} retrying={dgTask.busy} title="AI 笔记没有生成" />
          </div>
        )}
      </div>
    )
  }

  const placeholder = (
    <div className="relative h-full overflow-hidden">
      <div className="flex h-full flex-col justify-center px-16 pb-10">
        <div className="flex items-center gap-2.5">
          <svg width="15" height="14" viewBox="0 0 15 14" aria-hidden="true">
            <path d="M15 0 L15 14 L0 7 Z" fill={LM_BLUE} />
          </svg>
          <span className="text-[21px] font-bold" style={{ color: LM_TITLE }}>
            选择一篇文献
          </span>
        </div>
        <p className="mt-3 text-[14.5px] leading-relaxed text-[#4b5563]">
          选定后可在新的引文图谱中
          <br />
          探索它的相关文献。
        </p>
        <PreviewCard />
      </div>
    </div>
  )

  // 图谱区（explore / loading 共用）：SVG + 固定坐标轴覆盖层
  const graphArea = (
    <div ref={wrapRef} className="relative h-full w-full bg-white">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="img"
        aria-label="引文关系图谱"
      >
        <defs>
          <marker id="lm-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 L8 4.5 L0 9 Z" fill={LM_ARROW} />
          </marker>
          <marker id="lm-arrow-hot" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 L8 4.5 L0 9 Z" fill="#7ea6f0" />
          </marker>
        </defs>
        <g transform={`translate(${pan.x} ${pan.y}) scale(${scale})`}>
          {stage === 'loading' ? (
            <>
              <circle cx={W / 2} cy={H / 2 - 10} r={38} fill={LM_HALO} />
              <circle cx={W / 2} cy={H / 2 - 10} r={25} fill={LM_SEED_FILL} />
              <text
                x={W / 2}
                y={H / 2 + 52}
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                fill={LM_TITLE}
              >
                {selArt ? authorYear(selArt) : ''}
              </text>
            </>
          ) : (
            <>
              {graph?.edges.map((e: any) => {
                const a = positions.get(Number(e.source_id))
                const b = positions.get(Number(e.target_id))
                if (!a || !b) return null
                const hot =
                  activeId != null &&
                  (Number(e.source_id) === Number(activeId) || Number(e.target_id) === Number(activeId))
                const ra = nodeR(Number(e.source_id))
                const rb = nodeR(Number(e.target_id))
                const dx = b.x - a.x
                const dy = b.y - a.y
                const d = Math.max(1, Math.hypot(dx, dy))
                // 起点缩进到圆边；终点多留 7px 给箭头，箭头指向被引文献
                const x1 = a.x + (dx / d) * (ra + 1)
                const y1 = a.y + (dy / d) * (ra + 1)
                const x2 = b.x - (dx / d) * (rb + 8)
                const y2 = b.y - (dy / d) * (rb + 8)
                const bend = Math.min(26, d * 0.14)
                const cx = (x1 + x2) / 2 - (dy / d) * bend
                const cy = (y1 + y2) / 2 + (dx / d) * bend
                return (
                  <path
                    key={e.id}
                    d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
                    fill="none"
                    stroke={hot ? LM_EDGE_HOT : LM_EDGE}
                    strokeWidth={hot ? 1.5 : 1}
                    strokeLinecap="round"
                    markerEnd={hot ? 'url(#lm-arrow-hot)' : 'url(#lm-arrow)'}
                  />
                )
              })}
              {graph?.nodes.map((p: any) => {
                const pos = positions.get(Number(p.id))
                if (!pos) return null
                const id = Number(p.id)
                const r = nodeR(id)
                const isActive = id === Number(activeId)
                const isHover = id === hoverId
                return (
                  <g
                    key={p.id}
                    data-node="1"
                    className="cursor-pointer"
                    onClick={() => onSelect(id)}
                    onMouseEnter={() => setHoverId(id)}
                    onMouseLeave={() => setHoverId(null)}
                  >
                    {isActive && <circle cx={pos.x} cy={pos.y} r={r + 10} fill={LM_HALO} />}
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={r}
                      fill={isActive ? LM_SEED_FILL : '#ffffff'}
                      stroke={isActive ? LM_SEED_FILL : isHover ? LM_BLUE_DEEP : LM_NODE_STROKE}
                      strokeWidth={isActive ? 1 : 1.8}
                    />
                    <text
                      x={pos.x}
                      y={pos.y + r + 14}
                      textAnchor="middle"
                      fontSize="11"
                      fontWeight={isActive ? 600 : 400}
                      fill={isActive ? LM_TITLE : LM_TEXT}
                    >
                      {nodeLabel(p)}
                    </text>
                  </g>
                )
              })}
            </>
          )}
        </g>
      </svg>

      {/* 右侧纵轴：更多被引 */}
      <div className="pointer-events-none absolute bottom-24 right-3 top-5 flex flex-col items-center gap-1">
        <svg width="10" height="7" viewBox="0 0 10 7" aria-hidden="true">
          <path d="M5 0 L10 7 L0 7 Z" fill={LM_MUTED} />
        </svg>
        <div className="w-px flex-1" style={{ background: '#c4cbd8' }} />
        <span
          className="text-[10px] font-medium tracking-[0.22em] text-[#8a94a6]"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          更多被引
        </span>
      </div>
      {/* 底部横轴：发表更近 → */}
      <div className="pointer-events-none absolute bottom-4 left-16 right-16 flex items-center gap-2">
        <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true">
          <path d="M7 0 L7 10 L0 5 Z" fill={LM_MUTED} />
        </svg>
        <div className="h-px flex-1" style={{ background: '#c4cbd8' }} />
        <span className="shrink-0 px-2 text-[10px] font-medium tracking-[0.22em] text-[#8a94a6]">
          发表更近 →
        </span>
        <div className="h-px flex-1" style={{ background: '#c4cbd8' }} />
        <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true">
          <path d="M0 0 L0 10 L7 5 Z" fill={LM_MUTED} />
        </svg>
      </div>
      {/* 图例 */}
      <div className="pointer-events-none absolute bottom-12 left-6 flex items-center gap-1.5 text-[10px] text-[#8a94a6]">
        <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
          <path d="M0 4 H12" stroke={LM_MUTED} strokeWidth="1" />
          <path d="M11 1 L15 4 L11 7 Z" fill={LM_MUTED} />
        </svg>
        连线表示引用关系；箭头指向被引文献
      </div>
      {/* 缩放控制 */}
      <div
        className="absolute bottom-12 right-3 z-10 flex flex-col overflow-hidden rounded-[9px] border bg-white shadow-[var(--wb-shadow-sm)]"
        style={{ borderColor: LM_BORDER }}
      >
        <IconBtn icon="maximize" size="sm" title="适配视图" ariaLabel="适配视图" onClick={resetView} />
        <div className="h-px w-full" style={{ background: LM_BORDER }} />
        <IconBtn icon="plus" size="sm" title="放大" ariaLabel="放大" onClick={() => setScale((s) => Math.min(2.6, s * 1.15))} />
        <div className="h-px w-full" style={{ background: LM_BORDER }} />
        <IconBtn icon="minus" size="sm" title="缩小" ariaLabel="缩小" onClick={() => setScale((s) => Math.max(0.45, s * 0.85))} />
        <div className="h-px w-full" style={{ background: LM_BORDER }} />
        <IconBtn icon="scan" size="sm" title="全屏" ariaLabel="全屏" onClick={fullscreen} />
      </div>
    </div>
  )

  // ---------------------------------------------------------------- 整体

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-white">
      {/* 左栏：搜索/详情两态共用一张卡列表 */}
      <aside className="flex w-[400px] shrink-0 flex-col border-r" style={{ borderColor: LM_BORDER }}>
        {stage === 'select' && searchHeader}
        {stage === 'explore' && exploreHeader}

        {stage === 'loading' ? (
          loadingPanel
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3 pt-3">
              {stage === 'select' ? (
                pageList.length === 0 ? (
                  <p className="px-2 py-10 text-center text-[12px] leading-relaxed text-[#9aa3b2]">
                    {hits
                      ? '没有结果。换个关键词，或清掉年份过滤再试。'
                      : '文献库还是空的。去「检索」标签导入文献，或直接在上方搜索 OpenAlex。'}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {pageList.map((a) => (
                      <ArtCard
                        key={`${a.inLib ? 'lib' : 'hit'}-${a.id ?? a.openalex_id ?? a.title}`}
                        a={a}
                        active={
                          selDetail != null &&
                          ((a.id != null && Number(a.id) === Number(selDetail.id)) ||
                            (a.openalex_id != null && a.openalex_id === selDetail.openalex_id))
                        }
                        onClick={() => setSelArt(a)}
                      />
                    ))}
                  </div>
                )
              ) : exploreList.length === 0 ? (
                <p className="px-2 py-10 text-center text-[12px] leading-relaxed text-[#9aa3b2]">
                  图谱是空的。点右上角刷新按钮重新检索。
                </p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {exploreList.map((p: any) => (
                    <ArtCard
                      key={p.id}
                      a={toArt(p, true)}
                      active={Number(p.id) === Number(activeId)}
                      onClick={() => onSelect(Number(p.id))}
                      explore
                      moreBusy={mltId === Number(p.id)}
                      onMore={() => moreLike(Number(p.id))}
                    />
                  ))}
                </div>
              )}
            </div>
            {stage === 'select' ? (
              <PaginationFooter total={list.length} />
            ) : (
              <PaginationFooter total={exploreList.length} />
            )}
          </>
        )}
      </aside>

      {/* 右区：详情 / 占位 / 图谱 */}
      <section className="min-w-0 flex-1">
        {loadErr && stage !== 'select' ? (
          <Empty
            text="关联图加载失败"
            hint={loadErr}
            action={
              <Btn size="sm" onClick={() => loadGraph().catch(() => {})}>
                重试
              </Btn>
            }
          />
        ) : stage === 'select' ? (
          selDetail ? (
            detailPanel(selDetail)
          ) : (
            placeholder
          )
        ) : (
          graphArea
        )}
      </section>
    </div>
  )
}
