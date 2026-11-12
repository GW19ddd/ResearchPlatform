/**
 * 绘图工作室 · 参考画廊（agent-figure-gallery 形态）。
 *
 * 复刻 AgentFigureGallery 的网页版：选 plot type + 数量 + 策略 + 任务 → 生成候选会话 →
 * 候选卡片网格（点赞/拒/选 + 状态筛选 + 搜索）。点「用作样板」把选中的参考图与元数据
 * 作为风格样板回传给编辑器（onUseReference），由 FigureStudio 在编辑器里贴出预览 + 占位 spec。
 *
 * 后端全部走 /api/figure-gallery/*（包住 agentfiguregallery 纯 stdlib 包，不另起端口）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Btn, Drawer, IconBtn, Select, StatusTag } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { get, post } from '../../lib/api'
import { toast } from '../../components/toast'

export type GalleryCandidate = {
  candidate_id: string
  stable_candidate_id?: string
  display_id?: string
  session_candidate_id?: string
  reference_candidate_id?: string
  plot_type?: string
  primary_plot_type?: string
  source_repo?: string
  quality_score?: number
  why_suggested?: string
  what_to_borrow?: string[] | string
  design_takeaways?: string[] | string
  tags?: string[] | string
  script_path_rel?: string
  preview_path?: string
  preview_path_rel?: string
  preview_url?: string
  palette?: string[]
  script_exists?: boolean
  status?: string
  global_status?: string
}

export type GallerySession = {
  session_id?: string
  resolved?: { plot_type?: string }
  candidates?: GalleryCandidate[]
  preferences?: Record<string, unknown>
  status_counts?: Record<string, number>
  global_status_counts?: Record<string, number>
  session_json?: string
}

const PLOT_TYPES = [
  { value: 'bar_chart', label: '柱状图 bar' },
  { value: 'line_chart', label: '折线图 line' },
  { value: 'scatter_plot', label: '散点图 scatter' },
  { value: 'heatmap_matrix', label: '热力矩阵 heatmap' },
  { value: 'box_violin_distribution', label: '箱线/分布 box' },
  { value: 'embedding_plot', label: '嵌入投影 embedding' },
  { value: 'benchmark_performance', label: '基准对比 benchmark' },
  { value: 'multi_panel_figure', label: '多面板 multipanel' },
  { value: 'spatial_map', label: '空间地图 map' },
  { value: 'microscopy_panel', label: '显微面板 microscopy' },
]

const STRATEGIES = [
  { value: 'explore', label: 'Explore（前几 + 随机）' },
  { value: 'top', label: 'Top（按质量序）' },
  { value: 'random', label: 'Random（全随机）' },
]

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'candidate', label: '待选' },
  { key: 'liked', label: '已赞' },
  { key: 'global_liked', label: '全局赞' },
  { key: 'selected', label: '已选' },
  { key: 'rejected', label: '已拒' },
] as const

const STATUS_TONE: Record<string, 'gray' | 'ok' | 'warn' | 'danger' | 'info'> = {
  candidate: 'gray',
  liked: 'ok',
  rejected: 'danger',
  selected: 'info',
}

function previewSrc(c: GalleryCandidate): string {
  const p = c.preview_path || (c.preview_url ? c.preview_url.replace(/^\/media/, '') : '')
  return p ? `/api/figure-gallery/media?path=${encodeURIComponent(p)}` : ''
}

/** 把 string | string[] 统一成字符串数组（设计要点 / tags 在索引里有时是数组、有时是串）。 */
function asList(v: string[] | string | undefined): string[] {
  if (!v) return []
  return Array.isArray(v) ? v.filter(Boolean) : [String(v)]
}

/** 复制文本到剪贴板（兼容无 navigator.clipboard 的环境）。 */
async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    toast('已复制源码路径', 'ok')
  } catch {
    toast('复制失败', 'error')
  }
}

export default function FigureGallery({
  onUseReference,
}: {
  onUseReference: (c: GalleryCandidate) => void
}) {
  const [sessions, setSessions] = useState<{ session_id: string; session_json: string; plot_type?: string; candidate_count?: number }[]>([])
  const [session, setSession] = useState<GallerySession | null>(null)
  const [sessionValue, setSessionValue] = useState('')

  const [plotType, setPlotType] = useState('bar_chart')
  const [limit, setLimit] = useState(60)
  const [strategy, setStrategy] = useState('explore')
  const [task, setTask] = useState('选 Nature / Cell 风格的参考图')

  const [filter, setFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')

  const [busyGen, setBusyGen] = useState(false)
  const [busyPref, setBusyPref] = useState(false)
  const [msg, setMsg] = useState('')

  // 详情抽屉：点卡片打开，展示大图 + 源码路径 + 设计要点
  const [detail, setDetail] = useState<GalleryCandidate | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [paletteDark, setPaletteDark] = useState(false)

  const loadSessions = useCallback(async (preferred?: string) => {
    try {
      const r: any = await get('/figure-gallery/sessions')
      const list = r.sessions || []
      setSessions(list)
      const match = preferred
        ? list.find((s: any) => s.session_json === preferred || s.session_id === preferred)
        : null
      const pick = match || (list[0] && { session_json: list[0].session_json })
      if (pick) {
        setSessionValue(pick.session_json)
        await loadSession(pick.session_json)
      } else {
        setSession(null)
      }
    } catch (e: any) {
      setMsg(e?.message || '加载会话失败')
    }
  }, [])

  const loadSession = useCallback(async (value: string) => {
    if (!value) return
    try {
      const r: any = await get(`/figure-gallery/session?session=${encodeURIComponent(value)}`)
      setSession(r)
      setSessionValue(r.session_json || value)
    } catch (e: any) {
      setMsg(e?.message || '加载会话失败')
    }
  }, [])

  /** 精选榜：跨全部类型按质量分取最高的一批参考，固定会话（偏好保留）。 */
  const loadFeatured = useCallback(async (): Promise<boolean> => {
    setBusyGen(true)
    setMsg('正在加载精选榜…')
    try {
      const r: any = await post('/figure-gallery/featured', { limit: 24 }, { ok: false })
      setSession(r)
      setSessionValue(r.session_json || '')
      setMsg(`精选榜 · 全类型质量 Top ${r.candidates?.length ?? 0}`)
      try {
        const s: any = await get('/figure-gallery/sessions')
        setSessions(s.sessions || [])
      } catch {
        /* 会话下拉刷新失败不影响展示 */
      }
      return true
    } catch (e: any) {
      setMsg(e?.message || '精选榜加载失败')
      return false
    } finally {
      setBusyGen(false)
    }
  }, [])

  useEffect(() => {
    // 打开画廊即展示「精选榜」：全类型质量最高的参考；失败再回退到最近会话
    ;(async () => {
      const ok = await loadFeatured()
      if (!ok) loadSessions()
    })()
  }, [loadFeatured, loadSessions])

  const generate = async () => {
    setBusyGen(true)
    setMsg('正在生成候选会话…')
    try {
      const r: any = await post(
        '/figure-gallery/generate',
        {
          plot_type: plotType,
          task,
          limit,
          strategy,
          session_id: `gallery_${plotType}_${strategy}_${Date.now()}`,
          seed: Date.now(),
        },
        { ok: false },
      )
      await loadSessions(r.session_json)
      setMsg(`已生成 ${r.session_id}（${r.candidates?.length ?? 0} 个候选）`)
    } catch (e: any) {
      setMsg(e?.message || '生成失败')
    } finally {
      setBusyGen(false)
    }
  }

  const applyPref = async (c: GalleryCandidate, action: string) => {
    if (!session) return
    setBusyPref(true)
    try {
      const r: any = await post(
        '/figure-gallery/preference',
        {
          session: session.session_json || sessionValue,
          candidate_id: c.candidate_id || c.stable_candidate_id || c.display_id,
          action,
          updated_at: new Date().toISOString(),
        },
        { ok: false, silent: true },
      )
      setSession(r)
      // 抽屉打开时，把被操作的那条同步成最新状态
      setDetail((d) => {
        if (!d) return d
        const id = d.candidate_id || d.stable_candidate_id || d.display_id
        const upd = r.candidates?.find(
          (x: GalleryCandidate) => (x.candidate_id || x.stable_candidate_id || x.display_id) === id,
        )
        return upd ? { ...d, ...upd } : d
      })
    } catch (e: any) {
      toast(e?.message || '操作失败', 'error')
    } finally {
      setBusyPref(false)
    }
  }

  const openDetail = async (c: GalleryCandidate) => {
    const id = c.candidate_id || c.stable_candidate_id || c.display_id || ''
    const sid = session?.session_json || sessionValue
    // 先用本地快照立刻打开，再向后端拉完整元数据（设计要点 / 源码是否存在）
    setDetail({ ...c })
    if (!sid || !id) return
    setDetailLoading(true)
    try {
      const r: any = await get(
        `/figure-gallery/candidate?session=${encodeURIComponent(sid)}&candidate_id=${encodeURIComponent(id)}`,
      )
      setDetail(r)
    } catch {
      /* 保持本地快照 */
    } finally {
      setDetailLoading(false)
    }
  }

  const exportBundle = async () => {
    if (!session) return
    try {
      const r: any = await post(
        '/figure-gallery/export',
        { session: session.session_json || sessionValue, copy_scripts: true },
        { ok: false },
      )
      toast(`已导出 bundle：${r?.paths?.bundle_json || ''}`, 'ok')
    } catch (e: any) {
      toast(e?.message || '导出失败', 'error')
    }
  }

  const clearRejected = async () => {
    if (!session) return
    try {
      const r: any = await post(
        '/figure-gallery/preference',
        { session: session.session_json || sessionValue, action: 'clear_rejected', updated_at: new Date().toISOString() },
        { ok: false, silent: true },
      )
      setSession(r)
    } catch (e: any) {
      toast(e?.message || '操作失败', 'error')
    }
  }

  const candidates = session?.candidates || []

  const sources = useMemo(() => {
    const s = new Set<string>()
    candidates.forEach((c) => c.source_repo && s.add(c.source_repo))
    return Array.from(s).sort()
  }, [candidates])

  const counts = useMemo(() => {
    const base = { all: candidates.length, candidate: 0, liked: 0, selected: 0, rejected: 0, globalLiked: 0, globalRejected: 0 }
    candidates.forEach((c) => {
      const typeLiked = c.status === 'liked' || c.status === 'selected'
      if (c.global_status === 'global_liked') base.globalLiked++
      if (c.global_status === 'global_rejected') base.globalRejected++
      if (c.status === 'selected') base.selected++
      else if (typeLiked) base.liked++
      else if (c.status === 'rejected' || c.global_status === 'global_rejected') base.rejected++
      else if (c.status === 'candidate') base.candidate++
    })
    return base
  }, [candidates])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return candidates.filter((c) => {
      const globallyRejected = c.global_status === 'global_rejected'
      if (filter === 'all' && globallyRejected) return false
      if (filter === 'candidate' && (globallyRejected || c.status !== 'candidate')) return false
      if (filter === 'liked' && !((c.status === 'liked' || c.status === 'selected') && !globallyRejected)) return false
      if (filter === 'global_liked' && c.global_status !== 'global_liked') return false
      if (filter === 'selected' && (c.status !== 'selected' || globallyRejected)) return false
      if (filter === 'rejected' && c.status !== 'rejected' && !globallyRejected) return false
      if (source !== 'all' && c.source_repo !== source) return false
      if (q) {
        const hay = [
          c.candidate_id,
          c.stable_candidate_id,
          c.display_id,
          c.reference_candidate_id,
          c.source_repo,
          c.why_suggested,
          c.script_path_rel,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [candidates, filter, source, query])

  const resolvedPt = session?.resolved?.plot_type || plotType
  // 精选榜会话：榜单内第 1 名加 TOP 1 徽标
  const isFeatured = session?.resolved?.plot_type === 'featured'
  const topCid = candidates[0]?.candidate_id

  /** 在「当前筛选后的画廊列表」里按 delta 翻到上一张 / 下一张（键盘左右同效）。 */
  const goTo = (delta: number) => {
    if (!detail) return
    const id = detail.candidate_id || detail.stable_candidate_id || detail.display_id
    const idx = visible.findIndex((c) => (c.candidate_id || c.stable_candidate_id || c.display_id) === id)
    const base = idx < 0 ? 0 : idx
    const nextIdx = base + delta
    if (nextIdx < 0 || nextIdx >= visible.length) return
    openDetail(visible[nextIdx])
  }

  // 抽屉打开时支持 ← / → 切换上一张 / 下一张
  useEffect(() => {
    if (!detail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goTo(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goTo(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail, visible])

  // 当前详情在「筛选后列表」中的位置（翻页导航 / 键盘切换用）
  const detailIdx = detail
    ? (() => {
        const id = detail.candidate_id || detail.stable_candidate_id || detail.display_id
        const idx = visible.findIndex((c) => (c.candidate_id || c.stable_candidate_id || c.display_id) === id)
        return idx < 0 ? 0 : idx
      })()
    : -1

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 控制条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            参考画廊：浏览科学绘图参考图，点赞 / 拒 / 选，挑一张「用作样板」回到编辑器照着画
          </p>
        </div>
        {msg && <span className="text-[11px] text-[color:var(--wb-muted)]">{msg}</span>}
        <Btn size="sm" onClick={() => loadFeatured()} disabled={busyGen}>
          精选榜
        </Btn>
        <Select value={plotType} onChange={setPlotType} options={PLOT_TYPES} />
        <Select value={strategy} onChange={setStrategy} options={STRATEGIES} />
        <input
          type="number"
          min={12}
          max={200}
          step={4}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value) || 60)}
          className="h-7 w-16 rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-2 text-[12px] text-[color:var(--wb-text)] outline-none"
          aria-label="候选数量"
        />
        <Btn size="sm" variant="primary" onClick={generate} loading={busyGen}>
          生成候选
        </Btn>
        <IconBtn icon="refresh" size="md" ariaLabel="刷新会话" title="刷新" onClick={() => loadSessions(sessionValue)} />
      </div>

      {/* 左控制 / 右画廊 */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[260px] shrink-0 flex-col gap-4 overflow-auto border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] p-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-[color:var(--wb-text)]">会话</label>
            <Select
              value={sessionValue}
              onChange={(v) => {
                setSessionValue(v)
                loadSession(v)
              }}
              options={[
                { value: '', label: '（无会话）' },
                ...sessions.map((s) => ({ value: s.session_json, label: `${s.session_id} · ${s.plot_type || '?'} · ${s.candidate_count}` })),
              ]}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-[color:var(--wb-text)]">绘图类型</label>
            <Select value={plotType} onChange={setPlotType} options={PLOT_TYPES} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-[color:var(--wb-text)]">策略</label>
            <Select value={strategy} onChange={setStrategy} options={STRATEGIES} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-[color:var(--wb-text)]">候选数量</label>
            <input
              type="number"
              min={12}
              max={200}
              step={4}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 60)}
              className="h-8 rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-2 text-[12px] text-[color:var(--wb-text)] outline-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium text-[color:var(--wb-text)]">任务描述</label>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              className="resize-none rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] p-2 text-[12px] leading-relaxed text-[color:var(--wb-text)] outline-none"
            />
          </div>
          <Btn size="sm" variant="primary" onClick={generate} loading={busyGen}>
            生成候选会话
          </Btn>

          <div className="mt-1 border-t border-[color:var(--wb-border)] pt-3">
            <Btn size="sm" onClick={exportBundle} disabled={!session}>
              导出选中 bundle
            </Btn>
            <button
              onClick={clearRejected}
              disabled={!session}
              className="mt-2 w-full text-left text-[11px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-accent)]"
            >
              清除已拒候选
            </button>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col bg-[color:var(--wb-surface)]">
          {/* 工具栏：状态筛选 + 计数 */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[color:var(--wb-border)] px-3 py-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-2.5 py-1 text-[11px] transition ${
                  filter === f.key
                    ? 'bg-[color:var(--wb-accent)] text-white'
                    : 'bg-[color:var(--wb-surface-alt)] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'
                }`}
              >
                {f.label} <span className="tabular-nums">{counts[f.key === 'global_liked' ? 'globalLiked' : f.key] ?? 0}</span>
              </button>
            ))}
            <span className="ml-auto text-[11px] text-[color:var(--wb-muted)]">
              {isFeatured ? '精选 · 全类型质量榜' : resolvedPt} · {candidates.length} 候选
            </span>
          </div>

          {/* 搜索 + 来源 */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-2">
            <div className="relative flex-1">
              <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--wb-muted)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="按 id / 仓库 / 说明过滤"
                className="h-8 w-full rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] pl-8 pr-2 text-[12px] text-[color:var(--wb-text)] outline-none"
              />
            </div>
            <Select
              value={source}
              onChange={setSource}
              options={[{ value: 'all', label: '全部来源' }, ...sources.map((s) => ({ value: s, label: s }))]}
            />
          </div>

          {/* 画廊网格 */}
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!session ? (
              <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--wb-muted)]">
                正在加载精选榜；若长时间空白，请检查知识库是否可用（设置 AGENT_FIGURE_GALLERY_ROOT）
              </div>
            ) : visible.length === 0 ? (
              <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--wb-muted)]">
                没有符合当前筛选的候选
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
                {visible.map((c) => {
                  const tone = STATUS_TONE[c.status || 'candidate'] || 'gray'
                  const src = previewSrc(c)
                  const active =
                    c.status === 'liked' || c.status === 'selected'
                      ? 'ring-2 ring-[color:var(--wb-ok)]'
                      : c.status === 'rejected'
                      ? 'opacity-60'
                      : ''
                  return (
                    <article
                      key={c.candidate_id}
                      className={`flex flex-col overflow-hidden rounded-[var(--wb-radius)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-xs)] ${active}`}
                    >
                      <div className="relative flex h-40 items-center justify-center overflow-hidden bg-[color:var(--wb-surface-alt)]">
                        {src ? (
                          <img
                            src={src}
                            alt={c.display_id || c.candidate_id}
                            loading="lazy"
                            onClick={() => openDetail(c)}
                            className="h-full w-full cursor-zoom-in object-contain"
                          />
                        ) : (
                          <span className="text-[11px] text-[color:var(--wb-muted)]">无预览</span>
                        )}
                        <button
                          onClick={() => openDetail(c)}
                          title="查看大图与设计要点"
                          aria-label="详情"
                          className="absolute right-1.5 top-1.5 rounded-md bg-[rgba(16,17,20,0.55)] p-1 text-white transition hover:bg-[rgba(16,17,20,0.8)]"
                        >
                          <Icon name="eye" size={13} />
                        </button>
                        {isFeatured && c.candidate_id === topCid && (
                          <span className="absolute left-1.5 top-1.5 rounded-full bg-[color:var(--wb-accent)] px-2 py-0.5 text-[10px] font-medium text-white shadow-[var(--wb-shadow-xs)]">
                            TOP 1
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col gap-2 p-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium text-[color:var(--wb-text)]">
                            {c.display_id || c.candidate_id}
                          </span>
                          {c.session_candidate_id && (
                            <span className="rounded bg-[color:var(--wb-surface-alt)] px-1 text-[10px] text-[color:var(--wb-muted)]">
                              {c.session_candidate_id}
                            </span>
                          )}
                          <span className="ml-auto">
                            <StatusTag tone={tone}>{c.global_status && c.global_status !== 'none' ? `${c.status}·全局` : c.status || 'candidate'}</StatusTag>
                          </span>
                        </div>
                        <p className="truncate text-[10.5px] text-[color:var(--wb-muted)]">
                          {c.source_repo || 'unknown'}
                          {c.quality_score ? ` · score ${c.quality_score}` : ''}
                          {c.reference_candidate_id ? ` · ref ${c.reference_candidate_id}` : ''}
                        </p>
                        <p className="line-clamp-2 min-h-[28px] text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
                          {c.why_suggested || c.script_path_rel || ''}
                        </p>
                        <div className="flex flex-wrap gap-1">
                          <Btn size="xs" onClick={() => applyPref(c, 'like')} disabled={busyPref}>
                            赞
                          </Btn>
                          <Btn size="xs" onClick={() => applyPref(c, 'reject')} disabled={busyPref}>
                            拒
                          </Btn>
                          <Btn size="xs" variant="primary" onClick={() => applyPref(c, 'select')} disabled={busyPref}>
                            选
                          </Btn>
                          <Btn size="xs" variant="primary" onClick={() => onUseReference(c)}>
                            用作样板
                          </Btn>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* 详情抽屉：大图 + 源码路径 + 设计要点 */}
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={
          <span className="flex items-center gap-2">
            <Icon name="image" size={15} className="text-[color:var(--wb-accent)]" />
            <span className="truncate">{detail?.display_id || detail?.candidate_id || '参考详情'}</span>
            {detailLoading && <span className="text-[11px] font-normal text-[color:var(--wb-muted)]">加载中…</span>}
          </span>
        }
        footer={
          detail && (
            <div className="flex flex-wrap gap-2">
              <Btn size="xs" onClick={() => applyPref(detail, 'like')} disabled={busyPref}>赞</Btn>
              <Btn size="xs" onClick={() => applyPref(detail, 'reject')} disabled={busyPref}>拒</Btn>
              <Btn size="xs" variant="primary" onClick={() => applyPref(detail, 'select')} disabled={busyPref}>选</Btn>
              <Btn size="xs" variant="primary" onClick={() => { onUseReference(detail); setDetail(null) }}>
                用作样板
              </Btn>
            </div>
          )
        }
      >
        {detail && (
          <div className="flex flex-col gap-5">
            {/* 翻页导航：← / → 同效 */}
            <div className="flex items-center gap-2">
              <IconBtn
                icon="chevronLeft"
                size="sm"
                ariaLabel="上一张"
                onClick={() => goTo(-1)}
                disabled={detailIdx <= 0}
              />
              <span className="tabular-nums text-[11px] text-[color:var(--wb-muted)]">
                {detailIdx + 1} / {visible.length}
              </span>
              <IconBtn
                icon="chevronRight"
                size="sm"
                ariaLabel="下一张"
                onClick={() => goTo(1)}
                disabled={detailIdx >= visible.length - 1}
              />
              <span className="ml-auto text-[10.5px] text-[color:var(--wb-muted)]">← / → 切换</span>
            </div>

            <div className="flex max-h-[44vh] items-center justify-center overflow-hidden rounded-[var(--wb-radius)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)]">
              {previewSrc(detail) ? (
                <img src={previewSrc(detail)} alt={detail.display_id || detail.candidate_id} className="max-h-[44vh] w-full object-contain" />
              ) : (
                <span className="text-[12px] text-[color:var(--wb-muted)]">无预览</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-[color:var(--wb-muted)]">
              <StatusTag tone={STATUS_TONE[detail.status || 'candidate'] || 'gray'}>
                {detail.global_status && detail.global_status !== 'none' ? `${detail.status}·全局` : detail.status || 'candidate'}
              </StatusTag>
              <span>{detail.plot_type || '?'}</span>
              {detail.source_repo && <span>来源：{detail.source_repo}</span>}
              {detail.quality_score ? <span>质量分 {detail.quality_score}</span> : null}
            </div>

            {/* 设计要点 */}
            <section className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-text)]">
                <Icon name="lightbulb" size={14} className="text-[color:var(--wb-accent)]" />
                设计要点
              </p>
              {asList(detail.design_takeaways).length > 0 ? (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                  {asList(detail.design_takeaways).map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-col gap-1.5 text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                  {detail.why_suggested && <p>{detail.why_suggested}</p>}
                  {asList(detail.tags).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {asList(detail.tags).map((t, i) => (
                        <span key={i} className="rounded-full bg-[color:var(--wb-surface-alt)] px-2 py-0.5 text-[10.5px] text-[color:var(--wb-muted)]">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* 源码路径 */}
            <section className="flex flex-col gap-1.5">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-text)]">
                <Icon name="quill" size={14} className="text-[color:var(--wb-accent)]" />
                源码脚本路径
                {detail.script_path_rel && (
                  <IconBtn
                    icon="copy"
                    size="sm"
                    ariaLabel="复制源码路径"
                    title="复制路径"
                    className="ml-1"
                    onClick={() => copyText(detail.script_path_rel || '')}
                  />
                )}
              </p>
              {detail.script_path_rel ? (
                <>
                  <code className="block break-all rounded-[var(--wb-radius-sm)] bg-[color:var(--wb-surface-alt)] p-2 font-mono text-[11px] text-[color:var(--wb-text-soft)]">
                    {detail.script_path_rel}
                  </code>
                  <p className="text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
                    {detail.script_exists
                      ? '该源脚本已随知识库本地存在，可在 KB 根目录下直接打开。'
                      : '上游来源路径：知识库索引未随附本地脚本文件，仅供参考；本机已按元数据（工具 / colormap）推断调色板。'}
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-[color:var(--wb-muted)]">无源码路径</p>
              )}
            </section>

            {/* 推断调色板 */}
            {detail.palette && detail.palette.length > 0 && (
              <section className="flex flex-col gap-2">
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-text)]">
                  <Icon name="sparkle" size={14} className="text-[color:var(--wb-accent)]" />
                  推断调色板（用作样板时带入 spec）
                  <button
                    onClick={() => setPaletteDark((v) => !v)}
                    title={paletteDark ? '切换到亮色底预览' : '切换到暗色底预览'}
                    className={`ml-auto rounded-full px-2.5 py-0.5 text-[10.5px] transition ${
                      paletteDark
                        ? 'bg-[#1c1d21] text-[#e8e9ec]'
                        : 'bg-[color:var(--wb-surface-alt)] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'
                    }`}
                  >
                    {paletteDark ? '暗色底' : '亮色底'}
                  </button>
                </p>
                <div
                  className={`flex flex-wrap gap-2.5 rounded-[var(--wb-radius)] transition ${
                    paletteDark ? 'bg-[#1c1d21] p-2.5' : ''
                  }`}
                >
                  {detail.palette.map((hex, i) => (
                    <div key={i} className="flex flex-col items-center gap-1">
                      <span
                        className={`h-7 w-7 rounded-md shadow-[var(--wb-shadow-xs)] ${
                          paletteDark ? 'border border-[#33353a]' : 'border border-[color:var(--wb-border)]'
                        }`}
                        style={{ background: hex }}
                      />
                      <span
                        className={`font-mono text-[9.5px] ${
                          paletteDark ? 'text-[#9aa0aa]' : 'text-[color:var(--wb-muted)]'
                        }`}
                      >
                        {hex}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
                  明暗切换只改变预览底色，用于判断同一组颜色在亮/暗图面背景下的可读性，不会改动带入 spec 的色值。
                </p>
              </section>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}
