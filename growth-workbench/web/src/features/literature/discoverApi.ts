/**
 * 关联文献发现（Litmaps 式）数据层。
 *
 * 进度完全来自后端 SSE 的真实阶段事件（定位种子 → 参考文献 → 施引文献 → 构建网络），
 * 前端不做定时器模拟；papers / edges 全部来自 OpenAlex 实时检索，不含任何模拟数据。
 */
import { parseSse, type SseEvent } from '../../lib/sse'

export type DiscoverPaper = {
  oa_id: string
  title: string
  authors: string
  year: number | null
  venue: string
  doi: string
  url: string
  citations: number
  references: number
  oa: boolean
  pdf_url: string
  relation: 'seed' | 'reference' | 'citing'
}

export type DiscoverEdge = { source: string; target: string }

export type DiscoverResult = {
  seed: DiscoverPaper
  papers: DiscoverPaper[]
  edges: DiscoverEdge[]
  source: string
  stats: { references: number; citing: number; edges: number }
}

export type DiscoverStage = {
  type: 'stage'
  stage: string
  progress: number
  label: string
  detail: string
  seed?: DiscoverPaper
}

export type DiscoverEvent =
  | DiscoverStage
  | { type: 'done'; result: DiscoverResult }
  | { type: 'error'; message: string }

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

/**
 * 发起一次发现检索。onEvent 按后端真实顺序收到每一条事件（含进度）。
 * 返回最终结果；失败抛 Error。
 */
export async function streamDiscover(
  params: { q?: string; oa_id?: string; limit?: number },
  onEvent: (ev: DiscoverEvent) => void,
  signal?: AbortSignal,
): Promise<DiscoverResult> {
  const qs = new URLSearchParams()
  if (params.q) qs.set('q', params.q)
  if (params.oa_id) qs.set('oa_id', params.oa_id)
  qs.set('limit', String(params.limit ?? 20))

  // 这里必须自己判 401：lib/api.ts 的 get() 不参与 raw fetch / SSE
  const res = await fetch(`/api/litsearch/discover?${qs.toString()}`, { signal })
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('wb:unauthorized'))
    const t = await res.text().catch(() => '')
    throw new Error(errText(t, res.status))
  }
  if (!res.body) throw new Error('后端未返回流式响应')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let final: DiscoverResult | null = null
  let failure = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const { events, rest } = parseSse(buf)
    buf = rest
    for (const raw of events as SseEvent[]) {
      const ev = raw as unknown as DiscoverEvent
      onEvent(ev)
      if (ev.type === 'done') final = ev.result
      else if (ev.type === 'error') failure = ev.message || '检索失败'
    }
    if (failure) break
  }

  if (failure) throw new Error(failure)
  if (!final) throw new Error('流已结束，但没有收到结果')
  return final
}

/** 建议项：可能来自本地馆藏，也可能来自 OpenAlex 检索 */
export type Suggestion = {
  key: string
  head: string
  title: string
  sub: string
  source: '本地馆藏' | 'OpenAlex'
  oa_id?: string
  year: number | null
}

/** 第一作者姓氏：Litmaps 卡片头是「Pinheiro, 2001」这种短标 */
export function firstAuthor(authors: string): string {
  if (!authors) return '作者未知'
  const first = authors.split(/[,，]/)[0].trim()
  return first.split(/\s+/)[0] || first.slice(0, 12)
}

export function shortLabel(p: { authors: string; year: number | null }): string {
  return `${firstAuthor(p.authors)}, ${p.year ?? '年份未知'}`
}

export function normTitle(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

/** 大数缩短：12345 → 12.3k，卡片里保持紧凑 */
export function compactCount(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
