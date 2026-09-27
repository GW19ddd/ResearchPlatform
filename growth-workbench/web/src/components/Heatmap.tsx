import { useMemo, useState, type KeyboardEvent } from 'react'

export type HeatDay = {
  date: string
  count: number
  kinds?: Record<string, number>
  labels?: string[]
}

const LEVELS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']

function level(c: number, max: number) {
  if (!c) return 0
  const hi = Math.max(1, max)
  if (c >= Math.max(6, hi * 0.6)) return 4
  if (c >= Math.max(4, hi * 0.35)) return 3
  if (c >= Math.max(2, hi * 0.15)) return 2
  return 1
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 类 GitHub 的贡献热力图：列是周、行是星期几。
 *
 * 明细是**点选**出来的，不是鼠标划过。划过会在格子之间来回触发状态更新，
 * 而下方明细区高度会变（有 labels 就多一截），整页内容跟着上下跳。
 * 现在：点击选中 → 明细常驻；再点一次 / Esc / 关闭按钮取消。
 * 明细区高度固定，换日期也不会把下面的内容推走。
 */
export default function Heatmap({
  days,
  max,
  onPick,
}: {
  days: HeatDay[]
  max?: number
  onPick?: (d: HeatDay) => void
}) {
  const [selDate, setSelDate] = useState<string | null>(null)
  const hi = Math.max(1, max ?? Math.max(...days.map((d) => d.count), 1))

  // 按周切列
  const cols = useMemo(() => {
    const out: HeatDay[][] = []
    let cur: HeatDay[] = []
    for (const d of days) {
      const wd = new Date(d.date + 'T00:00:00').getDay()
      if (wd === 0 && cur.length) {
        out.push(cur)
        cur = []
      }
      cur.push(d)
    }
    if (cur.length) out.push(cur)
    return out
  }, [days])

  // 月份标签：每列第一天的月份变了就打一个
  const months = useMemo(() => {
    const marks: { col: number; label: string }[] = []
    let last = ''
    cols.forEach((c, i) => {
      const first = c[0]
      const m = first.date.slice(0, 7)
      if (m !== last) {
        marks.push({ col: i, label: String(Number(first.date.slice(5, 7))) + '月' })
        last = m
      }
    })
    return marks
  }, [cols])

  const selected = selDate ? days.find((d) => d.date === selDate) || null : null
  const idx = selDate ? days.findIndex((d) => d.date === selDate) : -1

  const choose = (d: HeatDay) => {
    if (selDate === d.date) {
      setSelDate(null) // 再点一次就是取消
      return
    }
    setSelDate(d.date)
    onPick?.(d)
  }

  // 键盘：整个图一个 tab 停靠点，方向键左右是前后一天、上下是前后一周
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const n = days.length
    if (!n) return
    if (e.key === 'Escape') {
      setSelDate(null)
      return
    }
    let next: number | null = null
    if (e.key === 'ArrowRight') next = idx < 0 ? 0 : Math.min(n - 1, idx + 1)
    else if (e.key === 'ArrowLeft') next = idx <= 0 ? 0 : idx - 1
    else if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(n - 1, idx + 7)
    else if (e.key === 'ArrowUp') next = idx < 0 ? 0 : Math.max(0, idx - 7)
    else return
    e.preventDefault()
    setSelDate(days[next].date)
    onPick?.(days[next])
  }

  const CELL = 11
  const GAP = 3
  const step = CELL + GAP

  const kinds = selected?.kinds ? Object.entries(selected.kinds).sort((a, b) => b[1] - a[1]) : []

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto pb-1">
        <div style={{ minWidth: cols.length * step }}>
          <svg
            width={cols.length * step + 28}
            height={7 * step + 20}
            tabIndex={0}
            aria-label="活跃热力图：方向键切换日期，Esc 取消选中"
            onKeyDown={onKey}
            className="rounded-[4px] outline-none focus-visible:shadow-[var(--wb-ring)]"
          >
            <g transform="translate(24, 16)">
              {months.map((m) => (
                <text
                  key={m.col}
                  x={m.col * step}
                  y={-4}
                  fontSize={10}
                  style={{ fill: 'var(--wb-muted)' }}
                >
                  {m.label}
                </text>
              ))}
              {WEEK.map((w, i) =>
                i % 2 === 1 ? (
                  <text
                    key={w}
                    x={-18}
                    y={i * step + CELL - 1}
                    fontSize={9}
                    style={{ fill: 'var(--wb-muted)' }}
                  >
                    {w}
                  </text>
                ) : null
              )}
              {cols.map((col, ci) =>
                col.map((d, ri) => {
                  const on = d.date === selDate
                  return (
                    <rect
                      key={d.date}
                      className={`wb-heat-cell${on ? ' is-sel' : ''}`}
                      x={ci * step}
                      y={ri * step}
                      width={CELL}
                      height={CELL}
                      rx={2}
                      fill={LEVELS[level(d.count, hi)]}
                      stroke="rgba(15,23,42,0.06)"
                      strokeWidth={1}
                      onClick={() => choose(d)}
                    />
                  )
                })
              )}
            </g>
          </svg>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11.5px] text-[color:var(--wb-muted)]">
        <span>点一个格子看当天明细</span>
        <span className="flex items-center gap-1">
          少
          {LEVELS.map((c, i) => (
            <span
              key={i}
              style={{ background: c }}
              className="inline-block h-2.5 w-2.5 rounded-sm"
            />
          ))}
          多
        </span>
      </div>

      {/* 明细区：高度固定，换日期 / 有没有 labels 都不会把下面的内容顶上顶下 */}
      <div
        className="rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2"
        style={{ height: 84 }}
      >
        {selected ? (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[12px] font-semibold text-[color:var(--wb-text)]">
                {selected.date}
              </span>
              <span className="text-[11.5px] text-[color:var(--wb-text-soft)]">
                {selected.count ? (
                  <>
                    有 <b>{selected.count}</b> 次活动
                  </>
                ) : (
                  '无记录'
                )}
              </span>
              {kinds.length > 0 && (
                <span className="min-w-0 truncate text-[11.5px] text-[color:var(--wb-muted)]">
                  {kinds.map(([k, v]) => `${k} ${v}`).join('、')}
                </span>
              )}
              <button
                type="button"
                onClick={() => setSelDate(null)}
                className="ml-auto shrink-0 rounded-[6px] px-1.5 py-[1px] text-[11.5px] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
              >
                关闭
              </button>
            </div>

            <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
              {selected.labels?.length ? (
                <ul className="flex flex-col gap-0.5">
                  {selected.labels.map((l, i) => (
                    <li key={i} className="truncate text-[11.5px] text-[color:var(--wb-text-soft)]">
                      · {l}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[11.5px] text-[color:var(--wb-muted)]">这天没有留下明细</div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center text-[11.5px] text-[color:var(--wb-muted)]">
            选中某一天后，这里显示它做了什么（再点一次或按 Esc 取消）
          </div>
        )}
      </div>
    </div>
  )
}
