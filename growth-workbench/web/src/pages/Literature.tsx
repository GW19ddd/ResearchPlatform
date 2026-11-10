/**
 * 文献页：录入 → 同步 → 浏览 → 对比矩阵 → 关联图。
 *
 * 这一层只负责「数据加载、视图切换、写操作、浮层」：
 *   - 文献库骨架（全高左导航 + 紧凑行列表）在 features/literature/LibraryView
 *   - 详情面板 + 引文图谱分屏在 features/literature/GraphView
 *   - 笔记 / Gloss / 痛点的深层编辑在 LiteratureDrawer，PDF 一律走 PdfModal 居中大窗
 * 视图状态由 URL 的 ?tab= 唯一决定，刷新保留、侧栏菜单可精确高亮。
 */
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Btn,
  Input,
  LoadError,
  Loading,
  Modal,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { del, get, patch, post } from '../lib/api'
import { useIdemKey } from '../lib/hooks'
import { usePersist } from '../lib/state'
import LiteratureDrawer from '../features/literature/LiteratureDrawer'
import LibraryView from '../features/literature/LibraryView'
import GraphView from '../features/literature/GraphView'
import MatrixTable from '../features/literature/MatrixTable'
import PdfModal from '../features/literature/PdfModal'
import Search from './Search'

const EMPTY_FORM = { title: '', authors: '', year: '', venue: '', url: '' }

type LitTab = 'library' | 'graph' | 'matrix' | 'search'
const TABS: { value: LitTab; label: string }[] = [
  { value: 'library', label: '文献库' },
  { value: 'graph', label: '关联图' },
  { value: 'matrix', label: '对比矩阵' },
  { value: 'search', label: '检索' },
]

export default function Literature() {
  const nav = useNavigate()
  const loc = useLocation()
  const urlTab = new URLSearchParams(loc.search).get('tab')
  const activeTab: LitTab = TABS.some((t) => t.value === urlTab) ? (urlTab as LitTab) : 'library'

  const [items, setItems] = useState<any[]>([])
  const [tree, setTree] = useState<any[]>([])
  const [matrix, setMatrix] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const idem = useIdemKey()

  // 录入
  const [form, setForm] = usePersist<any>('lit.form', EMPTY_FORM)
  const [addOpen, setAddOpen] = useState(false)

  // 浮层：抽屉只记 id，数据从 items 里取；列表刷新时抽屉自动跟着更新
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailNonce, setDetailNonce] = useState(0)
  const detail = detailId ? items.find((i) => i.id === detailId) || null : null
  const [pdfItem, setPdfItem] = useState<any | null>(null)

  // 从列表行点进关联图时记住选中哪篇；直接点侧栏「关联图」则为 null（视图内自动选第一篇）
  const [graphSelectedId, setGraphSelectedId] = useState<number | null>(null)

  const load = async () => {
    const [lits, g] = await Promise.all([
      get('/literature'),
      get('/zotero/library/collections'),
    ])
    setItems(lits)
    setTree(g.tree || [])
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
      await reloadAll()
    } catch (e: any) {
      setLoadError(e?.message || '文献列表加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 设置页里的 Zotero 同步是浮层，本页不会重新挂载，靠广播事件跟着刷新
  useEffect(() => {
    const refresh = () => {
      reloadAll().catch(() => {})
    }
    window.addEventListener('wb:data-changed', refresh)
    return () => window.removeEventListener('wb:data-changed', refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 切视图 = 换 URL；对比矩阵顺带重拉一次，避免在其他视图导入文献后看到旧矩阵 */
  /** 每次打开详情都让抽屉重拉一次笔记，避免「同一篇刚生成完 AI 笔记但抽屉没刷新」 */
  const openDetail = (id: number) => {
    setDetailId(id)
    setDetailNonce((n) => n + 1)
  }

  const openGraph = (id: number | null) => {
    setGraphSelectedId(id)
    nav('/literature?tab=graph')
  }

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

  // 加载失败要有出口：给原因 + 重试，别停在 spinner 上
  if (loadError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <LoadError error={loadError} onRetry={boot} retrying={loading} what="文献列表" />
      </div>
    )
  }

  if (loading) return <Loading text="正在加载文献…" />

  return (
    /* 文献页四个视图全部满铺（App.tsx 的 full 已覆盖 /literature），视图内部自己管滚动 */
    <div className="flex h-full min-h-0 flex-col">
      {/* 视图切换只走左侧菜单「文献」分组（?tab= 直达）；页面身份由顶栏面包屑承担，
          页内不再渲染标题/描述行，「新增文献」收在文献库标题条右侧 */}

      {activeTab === 'library' && (
        <LibraryView
          items={items}
          tree={tree}
          onOpenDetail={openDetail}
          onOpenPdf={setPdfItem}
          onOpenGraph={openGraph}
          onMutated={load}
          onStatusChange={setStatus}
          onAdd={() => setAddOpen(true)}
        />
      )}

      {activeTab === 'graph' && (
        <GraphView
          items={items}
          selectedId={graphSelectedId}
          onSelect={setGraphSelectedId}
          onOpenDetail={openDetail}
          onOpenPdf={setPdfItem}
          onMutated={load}
        />
      )}

      {activeTab === 'search' && (
        <div className="wb-view-enter min-h-0 flex-1 overflow-y-auto">
          <Search embedded />
        </div>
      )}

      {activeTab === 'matrix' && (
        <div className="wb-view-enter flex h-full min-h-0 flex-1 flex-col">
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
        </div>
      )}

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
            这里适合随手补一条；DOI / 关键词批量检索入库走「检索」标签，Zotero 批量同步在「设置」里。
          </p>
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
