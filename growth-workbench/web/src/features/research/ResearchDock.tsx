import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Btn, IconBtn, Segmented, Select } from '../../components/ui'
import type { PaperHit, StageEv } from '../../lib/rchatStream'

/**
 * 研究对话的「进度框」与「文献检索双栏」。
 *
 * 分工（按用户最新要求）：
 * - 进度框留在**对话栏内**（用户明确要「在对话栏中有一个进度框」），数据是后端 SSE 真实阶段；
 * - 文献检索结果**点开后在右侧开双栏**，版式与报告文档栏 ReportPane 完全一致，
 *   不再挤在对话栏底部当常驻卡；对话栏里只留一条「检出 N 篇 · 点开双栏查看」的入口卡。
 *
 * 对标 Undermind：Key | Match | Year | Cit/Yr | PDF | Title 的列头，
 * 加上用户点名的「影响因子 / 匹配程度 / 语言 / 引用」排序与筛选维度。
 *
 * 数据口径（重要，别虚构）：
 * - 引用数 / 年份 / 语言 / OA PDF 全部来自 OpenAlex 原样字段；
 * - 匹配度 = 英文检索式词与标题+摘要词表的词面重合率（本地算，不是模型打分）；
 * - 期刊影响因子 JIF 不在 OpenAlex 字段里，**不提供数值**，排序里的「影响因子*」
 *   用可核验的年均被引 = 被引数 / (今年 - 发表年 + 1) 代替，并在卡内明写。
 */

export type RunState = {
  sid: number
  mode: 'auto' | 'deep' | 'report'
  active: boolean
  stages: StageEv[]
  pct: number
  startedAt: number
  error?: string
  papers: PaperHit[]
  total: number
  queryCount: number
  rawHits: number
}

// ---- 按 sid 分桶的模块级状态：切会话/切路由都不丢，回来按 sid 取回 ----
const store = new Map<number, RunState>()
const listeners = new Set<() => void>()
const emitAll = () => listeners.forEach((f) => f())

function blank(sid: number, mode: RunState['mode'] = 'auto'): RunState {
  return {
    sid, mode, active: true, stages: [], pct: 0, startedAt: Date.now(),
    papers: [], total: 0, queryCount: 0, rawHits: 0,
  }
}

export function beginRun(sid: number, mode: RunState['mode']) {
  const prev = store.get(sid)
  const cur = blank(sid, mode)
  // 新一轮仍先保留上一轮的文献结果（双栏里不闪空），等这次的 papers 事件到了再整体替换
  if (prev) {
    cur.papers = prev.papers
    cur.total = prev.total
    cur.queryCount = prev.queryCount
    cur.rawHits = prev.rawHits
  }
  store.set(sid, cur)
  emitAll()
}

export function pushStage(sid: number, s: StageEv) {
  const cur = store.get(sid)
  if (!cur) return
  // 同一 key 的阶段会推两次（开始 / 完成）：覆盖而不是堆叠
  const stages = cur.stages.some((x) => x.key === s.key)
    ? cur.stages.map((x) => (x.key === s.key ? s : x))
    : [...cur.stages, s]
  store.set(sid, { ...cur, stages, pct: Math.max(cur.pct, s.pct || 0) })
  emitAll()
}

export function setPapers(sid: number, papers: PaperHit[], total: number, queryCount: number, rawHits: number) {
  const cur = store.get(sid)
  if (!cur) return
  store.set(sid, { ...cur, papers, total, queryCount, rawHits })
  emitAll()
}

export function finishRun(sid: number, error?: string) {
  const cur = store.get(sid)
  if (!cur) return
  store.set(sid, { ...cur, active: false, pct: error ? cur.pct : 100, error })
  emitAll()
}

/** 打开历史会话时，用该会话最近一次 deep 消息的 citations 回填文献栏（缺的派生字段留空，不编造） */
export function hydratePapers(sid: number, cits: any[]) {
  const cur = store.get(sid)
  if (cur?.papers.length) return
  const papers: PaperHit[] = (cits || []).map((c) => ({
    n: Number(c.n),
    lit_id: c.lit_id,
    title: c.title,
    authors: c.authors,
    year: c.year,
    venue: c.venue,
    doi: c.doi,
    url: c.url,
    cited_by_count: Number(c.cited_by_count ?? c.cited_by ?? 0),
  }))
  if (!papers.length) return
  store.set(sid, { ...(cur || { ...blank(sid), active: false }), papers, total: papers.length })
  emitAll()
}

export function clearRun(sid: number) {
  store.delete(sid)
  emitAll()
}

export function useResearchRun(sid: number | null): RunState | null {
  const [, tick] = useState(0)
  useEffect(() => {
    const f = () => tick((x) => x + 1)
    listeners.add(f)
    return () => {
      listeners.delete(f)
    }
  }, [])
  return sid == null ? null : store.get(sid) ?? null
}

// ---- 排序 / 筛选 ----
type SortKey = 'match' | 'impact' | 'cited' | 'year'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'match', label: '匹配度' },
  { value: 'impact', label: '影响因子*' },
  { value: 'cited', label: '引用' },
  { value: 'year', label: '年份' },
]

const LANG_OPTIONS = [
  { value: 'all', label: '全部语言' },
  { value: 'EN', label: 'EN' },
  { value: 'ZH', label: 'ZH' },
  { value: 'other', label: '其他' },
]

function sortValue(p: PaperHit, k: SortKey): number {
  if (k === 'match') return p.match ?? 0
  if (k === 'impact') return p.cit_per_year ?? 0
  if (k === 'cited') return p.cited_by_count ?? 0
  return p.year ?? 0
}

const COLS = '28px 44px 40px 52px 40px 40px 36px minmax(0,1fr)'

/** 对话栏内的进度框：后端 SSE 真实阶段，不是前端定时器假动画 */
function ProgressCard({ run }: { run: RunState }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!run.active) return
    const t = setInterval(() => tick((x) => x + 1), 500)
    return () => clearInterval(t)
  }, [run.active])
  const sec = Math.max(1, Math.round((Date.now() - run.startedAt) / 1000))
  const last = run.stages[run.stages.length - 1]
  const label = run.mode === 'deep' ? '深度检索进行中' : run.mode === 'report' ? '报告撰写进行中' : '正在回复'
  return (
    <div className="mb-2 rounded-[14px] border border-[color:var(--wb-accent)]/30 bg-[color:var(--wb-accent-soft)] px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <Icon name="radar" size={13} className="shrink-0 text-[color:var(--wb-accent)]" />
        <span className="whitespace-nowrap text-[12px] font-semibold text-[color:var(--wb-text)]">{label}</span>
        <span className="whitespace-nowrap text-[10.5px] text-[color:var(--wb-muted)]">Worked for {sec}s</span>
        <span className="ml-auto whitespace-nowrap text-[11px] font-semibold text-[color:var(--wb-accent-strong)]">
          {run.pct}%
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--wb-border)]">
        <div
          className="h-full rounded-full bg-[color:var(--wb-accent)] transition-[width] duration-500"
          style={{ width: `${run.pct}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {run.stages.map((s, i) => {
          const done = i < run.stages.length - 1
          return (
            <span key={s.key} className="flex items-center gap-1 whitespace-nowrap text-[10.5px] text-[color:var(--wb-text-soft)]">
              <Icon name={done ? 'check' : 'clock'} size={10} className={done ? 'text-[color:var(--wb-ok)]' : 'text-[color:var(--wb-accent)]'} />
              {s.label}
            </span>
          )
        })}
      </div>
      {last?.detail && (
        <div className="mt-1.5 truncate text-[10.5px] text-[color:var(--wb-muted)]" title={last.detail}>
          {last.detail}
        </div>
      )}
      {(run.rawHits > 0 || run.total > 0) && (
        <div className="mt-1 text-[10.5px] text-[color:var(--wb-text-soft)]">
          原始命中 {run.rawHits} 条 · 去重入库 {run.total} 篇 · 检索式 {run.queryCount} 条
        </div>
      )}
      {run.error && <div className="mt-1 text-[10.5px] text-[color:var(--wb-danger)]">{run.error}</div>}
    </div>
  )
}

/** 对话栏里的入口卡：对标「报告已生成 · 点击查看」，点了开右侧双栏 */
function LiteratureEntry({ run, onOpen }: { run: RunState | null; onOpen: () => void }) {
  const all = run?.papers || []
  if (!all.length) return null
  const preview = all.slice(0, 3).map((p) => p.title).filter(Boolean).join(' · ')
  return (
    <button
      onClick={onOpen}
      className="group flex w-full flex-col gap-1.5 rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-3.5 text-left transition hover:border-[color:var(--wb-accent)]/50"
    >
      <span className="flex items-center gap-2 text-[12.5px] font-semibold text-[color:var(--wb-text)]">
        <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
          <Icon name="book" size={13} />
        </span>
        检出 {all.length} 篇文献 · 点开在双栏查看
      </span>
      <span className="line-clamp-2 pl-9 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
        {preview || 'Match / Year / Cit-Yr / 引用 / 语言 / PDF 明细'}…
      </span>
    </button>
  )
}

/** 对话栏内的 dock：只放进度框 + 双栏入口卡；文献明细已挪到右侧双栏 */
export default function ResearchDock({
  run,
  onOpenLiterature,
}: {
  run: RunState | null
  onOpenLiterature: () => void
}) {
  const hasError = !!run && !run.active && !!run.error
  const hasPapers = (run?.papers.length || 0) > 0
  if (!run?.active && !hasError && !hasPapers) return null
  return (
    <div className="mb-2">
      {run?.active && <ProgressCard run={run} />}
      {hasError && (
        <div className="mb-2 flex items-center gap-1.5 rounded-[10px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-3 py-1.5 text-[10.5px] text-[color:var(--wb-danger)]">
          <Icon name="alert" size={11} className="shrink-0" />
          上次调研未完成：{run?.error}
        </div>
      )}
      <LiteratureEntry run={run} onOpen={onOpenLiterature} />
    </div>
  )
}

/**
 * 文献检索双栏：与 ReportPane 同规格（宽 46%/560px、左分隔线、栏头 + 说明行 + 白底滚动正文），
 * 右上角叉收起这一栏、对话恢复单栏。排序/筛选/指标口径都在这一栏里。
 */
export function LiteraturePane({ run, onClose, width }: { run: RunState | null; onClose: () => void; width: number }) {
  const [sort, setSort] = useState<SortKey>('match')
  const [lang, setLang] = useState('all')
  const [showNote, setShowNote] = useState(false)

  const all = run?.papers || []
  const rows = all
    .filter((p) => {
      if (lang === 'all') return true
      const l = (p.language || '—').toUpperCase()
      if (lang === 'EN') return l === 'EN'
      if (lang === 'ZH') return l === 'ZH'
      return l !== 'EN' && l !== 'ZH'
    })
    .slice()
    .sort((a, b) => sortValue(b, sort) - sortValue(a, sort))

  const exportCsv = () => {
    const head = ['KEY', 'MATCH', 'YEAR', 'CIT/YR', 'CIT', 'LANG', 'TITLE', 'AUTHORS', 'VENUE', 'DOI', 'PDF']
    const body = rows.map((p) => [
      `[${p.n}]`, p.match ?? '', p.year ?? '', p.cit_per_year ?? '', p.cited_by_count ?? '',
      p.language ?? '', p.title ?? '', p.authors ?? '', p.venue ?? '', p.doi ?? '', p.pdf_url ?? '',
    ])
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const csv = '\uFEFF' + [head, ...body].map((r) => r.map(cell).join(',')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `文献检索-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <aside
      data-resizable
      className="flex shrink-0 flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)]"
      style={{ width, minWidth: 280, maxWidth: 'calc(100vw - 700px)' }}
    >
      {/* 栏头：文件标识 + 标题 + 命中数 + 导出 + 关闭叉（与报告栏一致） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3.5 py-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
          <Icon name="book" size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">
          文献检索
        </span>
        <span className="shrink-0 whitespace-nowrap rounded-[3px] bg-[color:var(--wb-accent-soft)] px-1.5 py-[1px] text-[10px] font-medium text-[color:var(--wb-accent-strong)]">
          {all.length} 篇
        </span>
        <Btn size="xs" variant="subtle" onClick={exportCsv} disabled={!all.length} title="导出 CSV">
          <Icon name="download" size={11} />
          导出
        </Btn>
        <IconBtn icon="close" size="sm" ariaLabel="关闭文献检索栏" title="关闭文献检索" onClick={onClose} />
      </div>
      <div className="shrink-0 px-4 pt-3 text-[11px] text-[color:var(--wb-muted)]">
        基于本次真实检索 · 命中已同步文献库
      </div>

      {/* 白底正文：常驻面板高度写死为 flex-1，滚动只在内部 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2.5">
        <div className="px-4 py-3">
          {/* 排序 / 语言筛选 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Segmented value={sort} onChange={setSort} options={SORT_OPTIONS} />
            <Select value={lang} onChange={setLang} options={LANG_OPTIONS} className="shrink-0" />
          </div>

          {/* 指标口径：真实 / 替代 / 不虚构，全部写清楚 */}
          <div className="mt-2.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-[color:var(--wb-muted)]">
            <Icon name="info" size={11} className="mt-[1px] shrink-0" />
            <span className="min-w-0 flex-1">
              真实数据 · 引用/年份/语言/PDF 取自 OpenAlex；JIF 非其字段，不虚构，
              <button onClick={() => setShowNote(!showNote)} className="mx-0.5 text-[color:var(--wb-accent)] hover:underline">
                {showNote ? '收起口径' : '指标口径'}
              </button>
              影响因子* 以年均被引替代。
            </span>
          </div>
          {showNote && (
            <div className="mt-1.5 rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] px-2.5 py-2 text-[10.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
              匹配度 = 英文检索式词与「标题 + 摘要词表」的词面重合率（本地计算，不是模型打分）；
              年均被引 = 被引数 / (今年 − 发表年 + 1)，作为可核验的影响力替代指标；
              期刊影响因子（JIF）不在 OpenAlex 字段中，故本栏不提供 JIF 数值；
              引用数、发表年、语言、OA PDF 均为 OpenAlex 原样字段。
            </div>
          )}

          {/* 列头：对标 Undermind 的 KEY / MATCH / YEAR / CIT/YR / PDF / TITLE */}
          <div
            className="mt-3 grid gap-x-1.5 border-b border-[color:var(--wb-border)] pb-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--wb-muted)]"
            style={{ gridTemplateColumns: COLS }}
          >
            <span>KEY</span><span>MATCH</span><span>YEAR</span><span>CIT/YR</span>
            <span>CIT</span><span>LANG</span><span>PDF</span><span>TITLE</span>
          </div>

          {rows.length === 0 ? (
            <div className="py-6 text-center text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
              {all.length === 0
                ? '还没有检索结果。点「深度检索」并确认提案，命中会显示在这一栏。'
                : '当前语言筛选下没有文献。'}
            </div>
          ) : (
            rows.map((p) => {
              const href = p.doi ? `https://doi.org/${p.doi}` : p.url || ''
              const pdf = p.pdf_url || ''
              return (
                <div
                  key={`${p.n}-${p.openalex_id || p.lit_id || ''}`}
                  className="grid items-center gap-x-1.5 border-b border-[color:var(--wb-border)]/60 py-[6px] text-[10.5px] last:border-0"
                  style={{ gridTemplateColumns: COLS }}
                >
                  <span className="truncate font-semibold text-[color:var(--wb-accent-strong)]">[{p.n}]</span>
                  <span className={p.match != null && p.match >= 50 ? 'font-medium text-[color:var(--wb-accent)]' : 'text-[color:var(--wb-text-soft)]'}>
                    {p.match == null ? '—' : `${p.match}%`}
                  </span>
                  <span className="text-[color:var(--wb-text-soft)]">{p.year ?? '—'}</span>
                  <span className="text-[color:var(--wb-text-soft)]">{p.cit_per_year ?? '—'}</span>
                  <span className="text-[color:var(--wb-text-soft)]">{p.cited_by_count ?? '—'}</span>
                  <span className="truncate text-[color:var(--wb-muted)]" title={p.language || ''}>{p.language || '—'}</span>
                  <span>
                    {pdf ? (
                      <a href={pdf} target="_blank" rel="noreferrer" title="开放获取 PDF" className="text-[color:var(--wb-accent)] hover:underline">
                        <Icon name="file" size={12} />
                      </a>
                    ) : (
                      <span className="text-[color:var(--wb-muted)]">—</span>
                    )}
                  </span>
                  <span className="min-w-0 truncate" title={`${p.title || ''}${p.venue ? ` · ${p.venue}` : ''}`}>
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" className="text-[color:var(--wb-text)] hover:text-[color:var(--wb-accent)] hover:underline">
                        {p.title || '（无标题）'}
                      </a>
                    ) : (
                      <span className="text-[color:var(--wb-text)]">{p.title || '（无标题）'}</span>
                    )}
                  </span>
                </div>
              )
            })
          )}

          {all.length > 0 && (
            <div className="mt-2 flex items-center gap-2 border-t border-[color:var(--wb-border)] pt-2 text-[10px] text-[color:var(--wb-muted)]">
              <span>已同步文献库 · 排序：{SORT_OPTIONS.find((o) => o.value === sort)?.label}</span>
              {run && run.rawHits > 0 && <span>· 原始命中 {run.rawHits} 条</span>}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
