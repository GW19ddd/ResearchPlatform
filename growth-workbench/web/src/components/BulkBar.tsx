/**
 * 列表批量操作：多选开关 + 多选状态 + 操作条 + 导出工具。
 *
 * 只管「进没进多选、勾了哪些、怎么导出」，不碰任何业务字段 —— 字段清单由页面传进来，
 * 这样创新点 / 文献 / 实验（以及以后任何列表）都能复用同一套。
 *
 * 交互约定：**复选框默认不出现**，由「多选」按钮唤出；
 * 退出多选时清空勾选并收起操作条，列表回到干净的只读状态。
 */
import { useState } from 'react'
import { Btn } from './ui'
import { Icon } from './Icon'

const CHECK =
  'h-[15px] w-[15px] shrink-0 cursor-pointer accent-[color:var(--wb-accent)]'

// ---------------------------------------------------------------- 多选状态

export type BulkSel = {
  /** 当前选中的 id（稳定顺序：按勾选先后） */
  ids: number[]
  count: number
  /** 选中条目的 id 集合，行容器用它做高亮 */
  has: (id: number) => boolean
  toggle: (id: number) => void
  setAll: (ids: number[]) => void
  clear: () => void
}

export function useBulk(): BulkSel {
  const [sel, setSel] = useState<Set<number>>(new Set())
  const toggle = (id: number) =>
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return {
    ids: [...sel],
    count: sel.size,
    has: (id) => sel.has(id),
    toggle,
    setAll: (ids) => setSel(new Set(ids)),
    clear: () => setSel(new Set()),
  }
}

/**
 * 「多选」开关。放在列表工具条上，进入多选后才渲染复选框。
 * 小按钮形态（sm + ghost），不开多选时它自己也不占视觉重心。
 */
export function SelectToggle({
  on,
  onToggle,
  active,
  title,
}: {
  on: boolean
  onToggle: () => void
  /** 多选期间给按钮一点强调色，方便一眼看出「现在是多选态」 */
  active?: boolean
  title?: string
}) {
  return (
    <Btn
      size="sm"
      variant={on ? 'primary' : 'default'}
      onClick={onToggle}
      title={title || (on ? '退出多选' : '进入多选，可批量删除或导出')}
      className={on || active ? '!px-2' : undefined}
    >
      {on ? (
        <>
          <Icon name="checkSquare" size={13} />
          多选中
        </>
      ) : (
        <>
          <Icon name="checkSquare" size={13} />
          多选
        </>
      )}
    </Btn>
  )
}

// ---------------------------------------------------------------- 行内复选框

/**
 * 行里的复选框。**只在多选态下渲染**（由页面用 showSelect 控制，别常驻）。
 * 外层容器常常带 onClick（点行开详情），
 * 所以这里 click / change 都要 stopPropagation，否则勾一次会顺带把抽屉打开。
 */
export function RowCheck({
  checked,
  onChange,
  className = '',
}: {
  checked: boolean
  onChange: (v: boolean) => void
  className?: string
}) {
  // 行内的复选框不套 HIT：行高是按 13px 校过的，撑成 24px 会把整行顶散。
  // 它落在 WCAG 2.2 的「inline 目标」豁免里，画到 15px 已经比原来好点。
  return (
    <input
      type="checkbox"
      checked={checked}
      title="选中这一条"
      aria-label="选中这一条"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation()
        onChange(e.target.checked)
      }}
      className={`${CHECK} ${className}`}
    />
  )
}

// ---------------------------------------------------------------- 操作条

export function BulkBar({
  count,
  total,
  unit = '项',
  onSelectAll,
  onClear,
  onDelete,
  deleting,
  exports = [],
}: {
  count: number
  total: number
  unit?: string
  onSelectAll: () => void
  onClear: () => void
  onDelete: () => void
  deleting?: boolean
  /** 导出项。没选中时按钮自动禁用 */
  exports?: { label: string; run: () => void }[]
}) {
  const all = total > 0 && count === total
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-1.5">
      <label className="flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          checked={all}
          aria-label="全选"
          onChange={() => (count > 0 ? onClear() : onSelectAll())}
          className={CHECK}
        />
        <span className="whitespace-nowrap text-[12px] text-[color:var(--wb-text-soft)]">
          全选
        </span>
      </label>
      <span className="whitespace-nowrap text-[12px] text-[color:var(--wb-muted)]">
        已选 {count} / {total} {unit}
      </span>
      {count > 0 && !all && total > 0 && (
        <button
          onClick={onSelectAll}
          className="whitespace-nowrap text-[12px] text-[color:var(--wb-accent)] underline underline-offset-2"
        >
          选中全部 {total} {unit}
        </button>
      )}
      {count > 0 && (
        <button
          onClick={onClear}
          className="whitespace-nowrap text-[12px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]"
        >
          清空选择
        </button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {exports.map((x) => (
          <Btn key={x.label} size="sm" onClick={x.run} disabled={count === 0}>
            {x.label}
          </Btn>
        ))}
        <Btn
          size="sm"
          variant="danger"
          onClick={onDelete}
          disabled={count === 0}
          loading={deleting}
        >
          批量删除{count > 0 ? `（${count}）` : ''}
        </Btn>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 导出

export type ExportCol = { key: string; label: string }

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 某些浏览器会来不及下载，延后一拍
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 带 BOM，Excel 直接打开才是中文而不是乱码 */
const BOM = '\uFEFF'

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: any[], cols: ExportCol[]): string {
  const head = cols.map((c) => csvCell(c.label)).join(',')
  const body = rows.map((r) => cols.map((c) => csvCell(r[c.key])).join(',')).join('\n')
  return `${BOM}${head}\n${body}\n`
}

/** 每条一段：第一行做标题，其余字段按需列出（空的字段不写，避免满屏「—」） */
export function toMarkdown(title: string, rows: any[], cols: ExportCol[]): string {
  const lines = [
    `# ${title}`,
    '',
    `> 共 ${rows.length} 条 · 导出于 ${new Date().toLocaleString('zh-CN')}`,
    '',
  ]
  for (const r of rows) {
    lines.push(`## ${r[cols[0].key] || '(无标题)'}`)
    for (const c of cols.slice(1)) {
      const v = r[c.key]
      if (v == null || v === '') continue
      lines.push(`- **${c.label}**：${String(v).replace(/\n+/g, ' ')}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 文献专用：authors 是逗号分隔，BibTeX 里要换成 and */
export function toBibtex(rows: any[]): string {
  const entries = rows.map((l, i) => {
    const firstAuthor = String(l.authors || 'anon').split(/[,;]/)[0].trim() || 'anon'
    const surname = firstAuthor.split(/\s+/).pop() || firstAuthor
    const tag = surname.replace(/[^A-Za-z]/g, '') || 'ref'
    const key = `${tag}${l.year || 'nd'}${i ? String.fromCharCode(96 + ((i % 26) + 1)) : ''}`
    const fields = [
      `  title = {${l.title || ''}}`,
      l.authors ? `  author = {${String(l.authors).replace(/\s*[,;]\s*/g, ' and ')}}` : '',
      l.venue ? `  booktitle = {${l.venue}}` : '',
      l.year ? `  year = {${l.year}}` : '',
      l.url ? `  url = {${l.url}}` : '',
    ]
      .filter(Boolean)
      .join(',\n')
    return `@article{${key},\n${fields}\n}`
  })
  return `${entries.join('\n\n')}\n`
}

/** 文件名统一带上日期，避免连导几次互相覆盖 */
export function stamp(name: string): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${name}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}
