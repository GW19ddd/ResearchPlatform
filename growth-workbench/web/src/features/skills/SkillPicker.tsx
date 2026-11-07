/**
 * 输入框内「@ 添加技能」浮层：本机 skills / GitHub 技能 / 科研技能三组合一。
 *
 * 形态对齐 WorkBuddy 客户端：在输入框里敲 `@` 弹出，选中后变成输入框内的 chip。
 * 浮层是 absolute 定位（不占文档流），避免「hover 显示详情把页面撑得抖动」。
 * 键盘导航走 window capture 阶段，抢在输入框的 Enter 发送之前处理。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../components/Icon'

/** 一个可挂载的技能。id 是后端用的真实 id；预设技能没有后端 id，靠 text 直传。 */
export type SkillOption = {
  key: string
  id: string
  name: string
  desc: string
  group: string
  path?: string
  text?: string
}

export type SkillGroup = {
  key: string
  label: string
  icon: IconName
  items: SkillOption[]
}

export default function SkillPicker({
  open,
  groups,
  query,
  onQuery,
  onPick,
  onClose,
}: {
  open: boolean
  groups: SkillGroup[]
  query: string
  onQuery: (v: string) => void
  onPick: (o: SkillOption) => void
  onClose: () => void
}) {
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { sections, flat } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const f: { opt: SkillOption; idx: number }[] = []
    const s: { group: SkillGroup; rows: { opt: SkillOption; idx: number }[] }[] = []
    for (const g of groups) {
      const rows: { opt: SkillOption; idx: number }[] = []
      for (const opt of g.items) {
        if (q && !(opt.name + ' ' + opt.desc + ' ' + opt.group).toLowerCase().includes(q)) continue
        const row = { opt, idx: f.length }
        f.push(row)
        rows.push(row)
      }
      if (rows.length) s.push({ group: g, rows })
    }
    return { sections: s, flat: f }
  }, [groups, query])

  useEffect(() => setActive(0), [query, open])
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (!flat.length) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActive((i) => (i + 1) % flat.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActive((i) => (i - 1 + flat.length) % flat.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onPick(flat[Math.min(active, flat.length - 1)].opt)
      }
    }
    // capture：抢在 textarea 的「Enter 发送」之前把 Enter 变成「添加技能」
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, flat, active, onPick, onClose])

  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector('[data-skill-active="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open, query])

  if (!open) return null
  return (
    <div
      ref={panelRef}
      className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-full overflow-hidden rounded-[14px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]"
    >
      <div className="flex items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-2">
        <Icon name="search" size={14} className="text-[color:var(--wb-muted)]" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="搜索技能，或敲 @ 直接筛选…"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
        />
        <span className="whitespace-nowrap text-[11px] text-[color:var(--wb-muted)]">{flat.length} 个</span>
        <button
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded-full text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
          aria-label="关闭技能选择"
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="max-h-[300px] overflow-y-auto py-1">
        {sections.map(({ group, rows }) => (
          <div key={group.key} className="pb-1">
            <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-[color:var(--wb-surface)] px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
              <Icon name={group.icon} size={12} />
              {group.label}
            </div>
            {rows.map(({ opt, idx }) => (
              <button
                key={opt.key}
                data-skill-active={idx === active ? '1' : '0'}
                onMouseEnter={() => setActive(idx)}
                onClick={() => onPick(opt)}
                className={`flex w-full items-start gap-2.5 px-3 py-1.5 text-left transition-colors ${
                  idx === active
                    ? 'bg-[color:var(--wb-accent-soft)]'
                    : 'hover:bg-[color:var(--wb-bg-subtle)]'
                }`}
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)]">
                  <Icon name={group.icon} size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">{opt.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
                    {opt.desc || opt.group}
                  </span>
                </span>
                {idx === active && <Icon name="arrowRight" size={12} className="mt-1.5 text-[color:var(--wb-accent)]" />}
              </button>
            ))}
          </div>
        ))}
        {flat.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[color:var(--wb-muted)]">没有匹配的技能</div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-[color:var(--wb-border)] px-3 py-1.5 text-[10.5px] text-[color:var(--wb-muted)]">
        <span>↑↓ 选择</span><span>·</span><span>Enter 添加</span><span>·</span><span>Esc 关闭</span>
        <span className="flex-1" />
        <span>挂上的技能只对这一轮生效</span>
      </div>
    </div>
  )
}
