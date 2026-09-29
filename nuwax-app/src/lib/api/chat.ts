/**
 * 对话域路由 —— 原 FastAPI 的 chat.py 的浏览器端实现。
 *
 * 三条设计主线：
 * 1. 角色 system 提示词逐字内置（原后端也硬编码在 py 里），保证迁移前后模型行为一致；
 * 2. 「工作台上下文」在发消息时由服务端拼进 system，页面只存勾选的 key 与补充背景；
 * 3. 调用失败绝不落 assistant 行 —— 页面重试/重跑不会多出一条空回复，输入也不丢。
 */
import { route, badRequest, pick, idParam, ApiError } from './core'
import db, { now } from '../db'
import type { Row } from '../db'
import { completeResult, chatResult } from '../llm'

/** 角色列表：system 不下发（前端拿不到提示词），只在服务端选路时使用 */
const ROLES = [
  {
    value: 'assistant',
    label: '科研助手',
    system:
      '你是一位严谨的科研助手，服务于一位做 OpenFOAM/CFD 与 LLM 智能体方向研究的博士生。回答用简体中文，结构化、具体、可执行，拒绝空话套话。涉及对比优先用表格。不要臆造文献、数字或引用；不确定就明说。追问时先复述你的理解再回答。',
  },
  {
    value: 'reviewer',
    label: '挑剔审稿人',
    system:
      '你是一位顶会审稿人（Reviewer #2），苛刻但讲理。用户的每个想法你都要找漏洞：实验设计是否站得住、基线是否公平、指标是否有说服力、与已有工作是否撞车。每次回答给出 3 条最致命的问题 + 1 条补救建议。不要为了挑刺而挑刺，必须给出理由。',
  },
  {
    value: 'mentor',
    label: '务实导师',
    system:
      '你是一位务实、时间有限的导师，最关心学生能否按时毕业、工作能否落地。回答时优先关注：工作量可控吗、一个月内能出结果吗、风险在哪、下一步做什么。直接给优先级排序和可执行动作，少讲理论。',
  },
  {
    value: 'writer',
    label: '论文写作教练',
    system:
      '你是一位论文写作教练，擅长把粗糙的研究想法整理成可发表的叙述。帮助用户：理清 contribution 与 story、设计实验叙事、改写段落使其更学术严谨。给具体改写示例，指出哪些说法会被审稿人质疑。',
  },
  {
    value: 'cfd',
    label: 'OpenFOAM/CFD 专家',
    system:
      '你是 OpenFOAM 与 CFD 方向的资深工程师，熟悉 OpenFOAM 2406 的求解器、字典文件、边界条件、湍流模型、网格无关性验证与残差分析。回答时给出具体的字典配置片段、命令与排查步骤。指出常见坑（量纲、离散格式、松弛因子、并行分解）。',
  },
]

/** 未知名角色一律回退 assistant，避免历史会话因枚举变更而 500 */
function roleOf(role: unknown) {
  return ROLES.find((r) => r.value === role) ?? ROLES[0]
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 截断到 n 字：上下文只提供「主张/假设/结论」的摘要，避免把 system 撑爆 */
function clip(v: unknown, n = 200): string {
  return String(v ?? '').slice(0, n)
}

/** 最近 n 条：以自增 id 作为「新近」的稳定代理（与 SQLite rowid 口径一致） */
function recent(rows: Row[], n: number): Row[] {
  return [...rows].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, n)
}

/** 排序字段口径：sort_order 升序，同序按 id */
function bySort(a: Row, b: Row): number {
  const d = Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)
  return d !== 0 ? d : Number(a.id) - Number(b.id)
}

/** 数组/标量统一转成一行可读文本 */
function asText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).filter(Boolean).join('；')
  return String(v ?? '')
}

// ---------------------------------------------------------------------------
// 工作台上下文拼装
// ---------------------------------------------------------------------------

function segIdeas(): string {
  const rows = recent(db.all('ideas'), 30)
  if (rows.length === 0) return ''
  const lines = ['【创新点池】']
  for (const i of rows) {
    lines.push(
      `- ${i.title}（分类：${i.category ?? ''}）｜状态 ${i.status}｜评分 新${i.novelty}/可${i.feasibility}/影${i.impact}/工${i.effort}`,
    )
    if (i.one_liner) lines.push(`  主张：${clip(i.one_liner)}`)
  }
  return lines.join('\n')
}

function segLiterature(): string {
  const rows = recent(db.all('literature'), 40)
  if (rows.length === 0) return ''
  const lines = ['【文献库】']
  for (const l of rows) lines.push(`- ${l.title}（${l.year ?? ''} · ${l.venue ?? ''}）｜${l.status}`)
  return lines.join('\n')
}

function segExperiments(): string {
  const rows = recent(db.all('experiments'), 20)
  if (rows.length === 0) return ''
  const lines = ['【实验】']
  for (const e of rows) {
    lines.push(`- ${e.name}｜${e.status}`)
    if (e.hypothesis) lines.push(`  假设：${clip(e.hypothesis)}`)
    if (e.conclusion) lines.push(`  结论：${clip(e.conclusion)}`)
  }
  return lines.join('\n')
}

function segPaper(): string {
  const stages = db.all('paper_stages').sort(bySort)
  const sections = db.all('paper_sections').sort(bySort)
  if (stages.length === 0 && sections.length === 0) return ''
  const fmt = (r: Row) => `${r.name}(${r.status})`
  return ['【论文进度】', `阶段：${stages.map(fmt).join('、')}`, `章节：${sections.map(fmt).join('、')}`].join('\n')
}

function segPlan(): string {
  const rows = [...db.all('weekly_plans')]
    .sort((a, b) => String(b.week_start ?? '').localeCompare(String(a.week_start ?? '')))
    .slice(0, 4)
  if (rows.length === 0) return ''
  const lines = ['【近期周计划】']
  for (const p of rows) {
    const review = parseJson<Record<string, unknown>>(p.review_json, {})
    const outcomes = parseJson<unknown[]>(p.outcomes_json, [])
    lines.push(`- ${p.week_start}（${p.status || 'active'}）`)
    // 只输出有内容的行：没做复盘的周计划不该在 system 里留一串空标签
    const planOut = asText(outcomes)
    if (planOut) lines.push(`  计划产出：${planOut}`)
    const done = asText(review?.done)
    if (done) lines.push(`  已完成：${done}`)
    const missed = asText(review?.missed)
    if (missed) lines.push(`  未完成：${missed}`)
    const blockers = asText(review?.blockers)
    if (blockers) lines.push(`  卡点：${blockers}`)
    const next = asText(review?.next_min_action)
    if (next) lines.push(`  下一步：${next}`)
  }
  return lines.join('\n')
}

const SEGMENTS: Record<string, () => string> = {
  ideas: segIdeas,
  literature: segLiterature,
  experiments: segExperiments,
  paper: segPaper,
  plan: segPlan,
}

const CTX_HEADER = '下面是用户工作台里的真实数据，回答时请据此作答，不要凭空假设：'

/**
 * 把勾选的数据段拼成 system 追加块。
 * 单段出错只跳过该段（try/catch）：一张表有脏数据不能导致整轮对话发不出去。
 */
function buildContext(keys: unknown, extra: unknown): string {
  const parts: string[] = []
  const list = Array.isArray(keys) ? keys : []
  for (const k of list) {
    const fn = SEGMENTS[String(k)]
    if (!fn) continue
    try {
      const seg = fn()
      if (seg) parts.push(seg)
    } catch {
      /* 跳过坏段 */
    }
  }
  const extraText = String(extra ?? '').trim()
  if (extraText) parts.push(`【用户补充背景】\n${extraText}`)
  // 全空则不加抬头，避免 system 里出现一句没有下文的前言
  if (parts.length === 0) return ''
  return `${CTX_HEADER}\n\n${parts.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/** 会话详情：全列 + 按 id 升序的消息（只回渲染必需字段，减少跨会话信息泄漏面） */
function sessionDetail(id: number) {
  const s = db.get('chat_sessions', id)
  if (!s) throw new ApiError('会话不存在', 404)
  const messages = db
    .find('chat_messages', (m) => Number(m.session_id) === id)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      provider: m.provider ?? '',
      model: m.model ?? '',
      tokens_in: m.tokens_in ?? 0,
      tokens_out: m.tokens_out ?? 0,
      created_at: m.created_at,
    }))
  return { ...s, messages }
}

function firstMessageContent(sessionId: number): string | null {
  const msgs = db.find('chat_messages', (m) => Number(m.session_id) === sessionId)
  if (msgs.length === 0) return null
  const first = msgs.reduce((a, b) => (Number(a.id) <= Number(b.id) ? a : b))
  return first.content ?? null
}

route('GET', '/chat/roles', () => ({ roles: ROLES.map((r) => ({ value: r.value, label: r.label })) }))

const CTX_OPTIONS = [
  { value: 'ideas', label: '创新点池' },
  { value: 'literature', label: '文献库' },
  { value: 'experiments', label: '实验记录' },
  { value: 'paper', label: '论文进度' },
  { value: 'plan', label: '近期周计划' },
]

route('GET', '/chat/context/options', () => ({ options: CTX_OPTIONS }))

route('POST', '/chat/context/preview', (ctx) => {
  const body: any = ctx.body || {}
  return { text: buildContext(body.keys, body.extra) }
})

route('GET', '/chat/sessions', () =>
  db
    .all('chat_sessions')
    // 会话列表带 msg_count / first_msg：侧栏要显示消息数，未选中时要能给出预览
    .map((s): Row => ({
      ...s,
      msg_count: db.find('chat_messages', (m) => Number(m.session_id) === Number(s.id)).length,
      first_msg: firstMessageContent(Number(s.id)),
    }))
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))),
)

route('POST', '/chat/sessions', (ctx) => {
  const body: any = ctx.body || {}
  const title = String(pick(body, 'title', '') ?? '').trim() || '新对话'
  const ts = now()
  const row = db.insert('chat_sessions', {
    title,
    role: pick(body, 'role', 'assistant'),
    mode: pick(body, 'mode', 'fast'),
    // 新建即落库上下文快照：之后勾选项改变要显式 PATCH 才生效，会话行为可复现
    context: buildContext(pick<any>(body, 'context_keys', []), pick<any>(body, 'context_extra', '')),
    created_at: ts,
    updated_at: ts,
  })
  return sessionDetail(Number(row.id))
})

route('GET', '/chat/sessions/:id', (ctx) => sessionDetail(idParam(ctx)))

route('PATCH', '/chat/sessions/:id', (ctx) => {
  const id = idParam(ctx)
  if (!db.get('chat_sessions', id)) throw new ApiError('会话不存在', 404)
  const body: any = ctx.body || {}
  const patch: Row = {}
  if (body.title !== undefined) patch.title = String(body.title)
  if (body.role !== undefined) patch.role = body.role
  if (body.mode !== undefined) patch.mode = body.mode
  // 仅在显式传了上下文相关字段时才重建：页面改角色/模式不能顺手把上下文清空。
  // context_keys 缺省时用 ['ideas']，与页面默认勾选保持一致。
  if (body.context_keys !== undefined || body.context_extra !== undefined) {
    const keys = body.context_keys === undefined ? ['ideas'] : body.context_keys
    patch.context = buildContext(keys, body.context_extra)
  }
  patch.updated_at = now()
  db.update('chat_sessions', id, patch)
  return sessionDetail(id)
})

route('DELETE', '/chat/sessions/:id', (ctx) => {
  const id = idParam(ctx)
  // 先子后父：浏览器端没有外键级联，必须手动清消息，否则会留下孤儿行
  db.removeWhere('chat_messages', (m) => Number(m.session_id) === id)
  db.remove('chat_sessions', id)
  return { ok: true }
})

route('POST', '/chat/sessions/:id/clear', (ctx) => {
  const id = idParam(ctx)
  // 「清空记录」保留会话本身（标题/角色/上下文都在），只丢消息
  db.removeWhere('chat_messages', (m) => Number(m.session_id) === id)
  db.update('chat_sessions', id, { updated_at: now() })
  return { ok: true }
})

// ---------------------------------------------------------------------------
// 发消息（核心）
// ---------------------------------------------------------------------------

/** 自动标题：模型不可用或输出不合规时也要有兜底标题，绝不写空 */
async function autoTitle(text: string): Promise<string> {
  const fallback = text.replace(/\n/g, ' ').slice(0, 18) || '新对话'
  const prompt =
    `给下面这段对话起一个 12 字以内的中文标题。只输出标题本身，不要引号、不要解释、不要换行。\n\n` +
    text.slice(0, 500)
  const env = await completeResult(prompt, { mode: 'fast', task: 'chat-title', maxTokens: 64 })
  if (!env.ok) return fallback
  // 取首行并剥掉模型可能自带的引号/井号/星号等装饰
  const first = String(env.content || '').split('\n')[0] ?? ''
  const cleaned = first.replace(/[「」"'`#*]/g, '').trim()
  if (!cleaned || cleaned.length > 18) return fallback
  return cleaned
}

route('POST', '/chat/sessions/:id/messages', async (ctx) => {
  const id = idParam(ctx)
  const session = db.get('chat_sessions', id)
  if (!session) throw new ApiError('会话不存在', 404)

  const body: any = ctx.body || {}
  const regenerate = !!pick(body, 'regenerate', false)
  const historyLimit = Math.max(1, Number(pick(body, 'history_limit', 20)) || 20)
  // mode 优先级：本次请求 > 会话设定 > 默认快模型
  const mode = String(body.mode || session.mode || 'fast')
  let text = String(pick(body, 'content', '') ?? '').trim()

  if (regenerate) {
    // 重跑：以上一条用户消息为准，删掉它之后的助手回复，且不重复插入用户消息
    const users = db.find('chat_messages', (m) => Number(m.session_id) === id && m.role === 'user')
    const lastUser = users.length
      ? users.reduce((a, b) => (Number(a.id) > Number(b.id) ? a : b))
      : null
    if (lastUser) {
      text = String(lastUser.content ?? '').trim()
      db.removeWhere('chat_messages', (m) => Number(m.session_id) === id && Number(m.id) > Number(lastUser.id))
    }
    // 没有用户消息时落回普通流程（下面这条 content 会被当作新消息插入）
  }

  if (!text) badRequest('消息内容为空')

  if (!regenerate) {
    db.insert('chat_messages', { session_id: id, role: 'user', content: text, created_at: now() })
    // 用户一发消息就刷新会话活跃时间，侧栏排序立刻反映出来
    db.update('chat_sessions', id, { updated_at: now() })
  }

  // 历史按 id 倒序取最近 N 条再反转，等价 SQLite 的「子查询 + ORDER BY id」，
  // 含刚才插入的用户消息，保证多轮上下文连续。
  const history = db
    .find('chat_messages', (m) => Number(m.session_id) === id)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, historyLimit)
    .reverse()
    .map((m) => ({ role: String(m.role), content: String(m.content ?? '') }))

  let system = roleOf(session.role).system
  const context = String(session.context ?? '')
  if (context) system += `\n\n${context}`

  const env = await chatResult(history, system, mode === 'reason' ? 'reason' : 'fast', {
    task: 'chat',
    maxTokens: 4096,
  })

  if (!env.ok) {
    // 失败不落 assistant 行：页面重试时不会多出一条空回复，用户输入原样保留
    return { ok: false, reply: '', title: session.title, error: env.error }
  }

  db.insert('chat_messages', {
    session_id: id,
    role: 'assistant',
    content: env.content,
    // provider 存的是展示名 env.provider（name），与消息卡片显示一致
    provider: env.provider,
    model: env.model,
    tokens_in: env.tokens_in,
    tokens_out: env.tokens_out,
    created_at: now(),
  })

  // 自动标题只对首轮（消息数 <= 2，即「用户 + 助手」）生效，且用户没自己命名时。
  // 之后不再改标题，避免用户手动改名后被后续消息覆盖。
  let title = String(session.title ?? '')
  const count = db.find('chat_messages', (m) => Number(m.session_id) === id).length
  if ((!title || title === '新对话') && count <= 2) {
    title = await autoTitle(text)
    db.update('chat_sessions', id, { title, updated_at: now() })
  } else {
    db.update('chat_sessions', id, { updated_at: now() })
  }

  return {
    ok: true,
    reply: env.content.trim(),
    title,
    error: null,
    provider: env.provider,
    model: env.model,
    tokens_in: env.tokens_in,
    tokens_out: env.tokens_out,
  }
})

// ---------------------------------------------------------------------------
// 导出 / 用量
// ---------------------------------------------------------------------------

route('POST', '/chat/sessions/:id/export', (ctx) => {
  const id = idParam(ctx)
  const s = db.get('chat_sessions', id)
  if (!s) throw new ApiError('会话不存在', 404)
  const title = String(s.title || '对话')
  const lines: string[] = [`# ${title}`, '', `- 角色：${roleOf(s.role).label}`]
  const msgs = db
    .find('chat_messages', (m) => Number(m.session_id) === id)
    .sort((a, b) => Number(a.id) - Number(b.id))
  for (const m of msgs) {
    lines.push('', m.role === 'user' ? '## 我' : '## AI', '', String(m.content ?? ''))
  }
  return { markdown: lines.join('\n'), title }
})

route('GET', '/chat/usage', () => {
  // 按 (provider, task) 二元组聚合：同一 provider 的不同任务耗量差异大，合并会失真
  const agg = new Map<string, { provider: string; task: string; tin: number; tout: number; n: number }>()
  for (const r of db.all('llm_usage')) {
    const provider = String(r.provider ?? '')
    const task = String(r.task ?? '')
    const key = `${provider} ${task}`
    const g = agg.get(key) ?? { provider, task, tin: 0, tout: 0, n: 0 }
    g.n += 1
    g.tin += Number(r.tokens_in || 0)
    g.tout += Number(r.tokens_out || 0)
    agg.set(key, g)
  }
  return { rows: [...agg.values()].sort((a, b) => b.n - a.n).slice(0, 20) }
})
