/**
 * API 兼容层 —— 用浏览器端实现替换原 FastAPI 后端。
 *
 * 原架构：页面 → fetch('/api/xxx') → FastAPI → SQLite
 * 新架构：页面 → 本文件 → 路由表 → 领域模块（localStorage + 浏览器直连 LLM）
 *
 * 设计目标：**页面组件一行都不用改**。对外仍导出 get/post/patch/put/del，
 * 仍接受原来的路径字符串，仍以返回 Pending 的 Promise、失败时抛 Error
 * （useApi / useAction 依赖这个语义）。
 */
import { toast } from '../components/toast'
import { dispatch } from './api/core'

export { ApiError } from './api/core'

const WRITE_OK: Record<string, string> = {
  POST: '已保存',
  PUT: '已更新',
  PATCH: '已更新',
  DELETE: '已删除',
}

export type WriteOpts = {
  /** 成功提示文案；false = 不提示；省略 = 用方法默认文案 */
  ok?: string | false
  /** true = 完全静默（成功失败都不提示） */
  silent?: boolean
  /** 幂等键：同 key 并发请求复用同一个 Promise，防双击写两条 */
  idem?: boolean | string
}

let _seq = 0
export function newIdemKey(prefix = 'w'): string {
  _seq += 1
  return `${prefix}-${Date.now().toString(36)}-${_seq}-${Math.random().toString(36).slice(2, 8)}`
}

const _inflight = new Map<string, Promise<unknown>>()

async function request<T = any>(
  path: string,
  method: string,
  body: any,
  opts?: WriteOpts,
): Promise<T> {
  const writes = method !== 'GET'
  const quiet = !!opts?.silent
  const sayOk = writes && !quiet && opts?.ok !== false

  const idemKey = opts?.idem ? (opts.idem === true ? newIdemKey() : opts.idem) : ''
  if (idemKey) {
    const hit = _inflight.get(idemKey)
    if (hit) return hit as Promise<T>
  }

  const task = (async () => {
    const res = await dispatch(method, path, body)
    if (sayOk) toast(opts?.ok || WRITE_OK[method] || '已更新', 'ok')
    return res as T
  })()

  if (idemKey) {
    _inflight.set(idemKey, task)
    task.finally(() => _inflight.delete(idemKey)).catch(() => {})
  }
  return task
}

export const get = <T = any>(path: string) => request<T>(path, 'GET', undefined)

export const post = <T = any>(path: string, body?: unknown, opts?: WriteOpts) =>
  request<T>(path, 'POST', body ?? {}, opts)

export const patch = <T = any>(path: string, body?: unknown, opts?: WriteOpts) =>
  request<T>(path, 'PATCH', body ?? {}, opts)

export const put = <T = any>(path: string, body?: unknown, opts?: WriteOpts) =>
  request<T>(path, 'PUT', body ?? {}, opts)

export const del = <T = any>(path: string, opts?: WriteOpts) =>
  request<T>(path, 'DELETE', undefined, opts)

export const api = { get, post, put, patch, del }
export default api

// 注册全部领域路由（副作用导入）
import './api/register'
