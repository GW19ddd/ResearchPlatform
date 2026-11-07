import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

/**
 * 可拖拽的竖向分隔条：放在相邻两栏之间，拖动调整那一栏的宽度。
 *
 * - edge='after'：把手在「左栏」的右边缘（全局侧边栏、/research 左栏），
 *   向右拖 → 变宽（+dx）。
 * - edge='before'：把手在「右栏」的左边缘（报告栏 / 文献检索栏），
 *   向右拖 → 变窄（-dx）。
 *
 * 宽度完全由调用方持有（配 usePersist 持久化），本组件不存宽度状态。
 * 拖动期间给 body 加 .wb-resizing，统一锁光标、禁文本选中、关掉栏宽 transition，
 * 否则侧边栏的 transition-[width] 会让拖动跟手慢半拍。
 *
 * 无障碍：role=separator + 方向键 ±16px（Shift ±48）、Home/End 到边界、Enter 重置、双击重置。
 */
export function ResizeHandle({
  width,
  onResize,
  onReset,
  min = 180,
  max = 640,
  edge = 'after',
  label = '拖动调整栏宽',
  className = '',
}: {
  width: number
  onResize: (w: number) => void
  onReset?: () => void
  min?: number
  max?: number
  edge?: 'after' | 'before'
  label?: string
  className?: string
}) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const [active, setActive] = useState(false)

  // 兜底：拖拽中组件被卸载（切路由 / 切页签）时也要把 body class 清掉
  useEffect(() => () => document.body.classList.remove('wb-resizing'), [])

  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)))
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    setActive(false)
    document.body.classList.remove('wb-resizing')
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 指针已释放，忽略 */
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    drag.current = { x: e.clientX, w: width }
    setActive(true)
    document.body.classList.add('wb-resizing')
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 老浏览器不支持指针捕获也能拖（事件仍会冒泡到 document） */
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const dx = e.clientX - drag.current.x
    onResize(clamp(drag.current.w + (edge === 'after' ? dx : -dx)))
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16
    let next: number | null = null
    if (e.key === 'ArrowRight') next = width + step
    else if (e.key === 'ArrowLeft') next = width - step
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    else if (e.key === 'Enter' && onReset) {
      e.preventDefault()
      onReset()
      return
    }
    if (next == null) return
    e.preventDefault()
    onResize(clamp(next))
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} · 双击重置`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onReset?.()}
      onKeyDown={onKeyDown}
      className={`group relative z-10 w-[6px] shrink-0 cursor-col-resize touch-none outline-none ${className}`}
    >
      {/* 默认透明，hover / 拖拽 / 键盘聚焦时才显形，不干扰平时的分栏观感 */}
      <span
        className={`pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 rounded-full transition-colors ${
          active
            ? 'bg-[color:var(--wb-accent)]'
            : 'bg-transparent group-hover:bg-[color:var(--wb-accent)]/45 group-focus-visible:bg-[color:var(--wb-accent)]/70'
        }`}
      />
    </div>
  )
}
