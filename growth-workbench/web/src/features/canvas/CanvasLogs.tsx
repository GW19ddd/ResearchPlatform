/** 日志：读真实的 canvas_runs / canvas_node_outputs，带状态、时间范围与搜索筛选。 */
import { useEffect, useMemo, useState } from 'react'
import { Btn, IconBtn, SearchInput, Select, StatusTag } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { get } from '../../lib/api'
import {
  CanvasSelect,
  EmptyHint,
  NeedCanvas,
  SubHead,
  useCanvasPicker,
} from './CanvasSub'

type RunRow = {
  id: number
  scope: string
  status: string
  started_at: string
  finished_at: string | null
  out_count: number
}

type Detail = { run: any; outputs: any[] }

const STATUS: Record<string, { tone: 'gray' | 'ok' | 'warn' | 'danger' | 'busy'; text: string }> = {
  done: { tone: 'ok', text: '成功' },
  failed: { tone: 'danger', text: '失败' },
  cancelled: { tone: 'warn', text: '已取消' },
  running: { tone: 'busy', text: '运行中' },
  queued: { tone: 'gray', text: '排队中' },
}

function fmt(s?: string | null) {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('zh-CN', { hour12: false })
}

function duration(a?: string, b?: string | null) {
  if (!a || !b) return '—'
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

export default function CanvasLogs({
  embedded = false,
}: {
  /** 嵌入设置页时：不渲染自己的小标题与画布选择器（外层统一管理） */
  embedded?: boolean
} = {}) {
  const { cid, setCid, canvases } = useCanvasPicker()
  const [rows, setRows] = useState<RunRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [status, setStatus] = useState('all')
  const [range, setRange] = useState('7')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)

  const load = () => {
    if (!cid) return
    setLoading(true)
    setErr('')
    get<any>(`/canvas/${cid}/runs`)
      .then((d) => setRows(d?.runs || []))
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [cid])

  useEffect(() => {
    if (openId == null) {
      setDetail(null)
      return
    }
    let alive = true
    get<any>(`/canvas/runs/${openId}`)
      .then((d) => {
        if (alive) setDetail({ run: d.run, outputs: d.outputs || [] })
      })
      .catch(() => {
        if (alive) setDetail(null)
      })
    return () => {
      alive = false
    }
  }, [openId])

  const filtered = useMemo(() => {
    const since = range === 'all' ? 0 : Date.now() - Number(range) * 86400000
    const kw = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (status !== 'all' && r.status !== status) return false
      if (since && new Date(r.started_at).getTime() < since) return false
      if (kw && !`${r.id} ${r.scope} ${r.status}`.toLowerCase().includes(kw)) return false
      return true
    })
  }, [rows, status, range, q])

  if (!cid) return <NeedCanvas />

  return (
    <div className={embedded ? 'px-1 py-1' : 'h-full overflow-y-auto px-6 py-5'}>
      <div className="mx-auto w-full max-w-[1080px]">
        <SubHead
          title="日志"
          desc="日志记录应用的执行情况。数据来自本机 canvas_runs，最多显示最近 20 次运行。"
          actions={embedded ? undefined : <CanvasSelect cid={cid} setCid={setCid} canvases={canvases} />}
        />

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-[11.5px] text-[color:var(--wb-muted)]">
            <Icon name="menu" size={12} />
            筛选
          </span>
          <Select
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'done', label: '成功' },
              { value: 'failed', label: '失败' },
              { value: 'cancelled', label: '已取消' },
              { value: 'running', label: '运行中' },
            ]}
          />
          <Select
            value={range}
            onChange={setRange}
            options={[
              { value: '7', label: '过去 7 天' },
              { value: '30', label: '过去 30 天' },
              { value: 'all', label: '全部时间' },
            ]}
          />
          <SearchInput value={q} onChange={setQ} placeholder="搜索运行 ID / 范围 / 状态" className="w-56" />
          <IconBtn icon="refresh" size="md" ariaLabel="刷新日志" title="刷新" onClick={load} />
          <span className="ml-auto text-[11px] tabular-nums text-[color:var(--wb-muted)]">
            {filtered.length} / {rows.length} 次运行
          </span>
        </div>

        {err && (
          <div className="mb-3 rounded-[10px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-3 py-2 text-[11.5px] text-[color:var(--wb-danger)]">
            日志加载失败：{err}
            <Btn size="sm" className="ml-2" onClick={load}>
              重试
            </Btn>
          </div>
        )}

        {loading && rows.length === 0 ? (
          <div className="py-12 text-center text-[11.5px] text-[color:var(--wb-muted)]">加载中…</div>
        ) : filtered.length === 0 ? (
          <EmptyHint
            title={rows.length === 0 ? '还没有运行记录' : '没有符合条件的记录'}
            action={
              <Btn onClick={() => (window.location.href = '/canvas?tab=build')}>
                <Icon name="play" size={12} />
                去运行一次
              </Btn>
            }
          >
            {rows.length === 0
              ? '在编排页点「预览运行」后，每次执行都会记在这里，包含每个节点的输出、模型与耗时。'
              : '换个状态或时间范围试试。'}
          </EmptyHint>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((r) => {
              const st = STATUS[r.status] || { tone: 'gray' as const, text: r.status }
              const open = openId === r.id
              return (
                <section
                  key={r.id}
                  className="overflow-hidden rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]"
                >
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : r.id)}
                    className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 text-left hover:bg-[color:var(--wb-surface-alt)]"
                  >
                    <span className="w-14 shrink-0 font-mono text-[11.5px] tabular-nums text-[color:var(--wb-muted)]">
                      #{r.id}
                    </span>
                    <StatusTag tone={st.tone}>{st.text}</StatusTag>
                    <span className="text-[11.5px] text-[color:var(--wb-text-soft)]">
                      {r.scope === 'all' ? '整图运行' : `单节点 · ${r.scope}`}
                    </span>
                    <span className="text-[11px] text-[color:var(--wb-muted)]">{fmt(r.started_at)}</span>
                    <span className="ml-auto flex items-center gap-3 text-[11px] tabular-nums text-[color:var(--wb-muted)]">
                      <span>{r.out_count} 个节点输出</span>
                      <span>{duration(r.started_at, r.finished_at)}</span>
                      <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
                    </span>
                  </button>
                  {open && (
                    <div className="wb-view-enter border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3.5 py-3">
                      {!detail || detail.run?.id !== r.id ? (
                        <div className="text-[11.5px] text-[color:var(--wb-muted)]">正在读取这次运行的节点明细…</div>
                      ) : detail.outputs.length === 0 ? (
                        <div className="text-[11.5px] text-[color:var(--wb-muted)]">这次运行没有留下节点输出。</div>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {detail.outputs.map((o: any) => (
                            <div
                              key={o.id}
                              className="rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-2.5 py-2"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-[11px] font-medium text-[color:var(--wb-text)]">
                                  {o.node_key}
                                </span>
                                <StatusTag tone={o.ok ? 'ok' : 'danger'}>{o.ok ? '成功' : '失败'}</StatusTag>
                                {o.model && <span className="text-[10.5px] text-[color:var(--wb-muted)]">{o.model}</span>}
                                <span className="ml-auto text-[10.5px] tabular-nums text-[color:var(--wb-muted)]">
                                  {o.elapsed_ms != null ? `${o.elapsed_ms} ms` : '—'}
                                  {o.tokens_in || o.tokens_out
                                    ? ` · ${Number(o.tokens_in || 0) + Number(o.tokens_out || 0)} tokens`
                                    : ''}
                                </span>
                              </div>
                              {o.output_text && (
                                <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
                                  {o.output_text}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
