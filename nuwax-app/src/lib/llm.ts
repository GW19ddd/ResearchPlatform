/**
 * 浏览器端 LLM 客户端 —— 替代原后端的 llm.py。
 *
 * 原后端在服务端持有 API Key 并转发请求。搬到浏览器后，请求由浏览器直连
 * provider（已实测 DeepSeek 的 /chat/completions 返回 CORS 头，允许跨域）。
 *
 * 保留原 llm.py 的信封形状（ok/content/provider/provider_id/model/tokens/error）
 * 与全部错误 kind，页面组件与画布执行引擎无需感知实现变化。
 */
import db, { now } from './db'

export type ProviderType = 'openai' | 'responses' | 'ollama'
export type Routing = 'all' | 'fast' | 'reason'
export type Mode = 'fast' | 'reason'

export interface Provider {
  id: string
  name: string
  type: ProviderType
  base_url: string
  api_key: string
  model_fast: string
  model_reason: string
  routing: Routing
  enabled: boolean
}

export interface LlmConfig {
  default_provider: string
  providers: Provider[]
}

export interface LlmError {
  kind: string
  label: string
  message: string
  detail: string
  hint: string
}

export interface LlmEnvelope {
  ok: boolean
  content: string
  provider: string
  provider_id: string
  model: string
  tokens_in: number
  tokens_out: number
  error: LlmError | null
}

const CONFIG_KEY = 'llm_config'

export const PROVIDER_TYPES = [
  { value: 'openai', label: 'OpenAI 兼容 /chat/completions' },
  { value: 'responses', label: 'OpenAI Responses API（Codex / GPT）' },
  { value: 'ollama', label: 'Ollama 本地 /api/chat' },
]

/** 与原 llm.RESEARCH_SYSTEM 逐字一致 */
export const RESEARCH_SYSTEM =
  '你是一位严谨的科研助手，服务于一位做 OpenFOAM/CFD 与 LLM 智能体方向研究的博士生。回答用简体中文，结构化、具体、可执行，拒绝空话套话。涉及方法对比时优先用表格。不要臆造文献、数字或引用。'

/** 错误 kind → label / hint，与原 llm.py 的映射逐条对齐 */
export const ERROR_META: Record<string, { label: string; hint: string }> = {
  no_provider: {
    label: '没有可用的模型服务',
    hint: '去「设置」页添加一个 provider：DeepSeek / OpenAI(Codex) / Ollama / 本地 Qwen / 任意兼容端点。',
  },
  no_key: {
    label: '未配置 API Key',
    hint: '去「设置」页给这个 provider 填 API Key，或改用 Ollama / 本地 Qwen 这类不需要 key 的端点。',
  },
  auth: {
    label: '密钥校验失败',
    hint: 'API Key 无效或已过期，去「设置」页点「测试连接」确认。',
  },
  http_error: {
    label: '服务端返回错误',
    hint: '端点返回了错误状态码，去「设置」页点「测试连接」看具体原因。',
  },
  timeout: {
    label: '请求超时',
    hint: '请求超时。可以减少输入长度或换更快的模型后重试。',
  },
  network: {
    label: '网络不通',
    hint: '连不上端点。检查网络 / 是否被浏览器拦截了跨域请求（CORS）。',
  },
  empty_output: {
    label: '模型未输出内容',
    hint: '模型没有输出内容（推理过程可能耗尽了输出上限），重试或换用非推理模型。',
  },
  parse: {
    label: '返回内容无法解析',
    hint: '模型返回的内容不是需要的格式，重试即可。',
  },
  unknown: { label: '调用失败', hint: '未知错误。重试一次，或到「设置」页检查 provider 配置。' },
}

/** 默认 provider 配置（与后端 default_config 一致；api_key 留空，由使用者在设置页填） */
export function defaultConfig(): LlmConfig {
  return {
    default_provider: 'deepseek',
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        type: 'openai',
        base_url: 'https://api.deepseek.com/v1',
        api_key: '',
        model_fast: 'deepseek-chat',
        model_reason: 'deepseek-reasoner',
        routing: 'all',
        enabled: true,
      },
      {
        id: 'openai-codex',
        name: 'OpenAI / Codex',
        type: 'responses',
        base_url: 'https://api.openai.com/v1',
        api_key: '',
        model_fast: 'gpt-4o-mini',
        model_reason: 'o3-mini',
        routing: 'all',
        enabled: false,
      },
      {
        id: 'ollama',
        name: 'Ollama（本机）',
        type: 'ollama',
        base_url: 'http://localhost:11434',
        api_key: '',
        model_fast: 'qwen2.5:14b',
        model_reason: 'qwen2.5:14b',
        routing: 'all',
        enabled: false,
      },
    ],
  }
}

export function loadConfig(): LlmConfig {
  const cfg = db.settingJson<LlmConfig | null>(CONFIG_KEY, null)
  if (!cfg || !Array.isArray(cfg.providers) || cfg.providers.length === 0) return defaultConfig()
  return cfg
}

export function saveConfig(cfg: LlmConfig): LlmConfig {
  db.setSettingJson(CONFIG_KEY, cfg)
  return loadConfig()
}

export function maskKey(k: string): string {
  if (!k) return ''
  if (k.length >= 12) return '••••' + k.slice(-4)
  return '••••'
}

export function isMasked(v: string): boolean {
  return typeof v === 'string' && v.includes('••••')
}

/** 脱敏 + api_key_set 标记（对齐后端 mask_config） */
export function maskConfig(cfg: LlmConfig) {
  return {
    default_provider: cfg.default_provider,
    providers: cfg.providers.map((p) => ({
      ...p,
      api_key: maskKey(p.api_key),
      api_key_set: !!p.api_key,
    })),
  }
}

/** 选路：routing==mode 优先 → default_provider → routing==all → 首个 */
export function resolve(mode: Mode, providerId?: string | null): Provider | null {
  const cfg = loadConfig()
  if (providerId) {
    const hit = cfg.providers.find((p) => p.id === providerId)
    if (hit) return hit
  }
  const pool = cfg.providers.filter((p) => p.enabled !== false)
  if (pool.length === 0) return null
  return (
    pool.find((p) => p.routing === mode) ||
    pool.find((p) => p.id === cfg.default_provider) ||
    pool.find((p) => p.routing === 'all') ||
    pool[0]
  )
}

function modelOf(p: Provider, mode: Mode): string {
  return mode === 'reason' ? p.model_reason : p.model_fast || p.model_reason
}

/** 与后端 _effective_max_tokens 一致：reason 模式至少 8192 */
function effectiveMaxTokens(mode: Mode, maxTokens: number): number {
  return mode === 'reason' ? Math.max(maxTokens, 8192) : maxTokens
}

/** 密钥脱敏，异常信息里不能漏 key（对齐后端 redact） */
function redact(s: string): string {
  return String(s ?? '')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '***')
    .replace(/app-[A-Za-z0-9_-]{6,}/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
}

function fail(kind: string, provider: Provider | null, message?: string, detail = ''): LlmEnvelope {
  const meta = ERROR_META[kind] ?? ERROR_META.unknown
  return {
    ok: false,
    content: '',
    provider: provider?.name ?? '',
    provider_id: provider?.id ?? '',
    model: '',
    tokens_in: 0,
    tokens_out: 0,
    error: {
      kind,
      label: meta.label,
      message: redact(message || meta.label),
      detail: redact(detail),
      hint: meta.hint,
    },
  }
}

function okEnv(
  content: string,
  p: Provider,
  model: string,
  tin: number,
  tout: number,
): LlmEnvelope {
  return {
    ok: true,
    content,
    provider: p.name,
    provider_id: p.id,
    model,
    tokens_in: tin,
    tokens_out: tout,
    error: null,
  }
}

function logUsage(providerId: string, task: string, tin: number, tout: number) {
  try {
    db.insert('llm_usage', {
      provider: providerId,
      task,
      tokens_in: tin,
      tokens_out: tout,
      created_at: now(),
    })
  } catch {
    /* 用量记录失败不影响主流程 */
  }
}

export interface CompleteOpts {
  system?: string
  mode?: Mode
  task?: string
  maxTokens?: number
  providerId?: string | null
  messages?: { role: string; content: string }[]
}

type RawResult = { content: string; tin: number; tout: number }

/** 按 provider.type 分派请求，三种协议的请求体与解析各不相同 */
async function callProvider(
  p: Provider,
  model: string,
  messages: { role: string; content: string }[],
  mode: Mode,
  maxTokens: number,
): Promise<{ ok: true; value: RawResult } | { ok: false; env: LlmEnvelope }> {
  const base = (p.base_url || '').replace(/\/+$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`

  const temperature = mode === 'fast' ? 0.3 : 0
  let url = ''
  let body: unknown = null

  if (p.type === 'ollama') {
    url = `${base}/api/chat`
    body = {
      model,
      messages,
      stream: false,
      options: { num_predict: maxTokens, temperature },
    }
  } else if (p.type === 'responses') {
    url = `${base}/responses`
    body = { model, input: messages, max_output_tokens: maxTokens }
  } else {
    url = `${base}/chat/completions`
    body = { model, messages, max_tokens: maxTokens, temperature, stream: false }
  }

  // 浏览器直连，超时用 AbortController 实现
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 300_000)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e: any) {
    clearTimeout(timer)
    if (e?.name === 'AbortError') return { ok: false, env: fail('timeout', p) }
    // 浏览器跨域被拦时 fetch 抛 TypeError，归到 network 并给出可操作提示
    return {
      ok: false,
      env: fail('network', p, `连不上模型服务地址：${e?.message || '请求失败'}`),
    }
  }
  clearTimeout(timer)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const kind = res.status === 401 || res.status === 403 ? 'auth' : 'http_error'
    return { ok: false, env: fail(kind, p, `服务端返回 HTTP ${res.status}`, text.slice(0, 300)) }
  }

  let data: any
  try {
    data = await res.json()
  } catch (e: any) {
    return { ok: false, env: fail('parse', p, '响应不是合法 JSON', String(e?.message || e)) }
  }

  if (p.type === 'ollama') {
    const content = data?.message?.content ?? ''
    if (!content) return { ok: false, env: fail('empty_output', p, '模型未输出任何内容') }
    return {
      ok: true,
      value: {
        content,
        tin: data?.prompt_eval_count ?? 0,
        tout: data?.eval_count ?? 0,
      },
    }
  }

  if (p.type === 'responses') {
    let content = data?.output_text ?? ''
    if (!content && Array.isArray(data?.output)) {
      const parts: string[] = []
      for (const item of data.output) {
        for (const c of item?.content ?? []) {
          if (c?.type === 'output_text' || c?.type === 'text') parts.push(c.text ?? '')
        }
      }
      content = parts.join('\n')
    }
    if (!content) return { ok: false, env: fail('empty_output', p, '模型未输出任何内容') }
    return {
      ok: true,
      value: {
        content,
        tin: data?.usage?.input_tokens ?? 0,
        tout: data?.usage?.output_tokens ?? 0,
      },
    }
  }

  const content = data?.choices?.[0]?.message?.content ?? ''
  if (!content) {
    const fr = data?.choices?.[0]?.finish_reason
    const u = data?.usage ?? {}
    return {
      ok: false,
      env: fail(
        'empty_output',
        p,
        '模型未输出任何内容',
        `finish_reason=${fr} completion_tokens=${u.completion_tokens} reasoning_tokens=${u.completion_tokens_details?.reasoning_tokens}`,
      ),
    }
  }
  return {
    ok: true,
    value: {
      content,
      tin: data?.usage?.prompt_tokens ?? 0,
      tout: data?.usage?.completion_tokens ?? 0,
    },
  }
}

/** 统一的 LLM 调用入口（对应后端 complete_result） */
export async function completeResult(prompt: string, opts: CompleteOpts = {}): Promise<LlmEnvelope> {
  const mode: Mode = opts.mode ?? 'fast'
  const task = opts.task ?? 'generic'
  const maxTokens = effectiveMaxTokens(mode, opts.maxTokens ?? 2048)

  const p = resolve(mode, opts.providerId)
  if (!p) return fail('no_provider', null)
  if (p.type !== 'ollama' && !p.api_key) return fail('no_key', p)

  const model = modelOf(p, mode)
  const system = opts.system ?? RESEARCH_SYSTEM
  const messages =
    opts.messages && opts.messages.length > 0
      ? opts.messages
      : [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ]

  const r = await callProvider(p, model, messages, mode, maxTokens)
  if (!r.ok) return r.env

  logUsage(p.id, task, r.value.tin, r.value.tout)
  return okEnv(r.value.content, p, model, r.value.tin, r.value.tout)
}

/** 对应后端 chat_result：多轮消息 + system */
export async function chatResult(
  messages: { role: string; content: string }[],
  system: string,
  mode: Mode = 'fast',
  opts: { task?: string; maxTokens?: number; providerId?: string | null } = {},
): Promise<LlmEnvelope> {
  return completeResult('', {
    messages: [{ role: 'system', content: system }, ...messages],
    mode,
    task: opts.task ?? 'chat',
    maxTokens: opts.maxTokens ?? 4096,
    providerId: opts.providerId,
  })
}

/** 对应后端 complete_json_result：要求模型只输出 JSON 并解析 */
export async function completeJsonResult<T = any>(
  prompt: string,
  opts: CompleteOpts = {},
): Promise<{ data: T | null; env: LlmEnvelope }> {
  const env = await completeResult(
    prompt + '\n\n请只输出合法 JSON，不要包含解释文字或代码块围栏。',
    opts,
  )
  if (!env.ok) return { data: null, env }
  let text = env.content.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  try {
    return { data: JSON.parse(text) as T, env }
  } catch {
    return { data: null, env: fail('parse', resolve(opts.mode ?? 'fast', opts.providerId)) }
  }
}

/** 测试连接（对应后端 test_connection） */
export async function testConnection(
  draft: Partial<Provider>,
): Promise<{ ok: boolean; message: string }> {
  const cfg = loadConfig()
  const existing = draft.id ? cfg.providers.find((x) => x.id === draft.id) : undefined
  const p: Provider = {
    id: draft.id ?? 'draft',
    name: draft.name ?? 'draft',
    type: (draft.type as ProviderType) ?? 'openai',
    base_url: draft.base_url ?? existing?.base_url ?? '',
    api_key: draft.api_key && !isMasked(draft.api_key) ? draft.api_key : (existing?.api_key ?? ''),
    model_fast: draft.model_fast ?? existing?.model_fast ?? '',
    model_reason: draft.model_reason ?? existing?.model_reason ?? '',
    routing: (draft.routing as Routing) ?? 'all',
    enabled: true,
  }
  if (!p.base_url) return { ok: false, message: '先填 API 地址' }
  const model = modelOf(p, 'fast')
  const r = await callProvider(
    p,
    model,
    [
      { role: 'system', content: '你是连通性测试助手。' },
      { role: 'user', content: '请只回复两个字：可用' },
    ],
    'fast',
    64,
  )
  if (r.ok) return { ok: true, message: `连通正常 · 模型 ${model} 回复：${r.value.content.slice(0, 40)}` }
  return { ok: false, message: r.env.error?.message || '连接失败' }
}

/** 拉取模型列表（对应后端 /settings/llm/models） */
export async function listModels(
  draft: Partial<Provider>,
): Promise<{ ok: boolean; models: string[]; message?: string }> {
  const cfg = loadConfig()
  const existing = draft.id ? cfg.providers.find((x) => x.id === draft.id) : undefined
  const p: Provider = {
    id: draft.id ?? 'draft',
    name: draft.name ?? 'draft',
    type: (draft.type as ProviderType) ?? 'openai',
    base_url: draft.base_url ?? existing?.base_url ?? '',
    api_key: draft.api_key && !isMasked(draft.api_key) ? draft.api_key : (existing?.api_key ?? ''),
    model_fast: draft.model_fast ?? '',
    model_reason: draft.model_reason ?? '',
    routing: 'all',
    enabled: true,
  }
  const base = (p.base_url || '').replace(/\/+$/, '')
  if (!base) return { ok: false, models: [], message: '先填 API 地址' }
  const headers: Record<string, string> = {}
  if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`
  try {
    const url = p.type === 'ollama' ? `${base}/api/tags` : `${base}/models`
    const res = await fetch(url, { headers })
    if (!res.ok) return { ok: false, models: [], message: `HTTP ${res.status}` }
    const data = await res.json()
    const models: string[] =
      p.type === 'ollama'
        ? (data?.models ?? []).map((m: any) => m?.name).filter(Boolean)
        : (data?.data ?? []).map((m: any) => m?.id).filter(Boolean)
    return { ok: true, models: models.slice().sort() }
  } catch (e: any) {
    return { ok: false, models: [], message: redact(e?.message || String(e)) }
  }
}
