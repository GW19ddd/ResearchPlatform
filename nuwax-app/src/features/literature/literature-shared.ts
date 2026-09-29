/** 文献模块的跨组件共享常量与纯函数（无状态、无副作用，可单独测试）。 */

export const STATUS = [
  { value: 'todo', label: '待读' },
  { value: 'reading', label: '在读' },
  { value: 'done', label: '已读' },
]

/**
 * 分类字段可能是 JSON 数组（新）或 "a / b" 斜杠串（老数据），两种都要能读。
 * 分隔符是 " / "，不是裸 "/"——集合名本身可能叫 "C/C++"，切开就多出一层。
 */
export function collsOf(l: any): string[] {
  const raw = String(l?.collections || '').trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean)
    } catch {
      /* 不是合法 JSON 就按旧格式拆 */
    }
  }
  const parts = raw
    .split(' / ')
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : [raw]
}

/** 当前分类筛选下这条文献是否命中；点父分类会带上所有子分类（与 Zotero 行为一致）。 */
export function inCollection(l: any, coll: string): boolean {
  if (!coll) return true
  const names = collsOf(l)
  if (coll === '__none' || coll === '未分类') return names.length === 0
  return names.some((p) => p === coll || p.startsWith(coll + ' /'))
}
