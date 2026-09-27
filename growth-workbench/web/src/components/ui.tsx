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

// ---------------------------------------------------------------- Card

export function Card({
  title,
  extra,
  children,
  className = '',
  footer,
  bodyClassName = '',
}: {
  title?: ReactNode
  extra?: ReactNode
  children?: ReactNode
  className?: string
  footer?: ReactNode
  bodyClassName?: string
}) {
  const hasHead = !!title || !!extra
  return (
    <section
      className={`overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-sm)] ${className}`}
    >
      {hasHead && (
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-2.5">
          {title && (
            <h2 className="text-[13px] font-semibold tracking-[0.01em] text-[color:var(--wb-text)]">
              {title}
            </h2>
          )}
          {extra && <div className="flex shrink-0 items-center gap-1.5">{extra}</div>}
        </header>
      )}
      <div className={`p-4 ${bodyClassName}`}>{children}</div>
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
  size?: 'sm' | 'md'
  title?: string
  /** 纯图标按钮必须给可读名称，否则屏幕阅读器只会念出「按钮」 */
  ariaLabel?: string
}) {
  // whitespace-nowrap：中文没有词边界，窄容器里会退化成「一个字一行」
  const base =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] border font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-45'
  const sizes: Record<string, string> = {
    sm: 'px-2 py-[3px] text-[11.5px]',
    md: 'px-3 py-[6px] text-[12.5px]',
  }
  const styles: Record<BtnVariant, string> = {
    primary:
      'border-transparent bg-[color:var(--wb-accent)] text-white shadow-[var(--wb-shadow-xs)] hover:bg-[color:var(--wb-accent-strong)]',
    danger:
      'border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)] hover:bg-[#fbdcda]',
    ghost: 'border-transparent text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]',
    subtle:
      'border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]',
    default:
      'border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text)] shadow-[var(--wb-shadow-xs)] hover:bg-[color:var(--wb-surface-alt)] hover:border-[color:var(--wb-border-strong)]',
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

const CONTROL_BASE =
  'w-full rounded-[9px] border bg-[color:var(--wb-surface)] text-[13px] text-[color:var(--wb-text)] outline-none transition placeholder:text-[color:var(--wb-muted)] disabled:bg-[color:var(--wb-bg-subtle)] disabled:text-[color:var(--wb-muted)]'

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
      className={`${CONTROL_BASE} border-[color:var(--wb-border-strong)] px-2.5 py-[6px] focus:border-[color:var(--wb-accent)] ${className}`}
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
      className={`${CONTROL_BASE} resize-y border-[color:var(--wb-border-strong)] px-2.5 py-[6px] leading-relaxed focus:border-[color:var(--wb-accent)] ${className}`}
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
        className={`${CONTROL_BASE} w-auto cursor-pointer appearance-none border-[color:var(--wb-border-strong)] py-[6px] pl-2.5 pr-7 text-[12.5px] focus:border-[color:var(--wb-accent)]`}
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
    slate: 'bg-[#eceff3] text-[#475467]',
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
    <div className="flex flex-col items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface-alt)] px-4 py-8 text-center">
      <div className="text-[12.5px] text-[color:var(--wb-text-soft)]">{text}</div>
      {hint && <div className="text-[11.5px] text-[color:var(--wb-muted)]">{hint}</div>}
      {action}
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
  return (
    <div
      onClick={onClick}
      className={`rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3.5 py-3 shadow-[var(--wb-shadow-xs)] transition ${
        onClick ? 'cursor-pointer hover:shadow-[var(--wb-shadow-sm)]' : ''
      }`}
    >
      <div className="text-[12px] text-[color:var(--wb-muted)]">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={`text-[20px] font-semibold leading-tight tabular-nums ${tones[tone]}`}>
          {value}
        </span>
        {unit && <span className="text-[12px] text-[color:var(--wb-muted)]">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[11.5px] text-[color:var(--wb-muted)]">{hint}</div>}
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
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--wb-bg-subtle)]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${tones[tone]}`}
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
      className={`inline-flex gap-0.5 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] p-0.5 ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-[8px] px-2.5 py-[3px] text-[12px] transition ${
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
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="wb-anim-fade absolute inset-0 bg-[rgba(16,24,40,0.45)]"
        onClick={onClose}
      />
      <div
        className={`wb-anim-pop relative w-full ${width} overflow-hidden rounded-[16px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]`}
      >
        {title && (
          <header className="flex items-center justify-between border-b border-[color:var(--wb-border)] px-4 py-3">
            <h3 className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
              aria-label="关闭"
            >
              <Icon name="close" size={15} />
            </button>
          </header>
        )}
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
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
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <div className="wb-anim-fade absolute inset-0 bg-[rgba(16,24,40,0.4)]" onClick={onClose} />
      <aside
        className={`wb-anim-slide absolute right-0 top-0 flex h-full ${width} max-w-[92vw] flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]`}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--wb-border)] px-4 py-3">
          <div className="min-w-0 flex-1 text-[13.5px] font-semibold text-[color:var(--wb-text)]">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
            aria-label="关闭"
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
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
}: {
  title: ReactNode
  desc?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[17px] font-semibold tracking-[0.01em] text-[color:var(--wb-text)]">
          {title}
        </h1>
        {desc && <p className="mt-0.5 text-[12px] text-[color:var(--wb-muted)]">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
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
      className={`flex items-center gap-1.5 rounded-[9px] border bg-[color:var(--wb-surface)] px-2.5 transition ${
        focused
          ? 'border-[color:var(--wb-accent)]'
          : 'border-[color:var(--wb-border-strong)]'
      } ${className}`}
    >
      <Icon name="search" size={13} className="text-[color:var(--wb-muted)]" />
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
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
          className="flex h-5 w-5 items-center justify-center rounded text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
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
        <div className="border-t border-[color:var(--wb-border)] px-2.5 py-2 text-[11.5px] text-[color:var(--wb-text-soft)]">
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
