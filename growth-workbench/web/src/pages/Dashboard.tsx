import { useEffect, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Btn, Card, Empty, Input, Loading, Pill, Segmented, StatCard } from '../components/ui'
import { toast } from '../components/toast'
import Heatmap, { HeatDay } from '../components/Heatmap'
import { get, post } from '../lib/api'
import { usePersist } from '../lib/state'

// recharts 把颜色写成 SVG 属性，var() 在属性里不生效，这里用令牌的十六进制值
const C_FOCUS = '#4f46e5'
const C_SLEEP = '#0f9d58'
const AXIS = '#8a94a6'
const GRID = '#e3e6ea'

const HEAT_RANGES = [
  { value: '91', label: '3 个月' },
  { value: '182', label: '半年' },
  { value: '365', label: '一年' },
]

/** 线性插值取分位数（样本少的时候也够稳） */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * 睡眠的纵轴范围。
 *
 * 睡眠是 6-9 小时的窄幅数据，跟专注（几百分钟）共用一根轴会被压成一条直线，
 * 所以单独给它一根右轴。范围不能简单取 min/max：只要有一天填错写成 12 小时，
 * 轴就会被撑到 [6,12]，剩下那些 6.5↔8.0 的真实起伏又变成一条平线——
 * 所以先按 IQR 剔掉离群点定出主体区间，再把离群点截断到边界（悬停仍显示真实值）。
 * 另外保证至少 3 小时跨度，免得 7.0 / 7.2 被画成天壤之别。
 */
function sleepAxis(vals: number[]): { lo: number; hi: number } {
  const v = vals
    .filter((x) => typeof x === 'number' && !Number.isNaN(x))
    .sort((a, b) => a - b)
  if (!v.length) return { lo: 0, hi: 10 }
  const q1 = quantile(v, 0.25)
  const q3 = quantile(v, 0.75)
  const iqr = q3 - q1
  const core = v.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr)
  const use = core.length ? core : v
  let lo = Math.max(0, Math.floor(Math.min(...use) - 0.5))
  let hi = Math.ceil(Math.max(...use) + 0.5)
  if (hi - lo < 3) {
    const mid = (hi + lo) / 2
    lo = Math.max(0, Math.round(mid - 1.5))
    hi = lo + 3
  }
  return { lo, hi }
}

export default function Dashboard() {
  const [data, setData] = useState<any>(null)
  const [heat, setHeat] = useState<any>(null)
  const [heatRange, setHeatRange] = usePersist('dash.heatRange', '182')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [form, setForm] = usePersist<any>('dash.form', {
    sleep_h: '7',
    exercise_min: '30',
    focus_min: '240',
    mood: '3',
    note: '',
  })

  const load = async () => {
    try {
      setData(await get('/dashboard'))
      setErr('')
    } catch (e: any) {
      setErr(String(e.message || e))
    }
  }

  const loadHeat = async () => {
    try {
      setHeat(await get(`/activity/heatmap?days=${heatRange}`))
    } catch {
      setHeat(null)
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    loadHeat()
  }, [heatRange])

  const checkin = async () => {
    setSaving(true)
    try {
      const r: any = await post(
        '/plan/checkin',
        {
          sleep_h: Number(form.sleep_h || 0),
          exercise_min: Number(form.exercise_min || 0),
          focus_min: Number(form.focus_min || 0),
          mood: Number(form.mood || 3),
          note: form.note,
        },
        // 文案要区分「首次打卡给分」和「改今天的记录」，所以自己弹，不走默认提示
        { ok: false },
      )
      toast(r?.rewarded ? '打卡成功，积分已到账' : '今日打卡已更新', 'ok')
      setForm({ ...form, note: '' })
      await load()
      loadHeat() // 打卡本身也是活跃行为，热力图要跟着亮
    } finally {
      setSaving(false)
    }
  }

  if (err) {
    return (
      <Card title="连接失败">
        <span className="text-[12.5px] text-[color:var(--wb-text-soft)]">{err}</span>
        <div className="mt-2 text-[12px] text-[color:var(--wb-muted)]">
          确认后端已启动：<code>uvicorn main:app --reload --port 8000</code>
        </div>
        <Btn className="mt-3" onClick={load}>
          重试
        </Btn>
      </Card>
    )
  }
  if (!data) return <Loading text="正在加载今日概览…" />

  // 缺数据那天留 null，折线断开，而不是掉到 0 被当成「专注 0 分钟」
  const sleepRaw = (data.checkins || []).map((c: any) =>
    c.sleep_h ? Math.round(Number(c.sleep_h) * 10) / 10 : null,
  )
  const sAxis = sleepAxis(sleepRaw)
  const clipped = sleepRaw.filter((x: any) => x !== null && (x < sAxis.lo || x > sAxis.hi)).length
  const chartData = (data.checkins || []).map((c: any, i: number) => ({
    date: String(c.date).slice(5),
    专注: c.focus_min ? Number(c.focus_min) : null,
    // 画出来的是截断到轴内的值，真实值放在 sleepRaw 里给悬停用
    睡眠:
      sleepRaw[i] === null
        ? null
        : Math.min(sAxis.hi, Math.max(sAxis.lo, sleepRaw[i] as number)),
    sleepRaw: sleepRaw[i],
  }))

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {/* 四个指标量纲各不相同，单位一律单独写，不靠读者自己猜 */}
        <StatCard
          label="积分余额"
          value={data.points.balance}
          unit="分"
          tone={data.points.balance >= 0 ? 'ok' : 'danger'}
          hint={`本周净 ${data.points.week_net >= 0 ? '+' : ''}${data.points.week_net} 分（保护下限 ${data.points.floor} 分）`}
        />
        <StatCard
          label="论文进度"
          value={data.paper.progress}
          unit="%"
          hint={`字数 ${data.paper.words} / ${data.paper.target_words} 字`}
        />
        <StatCard
          label="待读文献"
          value={(data.literature.todo || 0) + (data.literature.reading || 0)}
          unit="篇"
          hint={`已读 ${data.literature.done || 0} 篇 · 待读 ${data.literature.todo || 0} / 在读 ${data.literature.reading || 0}`}
        />
        <StatCard
          label="未闭合承诺"
          value={data.commitments.open}
          unit="项"
          tone={data.commitments.overdue > 0 ? 'danger' : 'default'}
          hint={data.commitments.overdue > 0 ? `逾期 ${data.commitments.overdue} 项` : '暂无逾期'}
        />
      </div>

      <Card
        title="活跃热力图"
        extra={
          <div className="flex items-center gap-2">
            {heat && (
              <span className="hidden text-[11px] text-[color:var(--wb-muted)] sm:inline">
                共 {heat.total} 次 · 活跃 {heat.active_days} 天 · 连续 {heat.streak} 天（最长{' '}
                {heat.best_streak}）
              </span>
            )}
            <Segmented value={heatRange} onChange={setHeatRange} options={HEAT_RANGES} />
          </div>
        }
      >
        {!heat || heat.days.length === 0 ? (
          <Empty text="暂无活动记录" />
        ) : (
          <Heatmap days={heat.days as HeatDay[]} max={heat.max} />
        )}
        <p className="mt-2 text-[11px] text-[color:var(--wb-muted)]">
          统计范围：{heatRange} 天内的活跃记录。文献 / 创新点 / 实验 / 笔记 / 画布运行 / 对话 / 积分 /
          打卡，任何一天动了东西都会点亮；同一条目同一天只算一次。
          <br />
          图例：颜色越深当天动作越多；灰色 = 当天无记录（不是 0 次，是没记录）。
        </p>
      </Card>

      {data.paper.blocked?.length > 0 && (
        <div className="rounded-[12px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-4 py-3">
          <div className="text-[13px] font-medium text-[color:var(--wb-danger)]">
            论文卡住了：{data.paper.blocked.map((b: any) => b.name).join('、')}
          </div>
          <div className="mt-1 text-[12px] text-[color:var(--wb-danger)]/85">
            {data.paper.blocked[0].blocker || '未填写卡点描述'}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card
          className="md:col-span-2"
          title="近 14 天状态"
          extra={
            <span className="text-[11px] text-[color:var(--wb-muted)]">
              左轴 专注（分钟）· 右轴 睡眠（小时）
              {clipped > 0 ? ` · ${clipped} 天离群已截断` : ''}
            </span>
          }
        >
          {chartData.length === 0 ? (
            <Empty text="还没有打卡记录" hint="右边打一次卡，这里就会有曲线" />
          ) : (
            <>
              <div className="mb-1 text-[11px] text-[color:var(--wb-muted)]">
                缺失数据不补 0：某天没填的项折线直接断开，悬停也能看到当天只填了哪一项。
              </div>
              <div style={{ height: 236 }}>
                <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 6, bottom: 0, left: -6 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} />
                  <YAxis
                    yAxisId="focus"
                    tick={{ fontSize: 11, fill: AXIS }}
                    tickLine={false}
                    width={44}
                    tickFormatter={(v: number) => `${v}m`}
                  />
                  <YAxis
                    yAxisId="sleep"
                    orientation="right"
                    domain={[sAxis.lo, sAxis.hi]}
                    allowDecimals
                    tick={{ fontSize: 11, fill: AXIS }}
                    tickLine={false}
                    width={34}
                    tickFormatter={(v: number) => `${v}h`}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 10,
                      border: '1px solid #e3e6ea',
                      boxShadow: '0 4px 12px rgba(16,24,40,0.08)',
                    }}
                    formatter={(v: any, n: any, item: any) => {
                      if (n === '睡眠') {
                        const real = item?.payload?.sleepRaw
                        return [`${real ?? v} 小时`, n]
                      }
                      return [`${v} 分钟`, n]
                    }}
                  />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    yAxisId="focus"
                    type="monotone"
                    dataKey="专注"
                    stroke={C_FOCUS}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    connectNulls
                  />
                  <Line
                    yAxisId="sleep"
                    type="monotone"
                    dataKey="睡眠"
                    stroke={C_SLEEP}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    connectNulls
                  />
                </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Card>

        <Card
          title={data.checkin_today ? '今日已打卡' : '今日打卡'}
          extra={
            data.checkin_today ? <Pill tone="green">已记录</Pill> : <Pill tone="amber">待打卡</Pill>
          }
        >
          <div className="flex flex-col gap-2.5">
            <label className="flex items-center justify-between text-[12px] text-[color:var(--wb-text-soft)]">
              睡眠(h)
              <Input
                className="w-20"
                type="number"
                value={form.sleep_h}
                onChange={(v) => setForm({ ...form, sleep_h: v })}
              />
            </label>
            <label className="flex items-center justify-between text-[12px] text-[color:var(--wb-text-soft)]">
              运动(min)
              <Input
                className="w-20"
                type="number"
                value={form.exercise_min}
                onChange={(v) => setForm({ ...form, exercise_min: v })}
              />
            </label>
            <label className="flex items-center justify-between text-[12px] text-[color:var(--wb-text-soft)]">
              专注(min)
              <Input
                className="w-20"
                type="number"
                value={form.focus_min}
                onChange={(v) => setForm({ ...form, focus_min: v })}
              />
            </label>
            <label className="flex items-center justify-between text-[12px] text-[color:var(--wb-text-soft)]">
              心情(1-5)
              <Input
                className="w-20"
                type="number"
                value={form.mood}
                onChange={(v) => setForm({ ...form, mood: v })}
              />
            </label>
            <Input
              placeholder="一句话（可选）"
              value={form.note}
              onChange={(v) => setForm({ ...form, note: v })}
            />
            <Btn variant="primary" loading={saving} onClick={checkin}>
              {data.checkin_today ? '更新今日打卡' : '打卡'}
            </Btn>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="对导师的承诺">
          {data.commitments.items.length === 0 ? (
            <Empty text="没有逾期承诺" />
          ) : (
            <ul className="flex flex-col gap-2">
              {data.commitments.items.map((n: any) => (
                <li
                  key={n.id}
                  className="flex items-start justify-between gap-2 rounded-[10px] bg-[color:var(--wb-danger-soft)] px-3 py-2"
                >
                  <span className="text-[12px] text-[color:var(--wb-danger)]">
                    {n.my_commitment || '（空）'}
                  </span>
                  <Pill tone="red">{n.due_date}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="当前阶段">
          {data.paper.current ? (
            <div>
              <div className="text-[13px] font-medium text-[color:var(--wb-text)]">
                {data.paper.current.name}
              </div>
              <div className="mt-2 text-[12px] text-[color:var(--wb-text-soft)]">
                下一步：{data.paper.current.next_action || '未填写'}
              </div>
              {data.paper.current.stuck_days > 0 && (
                <div className="mt-2 text-[12px] text-[color:var(--wb-danger)]">
                  已卡 {data.paper.current.stuck_days} 天
                </div>
              )}
            </div>
          ) : (
            <Empty text="暂无进行中阶段" />
          )}
        </Card>
      </div>
    </div>
  )
}
