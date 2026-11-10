/**
 * 画布应用四个子视图的共用骨架（编排 / 访问点 / 日志 / 监测）。
 *
 * 约定：内容区不放大标题，只用一行 13px 小标题 + 说明；口径、状态一律来自真实数据。
 */
import { ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Btn, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { get } from '../../lib/api'
import { usePersist } from '../../lib/state'
import { toast } from '../../components/toast'

export function SubHead({
  title,
  desc,
  actions,
}: {
  title: string
  desc?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-[13px] font-medium text-[color:var(--wb-text)]">{title}</h2>
        {desc && (
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{desc}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** 四个视图共用同一个「当前画布」：读的是编排页写下的 canvas.cid */
export function useCanvasPicker() {
  const [cid, setCid] = usePersist<number | null>('canvas.cid', null)
  const [canvases, setCanvases] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    get<any>('/canvas')
      .then((d) => {
        if (alive) setCanvases(Array.isArray(d) ? d : d?.canvases || [])
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])
  return { cid, setCid, canvases, loading }
}

export function CanvasSelect({
  cid,
  setCid,
  canvases,
}: {
  cid: number | null
  setCid: (v: number | null) => void
  canvases: any[]
}) {
  return (
    <Select
      value={cid ? String(cid) : ''}
      onChange={(v) => setCid(v ? Number(v) : null)}
      options={[
        { value: '', label: '选择画布…' },
        ...canvases.map((c) => ({ value: String(c.id), label: c.name })),
      ]}
    />
  )
}

/** 图 4 那种居中浅色提示卡；没有画布 / 没有数据时都用它，不伪造空表格 */
export function EmptyHint({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-6 py-5 text-center">
      <div className="text-[12.5px] font-medium text-[color:var(--wb-text)]">{title}</div>
      {children && (
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{children}</div>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/** 没有选中画布时的统一引导（四页共用） */
export function NeedCanvas() {
  const nav = useNavigate()
  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 py-8">
      <EmptyHint
        title="先选一个画布"
        action={
          <Btn onClick={() => nav('/canvas?tab=build')}>
            <Icon name="layers" size={13} />
            去编排
          </Btn>
        }
      >
        访问点、日志、监测都针对某一块画布。在编排页选中或新建画布后，这里会自动跟着切换。
      </EmptyHint>
    </div>
  )
}

/** 2×2 的 Dify 式白卡：统一边框、圆角、内边距 */
export function SubCard({
  icon,
  title,
  desc,
  state,
  children,
}: {
  icon: ReactNode
  title: string
  desc?: string
  state?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="flex min-h-[188px] flex-col rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-4 shadow-[var(--wb-shadow-xs)]">
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] text-[color:var(--wb-text-soft)]">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">{title}</div>
          {desc && <div className="mt-0.5 text-[11px] leading-snug text-[color:var(--wb-muted)]">{desc}</div>}
        </div>
        {state && <div className="shrink-0">{state}</div>}
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  )
}

/** 状态点 + 文案；开关样式只做展示，不假装能切换未实现的服务 */
export function ServiceState({
  tone,
  text,
}: {
  tone: 'ok' | 'off' | 'na'
  text: string
}) {
  const color =
    tone === 'ok'
      ? 'var(--wb-ok)'
      : tone === 'off'
        ? 'var(--wb-muted)'
        : 'var(--wb-border-strong)'
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2 py-[2px] text-[10.5px] text-[color:var(--wb-muted)]">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {text}
    </span>
  )
}

/** 只读 URL 行：复制 / 刷新 / 打开，读不到值时显示遮蔽占位 */
export function UrlRow({
  value,
  masked,
  onRefresh,
  canOpen,
}: {
  value: string
  masked?: boolean
  onRefresh?: () => void
  canOpen?: boolean
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      toast('已复制到剪贴板', 'ok')
    } catch {
      toast('复制失败，请手动选中文本', 'error')
    }
  }
  return (
    <div className="flex items-center gap-1.5 rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-1.5">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[color:var(--wb-text-soft)]" title={value}>
        {masked ? '••••••••••••••••••••' : value}
      </span>
      <button
        type="button"
        onClick={copy}
        title="复制"
        aria-label="复制地址"
        className="wb-press-strong flex h-5 w-5 items-center justify-center rounded text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
      >
        <Icon name="copy" size={12} />
      </button>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          title="刷新"
          aria-label="刷新"
          className="wb-press-strong flex h-5 w-5 items-center justify-center rounded text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
        >
          <Icon name="refresh" size={12} />
        </button>
      )}
      {canOpen && (
        <button
          type="button"
          onClick={() => window.open(value, '_blank', 'noopener,noreferrer')}
          title="打开"
          aria-label="打开链接"
          className="wb-press-strong flex h-5 w-5 items-center justify-center rounded text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
        >
          <Icon name="arrowRight" size={12} />
        </button>
      )}
    </div>
  )
}
