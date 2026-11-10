/**
 * 论文速递单张卡片（对标 paperdance 的短视频式卡片）：
 * 顶部 arXiv id + 学科 + 相对时间，衬线大标题，一作，摘要块（可展开），
 * 正文首图（只用论文自己的配图，绝不渲染 PDF 首页截图）。
 * 标题 / 摘要中文-英文双语，缺中文时懒翻译一次（缓存进库 + 跨卸载复用）。
 */
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { post } from '../../lib/api'
import { relativeTime, figSrc, type Lang, type Paper } from './types'

// 跨组件卸载保留已翻译结果，避免重复调用 LLM / 重挂后丢失
const _zhCache = new Map<number, { title_zh: string; abstract_zh: string }>()

export function FeedCard({
  paper,
  onOpen,
  lang = 'both',
}: {
  paper: Paper
  /** 点标题进详情（大图 + 语言切换） */
  onOpen?: (p: Paper) => void
  /** 内容语言：en 英文 / zh 中文 / both 双语（默认双语） */
  lang?: Lang
}) {
  const [expanded, setExpanded] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [zh, setZh] = useState<{ title_zh: string; abstract_zh: string } | null>(() =>
    _zhCache.get(paper.id) ||
    (paper.title_zh || paper.abstract_zh
      ? { title_zh: paper.title_zh || '', abstract_zh: paper.abstract_zh || '' }
      : null),
  )

  const firstAuthor = (paper.authors || '').split(',')[0]?.trim() || ''
  const abstract = paper.abstract || ''
  const long = abstract.length > 320
  const cats = (paper.cats || '').split(' ').filter(Boolean).slice(0, 4)

  const needZh = lang === 'zh' || lang === 'both'
  const titleZh = zh?.title_zh || ''
  const absZh = zh?.abstract_zh || ''

  // 缺中文时懒翻译一次（缓存进库 + 本地 map，避免重复调用）
  useEffect(() => {
    if (!needZh || (zh?.title_zh || zh?.abstract_zh)) return
    let alive = true
    setTranslating(true)
    post<{ ok: boolean; title_zh?: string; abstract_zh?: string; error?: string }>(
      `/paperfeed/papers/${paper.id}/translate`,
      {},
      { silent: true },
    )
      .then((r) => {
        if (!alive) return
        if (r?.ok && (r.title_zh || r.abstract_zh)) {
          const next = { title_zh: r.title_zh || '', abstract_zh: r.abstract_zh || '' }
          _zhCache.set(paper.id, next)
          setZh(next)
        }
      })
      .catch(() => {})
      .finally(() => alive && setTranslating(false))
    return () => {
      alive = false
    }
  }, [paper.id, needZh, zh])

  return (
    <div
      className="flex max-h-[calc(100vh-140px)] w-[min(640px,92vw)] flex-col overflow-hidden rounded-[18px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]"
      data-paper-id={paper.id}
    >
      {/* 头部：arXiv id / 学科 / 时间 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] px-5 pb-2.5 pt-3.5 text-[12px]">
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
        {cats.map((c) => (
          <span key={c} className="font-mono text-[color:var(--wb-muted)]">
            {c}
          </span>
        ))}
        <span className="ml-auto shrink-0 text-[color:var(--wb-muted)]">
          {relativeTime(paper.published || paper.created_at)}
        </span>
      </div>

      {/* 正文：标题 / 一作 / 图 / 摘要 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-4">
        <button
          type="button"
          onClick={() => onOpen?.(paper)}
          className="block cursor-pointer text-left"
        >
          {needZh && titleZh && (
            <span className="block font-serif text-[20px] font-semibold leading-snug text-[color:var(--wb-text)]">
              {titleZh}
            </span>
          )}
          {lang !== 'zh' && (
            <span
              className={`block font-serif leading-snug text-[color:var(--wb-text-soft)] ${
                needZh && titleZh ? 'mt-1 text-[15px]' : 'text-[23px] font-semibold'
              }`}
            >
              {paper.title}
            </span>
          )}
        </button>
        {firstAuthor && (
          <div className="mt-1.5 text-[12.5px] text-[color:var(--wb-muted)]">
            一作 {firstAuthor}
            {(paper.authors || '').split(',').length > 1 && ' 等'}
          </div>
        )}
        {paper.figure_url ? (
          <div className="mt-3 overflow-hidden rounded-[10px] border border-[color:var(--wb-border)] bg-white">
            <img
              src={figSrc(paper)}
              alt=""
              className="mx-auto max-h-[240px] w-auto max-w-full object-contain"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          </div>
        ) : (
          // 无论文自有配图：以纸感文档占位块填满，绝不渲染 PDF 截图
          <div className="mt-3 overflow-hidden rounded-[10px] border border-[color:var(--wb-border)] bg-white">
            <div className="relative flex h-[200px] w-full items-center justify-center bg-[color:var(--wb-surface-alt)]">
              <svg
                className="absolute inset-0 h-full w-full"
                viewBox="0 0 400 200"
                preserveAspectRatio="xMidYMid slice"
                aria-hidden
              >
                <rect x="262" y="24" width="110" height="150" rx="8" fill="var(--wb-border)" opacity=".35" />
                {[0, 1, 2, 3, 4].map((i) => (
                  <rect
                    key={i}
                    x="276"
                    y={40 + i * 22}
                    width={i % 2 ? 64 : 82}
                    height="5"
                    rx="2.5"
                    fill="var(--wb-text)"
                    opacity=".14"
                  />
                ))}
                <circle cx="54" cy="150" r="28" fill="var(--wb-accent)" opacity=".1" />
                <rect x="20" y="22" width="84" height="5" rx="2.5" fill="var(--wb-accent)" opacity=".22" />
              </svg>
              <div className="relative z-10 flex flex-col items-center gap-1.5">
                <Icon name="file" size={30} className="text-[color:var(--wb-muted)]" />
                {paper.arxiv_id && (
                  <span className="font-mono text-[11.5px] text-[color:var(--wb-muted)]">
                    arXiv:{paper.arxiv_id}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
        {/* 中文摘要 */}
        {needZh && absZh && (
          <div
            className={`mt-3 rounded-[12px] bg-[color:var(--wb-surface-alt)] px-4 py-3 text-[13px] leading-relaxed text-[color:var(--wb-text-soft)] ${
              long && !expanded ? 'max-h-[190px] overflow-hidden' : ''
            }`}
          >
            {absZh}
          </div>
        )}
        {/* 英文摘要 */}
        {lang !== 'zh' && abstract && (
          <div
            className={`mt-3 rounded-[12px] px-4 py-3 text-[13px] leading-relaxed text-[color:var(--wb-text-soft)] ${
              needZh && absZh ? 'border border-[color:var(--wb-border)] text-[color:var(--wb-muted)]' : 'bg-[color:var(--wb-surface-alt)]'
            } ${long && !expanded ? 'max-h-[190px] overflow-hidden' : ''}`}
          >
            {abstract}
          </div>
        )}
        {translating && (
          <div className="mt-2 text-[11.5px] text-[color:var(--wb-muted)]">正在翻译标题与摘要…</div>
        )}
      </div>

      {/* 底部：展开摘要 / arXiv 原文 */}
      <div className="flex shrink-0 items-center gap-3 border-t border-[color:var(--wb-border)] px-5 py-2.5 text-[12px] text-[color:var(--wb-muted)]">
        {long && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="font-medium text-[color:var(--wb-text-soft)] hover:text-[color:var(--wb-text)]"
          >
            {expanded ? '收起摘要' : '展开摘要'}
          </button>
        )}
        {paper.link && (
          <a
            href={paper.link}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 hover:text-[color:var(--wb-text)]"
          >
            arXiv
            <Icon name="arrowRight" size={12} className="-rotate-45" />
          </a>
        )}
      </div>
    </div>
  )
}
