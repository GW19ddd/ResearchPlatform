/**
 * 在线检索卡：OpenAlex 全文检索 / DOI 直查，结果可一键入库或读 OA PDF。
 * 去重只按归一化标题比对当前库，命中就不再允许重复入库。
 */
import { useMemo, useState, type KeyboardEvent } from 'react'
import { Btn, Card, Empty, Pagination, Pill, SearchInput } from '../../components/ui'
import { get, post } from '../../lib/api'
import { LM_BLUE, LM_BORDER, LM_FAINT, LM_TITLE } from './litColors'

type Hit = {
  title: string
  authors: string
  year: number | null
  venue: string | null
  cited_by: number | null
  oa: boolean
  pdf_url: string
  url: string
}

const norm = (s: string) =>
  (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')

export default function LitSearchCard({
  libTitles,
  onImported,
  flat = false,
}: {
  libTitles: string[]
  onImported: () => void
  /** 嵌入检索 tab 时铺平：去掉独立卡片的圆角 / 外框 / 阴影，与上方发现区连成一整片 */
  flat?: boolean
}) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [adding, setAdding] = useState('')
  /** 检索结果分页（本地切片，翻页不发请求） */
  const [sp, setSp] = useState(1)
  const [spSize, setSpSize] = useState(10)

  const libSet = useMemo(() => new Set(libTitles.map(norm)), [libTitles])
  const inLib = (h: Hit) => libSet.has(norm(h.title))

  /** 一次拉 100 条（OpenAlex per-page 上限 200），前端切片换页 */
  const spCount = Math.max(1, Math.ceil((hits?.length || 0) / Math.max(1, spSize)))
  const spCur = Math.min(Math.max(1, sp), spCount) // 新检索后页码可能越界，兜住
  const pagedHits = useMemo(
    () => (hits || []).slice((spCur - 1) * spSize, spCur * spSize),
    [hits, spCur, spSize],
  )

  const search = async (term?: string) => {
    const kw = (term ?? q).trim()
    if (!kw) return
    setQ(kw)
    setBusy(true)
    setErr('')
    try {
      const r: any = await get(`/litsearch?q=${encodeURIComponent(kw)}&limit=100`)
      if (r.ok === false) {
        // 后端会把「额度用尽」这类限流写成一句人话，hint 里带怎么恢复
        setErr([r.error || '检索失败', r.hint].filter(Boolean).join(' '))
        setHits(null)
      } else {
        setHits(r.results || [])
        setTotal(typeof r.total === 'number' ? r.total : null)
        setSp(1) // 换检索词必须回到第一页
      }
    } catch (e: any) {
      setErr(e?.message || '检索失败')
      setHits(null)
    } finally {
      setBusy(false)
    }
  }

  const add = async (h: Hit) => {
    setAdding(h.title)
    try {
      await post(
        '/literature',
        {
          title: h.title,
          authors: h.authors,
          year: h.year ?? null,
          venue: h.venue || '',
          url: h.url || h.pdf_url || '',
          status: 'todo',
        },
        { ok: '已加入文献库' },
      )
      onImported()
    } finally {
      setAdding('')
    }
  }

  return (
    <Card
      className={flat ? '!rounded-none !border-0 !shadow-none' : ''}
      title="在线检索"
      extra={
        <span className={`text-[11.5px] text-${LM_FAINT}`}>
          数据源 OpenAlex（覆盖 arXiv / PubMed / 主流出版社）
        </span>
      }
    >
      <div className="flex gap-2">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="关键词 / 论文标题 / DOI（回车检索）"
          className="flex-1"
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && search()}
        />
        <Btn variant="primary" onClick={() => search()} loading={busy} disabled={!q.trim()}>
          搜索
        </Btn>
      </div>

      {err && <p className="mt-2 text-[12px] text-[color:var(--wb-danger)]">{err}</p>}

      {hits && hits.length === 0 && !err && (
        <Empty text="没有检索到结果" hint="换个关键词，或直接粘贴 DOI 精确查找" />
      )}

      {hits && hits.length > 0 && (
        <>
          <p className={`mt-2 text-[11.5px] text-${LM_FAINT}`}>
            已拉回 {hits.length} 条{total != null ? `（OpenAlex 共约 ${total} 条）` : ''}
            {spCount > 1 ? ` · 第 ${spCur} / ${spCount} 页` : ''}
          </p>
          <div className="mt-1 flex flex-col gap-1.5">
            {pagedHits.map((h) => {
              const exists = inLib(h)
              return (
                <div
                  key={h.title + (h.year ?? '')}
                  className={`flex items-start gap-2.5 rounded-[10px] border border-${LM_BORDER} px-3 py-2`}
                >
                  <div className="min-w-0 flex-1">
                    <a
                      href={h.url || undefined}
                      target="_blank"
                      rel="noreferrer"
                      className={`text-[13px] font-medium leading-snug text-${LM_TITLE} underline-offset-2 hover:text-${LM_BLUE} hover:underline`}
                    >
                      {h.title}
                    </a>
                    <div className={`mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-${LM_FAINT}`}>
                      <span className="max-w-[24rem] truncate">{h.authors || '作者未知'}</span>
                      {h.year && <span>· {h.year}</span>}
                      {h.venue && <span className="max-w-[16rem] truncate">· {h.venue}</span>}
                      {h.cited_by != null && <span>· 被引 {h.cited_by}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {h.oa && <Pill tone="green">OA</Pill>}
                    {h.pdf_url && (
                      <a
                        href={h.pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className={`text-[11.5px] text-${LM_BLUE} underline underline-offset-2`}
                      >
                        开放 PDF
                      </a>
                    )}
                    {exists ? (
                      <Pill tone="gray">已在库</Pill>
                    ) : (
                      <Btn
                        size="sm"
                        onClick={() => add(h)}
                        loading={adding === h.title}
                        title="录入文献库，后续走 AI 笔记 / 对比矩阵同一条链路"
                      >
                        入库
                      </Btn>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div className={`mt-3 border-t border-${LM_BORDER} pt-2.5`}>
            <Pagination
              total={hits.length}
              page={spCur}
              pageSize={spSize}
              onPage={setSp}
              onPageSize={(n) => setSpSize(n)}
              unit="条"
              sizes={[10, 20, 50]}
            />
          </div>
        </>
      )}
    </Card>
  )
}
