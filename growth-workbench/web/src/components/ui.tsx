import {
  FocusEvent,
  MouseEvent,
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

// ---------------------------------------------------------------- Avatar

/**
 * 头像：没有上传图片的本地账户，用「首字 + 按色相生成的渐变」代替。
 * 不画人脸、不用 emoji —— 首字块最稳，也最容易一眼认人。
 */
export function Avatar({
  name,
  hue = 240,
  size = 32,
  className = '',
}: {
  name?: string
  hue?: number
  size?: number
  className?: string
}) {
  const initial = (name || '研').trim().slice(0, 1).toUpperCase()
  const h = ((Number(hue) || 240) + 360) % 360
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        backgroundImage: `linear-gradient(145deg, hsl(${h} 62% 58%), hsl(${(h + 34) % 360} 64% 42%))`,
      }}
    >
      {initial}
    </span>
  )
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
  /** 新手引导锚点：渲染成 section[data-tour]，不影响外观 */
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
    'wb-press inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] border font-medium transition-all duration-150 active:translate-y-[0.5px] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0'
  const sizes: Record<string, string> = {
    xs: 'px-2 py-[2px] text-[11.5px]',
    sm: 'px-2.5 py-[4px] text-[12px]',
    md: 'px-3.5 py-[7px] text-[12.5px]',
    lg: 'px-4 py-2.5 text-[13.5px]',
  }
  const styles: Record<BtnVariant, string> = {
    primary:
      'border-transparent bg-[color:var(--wb-accent)] text-white shadow-[0_1px_2px_rgba(64,52,196,0.28),inset_0_1px_0_rgba(255,255,255,0.16)] hover:bg-[color:var(--wb-accent-strong)] hover:shadow-[0_2px_8px_-2px_rgba(64,52,196,0.45)]',
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

// ---------------------------------------------------------------- Icon-only Button

/**
 * 纯图标按钮：删除/关闭/导出这类只有一个图标的操作。
 *
 * 之前各页面手写了六七种尺寸（h-6 w-6 / h-8 w-8 / 圆角 7px / rounded-md…），
 * 现在统一到这里：sm=24px（表格行内、密集列表），md=32px（工具栏、抽屉头）。
 */
export function IconBtn({
  icon,
  onClick,
  title,
  ariaLabel,
  size = 'sm',
  tone = 'default',
  disabled,
  className = '',
}: {
  icon: IconName
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  title?: string
  /** 纯图标按钮必须给可读名称，否则屏幕阅读器只会念出「按钮」 */
  ariaLabel?: string
  size?: 'sm' | 'md'
  tone?: 'default' | 'danger'
  disabled?: boolean
  className?: string
}) {
  const sizes: Record<string, string> = { sm: 'h-6 w-6', md: 'h-8 w-8' }
  const iconSize = size === 'md' ? 15 : 13
  const tones: Record<string, string> = {
    default:
      'text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]',
    danger:
      'text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-danger-soft)] hover:text-[color:var(--wb-danger)]',
  }
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel || title}
      disabled={disabled}
      onClick={onClick}
      className={`wb-press-strong inline-flex shrink-0 items-center justify-center rounded-[8px] transition disabled:cursor-not-allowed disabled:opacity-40 ${sizes[size]} ${tones[tone]} ${className}`}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  )
}

// ---------------------------------------------------------------- Form

const CONTROL_BASE =
  'wb-input-w rounded-[10px] border bg-[color:var(--wb-surface)] text-[13px] text-[color:var(--wb-text)] outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[color:var(--wb-muted)] hover:border-[color:var(--wb-text-soft)]/40 focus:border-[color:var(--wb-accent)] focus:shadow-[var(--wb-ring)] disabled:cursor-not-allowed disabled:bg-[color:var(--wb-bg-subtle)] disabled:text-[color:var(--wb-muted)]'

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  className = '',
  defaultValue,
  onBlur,
  onKeyDown,
  disabled,
  autoComplete,
  ariaLabel,
}: {
  value?: string | number
  onChange?: (v: string) => void
  placeholder?: string
  type?: string
  className?: string
  defaultValue?: string | number
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  /** 地址栏之类需要回车提交时用；可选，不影响既有调用方 */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  disabled?: boolean
  autoComplete?: string
  /** 给原生 input 挂 aria-label（无障碍 + 自动化定位）；可选 */
  ariaLabel?: string
}) {
  return (
    <input
      type={type}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete={autoComplete}
      aria-label={ariaLabel}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      className={`${CONTROL_BASE} border-[color:var(--wb-border-strong)] px-3 py-[7px] focus:border-[color:var(--wb-accent)] ${className}`}
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
  defaultValue,
  onBlur,
}: {
  value?: string
  onChange?: (v: string) => void
  placeholder?: string
  rows?: number
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  className?: string
  /** 非受控用法：详情面板「失焦保存」场景，避免整页重渲 */
  defaultValue?: string
  onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void
}) {
  return (
    <textarea
      rows={rows}
      value={value ?? ''}
      defaultValue={defaultValue}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={`${CONTROL_BASE} resize-y border-[color:var(--wb-border-strong)] px-3 py-2 leading-relaxed focus:border-[color:var(--wb-accent)] ${className}`}
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
        className={`${CONTROL_BASE} w-auto cursor-pointer appearance-none border-[color:var(--wb-border-strong)] py-[7px] pl-3 pr-7 text-[12.5px] focus:border-[color:var(--wb-accent)]`}
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
        <span className="mt-1 flex items-start gap-1 text-[11.5px] text-[color:var(--wb-danger)]">
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
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-[1px] text-[11.5px] font-medium leading-[18px] ${
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
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tones[tone] || tones.gray}`}
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
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <span
        className="mb-1 flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)]"
        aria-hidden
      >
        <Icon name="hexagon" size={18} className="text-[color:var(--wb-muted)]" />
      </span>
      <div className="text-[13px] font-medium text-[color:var(--wb-text-soft)]">{text}</div>
      {hint && <div className="max-w-[46ch] text-[12px] leading-relaxed text-[color:var(--wb-muted)]">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-[color:var(--wb-muted)]">
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
  const dots: Record<string, string> = {
    default: 'bg-[color:var(--wb-border-strong)]',
    ok: 'bg-[color:var(--wb-ok)]',
    warn: 'bg-[color:var(--wb-warn)]',
    danger: 'bg-[color:var(--wb-danger)]',
    accent: 'bg-[color:var(--wb-accent)]',
  }
  return (
    <div
      onClick={onClick}
      className={`relative overflow-hidden rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-4 shadow-[var(--wb-shadow-xs)] transition-all duration-200 ${
        onClick ? 'wb-press-soft wb-lift cursor-pointer' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-[12px] text-[color:var(--wb-muted)]">{label}</div>
        {/* 语义色只留一个小圆点：数字本身按重点色走，色弱用户也能靠位置与文字区分 */}
        <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${dots[tone] || dots.default}`} aria-hidden />
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={`text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${tones[tone]}`}
        >
          {value}
        </span>
        {unit && <span className="text-[12px] text-[color:var(--wb-muted)]">{unit}</span>}
      </div>
      {hint && (
        <div className="mt-2 line-clamp-2 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{hint}</div>
      )}
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
    accent:
      'bg-gradient-to-r from-[color:var(--wb-accent)] to-[color:var(--wb-accent-strong)]',
    ok: 'bg-[color:var(--wb-ok)]',
    warn: 'bg-[color:var(--wb-warn)]',
    danger: 'bg-[color:var(--wb-danger)]',
  }
  return (
    <div className="flex items-center gap-2">
      <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[color:var(--wb-bg-subtle)]">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${tones[tone]}`}
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
      className={`inline-flex gap-0.5 rounded-[11px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] p-[3px] ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`wb-press-strong whitespace-nowrap rounded-[8px] px-2.5 py-[4px] text-[12px] transition-all duration-150 ${
            value === o.value
              ? 'bg-[color:var(--wb-surface)] font-medium text-[color:var(--wb-text)] shadow-[var(--wb-shadow-xs)]'
              : 'text-[color:var(--wb-text-soft)] hover:text-[color:var(--wb-text)]'
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
            className={`h-[5px] w-4 rounded-full transition-colors ${
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

/**
 * 浮层退出过渡：open 变 false 后先播退出动画，再真正卸载。
 * 之前是 if (!open) return null 直接消失，和「不要突然闪现」相冲。
 * 系统开了减少动态效果就把时长归零，立刻卸载。
 */
export function usePresence(open: boolean, ms = 200) {
  const reduce =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const dur = reduce ? 0 : ms
  const [mounted, setMounted] = useState(open)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
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
  }, [open, mounted, dur])
  return { mounted, leaving }
}

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
  const { mounted, leaving } = usePresence(open, 180)
  if (!mounted) return null
  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 ${leaving ? 'pointer-events-none' : ''}`}
      aria-hidden={leaving || undefined}
    >
      <div
        className={`absolute inset-0 bg-[rgba(16,17,20,0.36)] backdrop-blur-[3px] ${leaving ? 'wb-overlay-out' : 'wb-overlay-in'}`}
        onClick={onClose}
      />
      <div
        className={`relative w-full ${width} overflow-hidden rounded-[20px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)] ${leaving ? 'wb-dialog-out' : 'wb-dialog-in'}`}
      >
        {title && (
          <header className="flex items-center justify-between gap-3 border-b border-[color:var(--wb-border)] px-5 py-3.5">
            <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--wb-text)]">{title}</h3>
            <IconBtn icon="close" size="sm" ariaLabel="关闭" onClick={onClose} />
          </header>
        )}
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-5 py-3.5">
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
  const { mounted, leaving } = usePresence(open, 200)
  if (!mounted) return null
  return (
    <div className={`fixed inset-0 z-50 ${leaving ? 'pointer-events-none' : ''}`} aria-hidden={leaving || undefined}>
      <div
        className={`absolute inset-0 bg-[rgba(16,17,20,0.34)] backdrop-blur-[3px] ${leaving ? 'wb-overlay-out' : 'wb-overlay-in'}`}
        onClick={onClose}
      />
      <aside
        className={`absolute right-0 top-0 flex h-full ${width} max-w-[92vw] flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)] ${leaving ? 'wb-drawer-out' : 'wb-drawer-in'}`}
      >
        <header className="flex min-h-[56px] shrink-0 items-center justify-between gap-2 border-b border-[color:var(--wb-border)] px-5 py-3">
          <div className="min-w-0 flex-1 text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--wb-text)]">
            {title}
          </div>
          <IconBtn icon="close" size="sm" ariaLabel="关闭" onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <footer className="shrink-0 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-5 py-3.5">
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
  /** 紧凑单行：模块页的操作区才是主角，页头只做一条轻量定位行（大标题时代已废弃） */
  return (
    <div className="wb-anim-rise mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        {eyebrow && (
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
            {eyebrow}
          </span>
        )}
        <h1 className="text-[15.5px] font-semibold leading-snug tracking-[-0.01em] text-[color:var(--wb-text)]">
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
  onKeyDown,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  return (
    <div
      className={`flex items-center gap-2 rounded-[10px] border bg-[color:var(--wb-surface)] px-3 transition-[border-color,box-shadow] duration-150 ${
        focused
          ? 'border-[color:var(--wb-accent)] shadow-[var(--wb-ring)]'
          : 'border-[color:var(--wb-border-strong)] hover:border-[color:var(--wb-text-soft)]/40'
      } ${className}`}
    >
      <Icon name="search" size={13} className="text-[color:var(--wb-muted)]" />
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="w-full bg-transparent py-[6px] text-[12.5px] outline-none placeholder:text-[color:var(--wb-muted)]"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('')
            ref.current?.focus()
          }}
          className="wb-press-strong flex h-5 w-5 items-center justify-center rounded text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
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
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-[1px] text-[11.5px] font-medium leading-[18px] ${t.cls} ${className}`}
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
    <div className={`rounded-[9px] border border-[color:var(--wb-border)] ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]"
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
    <div className="rounded-[12px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-4 py-5">
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
