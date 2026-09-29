/**
 * API 路由核心：路由注册表 + 匹配 + 派发。
 *
 * 单独成文件是为了避免循环依赖：领域模块 import 本文件，
 * 而 lib/api.ts import 领域模块的注册入口。若领域模块直接 import lib/api.ts，
 * ESM 的 import 提升会让 const 声明处于 TDZ，注册表拿不到。
 */

export interface Ctx {
  params: Record<string, string>
  query: URLSearchParams
  body: any
  method: string
  path: string
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>

interface Route {
  method: string
  pattern: string
  handler: Handler
}

const routes: Route[] = []

export function route(method: string, pattern: string, handler: Handler) {
  routes.push({ method: method.toUpperCase(), pattern, handler })
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const ps = pattern.split('/').filter(Boolean)
  const xs = path.split('/').filter(Boolean)
  if (ps.length !== xs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(':')) params[ps[i].slice(1)] = decodeURIComponent(xs[i])
    else if (ps[i] !== xs[i]) return null
  }
  return params
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function notFound(what: string): never {
  throw new ApiError(`${what} not found`, 404)
}

export function badRequest(message: string): never {
  throw new ApiError(message, 400)
}

export async function dispatch(method: string, rawPath: string, body: any): Promise<unknown> {
  let p = rawPath.startsWith('/api/') ? rawPath.slice(4) : rawPath
  if (!p.startsWith('/')) p = '/' + p

  const qi = p.indexOf('?')
  const query = new URLSearchParams(qi >= 0 ? p.slice(qi + 1) : '')
  const path = qi >= 0 ? p.slice(0, qi) : p

  const m = method.toUpperCase()
  for (const r of routes) {
    if (r.method !== m) continue
    const params = match(r.pattern, path)
    if (params) return r.handler({ params, query, body, method: m, path })
  }
  throw new ApiError(`接口未实现：${m} ${path}`, 404)
}

/** 路径参数取数值 id，非法时抛 404（对齐后端把 "{id}" 当 int 解析的行为） */
export function idParam(ctx: Ctx, name = 'id'): number {
  const n = Number(ctx.params[name])
  if (!Number.isFinite(n)) notFound(name)
  return n
}

/** 取 body 字段，缺失用默认值 */
export function pick<T>(body: any, key: string, fallback: T): T {
  if (body == null) return fallback
  const v = body[key]
  return v === undefined || v === null ? fallback : (v as T)
}

/** 查询参数取整数 */
export function qInt(ctx: Ctx, key: string, fallback: number): number {
  const raw = ctx.query.get(key)
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}
