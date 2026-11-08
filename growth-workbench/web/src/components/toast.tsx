import { useEffect, useState } from 'react'
import { Icon, IconName } from './Icon'

/**
 * 极简全局提示。用模块级 store 而不是 Context，
 * 这样任何层级（包括抽屉、画布节点内部）都能直接 toast()，不必层层包 Provider。
 */
export type ToastTone = 'ok' | 'error' | 'info'

type Item = { id: number; text: string; tone: ToastTone; leaving?: boolean }

let seq = 0
let items: Item[] = []
const listeners = new Set<(v: Item[]) => void>()

function emit() {
  for (const fn of listeners) fn([...items])
}

/** 先标记 leaving 播退出动画，再真正从列表里移除；避免提示「啪」地消失 */
function dismiss(id: number) {
  if (!items.some((x) => x.id === id && !x.leaving)) return
  items = items.map((x) => (x.id === id ? { ...x, leaving: true } : x))
  emit()
  window.setTimeout(() => {
    items = items.filter((x) => x.id !== id)
    emit()
  }, 180)
}

export function toast(text: string, tone: ToastTone = 'info', ms = 2600) {
  const id = ++seq
  items = [...items, { id, text, tone }]
  emit()
  window.setTimeout(() => dismiss(id), ms)
}

const TONES: Record<ToastTone, string> = {
  ok: 'border-[color:var(--wb-ok)]/30 bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]',
  error:
    'border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]',
  info: 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text)]',
}

const ICONS: Record<ToastTone, IconName> = { ok: 'check', error: 'alert', info: 'info' }

export function ToastHost() {
  const [list, setList] = useState<Item[]>(items)
  useEffect(() => {
    listeners.add(setList)
    return () => {
      listeners.delete(setList)
    }
  }, [])
  if (!list.length) return null
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex max-w-[80vw] items-start gap-2 rounded-[10px] border px-3 py-2 text-[12.5px] shadow-[var(--wb-shadow-md)] ${t.leaving ? 'wb-toast-out' : 'wb-anim-pop'} ${TONES[t.tone]}`}
        >
          <Icon name={ICONS[t.tone]} size={14} className="mt-[2px]" />
          <span className="break-words">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
