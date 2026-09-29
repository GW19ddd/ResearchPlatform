/**
 * 文献页：录入 → 检索 → 同步 → 分页浏览 → 对比矩阵。
 *
 * 这一层只负责「列表数据、筛选、分页、开哪个浮层」，
 * 笔记 / PDF / Gloss 在 features/literature/*，Zotero 同步与对比矩阵也各自独立成组件。
 * 列表永远是全量拉回本地再切片分页 —— 这是本地单机应用，翻页不该产生请求。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AiError, AiMeta } from '../components/AiError'
import {
  Btn,
  Card,
  Empty,
  Input,
  LoadError,
  Loading,
  MdBlock,
  Modal,
  PageHeader,
  Pagination,
  Pill,
  SearchInput,
  Select,
  StatCard,
} from '../components/ui'
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
} from '../components/BulkBar'
import { toast } from '../components/toast'
import { Icon } from '../components/Icon'
import { del, get, patch, post } from '../lib/api'
import { useAiTask, useIdemKey } from '../lib/hooks'
import { usePersist } from '../lib/state'
import LiteratureDrawer from '../features/literature/LiteratureDrawer'
import MatrixTable from '../features/literature/MatrixTable'
import PdfModal from '../features/literature/PdfModal'
import ZoteroSyncCard from '../features/literature/ZoteroSyncCard'
import { STATUS, collsOf, inCollection } from '../features/literature/literature-shared'

const STATUS_DOT: Record<string, string> = {
  todo: 'bg-[color:var(--wb-muted)]',
  reading: 'bg-[color:var(--wb-warn)]',
  done: 'bg-[color:var(--wb-ok)]',
}

const EMPTY_FORM = { title: '', authors: '', year: '', venue: '', url: '' }

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

export default function Literature() {
  const [items, setItems] = useState<any[]>([])
  const [matrix, setMatrix] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  // 检索方案 / 单篇摘要两个 AI 动作：失败给原因 + 重试，不把错误文案当笔记
  const kwTask = useAiTask<any>()
  const dgTask = useAiTask<any>()
  const idem = useIdemKey()

  // 录入 / 检索
  const [form, setForm] = usePersist<any>('lit.form', EMPTY_FORM)
  const [topic, setTopic] = usePersist('lit.topic', '')
  const [out, setOut] = usePersist<{ title: string; text: string } | null>('lit.out', null)
  const [addOpen, setAddOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)

  // 浏览：筛选 + 搜索 + 分页
  const [filter, setFilter] = usePersist('lit.filter', '')
  const [q, setQ] = usePersist('lit.q', '')
  const [page, setPage] = usePersist('lit.page', 1)
  const [pageSize, setPageSize] = usePersist('lit.pageSize', 20)

  // Zotero 分类树浏览
  const [tree, setTree] = useState<any[]>([])
  const [coll, setColl] = usePersist('lit.coll', '')
  const [groupBy, setGroupBy] = usePersist('lit.groupby', false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // 详情抽屉只记 id，具体数据从 items 里取 —— 列表刷新时抽屉自动跟着更新
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailNonce, setDetailNonce] = useState(0)
  const detail = detailId ? items.find((i) => i.id === detailId) || null : null

  // 居中 PDF 浮层
  const [pdfItem, setPdfItem] = useState<any | null>(null)

  // 多选：默认关闭，点工具条上的「多选」才出现复选框
  // 全选范围 = 当前筛选命中的全部（跨页），不是只有本页
  const bulk = useBulk()
  const [multi, setMulti] = useState(false)
  const [bulkDel, setBulkDel] = useState(false)

  const toggleMulti = () => {
    if (multi) bulk.clear() // 退出时清空，避免下次进来带着看不见的旧勾选
    setMulti(!multi)
  }

  const load = async () => {
    setItems(await get('/literature'))
    const g = await get('/zotero/library/collections')
    const t = g.tree || []
    setTree(t)
    setExpanded((prev: Set<string>) => (prev.size > 0 ? prev : new Set(t.map((n: any) => n.path))))
  }

  const loadMatrix = async () => setMatrix(await get('/literature/matrix'))

  const reloadAll = async () => {
    await load()
    await loadMatrix()
  }

  const boot = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      await load()
      await loadMatrix()
    } catch (e: any) {
      setLoadError(e?.message || '文献列表加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    boot()
     
  }, [])

  // ---------------------------------------------------------------- 写操作

  const add = async () => {
    if (!form.title.trim()) return
    setBusy('add')
    try {
      await post(
        '/literature',
        { ...form, year: form.year ? Number(form.year) : null, status: 'todo' },
        { idem: idem.key },
      )
      idem.reset()
      setForm(EMPTY_FORM)
      setPage(1)
      setAddOpen(false)
      await reloadAll()
    } finally {
      setBusy('')
    }
  }

  const setStatus = async (id: number, status: string) => {
    await patch(`/literature/${id}`, { status })
    await load()
  }

  const remove = async (id: number) => {
    await del(`/literature/${id}`)
    if (detailId === id) setDetailId(null)
    if (pdfItem?.id === id) setPdfItem(null)
    if (bulk.has(id)) bulk.toggle(id) // 删掉的就别留在选区里
    await reloadAll()
  }

  const keywords = async () => {
    if (!topic.trim()) return
    const r: any = await kwTask.run(() => post('/literature/keywords', { topic }, { ok: false }))
    if (!r || r.ok === false) return
    setOut({ title: `检索方案 · ${topic}`, text: r.result })
  }

  // 摘要失败时要能一键重试同一篇，所以记住最后一次点的 id
  const lastDigest = useRef<number | null>(null)

  const digest = async (id: number) => {
    lastDigest.current = id
    const r: any = await dgTask.run(() => post(`/literature/${id}/digest`, undefined, { ok: false }))
    // 失败不落库、不打开抽屉 —— 用户不会看到一个空笔记区还以为生成成功了
    if (!r || r.ok === false) return
    await load()
    // 生成完直接开抽屉看结果；nonce 保证即使已打开也会重新拉笔记
    setDetailId(id)
    setDetailNonce((n) => n + 1)
  }

  const retryDigest = () => {
    if (lastDigest.current != null) digest(lastDigest.current)
  }

  // ---------------------------------------------------------------- 筛选与分页

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter((i) => {
      if (filter && i.status !== filter) return false
      if (!inCollection(i, coll)) return false
      if (!needle) return true
      const hay = [i.title, i.authors, i.venue, i.year, i.tags, ...collsOf(i)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(needle)
    })
  }, [items, filter, coll, q])

  const pageCount = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)))
  const cur = Math.min(Math.max(1, page), pageCount) // 删条目后页码可能越界，这里兜住
  const paged = useMemo(
    () => filtered.slice((cur - 1) * pageSize, cur * pageSize),
    [filtered, cur, pageSize],
  )

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

  const counts = useMemo(
    () => ({
      total: items.length,
      todo: items.filter((i) => i.status === 'todo').length,
      reading: items.filter((i) => i.status === 'reading').length,
      done: items.filter((i) => i.status === 'done').length,
    }),
    [items],
  )

  /** 改筛选条件一律回到第一页，否则会出现「筛完停在第 7 页、内容是空的」 */
  const resetTo = (fn: () => void) => {
    fn()
    setPage(1)
  }

  // ---------------------------------------------------------------- 分类树

  const toggleNode = (path: string) => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setExpanded(next)
  }

  const renderNode = (n: any): any => {
    const kids = n.children || []
    const open = expanded.has(n.path)
    const active = coll === n.path
    return (
      <div key={n.path}>
        <div className="flex items-center gap-1" style={{ paddingLeft: (n.depth || 0) * 10 }}>
          {kids.length > 0 ? (
            <button
              onClick={() => toggleNode(n.path)}
              className="w-3 shrink-0 text-[11.5px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]"
            >
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} strokeWidth={2} />
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <button
            onClick={() => resetTo(() => setColl(active ? '' : n.path))}
            className={`flex min-w-0 flex-1 items-center justify-between rounded-[7px] px-1.5 py-0.5 text-[12px] transition ${
              active
                ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
            }`}
          >
            <span className="truncate text-left">{n.name}</span>
            <span className="ml-1 shrink-0 text-[11.5px] text-[color:var(--wb-muted)]">
              {n.total ?? n.count}
            </span>
          </button>
        </div>
        {kids.length > 0 && open && <div className="flex flex-col gap-0.5">{kids.map(renderNode)}</div>}
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

  // ---- 批量操作：按勾选顺序取行，状态翻中文 ----
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

  const exportLits = (fmt: 'md' | 'csv' | 'bib') => {
    const rows = selectedRows()
    if (!rows.length) return
    const base = stamp('文献')
    if (fmt === 'csv') {
      downloadText(`${base}.csv`, toCsv(rows, LIT_COLS), 'text/csv;charset=utf-8')
    } else if (fmt === 'bib') {
      downloadText(`${base}.bib`, toBibtex(rows), 'application/x-bibtex;charset=utf-8')
    } else {
      downloadText(
        `${base}.md`,
        toMarkdown('文献', rows, LIT_COLS),
        'text/markdown;charset=utf-8',
      )
    }
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
      if (detailId !== null && ids.includes(detailId)) setDetailId(null)
      if (pdfItem && ids.includes(pdfItem.id)) setPdfItem(null)
      await reloadAll()
    } finally {
      setBulkDel(false)
    }
  }

  const renderItem = (l: any) => {
    const cols = collsOf(l)
    return (
      <div
        key={l.id}
        className={`group cursor-pointer rounded-[12px] border px-3 py-2.5 transition hover:shadow-[var(--wb-shadow-sm)] ${
          multi && bulk.has(l.id)
            ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)]'
            : 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] hover:border-[color:var(--wb-border-strong)]'
        }`}
        onClick={() => (multi ? bulk.toggle(l.id) : setDetailId(l.id))}
      >
        <div className="flex items-start gap-2.5">
          {multi && (
            <RowCheck
              checked={bulk.has(l.id)}
              onChange={() => bulk.toggle(l.id)}
              className="mt-[5px]"
            />
          )}
          <span
            className={`mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full ${
              STATUS_DOT[l.status] || STATUS_DOT.todo
            }`}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-snug text-[color:var(--wb-text)] transition group-hover:text-[color:var(--wb-accent)]">
              {l.title}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-[color:var(--wb-muted)]">
              <span className="max-w-[24rem] truncate">{l.authors || '作者未填'}</span>
              {l.year && <span>· {l.year}</span>}
              {l.venue && <span className="max-w-[16rem] truncate">· {l.venue}</span>}
              {Number(l.note_count || 0) > 0 && (
                <span className="text-[color:var(--wb-accent)]">· 笔记 {l.note_count}</span>
              )}
            </div>
            {cols.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {cols.map((c) => (
                  <span
                    key={c}
                    className="rounded-full bg-[color:var(--wb-bg-subtle)] px-2 py-[1px] text-[11.5px] text-[color:var(--wb-text-soft)]"
                    title={c}
                  >
                    {c.split(' / ').pop()}
                  </span>
                ))}
              </div>
            )}
          </div>
          <Pill tone={l.status === 'done' ? 'green' : l.status === 'reading' ? 'amber' : 'gray'}>
            {STATUS.find((s) => s.value === l.status)?.label || l.status}
          </Pill>
        </div>

        <div
          className="mt-2 flex flex-wrap items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <Select
            value={l.status}
            onChange={(v) => setStatus(l.id, v)}
            options={STATUS}
            className="[&_select]:!py-[3px] [&_select]:!text-[11.5px]"
          />
          <Btn size="sm" onClick={() => setPdfItem(l)} title="在页面正中的大窗口里读 PDF">
            PDF
          </Btn>
          <Btn size="sm" onClick={() => digest(l.id)} loading={dgTask.busy}>
            AI 笔记
          </Btn>
          <Btn size="sm" onClick={() => setDetailId(l.id)}>
            详情
            {Number(l.note_count || 0) > 0 ? ` · ${l.note_count}` : ''}
          </Btn>
          {l.url && (
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="text-[11.5px] text-[color:var(--wb-accent)] underline underline-offset-2"
            >
              原文
            </a>
          )}
          <Btn
            size="sm"
            variant="ghost"
            className="ml-auto !text-[color:var(--wb-muted)] hover:!text-[color:var(--wb-danger)]"
            onClick={() => remove(l.id)}
          >
            删除
          </Btn>
        </div>
      </div>
    )
  }

  // 加载失败要有出口：给原因 + 重试，别停在 spinner 上
  if (loadError) {
    return (
      <div className="flex flex-col gap-3.5">
        <PageHeader title="文献" desc="录入 → 检索 → 同步 → 精读笔记 → 横向对比" />
        <LoadError error={loadError} onRetry={boot} retrying={loading} what="文献列表" />
      </div>
    )
  }

  if (loading) return <Loading text="正在加载文献…" />

  return (
    <div className="flex flex-col gap-3.5">
      <PageHeader
        title="文献"
        desc="录入 → 检索 → 同步 → 精读笔记 → 横向对比，闭环到 Related Work"
        actions={
          <>
            <Btn
              onClick={() => {
                setPlanOpen(true)
                setOut(null)
              }}
            >
              <Icon name="sparkle" size={13} />
              检索方案
            </Btn>
            <Btn variant="primary" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={13} />
              新增文献
            </Btn>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="文献总数" value={counts.total} unit="篇" tone="accent" />
        <StatCard label="待读" value={counts.todo} unit="篇" />
        <StatCard label="在读" value={counts.reading} unit="篇" tone="warn" />
        <StatCard
          label="已读"
          value={counts.done}
          unit="篇"
          tone="ok"
          hint={counts.total ? `完成度 ${Math.round((counts.done / counts.total) * 100)}%` : undefined}
        />
      </div>

      <Card
        title="文献库"
        extra={
          <div className="flex flex-wrap items-center gap-1.5">
            <SearchInput
              value={q}
              onChange={(v) => resetTo(() => setQ(v))}
              placeholder="搜标题 / 作者 / 分类…"
              className="w-44"
            />
            <Select
              value={filter}
              onChange={(v) => resetTo(() => setFilter(v))}
              options={[{ value: '', label: '全部状态' }, ...STATUS]}
            />
            <Select value={coll} onChange={(v) => resetTo(() => setColl(v))} options={flatOptions} />
            <Btn onClick={() => resetTo(() => setGroupBy(!groupBy))}>
              {groupBy ? '取消分组' : '按分类分组'}
            </Btn>
            <SelectToggle
              on={multi}
              onToggle={toggleMulti}
              title="进入多选，可批量导出或删除文献"
            />
          </div>
        }
      >
        {dgTask.error && (
          <div className="mb-2.5">
            <AiError
              error={dgTask.error}
              onRetry={retryDigest}
              retrying={dgTask.busy}
              title="AI 笔记没有生成"
            />
          </div>
        )}
        <div className="flex gap-3">
          {tree.length > 0 && (
            <div className="hidden w-52 shrink-0 self-start rounded-[10px] border border-[color:var(--wb-border)] p-2 lg:block">
              <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-[11.5px] text-[color:var(--wb-muted)]">Zotero 分类树</span>
                {coll && (
                  <button
                    onClick={() => resetTo(() => setColl(''))}
                    className="text-[11.5px] text-[color:var(--wb-accent)]"
                  >
                    清除
                  </button>
                )}
              </div>
              <div className="max-h-[32rem] overflow-y-auto">
                <div className="flex flex-col gap-0.5">{tree.map(renderNode)}</div>
              </div>
              <p className="mt-2 px-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                点父分类会带上它下面所有子分类的文献
              </p>
            </div>
          )}

          <div className="min-w-0 flex-1">
            {multi && filtered.length > 0 && (
              <BulkBar
                count={bulk.count}
                total={filtered.length}
                unit="篇"
                onSelectAll={() => bulk.setAll(filtered.map((l) => l.id))}
                onClear={bulk.clear}
                onDelete={bulkDrop}
                deleting={bulkDel}
                exports={[
                  { label: '导出 Markdown', run: () => exportLits('md') },
                  { label: '导出 CSV', run: () => exportLits('csv') },
                  { label: '导出 BibTeX', run: () => exportLits('bib') },
                ]}
              />
            )}
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px] text-[color:var(--wb-text-soft)]">
              {coll && (
                <>
                  <span>当前分类：</span>
                  <span className="rounded-full bg-[color:var(--wb-accent-soft)] px-2 py-[1px] text-[color:var(--wb-accent)]">
                    {coll}
                  </span>
                </>
              )}
              <span className="text-[color:var(--wb-muted)]">
                命中 {filtered.length} 篇
                {groupBy ? ' · 本页按分类分组' : ''}
              </span>
              {(q || filter || coll) && (
                <button
                  className="text-[color:var(--wb-accent)] underline underline-offset-2"
                  onClick={() =>
                    resetTo(() => {
                      setQ('')
                      setFilter('')
                      setColl('')
                    })
                  }
                >
                  清空筛选
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <Empty
                text={items.length ? '没有命中的文献' : '还没有文献'}
                hint={
                  items.length
                    ? '换个关键词或清空筛选'
                    : '右上角「新增文献」，或从 Zotero 同步一批进来'
                }
              />
            ) : groupBy ? (
              <div className="flex flex-col gap-3">
                {grouped.map((g) => (
                  <div key={g.name}>
                    <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-[color:var(--wb-text)]">
                      <span className="rounded-full bg-[color:var(--wb-bg-subtle)] px-2 py-[1px]">
                        {g.name}
                      </span>
                      <span className="text-[11.5px] font-normal text-[color:var(--wb-muted)]">
                        {g.list.length} 篇
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">{g.list.map(renderItem)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">{paged.map(renderItem)}</div>
            )}

            <div className="mt-3 border-t border-[color:var(--wb-border)] pt-2.5">
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
      </Card>

      <ZoteroSyncCard collapsible={items.length > 0} onImported={reloadAll} />

      <MatrixTable
        matrix={matrix}
        onAddDim={async () => {
          const name = window.prompt('新对比维度名称（例：是否开源、评测集、是否需要人工）')
          if (!name) return
          await post('/literature/matrix/dimension', { dim_name: name })
          loadMatrix()
        }}
        onDropDim={async (name) => {
          await del(`/literature/matrix/dimension/${encodeURIComponent(name)}`)
          loadMatrix()
        }}
        onSaveCell={async (literature_id, dim_name, value) => {
          await post('/literature/matrix', { literature_id, dim_name, dim_value: value })
        }}
      />

      {/* 录入 */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="新增文献"
        footer={
          <>
            <Btn onClick={() => setAddOpen(false)}>取消</Btn>
            <Btn variant="primary" onClick={add} loading={busy === 'add'} disabled={!form.title.trim()}>
              加入文献库
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-2.5">
          <Input
            placeholder="标题（必填）"
            value={form.title}
            onChange={(v) => setForm({ ...form, title: v })}
          />
          <Input
            placeholder="作者（多位用逗号隔开）"
            value={form.authors}
            onChange={(v) => setForm({ ...form, authors: v })}
          />
          <div className="flex gap-2">
            <Input
              placeholder="年份"
              value={form.year}
              onChange={(v) => setForm({ ...form, year: v })}
            />
            <Input
              placeholder="会议 / 期刊"
              value={form.venue}
              onChange={(v) => setForm({ ...form, venue: v })}
            />
          </div>
          <Input
            placeholder="链接 / DOI"
            value={form.url}
            onChange={(v) => setForm({ ...form, url: v })}
          />
          <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            批量入库走下面的「从 Zotero 同步」，这里适合随手补一条。
          </p>
        </div>
      </Modal>

      {/* 检索方案 */}
      <Modal
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        title="AI 检索方案"
        width="max-w-3xl"
        footer={
          <>
            <Btn onClick={() => setPlanOpen(false)}>关闭</Btn>
            <Btn
              variant="primary"
              onClick={keywords}
              loading={kwTask.busy}
              disabled={!topic.trim()}
            >
              生成检索式
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            placeholder="研究主题，例：LLM agent for CFD case repair"
            value={topic}
            onChange={setTopic}
          />
          <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            输出可直接粘贴到 Google Scholar / IEEE Xplore / arXiv 的布尔检索式、必追关键词与反向检索建议。
          </p>
          {kwTask.error && (
            <AiError error={kwTask.error} onRetry={keywords} retrying={kwTask.busy} />
          )}
          {kwTask.busy ? (
            <Loading text="正在生成检索方案…" />
          ) : out && !kwTask.error ? (
            <div className="max-h-[52vh] overflow-y-auto rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] p-3">
              <MdBlock text={out.text} />
              <AiMeta res={kwTask.data || {}} />
            </div>
          ) : null}
        </div>
      </Modal>

      <LiteratureDrawer
        item={detail}
        nonce={detailNonce}
        onClose={() => setDetailId(null)}
        onMutated={load}
        onStatusChange={setStatus}
        onOpenPdf={() => detail && setPdfItem(detail)}
      />

      <PdfModal item={pdfItem} onClose={() => setPdfItem(null)} onChanged={load} />
    </div>
  )
}
