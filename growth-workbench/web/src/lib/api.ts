import { toast } from '../components/toast'

const BASE = '/api'

/** 写操作成功后的默认反馈文案。想换具体说法就在调用处传 { ok: '…' }。 */
const WRITE_OK: Record<string, string> = {
  POST: '已保存',
  PUT: '已更新',
  PATCH: '已更新',
  DELETE: '已删除',
}

export type WriteOpts = {
  /** 成功提示文案；false = 不提示；省略 = 用方法默认文案 */
  ok?: string | false
  /** true = 完全静默（成功失败都不提示），由调用方自行展示结果 */
  silent?: boolean
  /**
   * 幂等键。传 true 自动生成，或传自己持有的字符串。
   *
   * 会做两件事：
   * 1. 带上 Idempotency-Key 头 —— 后端对同一把 key 只写一次，重复提交直接回放首次结果
   * 2. 同 key 的请求在飞行途中再发一次，直接复用上一个 Promise，不发第二个请求
   *
   * 注意：key 的生命周期 = 「这一次提交」。用户有意再建一条同名记录时开新 key，
   * 所以这里不会误伤「就是要建两条」的场景。
   */
  idem?: boolean | string
}

let _seq = 0
export function newIdemKey(prefix = 'w'): string {
  _seq += 1
  return `${prefix}-${Date.now().toString(36)}-${_seq}-${Math.random().toString(36).slice(2, 8)}`
}

/** 飞行中的幂等请求：同 key 并发直接复用，避免双击写成两条 */
const _inflight = new Map<string, Promise<unknown>>()

/** 后端抛的是 JSON {"detail": "..."} 或纯文本，统一剥成一句人话 */
function errText(raw: string, status: number): string {
  let msg = (raw || '').trim()
  if (!msg) return `请求失败（HTTP ${status}）`
  try {
    const j = JSON.parse(msg)
    if (j && typeof j.detail === 'string') msg = j.detail
    else if (j && typeof j.message === 'string') msg = j.message
  } catch {
    /* 不是 JSON 就用原文 */
  }
  return msg.length > 140 ? msg.slice(0, 140) + '…' : msg
}

async function request<T = any>(
  path: string,
  init?: RequestInit,
  opts?: WriteOpts,
): Promise<T> {
  // 容错：调用方误带 /api 前缀时剥掉，避免拼成 /api/api/... 404
  const p = path.startsWith('/api/') ? path.slice(4) : path
  const method = (init?.method || 'GET').toUpperCase()
  const writes = method !== 'GET'
  const quiet = !!opts?.silent
  // 每次写操作都给一次轻反馈：以前 70 多个写接口只有一个有提示，点了没反应很难判断到底成了没有
  const sayOk = writes && !quiet && opts?.ok !== false

  const idemKey = opts?.idem ? (opts.idem === true ? newIdemKey() : opts.idem) : ''
  if (idemKey) {
    const hit = _inflight.get(idemKey)
    if (hit) return hit as Promise<T>
  }

  const task = (async (): Promise<T> => {
    if (idemKey && init) {
      init.headers = { ...(init.headers as Record<string, string>), 'Idempotency-Key': idemKey }
    }
    return _send<T>(p, init, opts, method, writes, quiet, sayOk)
  })()

  if (idemKey) {
    _inflight.set(idemKey, task)
    task.finally(() => _inflight.delete(idemKey)).catch(() => {})
  }
  return task
}

async function _send<T = any>(
  p: string,
  init: RequestInit | undefined,
  opts: WriteOpts | undefined,
  method: string,
  writes: boolean,
  quiet: boolean,
  sayOk: boolean,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + p, init)
  } catch (e: any) {
    if (writes && !quiet) toast(`网络请求失败：${e?.message || '后端未响应'}`, 'error')
    throw e
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    const msg = errText(text, res.status)
    if (writes && !quiet) toast(msg, 'error')
    throw new Error(msg)
  }

  if (sayOk) toast(opts?.ok || WRITE_OK[method] || '已更新', 'ok')

  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return res.json() as Promise<T>
  return (await res.text()) as unknown as T
}

export const get = <T = any>(path: string) => request<T>(path)

export const post = <T = any>(path: string, body?: unknown, opts?: WriteOpts) =>
  request<T>(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    opts,
  )

export const patch = <T = any>(path: string, body?: unknown, opts?: WriteOpts) =>
  request<T>(
    path,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    opts,
  )

export const put = <T = any>(path: string, body?: unknown, opts?: WriteOpts) =>
  request<T>(
    path,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    opts,
  )

export const del = <T = any>(path: string, opts?: WriteOpts) =>
  request<T>(path, { method: 'DELETE' }, opts)

export const api = { get, post, put, patch, del }
export default api
