/** 科研社区：前后端共用的常量与数据结构。分类与 server/routers/community.py 保持一致。 */

export const CATEGORIES = [
  '全部',
  '论文速递',
  '研究笔记',
  '方法讨论',
  '实验复盘',
  '数据集',
  '工具与代码',
  '投稿与审稿',
  '组会纪要',
  '资源分享',
  '求助问答',
  '学术动态',
] as const

export type Category = (typeof CATEGORIES)[number]
export const POST_CATEGORIES: Category[] = CATEGORIES.slice(1) as Category[]

export const POST_KINDS: { value: string; label: string }[] = [
  { value: 'discussion', label: '讨论' },
  { value: 'note', label: '笔记' },
  { value: 'question', label: '提问' },
  { value: 'share', label: '分享' },
  { value: 'review', label: '复盘' },
]

export const COVER_STYLES: { value: string; label: string }[] = [
  { value: 'paper', label: '文稿' },
  { value: 'grid', label: '矩阵' },
  { value: 'chart', label: '图表' },
  { value: 'nodes', label: '关联' },
  { value: 'quote', label: '引述' },
  { value: 'code', label: '代码' },
  { value: 'formula', label: '公式' },
  { value: 'wave', label: '波形' },
]

export const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'latest', label: '最新发布' },
  { value: 'hot', label: '最热讨论' },
  { value: 'views', label: '最多阅读' },
  { value: 'comments', label: '最多评论' },
]

export type CommunityPost = {
  id: number
  title: string
  summary: string
  content?: string
  category: string
  kind: string
  tags: string
  cover_style: string
  cover_url: string
  author_id: number
  author_name: string
  author_hue: number
  is_sample: boolean
  views: number
  likes: number
  favorites: number
  comments_count: number
  pinned: number
  created_at: string
  updated_at: string
  liked?: boolean
  favorited?: boolean
}

export type CommunityComment = {
  id: number
  post_id: number
  parent_id: number | null
  author_id: number
  author_name: string
  author_hue: number
  content: string
  created_at: string
}

export type CommunityList = {
  items: CommunityPost[]
  total: number
  counts: Record<string, number>
  categories: string[]
  kinds: Record<string, string>
}

export type PostDetail = { post: CommunityPost; comments: CommunityComment[] }
export type ReactionResult = { ok: boolean; kind: 'like' | 'favorite'; active: boolean; count: number }

export type PostDraft = {
  title: string
  summary: string
  content: string
  category: string
  kind: string
  tags: string
  cover_style: string
  cover_url: string
}

export const emptyDraft = (): PostDraft => ({
  title: '',
  summary: '',
  content: '',
  category: '方法讨论',
  kind: 'discussion',
  tags: '',
  cover_style: 'paper',
  cover_url: '',
})

export function kindLabel(kind?: string) {
  return POST_KINDS.find((k) => k.value === kind)?.label || '讨论'
}

export function tagList(tags?: string): string[] {
  return (tags || '')
    .split(/[,，、;；\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 4)
}

/** 中文相对时间；超过一个月直接给日期，避免「12w 前」这种没法读的形式。 */
export function formatWhen(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts.replace(' ', 'T'))
  const ms = d.getTime()
  if (Number.isNaN(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
