import { useEffect, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Btn, Card, Empty, Input, Pill } from '../components/ui'
import { del, get, post } from '../lib/api'
import { usePersist } from '../lib/state'

const RULE_LABELS: Record<string, string> = {
  weekly_outcome_done: '周成果完成',
  task_done: '任务完成',
  daily_checkin: '日打卡',
  weekly_review: '周复盘',
  paper_stage_advance: '论文阶段推进',
  idea_validated: '创新点验证通过',
  paper_read_done: '读完文献',
  experiment_done: '实验完成',
  weekly_outcome_missed: '周成果未完成',
  bet_lost: '押注失败',
  no_checkin_3days: '连续 3 天未打卡',
  weekly_net_floor: '周净分下限',
}

export default function Points() {
  const [s, setS] = useState<any>(null)
  const [rewards, setRewards] = useState<any[]>([])
  const [bets, setBets] = useState<any[]>([])
  const [rewardForm, setRewardForm] = usePersist('pts.rewardForm', { name: '', cost: 300 })
  const [betForm, setBetForm] = usePersist('pts.betForm', { title: '', amount: 100, due_date: '' })
  const [msg, setMsg] = useState('')

  const load = async () => {
    setS(await get('/points/summary'))
    setRewards(await get('/points/rewards'))
    setBets(await get('/points/bets'))
  }

  useEffect(() => {
    load()
  }, [])

  const setRule = async (key: string, value: string) => {
    await post('/points/rules', { key, value: Number(value) })
    load()
  }

  const redeem = async (id: number) => {
    try {
      await post(`/points/rewards/${id}/redeem`)
      setMsg('')
      load()
    } catch (e: any) {
      setMsg(String(e.message || e))
    }
  }

  const addReward = async () => {
    if (!rewardForm.name.trim()) return
    await post('/points/rewards', { name: rewardForm.name, cost: Number(rewardForm.cost) })
    setRewardForm({ name: '', cost: 300 })
    load()
  }

  const addBet = async () => {
    if (!betForm.title.trim()) return
    await post('/points/bets', betForm)
    setBetForm({ title: '', amount: 100, due_date: '' })
    load()
  }

  const settle = async (id: number, result: string) => {
    await post(`/points/bets/${id}/settle`, { result })
    load()
  }

  if (!s) return <Card>加载中…</Card>

  const trend = (s.trend || []).map((t: any) => ({ date: String(t.date).slice(5), 累计: t.total }))

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <div className="text-[12px] text-slate-500">余额</div>
          <div className="mt-1 text-2xl font-medium text-slate-900">{s.balance}</div>
        </Card>
        <Card>
          <div className="text-[12px] text-slate-500">本周净分</div>
          <div className={`mt-1 text-2xl font-medium ${s.week_net >= 0 ? 'text-slate-900' : 'text-rose-600'}`}>
            {s.week_net >= 0 ? '+' : ''}
            {s.week_net}
          </div>
        </Card>
        <Card>
          <div className="text-[12px] text-slate-500">保护下限</div>
          <div className="mt-1 text-2xl font-medium text-slate-900">{s.rules.weekly_net_floor}</div>
          <div className="mt-1 text-[11px] text-slate-400">超出部分不计分</div>
        </Card>
      </div>

      <Card title="积分曲线">
        {trend.length === 0 ? (
          <Empty text="还没有积分流水" />
        ) : (
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="累计" stroke="#185FA5" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="押注">
          <div className="flex flex-col gap-2">
            <Input placeholder="押什么，例：周三 18:00 前写完 Related Work 初稿" value={betForm.title} onChange={(v) => setBetForm({ ...betForm, title: v })} />
            <div className="flex gap-2">
              <Input className="w-24" type="number" value={betForm.amount} onChange={(v) => setBetForm({ ...betForm, amount: Number(v) })} />
              <Input className="w-40" type="date" value={betForm.due_date} onChange={(v) => setBetForm({ ...betForm, due_date: v })} />
              <Btn variant="primary" onClick={addBet}>
                下注
              </Btn>
            </div>
            <p className="text-[11px] text-slate-400">下注即扣分，达成返还 2 倍。</p>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {bets.length === 0 ? (
              <Empty text="暂无押注" />
            ) : (
              bets.map((b) => (
                <div key={b.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-slate-700">{b.title}</div>
                    <div className="text-[11px] text-slate-400">
                      {b.amount} 分 · {b.due_date || '无截止'}
                    </div>
                  </div>
                  {b.status === 'open' ? (
                    <div className="flex gap-1">
                      <Btn onClick={() => settle(b.id, 'won')}>达成</Btn>
                      <Btn variant="danger" onClick={() => settle(b.id, 'lost')}>
                        失败
                      </Btn>
                    </div>
                  ) : (
                    <Pill tone={b.status === 'won' ? 'green' : 'red'}>
                      {b.status === 'won' ? '已达成' : '已失败'}
                    </Pill>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>

        <Card title="奖励兑换">
          {msg && <div className="mb-2 text-[12px] text-rose-600">{msg}</div>}
          <div className="flex gap-2">
            <Input placeholder="奖励名称" value={rewardForm.name} onChange={(v) => setRewardForm({ ...rewardForm, name: v })} />
            <Input className="w-24" type="number" value={rewardForm.cost} onChange={(v) => setRewardForm({ ...rewardForm, cost: Number(v) })} />
            <Btn onClick={addReward}>添加</Btn>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {rewards.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div>
                  <div className="text-[12px] text-slate-700">{r.name}</div>
                  <div className="text-[11px] text-slate-400">
                    {r.cost} 分 · 已兑 {r.redeemed_count} 次
                  </div>
                </div>
                <div className="flex gap-1">
                  <Btn variant="primary" onClick={() => redeem(r.id)} disabled={s.balance < r.cost}>
                    兑换
                  </Btn>
                  <Btn
                    variant="danger"
                    onClick={async () => {
                      await del(`/points/rewards/${r.id}`)
                      load()
                    }}
                  >
                    删除
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="积分规则（可改）">
        <div className="grid gap-2 md:grid-cols-3">
          {Object.keys(RULE_LABELS).map((k) => (
            <label key={k} className="flex items-center justify-between gap-2 text-[12px] text-slate-600">
              {RULE_LABELS[k]}
              <Input
                className="w-20"
                type="number"
                defaultValue={s.rules[k]}
                onBlur={(e) => setRule(k, e.target.value)}
              />
            </label>
          ))}
        </div>
      </Card>

      <Card title="积分流水">
        {s.ledger.length === 0 ? (
          <Empty />
        ) : (
          <div className="flex flex-col gap-1">
            {s.ledger.map((l: any) => (
              <div key={l.id} className="flex items-center justify-between border-b border-slate-100 py-1 text-[12px] last:border-0">
                <span className="text-slate-600">{l.reason}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400">{String(l.created_at).slice(0, 16)}</span>
                  <span className={l.delta >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                    {l.delta >= 0 ? '+' : ''}
                    {l.delta}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
