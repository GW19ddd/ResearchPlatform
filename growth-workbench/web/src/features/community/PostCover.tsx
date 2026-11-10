import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { kindLabel } from './types'

/**
 * 帖子封面：布局对齐参考图的「大图封面」。
 *
 * 不依赖外链图片：按 cover_style 用 SVG 生成一张纸感图卡（底纹 + 主题字 + 分类角标），
 * 离线可用、导出时不会裂图。用户填了 cover_url 就优先用图，加载失败自动退回生成封面。
 */
type Palette = { bg: string; ink: string; accent: string; soft: string }

const PALETTES: Record<string, Palette> = {
  paper: { bg: '#f1effb', ink: '#27224f', accent: '#5145e0', soft: '#dcd6f7' },
  grid: { bg: '#eef2f3', ink: '#20363e', accent: '#2f5d50', soft: '#cfded7' },
  chart: { bg: '#faf0e9', ink: '#492b1e', accent: '#a4552c', soft: '#f0d6c3' },
  nodes: { bg: '#eaf1f6', ink: '#1c3648', accent: '#14618f', soft: '#cadce9' },
  quote: { bg: '#f6f1e7', ink: '#3b3020', accent: '#9a7226', soft: '#e8d9b8' },
  code: { bg: '#eceef4', ink: '#22283d', accent: '#4a56a8', soft: '#d3d8ec' },
  formula: { bg: '#f1eef6', ink: '#332450', accent: '#6b4ba8', soft: '#ddd2ef' },
  wave: { bg: '#eaf3f0', ink: '#1e3c35', accent: '#2f7565', soft: '#cbe2da' },
}

export function coverPalette(style?: string): Palette {
  return PALETTES[style || 'paper'] || PALETTES.paper
}

/** 每种风格一套几何纹样，全部画在文字下层 */
function Motif({ style, p }: { style: string; p: Palette }) {
  const a = p.accent
  const s = p.soft
  switch (style) {
    case 'grid':
      return (
        <>
          {Array.from({ length: 9 }, (_, i) => (
            <rect key={i} x={214 + (i % 3) * 48} y={26 + Math.floor(i / 3) * 48} width="34" height="34" rx="6" fill={a} opacity={0.09 + (i % 3) * 0.05} />
          ))}
          <circle cx="330" cy="200" r="52" fill={s} opacity=".55" />
          <path d="M20 216h150" stroke={a} strokeWidth="2" opacity=".18" />
        </>
      )
    case 'chart':
      return (
        <>
          <rect x="238" y="42" width="132" height="168" rx="10" fill={s} opacity=".5" />
          {[54, 84, 66, 112, 92].map((h, i) => (
            <rect key={i} x={252 + i * 23} y={196 - h} width="14" height={h} rx="3" fill={a} opacity={0.2 + i * 0.09} />
          ))}
          <path d="M20 208h170" stroke={a} strokeWidth="2" opacity=".22" />
        </>
      )
    case 'nodes':
      return (
        <>
          <g stroke={a} strokeWidth="2" opacity=".28" fill="none">
            <path d="M262 66l78 28-16 86-84 24-30-78z" />
            <path d="M262 66l-52 60M340 94l-100 110M324 180l-84 24" />
          </g>
          {[[262, 66], [340, 94], [324, 180], [240, 204], [210, 126]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={i % 2 ? 8 : 11} fill={a} opacity=".3" />
          ))}
        </>
      )
    case 'quote':
      return (
        <>
          <circle cx="322" cy="128" r="82" fill={s} opacity=".55" />
          <text x="286" y="182" fontSize="150" fontFamily="Georgia, serif" fill={a} opacity=".3">“</text>
          <path d="M22 214h150" stroke={a} strokeWidth="2" opacity=".2" />
        </>
      )
    case 'code':
      return (
        <>
          <rect x="228" y="34" width="146" height="182" rx="10" fill="#2b3048" opacity=".88" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <g key={i}>
              <rect x="244" y={54 + i * 25} width="12" height="6" rx="3" fill={a} opacity=".7" />
              <rect x="264" y={54 + i * 25} width={58 + (i % 3) * 22} height="6" rx="3" fill="#ffffff" opacity={0.28 + (i % 2) * 0.16} />
            </g>
          ))}
        </>
      )
    case 'formula':
      return (
        <>
          <circle cx="320" cy="112" r="74" fill={s} opacity=".6" />
          <text x="276" y="152" fontSize="96" fontFamily="Georgia, serif" fill={a} opacity=".34">∑</text>
          {[0, 1, 2].map((i) => (
            <rect key={i} x="246" y={172 + i * 16} width={110 - i * 22} height="4" rx="2" fill={a} opacity=".2" />
          ))}
        </>
      )
    case 'wave':
      return (
        <>
          {[0, 1, 2].map((i) => (
            <path
              key={i}
              d={`M0 ${150 + i * 30} C 90 ${96 + i * 30}, 150 ${210 + i * 24}, 240 ${148 + i * 28} S 350 ${92 + i * 30}, 400 ${140 + i * 26}`}
              stroke={a}
              strokeWidth="3"
              fill="none"
              opacity={0.12 + i * 0.07}
            />
          ))}
          <circle cx="332" cy="66" r="30" fill={s} opacity=".65" />
        </>
      )
    default: // paper
      return (
        <>
          <rect x="248" y="30" width="126" height="190" rx="9" fill={s} opacity=".58" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x="266" y={52 + i * 27} width={i % 2 ? 68 : 90} height="6" rx="3" fill={a} opacity=".2" />
          ))}
          <circle cx="60" cy="212" r="30" fill={a} opacity=".1" />
          <rect x="24" y="30" width="96" height="5" rx="2.5" fill={a} opacity=".3" />
        </>
      )
  }
}

export default function PostCover({
  title,
  headline,
  category,
  kind,
  style,
  url,
  pinned = false,
  compact = false,
}: {
  title: string
  /** 封面的大字。传摘要时，卡片下方的标题就不会和封面重复 */
  headline?: string
  category: string
  kind?: string
  style?: string
  url?: string
  /** 置顶帖只在角标行加一行文字，不做彩色标签 */
  pinned?: boolean
  /** 详情里的大封面：字号放大一档 */
  compact?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const p = coverPalette(style)
  const showImage = !!url && !failed

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: p.bg }}>
      {showImage ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <>
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 400 250"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden
          >
            <Motif style={style || 'paper'} p={p} />
          </svg>
          <div className="relative flex h-full flex-col justify-between p-[14px]">
            <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: p.accent }}>
              <span className="inline-block h-[6px] w-[6px] rounded-full" style={{ background: p.accent }} />
              {category}
              <span className="opacity-50">· {kindLabel(kind)}</span>
              {pinned && (
                <span className="ml-1 inline-flex items-center gap-0.5 font-semibold">
                  <Icon name="arrowUp" size={10} />
                  置顶
                </span>
              )}
            </div>
            <div
              className={`line-clamp-3 max-w-[70%] font-semibold leading-[1.38] ${compact ? 'text-[19px]' : 'text-[15px]'}`}
              style={{ color: p.ink, textShadow: '0 1px 0 rgba(255,255,255,0.55)' }}
            >
              {headline || title}
            </div>
            <div className="text-[9px] font-medium tracking-[0.18em]" style={{ color: p.accent, opacity: 0.7 }}>
              RESEARCH COMMUNITY
            </div>
          </div>
        </>
      )}
    </div>
  )
}
