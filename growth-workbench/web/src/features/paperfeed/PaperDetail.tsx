/**
 * 论文详情弹窗（对标 paperdance 的点入页）：大图 + 标题 + 摘要，
 * 语言切换（English / 中文 / 双语）；中文走 LLM 翻译并缓存进库。
 */
import { useEffect, useState } from 'react'
import { Btn, Modal, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { Segmented } from '../../components/ui'
import { post } from '../../lib/api'
import { relativeTime, figSrc, type Lang, type Paper } from './types'

export default function PaperDetail({
  paper,
  defaultLang,
  onClose,
}: {
  paper: Paper | null
  defaultLang: Lang
  onClose: () => void
}) {
  const [lang, setLang] = useState<Lang>(defaultLang || 'both')
  const [translating, setTranslating] = useState(false)
  const [transErr, setTransErr] = useState('')
  // 翻译结果写回本地状态，避免整列表重拉
  const [zh, setZh] = useState<{ title_zh: string; abstract_zh: string } | null>(null)
  const [imgLoading, setImgLoading] = useState(false)

  useEffect(() => {
    if (!paper) return
    setLang(defaultLang || 'both')
    setTransErr('')
    setImgLoading(true)
    setZh(
      paper.title_zh || paper.abstract_zh
        ? { title_zh: paper.title_zh || '', abstract_zh: paper.abstract_zh || '' }
        : null,
    )
    // 懒补图：四层兜底（img / object svg / 内嵌 svg / PDF 首页），展示走代理端点
    if (!paper.figure_url && paper.arxiv_id) {
      let alive = true
      post<{ ok: boolean; figure_url?: string; msg?: string }>(
        `/paperfeed/papers/${paper.id}/figure`,
        {},
        { silent: true },
      )
        .catch(() => {})
      return () => {
        alive = false
      }
    }
  }, [paper, defaultLang])

  // 中文 / 双语模式下缺中文 → 懒翻译一次
  useEffect(() => {
    if (!paper || !zh || (zh.title_zh || zh.abstract_zh)) return
    if (lang === 'en') return
    let alive = true
    setTranslating(true)
    setTransErr('')
    post<{ ok: boolean; title_zh?: string; abstract_zh?: string; error?: string }>(
      `/paperfeed/papers/${paper.id}/translate`,
      {},
      { silent: true },
    )
      .then((r) => {
        if (!alive) return
        if (r?.ok) {
          setZh({ title_zh: r.title_zh || '', abstract_zh: r.abstract_zh || '' })
        } else {
          setTransErr(r?.error || '翻译失败')
        }
      })
      .catch((e) => alive && setTransErr(e?.message || '翻译失败'))
      .finally(() => alive && setTranslating(false))
    return () => {
      alive = false
    }
  }, [paper, lang, zh])

  const needZh = lang === 'zh' || lang === 'both'
  const titleZh = zh?.title_zh || ''
  const absZh = zh?.abstract_zh || ''
  // 图一律走后端代理端点（arXiv 正文图下载 / PDF 首页渲染都在此完成，浏览器不直连 arXiv）
  const figureUrl = paper ? figSrc(paper) : ''

  return (
    <Modal open={!!paper} onClose={onClose} title="论文详情" width="max-w-3xl">
      {paper && (
        <div className="flex flex-col gap-4">
          {/* 头部：id / 学科 / 时间 + 语言切换 */}
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {paper.arxiv_id && (
              <a
                href={paper.link || `https://arxiv.org/abs/${paper.arxiv_id}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono font-medium text-[color:var(--wb-accent)] hover:underline"
              >
                arXiv:{paper.arxiv_id}
              </a>
            )}
            {(paper.cats || '')
              .split(' ')
              .filter(Boolean)
              .slice(0, 4)
              .map((c) => (
                <span key={c} className="font-mono text-[color:var(--wb-muted)]">
                  {c}
                </span>
              ))}
            <span className="text-[color:var(--wb-muted)]">
              {relativeTime(paper.published || paper.created_at)}
            </span>
            <div className="ml-auto">
              <Segmented
                value={lang}
                onChange={(v) => setLang(v as Lang)}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'zh', label: '中文' },
                  { value: 'both', label: '双语' },
                ]}
              />
            </div>
          </div>

          {/* 大图（paperdance 式：详情必须带论文封面图） */}
          {imgLoading && figureUrl && (
            <div className="flex items-center gap-2 rounded-[12px] bg-[color:var(--wb-surface-alt)] px-3 py-3 text-[12px] text-[color:var(--wb-muted)]">
              <Spinner /> 正在加载论文封面…
            </div>
          )}
          {figureUrl && (
            <div className="overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-white p-2">
              <img
                src={figureUrl}
                alt=""
                className="mx-auto max-h-[360px] w-auto max-w-full object-contain"
                onLoad={() => setImgLoading(false)}
                onError={(e) => {
                  setImgLoading(false)
                  ;(e.target as HTMLImageElement).parentElement!.style.display = 'none'
                }}
              />
            </div>
          )}

          {/* 标题 */}
          <div>
            {needZh && titleZh && (
              <div className="text-[20px] font-semibold leading-snug text-[color:var(--wb-text)]">
                {titleZh}
              </div>
            )}
            {lang !== 'zh' && (
              <div
                className={`font-serif leading-snug text-[color:var(--wb-text-soft)] ${
                  needZh && titleZh ? 'mt-1 text-[15px]' : 'text-[20px] font-semibold'
                }`}
              >
                {paper.title}
              </div>
            )}
            {(paper.authors || '').split(',')[0]?.trim() && (
              <div className="mt-1.5 text-[12px] text-[color:var(--wb-muted)]">
                一作 {(paper.authors || '').split(',')[0]?.trim()}
                {(paper.authors || '').split(',').length > 1 ? ' 等' : ''}
              </div>
            )}
          </div>

          {/* 翻译状态 */}
          {needZh && translating && (
            <div className="flex items-center gap-2 rounded-[10px] bg-[color:var(--wb-surface-alt)] px-3 py-2 text-[12px] text-[color:var(--wb-muted)]">
              <Spinner /> 正在用快模型翻译标题与摘要…
            </div>
          )}
          {needZh && !translating && transErr && (
            <div className="rounded-[10px] bg-[color:var(--wb-warn-soft)] px-3 py-2 text-[12px] text-[color:var(--wb-warn)]">
              中文翻译暂不可用：{transErr}（可检查「设置 → 模型供应商」后重试）
            </div>
          )}

          {/* 摘要 */}
          {needZh && absZh && (
            <div className="rounded-[12px] bg-[color:var(--wb-surface-alt)] px-4 py-3 text-[13px] leading-relaxed text-[color:var(--wb-text-soft)]">
              {absZh}
            </div>
          )}
          {lang !== 'zh' && paper.abstract && (
            <div
              className={`rounded-[12px] px-4 py-3 text-[13px] leading-relaxed text-[color:var(--wb-text-soft)] ${
                needZh ? 'border border-[color:var(--wb-border)] text-[color:var(--wb-muted)]' : 'bg-[color:var(--wb-surface-alt)]'
              }`}
            >
              {paper.abstract}
            </div>
          )}

          <div className="flex items-center gap-2">
            {paper.link && (
              <a href={paper.link} target="_blank" rel="noreferrer">
                <Btn size="sm">
                  在 arXiv 打开
                  <Icon name="arrowRight" size={13} className="-rotate-45" />
                </Btn>
              </a>
            )}
            <Btn size="sm" variant="ghost" onClick={onClose}>
              关闭
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}
