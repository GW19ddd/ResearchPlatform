import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Btn, Modal } from '../../components/ui'
import { get } from '../../lib/api'
import type { Citation } from '../canvas/ChatPanel'

/**
 * 正文 [n]、引用 chips、文献检索栏标题共用的「文献详情」弹窗。
 *
 * 数据口径：只展示本地文献库已存的真实字段 + OpenAlex 还原的摘要 + 已有阅读笔记。
 * 摘要缺失就明写「未提供」，绝不用模型补一段看似摘要的文字。
 */
export type PaperInfo = Omit<Citation, 'year'> & {
  year?: number | string | null
  cited_by_count?: number
  cit_per_year?: number
  language?: string
  pdf_url?: string
  match?: number
  abstract?: string
  openalex_id?: string
}

type LitNote = { id: number; section: string; content: string; source: string }
type LitRow = {
  id?: number
  title?: string
  authors?: string
  year?: number | string | null
  venue?: string
  doi?: string
  url?: string
  abstract?: string
  status?: string
  rating?: number
  notes?: string
  pdf_path?: string
  openalex_id?: string
  cited_by_count?: number
}

export default function PaperDetailModal({
  info,
  onClose,
  onOpenLibrary,
}: {
  info: PaperInfo | null
  onClose: () => void
  onOpenLibrary?: (litId: number) => void
}) {
  const [row, setRow] = useState<LitRow | null>(null)
  const [notes, setNotes] = useState<LitNote[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const litId = info?.lit_id ?? null
  useEffect(() => {
    if (!info) return
    setRow(null)
    setNotes([])
    setErr('')
    if (litId == null) return // 早期会话的引用没存 lit_id：只展示引用里已有的元数据
    setLoading(true)
    get<{ paper: LitRow; notes: LitNote[] }>(`/rchat/papers/${litId}`)
      .then((r) => {
        setRow(r.paper || null)
        setNotes(r.notes || [])
      })
      .catch((e: any) => setErr(e?.message || '文献详情加载失败'))
      .finally(() => setLoading(false))
  }, [info?.n, litId])

  if (!info) return null

  // 库里的记录优先，抓不到就退回该轮检索时留下的引用元数据
  const title = row?.title || info.title || '（无标题）'
  const authors = row?.authors || info.authors || '佚名'
  const year = row?.year ?? info.year
  const venue = row?.venue || info.venue
  const doi = row?.doi || info.doi
  const url = row?.url || info.url
  const abstract = row?.abstract || info.abstract || ''
  const cited = row?.cited_by_count ?? info.cited_by_count ?? info.cited_by
  const pdf = info.pdf_url || ''
  const oaId = row?.openalex_id || info.openalex_id
  const doiHref = doi ? `https://doi.org/${doi}` : ''
  const href = doiHref || url || (oaId ? `https://openalex.org/${oaId}` : '')

  return (
    <Modal
      open={!!info}
      onClose={onClose}
      width="max-w-[720px]"
      title={
        <span className="flex items-center gap-2">
          <Icon name="bookOpen" size={14} className="text-[color:var(--wb-accent)]" />
          文献 [{info.n}] · 对应内容
        </span>
      }
      footer={
        <>
          {litId != null && onOpenLibrary && (
            <Btn size="xs" variant="subtle" onClick={() => onOpenLibrary(litId)}>
              <Icon name="library" size={11} />
              在文献库打开
            </Btn>
          )}
          <Btn size="xs" variant="ghost" onClick={onClose}>
            关闭
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <h4 className="text-[15px] font-semibold leading-snug text-[color:var(--wb-text)]">{title}</h4>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[color:var(--wb-text-soft)]">
          <span className="truncate">{authors}</span>
          {year != null && <span>{year}</span>}
          {venue && <span className="text-[color:var(--wb-accent)]">{venue}</span>}
          {typeof cited === 'number' && <span>被引 {cited}</span>}
          {row?.status && <span>状态 {row.status}</span>}
        </div>

        {(href || pdf || oaId) && (
          <div className="flex flex-wrap gap-1.5">
            {href && (
              <a href={href} target="_blank" rel="noreferrer" className="wb-paper-link">
                <Icon name="link" size={11} />
                {doi ? `doi:${doi}` : '原文链接'}
              </a>
            )}
            {pdf && (
              <a href={pdf} target="_blank" rel="noreferrer" className="wb-paper-link">
                <Icon name="file" size={11} />
                开放获取 PDF
              </a>
            )}
            {oaId && (
              <a href={`https://openalex.org/${oaId}`} target="_blank" rel="noreferrer" className="wb-paper-link">
                <Icon name="database" size={11} />
                OpenAlex
              </a>
            )}
          </div>
        )}

        <div className="border-t border-[color:var(--wb-border)] pt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-[color:var(--wb-text)]">
            <Icon name="quote" size={12} className="text-[color:var(--wb-accent)]" />
            摘要
            <span className="font-normal text-[color:var(--wb-muted)]">· OpenAlex 原样还原</span>
          </div>
          {loading ? (
            <p className="text-[11.5px] text-[color:var(--wb-muted)]">正在读取文献库记录…</p>
          ) : abstract ? (
            <p className="max-h-[240px] overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
              {abstract}
            </p>
          ) : (
            <p className="rounded-[8px] border border-dashed border-[color:var(--wb-border)] px-3 py-2 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
              OpenAlex 未提供该篇摘要（本地也未保存）。为避免虚构，这里不生成摘要；
              可点上方链接查看原文，或到文献库为它补一段阅读笔记。
            </p>
          )}
        </div>

        {(row?.notes || notes.length > 0) && (
          <div className="border-t border-[color:var(--wb-border)] pt-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-[color:var(--wb-text)]">
              <Icon name="notebook" size={12} className="text-[color:var(--wb-accent)]" />
              本地记录
            </div>
            {row?.notes && (
              <p className="mb-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                {row.notes}
              </p>
            )}
            {notes.map((n) => (
              <div key={n.id} className="mb-1.5 rounded-[8px] bg-[color:var(--wb-bg-subtle)] px-3 py-2">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-[color:var(--wb-muted)]">
                  {n.section}
                  <span className="rounded-[3px] border border-[color:var(--wb-border)] px-1">
                    {n.source === 'me' ? '我写的' : 'AI 生成'}
                  </span>
                </div>
                {n.content && (
                  <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                    {n.content}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {err && <p className="text-[11px] text-[color:var(--wb-danger)]">{err}</p>}
        <p className="border-t border-[color:var(--wb-border)] pt-2 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
          标题 / 作者 / 年份 / 期刊 / 被引 / DOI / PDF 来自 OpenAlex 原样字段并写入本地文献库；
          摘要由 abstract_inverted_index 还原。没有的字段一律留白，不做推断。
        </p>
      </div>
    </Modal>
  )
}
