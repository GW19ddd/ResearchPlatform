/**
 * 设置域路由 —— 原 FastAPI 的 settings.py / llm.py 中「配置读写」部分的浏览器端实现。
 *
 * 为什么单独成文件：LLM 供应商与 Dify 应用都是「密钥 + 端点」型配置，密钥脱敏、
 * 已存密钥沿用、默认项顺延这套规则两边完全一样，集中在这里可以把安全口径写死一处。
 *
 * 安全基线：任何返回给页面的配置一律走脱敏（api_key → ••••后4位），
 * 明文密钥只存在于 localStorage，绝不随接口回传。
 */
import { route, notFound } from './core'
import db from '../db'
import {
  loadConfig,
  saveConfig,
  maskConfig,
  isMasked,
  PROVIDER_TYPES,
  testConnection,
  listModels,
  type LlmConfig,
  type Provider,
} from '../llm'

/** 生成业务侧短 id：原后端用 secrets.token_urlsafe 之类，这里只需「前缀 + 8 位可读随机」 */
function randId(prefix: string): string {
  return (prefix + Math.random().toString(36).slice(2, 10)).padEnd(prefix.length + 8, '0').slice(0, prefix.length + 8)
}

/**
 * 合并单条 provider：新 key 为空或是脱敏串时沿用库里同 id 的旧值。
 *
 * 为什么必须这样：GET 接口回传的是脱敏 key，前端保存时会把脱敏串原样 PUT 回来，
 * 若不做沿用就会把真 key 覆盖成「••••后4位」，用户配置直接损坏。
 */
function mergeProvider(incoming: any, existing?: Provider): Provider {
  const keepOld = !incoming.api_key || isMasked(incoming.api_key)
  return {
    id: String(incoming.id ?? existing?.id ?? randId('p')),
    name: incoming.name ?? existing?.name ?? '',
    type: (incoming.type ?? existing?.type ?? 'openai') as Provider['type'],
    base_url: incoming.base_url ?? existing?.base_url ?? '',
    api_key: keepOld ? (existing?.api_key ?? '') : String(incoming.api_key),
    model_fast: incoming.model_fast ?? existing?.model_fast ?? '',
    model_reason: incoming.model_reason ?? existing?.model_reason ?? '',
    routing: (incoming.routing ?? existing?.routing ?? 'all') as Provider['routing'],
    // enabled 用显式判断而非 ??：false 是合法值，不能被「缺省」逻辑吞掉
    enabled: incoming.enabled === undefined ? (existing?.enabled ?? true) : !!incoming.enabled,
  }
}

// ---------------------------------------------------------------------------
// LLM 配置
// ---------------------------------------------------------------------------

route('GET', '/settings/llm', () => ({ ...maskConfig(loadConfig()), types: PROVIDER_TYPES }))

route('PUT', '/settings/llm', (ctx) => {
  const body: any = ctx.body || {}
  const cfg = loadConfig()
  // providers 缺失/非法时退回原列表，避免前端一次异常请求把全部供应商清空
  const incoming: any[] = Array.isArray(body.providers) ? body.providers : cfg.providers
  const providers = incoming.map((p) => mergeProvider(p, cfg.providers.find((x) => x.id === p?.id)))
  const next: LlmConfig = {
    // 只改供应商列表、没带默认项时沿用原默认项，防止默认供应商被清空
    default_provider: body.default_provider ?? cfg.default_provider,
    providers,
  }
  return { ...maskConfig(saveConfig(next)), types: PROVIDER_TYPES }
})

route('POST', '/settings/llm/providers', (ctx) => {
  const body: any = ctx.body || {}
  const cfg = loadConfig()
  // 页面新增时通常不带 id，这里补一个；带了 id 则按更新处理，保证可幂等重放
  const p = mergeProvider(body, body.id ? cfg.providers.find((x) => x.id === body.id) : undefined)
  const saved = saveConfig({ default_provider: cfg.default_provider, providers: [...cfg.providers, p] })
  const masked = maskConfig(saved)
  return {
    config: masked,
    // 单条也回传脱敏对象：前端 addProvider 只用 id，给明文没有任何必要
    provider: masked.providers.find((x) => x.id === p.id),
  }
})

route('PUT', '/settings/llm/providers/:id', (ctx) => {
  // 路径 id 是权威来源，强制覆盖 body.id，避免 URL 与载荷不一致时改错记录
  const id = ctx.params.id
  const body: any = { ...(ctx.body || {}), id }
  const cfg = loadConfig()
  const idx = cfg.providers.findIndex((x) => x.id === id)
  const p = mergeProvider(body, idx >= 0 ? cfg.providers[idx] : undefined)
  const providers = [...cfg.providers]
  // 找不到就追加：PUT 语义上做成 upsert，前端重试不会静默丢配置
  if (idx >= 0) providers[idx] = p
  else providers.push(p)
  const masked = maskConfig(saveConfig({ default_provider: cfg.default_provider, providers }))
  return { config: masked, provider: masked.providers.find((x) => x.id === p.id) }
})

route('DELETE', '/settings/llm/providers/:id', (ctx) => {
  const id = ctx.params.id
  const cfg = loadConfig()
  const providers = cfg.providers.filter((x) => x.id !== id)
  // 删掉的正好是默认项：顺延到剩余第一个；一个都不剩则清空，交给 resolve() 兜底
  const defaultProvider = cfg.default_provider === id ? (providers[0]?.id ?? '') : cfg.default_provider
  return { config: maskConfig(saveConfig({ default_provider: defaultProvider, providers })) }
})

route('POST', '/settings/llm/providers/:id/default', (ctx) => {
  const id = ctx.params.id
  const cfg = loadConfig()
  if (!cfg.providers.some((x) => x.id === id)) notFound('provider')
  const saved = saveConfig({ default_provider: id, providers: cfg.providers })
  // 有意偏离原后端：原实现此处回传未脱敏配置，浏览器端改为始终脱敏。
  // 前端只读 config.default_provider，无兼容代价，但能杜绝明文 key 进页面内存。
  return { config: maskConfig(saved) }
})

/** 草稿或仅 id 的解析：给了 base_url 当草稿，否则必须能在库里找到，找不到按后端行为 404 */
function requireProvider(body: any) {
  if (!body?.base_url) {
    const existing = body?.id ? loadConfig().providers.find((x) => x.id === body.id) : undefined
    if (!existing) notFound('provider')
  }
}

route('POST', '/settings/llm/test', async (ctx) => {
  const body: any = ctx.body || {}
  requireProvider(body)
  return testConnection(body)
})

route('POST', '/settings/llm/models', async (ctx) => {
  const body: any = ctx.body || {}
  requireProvider(body)
  return listModels(body)
})

route('GET', '/settings/llm/usage', () => {
  // 裸数组（不包 rows）：调用统计卡片直接 .map，字段名沿用后端 provider/n/tin/tout
  const agg = new Map<string, { provider: string; n: number; tin: number; tout: number }>()
  for (const r of db.all('llm_usage')) {
    const provider = String(r.provider ?? '')
    const g = agg.get(provider) ?? { provider, n: 0, tin: 0, tout: 0 }
    g.n += 1
    g.tin += Number(r.tokens_in || 0)
    g.tout += Number(r.tokens_out || 0)
    agg.set(provider, g)
  }
  return [...agg.values()].sort((a, b) => b.n - a.n)
})

// ---------------------------------------------------------------------------
// Dify 配置
// ---------------------------------------------------------------------------

interface DifyApp {
  id: string
  name: string
  api_key: string
  mode: string
}

interface DifyConfig {
  enabled: boolean
  base_url: string
  apps: DifyApp[]
}

const DIFY_KEY = 'dify_config'
const DEFAULT_DIFY: DifyConfig = { enabled: false, base_url: 'http://localhost/v1', apps: [] }

const DIFY_MODES = [
  { value: 'workflow', label: '工作流' },
  { value: 'chat', label: '对话应用' },
]

function loadDify(): DifyConfig {
  const c = db.settingJson<DifyConfig | null>(DIFY_KEY, null)
  // 脏数据一律回退默认：设置页读取时不能因为一条坏记录整页白屏
  if (!c || typeof c !== 'object' || !Array.isArray(c.apps)) return { ...DEFAULT_DIFY, apps: [] }
  return {
    enabled: !!c.enabled,
    base_url: typeof c.base_url === 'string' ? c.base_url : DEFAULT_DIFY.base_url,
    apps: c.apps,
  }
}

/**
 * Dify 密钥展示口径（与 LLM 的 maskKey 不同，故意分开实现）：
 * 长 key 露出前 4/后 4 方便用户核对，短 key 只提示「已填」不露任何字符。
 */
function maskDifyKey(k: unknown): string {
  const v = String(k ?? '')
  if (!v) return '未填'
  return v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '已填'
}

function mergeDifyApp(incoming: any, existing?: DifyApp): DifyApp {
  const keepOld = !incoming?.api_key || isMasked(incoming.api_key)
  return {
    id: String(incoming?.id ?? existing?.id ?? randId('d')),
    name: incoming?.name ?? existing?.name ?? '',
    api_key: keepOld ? (existing?.api_key ?? '') : String(incoming.api_key),
    mode: incoming?.mode ?? existing?.mode ?? 'workflow',
  }
}

/** 脱敏后的配置体（无 modes）：POST/DELETE 单条接口的 config 与 LLM 侧保持同构 */
function difyConfigView(c: DifyConfig) {
  return {
    enabled: c.enabled,
    base_url: c.base_url,
    apps: c.apps.map((a) => ({ id: a.id, name: a.name, mode: a.mode, api_key_masked: maskDifyKey(a.api_key) })),
  }
}

/** 脱敏配置 + 模式选项：GET 与整表 PUT 回传的结构 */
function difyView(c: DifyConfig) {
  return { ...difyConfigView(c), modes: DIFY_MODES }
}

route('GET', '/settings/dify', () => difyView(loadDify()))

route('PUT', '/settings/dify', (ctx) => {
  const body: any = ctx.body || {}
  const cur = loadDify()
  const incoming: any[] = Array.isArray(body.apps) ? body.apps : cur.apps
  const apps = incoming.map((a) => mergeDifyApp(a, a?.id ? cur.apps.find((x) => x.id === a.id) : undefined))
  const next: DifyConfig = {
    enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
    base_url: body.base_url === undefined ? cur.base_url : String(body.base_url),
    apps,
  }
  db.setSettingJson(DIFY_KEY, next)
  return difyView(loadDify())
})

route('POST', '/settings/dify/apps', (ctx) => {
  const body: any = ctx.body || {}
  const cur = loadDify()
  const app = mergeDifyApp({ ...body, id: body.id ?? randId('d') }, undefined)
  const next: DifyConfig = { ...cur, apps: [...cur.apps, app] }
  db.setSettingJson(DIFY_KEY, next)
  const view = difyConfigView(loadDify())
  return { config: view, app: view.apps.find((x) => x.id === app.id) }
})

route('DELETE', '/settings/dify/apps/:id', (ctx) => {
  const id = ctx.params.id
  const cur = loadDify()
  const next: DifyConfig = { ...cur, apps: cur.apps.filter((a) => a.id !== id) }
  db.setSettingJson(DIFY_KEY, next)
  return { config: difyConfigView(loadDify()) }
})

route('POST', '/settings/dify/test', async (ctx) => {
  const body: any = ctx.body || {}
  const baseUrl = String(body.base_url || '').trim()
  if (!baseUrl) return { ok: false, message: '先填 Dify 的 API 地址，例如 http://localhost/v1' }

  // 这是本模块唯一允许真发网络请求的端点：Dify 可能部署在同源反代后，
  // 一次根地址探活就能区分「地址写错」与「服务没起」，对排障价值很高。
  // 去掉尾部 /v1 再 GET 根地址，因为展示页/应用页的根路径通常没有鉴权。
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') || baseUrl
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(root, { method: 'GET', signal: ctrl.signal })
    clearTimeout(timer)
    // 只要拿到 HTTP 响应就算可达，401/404 也说明地址是对的
    return { ok: true, message: `地址可达 · HTTP ${res.status}` }
  } catch (e: any) {
    clearTimeout(timer)
    if (e?.name === 'AbortError') return { ok: false, message: '地址不通：请求超时（8 秒）' }
    const msg = e?.message || String(e)
    // 浏览器跨域被拦时 fetch 抛 TypeError，与「服务真的挂了」区分开，给用户可操作的提示
    if (/Failed to fetch|NetworkError|load failed|CORS/i.test(msg)) {
      return { ok: false, message: `地址不通（浏览器跨域限制）：${msg}` }
    }
    return { ok: false, message: `地址不通：${msg}` }
  }
})
