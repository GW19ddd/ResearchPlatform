import {
  FocusEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon, IconName } from './Icon'

/* ============================================================
   设计系统层：所有页面共用的视觉原语。

   约定：
   - 这里的组件只管「长什么样」，不碰任何业务数据；业务逻辑留在 features/*
   - 对外 API 保持向后兼容，新增能力一律走可选 props，避免改一处动全身
   ============================================================ */

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`wb-spinner inline-block ${className}`} aria-hidden />
}

/**
 * 受控浮层的「延迟卸载」：open 变 false 后先播退出动画，再真正卸载。
 * 系统开了「减少动态效果」就别让人干等，直接把 dur 压到 0。
 * Modal / Drawer / 头像菜单共用，避免「啪」地一下消失。
 */
export function usePresence(open: boolean, ms = 180) {
  const [mounted, setMounted] = useState(open)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const dur = reduce ? 0 : ms
    if (open) {
      setMounted(true)
      setLeaving(false)
      return
    }
    if (!mounted) return
    setLeaving(true)
    const t = window.setTimeout(() => {
      setMounted(false)
      setLeaving(false)
    }, dur)
    return () => window.clearTimeout(t)
  }, [open, mounted, ms])
  return { mounted, leaving }
}

// ---------------------------------------------------------------- Card

export function Card({
  title,
  extra,
  children,
  className = '',
  footer,
  bodyClassName = '',
  tourId,
  onClick,
}: {
  title?: ReactNode
  extra?: ReactNode
  children?: ReactNode
  className?: string
  footer?: ReactNode
  bodyClassName?: string
  /** 引导锚点：渲染成 section[data-tour]，不影响外观 */
  tourId?: string
  /** 传了就把整张卡变成可点：自动补按压反馈与抬起效果（可选，不传时外观不变） */
  onClick?: () => void
}) {
  const hasHead = !!title || !!extra
  return (
    <section
      data-tour={tourId}
      onClick={onClick}
      className={`${onClick ? 'wb-press-soft wb-lift cursor-pointer' : ''} overflow-hidden rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-xs)] ${className}`}
    >
      {hasHead && (
        <header className="flex min-h-[46px] items-center justify-between gap-3 border-b border-[color:var(--wb-border)] px-4 py-2.5">
          {title && (
            <h2 className="min-w-0 text-[13.5px] font-semibold tracking-[-0.01em] text-[color:var(--wb-text)]">
              {title}
            </h2>
          )}
          {extra && <div className="flex shrink-0 items-center gap-1.5">{extra}</div>}
        </header>
      )}
      <div className={`p-[18px] ${bodyClassName}`}>{children}</div>
      {footer && (
        <footer className="border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-2.5">
          {footer}
        </footer>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- Button

export type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'subtle'

export function Btn({
  children,
  onClick,
  variant = 'default',
  disabled,
  loading,
  type = 'button',
  className = '',
  size = 'md',
  title,
  ariaLabel,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: BtnVariant
  disabled?: boolean
  loading?: boolean
  type?: 'button' | 'submit'
  className?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  title?: string
  /** 纯图标按钮必须给可读名称，否则屏幕阅读器只会念出「按钮」 */
  ariaLabel?: string
}) {
  // whitespace-nowrap：中文没有词边界，窄容器里会退化成「一个字一行」
  const base =
    'wb-press inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--wb-radius-sm)] border font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-45'
  const sizes: Record<string, string> = {
    xs: 'px-2 py-[2px] text-[11.5px]',
    sm: 'px-2.5 py-[4px] text-[12px]',
    md: 'px-3.5 py-[7px] text-[12.5px]',
    lg: 'px-4 py-2.5 text-[13.5px]',
  }
  const styles: Record<BtnVariant, string> = {
    /* 主按钮是墨黑实心，hover 反白；不用彩色渐变块、不用发光阴影 */
    primary:
      'border-[color:var(--wb-text)] bg-[color:var(--wb-text)] text-white hover:bg-[color:var(--wb-surface)] hover:text-[color:var(--wb-text)]',
    danger:
      'border-[color:var(--wb-danger)]/25 bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)] hover:border-[color:var(--wb-danger)]/45',
    ghost:
      'border-transparent text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]',
    subtle:
      'border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]',
    default:
      'border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text)] shadow-[var(--wb-shadow-xs)] hover:border-[color:var(--wb-text-soft)]/45 hover:bg-[color:var(--wb-surface-alt)]',
  }
  return (
    <button
      type={type}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled || loading}
      onClick={onClick}
      className={`${base} ${sizes[size]} ${styles[variant]} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- Form

/**
 * 表单控件共用底子。宽度不写在这里：改由调用方挂 `wb-input-w`（:where() 压过特异性），
 * 这样页面传 `w-32 / w-40` 能正常覆盖，不必写 !important。
 */
const CONTROL_BASE =
  'rounded-[var(--wb-radius-sm)] border bg-[color:var(--wb-surface)] text-[13px] text-[color:var(--wb-text)] outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[color:var(--wb-muted)] hover:border-[color:var(--wb-text-soft)]/40 focus:border-[color:var(--wb-accent)] focus:shadow-[var(--wb-ring)] disabled:cursor-not-allowed disabled:bg-[color:var(--wb-bg-subtle)] disabled:text-[color:var(--wb-muted)]'

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  className = '',
  defaultValue,
  onBlur,
  disabled,
}: {
  value?: string | number
  onChange?: (v: string) => void
  placeholder?: string
  type?: string
  className?: string
  defaultValue?: string | number
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  disabled?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={onBlur}
      className={`${CONTROL_BASE} wb-input-w border-[color:var(--wb-border-strong)] px-2.5 py-[6px] ${className}`}
    />
  )
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  onKeyDown,
  className = '',
}: {
  value?: string
  onChange?: (v: string) => void
  placeholder?: string
  rows?: number
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  className?: string
}) {
  return (
    <textarea
      rows={rows}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      onKeyDown={onKeyDown}
      className={`${CONTROL_BASE} wb-input-w resize-y border-[color:var(--wb-border-strong)] px-2.5 py-[6px] leading-relaxed ${className}`}
    />
  )
}

export function Select({
  value,
  onChange,
  options,
  className = '',
}: {
  value?: string
  onChange?: (v: string) => void
  options: { value: string; label: string }[]
  className?: string
}) {
  return (
    <div className={`relative inline-flex ${className}`}>
      <select
        value={value ?? ''}
        onChange={(e) => onChange?.(e.target.value)}
        className={`${CONTROL_BASE} w-auto cursor-pointer appearance-none border-[color:var(--wb-border-strong)] py-[6px] pl-2.5 pr-7 text-[12.5px]`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevronDown"
        size={12}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[color:var(--wb-muted)]"
      />
    </div>
  )
}

/** 标签 + 说明 + 错误提示的统一包裹，省掉每个表单各写一遍排版 */
export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="mb-1 block whitespace-nowrap text-[12px] font-medium text-[color:var(--wb-text-soft)]">
          {label}
        </span>
      )}
      {children}
      {error ? (
        <span role="alert" className="mt-1 flex items-start gap-1 text-[11.5px] text-[color:var(--wb-danger)]">
          <Icon name="alert" size={12} className="mt-[2px]" />
          <span>{error}</span>
        </span>
      ) : hint ? (
        <span className="mt-1 block text-[11.5px] text-[color:var(--wb-muted)]">{hint}</span>
      ) : null}
    </label>
  )
}

// ---------------------------------------------------------------- 展示件

export function Pill({
  children,
  tone = 'gray',
  className = '',
}: {
  children: ReactNode
  tone?: string
  className?: string
}) {
  const tones: Record<string, string> = {
    gray: 'bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-text-soft)]',
    slate: 'bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-text-soft)]',
    blue: 'bg-[color:var(--wb-info-soft)] text-[color:var(--wb-info)]',
    indigo: 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]',
    green: 'bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]',
    amber: 'bg-[color:var(--wb-warn-soft)] text-[color:var(--wb-warn)]',
    red: 'bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--wb-radius-sm)] px-2 py-[1px] text-[11.5px] font-medium leading-[18px] ${
        tones[tone] || tones.gray
      } ${className}`}
    >
      {children}
    </span>
  )
}

export function Dot({ tone = 'gray' }: { tone?: string }) {
  const tones: Record<string, string> = {
    gray: 'bg-[color:var(--wb-muted)]',
    green: 'bg-[color:var(--wb-ok)]',
    amber: 'bg-[color:var(--wb-warn)]',
    red: 'bg-[color:var(--wb-danger)]',
    indigo: 'bg-[color:var(--wb-accent)]',
    blue: 'bg-[color:var(--wb-info)]',
  }
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-[var(--wb-radius-sm)] ${tones[tone] || tones.gray}`}
    />
  )
}

export function Empty({
  text = '暂无数据',
  hint,
  action,
}: {
  text?: string
  hint?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="wb-anim-fade flex flex-col items-center justify-center gap-1.5 rounded-[var(--wb-radius)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-9 text-center">
      {/* 一条短细线作视觉锚点，不用圆形图标徽章 */}
      <span aria-hidden className="mb-1.5 h-px w-8 bg-[color:var(--wb-border-strong)]" />
      <div className="text-[12.5px] font-medium text-[color:var(--wb-text-soft)]">{text}</div>
      {hint && <div className="max-w-[320px] text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{hint}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="wb-anim-fade flex items-center justify-center gap-2 py-8 text-[12px] text-[color:var(--wb-muted)]">
      <Spinner />
      {text}
    </div>
  )
}

/** 顶部指标卡：Dashboard / 概览类页面的统一数字展示 */
export function StatCard({
  label,
  value,
  unit,
  hint,
  tone = 'default',
  onClick,
}: {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  hint?: ReactNode
  tone?: 'default' | 'ok' | 'warn' | 'danger' | 'accent'
  onClick?: () => void
}) {
  const tones: Record<string, string> = {
    default: 'text-[color:var(--wb-text)]',
    ok: 'text-[color:var(--wb-ok)]',
    warn: 'text-[color:var(--wb-warn)]',
    danger: 'text-[color:var(--wb-danger)]',
    accent: 'text-[color:var(--wb-accent)]',
  }
  /** 期刊统计栏：一根顶线 + 小号栏名 + 衬线数字，不是四张浮起来的卡片 */
  return (
    <div
      onClick={onClick}
      className={`border-t border-[color:var(--wb-border-strong)] pt-3 ${
        onClick ? 'wb-press-soft cursor-pointer hover:bg-[color:var(--wb-surface-alt)]' : ''
      }`}
    >
      <div className="text-[11px] font-medium tracking-[0.06em] text-[color:var(--wb-muted)]">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className={`wb-serif text-[28px] leading-none tabular-nums ${tones[tone]}`}>
          {value}
        </span>
        {unit && <span className="text-[11.5px] text-[color:var(--wb-muted)]">{unit}</span>}
      </div>
      {hint && <div className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{hint}</div>}
    </div>
  )
}

export function Progress({
  value,
  max = 100,
  tone = 'accent',
  showLabel,
}: {
  value: number
  max?: number
  tone?: 'accent' | 'ok' | 'warn' | 'danger'
  showLabel?: boolean
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (Number(value) / max) * 100)) : 0
  const tones: Record<string, string> = {
    accent: 'bg-[color:var(--wb-accent)]',
    ok: 'bg-[color:var(--wb-ok)]',
    warn: 'bg-[color:var(--wb-warn)]',
    danger: 'bg-[color:var(--wb-danger)]',
  }
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-[var(--wb-radius-sm)] bg-[color:var(--wb-bg-subtle)] shadow-[inset_0_1px_1px_rgba(26, 26, 26,0.05)]">
        <div
          className={`h-full rounded-[var(--wb-radius-sm)] transition-all duration-300 ${tones[tone]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="w-9 shrink-0 text-right text-[11.5px] tabular-nums text-[color:var(--wb-muted)]">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  )
}

/** 分段选择器，替代一排零散的按钮 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className = '',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  className?: string
}) {
  return (
    <div
      className={`inline-flex gap-0.5 rounded-[var(--wb-radius)] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] p-0.5 ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`wb-press-soft rounded-[var(--wb-radius-sm)] px-2.5 py-[4px] text-[12px] transition ${
            value === o.value
              ? 'bg-[color:var(--wb-surface)] font-medium text-[color:var(--wb-text)] shadow-[var(--wb-shadow-xs)]'
              : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-surface)]/60 hover:text-[color:var(--wb-text)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ScoreBar({
  label,
  value,
  max = 5,
}: {
  label: string
  value: number
  max?: number
}) {
  const v = Math.max(0, Math.min(max, Number(value) || 0))
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[11.5px] text-[color:var(--wb-muted)]">{label}</span>
      <div className="flex gap-[3px]">
        {Array.from({ length: max }, (_, i) => i + 1).map((i) => (
          <span
            key={i}
            className={`h-[5px] w-4 rounded-[var(--wb-radius-sm)] transition-colors ${
              i <= v ? 'bg-[color:var(--wb-accent)]' : 'bg-[color:var(--wb-bg-subtle)]'
            }`}
          />
        ))}
      </div>
      <span className="text-[11.5px] tabular-nums text-[color:var(--wb-muted)]">{v}</span>
    </div>
  )
}

// ---------------------------------------------------------------- Markdown

export function MdBlock({ text }: { text: string }) {
  // remark-gfm：表格、任务列表、删除线、自动链接（AI 输出里全是这些）
  return (
    <div className="markdown-block">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {text || ''}
      </ReactMarkdown>
    </div>
  )
}

// ---------------------------------------------------------------- 浮层

function useEscClose(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  useEscClose(open, onClose)
  const presence = usePresence(open, 200)
  if (!presence.mounted) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className={`absolute inset-0 bg-[rgba(26,26,26,0.42)] ${
          presence.leaving ? 'wb-overlay-out' : 'wb-overlay-in'
        }`}
        onClick={onClose}
      />
      <div
        className={`relative w-full ${width} overflow-hidden rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)] ${
          presence.leaving ? 'wb-dialog-out' : 'wb-dialog-in'
        }`}
      >
        {title && (
          <header className="flex min-h-[48px] items-center justify-between border-b border-[color:var(--wb-border)] px-4 py-2.5">
            <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-[color:var(--wb-text)]">
              {title}
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="wb-press-strong flex h-6 w-6 items-center justify-center rounded-[var(--wb-radius-sm)] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
              aria-label="关闭"
            >
              <Icon name="close" size={15} />
            </button>
          </header>
        )}
        <div className="max-h-[70vh] overflow-y-auto p-[18px]">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'w-[520px]',
  footer,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  width?: string
  footer?: ReactNode
}) {
  useEscClose(open, onClose)
  const presence = usePresence(open, 220)
  if (!presence.mounted) return null
  return (
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-[rgba(26,26,26,0.40)] ${
          presence.leaving ? 'wb-overlay-out' : 'wb-overlay-in'
        }`}
        onClick={onClose}
      />
      <aside
        className={`absolute right-0 top-0 flex h-full ${width} max-w-[92vw] flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)] ${
          presence.leaving ? 'wb-drawer-out' : 'wb-drawer-in'
        }`}
      >
        <header className="flex min-h-[48px] shrink-0 items-center justify-between gap-2 border-b border-[color:var(--wb-border)] px-4 py-2.5">
          <div className="min-w-0 flex-1 text-[13.5px] font-semibold tracking-[-0.01em] text-[color:var(--wb-text)]">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="wb-press-strong flex h-6 w-6 items-center justify-center rounded-[var(--wb-radius-sm)] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
            aria-label="关闭"
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-[18px]">{children}</div>
        {footer && (
          <footer className="shrink-0 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-3">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------- 页面骨架

export function PageHeader({
  title,
  desc,
  actions,
  eyebrow,
}: {
  title: ReactNode
  desc?: ReactNode
  actions?: ReactNode
  /** 标题左侧的小字引导（如分组名 / 当前阶段），只在需要交代语境时给 */
  eyebrow?: ReactNode
}) {
  /** 期刊页眉：单行衬线标题 + 一行说明，下方一根发丝线收口（仍不做大标题卡） */
  return (
    <div className="wb-anim-rise mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-[color:var(--wb-border-strong)] pb-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {eyebrow && <span className="wb-running">{eyebrow}</span>}
        <h1 className="wb-serif text-[19px] font-medium leading-snug text-[color:var(--wb-text)]">
          {title}
        </h1>
        {desc && (
          <p className="min-w-0 max-w-[72ch] text-[12px] leading-relaxed text-[color:var(--wb-muted)]">
            {desc}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** 本地搜索框：列表页复用，带清空按钮 */
export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  return (
    <div
      className={`flex items-center gap-1.5 rounded-[var(--wb-radius-sm)] border bg-[color:var(--wb-surface)] px-2.5 transition-[border-color,box-shadow] duration-150 ${
        focused
          ? 'border-[color:var(--wb-accent)] shadow-[var(--wb-ring)]'
          : 'border-[color:var(--wb-border-strong)] hover:border-[color:var(--wb-text-soft)]/40'
      } ${className}`}
    >
      <Icon
        name="search"
        size={13}
        className={focused ? 'text-[color:var(--wb-accent)]' : 'text-[color:var(--wb-muted)]'}
      />
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="w-full bg-transparent py-[5px] text-[12.5px] outline-none placeholder:text-[color:var(--wb-muted)]"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('')
            ref.current?.focus()
          }}
          className="wb-press-strong flex h-5 w-5 items-center justify-center rounded-[var(--wb-radius-sm)] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
          aria-label="清空搜索"
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 分页

const PAGE_SIZES = [20, 50, 100]

/**
 * 列表分页条：条数统计 + 每页大小 + 翻页。
 * 纯受控组件，页码与每页大小都存在调用方（通常是 usePersist），翻页不触发数据重取。
 */
export function Pagination({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
  unit = '条',
  sizes = PAGE_SIZES,
  className = '',
}: {
  total: number
  page: number
  pageSize: number
  onPage: (p: number) => void
  onPageSize?: (n: number) => void
  unit?: string
  sizes?: number[]
  className?: string
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  const cur = Math.min(Math.max(1, page), pages)
  const from = total === 0 ? 0 : (cur - 1) * pageSize + 1
  const to = Math.min(cur * pageSize, total)

  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 ${className}`}>
      <div className="text-[11.5px] text-[color:var(--wb-muted)]">
        共 {total} {unit}
        {total > 0 && (
          <span className="ml-1">
            · 当前显示 {from}–{to}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {onPageSize && (
          <Select
            value={String(pageSize)}
            onChange={(v) => onPageSize(Number(v) || pageSize)}
            options={sizes.map((n) => ({ value: String(n), label: `每页 ${n}` }))}
          />
        )}
        <Btn size="sm" disabled={cur <= 1} onClick={() => onPage(1)} ariaLabel="第一页">
          <Icon name="chevronsLeft" size={13} />
        </Btn>
        <Btn size="sm" disabled={cur <= 1} onClick={() => onPage(cur - 1)}>
          <Icon name="chevronLeft" size={13} />
          上一页
        </Btn>
        <span className="min-w-[4.5rem] text-center text-[12px] tabular-nums text-[color:var(--wb-text-soft)]">
          {cur} / {pages}
        </span>
        <Btn size="sm" disabled={cur >= pages} onClick={() => onPage(cur + 1)}>
          下一页
          <Icon name="chevronRight" size={13} />
        </Btn>
        <Btn size="sm" disabled={cur >= pages} onClick={() => onPage(pages)} ariaLabel="最后一页">
          <Icon name="chevronsRight" size={13} />
        </Btn>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 状态与错误展示

/**
 * 状态标签：图标 + 文字 + 颜色。
 *
 * 颜色单独用是不行的 —— 色弱用户分不出红绿，黑白打印更是一片灰。
 * 所以每一档都带一个符号（✓ ! ✕ …）和中文说明。
 */
export function StatusTag({
  tone = 'gray',
  children,
  className = '',
}: {
  tone?: 'gray' | 'ok' | 'warn' | 'danger' | 'info' | 'busy'
  children: ReactNode
  className?: string
}) {
  const map: Record<string, { cls: string; icon: IconName }> = {
    gray: { cls: 'bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-text-soft)]', icon: 'minus' },
    ok: { cls: 'bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]', icon: 'check' },
    warn: { cls: 'bg-[color:var(--wb-warn-soft)] text-[color:var(--wb-warn)]', icon: 'alert' },
    danger: { cls: 'bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]', icon: 'close' },
    info: { cls: 'bg-[color:var(--wb-info-soft)] text-[color:var(--wb-info)]', icon: 'info' },
    busy: { cls: 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]', icon: 'refresh' },
  }
  const t = map[tone] || map.gray
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--wb-radius-sm)] px-2 py-[1px] text-[11.5px] font-medium leading-[18px] ${t.cls} ${className}`}
    >
      {/* 忙碌态用旋转图标表达「进行中」，其余档位本身就是语义符号，aria-hidden 交给 Icon */}
      <Icon name={t.icon} size={11} className={tone === 'busy' ? 'wb-anim-spin' : ''} />
      {children}
    </span>
  )
}

/**
 * 可展开区块：技术细节默认收起。
 *
 * 错误原因要让人看懂，但「HTTP 401 + 原始 body」这种东西不该糊在正文里。
 */
export function Details({
  summary,
  children,
  defaultOpen = false,
  className = '',
}: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`wb-inset overflow-hidden ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="wb-press-soft flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)]"
      >
        <span aria-hidden className="text-[color:var(--wb-muted)]">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} strokeWidth={2} />
        </span>
        <span className="whitespace-nowrap">{summary}</span>
      </button>
      {open && (
        <div className="wb-view-enter border-t border-[color:var(--wb-border)] px-2.5 py-2 text-[11.5px] text-[color:var(--wb-text-soft)]">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * 加载失败占位：给出原因 + 重试入口。
 *
 * 「卡在加载中」和「加载失败」是两件事，不能都用一个 spinner 表示。
 */
export function LoadError({
  error,
  onRetry,
  retrying,
  what = '内容',
}: {
  error: string | null
  onRetry?: () => void
  retrying?: boolean
  what?: string
}) {
  return (
    <div className="wb-anim-fade rounded-[var(--wb-radius)] border border-[color:var(--wb-danger)]/25 bg-[color:var(--wb-danger-soft)] px-4 py-5">
      <div className="flex items-start gap-2">
        <Icon name="alert" size={15} className="mt-[1px] text-[color:var(--wb-danger)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-[color:var(--wb-danger)]">
            {what}加载失败
          </div>
          <div className="mt-0.5 break-words text-[11.5px] text-[color:var(--wb-text-soft)]">
            {error || '后端没有响应'}
          </div>
          {onRetry && (
            <Btn size="sm" className="mt-2" onClick={onRetry} loading={retrying}>
              重试
            </Btn>
          )}
        </div>
      </div>
    </div>
  )
}
