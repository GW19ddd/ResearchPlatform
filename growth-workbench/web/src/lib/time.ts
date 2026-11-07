/**
 * 把时间戳格式化成 Undermind 式相对时间：now / 59m / 23h / 6d / 2w。
 * 后端 SQLite 的 datetime 是空格分隔（"2026-11-07 16:00:00"），先替换成 ISO 的 'T' 再解析。
 */
export function relTime(ts?: string): string {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts.replace(' ', 'T')).getTime()
  if (Number.isNaN(diff)) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return `${Math.floor(d / 7)}w`
}
