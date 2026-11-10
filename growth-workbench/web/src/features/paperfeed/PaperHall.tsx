/**
 * 论文大厅（对标 B 站首页 / paperdance 大厅）：分类胶囊行 + 首页大卡 + 论文卡片墙。
 * 每张卡都带论文正文图（figure_url）；没抓到图的用生成式纸感封面兜底，绝不留白。
 * 点卡片进详情弹窗（大图 + 中/英/双语）。
 */
import { useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { relativeTime, figSrc, type Paper } from './types'

type Palette = { bg: string; ink: string; accent: string; soft: string }

/** 与全站纸感一致的封面调色板（按 id 哈希取色，缺图时兜底） */
const PALETTES: Palette[] = [
  { bg: '#f1effb', ink: '#27224f', accent: '#5145e0', soft: '#dcd6f7' },
  { bg: '#eef2f3', ink: '#20363e', accent: '#2f5d50', soft: '#cfded7' },
  { bg: '#faf0e9', ink: '#492b1e', accent: '#a4552c', soft: '#f0d6c3' },
  { bg: '#eaf1f6', ink: '#1c3648', accent: '#14618f', soft: '#cadce9' },
  { bg: '#f6f1e7', ink: '#3b3020', accent: '#9a7226', soft: '#e8d9b8' },
  { bg: '#eceef4', ink: '#22283d', accent: '#4a56a8', soft: '#d3d8ec' },
  { bg: '#f1eef6', ink: '#332450', accent: '#6b4ba8', soft: '#ddd2ef' },
  { bg: '#eaf3f0', ink: '#1e3c35', accent: '#2f7565', soft: '#cbe2da' },
]

function hashStyle(p: Paper): Palette {
  const s = p.arxiv_id || String(p.id) + p.title
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return PALETTES[Math.abs(h) % PALETTES.length]
}

/** 卡片封面：正文图优先，抓不到图退回生成的纸感图卡 */
function HallCover({ paper, tall = false }: { paper: Paper; tall?: boolean }) {
  const p = hashStyle(paper)
  const [failed, setFailed] = useState(false)
  const hasFig = !!paper.figure_url
  const showImg = hasFig && !failed
  return (
    <div className="relative w-full overflow-hidden bg-white" style={{ height: tall ? 320 : 150 }}>
      {showImg ? (
        <img
          src={figSrc(paper)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="relative h-full w-full" style={{ background: p.bg }}>
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 400 160"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden
          >
            <rect x="268" y="18" width="104" height="126" rx="8" fill={p.soft} opacity=".55" />
            {[0, 1, 2, 3, 4].map((i) => (
              <rect
                key={i}
                x="282"
                y={34 + i * 21}
                width={i % 2 ? 58 : 76}
                height="5"
                rx="2.5"
                fill={p.accent}
                opacity=".22"
              />
            ))}
            <circle cx="56" cy="126" r="26" fill={p.accent} opacity=".1" />
            <rect x="22" y="22" width="80" height="4.5" rx="2.25" fill={p.accent} opacity=".3" />
          </svg>
          <div className="absolute bottom-2 left-3 right-3 line-clamp-2 text-[11px] font-medium leading-snug" style={{ color: p.ink }}>
            {paper.title}
          </div>
          <div className="absolute left-3 top-2 font-mono text-[9px] font-semibold uppercase tracking-wider" style={{ color: p.accent }}>
            {paper.primary_cat || 'arXiv'}
          </div>
        </div>
      )}
    </div>
  )
}

function CardMeta({ paper }: { paper: Paper }) {
  const first = (paper.authors || '').split(',')[0]?.trim() || ''
  return (
    <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-2 text-[11px] text-[color:var(--wb-muted)]">
      <span className="truncate">{first}{(paper.authors || '').split(',').length > 1 ? ' 等' : ''}</span>
      <span className="ml-auto shrink-0">{relativeTime(paper.published || paper.created_at)}</span>
    </div>
  )
}

export default function PaperHall({
  papers,
  onOpen,
}: {
  papers: Paper[]
  onOpen: (p: Paper) => void
}) {
  const cats = useMemo(() => {
    const set: string[] = []
    for (const p of papers) {
      const c = p.primary_cat || ''
      if (c && !set.includes(c)) set.push(c)
    }
    return set.slice(0, 12)
  }, [papers])
  const [cat, setCat] = useState('')

  const list = useMemo(
    () => (cat ? papers.filter((p) => (p.primary_cat || '') === cat) : papers),
    [papers, cat],
  )
  const [featured, ...rest] = list

  if (!papers.length) return null

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {/* 分类胶囊行 */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCat('')}
          className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
            !cat
              ? 'bg-[color:var(--wb-accent)] font-medium text-white'
              : 'bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-surface-alt)]'
          }`}
        >
          全部
        </button>
        {cats.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCat(c === cat ? '' : c)}
            className={`rounded-full px-3 py-1 font-mono text-[12px] transition-colors ${
              c === cat
                ? 'bg-[color:var(--wb-accent)] font-medium text-white'
                : 'bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-surface-alt)]'
            }`}
          >
            {c}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-[color:var(--wb-muted)]">{list.length} 篇</span>
      </div>

      {!featured ? null : (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        >
          {/* 首页大卡：占 2×2 */}
          <div
            className="col-span-2 row-span-2 cursor-pointer overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow)] transition-shadow hover:shadow-[var(--wb-shadow-lg)]"
            onClick={() => onOpen(featured)}
          >
            <HallCover paper={featured} tall />
            <div className="px-4 pb-2 pt-2.5">
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                {featured.arxiv_id && (
                  <span className="font-mono font-medium text-[color:var(--wb-accent)]">
                    arXiv:{featured.arxiv_id}
                  </span>
                )}
                <span className="text-[color:var(--wb-muted)]">
                  {relativeTime(featured.published || featured.created_at)}
                </span>
              </div>
              <div className="line-clamp-2 font-serif text-[17px] font-semibold leading-snug text-[color:var(--wb-text)]">
                {featured.title}
              </div>
              {featured.title_zh && (
                <div className="mt-0.5 line-clamp-1 text-[13px] leading-snug text-[color:var(--wb-text-soft)]">
                  {featured.title_zh}
                </div>
              )}
              {featured.abstract && (
                <div className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-[color:var(--wb-muted)]">
                  {featured.abstract}
                </div>
              )}
            </div>
            <CardMeta paper={featured} />
          </div>

          {/* 其余卡片墙 */}
          {rest.slice(0, 47).map((p) => (
            <div
              key={p.id}
              className="cursor-pointer overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow)] transition-shadow hover:shadow-[var(--wb-shadow-lg)]"
              onClick={() => onOpen(p)}
            >
              <HallCover paper={p} />
              <div className="px-3 pb-1 pt-2">
                <div className="line-clamp-2 text-[13px] font-medium leading-snug text-[color:var(--wb-text)]">
                  {p.title}
                </div>
                {p.title_zh && (
                  <div className="mt-0.5 line-clamp-1 text-[11.5px] leading-snug text-[color:var(--wb-text-soft)]">
                    {p.title_zh}
                  </div>
                )}
              </div>
              <CardMeta paper={p} />
            </div>
          ))}
        </div>
      )}

      {rest.length === 0 && (
        <div className="flex items-center justify-center gap-1.5 py-10 text-[12px] text-[color:var(--wb-muted)]">
          <Icon name="inbox" size={13} />
          这个分类下暂时只有一篇论文
        </div>
      )}
    </div>
  )
}
