/**
 * 监测：按天聚合真实运行数据（canvas_runs + canvas_node_outputs）。
 *
 * 口径显式写在每个指标卡下方：本机是单用户工具，没有计费网关，
 * 所以「活跃用户数」按当天是否有运行记 0/1，「费用消耗」以 token 计量，绝不编造金额。
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Btn, IconBtn, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { get } from '../../lib/api'
import { usePersist } from '../../lib/state'
import { C_ACCENT, C_AXIS, C_GRID, C_OK, C_WARN } from '../../lib/chartTokens'
import {
  CanvasSelect,
  EmptyHint,
  NeedCanvas,
  SubHead,
  useCanvasPicker,
} from './CanvasSub'

type Stats = {
  days: string[]
  series: Record<string, number[]>
  totals: Record<string, number>
  scope: Record<string, string>
}

function MetricCard({
  title,
  value,
  hint,
  color,
  data,
  dataKey,
}: {
  title: string
  value: React.ReactNode
  hint: string
  color: string
  data: any[]
  dataKey: string
}) {
  return (
    <section className="rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-4 shadow-[var(--wb-shadow-xs)]">
      <div className="flex items-baseline gap-2">
        <span className="text-[11.5px] text-[color:var(--wb-text-soft)]">{title}</span>
        <span className="text-[18px] font-medium leading-none tabular-nums text-[color:var(--wb-text)]">{value}</span>
      </div>
      <div className="mt-3 h-[132px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: -22 }}>
            <CartesianGrid stroke={C_GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: C_AXIS }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: C_AXIS }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                borderRadius: 8,
                border: '1px solid #e4ebee',
                boxShadow: '0 4px 16px rgba(22,37,44,.08)',
              }}
            />
            <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.8} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 text-[10px] leading-relaxed text-[color:var(--wb-muted)]">{hint}</div>
    </section>
  )
}

export default function CanvasMonitor({
  embedded = false,
}: {
  /** 嵌入设置页时：不渲染自己的小标题与画布选择器（外层统一管理） */
  embedded?: boolean
} = {}) {
  const { cid, setCid, canvases } = useCanvasPicker()
  const nav = useNavigate()
  const [days, setDays] = useState('7')
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [banner, setBanner] = usePersist('canvas.monitorBanner', true)

  const load = () => {
    if (!cid) return
    setLoading(true)
    setErr('')
    get<any>(`/canvas/${cid}/stats?days=${days}`)
      .then(setStats)
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [cid, days])

  const data = useMemo(() => {
    if (!stats) return []
    return stats.days.map((d, i) => ({
      date: d.slice(5),
      active_users: stats.series.active_users?.[i] ?? 0,
      runs: stats.series.runs?.[i] ?? 0,
      tokens: stats.series.tokens?.[i] ?? 0,
      avg_calls: stats.series.avg_calls?.[i] ?? 0,
      done: stats.series.done?.[i] ?? 0,
      failed: stats.series.failed?.[i] ?? 0,
    }))
  }, [stats])

  if (!cid) return <NeedCanvas />

  return (
    <div className={embedded ? 'px-1 py-1' : 'h-full overflow-y-auto px-6 py-5'}>
      <div className="mx-auto w-full max-w-[1080px]">
        {banner && (
          <div className="mb-4 flex flex-wrap items-start gap-3 rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-3 shadow-[var(--wb-shadow-xs)]">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-[color:var(--wb-text)]">首先，设置您的模型提供商。</div>
              <Btn size="sm" variant="primary" className="mt-2" onClick={() => nav('/settings')}>
                设置模型供应商
              </Btn>
              <div className="mt-2 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
                画布节点运行需要至少一个可用的 LLM provider；本机已配置的 provider 可在设置页查看。
              </div>
            </div>
            <IconBtn icon="close" size="sm" ariaLabel="关闭提示" title="不再显示" onClick={() => setBanner(false)} />
          </div>
        )}

        <SubHead
          title="监测"
          desc="监控记录应用的运行情况，包括执行次数、节点产出与 token 消耗。全部数值来自本机运行记录。"
          actions={embedded ? undefined : <CanvasSelect cid={cid} setCid={setCid} canvases={canvases} />}
        />

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select
            value={days}
            onChange={setDays}
            options={[
              { value: '7', label: '过去 7 天' },
              { value: '14', label: '过去 14 天' },
              { value: '30', label: '过去 30 天' },
            ]}
          />
          <IconBtn icon="refresh" size="md" ariaLabel="刷新数据" title="刷新" onClick={load} />
          <Btn size="sm" onClick={() => nav('/canvas?tab=logs')}>
            <Icon name="chart" size={12} />
            追踪应用性能
          </Btn>
          {loading && <span className="text-[11px] text-[color:var(--wb-muted)]">加载中…</span>}
          <span className="ml-auto text-[11px] tabular-nums text-[color:var(--wb-muted)]">
            近 {days} 天共 {stats?.totals?.runs ?? 0} 次运行 · {stats?.totals?.tokens ?? 0} tokens
          </span>
        </div>

        {err && (
          <div className="mb-3 rounded-[10px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-3 py-2 text-[11.5px] text-[color:var(--wb-danger)]">
            监测数据加载失败：{err}
            <Btn size="sm" className="ml-2" onClick={load}>
              重试
            </Btn>
          </div>
        )}

        {stats && (stats.totals?.runs ?? 0) === 0 && (
          <div className="mb-3">
            <EmptyHint title="这段时间还没有运行数据">
              在编排页运行一次画布后，这里会按天画出真实的执行曲线。图表坐标轴会保留，不会出现占位假数据。
            </EmptyHint>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <MetricCard
            title="活跃用户数"
            value={stats?.totals?.active_days ?? 0}
            hint={stats?.scope?.active_users || '本机单用户口径：当天有运行记 1，否则 0；数值为区间内有运行的天数。'}
            color={C_WARN}
            data={data}
            dataKey="active_users"
          />
          <MetricCard
            title="运行次数"
            value={stats?.totals?.runs ?? 0}
            hint={stats?.scope?.runs || '按 canvas_runs.started_at 的日期分组计数，含成功、失败与取消。'}
            color={C_ACCENT}
            data={data}
            dataKey="runs"
          />
          <MetricCard
            title="Token 消耗"
            value={stats?.totals?.tokens ?? 0}
            hint={stats?.scope?.tokens || 'tokens_in + tokens_out 求和。本机未接入计费网关，因此不折算金额。'}
            color={C_OK}
            data={data}
            dataKey="tokens"
          />
          <MetricCard
            title="平均用户调用次数"
            value={stats?.totals?.avg_calls ?? 0}
            hint={stats?.scope?.avg_calls || '单用户口径下等于当天运行次数；卡片数值为区间日均值，曲线为当日次数。'}
            color={C_AXIS}
            data={data}
            dataKey="avg_calls"
          />
        </div>

        <div className="mt-4 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3.5 py-2.5 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
          口径说明：所有曲线只统计当前选中画布（画布 #{cid}）在所选时间窗内的真实运行记录，来源于
          <code className="mx-1 font-mono">canvas_runs</code>与
          <code className="mx-1 font-mono">canvas_node_outputs</code>。没有运行的日期补 0，不插值、不模拟。
        </div>
      </div>
    </div>
  )
}
