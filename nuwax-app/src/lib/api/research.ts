/**
 * research 领域路由 —— 创新点 / 文献 / 实验三块的核心 CRUD 与 AI 动作。
 *
 * 这是原 FastAPI 后端（db.py + llm.py）的浏览器端实现：数据落 localStorage，
 * AI 调用走浏览器直连 provider。三块放同一文件是因为它们在业务上属于同一条
 * 主线（想法 → 文献支撑 → 实验验证），并复用了大量提示词拼装与笔记 upsert 逻辑。
 *
 * 路由注册顺序有讲究：参数路由（/:id）会吞掉同层级的字面量路径，
 * 因此所有字面量路由（categories / matrix / keywords …）一律先于 :id 注册。
 */
import db, { now, type Row } from '../db'
import { completeJsonResult, completeResult } from '../llm'
import { badRequest, idParam, notFound, pick, route } from './core'

// ------------------------------------------------------------------ 通用工具

/** 取字符串：null/undefined 回退，其余强制转串（对齐后端 str() 的宽松语义） */
function str(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v)
}

/** 评分归一：缺失/非数字给默认 3，否则夹到 1..5 —— 模型输出不可信，必须兜底 */
function clampScore(v: unknown, fallback = 3): number {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(5, Math.max(1, n))
}

/** 解析 metrics_json：任何异常都退化成空对象，避免脏数据打断结果列表渲染 */
function parseMetrics(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * 动态导入 points 领域模块。
 * 积分是「结果」而非「原因」，若静态 import 会与 points.ts 形成循环依赖，
 * 所以延迟到真正加分时再取模块。
 */
async function pointsModule() {
  return await import('./points')
}

/** 加分：失败只吞掉异常，绝不影响主业务写入（激励不能反过来阻断流程） */
async function earnPoints(ruleKey: string, reason: string, refType: string, refId: number) {
  try {
    const pts = await pointsModule()
    pts.earn(ruleKey, reason, refType, refId)
  } catch {
    /* 积分模块不可用/未配置时静默跳过 */
  }
}

/** 从任意 body 中按白名单取字段：只有显式出现的键才进 patch，避免 undefined 覆盖 */
function whitelist(body: any, fields: readonly string[]): Row {
  const patch: Row = {}
  if (body == null) return patch
  for (const f of fields) if (body[f] !== undefined) patch[f] = body[f]
  return patch
}

/** 1-5 评分字段统一校验，越界抛出与后端一致的提示 */
function validateScores(patch: Row, fields: readonly string[]) {
  for (const f of fields) {
    if (patch[f] === undefined) continue
    const raw = patch[f]
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 1 || n > 5) {
      badRequest(`${f}需在 1-5 之间，收到 ${raw}`)
    }
    patch[f] = n
  }
}

/** 批量删除时把 ids 收敛成 Set<number>，只做一次成员判断 */
function idSet(body: any): number[] {
  return Array.isArray(body?.ids) ? body.ids.map((x: unknown) => Number(x)) : []
}

// ================================================================ 创新点 /ideas

const IDEA_FIELDS = [
  'title',
  'one_liner',
  'direction',
  'novelty',
  'feasibility',
  'impact',
  'effort',
  'status',
  'category',
  'notes',
] as const

const SCORE_FIELDS = ['novelty', 'feasibility', 'impact', 'effort'] as const

route('GET', '/ideas', (ctx) => {
  const status = ctx.query.get('status')
  const category = ctx.query.get('category')
  let rows = db.all('ideas')
  if (status) rows = rows.filter((r) => r.status === status)
  if (category) {
    // 「未分类」在分组统计里代表空分类，列表筛选保持同一语义，否则该分组点进来会是空
    if (category === '未分类') rows = rows.filter((r) => !str(r.category).trim())
    else rows = rows.filter((r) => str(r.category) === category)
  }
  return rows.sort((a, b) => b.id - a.id)
})

route('GET', '/ideas/categories', () => {
  // 分组统计：key 归一后聚合成 map，最后再算 avg_score —— 避免中途做浮点除法累积误差
  const map = new Map<string, { name: string; count: number; selected: number; sum: number }>()
  for (const r of db.all('ideas')) {
    const name = str(r.category).trim() || '未分类'
    let g = map.get(name)
    if (!g) {
      g = { name, count: 0, selected: 0, sum: 0 }
      map.set(name, g)
    }
    g.count += 1
    if (r.status === 'selected') g.selected += 1
    g.sum += Number(r.novelty || 0) + Number(r.feasibility || 0) + Number(r.impact || 0)
  }
  const groups = [...map.values()].map((g) => ({
    name: g.name,
    count: g.count,
    selected: g.selected,
    avg_score: g.count ? Math.round((g.sum / (3 * g.count)) * 100) / 100 : 0,
  }))
  // 先按数量降序，再按名称升序，保证结果稳定可复现
  groups.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { groups }
})

route('POST', '/ideas', (ctx) => {
  const b = ctx.body || {}
  const title = str(pick(b, 'title', '')).trim()
  if (!title) badRequest('title 不能为空')
  const catRaw = pick<string>(b, 'category', '')
  return db.insert('ideas', {
    title,
    one_liner: pick(b, 'one_liner', ''),
    direction: pick(b, 'direction', ''),
    novelty: pick(b, 'novelty', 3),
    feasibility: pick(b, 'feasibility', 3),
    impact: pick(b, 'impact', 3),
    effort: pick(b, 'effort', 3),
    status: pick(b, 'status', 'captured'),
    // 空串代表「没分类」，统一存 null，避免分组时出现 '' 与 null 两个桶
    category: catRaw === '' || catRaw == null ? null : catRaw,
    notes: pick(b, 'notes', ''),
    created_at: now(),
  })
})

route('PATCH', '/ideas/:id', async (ctx) => {
  const id = idParam(ctx)
  const cur = db.get('ideas', id)
  if (!cur) notFound('idea')
  const patch = whitelist(ctx.body, IDEA_FIELDS)
  validateScores(patch, SCORE_FIELDS)
  const updated = db.update('ideas', id, patch)!
  // 只有「跨过验证门槛」那一次才加分，重复 PATCH 相同状态不重复激励
  if (cur.status !== 'validated' && updated.status === 'validated') {
    await earnPoints('idea_validated', `创新点验证通过：${updated.title}`, 'idea', id)
  }
  return updated
})

route('DELETE', '/ideas/:id', (ctx) => {
  const id = idParam(ctx)
  if (!db.get('ideas', id)) notFound('idea')
  // 先清子表再删主表：localStorage 没有外键约束，顺序错了会留孤儿审稿记录
  db.removeWhere('idea_reviews', (r) => Number(r.idea_id) === id)
  db.remove('ideas', id)
  return { ok: true }
})

route('POST', '/ideas/bulk-delete', (ctx) => {
  const ids = idSet(ctx.body)
  if (ids.length === 0) return { deleted: 0 }
  const set = new Set(ids)
  db.removeWhere('idea_reviews', (r) => set.has(Number(r.idea_id)))
  db.removeWhere('ideas', (r) => set.has(Number(r.id)))
  // 返回请求条数（与后端一致）：前端用它拼提示文案，不关心实际命中几条
  return { deleted: ids.length }
})

route('GET', '/ideas/:id/reviews', (ctx) => {
  const id = idParam(ctx)
  return db
    .find('idea_reviews', (r) => Number(r.idea_id) === id)
    .sort((a, b) => b.id - a.id)
})

/** 三种审稿视角：默认回退到通用审稿人口吻 */
const REVIEW_TONES: Record<string, string> = {
  reviewer: '一位以严苛著称的顶级会议审稿人',
  mentor: '一位务实、只关心能不能落地的导师',
  rival: '一位同一方向、正想抢先发表竞争同行',
}
const REVIEW_TONE_DEFAULT = '一位严谨的通用审稿人'

route('POST', '/ideas/:id/review', async (ctx) => {
  const id = idParam(ctx)
  const idea = db.get('ideas', id)
  if (!idea) notFound('idea')
  const role = str(pick(ctx.body, 'role', 'reviewer'), 'reviewer')
  const tone = REVIEW_TONES[role] || REVIEW_TONE_DEFAULT

  const prompt = `你是${tone}。请对下面这个研究想法做一次不留情面的审查。

标题：${str(idea.title)}
一句话：${str(idea.one_liner) || '（未填）'}
方向：${str(idea.direction) || '（未填）'}
自评：新颖 ${idea.novelty}/5 · 可行 ${idea.feasibility}/5 · 影响 ${idea.impact}/5 · 投入 ${idea.effort}/5
备注：${str(idea.notes) || '（无）'}

请严格输出三部分：
① 致命问题 3 条：每条一句话，直指最可能推翻该想法的点，不要客套。
② 撞车点 + 待查关键词：指出可能与哪些已有工作撞车，并列出需要去查证的关键词。
③ 最小补救建议：在现有条件下 1-2 天就能动手改动的方案。`

  const env = await completeResult(prompt, { mode: 'reason', task: 'idea-review', maxTokens: 3072 })
  // 失败不落库：否则用户会看到一条空审稿记录，误以为生成成功
  if (!env.ok) return { ok: false, result: '', saved: false, error: env.error }

  db.insert('idea_reviews', {
    idea_id: id,
    role,
    content: env.content,
    created_at: now(),
  })
  const reviews = db
    .find('idea_reviews', (r) => Number(r.idea_id) === id)
    .sort((a, b) => b.id - a.id)
  return {
    ok: true,
    result: env.content,
    saved: true,
    reviews,
    provider: env.provider,
    model: env.model,
    tokens_in: env.tokens_in,
    tokens_out: env.tokens_out,
  }
})

/** 头脑风暴结果的归一化：模型字段可能缺失/越界，全部补默认再截断 */
function normalizeCandidates(raw: any[]): any[] {
  const out: any[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const title = str(item.title).trim().slice(0, 80)
    if (!title) continue
    out.push({
      title,
      one_liner: str(item.one_liner).trim(),
      defect: str(item.defect).trim(),
      mve: str(item.mve).trim(),
      novelty: clampScore(item.novelty),
      feasibility: clampScore(item.feasibility),
      impact: clampScore(item.impact),
      effort: clampScore(item.effort),
      category: str(item.category).trim().slice(0, 20),
      risk: str(item.risk).trim(),
    })
  }
  return out
}

route('POST', '/ideas/brainstorm', async (ctx) => {
  const b = ctx.body || {}
  const direction = str(pick(b, 'direction', '')).trim()
  if (!direction) badRequest('direction 不能为空')
  const context = str(pick(b, 'context', '')).trim()
  const countRaw = Number(pick(b, 'count', 5))
  const count = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : 5
  const categories = Array.isArray(b.categories) ? b.categories.map((x: unknown) => str(x)).filter(Boolean) : []
  const catRule = categories.length
    ? `优先复用这些已有分类：${categories.join('、')}；确实不合适时最多新增 1 个，新分类名 4-6 个字。`
    : `为每个想法给出一个 4-6 个字的分类名，且整批新分类总数不超过 3 个。`

  const prompt = `研究大方向：${direction}
已知背景 / 约束：${context || '（无）'}

请围绕该方向产出 ${count} 个具体、可验证的研究想法（不要泛泛而谈）。
${catRule}

请严格输出一个 JSON 数组，不要包含任何解释文字或代码块围栏。数组中每个元素是一个对象，字段如下：
- title：想法标题，不超过 12 个汉字
- one_liner：一句话说清这个想法做什么
- defect：该想法最可能被攻击的缺陷
- mve：最小验证实验（1-2 天可完成）
- novelty / feasibility / impact / effort：1-5 的整数自评
- category：分类名
- risk：主要风险`

  const { data, env } = await completeJsonResult<any[]>(prompt, {
    mode: 'reason',
    task: 'brainstorm',
    maxTokens: 4096,
  })
  const candidates = env.ok && Array.isArray(data) ? normalizeCandidates(data) : []

  if (candidates.length > 0) {
    return {
      ok: true,
      candidates,
      result: '',
      error: null,
      source: 'json',
      provider: env.provider,
      model: env.model,
      tokens_in: env.tokens_in,
      tokens_out: env.tokens_out,
    }
  }

  // JSON 拿不到可用候选就退回 Markdown 长文，保证至少能给用户一份可读产出
  const md = await completeResult(prompt, { mode: 'reason', task: 'brainstorm', maxTokens: 4096 })
  if (md.ok) {
    return {
      ok: true,
      candidates: [],
      result: md.content,
      error: null,
      source: 'markdown',
      provider: md.provider,
      model: md.model,
      tokens_in: md.tokens_in,
      tokens_out: md.tokens_out,
    }
  }
  // 失败分支刻意不带 tokens：页面据此判断「彻底没产出」，不渲染空结果
  return {
    ok: false,
    candidates: [],
    result: '',
    error: md.error,
    source: 'markdown',
    provider: md.provider,
    model: md.model,
  }
})

// ================================================================ 文献 /literature

const LIT_FIELDS = [
  'title',
  'authors',
  'year',
  'venue',
  'url',
  'status',
  'rating',
  'relevance',
  'notes',
  'tags',
  'idea_id',
  'pdf_path',
  'gloss_id',
] as const

/** 排序后的笔记列表：sort_order 优先，同序再按 id，保证前端展示稳定 */
function listNotes(literatureId: number): Row[] {
  return db
    .find('lit_notes', (n) => Number(n.literature_id) === literatureId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.id - b.id)
}

route('GET', '/literature', (ctx) => {
  const status = ctx.query.get('status')
  let rows = db.all('literature')
  if (status) rows = rows.filter((r) => r.status === status)
  return rows
    .sort((a, b) => b.id - a.id)
    // note_count 是列表页展示用的派生字段，不落库，避免两处数据不一致
    .map((r) => ({
      ...r,
      note_count: db.find('lit_notes', (n) => Number(n.literature_id) === Number(r.id)).length,
    }))
})

route('POST', '/literature', (ctx) => {
  const b = ctx.body || {}
  const title = str(pick(b, 'title', '')).trim()
  if (!title) badRequest('title 不能为空')
  // 刻意不返回 note_count：新建必然为 0，调用方不需要这个字段
  return db.insert('literature', {
    title,
    authors: pick(b, 'authors', ''),
    year: pick(b, 'year', null),
    venue: pick(b, 'venue', ''),
    url: pick(b, 'url', ''),
    status: pick(b, 'status', 'todo'),
    rating: pick(b, 'rating', 3),
    relevance: pick(b, 'relevance', ''),
    notes: pick(b, 'notes', ''),
    tags: pick(b, 'tags', ''),
    idea_id: pick(b, 'idea_id', null),
    created_at: now(),
  })
})

route('PATCH', '/literature/:id', async (ctx) => {
  const id = idParam(ctx)
  const cur = db.get('literature', id)
  if (!cur) notFound('literature')
  const patch = whitelist(ctx.body, LIT_FIELDS)
  validateScores(patch, ['rating'] as const)
  const updated = db.update('literature', id, patch)!
  // 状态跨过「读完」这道线时给一次分，重复标记不重复加
  if (cur.status !== 'done' && updated.status === 'done') {
    await earnPoints('paper_read_done', `读完文献：${updated.title}`, 'literature', id)
  }
  return updated
})

route('DELETE', '/literature/:id', (ctx) => {
  const id = idParam(ctx)
  // 矩阵单元格和笔记都挂在文献下，先删子表避免残留脏数据
  db.removeWhere('lit_matrix', (m) => Number(m.literature_id) === id)
  db.removeWhere('lit_notes', (n) => Number(n.literature_id) === id)
  db.remove('literature', id)
  return { ok: true }
})

route('POST', '/literature/bulk-delete', (ctx) => {
  const ids = idSet(ctx.body)
  if (ids.length === 0) return { deleted: 0 }
  const set = new Set(ids)
  db.removeWhere('lit_matrix', (m) => set.has(Number(m.literature_id)))
  db.removeWhere('lit_notes', (n) => set.has(Number(n.literature_id)))
  db.removeWhere('literature', (r) => set.has(Number(r.id)))
  return { deleted: ids.length }
})

route('POST', '/literature/keywords', async (ctx) => {
  const b = ctx.body || {}
  const topic = str(pick(b, 'topic', '')).trim()
  if (!topic) badRequest('topic 不能为空')
  const constraints = str(pick(b, 'constraints', '')).trim()

  const prompt = `研究主题：${topic}
附加约束：${constraints || '（无）'}

请输出一份可以直接拿去数据库检索的方案，包含：
① 3 组英文检索式（布尔逻辑，覆盖同义词与近义表达）
② 5 个核心关键词
③ 3-5 位该方向有代表性的作者
④ 2-3 个对口的会议或期刊
⑤ 1 条反向检索建议（用于顺藤摸瓜找到被引/引用的关键工作）`

  const env = await completeResult(prompt, { mode: 'fast', task: 'lit-keywords', maxTokens: 2048 })
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

route('GET', '/literature/:id/notes', (ctx) => {
  const id = idParam(ctx)
  return listNotes(id)
})

route('POST', '/literature/:id/notes', (ctx) => {
  const id = idParam(ctx)
  if (!db.get('literature', id)) notFound('literature')
  const b = ctx.body || {}
  const section = str(pick(b, 'section', '')).trim()
  if (!section) badRequest('section 不能为空')
  const content = str(pick(b, 'content', ''))

  const existing = db.first(
    'lit_notes',
    (n) => Number(n.literature_id) === id && str(n.section) === section,
  )
  if (existing) {
    // 同 section 覆盖：手动笔记要能盖掉 AI 生成的旧内容
    db.update('lit_notes', existing.id, { content, source: 'me' })
  } else {
    // 新节追加到末尾：sort_order 取当前最大值 +1
    let next = 0
    for (const n of db.find('lit_notes', (x) => Number(x.literature_id) === id)) {
      const so = Number(n.sort_order || 0)
      if (so >= next) next = so + 1
    }
    db.insert('lit_notes', {
      literature_id: id,
      section,
      content,
      sort_order: next,
      source: 'me',
      created_at: now(),
    })
  }
  return listNotes(id)
})

/** 固定六节：与前端抽屉、后端提示词三处保持一致，是「结构化阅读」的骨架 */
const DIGEST_SECTIONS = [
  '一句话贡献',
  '方法核心',
  '实验与结果',
  '局限与缺口',
  '与我的研究的关系',
  '值得追的引用',
] as const

/** 归一化 AI 返回/切分出的节：标题截断补默认，空内容丢弃 */
function normalizeDigestSections(raw: any): { title: string; content: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { title: string; content: string }[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue
    const title = str(s.title).trim().slice(0, 40) || '笔记'
    const content = str(s.content).trim()
    if (!content) continue
    out.push({ title, content })
  }
  return out
}

/** 把 Markdown 按 `## ` 行首标题切成节；切不出则整体作为「阅读笔记」一节 */
function splitMarkdownSections(md: string): { title: string; content: string }[] {
  const out: { title: string; content: string }[] = []
  let cur: { title: string; lines: string[] } | null = null
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      if (cur) out.push({ title: cur.title, content: cur.lines.join('\n') })
      cur = { title: line.slice(3).trim(), lines: [] }
    } else if (cur) {
      cur.lines.push(line)
    }
  }
  if (cur) out.push({ title: cur.title, content: cur.lines.join('\n') })
  if (out.length === 0 && md.trim()) return [{ title: '阅读笔记', content: md }]
  return out
}

/** 按 (literature_id, section) upsert，新节 sort_order 依次追加；返回实际落库的节 */
function saveNoteSections(
  literatureId: number,
  sections: { title: string; content: string }[],
): { title: string; content: string }[] {
  let next = 0
  for (const n of db.find('lit_notes', (x) => Number(x.literature_id) === literatureId)) {
    const so = Number(n.sort_order || 0)
    if (so >= next) next = so + 1
  }
  const saved: { title: string; content: string }[] = []
  for (const sec of sections) {
    const existing = db.first(
      'lit_notes',
      (n) => Number(n.literature_id) === literatureId && str(n.section) === sec.title,
    )
    if (existing) {
      db.update('lit_notes', existing.id, { content: sec.content, source: 'ai' })
    } else {
      db.insert('lit_notes', {
        literature_id: literatureId,
        section: sec.title,
        content: sec.content,
        sort_order: next++,
        source: 'ai',
        created_at: now(),
      })
    }
    saved.push(sec)
  }
  return saved
}

route('POST', '/literature/:id/digest', async (ctx) => {
  const id = idParam(ctx)
  const lit = db.get('literature', id)
  if (!lit) notFound('literature')
  const b = ctx.body || {}
  const section = str(pick(b, 'section', '')).trim()
  const focus = str(pick(b, 'focus', '')).trim()
  // 指定 section 时只生成那一节；否则生成固定六节全集
  const targets: string[] = section ? [section] : [...DIGEST_SECTIONS]

  const prompt = `请为下面这篇文献生成结构化的阅读笔记。

标题：${str(lit.title)}
作者：${str(lit.authors) || '（未填）'}
年份：${str(lit.year) || '（未填）'}
来源：${str(lit.venue) || '（未填）'}
摘要 / 备注：${str(lit.notes) || '（无）'}${focus ? `\n额外关注：${focus}` : ''}

需要生成的章节：${targets.join('、')}
请严格输出 JSON：{"sections":[{"title":"章节名","content":"该节内容"}]}，其中 title 必须使用上面给出的章节名。`

  const jsonRes = await completeJsonResult<{ sections?: any[] }>(prompt, {
    mode: 'fast',
    task: 'lit-digest',
    maxTokens: 3072,
  })
  let parsed: { title: string; content: string }[] = []
  let provider = jsonRes.env.provider
  let model = jsonRes.env.model

  if (jsonRes.env.ok && jsonRes.data && Array.isArray(jsonRes.data.sections)) {
    parsed = normalizeDigestSections(jsonRes.data.sections)
  }

  if (parsed.length === 0) {
    // 真正的调用失败（无 key / 断网）不该再浪费一次请求，直接报错
    const canFallback = jsonRes.env.ok || jsonRes.env.error?.kind === 'parse'
    if (!canFallback) {
      return { ok: false, sections: [], notes: listNotes(id), error: jsonRes.env.error }
    }
    // 解析失败但有原始文本时退回 Markdown 解析，尽量别让用户空手而归
    const md = await completeResult(prompt, { mode: 'fast', task: 'lit-digest', maxTokens: 3072 })
    if (!md.ok) {
      return { ok: false, sections: [], notes: listNotes(id), error: md.error }
    }
    provider = md.provider
    model = md.model
    parsed = normalizeDigestSections(splitMarkdownSections(md.content))
  }

  // 指定单节时只认标题匹配的那节，防止模型顺带吐出别的节污染笔记区
  const chosen = section ? parsed.filter((s) => s.title === section) : parsed
  const sections = saveNoteSections(id, chosen)
  return {
    ok: true,
    sections,
    notes: listNotes(id),
    error: null,
    provider,
    model,
  }
})

route('PATCH', '/lit_notes/:id', (ctx) => {
  const id = idParam(ctx)
  const patch = whitelist(ctx.body, ['section', 'content'] as const)
  if (Object.keys(patch).length === 0) badRequest('no valid field')
  if (!db.get('lit_notes', id)) notFound('lit_note')
  return db.update('lit_notes', id, patch)
})

route('DELETE', '/lit_notes/:id', (ctx) => {
  db.remove('lit_notes', idParam(ctx))
  return { ok: true }
})

route('GET', '/literature/matrix', () => {
  const rows = db.all('lit_matrix')
  // 维度按单元格首次出现的顺序去重，保持用户手动添加的先后感
  const dimensions: string[] = []
  for (const r of rows) {
    const name = str(r.dim_name)
    if (!dimensions.includes(name)) dimensions.push(name)
  }
  const papers = db
    .all('literature')
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((l) => {
      // 缺单元格补空串，前端表格渲染时不必再判 undefined
      const cells: Record<string, string> = {}
      for (const d of dimensions) {
        const hit = db.first(
          'lit_matrix',
          (m) => Number(m.literature_id) === Number(l.id) && str(m.dim_name) === d,
        )
        cells[d] = hit ? str(hit.dim_value) : ''
      }
      return { id: l.id, title: l.title, year: l.year, venue: l.venue, cells }
    })
  return { dimensions, papers }
})

route('POST', '/literature/matrix', (ctx) => {
  const b = ctx.body || {}
  const literatureId = Number(pick(b, 'literature_id', NaN))
  const dimName = str(pick(b, 'dim_name', '')).trim()
  const dimValue = pick(b, 'dim_value', undefined)
  if (!Number.isFinite(literatureId)) badRequest('literature_id 不能为空')
  if (!dimName) badRequest('dim_name 不能为空')
  // 空串是合法值（用于清空单元格），只要字段存在即可
  if (dimValue === undefined || dimValue === null) badRequest('dim_value 不能为空')

  const existing = db.first(
    'lit_matrix',
    (m) => Number(m.literature_id) === literatureId && str(m.dim_name) === dimName,
  )
  if (existing) {
    db.update('lit_matrix', existing.id, { dim_value: str(dimValue) })
    return { ok: true, id: existing.id }
  }
  const row = db.insert('lit_matrix', {
    literature_id: literatureId,
    dim_name: dimName,
    dim_value: str(dimValue),
    sort_order: 0,
  })
  return { ok: true, id: row.id }
})

route('POST', '/literature/matrix/dimension', (ctx) => {
  const name = str(pick(ctx.body, 'dim_name', '')).trim()
  if (!name) badRequest('维度名不能为空')
  const dim = name.slice(0, 40)
  // 为每篇文献补齐该维度的空单元格，表格列才能立刻对齐
  for (const l of db.all('literature')) {
    const has = db.first(
      'lit_matrix',
      (m) => Number(m.literature_id) === Number(l.id) && str(m.dim_name) === dim,
    )
    if (!has) {
      db.insert('lit_matrix', {
        literature_id: Number(l.id),
        dim_name: dim,
        dim_value: '',
        sort_order: 0,
      })
    }
  }
  return { ok: true }
})

route('DELETE', '/literature/matrix/dimension/:dim_name', (ctx) => {
  // core 的 match 已经做过 decodeURIComponent，这里直接用原始名
  const name = ctx.params.dim_name
  db.removeWhere('lit_matrix', (m) => str(m.dim_name) === name)
  return { ok: true }
})

// ================================================================ 实验 /experiments

const EXP_FIELDS = [
  'name',
  'hypothesis',
  'design',
  'status',
  'idea_id',
  'config_json',
  'conclusion',
] as const

route('GET', '/experiments', () => {
  return db.all('experiments').sort((a, b) => b.id - a.id)
})

route('POST', '/experiments', (ctx) => {
  const b = ctx.body || {}
  const name = str(pick(b, 'name', '')).trim()
  if (!name) badRequest('name 不能为空')
  return db.insert('experiments', {
    name,
    hypothesis: pick(b, 'hypothesis', ''),
    design: pick(b, 'design', ''),
    status: pick(b, 'status', 'planned'),
    idea_id: pick(b, 'idea_id', null),
    config_json: pick(b, 'config_json', ''),
    conclusion: pick(b, 'conclusion', ''),
    created_at: now(),
  })
})

route('PATCH', '/experiments/:id', async (ctx) => {
  const id = idParam(ctx)
  const cur = db.get('experiments', id)
  if (!cur) notFound('experiment')
  const patch = whitelist(ctx.body, EXP_FIELDS)
  const updated = db.update('experiments', id, patch)!
  if (cur.status !== 'done' && updated.status === 'done') {
    await earnPoints('experiment_done', `实验完成：${updated.name}`, 'experiment', id)
  }
  return updated
})

route('DELETE', '/experiments/:id', (ctx) => {
  const id = idParam(ctx)
  db.removeWhere('exp_results', (r) => Number(r.experiment_id) === id)
  db.remove('experiments', id)
  return { ok: true }
})

route('POST', '/experiments/bulk-delete', (ctx) => {
  const ids = idSet(ctx.body)
  if (ids.length === 0) return { deleted: 0 }
  const set = new Set(ids)
  db.removeWhere('exp_results', (r) => set.has(Number(r.experiment_id)))
  db.removeWhere('experiments', (r) => set.has(Number(r.id)))
  return { deleted: ids.length }
})

route('GET', '/experiments/:id/results', (ctx) => {
  const id = idParam(ctx)
  return db
    .find('exp_results', (r) => Number(r.experiment_id) === id)
    .sort((a, b) => a.id - b.id)
    // metrics 是解析后的对象，和原始 metrics_json 一起给前端，省得页面再解析一次
    .map((r) => ({ ...r, metrics: parseMetrics(r.metrics_json) }))
})

route('POST', '/experiments/:id/results', (ctx) => {
  const id = idParam(ctx)
  const b = ctx.body || {}
  const caseName = str(pick(b, 'case_name', '')).trim()
  if (!caseName) badRequest('case_name 不能为空')
  const row = db.insert('exp_results', {
    experiment_id: id,
    case_name: caseName,
    method: pick(b, 'method', ''),
    success: pick(b, 'success', 0),
    metrics_json: pick(b, 'metrics_json', ''),
    notes: pick(b, 'notes', ''),
    created_at: now(),
  })
  // 只回 id：调用方拿到后重新拉列表，避免自己拼一份可能过期的整行
  return { ok: true, id: row.id }
})

route('DELETE', '/results/:id', (ctx) => {
  db.remove('exp_results', idParam(ctx))
  return { ok: true }
})

route('POST', '/experiments/:id/analysis', async (ctx) => {
  const id = idParam(ctx)
  const exp = db.get('experiments', id)
  if (!exp) notFound('experiment')
  const rows = db
    .find('exp_results', (r) => Number(r.experiment_id) === id)
    .sort((a, b) => a.id - b.id)
  // 每行压成一行纯文本喂给模型：表格/JSON 混排反而更容易被漏读
  const lines = rows
    .map(
      (r) =>
        `- ${str(r.case_name)} | 方法=${str(r.method) || '-'} | 成功=${r.success ? 'true' : 'false'} | ` +
        `指标=${str(r.metrics_json) || '{}'} | 备注=${str(r.notes) || '-'}`,
    )
    .join('\n')

  const prompt = `实验名称：${str(exp.name)}
假设：${str(exp.hypothesis) || '（未填）'}
设计：${str(exp.design) || '（未填）'}

结果数据：
${lines || '（暂无结果）'}

请基于以上数据给出分析：
① 假设是否成立 —— 只对数据负责，数据不足就明说，不要脑补。
② 失败样本的共同特征与根因，按可能性从高到低排序。
③ 一张 Markdown 汇总表，逐行给出各 case 的关键结论。
④ 1-2 天内可以完成的最小补充实验。
⑤ 可以直接写进论文 Results 的 2-3 句话。`

  const env = await completeResult(prompt, { mode: 'reason', task: 'exp-analysis', maxTokens: 3072 })
  // 失败不写 conclusion：绝不能拿空内容覆盖用户已有的结论
  if (!env.ok) return { ok: false, result: '', saved: false, error: env.error }

  db.update('experiments', id, { conclusion: env.content })
  return {
    ok: true,
    result: env.content,
    saved: true,
    provider: env.provider,
    model: env.model,
    tokens_in: env.tokens_in,
    tokens_out: env.tokens_out,
  }
})
