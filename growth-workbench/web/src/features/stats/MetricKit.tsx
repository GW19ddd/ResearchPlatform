/**
 * 概览指标的视觉原语：环形进度、横向条组、指标小格、右侧提要。
 *
 * 只从 features/stats/OverviewSummary.tsx 用，所以不进 components/ui.tsx（那是全站共享层）。
 * 所有颜色走 index.css 的 --wb-* 令牌；这里没有裸调色板。
 */
import { ReactNode } from 'react'

export type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'default'

const TONE_VAR: Record<Tone, string> = {
  accent: 'var(--wb-accent)',
  ok: 'var(--wb-ok)',
  warn: 'var(--wb-warn)',
  danger: 'var(--wb-danger)',
  default: 'var(--wb-border-strong)',
}

const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-[color:var(--wb-accent)]',
  ok: 'text-[color:var(--wb-ok)]',
  warn: 'text-[color:var(--wb-warn)]',
  danger: 'text-[color:var(--wb-danger)]',
  default: 'text-[color:var(--wb-text)]',
}

const TONE_SOFT: Record<Tone, string> = {
  accent: 'var(--wb-accent-soft)',
  ok: 'var(--wb-ok-soft)',
  warn: 'var(--wb-warn-soft)',
  danger: 'var(--wb-danger-soft)',
  default: 'var(--wb-bg-subtle)',
}

export const toneText = (t: Tone) => TONE_TEXT[t]

// ---------------------------------------------------------------- Donut

/**
 * 环形进度：r=28 的 2.4px 描边环，中间叠大数字 + 单位。
 * 用 strokeDasharray 而不是 conic-gradient —— 环的端点是圆的，切口干净。
 */
export function Donut({
  value,
  max = 100,
  tone = 'accent',
  unit = '%',
  caption,
  size = 84,
}: {
  value: number
  max?: number
  tone?: Tone
  unit?: string
  caption?: ReactNode
  size?: number
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  const r = 28
  const c = 2 * Math.PI * r
  return (
    <div className="flex flex-col items-center gap-1" style={{ width: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
          <circle cx="32" cy="32" r={r} fill="none" stroke="var(--wb-bg-subtle)" strokeWidth="5" />
          <circle
            cx="32"
            cy="32"
            r={r}
            fill="none"
            stroke={TONE_VAR[tone]}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${pct * c} ${c}`}
            transform="rotate(-90 32 32)"
            style={{ transition: 'stroke-dasharray .6s var(--wb-ease)' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
          <span className={`text-[19px] font-semibold tabular-nums tracking-[-0.03em] ${TONE_TEXT[tone]}`}>
            {Math.round(pct * 100)}
          </span>
          <span className="mt-0.5 text-[9.5px] text-[color:var(--wb-muted)]">{unit}</span>
        </div>
      </div>
      {caption && (
        <span className="text-center text-[10.5px] leading-tight text-[color:var(--wb-muted)]">{caption}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- MiniStat

/**
 * 无上限数字的环形：fraction ∈ [0,1] 只决定环画到几分之几，中心永远显示原始数值。
 * 积分余额没有满分概念，用它比套一个假 max 更诚实。
 */
export function MiniStat({
  value,
  tone = 'accent',
  caption,
  sub,
  fraction,
  size = 76,
}: {
  value: ReactNode
  tone?: Tone
  caption?: ReactNode
  sub?: ReactNode
  fraction: number
  size?: number
}) {
  const f = Math.max(0, Math.min(1, fraction))
  const r = 28
  const c = 2 * Math.PI * r
  return (
    <div className="flex flex-col items-center gap-1" style={{ width: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
          <circle cx="32" cy="32" r={r} fill="none" stroke="var(--wb-bg-subtle)" strokeWidth="5" />
          <circle
            cx="32"
            cy="32"
            r={r}
            fill="none"
            stroke={TONE_VAR[tone]}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${f * c} ${c}`}
            transform="rotate(-90 32 32)"
            style={{ transition: 'stroke-dasharray .6s var(--wb-ease)' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
          <span className={`text-[19px] font-semibold tabular-nums tracking-[-0.03em] ${TONE_TEXT[tone]}`}>{value}</span>
          {sub && <span className={`mt-0.5 text-[9.5px] tabular-nums ${TONE_TEXT[tone]}`}>{sub}</span>}
        </div>
      </div>
      {caption && (
        <span className="text-center text-[10.5px] leading-tight text-[color:var(--wb-muted)]">{caption}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Bars

/**
 * 横向条组：每一行 = 标签 + 条 + 数值。
 * 条长按组内最大值归一，最大那条自然占满，不会被奇怪的绝对量级带跑。
 * 数值统一右对齐停在轨道右侧，字号小、字重轻，不与条抢视线。
 */
export function BarSet({
  rows,
  unit,
}: {
  rows: { label: string; value: number; tone?: Tone }[]
  unit?: string
}) {
  const hi = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="flex flex-col gap-[7px]">
      {rows.map((r) => {
        const pct = Math.min(100, (r.value / hi) * 100)
        return (
          <div key={r.label} className="flex items-center gap-2.5">
            <span className="w-[68px] shrink-0 truncate text-[11px] text-[color:var(--wb-text-soft)]" title={r.label}>
              {r.label}
            </span>
            <span className="h-[6px] min-w-0 flex-1 overflow-hidden rounded-full bg-[color:var(--wb-bg-subtle)]">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${pct}%`,
                  background: TONE_VAR[r.tone || 'accent'],
                  transition: 'width .5s var(--wb-ease)',
                }}
              />
            </span>
            <span className="w-[38px] shrink-0 text-right text-[11.5px] font-medium tabular-nums text-[color:var(--wb-text)]">
              {r.value}
              {unit && <span className="ml-0.5 text-[9.5px] font-normal text-[color:var(--wb-muted)]">{unit}</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- Piece

/** 指标小格：数字 + 说明，卡片里 2×2 / 2×3 拼装用；没有独立边框，靠留白分隔 */
export function Piece({
  label,
  value,
  unit,
  hint,
  tone = 'default',
  wide,
}: {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  hint?: ReactNode
  tone?: Tone
  wide?: boolean
}) {
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <div className="truncate text-[11px] text-[color:var(--wb-muted)]">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={`text-[17px] font-semibold leading-tight tabular-nums tracking-[-0.02em] ${TONE_TEXT[tone]}`}>
          {value}
        </span>
        {unit && <span className="text-[11px] text-[color:var(--wb-muted)]">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 truncate text-[10.5px] text-[color:var(--wb-muted)]">{hint}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Aside

/** 右侧提要：小标签 + 一句重点，竖排时靠 left 细线分隔 */
export function Aside({
  label,
  children,
  tone = 'default',
}: {
  label: ReactNode
  children: ReactNode
  tone?: Tone
}) {
  return (
    <div className="min-w-0 border-l border-[color:var(--wb-border)] pl-3">
      <div className="truncate text-[10.5px] text-[color:var(--wb-muted)]">{label}</div>
      <div className={`mt-0.5 truncate text-[12px] font-medium ${TONE_TEXT[tone]}`}>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------- Block

/** 卡片外壳：标题 + 副标 + 内容；统一圆角、细边、极浅阴影，避免和内部元素各说各话 */
export function Block({
  title,
  meta,
  extra,
  children,
  className = '',
}: {
  title: ReactNode
  meta?: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-3.5 shadow-[var(--wb-shadow-xs)] ${className}`}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[12.5px] font-semibold text-[color:var(--wb-text)]">{title}</h2>
          {meta && <div className="mt-0.5 truncate text-[10.5px] text-[color:var(--wb-muted)]">{meta}</div>}
        </div>
        {extra && <div className="shrink-0">{extra}</div>}
      </header>
      {children}
    </section>
  )
}

/** 图例小点：图例、色块统一用它，尺寸只此一档 */
export function Swatch({ tone, label }: { tone: Tone; label?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10.5px] text-[color:var(--wb-muted)]">
      <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: TONE_VAR[tone] }} aria-hidden />
      {label}
    </span>
  )
}

/** 胶囊小标签：阶段名、状态词用；底色取语义 soft 令牌 */
export function Chip({ tone = 'default', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex max-w-full items-center truncate rounded-full px-2 py-[2px] text-[10.5px] font-medium ${TONE_TEXT[tone]}`}
      style={{ background: TONE_SOFT[tone] }}
    >
      {children}
    </span>
  )
}
