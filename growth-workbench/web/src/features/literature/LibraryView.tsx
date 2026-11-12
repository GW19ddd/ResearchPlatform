/**
 * 文献库主视图：页内全高左导航 + 右侧紧凑行列表。
 *
 * 布局参照 ResearchRabbit 的 Library：左栏是页面级持久导航（智能视图 + Zotero 分类树 +
 * 底部导出/同步出口），右主区是标题条 → 批量/筛选工具条 → 无边框行列表 → 分页。
 * 与旧版「Card 里嵌一张卡片一文献」的区别：行不自带边框和整排按钮，操作收进 hover 图标，
 * 点击行主体直接打开居中 PDF 大窗（PdfModal），完整编辑仍走 LiteratureDrawer，
 * 引用关系走顶部的「关联图」按钮。
 *
 * 视觉只用 --wb-* 令牌（纸感靛蓝），容器不带 transform/filter/clip-path —— fixed 弹层的硬约束。
 * 数据全部来自父级 items，筛选/分页/多选状态自己管，父级只负责刷新与打开浮层。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { AiError } from '../../components/AiError'
import {
  Btn,
  Empty,
  IconBtn,
  Pagination,
  SearchInput,
  Select,
} from '../../components/ui'
import {
  BulkBar,
  ExportCol,
  RowCheck,
  SelectToggle,
  downloadText,
  stamp,
  toBibtex,
  toCsv,
  toMarkdown,
  useBulk,
} from '../../components/BulkBar'
import { toast } from '../../components/toast'
import { Icon, type IconName } from '../../components/Icon'
import { del, post } from '../../lib/api'
import { useAiTask } from '../../lib/hooks'
import { usePersist } from '../../lib/state'
import { STATUS, abstractOf, collsOf, inCollection, tagsOf } from './literature-shared'
import { LM_BLUE, LM_BLUE_SOFT, LM_BORDER, LM_BORDER_STRONG, LM_CHIP_BG, LM_FAINT, LM_TEXT, LM_TITLE } from './litColors'

const STATUS_DOT: Record<string, string> = {
  todo: `bg-${LM_FAINT}`,
  reading: 'bg-[color:var(--wb-warn)]',
  done: 'bg-[color:var(--wb-ok)]',
}

const LIT_COLS: ExportCol[] = [
  { key: 'title', label: '标题' },
  { key: 'authors', label: '作者' },
  { key: 'year', label: '年份' },
  { key: 'venue', label: '会议/期刊' },
  { key: 'status', label: '状态' },
  { key: 'rating', label: '评分' },
  { key: 'tags', label: '标签' },
  { key: 'url', label: '链接' },
  { key: 'notes', label: '笔记' },
]

type View = 'all' | 'recent' | 'todo' | 'reading' | 'done'
const SMART: { value: View; label: string; icon: IconName }[] = [
  { value: 'all', label: '全部文献', icon: 'library' },
  { value: 'recent', label: '最近添加', icon: 'clock' },
  { value: 'todo', label: '待读', icon: 'inbox' },
  { value: 'reading', label: '在读', icon: 'bookOpen' },
  { value: 'done', label: '已读', icon: 'clipboardCheck' },
]

const SORT_OPTIONS = [
  { value: 'new', label: '最新添加' },
  { value: 'title', label: '标题 A–Z' },
  { value: 'year', label: '年份（新→旧）' },
  { value: 'rating', label: '评分（高→低）' },
]

/** 摘要在列表里只给两行，超出用 CSS 截断（不依赖 tailwind line-clamp 插件版本）。 */
const CLAMP2: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

function firstAuthor(l: any): string {
  const raw = String(l?.authors || '').trim()
  if (!raw) return '作者未填'
  const head = raw.split(/[,，;；]/)[0].trim()
  return head || raw
}

export default function LibraryView({
  items,
  tree,
  onOpenDetail,
  onOpenPdf,
  onOpenGraph,
  onMutated,
  onStatusChange,
  onAdd,
}: {
  items: any[]
  tree: any[]
  onOpenDetail: (id: number) => void
  onOpenPdf: (item: any) => void
  onOpenGraph: (id: number | null) => void
  onMutated: () => void | Promise<void>
  onStatusChange: (id: number, status: string) => void | Promise<void>
  onAdd: () => void
}) {
  const nav = useNavigate()
  const [view, setView] = usePersist<View>('lit.view', 'all')
  const [coll, setColl] = usePersist('lit.coll', '')
  const [q, setQ] = usePersist('lit.q', '')
  const [sortBy, setSortBy] = usePersist('lit.sort', 'new')
  const [page, setPage] = usePersist('lit.page', 1)
  const [pageSize, setPageSize] = usePersist('lit.pageSize', 20)
  const [groupBy, setGroupBy] = usePersist('lit.groupby', false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [multi, setMulti] = useState(false)
  const [bulkDel, setBulkDel] = useState(false)
  const bulk = useBulk()
  const dgTask = useAiTask<any>()
  const lastDigest = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setExpanded((prev: Set<string>) =>
      prev.size > 0 ? prev : new Set(tree.map((n: any) => n.path)),
    )
  }, [tree])

  const toggleMulti = () => {
    if (multi) bulk.clear() // 退出多选必须清空，避免下次带着看不见的旧勾选
    setMulti(!multi)
  }

  // ---------------------------------------------------------------- 写操作

  const remove = async (id: number) => {
    await del(`/literature/${id}`)
    if (bulk.has(id)) bulk.toggle(id)
    await onMutated()
  }

  const digest = async (id: number) => {
    lastDigest.current = id
    const r: any = await dgTask.run(() =>
      post(`/literature/${id}/digest`, undefined, { ok: false }),
    )
    // 失败不落库、不开抽屉，避免空笔记区被误认为生成成功
    if (!r || r.ok === false) return
    await onMutated()
    onOpenDetail(id)
  }

  const retryDigest = () => {
    if (lastDigest.current != null) digest(lastDigest.current)
  }

  const selectedRows = () => {
    const byId = new Map(filtered.map((l) => [l.id, l]))
    return bulk.ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((l: any) => ({
        ...l,
        status: STATUS.find((s) => s.value === l.status)?.label || l.status,
      }))
  }

  const exportRows = (rows: any[], fmt: 'md' | 'csv' | 'bib') => {
    if (!rows.length) return
    const base = stamp('文献')
    if (fmt === 'csv') downloadText(`${base}.csv`, toCsv(rows, LIT_COLS), 'text/csv;charset=utf-8')
    else if (fmt === 'bib') downloadText(`${base}.bib`, toBibtex(rows), 'application/x-bibtex;charset=utf-8')
    else downloadText(`${base}.md`, toMarkdown('文献', rows, LIT_COLS), 'text/markdown;charset=utf-8')
    toast(`已导出 ${rows.length} 篇文献`, 'ok')
  }

  const bulkDrop = async () => {
    const ids = bulk.ids
    if (!ids.length) return
    if (!window.confirm(`删掉选中的 ${ids.length} 篇文献？笔记与对比记录会一起清掉，不可撤销`))
      return
    setBulkDel(true)
    try {
      await post('/literature/bulk-delete', { ids }, { ok: `已删除 ${ids.length} 篇文献` })
      bulk.clear()
      await onMutated()
    } finally {
      setBulkDel(false)
    }
  }

  // ---------------------------------------------------------------- 筛选与分页

  /** 改筛选条件一律回到第一页，否则会停在空页 */
  const resetTo = (fn: () => void) => {
    fn()
    setPage(1)
    listRef.current?.scrollTo({ top: 0 })
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const base = view === 'recent' ? items.slice(0, 30) : items
    const hit = base.filter((i) => {
      if (['todo', 'reading', 'done'].includes(view) && i.status !== view) return false
      if (!inCollection(i, coll)) return false
      if (!needle) return true
      const hay = [i.title, i.authors, i.venue, i.year, i.tags, ...collsOf(i)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(needle)
    })
    const sorted = [...hit]
    if (sortBy === 'title') sorted.sort((a, b) => String(a.title).localeCompare(String(b.title)))
    else if (sortBy === 'year') sorted.sort((a, b) => Number(b.year || 0) - Number(a.year || 0))
    else if (sortBy === 'rating') sorted.sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
    else sorted.sort((a, b) => Number(b.id) - Number(a.id))
    return sorted
  }, [items, view, coll, q, sortBy])

  const pageCount = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)))
  const cur = Math.min(Math.max(1, page), pageCount)
  const paged = useMemo(
    () => filtered.slice((cur - 1) * pageSize, cur * pageSize),
    [filtered, cur, pageSize],
  )

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [cur, q, coll, view])

  const grouped: { name: string; list: any[] }[] = useMemo(() => {
    if (!groupBy) return []
    const m = new Map<string, any[]>()
    for (const l of paged) {
      const names = collsOf(l)
      const key = names.length ? names[0] : '未分类'
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(l)
    }
    return [...m.entries()]
      .map(([name, list]) => ({ name, list }))
      .sort((a, b) => b.list.length - a.list.length)
  }, [paged, groupBy])

  // ---------------------------------------------------------------- 左栏

  const collCount = useMemo(() => {
    const s = new Set<string>()
    for (const l of items) for (const c of collsOf(l)) s.add(c)
    return s.size
  }, [items])

  const viewLabel = coll
    ? coll.split(' / ').pop() || coll
    : SMART.find((s) => s.value === view)?.label || '全部文献'

  const countFor = (v: View) => {
    if (v === 'all') return items.length
    if (v === 'recent') return Math.min(30, items.length)
    return items.filter((i) => i.status === v).length
  }

  /** 空结果时说清楚是哪几层筛选叠出来的，别让人误以为分类没加载出论文 */
  const emptyHint = (() => {
    if (!items.length) return '右上角「新增文献」，或从 Zotero 同步一批进来'
    const labels = [
      view !== 'all' ? `智能视图「${SMART.find((s) => s.value === view)?.label}」` : '',
      coll ? `分类「${viewLabel}」` : '',
      q.trim() ? `关键词「${q.trim()}」` : '',
    ].filter(Boolean)
    if (!labels.length) return '换个关键词，或点「清空筛选」'
    return `当前筛选：${labels.join(' + ')} · 点下面「清空筛选」回到全部文献`
  })()

  const toggleNode = (path: string) => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setExpanded(next)
  }

  /**
   * 点分类 = 「看这个分类下的全部文献」（与 Zotero 行为一致）。
   * 必须把智能视图（待读/在读/已读/最近添加）一起复位到「全部文献」：
   * 否则从「已读」切到分类时，只剩「该分类 ∩ 已读」的 0–1 篇，
   * 看起来就像点了分类却没加载出论文。
   */
  const pickCollection = (path: string) => {
    resetTo(() => {
      setView('all')
      setColl(path)
    })
  }

  const renderNode = (n: any): any => {
    const kids = n.children || []
    const open = expanded.has(n.path)
    const active = coll === n.path
    return (
      <div key={n.path}>
        <div className="flex items-center gap-1" style={{ paddingLeft: (n.depth || 0) * 9 }}>
          {kids.length > 0 ? (
            <button
              onClick={() => toggleNode(n.path)}
              className={`w-3 shrink-0 text-[11.5px] text-${LM_FAINT} hover:text-${LM_TITLE}`}
              aria-label={open ? '收起分类' : '展开分类'}
            >
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} strokeWidth={2} />
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <button
            onClick={() => pickCollection(active ? '' : n.path)}
            className={`flex min-w-0 flex-1 items-center justify-between rounded-[7px] px-1.5 py-1 text-[12px] transition ${
              active
                ? `bg-${LM_BLUE_SOFT} text-${LM_BLUE}`
                : `text-${LM_TEXT} hover:bg-${LM_CHIP_BG}`
            }`}
          >
            <span className="truncate text-left">{n.name}</span>
            <span className={`ml-1 shrink-0 text-[11.5px] text-${LM_FAINT}`}>
              {n.total ?? n.count}
            </span>
          </button>
        </div>
        {kids.length > 0 && open && (
          <div className="flex flex-col gap-0.5">{kids.map(renderNode)}</div>
        )}
      </div>
    )
  }

  const flatOptions = (() => {
    const out: { value: string; label: string }[] = [{ value: '', label: '全部分类' }]
    const walk = (nodes: any[], depth = 0) => {
      for (const n of nodes) {
        out.push({ value: n.path, label: `${'　'.repeat(depth)}${n.name}（${n.total ?? n.count}）` })
        if (n.children?.length) walk(n.children, depth + 1)
      }
    }
    walk(tree)
    out.push({ value: '__none', label: '未分类' })
    return out
  })()

  // ---------------------------------------------------------------- 行

  const renderRow = (l: any) => {
    const abs = abstractOf(l)
    const chips = [...collsOf(l).map((c) => c.split(' / ').pop() || c), ...tagsOf(l)].slice(0, 4)
    const checked = multi && bulk.has(l.id)
    return (
      <div
        key={l.id}
        className={`group flex gap-2.5 border-b border-${LM_BORDER} px-3 py-2.5 transition hover:bg-${LM_CHIP_BG} ${
          checked ? `bg-${LM_BLUE_SOFT}` : ''
        }`}
      >
        {multi && (
          <RowCheck checked={bulk.has(l.id)} onChange={() => bulk.toggle(l.id)} className="mt-2" />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
          onClick={() => onOpenPdf(l)}
          title="打开 PDF 阅读窗口"
        >
          <span className={`flex max-w-full items-center gap-1.5 text-[11.5px] text-${LM_FAINT}`}>
            <span
              className={`h-[6px] w-[6px] shrink-0 rounded-full ${STATUS_DOT[l.status] || STATUS_DOT.todo}`}
            />
            <span className="truncate">
              {firstAuthor(l)}. {l.year || '年份未填'}
            </span>
          </span>
          <span className={`w-full text-[13px] font-medium leading-snug text-${LM_TITLE} transition group-hover:text-${LM_BLUE}`}>
            {l.title}
          </span>
          {l.venue && (
            <span className={`w-full truncate text-[11.5px] text-${LM_TEXT}`}>
              {l.venue}
            </span>
          )}
          {abs && (
            <span
              style={CLAMP2}
              className={`mt-0.5 w-full text-[11.5px] leading-[1.55] text-${LM_FAINT}`}
            >
              {abs}
            </span>
          )}
          {chips.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {chips.map((c, idx) => (
                <span
                  key={`${c}-${idx}`}
                  className={`rounded-[5px] bg-${LM_CHIP_BG} px-1.5 py-[1px] text-[11px] text-${LM_TEXT}`}
                  title={c}
                >
                  {c}
                </span>
              ))}
            </span>
          )}
        </button>

        <div className="flex w-[6.5rem] shrink-0 flex-col items-end justify-between py-0.5">
          <button
            type="button"
            onClick={() => {
              if (!multi) setMulti(true)
              bulk.toggle(l.id)
            }}
            aria-label={checked ? '取消选中这篇文献' : '选中这篇文献'}
            title={checked ? '取消选中' : '选中（进入多选）'}
            className={`flex h-[15px] w-[15px] items-center justify-center rounded-full border transition ${
              checked
                ? `border-${LM_BLUE} bg-${LM_BLUE} text-white`
                : `border-${LM_BORDER_STRONG} bg-white hover:border-${LM_BLUE}`
            }`}
          >
            {checked && <Icon name="check" size={10} strokeWidth={2.5} />}
          </button>
          <div className="flex gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <IconBtn
              icon="file"
              size="sm"
              title="在页面正中的大窗口里读 PDF"
              ariaLabel="打开 PDF"
              onClick={() => onOpenPdf(l)}
            />
            <IconBtn
              icon="sparkle"
              size="sm"
              title="AI 生成分段笔记"
              ariaLabel="生成 AI 笔记"
              onClick={() => digest(l.id)}
            />
            <IconBtn
              icon="check"
              size="sm"
              title={l.status === 'done' ? '标回待读' : '标记已读'}
              ariaLabel={l.status === 'done' ? '标回待读' : '标记已读'}
              onClick={() => onStatusChange(l.id, l.status === 'done' ? 'todo' : 'done')}
            />
            <IconBtn
              icon="bookOpen"
              size="sm"
              title="打开完整详情（笔记 / Gloss / 痛点）"
              ariaLabel="打开完整详情"
              onClick={() => onOpenDetail(l.id)}
            />
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------- 渲染

  return (
    /* 满铺：直接贴住顶栏 / 侧栏 / 状态栏，分隔线由它们的边框承担，自己不再带圆角和外边框 */
    <div className="wb-view-enter lit-scope flex h-full min-h-0 flex-1 gap-0 overflow-hidden bg-white">
      {/* 左栏：页面级持久导航 */}
      <aside className={`hidden w-[210px] shrink-0 flex-col overflow-y-auto border-r border-${LM_BORDER} bg-white lg:flex`}>
        <div className={`px-3 pb-1 pt-3 text-[11px] text-${LM_FAINT}`}>智能视图</div>
        <div className="flex flex-col gap-0.5 px-2">
          {SMART.map((s) => {
            const active = !coll && view === s.value
            return (
              <button
                key={s.value}
                onClick={() =>
                  resetTo(() => {
                    setColl('')
                    setView(s.value)
                  })
                }
                className={`flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] transition ${
                  active
                    ? `bg-${LM_BLUE_SOFT} font-medium text-${LM_BLUE}`
                    : `text-${LM_TEXT} hover:bg-${LM_CHIP_BG}`
                }`}
              >
                <Icon name={s.icon} size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className={`shrink-0 text-[11px] text-${LM_FAINT}`}>
                  {countFor(s.value)}
                </span>
              </button>
            )
          })}
        </div>

        <div className={`mt-3 flex items-center justify-between border-t border-${LM_BORDER} px-3 py-2.5 text-[11px] text-${LM_FAINT}`}>
          <span>Collections</span>
          {coll && (
            <button
              onClick={() => resetTo(() => setColl(''))}
              className={`text-[11px] text-${LM_BLUE}`}
            >
              清除
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 px-2">
          {tree.length > 0 ? (
            <div className="flex flex-col gap-0.5">{tree.map(renderNode)}</div>
          ) : (
            <p className={`px-1 text-[11.5px] leading-relaxed text-${LM_FAINT}`}>
              还没有 Zotero 分类。到设置页同步一次，这里会按分类树列出文献。
            </p>
          )}
          {tree.length > 0 && (
            <p className={`mt-2 px-1 text-[11px] leading-relaxed text-${LM_FAINT}`}>
              点父分类会带上它下面所有子分类的文献
            </p>
          )}
        </div>

        <div className={`mt-auto flex shrink-0 flex-wrap gap-1 border-t border-${LM_BORDER} px-2.5 py-2.5`}>
          <Btn size="xs" onClick={() => exportRows(filtered, 'bib')} title="导出当前筛选结果的 BibTeX">
            导出 BibTeX
          </Btn>
          <Btn size="xs" variant="ghost" onClick={() => nav('/settings')} title="到设置页同步 Zotero">
            Zotero 同步
          </Btn>
        </div>
      </aside>

      {/* 右主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={`flex shrink-0 flex-wrap items-center gap-2 border-b border-${LM_BORDER} px-3.5 py-2.5`}>
          <Icon name="library" size={15} className={`text-${LM_BLUE}`} />
          <span className={`text-[14px] font-medium text-${LM_TITLE}`}>{viewLabel}</span>
          <span className={`text-[11.5px] text-${LM_FAINT}`}>
            {coll ? `馆藏 ${items.length} 篇 · ` : `${items.length} 篇 · `}
            {collCount} 个分类
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Btn size="sm" onClick={() => onOpenGraph(null)}>
              <Icon name="network" size={13} />
              关联图
            </Btn>
            <Btn size="sm" variant="primary" onClick={onAdd}>
              <Icon name="plus" size={13} />
              新增文献
            </Btn>
          </div>
        </div>

        <div className={`flex shrink-0 flex-wrap items-center gap-1.5 border-b border-${LM_BORDER} bg-white px-3.5 py-1.5`}>
          <span className={`text-[11.5px] text-${LM_FAINT}`}>
            已选 {bulk.count} · 命中 <span className={`text-${LM_TEXT}`}>{filtered.length}</span> 篇
          </span>
          <span className={`mx-0.5 h-3 w-px bg-${LM_BORDER_STRONG}`} />
          <SearchInput
            value={q}
            onChange={(v) => resetTo(() => setQ(v))}
            placeholder="搜标题 / 作者 / 摘要…"
            className="w-44"
          />
          <Select value={coll} onChange={pickCollection} options={flatOptions} className="lg:hidden" />
          <Select value={sortBy} onChange={(v) => resetTo(() => setSortBy(v))} options={SORT_OPTIONS} />
          <Btn size="sm" onClick={() => resetTo(() => setGroupBy(!groupBy))}>
            {groupBy ? '取消分组' : '按分类分组'}
          </Btn>
          <SelectToggle on={multi} onToggle={toggleMulti} title="进入多选，可批量导出或删除文献" />
        </div>

        {multi && (
          <div className="shrink-0 px-3.5 pt-2">
            <BulkBar
              count={bulk.count}
              total={filtered.length}
              unit="篇"
              onSelectAll={() => bulk.setAll(filtered.map((l) => l.id))}
              onClear={bulk.clear}
              onDelete={bulkDrop}
              deleting={bulkDel}
              exports={[
                { label: '导出 Markdown', run: () => exportRows(selectedRows(), 'md') },
                { label: '导出 CSV', run: () => exportRows(selectedRows(), 'csv') },
                { label: '导出 BibTeX', run: () => exportRows(selectedRows(), 'bib') },
              ]}
            />
          </div>
        )}

        {dgTask.error && (
          <div className="shrink-0 px-3.5 pt-2">
            <AiError
              error={dgTask.error}
              onRetry={retryDigest}
              retrying={dgTask.busy}
              title="AI 笔记没有生成"
            />
          </div>
        )}

        <div className={`flex shrink-0 items-center justify-between px-3.5 py-1.5 text-[11.5px] text-${LM_FAINT}`}>
          <span>
            显示 {paged.length} 篇{groupBy ? ' · 按分类分组' : ''}
            {view === 'recent' ? ' · 最近添加的 30 篇' : ''}
          </span>
          {(q || coll || view !== 'all') && (
            <button
              className={`text-${LM_BLUE} underline underline-offset-2`}
              onClick={() =>
                resetTo(() => {
                  setQ('')
                  setColl('')
                  setView('all')
                })
              }
            >
              清空筛选
            </button>
          )}
        </div>

        {/* 列表独立滚动：左栏与整页不跟着动 */}
        <div ref={listRef} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-${LM_BORDER}`}>
          {filtered.length === 0 ? (
            <Empty
              text={items.length ? '没有命中的文献' : '还没有文献'}
              hint={emptyHint}
              action={
                <Btn size="sm" variant="primary" onClick={onAdd}>
                  新增文献
                </Btn>
              }
            />
          ) : groupBy ? (
            <div>
              {grouped.map((g) => (
                <div key={g.name}>
                  <div className={`flex items-center gap-2 border-b border-${LM_BORDER} bg-white px-3 py-1.5 text-[12px] font-medium text-${LM_TITLE}`}>
                    <span>{g.name}</span>
                    <span className={`text-[11.5px] font-normal text-${LM_FAINT}`}>
                      {g.list.length} 篇
                    </span>
                  </div>
                  {g.list.map(renderRow)}
                </div>
              ))}
            </div>
          ) : (
            <div>{paged.map(renderRow)}</div>
          )}
        </div>

        <div className={`shrink-0 border-t border-${LM_BORDER} px-3.5 py-2`}>
          <Pagination
            total={filtered.length}
            page={cur}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={(n) => resetTo(() => setPageSize(n))}
            unit="篇"
          />
        </div>
      </div>
    </div>
  )
}
