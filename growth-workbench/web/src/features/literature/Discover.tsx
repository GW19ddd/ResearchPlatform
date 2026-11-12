/**
 * 文献检索（Litmaps 式三段体验）：
 *
 *   idle      —— 大搜索框 + 论文建议（本地馆藏 / OpenAlex 两类来源）
 *   searching —— 后端 SSE 的真实阶段进度 + 画布上先长出种子节点
 *   results   —— 左栏「关联文献」卡片列表（参考文献 / 被引 / 更多类似 / 入库）
 *                + 右栏「年份 × 被引」引文网络
 *
 * 数据全部来自 OpenAlex 实时检索，默认不落库；点「入库」才走原 POST /literature，
 * 之后的去重、AI 笔记、对比矩阵与文献库共用同一条链路。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Btn,
  Empty,
  Modal,
  Pagination,
  Pill,
  Progress,
  SearchInput,
  Segmented,
  Spinner,
} from '../../components/ui'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { get, post } from '../../lib/api'
import DiscoverMap from './DiscoverMap'
import {
  firstAuthor,
  normTitle,
  shortLabel,
  streamDiscover,
  type DiscoverEvent,
  type DiscoverError,
  type DiscoverPaper,
  type DiscoverResult,
  type DiscoverStage,
  type Suggestion,
} from './discoverApi'
import { LM_BLUE, LM_BLUE_SOFT, LM_BORDER, LM_BORDER_STRONG, LM_CHIP_BG, LM_EDGE_HOT, LM_FAINT, LM_NODE_STROKE, LM_TEXT, LM_TITLE } from './litColors'

type Phase = 'idle' | 'searching' | 'results'
type StartParams = { q?: string; oa_id?: string; limit?: number }

const QUICK_TERMS = [
  'Attention Is All You Need',
  'Mixed-Effects Models in S and S-PLUS',
  'GPT-4 Technical Report',
]

const STAGE_STEPS = [
  { key: 'resolve', label: '定位种子文献' },
  { key: 'seed', label: '锁定种子并读取元数据' },
  { key: 'references', label: '检索参考文献' },
  { key: 'citing', label: '检索施引文献' },
  { key: 'graph', label: '构建引文网络' },
]

const RELATION_OPTIONS: { value: 'all' | 'reference' | 'citing'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'reference', label: '参考文献' },
  { value: 'citing', label: '施引文献' },
]

/** 首屏背景：极淡的引文网络涂鸦，呼应 Litmaps 的 hero */
function HeroDoodle() {
  const nodes: [number, number, number][] = [
    [40, 60, 4], [130, 30, 3], [210, 80, 5], [300, 40, 3], [390, 95, 4],
    [480, 35, 3], [560, 85, 5], [660, 45, 3], [740, 100, 4], [830, 55, 3],
    [100, 145, 3], [250, 160, 4], [430, 140, 3], [610, 165, 4], [780, 150, 3],
  ]
  const lines: [number, number][] = [
    [0, 2], [2, 3], [3, 5], [5, 6], [6, 8], [1, 2], [4, 6], [7, 8],
    [10, 11], [11, 12], [12, 13], [2, 11], [4, 12], [6, 13], [8, 14],
  ]
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 880 200" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {lines.map(([a, b], i) => (
        <line key={i} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} stroke={LM_EDGE_HOT} strokeWidth="1" opacity="0.5" />
      ))}
      {nodes.map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill={LM_NODE_STROKE} opacity="0.45" />
      ))}
    </svg>
  )
}

export default function Discover({ onImported }: { onImported?: () => void }) {
  const navigate = useNavigate()
  // ---- 本地馆藏：给建议项 + 去重「已在库」 ----
  const [libRows, setLibRows] = useState<any[]>([])
  const loadLib = useCallback(async () => {
    try {
      setLibRows(await get('/literature'))
    } catch {
      // 馆藏清单只是增强，拉不到不影响检索
    }
  }, [])
  useEffect(() => {
    loadLib()
  }, [loadLib])

  const libTitleSet = useMemo(
    () => new Set(libRows.map((r) => normTitle(r.title))),
    [libRows],
  )
  // 馆藏里带 OpenAlex ID 的条目，用于入库时把快照引用边落到馆藏图谱
  const libOa = useMemo(
    () => new Set(libRows.map((r: any) => r.openalex_id).filter(Boolean) as string[]),
    [libRows],
  )

  // ---- 搜索框与建议 ----
  const [q, setQ] = useState('')
  const [sugOpen, setSugOpen] = useState(false)
  const [sugLoading, setSugLoading] = useState(false)
  const [remoteSug, setRemoteSug] = useState<Suggestion[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const sugBoxRef = useRef<HTMLDivElement | null>(null)
  const sugSeq = useRef(0)

  const localSug = useMemo<Suggestion[]>(() => {
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return []
    return libRows
      .filter((r) =>
        [r.title, r.authors, r.venue, r.year].filter(Boolean).join(' ').toLowerCase().includes(needle),
      )
      .slice(0, 4)
      .map((r) => ({
        key: `local-${r.id}`,
        head: `${firstAuthor(r.authors || '')}, ${r.year ?? '年份未知'}`,
        title: r.title,
        sub: r.venue || '',
        source: '本地馆藏' as const,
        oa_id: r.openalex_id || undefined,
        year: r.year ?? null,
      }))
  }, [libRows, q])

  const suggestions = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [...localSug]
    const seen = new Set(localSug.map((s) => normTitle(s.title)))
    for (const s of remoteSug) {
      if (seen.has(normTitle(s.title))) continue
      seen.add(normTitle(s.title))
      out.push(s)
      if (out.length >= 9) break
    }
    return out
  }, [localSug, remoteSug])

  // 输入停顿 650ms 才打 OpenAlex：一次关键词检索要花 10 credits（无 key 时每天只够约 100 次），
  // 停得越久越省；后端对同一 query 还有 15 分钟缓存。
  useEffect(() => {
    const kw = q.trim()
    if (kw.length < 2) {
      setRemoteSug([])
      setSugLoading(false)
      return
    }
    sugSeq.current += 1
    const seq = sugSeq.current
    setSugLoading(true)
    const t = window.setTimeout(async () => {
      try {
        const r: any = await get(`/litsearch?q=${encodeURIComponent(kw)}&limit=6`)
        if (seq !== sugSeq.current) return
        const rows: Suggestion[] = (r?.results || []).map((h: any) => ({
          key: `oa-${h.oa_id || h.title}`,
          head: `${firstAuthor(h.authors || '')}, ${h.year ?? '年份未知'}`,
          title: h.title,
          sub: h.venue || '',
          source: 'OpenAlex' as const,
          oa_id: h.oa_id || undefined,
          year: h.year ?? null,
        }))
        setRemoteSug(rows)
      } catch {
        if (seq === sugSeq.current) setRemoteSug([])
      } finally {
        if (seq === sugSeq.current) setSugLoading(false)
      }
    }, 650)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  // 点空白处收起建议
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (sugBoxRef.current && !sugBoxRef.current.contains(e.target as Node)) setSugOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // ---- 发现流程 ----
  const [phase, setPhase] = useState<Phase>('idle')
  const [stage, setStage] = useState<DiscoverStage | null>(null)
  const [seed, setSeed] = useState<DiscoverPaper | null>(null)
  const [result, setResult] = useState<DiscoverResult | null>(null)
  const [error, setError] = useState<
    { message: string; code?: string; hint?: string; reset_in?: number } | null
  >(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastParams = useRef<StartParams>({})

  // ---- 结果态 ----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [listQ, setListQ] = useState('')
  const [relationFilter, setRelationFilter] = useState<'all' | 'reference' | 'citing'>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [imported, setImported] = useState<Set<string>>(new Set())
  const [busyImport, setBusyImport] = useState('')
  const [explainOpen, setExplainOpen] = useState(false)

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase('idle')
    setStage(null)
    setResult(null)
    setError(null)
    setSelectedId(null)
    setListQ('')
    setRelationFilter('all')
    setPage(1)
    setSugOpen(false)
  }, [])

  const start = useCallback(async (params: StartParams) => {
    if (!params.q?.trim() && !params.oa_id) return
    lastParams.current = params
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase('searching')
    setStage(null)
    setSeed(null)
    setResult(null)
    setError(null)
    setSelectedId(null)
    setPage(1)
    setListQ('')
    setRelationFilter('all')
    setSugOpen(false)
    try {
      const r = await streamDiscover(
        { ...params, limit: 20 },
        (ev: DiscoverEvent) => {
          if (ev.type === 'stage') {
            setStage(ev)
            if (ev.seed) setSeed(ev.seed)
          }
        },
        ctrl.signal,
      )
      if (ctrl.signal.aborted) return
      setResult(r)
      setSeed(r.seed)
      setStage(null)
      setPhase('results')
    } catch (e: any) {
      if (ctrl.signal.aborted) return
      const err = e as DiscoverError
      setError({
        message: err?.message || '检索失败',
        code: err?.code,
        hint: err?.hint,
        reset_in: err?.reset_in,
      })
    }
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  const pick = (s: Suggestion) => {
    setQ(s.title)
    setSugOpen(false)
    start({ oa_id: s.oa_id, q: s.title })
  }

  const refine = (p: DiscoverPaper) => {
    setQ(p.title)
    start({ oa_id: p.oa_id, q: p.title })
  }

  const importPaper = async (p: DiscoverPaper) => {
    if (imported.has(p.oa_id) || libTitleSet.has(normTitle(p.title))) {
      setImported((prev) => new Set(prev).add(p.oa_id))
      toast('这篇已在文献库里', 'ok')
      return
    }
    setBusyImport(p.oa_id)
    try {
      // 快照里与「已在馆藏」文献的真实引用边，随入库一并落库（另端不在馆藏的边等它入库时再落）
      const cites = (result?.edges || [])
        .filter((e) => e.source === p.oa_id && libOa.has(e.target))
        .map((e) => e.target)
      const citedBy = (result?.edges || [])
        .filter((e) => e.target === p.oa_id && libOa.has(e.source))
        .map((e) => e.source)
      await post(
        '/literature',
        {
          title: p.title,
          authors: p.authors || '',
          year: p.year ?? null,
          venue: p.venue || '',
          url: p.url || p.pdf_url || '',
          doi: p.doi || null,
          openalex_id: p.oa_id,
          cites,
          cited_by: citedBy,
          status: 'todo',
        },
        { ok: '已加入文献库' },
      )
      setImported((prev) => new Set(prev).add(p.oa_id))
      await loadLib()
      onImported?.()
    } finally {
      setBusyImport('')
    }
  }

  // 结果到达后，把「已在本地馆藏」的条目标成已入库
  useEffect(() => {
    if (!result) return
    setImported((prev) => {
      const next = new Set(prev)
      for (const p of result.papers) if (libTitleSet.has(normTitle(p.title))) next.add(p.oa_id)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, libRows])

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(suggestions.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Escape') {
      setSugOpen(false)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions[activeIdx] && sugOpen) pick(suggestions[activeIdx])
      else start({ q })
    }
  }

  // ---- 结果列表 ----
  const filtered = useMemo(() => {
    if (!result) return []
    const needle = listQ.trim().toLowerCase()
    return result.papers
      .filter((p) => p.oa_id !== result.seed.oa_id)
      .filter((p) => relationFilter === 'all' || p.relation === relationFilter)
      .filter((p) =>
        !needle
          ? true
          : [p.title, p.authors, p.venue, p.year].filter(Boolean).join(' ').toLowerCase().includes(needle),
      )
      .sort((a, b) => (b.citations || 0) - (a.citations || 0))
  }, [result, listQ, relationFilter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)))
  const cur = Math.min(Math.max(1, page), pageCount)
  const paged = useMemo(
    () => filtered.slice((cur - 1) * pageSize, cur * pageSize),
    [filtered, cur, pageSize],
  )

  const stageIdx = stage ? STAGE_STEPS.findIndex((s) => s.key === stage.stage) : 0

  // ---------------------------------------------------------------- 三段视图

  if (phase === 'idle') {
    // 首屏不是独立卡片：与下方分段共用一整片白底，块与块之间只有细线、没有留白
    return (
      <div className="flex flex-col">
        {error && (
          <div className="border-b border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-6 py-2 text-[12px] leading-relaxed text-[color:var(--wb-danger)]">
            {error.message}
            {error.hint && (
              <span className={`ml-1 text-${LM_TEXT}`}>{error.hint}</span>
            )}
          </div>
        )}
        <div className="relative overflow-hidden bg-white">
          <div className={`pointer-events-none absolute inset-x-0 top-[168px] h-[190px] bg-${LM_BLUE_SOFT}/55`}>
            <HeroDoodle />
          </div>
          <div className="relative flex min-h-[430px] flex-col items-center justify-center px-6 py-12">
            <div className={`text-[10.5px] font-semibold uppercase tracking-[0.22em] text-${LM_FAINT}`}>
              Literature Discovery
            </div>
            <h1
              className={`mt-3 text-center text-[32px] font-semibold leading-[1.22] text-${LM_TITLE} md:text-[40px]`}
              style={{ fontFamily: 'Georgia, "Times New Roman", "Songti SC", serif' }}
            >
              发现科学文献的世界
            </h1>
            <p className={`mt-2 max-w-[520px] text-center text-[12.5px] leading-relaxed text-${LM_TEXT}`}>
              输入一篇论文、一个 DOI 或一个关键词，顺着真实引用关系长出一张引文网络
            </p>

            <div ref={sugBoxRef} className="relative mt-8 w-full max-w-[620px]">
              <div className={`flex items-center gap-3 rounded-[14px] border-2 border-${LM_TITLE} bg-white px-4 py-3 shadow-[var(--wb-shadow-md)]`}>
                <Icon name="search" size={18} className={`shrink-0 text-${LM_FAINT}`} />
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value)
                    setActiveIdx(0)
                    setSugOpen(true)
                  }}
                  onFocus={() => setSugOpen(true)}
                  onKeyDown={onKey}
                  placeholder="搜索论文标题、作者或 DOI…"
                  className={`w-full bg-transparent text-[15px] outline-none placeholder:text-${LM_FAINT}`}
                />
                <span className={`hidden shrink-0 rounded-[5px] border border-${LM_BORDER_STRONG} px-1.5 py-[1px] text-[10px] text-${LM_FAINT} sm:block`}>
                  Enter
                </span>
              </div>

              {sugOpen && (suggestions.length > 0 || sugLoading) && (
                <div className={`absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-[10px] border border-${LM_BORDER_STRONG} bg-white shadow-[var(--wb-shadow-lg)]`}>
                  <div className="max-h-[232px] overflow-y-auto overscroll-contain">
                  {suggestions.map((s, i) => (
                    <button
                      key={s.key}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(s)}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={`flex w-full flex-col items-start gap-0.5 border-b border-${LM_BORDER} px-3 py-2 text-left transition last:border-0 ${
                        i === activeIdx ? `bg-${LM_BLUE_SOFT}` : `hover:bg-${LM_CHIP_BG}`
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className={`text-[12px] font-medium text-${LM_TITLE}`}>{s.head}</span>
                        <span className={`shrink-0 rounded-full border border-${LM_BORDER} px-1.5 py-[1px] text-[9.5px] text-${LM_FAINT}`}>
                          {s.source}
                        </span>
                      </div>
                      <span className={`line-clamp-1 w-full text-[11.5px] text-${LM_TEXT}`}>
                        {s.title}
                      </span>
                    </button>
                  ))}
                  {sugLoading && (
                    <div className={`flex items-center gap-2 px-3 py-2 text-[11px] text-${LM_FAINT}`}>
                      <Spinner /> 正在检索 OpenAlex…
                    </div>
                  )}
                </div>
                <div className={`flex items-center justify-between gap-2 border-t border-${LM_BORDER} bg-${LM_CHIP_BG} px-3 py-1.5 text-[10px] text-${LM_FAINT}`}>
                  <span>方向键选择 · Enter 检索 · Esc 收起</span>
                  <span className="shrink-0">{suggestions.length} 条建议</span>
                </div>
              </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
              <span className={`text-[11px] text-${LM_FAINT}`}>试试：</span>
              {QUICK_TERMS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setQ(t)
                    start({ q: t })
                  }}
                  className={`rounded-full border border-${LM_BORDER} bg-white px-2.5 py-[3px] text-[11px] text-${LM_TEXT} transition hover:border-${LM_BLUE} hover:bg-${LM_BLUE_SOFT} hover:text-${LM_BLUE}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className={`grid grid-cols-2 gap-px border-t border-${LM_BORDER} bg-${LM_BORDER} sm:grid-cols-4`}>
            {[
              { icon: 'search' as const, title: '发现', desc: '从一篇种子论文找到相关研究' },
              { icon: 'network' as const, title: '可视化', desc: '引用关系铺成一张引文网络' },
              { icon: 'bookOpen' as const, title: '精读', desc: '一键入库，接上笔记与对比矩阵' },
              { icon: 'radar' as const, title: '追踪', desc: '顺着施引文献看后续进展' },
            ].map((f) => (
              <div key={f.title} className="flex items-start gap-2.5 bg-white px-4 py-3">
                <span className={`mt-[2px] flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-${LM_BLUE_SOFT} text-${LM_BLUE}`}>
                  <Icon name={f.icon} size={14} />
                </span>
                <div className="min-w-0">
                  <div className={`text-[12.5px] font-semibold text-${LM_TITLE}`}>{f.title}</div>
                  <div className={`text-[10.5px] leading-snug text-${LM_FAINT}`}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className={`border-t border-${LM_BORDER} bg-white px-6 py-2.5 text-center text-[11px] text-${LM_FAINT}`}>
          数据来源 OpenAlex · 结果实时检索、默认不落库 · 点「入库」后与文献库共用同一条链路
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------- 检索过程 / 结果共用顶栏

  const head = (
    <div className="flex flex-wrap items-center gap-2">
      <Btn onClick={reset} title="回到搜索首页">
        <Icon name="chevronLeft" size={13} />
        换个种子
      </Btn>
      <div className={`min-w-0 flex-1 truncate text-[12.5px] font-medium text-${LM_TITLE}`}>
        {seed?.title || q}
      </div>
      {phase === 'results' && <Pill tone="gray">OpenAlex 实时检索</Pill>}
    </div>
  )

  if (phase === 'searching') {
    return (
      <div className="flex flex-col gap-3">
        {head}
        <div className="flex flex-col gap-3 lg:flex-row" style={{ minHeight: 460 }}>
          <div className="flex w-full shrink-0 flex-col gap-3 lg:w-[330px]">
            <div className={`rounded-[12px] border border-${LM_BORDER} bg-white p-4`}>
              <div className={`text-[13px] font-semibold text-${LM_TITLE}`}>检索进度</div>
              <div className={`mt-0.5 text-[11px] text-${LM_FAINT}`}>
                按 OpenAlex 真实请求阶段扩展引文网络
              </div>

              {error ? (
                <div className="mt-5 flex flex-col items-start gap-2.5 rounded-[10px] bg-[color:var(--wb-danger-soft)] p-3">
                  <div className="flex items-start gap-1.5">
                    <Icon
                      name="alert"
                      size={13}
                      className="mt-[1px] shrink-0 text-[color:var(--wb-danger)]"
                    />
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium leading-relaxed text-[color:var(--wb-danger)]">
                        {error.message}
                      </div>
                      {error.hint && (
                        <div className={`mt-1 text-[11px] leading-relaxed text-${LM_TEXT}`}>
                          {error.hint}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {error.code === 'rate_limited' ? (
                      <>
                        <Btn size="sm" variant="primary" onClick={() => navigate('/settings')}>
                          去设置填 key
                        </Btn>
                        <Btn
                          size="sm"
                          onClick={() => window.open('https://openalex.org/settings/api', '_blank')}
                        >
                          免费申请 key
                        </Btn>
                        <Btn size="sm" onClick={reset}>
                          换个关键词
                        </Btn>
                      </>
                    ) : (
                      <>
                        <Btn size="sm" variant="primary" onClick={() => start(lastParams.current)}>
                          重试
                        </Btn>
                        <Btn size="sm" onClick={reset}>
                          换个关键词
                        </Btn>
                      </>
                    )}
                  </div>
                  {error.code === 'rate_limited' && (
                    <div className={`text-[10.5px] leading-relaxed text-${LM_FAINT}`}>
                      免费额度按出口 IP 共享，同网络下所有人一起花；反复点「重试」不会变快，等重置或填自己的 key 才有用。
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex flex-col items-center gap-3 py-7">
                    <Icon name="clock" size={40} strokeWidth={1.8} className={`text-${LM_BLUE}`} />
                    <div className={`text-center text-[12.5px] font-medium text-${LM_TEXT}`}>
                      {stage?.label || '正在准备检索…'}
                    </div>
                    <div className={`text-center text-[11px] text-${LM_FAINT}`}>
                      {stage?.detail || '连接 OpenAlex'}
                    </div>
                  </div>
                  <Progress value={stage?.progress ?? 0} showLabel />
                  <div className="mt-4 flex flex-col gap-1.5">
                    {STAGE_STEPS.map((s, i) => {
                      const done = i < stageIdx
                      const active = i === stageIdx
                      return (
                        <div key={s.key} className="flex items-center gap-2 text-[11.5px]">
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${
                              done
                                ? 'bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]'
                                : active
                                  ? `bg-${LM_BLUE_SOFT} text-${LM_BLUE}`
                                  : `bg-${LM_CHIP_BG} text-${LM_FAINT}`
                            }`}
                          >
                            {done ? <Icon name="check" size={10} strokeWidth={2.4} /> : i + 1}
                          </span>
                          <span className={active ? `text-${LM_TITLE}` : `text-${LM_FAINT}`}>
                            {s.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            {seed && (
              <div className={`rounded-[12px] border border-${LM_BORDER} bg-white p-3`}>
                <div className={`text-[10px] font-semibold uppercase tracking-[0.16em] text-${LM_FAINT}`}>
                  种子文献
                </div>
                <div className={`mt-1.5 text-[12.5px] font-medium leading-snug text-${LM_TITLE}`}>
                  {seed.title}
                </div>
                <div className={`mt-1 text-[11px] text-${LM_TEXT}`}>{seed.authors}</div>
                <div className={`mt-1.5 flex flex-wrap gap-x-3 text-[10.5px] text-${LM_FAINT}`}>
                  {seed.year && <span>{seed.year}</span>}
                  {seed.venue && <span className="max-w-[240px] truncate">{seed.venue}</span>}
                  <span>参考文献 {seed.references}</span>
                  <span>被引 {seed.citations}</span>
                </div>
              </div>
            )}
          </div>

          <DiscoverMap
            papers={seed ? [seed] : []}
            edges={[]}
            seedId={seed?.oa_id || ''}
            selectedId={null}
            onSelect={() => {}}
            onRefine={() => {}}
            onImport={() => {}}
            imported={imported}
            pending
          />
        </div>
        <p className={`text-center text-[11px] text-${LM_FAINT}`}>
          进度来自后端真实阶段（OpenAlex 请求逐段完成），不是定时器模拟
        </p>
      </div>
    )
  }

  // ---------------------------------------------------------------- 检索结果

  const stats = result?.stats || { references: 0, citing: 0, edges: 0 }

  return (
    <div className="flex flex-col gap-3">
      {head}
      <div className="flex flex-col gap-3 lg:flex-row" style={{ height: 'max(540px, calc(100vh - 218px))' }}>
        {/* 左栏：关联文献列表 */}
        <div className={`flex w-full shrink-0 flex-col overflow-hidden rounded-[12px] border border-${LM_BORDER} bg-white lg:w-[350px]`}>
          <div className={`shrink-0 border-b border-${LM_BORDER} p-3`}>
            <div className="flex items-center justify-between gap-2">
              <div className={`text-[13px] font-semibold text-${LM_TITLE}`}>探索关联文献</div>
              <button
                type="button"
                onClick={() => setExplainOpen(true)}
                className={`text-[11px] text-${LM_BLUE} underline underline-offset-2`}
              >
                结果如何计算？
              </button>
            </div>
            <div className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-${LM_FAINT}`}>
              <span>种子 {seed ? shortLabel(seed) : '—'}</span>
              <span>· 参考文献 {stats.references}</span>
              <span>· 施引 {stats.citing}</span>
              <span>· 连线 {stats.edges}</span>
            </div>
            <div className="mt-2">
              <SearchInput
                value={listQ}
                onChange={(v) => {
                  setListQ(v)
                  setPage(1)
                }}
                placeholder="按标题 / 作者 / 期刊筛选…"
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <Segmented
                value={relationFilter}
                onChange={(v) => {
                  setRelationFilter(v)
                  setPage(1)
                }}
                options={RELATION_OPTIONS}
              />
              <span className={`shrink-0 text-[10px] text-${LM_FAINT}`}>按被引排序</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-white p-2">
            {paged.length === 0 ? (
              <Empty text="没有匹配的相关文献" hint="换个筛选词，或切回「全部」" />
            ) : (
              paged.map((p) => (
                <div
                  key={p.oa_id}
                  onClick={() => setSelectedId(p.oa_id)}
                  className={`mb-2 cursor-pointer rounded-[10px] border px-3 py-2.5 transition ${
                    selectedId === p.oa_id
                      ? `border-${LM_BLUE} bg-${LM_BLUE_SOFT}/50`
                      : `border-${LM_BORDER} bg-white hover:border-${LM_BORDER_STRONG} hover:shadow-[var(--wb-shadow-sm)]`
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className={`text-[12px] font-semibold text-${LM_TITLE}`}>
                      {shortLabel(p)}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-[1px] text-[9.5px] ${
                        p.relation === 'reference'
                          ? 'bg-[color:var(--wb-info-soft)] text-[color:var(--wb-info)]'
                          : 'bg-[color:var(--wb-warn-soft)] text-[color:var(--wb-warn)]'
                      }`}
                    >
                      {p.relation === 'reference' ? '参考文献' : '施引文献'}
                    </span>
                  </div>
                  <div className={`mt-1 text-[12.5px] leading-snug text-${LM_TITLE}`}>
                    {p.title}
                  </div>
                  {p.venue && (
                    <div className={`mt-1 truncate text-[11px] text-${LM_BLUE}`}>{p.venue}</div>
                  )}
                  <div className={`mt-2 flex gap-4 text-[10px] uppercase tracking-[0.08em] text-${LM_FAINT}`}>
                    <span>
                      <b className={`mr-1 text-[12px] normal-case tracking-normal text-${LM_TEXT}`}>
                        {p.references}
                      </b>
                      参考文献
                    </span>
                    <span>
                      <b className={`mr-1 text-[12px] normal-case tracking-normal text-${LM_TEXT}`}>
                        {p.citations}
                      </b>
                      被引
                    </span>
                  </div>
                  <div
                    className={`mt-2 flex flex-wrap items-center gap-1.5 border-t border-${LM_BORDER} pt-2`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className={`text-[11px] text-${LM_FAINT}`}>细化检索：</span>
                    <Btn size="xs" variant="primary" onClick={() => refine(p)}>
                      更多类似
                    </Btn>
                    <Btn
                      size="xs"
                      onClick={() => importPaper(p)}
                      loading={busyImport === p.oa_id}
                      disabled={imported.has(p.oa_id)}
                    >
                      {imported.has(p.oa_id) ? '已在库' : '入库'}
                    </Btn>
                    {p.oa && p.pdf_url && (
                      <a
                        href={p.pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className={`text-[11px] text-${LM_BLUE} underline underline-offset-2`}
                      >
                        PDF
                      </a>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className={`shrink-0 border-t border-${LM_BORDER} p-2`}>
            <Pagination
              total={filtered.length}
              page={cur}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(n) => {
                setPageSize(n)
                setPage(1)
              }}
              unit="篇"
              sizes={[10, 20, 50]}
            />
          </div>
        </div>

        {/* 右栏：年份 × 被引的引文网络 */}
        {result && (
          <DiscoverMap
            papers={result.papers}
            edges={result.edges}
            seedId={result.seed.oa_id}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRefine={refine}
            onImport={importPaper}
            imported={imported}
            busyImport={busyImport}
          />
        )}
      </div>

      {/* 口径说明：真实 / 模拟边界写清楚 */}
      <Modal open={explainOpen} onClose={() => setExplainOpen(false)} title="这些结果是怎么来的？" width="max-w-2xl">
        <div className={`flex flex-col gap-2.5 text-[12px] leading-relaxed text-${LM_TEXT}`}>
          <p>
            全部数据来自 <b>OpenAlex 实时响应</b>，本页不生成任何模拟数据；检索结果默认不落库，点「入库 / 加入文献库」才写入本地文献库。
          </p>
          <ul className="ml-4 flex list-disc flex-col gap-1.5">
            <li>
              <b>种子</b>：你选中的论文（用 OpenAlex ID 精确取回），或搜索框里那串关键词的全文检索第一名。
            </li>
            <li>
              <b>参考文献</b>：种子 work 的 <code>referenced_works</code> 前 20 篇。
            </li>
            <li>
              <b>施引文献</b>：<code>filter=cites:&lt;种子ID&gt;</code>，按 <code>cited_by_count</code> 降序取前 20 篇。
            </li>
            <li>
              <b>连线</b>：只连「同时出现在本次结果集里」的真实引用关系（A → B 表示 A 引用了 B），不按文本相似度猜边。
            </li>
            <li>
              <b>坐标</b>：横轴发表年份（越右越晚），纵轴被引次数（<code>log1p</code> 缩放）；两者都按<b>本次结果集内的相对位置</b>铺满画布（年份取 5–95 分位、被引取 min–max），避免个别早年 / 超高被引论文把点压成一团——单调性不变，但刻度不是绝对等距。圆点大小 = 被引次数，实心深色圆 = 种子；同年份 / 相近被引的点会做确定性去重叠散开，只轻微移位。
            </li>
          </ul>
          <p className={`rounded-[8px] bg-${LM_CHIP_BG} px-3 py-2 text-[11.5px]`}>
            卡片里的「参考文献 / 被引」是 OpenAlex 的 <code>referenced_works_count</code> / <code>cited_by_count</code>，是全库计数；图上的连线只是这次结果集内部的引用关系，两者口径不同，不要等同看待。
          </p>
        </div>
      </Modal>
    </div>
  )
}
