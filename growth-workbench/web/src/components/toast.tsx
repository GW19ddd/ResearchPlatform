import { useEffect, useState } from 'react'

/**
 * 极简全局提示。用模块级 store 而不是 Context，
 * 这样任何层级（包括抽屉、画布节点内部）都能直接 toast()，不必层层包 Provider。
 */
export type ToastTone = 'ok' | 'error' | 'info'

type Item = { id: number; text: string; tone: ToastTone }

let seq = 0
let items: Item[] = []
const listeners = new Set<(v: Item[]) => void>()

function emit() {
  for (const fn of listeners) fn([...items])
}

export function toast(text: string, tone: ToastTone = 'info', ms = 2600) {
  const id = ++seq
  items = [...items, { id, text, tone }]
  emit()
  window.setTimeout(() => {
    items = items.filter((x) => x.id !== id)
    emit()
  }, ms)
}

const TONES: Record<ToastTone, string> = {
  ok: 'border-[color:var(--wb-ok)]/30 bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]',
  error:
    'border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]',
  info: 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text)]',
}

const ICONS: Record<ToastTone, string> = { ok: '✓', error: '!', info: '·' }

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
          className={`wb-anim-pop pointer-events-auto flex max-w-[80vw] items-start gap-2 rounded-[10px] border px-3 py-2 text-[12.5px] shadow-[var(--wb-shadow-md)] ${TONES[t.tone]}`}
        >
          <span className="mt-[1px] text-[11px] font-bold">{ICONS[t.tone]}</span>
          <span className="break-words">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
