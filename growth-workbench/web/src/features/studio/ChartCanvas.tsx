/**
 * 图表 spec 的实时渲染件（bar / line / scatter + 同源数据表）。
 *
 * 与 features/experiments/ResultChart.tsx 用同一套 ChartSpec 结构和配色，
 * 这样「实验页 AI 生成的图」和「绘图工作室手调的图」不会长成两套东西。
 * 校验口径也一致：只画 spec 里真实存在的数字，维度对不上就不画，不补点、不推算。
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Icon } from '../../components/Icon'
import { C_ACCENT, C_AXIS, C_DANGER, C_GRID, C_OK, C_WARN } from '../../lib/chartTokens'

/** 参考线（照参考图的虚线阈值 / 区域标注，如 χ1 的 gauche− / gauche+ / trans）。 */
export type ChartGuide = {
  axis?: 'x' | 'y'
  value: number
  label?: string
  color?: string
}

/** 多面板图里的单个小面板：与整图同构（散点用 points，柱/线用 categories + series）。 */
export type ChartPanel = {
  type?: 'bar' | 'line' | 'scatter'
  title?: string
  x_label?: string
  y_label?: string
  categories?: string[]
  series?: { name: string; values: number[] }[]
  points?: { x: number; y: number; label?: string | null }[]
}

export type ChartSpec = {
  type: 'bar' | 'line' | 'scatter' | 'none'
  title?: string
  x_label?: string
  y_label?: string
  note?: string
  colors?: string[]
  categories?: string[]
  series?: { name: string; values: number[] }[]
  points?: { x: number; y: number; label?: string | null }[]
  /** 多面板（small multiples）：给了 panels 就按面板网格画，忽略顶层 categories / points。 */
  panels?: ChartPanel[]
  /** 参考线（横线为主），用于复刻参考图里的阈值 / 区域线。 */
  guides?: ChartGuide[]
  /** 点径（px，散点/点标记）；默认 4，参考图那种小圆点用 3。 */
  point_radius?: number
  /** 显式坐标域，避免多面板各自缩放导致不可比。 */
  x_domain?: [number, number]
  y_domain?: [number, number]
  /** 来源说明：这块 spec 是从哪张画廊参考图复刻来的（展示用，不参与绘图）。 */
  reference?: { id?: string; repo?: string; plot_type?: string; preview_path?: string }
  reason?: string
}

const SERIES_COLORS = [C_ACCENT, C_OK, C_WARN, C_DANGER]

/** 优先用 spec 自带的配色，否则回退到全站色板。 */
function seriesColor(spec: ChartSpec, i: number): string {
  const colors = spec.colors?.filter(Boolean)
  if (colors && colors.length) return colors[i % colors.length]
  return SERIES_COLORS[i % SERIES_COLORS.length]
}

const fmtNum = (v: number) =>
  Math.abs(v) >= 1000 ? v.toLocaleString() : String(Math.round(v * 10000) / 10000)

/** 渲染前的硬校验：返回 null 才可画，返回字符串就是给人看的原因。 */
export function specError(spec: ChartSpec | null): string | null {
  if (!spec) return '还没有图表 spec'
  if (spec.type === 'none') return spec.reason || '这批数据不适合画图'
  if (!['bar', 'line', 'scatter'].includes(spec.type)) return `未知图表类型：${spec.type}`
  if (spec.panels?.length) {
    const ok = spec.panels.some((p) => {
      const t = p.type || spec.type
      if (t === 'scatter') {
        return (p.points || []).filter(
          (q) => q && Number.isFinite(Number(q.x)) && Number.isFinite(Number(q.y)),
        ).length >= 2
      }
      const cats = p.categories || []
      return (
        cats.length > 0 &&
        (p.series || []).some(
          (s) => Array.isArray(s.values) && s.values.length === cats.length && s.values.every((v) => Number.isFinite(Number(v))),
        )
      )
    })
    return ok ? null : '多面板图每个面板都需要可画的数据（散点 ≥ 2 个 x/y 点；柱/线须 categories 与 values 等长）'
  }
  if (spec.type === 'scatter') {
    const pts = (spec.points || []).filter(
      (p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)),
    )
    return pts.length >= 2 ? null : '散点图至少需要 2 个含数值 x / y 的点'
  }
  const cats = spec.categories || []
  if (!cats.length) return 'bar / line 需要 categories（x 轴刻度）'
  const valid = (spec.series || []).filter(
    (s) =>
      Array.isArray(s.values) &&
      s.values.length === cats.length &&
      s.values.every((v) => Number.isFinite(Number(v))),
  )
  return valid.length
    ? null
    : 'series 的 values 必须与 categories 等长且全是数字（不自动补点、不推算）'
}

export default function ChartCanvas({ spec, height = 300 }: { spec: ChartSpec; height?: number }) {
  const err = specError(spec)
  if (err) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)]">
          <Icon name="alert" size={17} className="text-[color:var(--wb-warn)]" />
        </span>
        <div className="text-[12.5px] font-medium text-[color:var(--wb-text-soft)]">这张图暂时画不出来</div>
        <div className="max-w-[52ch] text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{err}</div>
      </div>
    )
  }

  const panels = spec.panels?.length ? spec.panels : null
  const guides = (spec.guides || []).filter((g) => Number.isFinite(Number(g.value)))

  const validSeries = (spec.series || []).filter(
    (s) => Array.isArray(s.values) && s.values.length === (spec.categories || []).length,
  )
  const rows = (spec.categories || []).map((c, i) => {
    const row: Record<string, number | string> = { x: c }
    for (const s of validSeries) row[s.name] = Number(s.values[i])
    return row
  })
  const pts = (spec.points || []).filter(
    (p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)),
  )

  /** 单图与多面板的每个面板共用同一套渲染（结构一致，只是数据源不同）。 */
  const renderChart = (p: ChartPanel, compact: boolean) => {
    const t = (p.type || (spec.type === 'none' ? 'scatter' : spec.type)) as 'bar' | 'line' | 'scatter'
    const margin = compact ? { top: 6, right: 8, bottom: 2, left: 0 } : { top: 8, right: 16, bottom: 4, left: 0 }
    const yGuides = guides.filter((g) => (g.axis || 'y') === 'y')
    const xGuides = guides.filter((g) => g.axis === 'x')

    if (t === 'scatter') {
      const pPts = (p.points || []).filter(
        (q) => q && Number.isFinite(Number(q.x)) && Number.isFinite(Number(q.y)),
      )
      const r = spec.point_radius ?? (compact ? 2.6 : 3.4)
      return (
        <ScatterChart margin={compact ? { top: 6, right: 10, bottom: 14, left: -14 } : { top: 8, right: 16, bottom: 22, left: -8 }}>
          <CartesianGrid stroke={C_GRID} />
          <XAxis
            type="number"
            dataKey="x"
            domain={spec.x_domain || ['dataMin', 'dataMax']}
            allowDecimals={false}
            tick={{ fontSize: compact ? 9.5 : 11, fill: C_AXIS }}
            tickFormatter={fmtNum}
            tickCount={compact ? 5 : 7}
            height={compact ? 30 : 44}
            label={
              (compact ? p.x_label : spec.x_label)
                ? {
                    value: (compact ? p.x_label : spec.x_label) as string,
                    position: 'insideBottom',
                    offset: -4,
                    fontSize: compact ? 9.5 : 11,
                    fill: C_AXIS,
                  }
                : undefined
            }
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={spec.y_domain || ['dataMin', 'dataMax']}
            allowDecimals={false}
            tick={{ fontSize: compact ? 9.5 : 11, fill: C_AXIS }}
            tickFormatter={fmtNum}
            tickCount={compact ? 5 : 7}
            width={compact ? 34 : 52}
            label={
              (compact ? p.y_label : spec.y_label)
                ? {
                    value: (compact ? p.y_label : spec.y_label) as string,
                    angle: -90,
                    position: 'insideLeft',
                    offset: 12,
                    fontSize: compact ? 9.5 : 11,
                    fill: C_AXIS,
                  }
                : undefined
            }
          />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            formatter={(v: any) => fmtNum(Number(v))}
            labelFormatter={() => ''}
            contentStyle={{ fontSize: 12 }}
          />
          {yGuides.map((g, i) => (
            <ReferenceLine
              key={`y${i}`}
              y={Number(g.value)}
              stroke={g.color || C_AXIS}
              strokeDasharray="4 3"
              strokeWidth={1}
              label={
                g.label
                  ? {
                      value: g.label,
                      position: 'right',
                      fontSize: 8.5,
                      fill: g.color || C_AXIS,
                      offset: 4,
                    }
                  : undefined
              }
            />
          ))}
          {xGuides.map((g, i) => (
            <ReferenceLine
              key={`x${i}`}
              x={Number(g.value)}
              stroke={g.color || C_AXIS}
              strokeDasharray="4 3"
              strokeWidth={1}
            />
          ))}
          <Scatter
            data={pPts}
            fill={seriesColor(spec, 0)}
            shape="circle"
            isAnimationActive={false}
            {...({ r } as any)}
          />
        </ScatterChart>
      )
    }

    const pCats = p.categories || []
    const pSeries = (p.series || []).filter((s) => Array.isArray(s.values) && s.values.length === pCats.length)
    const pRows = pCats.map((c, i) => {
      const row: Record<string, number | string> = { x: c }
      for (const s of pSeries) row[s.name] = Number(s.values[i])
      return row
    })
    const guideLines = yGuides.map((g, i) => (
      <ReferenceLine
        key={`y${i}`}
        y={Number(g.value)}
        stroke={g.color || C_AXIS}
        strokeDasharray="4 3"
        strokeWidth={1.2}
      />
    ))

    if (t === 'line') {
      return (
        <LineChart data={pRows} margin={margin}>
          <CartesianGrid stroke={C_GRID} />
          <XAxis dataKey="x" tick={{ fontSize: compact ? 10 : 11, fill: C_AXIS }} interval={0} />
          <YAxis tick={{ fontSize: compact ? 10 : 11, fill: C_AXIS }} tickFormatter={fmtNum} width={compact ? 40 : 56} />
          <Tooltip contentStyle={{ fontSize: 12 }} />
          {!compact && <Legend wrapperStyle={{ fontSize: 11.5 }} />}
          {guideLines}
          {pSeries.map((s, i) => (
            <Line
              key={s.name}
              type="monotone"
              dataKey={s.name}
              stroke={seriesColor(spec, i)}
              strokeWidth={2}
              dot={{ r: compact ? 2.5 : 3 }}
            />
          ))}
        </LineChart>
      )
    }

    return (
      <BarChart data={pRows} margin={margin}>
        <CartesianGrid stroke={C_GRID} />
        <XAxis dataKey="x" tick={{ fontSize: compact ? 10 : 11, fill: C_AXIS }} interval={0} />
        <YAxis tick={{ fontSize: compact ? 10 : 11, fill: C_AXIS }} tickFormatter={fmtNum} width={compact ? 40 : 56} />
        <Tooltip contentStyle={{ fontSize: 12 }} />
        {!compact && <Legend wrapperStyle={{ fontSize: 11.5 }} />}
        {guideLines}
        {pSeries.map((s, i) => (
          <Bar key={s.name} dataKey={s.name} fill={seriesColor(spec, i)} radius={[3, 3, 0, 0]} />
        ))}
      </BarChart>
    )
  }

  const panelType = (panels?.[0]?.type || (spec.type === 'none' ? 'scatter' : spec.type)) as
    | 'bar'
    | 'line'
    | 'scatter'
  const pxLabel = panels?.[0]?.x_label || spec.x_label
  const pyLabel = panels?.[0]?.y_label || spec.y_label
  const tableHead = panels
    ? panelType === 'scatter'
      ? ['面板', pxLabel || 'x', pyLabel || 'y', '标注']
      : ['面板', pxLabel || '类别', ...((panels[0]?.series || []).map((s) => s.name) || [])]
    : spec.type === 'scatter'
      ? [spec.x_label || 'x', spec.y_label || 'y', '标注']
      : [spec.x_label || '类别', ...validSeries.map((s) => s.name)]

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto px-4 pb-4 pt-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-[color:var(--wb-text)]">
          {spec.title || '未命名图表'}
        </span>
        <span className="whitespace-nowrap text-[11px] text-[color:var(--wb-muted)]">
          {(panels
            ? [
                panels.length > 1 ? `${panels.length} 个面板` : '',
                (panels[0]?.x_label || spec.x_label) && `x：${panels[0]?.x_label || spec.x_label}`,
                (panels[0]?.y_label || spec.y_label) && `y：${panels[0]?.y_label || spec.y_label}`,
              ]
            : [spec.x_label && `x：${spec.x_label}`, spec.y_label && `y：${spec.y_label}`]
          )
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>

      {panels ? (
        <div
          className="grid shrink-0 gap-x-3 gap-y-2"
          style={{ gridTemplateColumns: `repeat(${Math.min(panels.length, 4)}, minmax(0, 1fr))` }}
        >
          {panels.map((p, i) => (
            <div key={i} className="min-w-0">
              <p className="mb-0.5 truncate text-center text-[11px] font-medium text-[color:var(--wb-text-soft)]">
                {p.title || `Panel ${String.fromCharCode(65 + i)}`}
              </p>
              <div style={{ height: Math.max(210, Math.round(height * 1.05)) }}>
                <ResponsiveContainer width="100%" height="100%">
                  {renderChart(p, true)}
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="shrink-0" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {renderChart(
              { type: spec.type as 'bar' | 'line' | 'scatter', categories: spec.categories, series: spec.series, points: spec.points },
              false,
            )}
          </ResponsiveContainer>
        </div>
      )}

      {/* 参考线图例：照参考图的虚线阈值标注 */}
      {guides.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--wb-text-soft)]">
          <span className="text-[color:var(--wb-muted)]">参考线</span>
          {guides.map((g, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-0 w-4 border-t border-dashed"
                style={{ borderColor: g.color || C_AXIS }}
              />
              {g.label || `${g.axis === 'x' ? 'x' : 'y'} = ${fmtNum(Number(g.value))}`}
            </span>
          ))}
        </div>
      )}

      {spec.note && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
          <span className="mt-[2px] shrink-0">※</span>
          <span>{spec.note}</span>
        </div>
      )}

      {/* 同源数据表：图上的每个数字都能在这张表里找到 */}
      <div className="mt-3 overflow-auto rounded-lg border border-[color:var(--wb-border)]">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-[color:var(--wb-surface-alt)]">
            <tr>
              {tableHead.map((h) => (
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
            {panels
              ? panels.flatMap((p, pi) => {
                  const pCats = p.categories || []
                  const pSeries = (p.series || []).filter((s) => Array.isArray(s.values) && s.values.length === pCats.length)
                  const title = p.title || `Panel ${String.fromCharCode(65 + pi)}`
                  if (panelType === 'scatter') {
                    const pPts = (p.points || []).filter(
                      (q) => q && Number.isFinite(Number(q.x)) && Number.isFinite(Number(q.y)),
                    )
                    return pPts.map((q, i) => (
                      <tr key={`${pi}-${i}`}>
                        <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 text-[color:var(--wb-text-soft)]">{title}</td>
                        <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">{fmtNum(Number(q.x))}</td>
                        <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">{fmtNum(Number(q.y))}</td>
                        <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 text-[color:var(--wb-muted)]">
                          {q.label || '—'}
                        </td>
                      </tr>
                    ))
                  }
                  return pCats.map((c, i) => (
                    <tr key={`${pi}-${i}`}>
                      <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 text-[color:var(--wb-text-soft)]">{title}</td>
                      <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1">{c}</td>
                      {pSeries.map((s) => (
                        <td key={s.name} className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">
                          {fmtNum(Number(s.values[i]))}
                        </td>
                      ))}
                    </tr>
                  ))
                })
              : spec.type === 'scatter'
                ? pts.map((p, i) => (
                    <tr key={i}>
                      <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">{fmtNum(Number(p.x))}</td>
                      <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">{fmtNum(Number(p.y))}</td>
                      <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1 text-[color:var(--wb-text-soft)]">
                        {p.label || '—'}
                      </td>
                    </tr>
                  ))
                : (spec.categories || []).map((c, i) => (
                    <tr key={i}>
                      <td className="border-b border-[color:var(--wb-border)] px-2.5 py-1">{c}</td>
                      {validSeries.map((s) => (
                        <td key={s.name} className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono">
                          {fmtNum(Number(s.values[i]))}
                        </td>
                      ))}
                    </tr>
                  ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

