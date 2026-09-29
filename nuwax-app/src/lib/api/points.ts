/**
 * 积分引擎 —— 原 FastAPI 后端 points.py 的浏览器端等价实现。
 *
 * 这是产品的核心设计之一：用「周净分保护下限」逼用户把努力落在**本周可交付成果**上，
 * 而不是靠刷小任务攒分。因此 award() 对负分做了双层夹逼：先看本周是否已触底，
 * 再把扣分裁剪到「刚好触底」，且**触底或归零时不写任何流水**——
 * 流水表因此永远只记录真实生效的增减，读起来不糊。
 *
 * 为什么这些函数要 export：research.ts 会在状态翻转时用 `await import('./points')`
 * 跨模块调用 earnOnTransition，避免领域模块之间产生静态循环依赖。
 */
import { route, notFound, badRequest, pick } from './core'
import db, { now, weekStart } from '../db'
import type { Row } from '../db'

/** 默认积分规则。数值与后端逐字对齐，改动会直接影响用户画像，慎动。 */
export const DEFAULT_RULES: Record<string, number> = {
  weekly_outcome_done: 100,
  task_done: 10,
  daily_checkin: 5,
  weekly_review: 30,
  paper_stage_advance: 50,
  idea_validated: 40,
  paper_read_done: 20,
  experiment_done: 60,
  weekly_outcome_missed: -60,
  bet_lost: -100,
  no_checkin_3days: -30,
  weekly_net_floor: -100,
}

/**
 * 读取当前规则：先深拷贝默认值，再用 settings 里 `rule:*` 的覆盖项盖上去。
 * 为什么要深拷贝：DEFAULT_RULES 是模块级常量，若直接改它，页面间会串味。
 * parseInt 解析失败的项直接忽略，防止用户手滑写入脏值后整张规则表报废。
 */
export function getRules(): Record<string, number> {
  const rules: Record<string, number> = { ...DEFAULT_RULES }
  for (const s of db.all('settings')) {
    const key = String(s.key ?? '')
    if (!key.startsWith('rule:')) continue
    const n = parseInt(String(s.value ?? ''), 10)
    if (!Number.isNaN(n)) rules[key.slice(5)] = n
  }
  return rules
}

/** 全部流水 delta 之和，即账户余额 */
export function balance(): number {
  let sum = 0
  for (const r of db.all('points_ledger')) sum += Number(r.delta ?? 0)
  return Math.trunc(sum)
}

/**
 * 某个自然周的净分。created_at 形如 `YYYY-MM-DDTHH:MM:SS`，
 * 与 `YYYY-MM-DD` 做字典序比较，等价于「该日 0 点之后」，无需解析日期对象。
 */
export function weekNet(weekStartDate?: string): number {
  const ws = weekStartDate || weekStart()
  let sum = 0
  for (const r of db.all('points_ledger')) {
    if (String(r.created_at ?? '') >= ws) sum += Number(r.delta ?? 0)
  }
  return Math.trunc(sum)
}

export interface AwardResult {
  applied: number
  reason: string
  clamped: boolean
}

/**
 * 记一笔积分，并对负分施加「周净分保护下限」。
 *
 * 关键行为（与后端一致）：
 * - 判断是 `current <= floor`，即**小于等于**即视为触底；
 * - 触底时直接返回，不读不写流水；
 * - 未触底时把 applied 裁到 [floor-current, 0]，即最多扣到刚好触底；
 * - applied === 0 时同样不写流水；
 * - 正分无上限、无保护。
 * 返回值刻意不含 id / balance，避免调用方误当成账户快照。
 */
export function award(
  delta: number,
  reason: string,
  refType: string,
  refId: number | string | null,
): AwardResult {
  const rules = getRules()
  let applied = Math.trunc(delta)

  if (delta < 0) {
    const floor = Number(rules.weekly_net_floor ?? -100)
    const current = weekNet()
    // 本周已经跌到或跌破下限：不再扣，也不留流水，避免「越扣越像欠债」
    if (current <= floor) return { applied: 0, reason, clamped: true }
    applied = Math.min(Math.max(floor - current, delta), 0)
  }

  // 归零意味着本次调整无实际效果，不落库
  if (applied === 0) return { applied: 0, reason, clamped: true }

  db.insert('points_ledger', {
    delta: applied,
    reason,
    ref_type: refType,
    ref_id: refId,
    created_at: now(),
  })
  return { applied, reason, clamped: applied !== delta }
}

/** 按规则名取分值再调用 award；reason 缺省时用规则名兜底，保证流水可读 */
export function earn(
  ruleKey: string,
  reason: string,
  refType: string,
  refId: number | string | null,
): AwardResult {
  const rules = getRules()
  return award(Number(rules[ruleKey] ?? 0), reason || ruleKey, refType, refId)
}

/**
 * 状态机式加分：仅当字段**迁移到目标值**时给分。
 * 判断「before 为空 或 before 字段不等于目标」——首次进入目标态也算迁移，
 * 这样研究模块把状态从 null/undefined 直接设为终态时不会漏分；
 * 重复保存同一状态则不会重复给分。
 */
export function earnOnTransition(
  before: Row | null | undefined,
  after: Row | null | undefined,
  field: string,
  target: unknown,
  ruleKey: string,
  reason?: string,
  refType?: string,
  refId?: number | string | null,
): AwardResult | null {
  if (!after || after[field] !== target) return null
  if (before && before[field] === target) return null
  return earn(ruleKey, reason || ruleKey, refType || '', refId ?? null)
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 按 created_at 前 10 位（日期）分组求和，用于首页积分曲线 */
function trendGroups(limit: number) {
  const byDate = new Map<string, number>()
  for (const r of db.all('points_ledger')) {
    const date = String(r.created_at ?? '').slice(0, 10)
    byDate.set(date, (byDate.get(date) ?? 0) + Number(r.delta ?? 0))
  }
  const groups = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(-limit)
  // total 是「窗口内累计」：从窗口第一天起算，而不是全局余额，
  // 这样曲线起点归零，用户看的是近 30 个活跃日的净增趋势
  let acc = 0
  return groups.map(([date, delta]) => {
    acc += delta
    return { date, delta, total: acc }
  })
}

route('GET', '/points/summary', () => {
  const ledger = db
    .all('points_ledger')
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 50)
  return {
    balance: balance(),
    week_net: weekNet(),
    rules: getRules(),
    ledger,
    trend: trendGroups(30),
  }
})

// 规则字典对象本身（不是数组），前端直接 Object.keys 渲染表单
route('GET', '/points/rules', () => getRules())

route('POST', '/points/rules', (ctx) => {
  const body: any = ctx.body
  const key = body?.key
  const value = body?.value
  if (key == null || key === '') badRequest('key is required')
  if (value == null || value === '') badRequest('value is required')
  // 统一字符串化后落 settings，getRules 读取时再 parseInt
  db.setSetting(`rule:${String(key)}`, String(value))
  return getRules()
})

route('GET', '/points/bets', () =>
  db.all('bets').sort((a, b) => Number(b.id) - Number(a.id)),
)

route('POST', '/points/bets', (ctx) => {
  const body: any = ctx.body
  const title = String(pick(body, 'title', '') ?? '').trim()
  if (!title) badRequest('title is required')
  const amount = Number(pick(body, 'amount', 100))
  const row = db.insert('bets', {
    title,
    amount,
    due_date: pick<any>(body, 'due_date', ''),
    status: 'open',
    created_at: now(),
  })
  // 下注即先扣分（受周净分下限约束）；达成后返还 2 倍
  award(-amount, `押注：${title}`, 'bet', row.id)
  return { ok: true, id: row.id, balance: balance() }
})

route('POST', '/points/bets/:id/settle', (ctx) => {
  const body: any = ctx.body
  const result = pick<any>(body, 'result', '')
  if (result !== 'won' && result !== 'lost') badRequest('result must be won or lost')

  const bet = db.get('bets', Number(ctx.params.id))
  if (!bet) notFound('bet')

  db.update('bets', bet.id, { status: result })
  const amount = Number(bet.amount || 0)
  if (result === 'won') award(amount * 2, `押注达成：${bet.title}`, 'bet', bet.id)
  else award(0, `押注失败：${bet.title}`, 'bet', bet.id)
  return { ok: true, balance: balance() }
})

route('GET', '/points/rewards', () =>
  db.all('rewards').sort((a, b) => Number(a.cost ?? 0) - Number(b.cost ?? 0)),
)

route('POST', '/points/rewards', (ctx) => {
  const body: any = ctx.body
  const name = String(pick(body, 'name', '') ?? '').trim()
  if (!name) badRequest('name is required')
  const cost = Number(pick(body, 'cost', 0))
  if (!(cost > 0)) badRequest('cost must be greater than 0')
  const row = db.insert('rewards', { name, cost })
  return { id: row.id, name: row.name, cost: row.cost, redeemed_count: row.redeemed_count ?? 0 }
})

route('DELETE', '/points/rewards/:id', (ctx) => {
  db.remove('rewards', Number(ctx.params.id))
  return { ok: true }
})

route('POST', '/points/rewards/:id/redeem', (ctx) => {
  const reward = db.get('rewards', Number(ctx.params.id))
  if (!reward) notFound('reward')

  const cost = Number(reward.cost || 0)
  const bal = balance()
  // 余额不足时精确告诉用户还差多少，避免模糊的「兑换失败」
  if (bal < cost) badRequest(`积分不足，还差 ${cost - bal} 分`)

  award(-cost, `兑换奖励：${reward.name}`, 'reward', reward.id)
  db.update('rewards', reward.id, { redeemed_count: Number(reward.redeemed_count || 0) + 1 })
  return { ok: true, balance: balance() }
})
