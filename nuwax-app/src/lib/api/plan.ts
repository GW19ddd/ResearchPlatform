/**
 * 周计划 / 任务 / 日打卡 / 周复盘 / 双周汇报 —— 原 plan.py 的浏览器端实现。
 *
 * 设计主线：把「努力」翻译成可验证的成果。因此周复盘是**唯一**的结算入口，
 * 且只结算一次（first_time 语义）——重复提交复盘不能反复刷分。
 * 积分下沉到 points.ts 的 award/earn，本模块只负责触发时机与口径。
 */
import { route, notFound, badRequest, pick, qInt } from './core'
import db, { now, today, weekStart, daysAgo } from '../db'
import type { Row } from '../db'
import { completeResult } from '../llm'
import { award, earn } from './points'

/** JSON 字段的安全解析：空串 / null / 脏数据一律退回默认值，绝不让一行坏数据打挂接口 */
function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * 取本周计划，没有就即时创建。
 * 惰性创建而非定时任务：用户什么时候打开页面，本周计划就什么时候出现，
 * 不会产生一堆没人认领的空周计划。
 */
function currentPlan(): Row {
  const ws = weekStart()
  let plan = db.first('weekly_plans', (p) => p.week_start === ws)
  if (!plan) {
    plan = db.insert('weekly_plans', {
      week_start: ws,
      outcomes_json: '[]',
      status: 'active',
      created_at: now(),
    })
  }
  return plan
}

/**
 * 计划视图：保留原始 *_json 字段，同时附加解析后的 outcomes/review/Tasks。
 * 为什么要「两个都给」：老前端可能直接读 outcomes_json，新前端读 outcomes，
 * 双写可以让迁移期间两边都不炸。
 */
function planView(plan: Row) {
  const tasks = db
    .find('tasks', (t) => Number(t.plan_id) === Number(plan.id))
    .sort((a, b) => Number(a.id) - Number(b.id))
  return {
    ...plan,
    outcomes: parseJson<string[]>(plan.outcomes_json, []),
    review: parseJson<unknown>(plan.review_json, null),
    tasks,
  }
}

/** 取最近 n 条（按 id 倒序，作为「最近」的稳定代理） */
function recent(rows: Row[], n: number): Row[] {
  return rows.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, n)
}

/** 去空白、去空串、保序去重 —— 复盘的两栏必须是干净的字符串列表 */
function cleanList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of arr) {
    const s = String(raw ?? '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

// ---------------------------------------------------------------------------
// 周计划
// ---------------------------------------------------------------------------

route('GET', '/plan/current', () => planView(currentPlan()))

route('POST', '/plan/week', (ctx) => {
  const body: any = ctx.body
  const outcomes = Array.isArray(body?.outcomes) ? body.outcomes : []
  const plan = currentPlan()
  const updated = db.update('weekly_plans', plan.id, {
    outcomes_json: JSON.stringify(outcomes),
  })
  // 与 /plan/current 返回完全一致的结构，前端拿到即可直接替换 state
  return planView(updated ?? plan)
})

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

route('POST', '/plan/tasks', (ctx) => {
  const body: any = ctx.body
  const title = String(pick(body, 'title', '') ?? '').trim()
  if (!title) badRequest('title is required')

  // plan_id 为空时落到本周计划，让「快速加任务」无需前端先查 plan
  const rawPid = pick<any>(body, 'plan_id', 0)
  const planId = rawPid ? Number(rawPid) : currentPlan().id
  const points = Number(pick(body, 'points', 10))

  return db.insert('tasks', {
    plan_id: planId,
    title,
    status: 'todo',
    points: Number.isFinite(points) ? points : 10,
    due_date: pick<any>(body, 'due_date', ''),
    created_at: now(),
  })
})

route('PATCH', '/plan/tasks/:id', (ctx) => {
  const body: any = ctx.body
  const id = Number(ctx.params.id)
  const task = db.get('tasks', id)
  if (!task) notFound('task')

  // 白名单：只认这四个字段，其余键一律忽略；全被忽略时报 400
  const patch: Row = {}
  for (const k of ['title', 'status', 'points', 'due_date']) {
    if (body && typeof body === 'object' && body[k] !== undefined) patch[k] = body[k]
  }
  if (Object.keys(patch).length === 0) badRequest('no valid field')

  // 副作用：首次勾选完成才给分。用行内 points（不走规则表），
  // 因为每条任务的分数是用户自己定的，规则表里的 task_done 只是默认值。
  if (patch.status === 'done' && task.status !== 'done') {
    award(Number(task.points || 10), `完成任务：${task.title}`, 'task', task.id)
  }

  return db.update('tasks', id, patch) ?? task
})

route('DELETE', '/plan/tasks/:id', (ctx) => {
  db.remove('tasks', Number(ctx.params.id))
  return { ok: true }
})

// ---------------------------------------------------------------------------
// 日打卡
// ---------------------------------------------------------------------------

route('POST', '/plan/checkin', (ctx) => {
  const body: any = ctx.body
  const date = String(pick(body, 'date', today()) ?? today())

  // 只收集真正传了的字段，避免「改备注」把其它指标清成 null
  const fields: Row = {}
  for (const k of ['sleep_h', 'exercise_min', 'focus_min', 'mood', 'note']) {
    if (body && body[k] !== undefined && body[k] !== null) fields[k] = body[k]
  }

  const existing = db.first('daily_checkins', (c) => String(c.date) === date)
  if (existing) {
    db.update('daily_checkins', existing.id, fields)
    // 同日重复提交只是补录，不重复给分
    return { ok: true, id: existing.id, rewarded: false }
  }

  const row = db.insert('daily_checkins', { date, ...fields })
  earn('daily_checkin', `日打卡 ${date}`, 'checkin', row.id)
  return { ok: true, id: row.id, rewarded: true }
})

route('GET', '/plan/checkins', (ctx) => {
  const days = qInt(ctx, 'days', 30)
  const from = daysAgo(days)
  return db
    .find('daily_checkins', (c) => String(c.date) >= from)
    .sort((a, b) => (String(a.date) < String(b.date) ? 1 : String(a.date) > String(b.date) ? -1 : 0))
})

// ---------------------------------------------------------------------------
// 周复盘（唯一结算入口，只结一次）
// ---------------------------------------------------------------------------

route('POST', '/plan/review', (ctx) => {
  const body: any = ctx.body
  const done = cleanList(body?.done)
  const missed = cleanList(body?.missed)

  // 同一成果不可能既完成又未完成，交集即数据错误，必须拦下并指出是哪几条
  const both = done.filter((d) => missed.includes(d))
  if (both.length > 0) {
    badRequest(`同一条成果不能同时标记「完成」和「未完成」：${both.join('、')}（共 ${both.length} 条）`)
  }

  const rawPid = pick(body, 'plan_id', 0)
  const plan = rawPid ? db.get('weekly_plans', Number(rawPid)) : currentPlan()
  if (!plan) notFound('plan')

  const review = {
    done,
    missed,
    blockers: pick<any>(body, 'blockers', ''),
    next_min_action: pick<any>(body, 'next_min_action', ''),
    self_score: Number(pick(body, 'self_score', 3)),
  }

  // 只有「同一条成果不能同时完成和未完成」的校验通过后才落库；
  // 首次（此前不是 reviewed）才结算，避免反复提交刷分。
  const firstTime = plan.status !== 'reviewed'
  db.update('weekly_plans', plan.id, {
    review_json: JSON.stringify(review),
    status: 'reviewed',
  })

  if (firstTime) {
    earn('weekly_review', '完成周复盘', 'plan', plan.id)
    // 一次调用结算整批，避免 n 条流水把账本刷屏；分数按条数线性放大
    if (done.length > 0) {
      award(100 * done.length, `周成果完成 ${done.length} 项`, 'plan', plan.id)
    }
    if (missed.length > 0) {
      award(-60 * missed.length, `周成果未完成 ${missed.length} 项`, 'plan', plan.id)
    }
  }

  return { ok: true, rewarded: firstTime, plan_id: plan.id, review }
})

// ---------------------------------------------------------------------------
// 双周组会汇报（LLM）
// ---------------------------------------------------------------------------

route('GET', '/plan/biweekly', async () => {
  const since = daysAgo(14)
  const until = today()

  const checkins = db.find('daily_checkins', (c) => String(c.date) >= since)
  const tasks = db.find('tasks', (t) => String(t.created_at ?? '') >= since)
  const stages = db.all('paper_stages') // 阶段是全量：论文进度不能被两周窗口切断
  const experiments = recent(db.all('experiments'), 10)
  const litDone = recent(
    db.find('literature', (l) => l.status === 'done'),
    20,
  )
  const ideas = recent(db.all('ideas'), 20)
  const commitments = db.find('advisor_notes', (n) => String(n.date ?? '') >= since)

  const counts = {
    checkins: checkins.length,
    tasks: tasks.length,
    stages: stages.length,
    experiments: experiments.length,
    literature_done: litDone.length,
    ideas: ideas.length,
    commitments: commitments.length,
  }

  // 口径必须能自查：AI 汇总看了什么范围，页面上要原样展示，避免「汇报数字对不上」
  const scope = {
    since,
    until,
    window_days: 14,
    counts,
    notes: [
      `窗口：${since} 起共 14 天（按创建/记录日期筛）`,
      '论文阶段是全量，不受窗口限制',
      '实验 / 已读文献 / 创新点取最近 10 / 20 / 20 条，可能包含更早记录',
    ],
  }

  const lines: string[] = []
  lines.push('请根据以下真实工作数据，生成一份可直接交给导师的【双周组会汇报】（Markdown）。')
  lines.push('')
  lines.push('结构固定为三节，标题必须严格使用：')
  lines.push('## 做了什么')
  lines.push('## 卡点')
  lines.push('## 下一步')
  lines.push('')
  lines.push('要求：具体、可验证、用数据说话；没有数据的部分如实说明「本期无记录」，严禁编造。')
  lines.push('')
  lines.push(`统计窗口：${since} ~ ${until}（14 天，按记录/创建日期筛选）`)
  lines.push('')
  lines.push(`【日打卡 ${counts.checkins} 天】`)
  lines.push(
    checkins
      .map((c) => `${c.date} 睡眠${c.sleep_h ?? '-'}h 专注${c.focus_min ?? '-'}min`)
      .join('；') || '（无记录）',
  )
  lines.push('')
  lines.push(`【本周任务 ${counts.tasks} 条】`)
  lines.push(
    tasks.map((t) => `${t.title}（${t.status === 'done' ? '已完成' : '未完成'}，${t.points}分）`).join('；') ||
      '（无记录）',
  )
  lines.push('')
  lines.push(`【论文阶段（全量 ${counts.stages} 个）】`)
  lines.push(stages.map((s) => `${s.name}（${s.status}）`).join('；') || '（无记录）')
  lines.push('')
  lines.push(`【实验（最近 ${counts.experiments} 条）】`)
  lines.push(experiments.map((e) => `${e.name || e.title || '未命名'}（${e.status}）`).join('；') || '（无记录）')
  lines.push('')
  lines.push(`【已读文献（最近 ${counts.literature_done} 篇）】`)
  lines.push(litDone.map((l) => `${l.title}（${l.status}）`).join('；') || '（无记录）')
  lines.push('')
  lines.push(`【创新点（最近 ${counts.ideas} 条）】`)
  lines.push(ideas.map((i) => `${i.title}（${i.status}）`).join('；') || '（无记录）')
  lines.push('')
  lines.push(`【对导师的承诺（窗口内 ${counts.commitments} 条）】`)
  lines.push(
    commitments.map((n) => `${n.date} ${n.my_commitment || '（未记录承诺）'}（${n.status}）`).join('；') ||
      '（无记录）',
  )

  const env = await completeResult(lines.join('\n'), {
    mode: 'reason',
    task: 'biweekly',
    maxTokens: 4096,
  })

  // 失败信封刻意不带 provider/model/tokens，避免前端把空值渲染成一个「假成功」
  if (!env.ok) return { ok: false, result: '', since, scope, error: env.error }

  return {
    ok: true,
    result: env.content,
    since,
    scope,
    error: null,
    provider: env.provider,
    model: env.model,
    tokens_in: env.tokens_in,
    tokens_out: env.tokens_out,
  }
})
