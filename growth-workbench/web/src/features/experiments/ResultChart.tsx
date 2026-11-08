import { useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Btn, Card, Empty } from '../../components/ui'
import { AiError, AiMeta, AiErrorInfo } from '../../components/AiError'
import { post } from '../../lib/api'
import { useAiTask } from '../../lib/hooks'
import { C_ACCENT, C_AXIS, C_DANGER, C_GRID, C_OK, C_WARN } from '../../lib/chartTokens'

type ChartSpec = {
  type: 'bar' | 'line' | 'scatter' | 'none'
  title?: string
  x_label?: string
  y_label?: string
  note?: string
  categories?: string[]
  series?: { name: string; values: number[] }[]
  points?: { x: number; y: number; label?: string | null }[]
  reason?: string
}

/** 后端 /chart 端点返回的信封（与 AiEnvelope 兼容，额外带 chart 主体）。 */
type ChartResp = {
  ok: boolean
  chart?: ChartSpec
  error?: AiErrorInfo | null
  provider?: string
  model?: string
  tokens_in?: number
  tokens_out?: number
}

const SERIES_COLORS = [C_ACCENT, C_OK, C_WARN, C_DANGER]

const fmtNum = (v: number) =>
  Math.abs(v) >= 1000 ? v.toLocaleString() : String(Math.round(v * 10000) / 10000)

/**
 * AI 科研图表（阶段⑤）：结果记录 → 图表 spec（bar/line/scatter）→ Recharts 渲染
 * + 同源数据表格。数字只来自结果记录，禁止模型推算（后端已做 spec 校验）。
 */
export function ResultChart({ expId, resultsCount }: { expId: number; resultsCount: number }) {
  const chartTask = useAiTask<ChartResp>()
  const [spec, setSpec] = useState<ChartSpec | null>(null)

  const gen = async () => {
    const r: any = await chartTask.run(
      () => post(`/experiments/${expId}/chart`, {}, { ok: false }),
    )
    if (r && r.ok !== false && r.chart) setSpec(r.chart)
  }

  const reset = () => {
    setSpec(null)
    chartTask.reset?.()
  }

  const hasResults = resultsCount >= 2
  const showChart = spec && spec.type !== 'none'

  // bar/line：把 spec 摊平成 Recharts 的行数据
  const rows =
    spec && (spec.type === 'bar' || spec.type === 'line')
      ? (spec.categories || []).map((c, i) => {
          const row: Record<string, number | string> = { x: c }
          for (const s of spec.series || []) row[s.name] = s.values[i]
          return row
        })
      : []

  return (
    <Card
      title="AI 科研图表"
      extra={
        <div className="flex items-center gap-1.5">
          {spec && (
            <Btn size="sm" variant="ghost" onClick={reset}>
              收起
            </Btn>
          )}
          <Btn size="sm" onClick={gen} loading={chartTask.busy} disabled={!hasResults && !spec}>
            {spec ? '重新生成' : '生成图表'}
          </Btn>
        </div>
      }
    >
      {chartTask.error && (
        <div className="mb-2">
          <AiError error={chartTask.error} onRetry={gen} retrying={chartTask.busy} title="图表没有生成，已有图表保持不变" />
        </div>
      )}

      {!spec && !chartTask.error && (
        <Empty
          text={hasResults ? '还没有图表' : '可画的数据点不足'}
          hint={
            hasResults
              ? '点「生成图表」，AI 会从结果记录里挑真实数字画成分组柱状 / 折线 / 散点图，并附同源数据表格——只准用记录里已有的数字，推算出来的点画不进来。'
              : '至少需要 2 条含数值指标的结果记录（指标 JSON 里要有数字，如 {"acc":0.87}）才能成图。'
          }
        />
      )}

      {spec?.type === 'none' && (
        <Empty text="AI 认为这批数据不适合画图" hint={spec.reason || '（未说明原因）'} />
      )}

      {showChart && spec && (
        <>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold text-[color:var(--wb-text)]">{spec.title}</span>
            <span className="whitespace-nowrap text-[11px] text-[color:var(--wb-muted)]">
              {[spec.x_label && `x：${spec.x_label}`, spec.y_label && `y：${spec.y_label}`]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>

          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {spec.type === 'scatter' ? (
                <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke={C_GRID} />
                  <XAxis
                    type="number"
                    dataKey="x"
                    tick={{ fontSize: 11, fill: C_AXIS }}
                    tickFormatter={fmtNum}
                    label={spec.x_label ? { value: spec.x_label, position: 'insideBottom', offset: -2, fontSize: 11, fill: C_AXIS } : undefined}
                  />
                  <YAxis
                    type="number"
                    dataKey="y"
                    tick={{ fontSize: 11, fill: C_AXIS }}
                    tickFormatter={fmtNum}
                    width={56}
                  />
                  <Tooltip
                    formatter={(v: any) => fmtNum(Number(v))}
                    labelFormatter={() => ''}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Scatter data={spec.points} fill={C_ACCENT} />
                </ScatterChart>
              ) : spec.type === 'line' ? (
                <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke={C_GRID} />
                  <XAxis dataKey="x" tick={{ fontSize: 11, fill: C_AXIS }} interval={0} />
                  <YAxis tick={{ fontSize: 11, fill: C_AXIS }} tickFormatter={fmtNum} width={56} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11.5 }} />
                  {(spec.series || []).map((s, i) => (
                    <Line
                      key={s.name}
                      type="monotone"
                      dataKey={s.name}
                      stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  ))}
                </LineChart>
              ) : (
                <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke={C_GRID} />
                  <XAxis dataKey="x" tick={{ fontSize: 11, fill: C_AXIS }} interval={0} />
                  <YAxis tick={{ fontSize: 11, fill: C_AXIS }} tickFormatter={fmtNum} width={56} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11.5 }} />
                  {(spec.series || []).map((s, i) => (
                    <Bar key={s.name} dataKey={s.name} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[3, 3, 0, 0]} />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>

          {spec.note && (
            <div className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
              <span className="mt-[2px] shrink-0">※</span>
              <span>{spec.note}</span>
            </div>
          )}

          {/* 同源数据表格 */}
          <div className="mt-3 max-h-[220px] overflow-auto rounded-lg border border-[color:var(--wb-border)]">
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-[color:var(--wb-surface-alt)]">
                <tr>
                  {(spec.type === 'scatter'
                    ? [spec.x_label || 'x', spec.y_label || 'y', '标注']
                    : [spec.x_label || '类别', ...(spec.series || []).map((s) => s.name)]
                  ).map((h) => (
                    <th
                      key={h}
                      className="border-b border-[color:var(--wb-border)] px-2.5 py-1.5 text-left font-medium text-[color:var(--wb-text-soft)]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {spec.type === 'scatter'
                  ? (spec.points || []).map((p, i) => (
                      <tr key={i}>
                        <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">{fmtNum(p.x)}</td>
                        <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">{fmtNum(p.y)}</td>
                        <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 text-[color:var(--wb-text-soft)]">
                          {p.label || '—'}
                        </td>
                      </tr>
                    ))
                  : (spec.categories || []).map((c, i) => (
                      <tr key={i}>
                        <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1">{c}</td>
                        {(spec.series || []).map((s) => (
                          <td key={s.name} className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">
                            {fmtNum(s.values[i])}
                          </td>
                        ))}
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>

          {chartTask.data && <AiMeta res={chartTask.data} />}
        </>
      )}
    </Card>
  )
}
