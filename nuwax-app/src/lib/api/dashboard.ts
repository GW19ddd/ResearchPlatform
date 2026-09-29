/**
 * 首页仪表盘 / 活跃热力图 / 全量导出 —— 原 FastAPI 后端 dashboard.py 的浏览器端等价实现。
 *
 * 三件事共享同一套「派生视图」逻辑，所以放在同一个领域模块里：
 * 1. /dashboard        首页聚合卡片（积分 / 论文 / 各领域计数 / 承诺 / 打卡）
 * 2. /activity/heatmap 类 GitHub 贡献图，把「每天动了什么」按去重口径统计出来
 * 3. /export/all       一键导出 Markdown（数据主权：用户随时能把自己的东西拿走）
 *
 * 热力图的口径要点：**同一条记录同一天只算一次**。因为一条文献被编辑三次会写进
 * updated_at，但那不代表「今天做了三件事」——用 (kind, day, label) 去重把噪声压掉。
 */
import { route, qInt } from './core'
import db, { today, daysAgo } from '../db'
import type { Row, TableName } from '../db'
import { getRules, balance, weekNet } from './points'

// ---------------------------------------------------------------------------
// 论文派生视图（与 paper.ts 同口径）
// ---------------------------------------------------------------------------

/**
 * 卡住天数：blocked 才计算，now 与 updated_at 的整天差。
 * 解析失败归 0、取 max(0) 容忍时钟回拨——与 paper.ts 保持一致，
 * 这里刻意重复实现而非跨模块引用：仪表盘和论文页是两条独立调用链，
 * 复制这一小段能避免模块间产生耦合（register.ts 的加载顺序也不影响结果）。
 */
function stuckDays(row: Row): number {
  if (row?.status !== 'blocked') return 0
  const t = Date.parse(String(row.updated_at ?? ''))
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / 86400000))
}

function withStuck(row: Row): Row {
  return { ...row, stuck_days: stuckDays(row) }
}

function sortStages(rows: Row[]): Row[] {
  return rows.sort(
    (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id),
  )
}

/** 论文摘要：current / blocked / progress / words 等，供首页卡片与论文页共用口径 */
function paperSummary() {
  const stages = sortStages(db.all('paper_stages')).map(withStuck)
  const blocked = stages.filter((s) => s.status === 'blocked')
  const doing = stages.filter((s) => s.status === 'doing')
  const current = blocked[0] ?? doing[0] ?? null

  const total = stages.length
  const done = stages.filter((s) => s.status === 'done').length
  const progress = total ? Math.round((done / total) * 100) : 0

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
    words,
    target_words: targetWords,
    word_progress: wordProgress,
  }
}

/** 按 status 分组计数，前端直接拿小字典渲染「待读/在读/已读」这类分布 */
function statusCounts(rows: Row[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    const k = String(r.status ?? '')
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// 首页聚合
// ---------------------------------------------------------------------------

route('GET', '/dashboard', () => {
  const since = daysAgo(14)
  const t = today()

  const rules = getRules()
  const floor = Number(rules.weekly_net_floor ?? -100)

  const paper = paperSummary()

  // 承诺：open 为全部未闭合；overdue 是「今天之前就该还」的那部分（当天到期不算逾期）
  const openNotes = db.find('advisor_notes', (n) => n.status === 'open')
  const overdueItems = openNotes
    .filter((n) => !!n.due_date && String(n.due_date) < t)
    .sort((a, b) => {
      const da = String(a.due_date || '')
      const dbb = String(b.due_date || '')
      return da < dbb ? -1 : da > dbb ? 1 : Number(a.id) - Number(b.id)
    })

  return {
    points: {
      balance: balance(),
      week_net: weekNet(),
      floor,
    },
    paper,
    ideas: statusCounts(db.all('ideas')),
    literature: statusCounts(db.all('literature')),
    experiments: statusCounts(db.all('experiments')),
    checkin_today: db.find('daily_checkins', (c) => String(c.date) === t).length > 0,
    // 近 14 天打卡，按日期升序：折线图从左到右就是时间顺序
    checkins: db
      .find('daily_checkins', (c) => String(c.date) >= since)
      .sort((a, b) => {
        const da = String(a.date || '')
        const dbb = String(b.date || '')
        return da < dbb ? -1 : da > dbb ? 1 : 0
      }),
    commitments: {
      open: openNotes.length,
      overdue: overdueItems.length,
      items: overdueItems,
    },
    open_bets: db.find('bets', (b) => b.status === 'open').length,
    open_tasks: db.find('tasks', (t2) => t2.status === 'todo').length,
  }
})

// ---------------------------------------------------------------------------
// 活跃热力图
// ---------------------------------------------------------------------------

/** 活动来源定义：kind 是展示名，time/alt 是两个可能落活跃的日期列 */
type Source = {
  kind: string
  table: TableName
  time: string
  /** 次时间列：一条记录被编辑后 updated_at 变动，也算当天的活跃 */
  alt?: string
  label: (r: Row) => string
}

/**
 * 来源清单与原后端逐条对齐。
 * 说明：
 * - literature / ideas / experiments / lit_notes 有 updated_at，同一条记录在两个日期都可能点亮；
 * - canvas_node_outputs / chat_messages / points_ledger 只有 created_at；
 * - advisor_notes / daily_checkins 的活跃日就是它们的业务日期（date 列）；
 * - 对话的 label 取正文前 40 字，避免把整段回复塞进明细。
 */
const SOURCES: Source[] = [
  { kind: '文献', table: 'literature', time: 'created_at', alt: 'updated_at', label: (r) => String(r.title ?? '') },
  { kind: '创新点', table: 'ideas', time: 'created_at', alt: 'updated_at', label: (r) => String(r.title ?? '') },
  { kind: '实验', table: 'experiments', time: 'created_at', alt: 'updated_at', label: (r) => String(r.name ?? '') },
  { kind: '笔记', table: 'lit_notes', time: 'created_at', alt: 'updated_at', label: (r) => String(r.section ?? '') },
  { kind: '画布', table: 'canvas_node_outputs', time: 'created_at', label: (r) => String(r.node_key ?? '') },
  {
    kind: '对话',
    table: 'chat_messages',
    time: 'created_at',
    label: (r) => String(r.content ?? '').slice(0, 40),
  },
  { kind: '积分', table: 'points_ledger', time: 'created_at', label: (r) => String(r.reason ?? '') },
  { kind: '组会', table: 'advisor_notes', time: 'date', label: (r) => String(r.scene ?? '') },
  // 打卡没有标题类字段，固定一个 label，明细里也知道那天做了什么
  { kind: '打卡', table: 'daily_checkins', time: 'date', label: () => '每日打卡' },
]

/** 日期格式化：与 db.now()/today() 同口径的本地日期 */
function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

route('GET', '/activity/heatmap', (ctx) => {
  // 先 clamp 再对齐：min 28 保证图不至于只有几列，max 730（约两年）防止历史存不下
  const span = Math.max(28, Math.min(730, Math.trunc(qInt(ctx, 'days', 365)) || 365))
  const end = today()

  const endDate = new Date(end + 'T00:00:00')
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - (span - 1))
  // 对齐到周日：热力图按周成列，列首必须是周日，否则整张图会错位一列。
  // 代价是实际序列长度可能略多于 span 天（起点被提前），这是预期行为。
  startDate.setDate(startDate.getDate() - startDate.getDay())
  const seriesStart = fmt(startDate)

  // 生成连续日期序列，并建立 date → item 的索引，后面按日累加
  type Day = { date: string; count: number; kinds: Record<string, number>; labels: string[] }
  const days: Day[] = []
  const byDate = new Map<string, Day>()
  for (let d = new Date(startDate); fmt(d) <= end; d.setDate(d.getDate() + 1)) {
    const date = fmt(d)
    const item: Day = { date, count: 0, kinds: {}, labels: [] }
    days.push(item)
    byDate.set(date, item)
  }

  // 去重键 = (kind, day, label)：同一条记录同一天无论改几次都只算一次
  const seen = new Set<string>()
  for (const src of SOURCES) {
    for (const row of db.all(src.table)) {
      const label = src.label(row)
      const cols = src.alt ? [src.time, src.alt] : [src.time]
      for (const col of cols) {
        // 统一截前 10 位得到日期；空值 / 脏值直接跳过
        const day = String(row[col] ?? '').slice(0, 10)
        if (!day || day < seriesStart || day > end) continue
        const item = byDate.get(day)
        if (!item) continue
        const key = `${src.kind}|${day}|${label}`
        if (seen.has(key)) continue
        seen.add(key)
        item.count += 1
        item.kinds[src.kind] = (item.kinds[src.kind] ?? 0) + 1
        item.labels.push(`${src.kind}·${label}`)
      }
    }
  }

  // 明细区高度固定，每天最多列 6 条，多了会让弹层撑爆
  for (const item of days) {
    if (item.labels.length > 6) item.labels = item.labels.slice(0, 6)
  }

  let total = 0
  let activeDays = 0
  let max = 0
  for (const item of days) {
    total += item.count
    if (item.count > 0) activeDays += 1
    if (item.count > max) max = item.count
  }

  // 当前连续：今天有活动就从今天算，今天没有就从昨天算（今天还没开始不该断掉昨天前的连击）
  let streak = 0
  let i = days.length - 1
  if (i >= 0 && days[i].count === 0) i -= 1
  for (; i >= 0 && days[i].count > 0; i--) streak += 1

  // 窗口内最长连续
  let bestStreak = 0
  let run = 0
  for (const item of days) {
    if (item.count > 0) {
      run += 1
      if (run > bestStreak) bestStreak = run
    } else {
      run = 0
    }
  }

  return {
    days,
    start: seriesStart,
    end,
    total,
    active_days: activeDays,
    streak,
    best_streak: bestStreak,
    max,
  }
})

// ---------------------------------------------------------------------------
// 全量导出（Markdown）
// ---------------------------------------------------------------------------

/** 表格单元格转义：竖线会破坏 Markdown 表格结构，换行会串行 */
function cell(v: unknown): string {
  return String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
}

/** 由表头 + 行数据拼一张 Markdown 表格；无数据时也保留表头，方便用户自己接着填 */
function mdTable(headers: string[], rows: unknown[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

/** 导出按 id 升序，保证每次导出的列序稳定、便于 diff */
function byId(rows: Row[]): Row[] {
  return rows.sort((a, b) => Number(a.id) - Number(b.id))
}

route('GET', '/export/all', () => {
  const out: string[] = []
  out.push(`# 科研工作台导出 · ${today()}`)

  out.push('')
  out.push('## 创新点')
  out.push(
    mdTable(
      ['ID', '标题', '状态', '新颖性', '可行性', '影响', '工作量', '创建时间'],
      byId(db.all('ideas')).map((r) => [
        r.id,
        r.title,
        r.status,
        r.novelty,
        r.feasibility,
        r.impact,
        r.effort,
        r.created_at,
      ]),
    ),
  )

  out.push('')
  out.push('## 文献')
  out.push(
    mdTable(
      ['ID', '标题', '作者', '年份', '状态', '评分', '创建时间'],
      byId(db.all('literature')).map((r) => [
        r.id,
        r.title,
        r.authors,
        r.year,
        r.status,
        r.rating,
        r.created_at,
      ]),
    ),
  )

  out.push('')
  out.push('## 实验')
  out.push(
    mdTable(
      ['ID', '名称', '状态', '假设', '结论', '创建时间'],
      byId(db.all('experiments')).map((r) => [
        r.id,
        r.name,
        r.status,
        r.hypothesis,
        r.conclusion,
        r.created_at,
      ]),
    ),
  )

  out.push('')
  out.push('## 论文阶段')
  out.push(
    mdTable(
      ['ID', '名称', '状态', '卡点', '下一步', '已卡天数', '更新时间'],
      sortStages(db.all('paper_stages')).map((r) => {
        const s = withStuck(r)
        return [s.id, s.name, s.status, s.blocker, s.next_action, s.stuck_days, s.updated_at]
      }),
    ),
  )

  out.push('')
  out.push('## 论文章节')
  out.push(
    mdTable(
      ['ID', '名称', '状态', '字数', '目标字数', '更新时间'],
      byId(db.all('paper_sections')).map((r) => [
        r.id,
        r.name,
        r.status,
        r.word_count,
        r.target_words,
        r.updated_at,
      ]),
    ),
  )

  out.push('')
  out.push('## 导师承诺')
  out.push(
    mdTable(
      ['ID', '日期', '场景', '导师说', '我的承诺', '截止', '状态'],
      byId(db.all('advisor_notes')).map((r) => [
        r.id,
        r.date,
        r.scene,
        r.advisor_said,
        r.my_commitment,
        r.due_date,
        r.status,
      ]),
    ),
  )

  out.push('')
  out.push('## 积分流水')
  out.push(
    mdTable(
      ['ID', '时间', '增减', '事由', '关联类型', '关联ID'],
      byId(db.all('points_ledger')).map((r) => [
        r.id,
        r.created_at,
        r.delta,
        r.reason,
        r.ref_type,
        r.ref_id,
      ]),
    ),
  )

  // 返回纯文本（不是 JSON）：调用方可直接下载为 .md
  return out.join('\n')
})
