/**
 * 科研画布 —— 节点 = skill、边 = 数据流、画布 = 可保存可重跑的科研流水线。
 *
 * 原实现是服务端 asyncio 后台任务 + 轮询。搬到浏览器后行为保持一致：
 * POST /run 立即返回 run_id，真正的执行在后台 Promise 里跑，
 * 页面照旧轮询 GET /runs/:id 拿进度与每个节点的输出。
 *
 * 这是整个产品里最像「智能体编排」的部分，所以执行语义按原样完整保留：
 * 拓扑序执行、上游输出注入 {{upstream}}、单节点重跑复用祖先缓存、逐节点留痕。
 */
import { route, notFound, badRequest, idParam, pick } from './core'
import db, { now } from '../db'
import { completeResult, RESEARCH_SYSTEM, type Mode } from '../llm'
import { getSkill, allSkills, skillCategories, type Skill } from '../skills'
import {
  BUILTIN_TEMPLATES,
  templateList,
  getTemplate,
  type CanvasTemplate,
} from '../canvas-templates'

/** 上游输出注入时的默认截断长度 */
const MAX_CTX_DEFAULT = 4000

/** 正在跑的 run（对应后端进程内的 _ACTIVE） */
const ACTIVE = new Set<number>()
/** 已请求取消的 run（对应后端进程内的 _CANCELLED） */
const CANCELLED = new Set<number>()

const USER_TPL_KEY = 'canvas_user_templates'

type NodeRow = Record<string, any>
type EdgeRow = Record<string, any>

/** 读取节点的 config（坏值当空对象，不抛错） */
function cfgOf(node: NodeRow): Record<string, any> {
  try {
    return JSON.parse(node.config_json || '{}') || {}
  } catch {
    return {}
  }
}

/** 画布内的节点（按入库顺序，等价 SQLite 无 ORDER BY 的 rowid 顺序） */
function nodesOf(canvasId: number): NodeRow[] {
  return db.find('canvas_nodes', (n) => n.canvas_id === canvasId)
}

function edgesOf(canvasId: number): EdgeRow[] {
  return db.find('canvas_edges', (e) => e.canvas_id === canvasId)
}

/** 某节点的全部上游 key，按 edges 入库顺序 */
function upstreams(key: string, edges: EdgeRow[]): string[] {
  return edges.filter((e) => e.target_key === key).map((e) => e.source_key)
}

/**
 * 模板渲染：
 * - {{upstream}} → 上游拼接文本（为空时给一句占位提示，避免模型对着空槽发呆）
 * - {{input}} → 节点的「直接补充要求」
 * - {{槽名}} → cfg.inputs 里对应的值
 * - 其余未填的 {{标识符}} 直接删掉，不留残缺占位符给模型
 */
function render(
  tpl: string,
  slots: Record<string, any>,
  upstreamText: string,
  direct: string,
  maxCtx: number,
): string {
  let up = upstreamText
  if (up.length > maxCtx) up = up.slice(0, maxCtx) + '\n\n…（上游输出过长已截断）'

  let out = tpl || ''
  out = out.replace(/\{\{upstream\}\}/g, up || '（无上游输入）')
  out = out.replace(/\{\{input\}\}/g, direct || '')
  for (const [k, v] of Object.entries(slots || {})) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v == null ? '' : String(v))
  }
  out = out.replace(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g, '')
  return out
}

/** 节点执行结果：文本 + 留痕元信息 */
interface NodeMeta {
  provider: string
  model: string
  tokens_in: number
  tokens_out: number
  elapsed_ms: number
  ok: boolean
  error?: Record<string, any> | null
}

function errMeta(kind: string, label: string, message: string, hint = ''): NodeMeta {
  return {
    provider: '',
    model: '',
    tokens_in: 0,
    tokens_out: 0,
    elapsed_ms: 0,
    ok: false,
    error: { kind, label, message, detail: '', hint },
  }
}

/** LLM 失败信封 → 节点级 meta */
function fromEnv(env: any, elapsed: number): NodeMeta {
  if (env.ok) {
    return {
      provider: env.provider,
      model: env.model,
      tokens_in: env.tokens_in,
      tokens_out: env.tokens_out,
      elapsed_ms: elapsed,
      ok: true,
      error: null,
    }
  }
  return {
    provider: env.provider || '',
    model: '',
    tokens_in: 0,
    tokens_out: 0,
    elapsed_ms: elapsed,
    ok: false,
    error: env.error,
  }
}

/** 执行单个节点 */
async function execNode(
  node: NodeRow,
  upstreamText: string,
  upstreamOk: Record<string, boolean>,
): Promise<{ text: string; meta: NodeMeta }> {
  const cfg = cfgOf(node)
  const type = node.type || 'skill'
  const t0 = Date.now()

  if (type === 'input') {
    return { text: cfg.text || '', meta: { ...okMeta(t0), elapsed_ms: Date.now() - t0 } }
  }

  if (type === 'output') {
    // 输出节点只做汇总：上游任一失败就不出结果，避免把半截流水线当成成品
    const failed = Object.entries(upstreamOk).find(([, ok]) => !ok)
    if (failed) {
      return {
        text: '',
        meta: errMeta('upstream_failed', '上游节点失败', '有上游节点执行失败，输出节点无法汇总', '先修好失败的上游节点再重跑'),
      }
    }
    const merged = (upstreamText || '').trim()
    if (!merged) {
      return {
        text: '',
        meta: errMeta('empty_upstream', '上游无内容', '上游节点没有产出内容', '先跑通上游节点'),
      }
    }
    const prefix = (cfg.prefix || '').trim()
    return { text: prefix ? `${prefix}\n${merged}` : merged, meta: okMeta(t0) }
  }

  if (type === 'prompt') {
    const prompt = (cfg.prompt || '').trim()
    if (!prompt) {
      return {
        text: '',
        meta: errMeta('not_configured', '节点未配置', '这个指令节点还没有写提示词', '在右侧面板填入提示词'),
      }
    }
    const rendered = render(
      prompt,
      cfg.inputs || {},
      upstreamText,
      cfg.text || '',
      Number(cfg.max_ctx) || MAX_CTX_DEFAULT,
    )
    const env = await completeResult(rendered, {
      system: (cfg.system || '').trim() || RESEARCH_SYSTEM,
      mode: (cfg.mode as Mode) || 'fast',
      task: 'canvas:custom',
      maxTokens: Number(cfg.max_tokens) || 3000,
      providerId: cfg.provider_id || null,
    })
    return { text: env.content, meta: fromEnv(env, Date.now() - t0) }
  }

  if (type === 'skill') {
    const skill: Skill | null = getSkill(node.skill_id || '')
    if (!skill) {
      return {
        text: '',
        meta: errMeta('not_configured', '节点未配置', `没有这个技能：${node.skill_id || '(空)'}`, '在右侧面板重新选择技能'),
      }
    }
    const rendered = render(
      skill.prompt,
      cfg.inputs || {},
      upstreamText,
      cfg.text || '',
      Number(cfg.max_ctx) || MAX_CTX_DEFAULT,
    )
    const env = await completeResult(rendered, {
      system: skill.system || RESEARCH_SYSTEM,
      mode: ((cfg.mode as Mode) || skill.mode || 'fast') as Mode,
      task: `canvas:${skill.id}`,
      maxTokens: Number(cfg.max_tokens) || 3000,
      providerId: cfg.provider_id || null,
    })
    return { text: env.content, meta: fromEnv(env, Date.now() - t0) }
  }

  if (type === 'tool') {
    return runTool(cfg, upstreamText, t0)
  }

  return {
    text: '',
    meta: errMeta('not_configured', '节点未配置', `未知的节点类型：${type}`, ''),
  }
}

function okMeta(t0: number): NodeMeta {
  return { provider: '', model: '', tokens_in: 0, tokens_out: 0, elapsed_ms: Date.now() - t0, ok: true, error: null }
}

/**
 * 工具节点。原实现支持 Dify 与任意 HTTP。
 * 浏览器端：HTTP 节点可用（受目标站点的 CORS 限制）；Dify 若未开跨域会失败，
 * 这里如实返回错误而不是静默假装成功。
 */
async function runTool(
  cfg: Record<string, any>,
  upstreamText: string,
  t0: number,
): Promise<{ text: string; meta: NodeMeta }> {
  const tool = cfg.tool || 'http'

  if (tool === 'dify') {
    return {
      text: '[Dify 节点未配置]',
      meta: {
        ...okMeta(t0),
        provider: 'dify:unconfigured',
        ok: false,
        error: {
          kind: 'tool_error',
          label: '工具调用失败',
          message: '浏览器环境无法直连 Dify（需要目标服务开启跨域）',
          detail: '',
          hint: '演示环境请改用「技能」节点，或把 Dify 换成允许跨域的 HTTP 端点。',
        },
      },
    }
  }

  if (tool === 'http') {
    const url = cfg.url || ''
    if (!url) {
      return {
        text: '[HTTP 节点未配置 url]',
        meta: {
          ...okMeta(t0),
          provider: 'http:unconfigured',
          ok: false,
          error: { kind: 'tool_error', label: '工具调用失败', message: 'HTTP 节点缺少 url', detail: '', hint: '在右侧面板填写请求地址' },
        },
      }
    }
    try {
      const bodyStr = JSON.stringify(cfg.body || {}).replace(/\{\{upstream\}\}/g, upstreamText || '')
      const res = await fetch(url, {
        method: (cfg.method || 'POST').toUpperCase(),
        headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
        body: bodyStr === '{}' ? undefined : bodyStr,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = (await res.text()).slice(0, 8000)
      return { text, meta: { ...okMeta(t0), provider: 'http:ok' } }
    } catch (e: any) {
      const msg = `${e?.name || 'Error'}: ${e?.message || e}`
      return {
        text: `[HTTP 调用失败] ${url}\n${msg}`,
        meta: {
          ...okMeta(t0),
          provider: 'http:error',
          ok: false,
          error: {
            kind: 'tool_error',
            label: '工具调用失败',
            message: 'http:error',
            detail: msg.slice(0, 300),
            hint: '检查 url 是否正确、目标服务是否允许浏览器跨域调用。',
          },
        },
      }
    }
  }

  return {
    text: '[未知工具类型] 支持 dify / http',
    meta: {
      ...okMeta(t0),
      provider: 'tool:unknown',
      ok: false,
      error: { kind: 'tool_error', label: '工具调用失败', message: 'tool:unknown', detail: '', hint: '只支持 dify / http 两种工具节点' },
    },
  }
}

/** Kahn 拓扑排序；有环时剩余节点按入库顺序兜底追加（与原实现一致，不报错） */
function topo(nodes: NodeRow[], edges: EdgeRow[]): NodeRow[] {
  const byKey = new Map<string, NodeRow>()
  for (const n of nodes) byKey.set(n.node_key, n)

  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const k of byKey.keys()) {
    indeg.set(k, 0)
    adj.set(k, [])
  }
  for (const e of edges) {
    if (!byKey.has(e.source_key) || !byKey.has(e.target_key)) continue
    adj.get(e.source_key)!.push(e.target_key)
    indeg.set(e.target_key, (indeg.get(e.target_key) || 0) + 1)
  }

  const queue: string[] = []
  for (const k of byKey.keys()) if ((indeg.get(k) || 0) === 0) queue.push(k)

  const order: string[] = []
  while (queue.length) {
    const k = queue.shift()!
    order.push(k)
    for (const t of adj.get(k) || []) {
      indeg.set(t, (indeg.get(t) || 0) - 1)
      if (indeg.get(t) === 0) queue.push(t)
    }
  }
  // 有环：残余节点按 key 顺序追加，保证「能跑的照跑」，不因为一处环整张图作废
  if (order.length !== byKey.size) {
    for (const k of byKey.keys()) if (!order.includes(k)) order.push(k)
  }
  return order.map((k) => byKey.get(k)!)
}

/** 某节点在**该画布全历史**中最近一条成功输出（单节点重跑复用祖先缓存用） */
function latestOutput(canvasId: number, nodeKey: string): string | null {
  const runIds = new Set(db.find('canvas_runs', (r) => r.canvas_id === canvasId).map((r) => r.id))
  const rows = db
    .find('canvas_node_outputs', (o) => o.node_key === nodeKey && runIds.has(o.run_id) && (o.status || 'done') === 'done')
    .sort((a, b) => b.id - a.id)
  return rows.length ? (rows[0].output_text ?? '') : null
}

function outputView(o: NodeRow) {
  let error = null
  if (o.error_json) {
    try {
      error = JSON.parse(o.error_json)
    } catch {
      error = null
    }
  }
  return { ...o, ok: (o.status || 'done') !== 'error', error }
}

/** 收集某节点的全部祖先（传递闭包），最多递归 20 层防环 */
function ancestors(key: string, edges: EdgeRow[], seen = new Set<string>(), depth = 0): Set<string> {
  if (depth > 20) return seen
  for (const u of upstreams(key, edges)) {
    if (!seen.has(u)) {
      seen.add(u)
      ancestors(u, edges, seen, depth + 1)
    }
  }
  return seen
}

/** 后台执行整次运行 */
async function executeRun(
  runId: number,
  canvasId: number,
  order: NodeRow[],
  allNodes: NodeRow[],
  edges: EdgeRow[],
  presetOutputs: Record<string, string>,
) {
  ACTIVE.add(runId)
  db.update('canvas_runs', runId, { status: 'running' })

  const byKey = new Map<string, NodeRow>()
  for (const n of allNodes) byKey.set(n.node_key, n)

  const outputs: Record<string, string> = { ...presetOutputs }
  const okMap: Record<string, boolean> = {}
  let failed = 0

  for (const node of order) {
    if (CANCELLED.has(runId)) {
      db.update('canvas_runs', runId, { status: 'cancelled', finished_at: now() })
      CANCELLED.delete(runId)
      ACTIVE.delete(runId)
      return
    }

    const key = node.node_key
    const ups = upstreams(key, edges)
    const parts: string[] = []
    for (const u of ups) {
      const out = outputs[u]
      if (out) {
        const title = byKey.get(u)?.title || u
        parts.push(`【${title}】\n${out}`)
      }
    }
    const upstreamText = parts.join('\n\n')
    const upstreamOk: Record<string, boolean> = {}
    for (const u of ups) upstreamOk[u] = okMap[u] ?? true

    const t0 = Date.now()
    let text = ''
    let meta: NodeMeta
    try {
      const r = await execNode(node, upstreamText, upstreamOk)
      text = r.text || ''
      meta = r.meta
    } catch (e: any) {
      // 单节点异常不中断整图，其余节点照跑
      meta = errMeta('unknown', '节点执行异常', `${e?.name || 'Error'}: ${e?.message || e}`, '重试该节点；反复失败就换个 provider 或简化输入。')
    }
    if (!meta.elapsed_ms) meta.elapsed_ms = Date.now() - t0

    outputs[key] = text
    okMap[key] = meta.ok
    if (!meta.ok) failed++

    db.insert('canvas_node_outputs', {
      run_id: runId,
      node_key: key,
      // 留痕的上游文本固定截 4000 字，与节点的 max_ctx 无关（避免把整段大文本塞进库）
      input_text: upstreamText.slice(0, 4000),
      output_text: text,
      provider: meta.provider,
      model: meta.model,
      tokens_in: meta.tokens_in,
      tokens_out: meta.tokens_out,
      elapsed_ms: meta.elapsed_ms,
      status: meta.ok ? 'done' : 'error',
      error_json: meta.ok ? null : JSON.stringify(meta.error),
      created_at: now(),
    })
  }

  CANCELLED.delete(runId)
  ACTIVE.delete(runId)
  db.update('canvas_runs', runId, { status: failed ? 'failed' : 'done', finished_at: now() })
}

// ============================ 路由 ============================

// ---- 技能库 ----
route('GET', '/canvas/skills', () => ({ skills: allSkills(), categories: skillCategories() }))

// GitHub 上的 skill 需要服务端克隆仓库并读文件，浏览器做不到，降级但要说明白
route('GET', '/canvas/skills/github', () => ({
  ok: true,
  root: '',
  count: 0,
  repos: [],
  skills: [],
  message: '浏览器环境无法克隆 GitHub 仓库，请使用内置的 15 个技能',
}))

route('POST', '/canvas/skills/github/clone', () => {
  badRequest('浏览器环境无法克隆 GitHub 仓库（需要服务端 git 能力），请使用内置技能')
})

route('GET', '/canvas/skills/github/:id/source', () => {
  notFound('github skill')
})

route('GET', '/canvas/skills/github/:id/files', () => {
  notFound('github skill')
})

route('GET', '/canvas/skills/github/:id/file', () => {
  notFound('github skill')
})

// ---- 模板 ----
route('GET', '/canvas/templates', () => {
  const user = db.settingJson<any[]>(USER_TPL_KEY, [])
  const list = templateList()
  for (const t of user) {
    list.push({ key: t.key, name: t.name, node_count: (t.nodes || []).length, builtin: false, created_at: t.created_at || '' })
  }
  return { templates: list }
})

route('DELETE', '/canvas/templates/:key', (ctx) => {
  const key = ctx.params.key
  if (BUILTIN_TEMPLATES[key]) badRequest('内置模板不能删除')
  const user = db.settingJson<any[]>(USER_TPL_KEY, [])
  const next = user.filter((t) => t.key !== key)
  if (next.length === user.length) notFound('template')
  db.setSettingJson(USER_TPL_KEY, next)
  return { ok: true }
})

// ---- 运行记录（必须放在 /canvas/:id 之前注册，否则 runs 会被当成画布 id）----
route('GET', '/canvas/runs/:id', (ctx) => {
  const runId = idParam(ctx)
  const run = db.get('canvas_runs', runId)
  if (!run) notFound('run')

  // 孤儿任务判死：进程重启后内存里的 ACTIVE 是空的，残留的 running 永远跑不完，
  // 不处理的话前端会一直转圈。这里如实标成失败并给出可操作提示。
  let view: any = { ...run }
  if ((run.status === 'running' || run.status === 'queued') && !ACTIVE.has(runId)) {
    db.update('canvas_runs', runId, { status: 'failed', finished_at: now() })
    view.status = 'failed'
    view.stale = true
    view.message = '上次运行随服务中断结束了，没有留下结果。重跑一次即可。'
  }
  const outputs = db
    .find('canvas_node_outputs', (o) => o.run_id === runId)
    .sort((a, b) => a.id - b.id)
    .map(outputView)
  view.node_count = outputs.length
  return { run: view, outputs }
})

route('POST', '/canvas/runs/:id/cancel', (ctx) => {
  const runId = idParam(ctx)
  const run = db.get('canvas_runs', runId)
  if (!run) notFound('run')
  if (['done', 'failed', 'cancelled'].includes(run.status)) {
    return { ok: false, status: run.status, message: '这次运行已经结束了' }
  }
  CANCELLED.add(runId)
  return { ok: true, status: 'cancelling', message: '已请求取消，正在运行的节点结束后停止' }
})

// ---- 画布列表 / 创建 ----
route('POST', '/canvas/auto', () => {
  badRequest('AI 自动编排需要服务端调用大模型生成长流程；当前版本请在画布面板从模板创建或手动拖拽技能节点。')
})

route('GET', '/canvas', () => {
  const list = db
    .all('canvases')
    .map(
      (c): Record<string, any> => ({
        ...c,
        node_count: db.find('canvas_nodes', (n) => n.canvas_id === c.id).length,
      }),
    )
    .sort((a, b) => b.id - a.id)
  const user = db.settingJson<any[]>(USER_TPL_KEY, [])
  const templates = templateList()
  for (const t of user) {
    templates.push({ key: t.key, name: t.name, node_count: (t.nodes || []).length, builtin: false, created_at: t.created_at || '' })
  }
  return { canvases: list, templates }
})

route('POST', '/canvas', (ctx) => {
  const name = String(pick(ctx.body, 'name', '新画布'))
  const templateKey = ctx.body?.template ? String(ctx.body.template) : ''
  const tpl = templateKey ? getTemplate(templateKey) : null
  const finalName = tpl && (name === '' || name === '新画布') ? tpl.name : name

  const canvas = db.insert('canvases', {
    name: finalName,
    template: templateKey || null,
    created_at: now(),
    updated_at: now(),
  })

  if (tpl) {
    for (const n of tpl.nodes) {
      db.insert('canvas_nodes', {
        canvas_id: canvas.id,
        node_key: n.node_key,
        type: n.type || 'skill',
        skill_id: n.skill_id ?? null,
        title: n.title || '',
        x: n.x ?? 0,
        y: n.y ?? 0,
        config_json: JSON.stringify(n.config || {}),
      })
    }
    for (const e of tpl.edges) {
      db.insert('canvas_edges', { canvas_id: canvas.id, source_key: e.source_key, target_key: e.target_key })
    }
  }
  return { id: canvas.id, name: canvas.name }
})

// ---- 画布详情 ----
route('GET', '/canvas/:id', (ctx) => {
  const canvasId = idParam(ctx)
  const canvas = db.get('canvases', canvasId)
  if (!canvas) notFound('canvas')

  const nodes = nodesOf(canvasId)
  const edges = edgesOf(canvasId)
  const runs = db
    .find('canvas_runs', (r) => r.canvas_id === canvasId)
    .sort((a, b) => b.id - a.id)
    .slice(0, 10)
    .map((r) => ({
      ...r,
      out_count: db.find('canvas_node_outputs', (o) => o.run_id === r.id).length,
    }))

  const allRuns = db.find('canvas_runs', (r) => r.canvas_id === canvasId)
  const latestId = allRuns.length ? Math.max(...allRuns.map((r) => r.id)) : null
  const latest = latestId
    ? db.find('canvas_node_outputs', (o) => o.run_id === latestId).sort((a, b) => a.id - b.id).map(outputView)
    : []

  return { canvas, nodes, edges, runs, latest }
})

route('DELETE', '/canvas/:id', (ctx) => {
  const canvasId = idParam(ctx)
  const canvas = db.get('canvases', canvasId)
  if (!canvas) notFound('canvas')
  // 级联顺序与原后端一致：先输出、再运行、再节点、再连线、最后画布本身
  const runIds = db.find('canvas_runs', (r) => r.canvas_id === canvasId).map((r) => r.id)
  db.removeWhere('canvas_node_outputs', (o) => runIds.includes(o.run_id))
  db.removeWhere('canvas_runs', (r) => r.canvas_id === canvasId)
  db.removeWhere('canvas_nodes', (n) => n.canvas_id === canvasId)
  db.removeWhere('canvas_edges', (e) => e.canvas_id === canvasId)
  db.remove('canvases', canvasId)
  return { ok: true }
})

// ---- 保存（全量替换，非增量）----
route('POST', '/canvas/:id/save', (ctx) => {
  const canvasId = idParam(ctx)
  const canvas = db.get('canvases', canvasId)
  if (!canvas) notFound('canvas')

  const nodes = Array.isArray(ctx.body?.nodes) ? ctx.body.nodes : []
  const edges = Array.isArray(ctx.body?.edges) ? ctx.body.edges : []

  db.removeWhere('canvas_nodes', (n) => n.canvas_id === canvasId)
  db.removeWhere('canvas_edges', (e) => e.canvas_id === canvasId)

  for (const n of nodes) {
    db.insert('canvas_nodes', {
      canvas_id: canvasId,
      node_key: n.node_key,
      type: n.type || 'skill',
      skill_id: n.skill_id ?? null,
      title: n.title || '',
      x: n.x ?? 0,
      y: n.y ?? 0,
      config_json: JSON.stringify(n.config || {}),
    })
  }
  for (const e of edges) {
    db.insert('canvas_edges', { canvas_id: canvasId, source_key: e.source_key, target_key: e.target_key })
  }

  const patch: Record<string, any> = { updated_at: now() }
  if (ctx.body?.name) patch.name = String(ctx.body.name)
  db.update('canvases', canvasId, patch)

  return { ok: true, saved: nodes.length }
})

route('POST', '/canvas/:id/save-as-template', (ctx) => {
  const canvasId = idParam(ctx)
  const canvas = db.get('canvases', canvasId)
  if (!canvas) notFound('canvas')

  const nodes = nodesOf(canvasId)
  if (nodes.length === 0) badRequest('空画布不能存为模板')

  const name = (String(pick(ctx.body, 'name', '')).trim() || canvas.name || '未命名模板').slice(0, 40)
  const user = db.settingJson<any[]>(USER_TPL_KEY, [])

  // 从 u1 起找第一个没被占用的 key
  let i = 1
  while (user.some((t) => t.key === `u${i}`)) i++
  const key = `u${i}`

  const ts = now().slice(0, 16).replace('T', ' ')
  const existing = user.find((t) => t.name === name)

  const tpl: CanvasTemplate = {
    key: existing ? existing.key : key,
    name,
    nodes: nodes.map((n) => ({
      node_key: n.node_key,
      type: n.type || 'skill',
      skill_id: n.skill_id ?? null,
      title: n.title || '',
      x: n.x ?? 0,
      y: n.y ?? 0,
      config: cfgOf(n),
    })),
    edges: edgesOf(canvasId).map((e) => ({ source_key: e.source_key, target_key: e.target_key })),
    builtin: false,
    created_at: existing ? existing.created_at : ts,
  }

  const next = existing ? user.map((t) => (t.key === existing.key ? tpl : t)) : [...user, tpl]
  db.setSettingJson(USER_TPL_KEY, next)
  return { key: tpl.key, name: tpl.name, node_count: tpl.nodes.length }
})

// ---- 运行 ----
route('POST', '/canvas/:id/run', (ctx) => {
  const canvasId = idParam(ctx)
  const canvas = db.get('canvases', canvasId)
  if (!canvas) notFound('canvas')

  const nodes = nodesOf(canvasId)
  if (nodes.length === 0) badRequest('画布为空')

  const edges = edgesOf(canvasId)
  const nodeKey: string | null = ctx.body?.node_key || null
  const force = !!ctx.body?.force
  const byKey = new Map(nodes.map((n) => [n.node_key, n]))

  let order: NodeRow[]
  const presetOutputs: Record<string, string> = {}

  if (nodeKey) {
    if (!byKey.has(nodeKey)) notFound('node')
    const ups = ancestors(nodeKey, edges)
    if (force) {
      // 强制重跑：连祖先一起跑，不装载缓存
      const need = new Set([...ups, nodeKey])
      order = topo(nodes, edges).filter((n) => need.has(n.node_key))
    } else {
      // 只跑本节点：祖先优先复用历史成功输出，避免为了改一句话把整条链重跑一遍
      for (const u of ups) {
        const cached = latestOutput(canvasId, u)
        if (cached != null) presetOutputs[u] = cached
      }
      order = topo(nodes, edges).filter((n) => n.node_key === nodeKey)
    }
  } else {
    order = topo(nodes, edges)
  }

  const run = db.insert('canvas_runs', {
    canvas_id: canvasId,
    scope: nodeKey || 'all',
    status: 'queued',
    started_at: now(),
    finished_at: null,
  })

  // 先登记 ACTIVE 再起后台任务：否则 GET /runs/:id 可能抢在调度前把这次运行误判为孤儿
  ACTIVE.add(run.id)
  void executeRun(run.id, canvasId, order, nodes, edges, presetOutputs)

  return {
    run_id: run.id,
    status: 'queued',
    nodes: order.map((n) => n.node_key),
    scope: nodeKey || 'all',
  }
})

route('GET', '/canvas/:id/runs', (ctx) => {
  const canvasId = idParam(ctx)
  const runs = db
    .find('canvas_runs', (r) => r.canvas_id === canvasId)
    .sort((a, b) => b.id - a.id)
    .slice(0, 20)
    .map((r) => ({ ...r, out_count: db.find('canvas_node_outputs', (o) => o.run_id === r.id).length }))
  return { runs }
})

// ---- 输出落库 ----
route('POST', '/canvas/:id/output/save', (ctx) => {
  const canvasId = idParam(ctx)
  const canvas = db.get('canvases', canvasId)
  if (!canvas) notFound('canvas')

  const nodeKey = String(ctx.body?.node_key || '')
  const target = String(pick(ctx.body, 'target', 'idea'))
  const runIds = db.find('canvas_runs', (r) => r.canvas_id === canvasId).map((r) => r.id)
  const rows = db
    .find('canvas_node_outputs', (o) => o.node_key === nodeKey && runIds.includes(o.run_id))
    .sort((a, b) => b.id - a.id)
  if (rows.length === 0) notFound('该节点还没有运行输出')

  const last = rows[0]
  if ((last.status || 'done') === 'error') {
    let msg = '未知原因'
    try {
      msg = JSON.parse(last.error_json || '{}')?.message || msg
    } catch {
      /* 保留兜底文案 */
    }
    throw Object.assign(new Error(`这个节点最后一次运行是失败的（${msg}），没有可保存的成果。修好配置后重跑节点再存。`), { status: 409 })
  }

  const text = String(last.output_text || '')
  if (!text.trim()) {
    throw Object.assign(new Error('这个节点的输出是空的，先重跑拿到结果再存'), { status: 409 })
  }

  const title = String(pick(ctx.body, 'title', '')).trim() || `画布产出 · ${nodeKey} · ${now().slice(0, 10)}`

  if (target === 'literature') {
    const row = db.insert('literature', {
      title,
      authors: '画布产出',
      notes: text,
      status: 'todo',
      created_at: now(),
      updated_at: now(),
    })
    return { ok: true, target: 'literature', id: row.id }
  }

  if (target === 'paper') {
    // 写进「最该被推进」的那个阶段：优先 blocked，其次 doing
    const stages = db.all('paper_stages')
    if (stages.length === 0) badRequest('还没有论文阶段可以写入')
    const rank = (s: string) => (s === 'blocked' ? 0 : s === 'doing' ? 1 : 2)
    const stage = stages
      .slice()
      .sort((a, b) => rank(a.status) - rank(b.status) || (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)[0]
    db.update('paper_stages', stage.id, { blocker: text.slice(0, 500), updated_at: now() })
    return { ok: true, target: 'paper', stage_id: stage.id }
  }

  const row = db.insert('ideas', {
    title,
    one_liner: text.slice(0, 200),
    direction: '画布',
    status: 'captured',
    notes: text,
    created_at: now(),
    updated_at: now(),
  })
  return { ok: true, target: 'idea', id: row.id }
})
