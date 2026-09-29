/**
 * 论文进度模块 —— 原 FastAPI 后端 paper.py 的浏览器端等价实现。
 *
 * 论文是博士生的主线，本模块围绕两件事：
 * 1. 阶段（stages）：用状态机 + 卡点（blocker / next_action）把「卡在哪」写清楚，
 *    并用 stuck_days 把「沉默的停滞」量化出来，首页/仪表盘据此报警。
 * 2. 章节（sections）：用字数目标推进写作。
 * 阶段状态真正发生迁移时，走积分引擎记一次 paper_stage_advance，作为正向反馈。
 */
import { route, notFound, badRequest, pick, idParam } from './core'
import db from '../db'
import type { Row } from '../db'
import { completeResult } from '../llm'
import { earn } from './points'

/**
 * 合法的阶段状态域。它既是前端下拉框的取值，也是 PATCH 发分副作用的判定集合：
 * 只有新旧值都落在这个集合内的状态迁移才值得激励。
 */
const STAGE_STATUS: string[] = ['todo', 'doing', 'blocked', 'done']

/** 阶段可修改字段白名单（其余键一律忽略，防脏字段写库） */
const STAGE_FIELDS = ['name', 'sort_order', 'status', 'blocker', 'next_action'] as const

/** 章节可修改字段白名单 */
const SECTION_FIELDS = ['name', 'sort_order', 'word_count', 'target_words', 'status'] as const

/**
 * 卡住天数：只有 blocked 才计算，值为 now 与 updated_at 的整天差。
 * - 解析失败（空值 / 脏数据）一律返回 0：绝不让一行坏数据把列表接口打挂；
 * - 取 max(0, …) 是为了容忍时钟回拨或未来时间戳，避免出现「已卡 -3 天」这种反直觉数字。
 */
function stuckDays(row: Row): number {
  if (row?.status !== 'blocked') return 0
  const t = Date.parse(String(row.updated_at ?? ''))
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / 86400000))
}

/** 给行附加派生列 stuck_days（只用于展示，不落库，避免和 updated_at 两处不一致） */
function withStuck(row: Row): Row {
  return { ...row, stuck_days: stuckDays(row) }
}

/** 阶段排序：先 sort_order 再 id，保证同序号时顺序稳定可复现 */
function sortStages(rows: Row[]): Row[] {
  return rows.sort(
    (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id),
  )
}

/** 章节排序：口径与阶段一致 */
function sortSections(rows: Row[]): Row[] {
  return rows.sort(
    (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id),
  )
}

/** 全量阶段（含 stuck_days） */
function listStages(): Row[] {
  return sortStages(db.all('paper_stages')).map(withStuck)
}

/**
 * 整数字段归一化：非数字回退到 fallback。
 * 用于 sort_order 这类「允许为负、但必须可排序」的字段。
 */
function intOr(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * 非负整数字段归一化：非数字 / 负数一律归 0。
 * 字数是统计量，负数和字符串都没有意义；这里选择静默归零而不是抛错，
 * 因为用户是在输入框里手填，报错会打断录入节奏。
 */
function nonNegInt(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

// ---------------------------------------------------------------------------
// 阶段
// ---------------------------------------------------------------------------

route('GET', '/paper/stages', () => listStages())

route('POST', '/paper/stages', (ctx) => {
  const body: any = ctx.body
  const name = String(pick(body, 'name', '') ?? '').trim()
  if (!name) badRequest('name is required')

  // updated_at 由 db.insert 依据 TABLES_WITH_UPDATED_AT 自动写入，
  // 这是 stuck_days 的计算基准，必须由存储层统一维护，业务层不插手。
  const row = db.insert('paper_stages', {
    name,
    sort_order: intOr(pick(body, 'sort_order', 0)),
    status: pick(body, 'status', 'todo'),
    blocker: pick(body, 'blocker', ''),
    next_action: pick(body, 'next_action', ''),
  })
  return withStuck(row)
})

route('PATCH', '/paper/stages/:id', (ctx) => {
  const id = idParam(ctx)
  const before = db.get('paper_stages', id)
  if (!before) notFound('stage')

  const body: any = ctx.body
  const patch: Row = {}
  for (const k of STAGE_FIELDS) {
    if (body && typeof body === 'object' && body[k] !== undefined) patch[k] = body[k]
  }
  if (Object.keys(patch).length === 0) badRequest('no valid field')

  // sort_order 归一为整数；脏值退回原值，避免排序字段被写成 "abc"
  if (patch.sort_order !== undefined) {
    patch.sort_order = intOr(patch.sort_order, Number(before.sort_order || 0))
  }

  const after = db.update('paper_stages', id, patch) ?? before

  // 副作用：仅当状态真正发生迁移、且新旧值都落在合法状态域内才发分。
  // 要求「新旧都合法」而不是只看新值，是为了拦住脏数据之间的跳变（如 '' → 'done'），
  // 同时保证重复保存同一状态时不会反复领分。
  const from = String(before.status ?? '')
  const to = String(after.status ?? '')
  if (from !== to && STAGE_STATUS.includes(from) && STAGE_STATUS.includes(to)) {
    earn('paper_stage_advance', `论文阶段推进：${after.name}`, 'paper_stage', id)
  }

  return withStuck(after)
})

route('DELETE', '/paper/stages/:id', (ctx) => {
  const id = idParam(ctx)
  // 显式区分「删掉了」和「本来就不存在」，避免前端对 404 与成功一视同仁
  if (!db.remove('paper_stages', id)) notFound('stage')
  return { ok: true }
})

route('POST', '/paper/stages/:id/unblock', async (ctx) => {
  const id = idParam(ctx)
  const stage = db.get('paper_stages', id)
  if (!stage) notFound('stage')

  // 空值是常态（用户往往只标了 blocked 就跑了），统一填「（未填写）」让模型知道信息缺口，
  // 而不是把 "undefined" 之类字面量喂进去。
  const blocker = String(stage.blocker || '') || '（未填写）'
  const nextAction = String(stage.next_action || '') || '（未填写）'
  const name = String(stage.name ?? '')
  const days = stuckDays(stage)

  // 模板逐字固定：改动它会直接影响「解锁方案」的结构与可执行性，请勿顺手改写措辞
  const prompt = `论文当前卡在这个阶段：

阶段：${name}
卡点描述：${blocker}
原计划的下一步：${nextAction}
已卡住 ${days} 天

请给出解锁方案：
1. 先把卡点拆开：它到底是「没想清楚」「没数据」「没时间」还是「不敢下手」？给出判断依据
2. 给出 3 条具体出路，每条标注耗时（小时）与风险
3. 推荐一条，并写出今天下午就能开始的第一个动作（颗粒度到"打开什么、做什么、产出什么"）
4. 如果这个阶段其实可以绕过或降级完成，说明怎么绕过`

  const env = await completeResult(prompt, { mode: 'reason', task: 'unblock', maxTokens: 3072 })

  // 失败信封刻意不带 provider/model/tokens：前端据此渲染「没有生成」的可操作提示，
  // 若回填空值会被渲染成一个「假成功」。
  if (!env.ok) return { ok: false, result: '', error: env.error }

  return {
    ok: true,
    result: env.content,
    error: null,
    provider: env.provider,
    model: env.model,
    tokens_in: env.tokens_in,
    tokens_out: env.tokens_out,
  }
})

// ---------------------------------------------------------------------------
// 章节
// ---------------------------------------------------------------------------

route('GET', '/paper/sections', () => sortSections(db.all('paper_sections')))

route('POST', '/paper/sections', (ctx) => {
  const body: any = ctx.body
  const name = String(pick(body, 'name', '') ?? '').trim()
  if (!name) badRequest('name is required')

  return db.insert('paper_sections', {
    name,
    sort_order: intOr(pick(body, 'sort_order', 0)),
    // 新建章节一律从 0 字起算：防止前端把其它章节的历史字数误传进来
    word_count: 0,
    target_words: nonNegInt(pick(body, 'target_words', 0)),
    status: pick(body, 'status', 'todo'),
  })
})

route('PATCH', '/paper/sections/:id', (ctx) => {
  const id = idParam(ctx)
  const before = db.get('paper_sections', id)
  if (!before) notFound('section')

  const body: any = ctx.body
  const patch: Row = {}
  for (const k of SECTION_FIELDS) {
    if (body && typeof body === 'object' && body[k] !== undefined) patch[k] = body[k]
  }
  if (Object.keys(patch).length === 0) badRequest('no valid field')

  // 字数类字段：负数 / 非数字一律归 0（而不是报错），口径与 POST 保持一致
  if (patch.word_count !== undefined) patch.word_count = nonNegInt(patch.word_count)
  if (patch.target_words !== undefined) patch.target_words = nonNegInt(patch.target_words)
  if (patch.sort_order !== undefined) {
    patch.sort_order = intOr(patch.sort_order, Number(before.sort_order || 0))
  }

  return db.update('paper_sections', id, patch) ?? before
})

route('DELETE', '/paper/sections/:id', (ctx) => {
  db.remove('paper_sections', Number(ctx.params.id))
  return { ok: true }
})

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

route('GET', '/paper/overview', () => {
  const stages = listStages()
  const blocked = stages.filter((s) => s.status === 'blocked')
  const doing = stages.filter((s) => s.status === 'doing')

  // 当前阶段优先展示「被卡住的」——那才是真正需要用户马上处理的事情；
  // 没有 blocked 才退回到进行中；两者都没有则为 null。
  const current = blocked[0] ?? doing[0] ?? null

  const total = stages.length
  const done = stages.filter((s) => s.status === 'done').length
  const progress = total ? Math.round((done / total) * 100) : 0

  // 字数是各章节之和；目标为 0 时进度记 0，避免除零得到 NaN/Infinity
  let words = 0
  let targetWords = 0
  for (const s of db.all('paper_sections')) {
    words += Number(s.word_count || 0)
    targetWords += Number(s.target_words || 0)
  }
  const wordProgress = targetWords ? Math.round((words / targetWords) * 100) : 0

  return {
    current,
    blocked,
    progress,
    stages,
    words,
    target_words: targetWords,
    word_progress: wordProgress,
  }
})
