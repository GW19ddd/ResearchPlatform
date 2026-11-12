/** 论文速递的类型与公共小工具 */

export type Paper = {
  id: number
  arxiv_id: string | null
  title: string
  authors: string | null
  abstract: string | null
  cats: string | null
  primary_cat: string | null
  figure_url: string | null
  link: string | null
  published: string | null
  source: string
  liked: boolean
  saved: boolean
  hidden: boolean
  title_zh: string | null
  abstract_zh: string | null
  figure_kind: string | null
  notes_count: number
  created_at: string | null
}

export type Lang = 'zh' | 'en' | 'both'

export type FeedSettingsData = {
  subjects?: string[]
  keywords?: string
  email?: string
  imap_host?: string
  imap_port?: number
  imap_user?: string
  imap_pass?: string
  language?: Lang
}

/** 图片走后端代理（服务器端下载并缓存，浏览器不直连 arXiv——直连常被网络/防盗链拦）。
 * 图有四层来源：正文 img / object 矢量图 / 内嵌 svg / PDF 首页渲染（kind='pdf'，
 * 均为论文自己的内容）。只有 'none'（确认全空）不给端点。
 * 还没抓到图但「可重试」的论文也返回端点：后端 /fig/{pid} 会现场懒补图。 */
export function figSrc(
  p: { id: number; figure_url: string | null; arxiv_id?: string | null; figure_kind?: string | null },
  bust = '',
): string {
  const pending = !p.figure_url && !!p.arxiv_id && p.figure_kind !== 'none'
  if (!p.figure_url && !pending) return ''
  return `/api/paperfeed/fig/${p.id}${bust ? `?v=${bust}` : ''}`
}

/** 相对时间：published / created_at → 「2 天前」 */
export function relativeTime(s: string | null): string {
  if (!s) return ''
  const t = new Date(s).getTime()
  if (!t || Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const day = 86400000
  if (diff < day) return '今天'
  const d = Math.floor(diff / day)
  if (d < 30) return `${d} 天前`
  const m = Math.floor(d / 30)
  if (m < 12) return `${m} 个月前`
  return `${Math.floor(m / 12)} 年前`
}
