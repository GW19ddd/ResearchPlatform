/**
 * 对比矩阵表：横向比较相关工作，填满后 Related Work 基本能照着写。
 *
 * 纯展示 + 三个回调，不碰数据获取，方便单独复用/替换。
 * 行数多时（在线检索批量入库动辄上百篇）前端切片分页，换页不发请求；
 * 工具条提供标题搜索与「只看已填 / 只看空白」，改筛选一律回到第一页。
 */
import { useMemo, useState } from 'react'
import { Btn, Empty, IconBtn, Pagination, SearchInput, Select } from '../../components/ui'
import { LM_BLUE, LM_BORDER, LM_BORDER_STRONG, LM_FAINT, LM_TITLE } from './litColors'

const VIEW_OPTS = [
  { value: 'all', label: '全部文献' },
  { value: 'filled', label: '只看已填' },
  { value: 'blank', label: '只看空白' },
]

const isFilled = (p: any) =>
  Object.values(p.cells || {}).some((v) => String(v ?? '').trim() !== '')

export default function MatrixTable({
  matrix,
  onAddDim,
  onDropDim,
  onSaveCell,
}: {
  matrix: any
  onAddDim: () => void
  onDropDim: (name: string) => void
  onSaveCell: (literatureId: number, dim: string, value: string) => void
}) {
  const [q, setQ] = useState('')
  const [view, setView] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const papers: any[] = matrix?.papers || []
  const filledCount = useMemo(() => papers.filter(isFilled).length, [papers])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return papers.filter((p) => {
      if (needle && !String(p.title || '').toLowerCase().includes(needle)) return false
      if (view === 'filled' && !isFilled(p)) return false
      if (view === 'blank' && isFilled(p)) return false
      return true
    })
  }, [papers, q, view])

  // 删条目 / 换筛选后页码可能越界，这里兜住
  const pageCount = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)))
  const cur = Math.min(Math.max(1, page), pageCount)
  const paged = useMemo(
    () => filtered.slice((cur - 1) * pageSize, cur * pageSize),
    [filtered, cur, pageSize],
  )

  /** 改筛选条件一律回到第一页，避免「筛完停在空页」 */
  const resetTo = (fn: () => void) => {
    fn()
    setPage(1)
  }

  return (
    /* 满铺：与文献库同款，贴住顶栏/侧栏/状态栏边线，表格区域内部滚动 */
    <div className="lit-scope flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-white">
      <div className={`flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-${LM_BORDER} bg-white px-4 py-2.5`}>
        <h2 className={`whitespace-nowrap text-[13px] font-semibold text-${LM_TITLE}`}>
          相关工作对比矩阵
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <SearchInput
            value={q}
            onChange={(v) => resetTo(() => setQ(v))}
            placeholder="搜标题…"
            className="w-40"
          />
          <Select
            value={view}
            onChange={(v) => resetTo(() => setView(v))}
            options={VIEW_OPTS}
          />
          <Btn onClick={onAddDim}>加维度</Btn>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!matrix || papers.length === 0 ? (
          <Empty text="先录入文献，再横向对比" />
        ) : filtered.length === 0 ? (
          <Empty text="没有命中的文献" hint="换个关键词，或切回「全部文献」" />
        ) : (
          <>
            <div className={`mb-2 text-[11.5px] text-${LM_FAINT}`}>
              命中 {filtered.length} 篇 · 已填 {filledCount} / 共 {papers.length} 篇
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-[12px]">
                <thead>
                  <tr>
                    <th className={`border-b border-${LM_BORDER} px-2 py-2 text-left font-medium text-${LM_FAINT}`}>
                      文献
                    </th>
                    {matrix.dimensions.map((d: string) => (
                      <th
                        key={d}
                        className={`border-b border-${LM_BORDER} px-2 py-2 text-left font-medium text-${LM_FAINT}`}
                      >
                        <span className="flex items-center gap-1">
                          {d}
                          <IconBtn
                            icon="close"
                            size="sm"
                            tone="danger"
                            title="删除该维度"
                            ariaLabel={`删除维度 ${d}`}
                            onClick={() => onDropDim(d)}
                          />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paged.map((p: any) => (
                    <tr key={p.id} className="hover:bg-white">
                      <td className={`border-b border-${LM_BORDER} px-2 py-1.5 align-top text-${LM_TITLE}`}>
                        <div>{p.title}</div>
                        {(p.venue || p.year) && (
                          <div className={`mt-0.5 text-[11px] text-${LM_FAINT}`}>
                            {[p.venue, p.year].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
                      {matrix.dimensions.map((d: string) => (
                        <td
                          key={d}
                          className={`border-b border-${LM_BORDER} px-2 py-1.5 align-top`}
                        >
                          <input
                            defaultValue={p.cells[d] || ''}
                            onBlur={(e) => onSaveCell(p.id, d, e.target.value)}
                            className={`w-full rounded-[6px] border border-transparent bg-transparent px-1 py-0.5 text-[12px] outline-none transition hover:border-${LM_BORDER_STRONG} focus:border-${LM_BLUE} focus:bg-white`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={`mt-3 border-t border-${LM_BORDER} pt-2.5`}>
              <Pagination
                total={filtered.length}
                page={cur}
                pageSize={pageSize}
                onPage={setPage}
                onPageSize={(n) => resetTo(() => setPageSize(n))}
                unit="篇"
              />
            </div>
          </>
        )}
        <p className={`mt-2 text-[11.5px] text-${LM_FAINT}`}>
          这张表填满后，Related Work 基本可以直接照着写。单元格失焦即保存。
        </p>
      </div>
    </div>
  )
}
