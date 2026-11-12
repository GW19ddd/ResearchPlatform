import { useEffect, useMemo, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Btn } from '../../components/ui'

/**
 * 案例教程跨页指引：
 * - 教程页点「前往」→ launchTutorialGuide 把指引上下文写进 sessionStorage 并跳转
 * - 目标页由全局挂载的 TutorialGuideHost 接住：右下角浮出引导卡，
 *   「开始指引」在本页逐个高亮真实元素（讲这一步怎么产出论文那一节），「回到教程」跳回教程页
 */

export const TUTORIAL_GUIDE_KEY = 'wb:tutorial.guide'
export const TUTORIAL_HOME = '/tutorial/llmutg'

export type GuideItem = {
  at: string
  note: string
  sel?: string
  text?: string
  scope?: string
}

export type GuideCtx = {
  stepTitle: string
  from: string
  target: string
  items: GuideItem[]
}

export function launchTutorialGuide(ctx: GuideCtx) {
  try {
    sessionStorage.setItem(TUTORIAL_GUIDE_KEY, JSON.stringify(ctx))
  } catch {
    /* ignore */
  }
}

export function clearTutorialGuide() {
  try {
    sessionStorage.removeItem(TUTORIAL_GUIDE_KEY)
  } catch {
    /* ignore */
  }
}

export function readTutorialGuide(): GuideCtx | null {
  try {
    const raw = sessionStorage.getItem(TUTORIAL_GUIDE_KEY)
    if (!raw) return null
    const ctx = JSON.parse(raw) as GuideCtx
    return ctx && Array.isArray(ctx.items) && ctx.items.length > 0 ? ctx : null
  } catch {
    return null
  }
}

/** 在真实 DOM 里找最小面积含目标文本的元素（与截图脚本同一套逻辑）
 *  优先在 <main> 业务区内找：侧栏/顶栏同名文字更容易误命中 */
export function findTarget(t: { sel?: string; text?: string; scope?: string }): DOMRect | null {
  if (t.text) {
    // 指定了 scope 就只在里面找：找不到宁可返回 null 让卡片提示「不在本页」，
    // 也不要退回到全文档去命中侧栏/顶栏的同名文字（会指错地方）
    const scopes: ParentNode[] = []
    const want = t.scope ? document.querySelector(t.scope) : null
    if (want) scopes.push(want)
    if (!t.scope) {
      const main = document.querySelector('main')
      if (main) scopes.push(main)
      scopes.push(document)
    }

    for (const root of scopes) {
      const all = Array.from(
        root.querySelectorAll<HTMLElement>('button, a, div, span, h1, h2, h3, input, textarea, header, select')
      )
      let best: { r: DOMRect; area: number } | null = null
      for (const el of all) {
        const own = (el.innerText || el.textContent || '').trim()
        if (!own || own.length > 60) continue
        if (!own.includes(t.text)) continue
        const r = el.getBoundingClientRect()
        if (r.width < 12 || r.height < 10) continue
        const area = r.width * r.height
        if (!best || area < best.area) best = { r, area }
      }
      if (best) return best.r
    }
  }
  if (t.sel) {
    const el = document.querySelector(t.sel)
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return r
    }
  }
  return null
}

/** 找到后把它滚进视口中间，再返回矩形（长列表页目标常在屏幕外） */
export const findTargetInView = (t: { sel?: string; text?: string; scope?: string }) => {  const r0 = findTarget(t)
  if (!r0) return null
  if (r0.top >= 12 && r0.bottom <= window.innerHeight - 12) return r0
  const target = document.elementFromPoint(
    Math.min(window.innerWidth - 1, Math.max(0, r0.left + Math.min(r0.width / 2, 200))),
    Math.min(window.innerHeight - 1, Math.max(0, r0.top + r0.height / 2))
  )
  if (target) target.scrollIntoView({ block: 'center', behavior: 'auto' })
  return findTarget(t)
}

function useSpot(item: GuideItem | null) {
  const [spot, setSpot] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const locate = useCallback(() => {
    if (!item) {
      setSpot(null)
      return
    }
    const r = findTargetInView(item)
    setSpot(r ? { x: r.x - 6, y: r.y - 6, w: r.width + 12, h: r.height + 12 } : null)
  }, [item])

  useEffect(() => {
    locate()
    const re = () => locate()
    window.addEventListener('resize', re)
    window.addEventListener('scroll', re, true)
    const t = setTimeout(locate, 400)
    return () => {
      window.removeEventListener('resize', re)
      window.removeEventListener('scroll', re, true)
      clearTimeout(t)
    }
  }, [locate])

  return spot
}

/** 引导浮层：右下角入口卡 + 逐点高亮讲解 */
function GuideOverlay({
  ctx,
  index,
  onNext,
  onPrev,
  onExit,
  onBack,
}: {
  ctx: GuideCtx
  index: number
  onNext: () => void
  onPrev: () => void
  onExit: () => void
  onBack: () => void
}) {
  const item = ctx.items[index]
  const spot = useSpot(item)
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <div className="fixed bottom-4 right-4 z-[88]">
        <div className="w-[264px] rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-3 shadow-xl">
          <div className="flex items-center gap-1.5">
            <Icon name="book" size={13} className="text-[color:var(--wb-accent)]" />
            <span className="min-w-0 truncate text-[12px] font-semibold text-[color:var(--wb-text)]">
              案例教程 · {ctx.stepTitle}
            </span>
            <button
              onClick={onExit}
              className="ml-auto flex h-[20px] w-[20px] items-center justify-center rounded-md text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)]"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            这一页有 <b className="text-[color:var(--wb-accent)]">{ctx.items.length}</b> 个要点，串起来讲「论文的这一节是怎么在这里产生的」。
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <Btn size="sm" onClick={() => setOpen(true)}>
              <Icon name="play" size={11} /> 开始指引
            </Btn>
            <Btn variant="ghost" size="sm" onClick={onBack}>
              <Icon name="reply" size={11} /> 回到教程
            </Btn>
          </div>
        </div>
      </div>
    )
  }

  // 卡片：目标在视口上半部就放下方，下半部就放上方，确保不压住被高亮元素
  const cardW = 380
  const cardH = 176
  let cardX = spot ? spot.x + spot.w / 2 - cardW / 2 : window.innerWidth / 2 - cardW / 2
  cardX = Math.max(12, Math.min(window.innerWidth - cardW - 12, cardX))
  const vh = window.innerHeight
  const roomBelow = spot ? vh - (spot.y + spot.h) : 0
  const roomAbove = spot ? spot.y : 0
  const putAbove = spot ? roomBelow < cardH + 16 && roomAbove >= cardH + 16 : false
  const cardY = spot
    ? putAbove
      ? Math.max(12, spot.y - cardH - 14)
      : Math.min(vh - cardH - 12, spot.y + spot.h + 14)
    : vh / 2 - 80

  // 单块全屏遮罩 + clip-path 挖洞（多面板方案在部分父层会被裁/失效）
  const spotClip = spot
    ? `polygon(0 0, 100% 0, 100% ${spot.y}px, ${spot.x}px ${spot.y}px, ${spot.x}px ${spot.y + spot.h}px, ${
        spot.x + spot.w
      }px ${spot.y + spot.h}px, ${spot.x + spot.w}px ${spot.y}px, 100% ${spot.y}px, 100% 100%, 0 100%)`
    : undefined

  return (
    <div className="fixed inset-0 z-[92]">
      <div
        className="fixed inset-0"
        style={{
          background: 'rgba(12,14,12,0.62)',
          clipPath: spotClip,
          transition: 'clip-path .18s ease',
          pointerEvents: 'auto',
        }}
        onClick={onExit}
      />
      {spot && (
        <div
          className="pointer-events-none fixed rounded-[10px]"
          style={{
            left: spot.x,
            top: spot.y,
            width: spot.w,
            height: spot.h,
            border: '2px solid var(--wb-accent)',
            boxShadow: '0 0 0 3px rgba(255,255,255,0.85), 0 6px 24px rgba(0,0,0,0.28)',
            transition: 'all .18s ease',
          }}
        />
      )}
      <div
        className="absolute rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-3 shadow-xl"
        style={{ left: cardX, top: cardY, width: cardW, transition: 'all .18s ease' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-[color:var(--wb-accent)] px-1.5 py-0.5 text-[10.5px] font-semibold text-white">
            要点 {index + 1}/{ctx.items.length}
          </span>
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-[color:var(--wb-text)]">{item.at}</span>
          <button
            onClick={onExit}
            className="ml-auto flex h-[20px] w-[20px] items-center justify-center rounded-md text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)]"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">{item.note}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="shrink-0 whitespace-nowrap text-[11px] text-[color:var(--wb-muted)]">
            {spot ? '↑ 蓝色框住的就在那' : '目标不在当前屏'}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Btn variant="ghost" size="sm" disabled={index <= 0} onClick={onPrev}>
              上一个
            </Btn>
            <Btn size="sm" disabled={index >= ctx.items.length - 1} onClick={onNext}>
              下一个
            </Btn>
            <Btn variant="ghost" size="sm" onClick={onBack}>
              回教程
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 全局挂载：当前路由与指引目标一致时才出现 */
export default function TutorialGuideHost() {
  const loc = useLocation()
  const nav = useNavigate()
  const [ctx, setCtx] = useState<GuideCtx | null>(() => readTutorialGuide())
  const [index, setIndex] = useState(0)

  // 路由变化时重读 sessionStorage（前往跳转后在本页接住）
  useEffect(() => {
    setCtx(readTutorialGuide())
    setIndex(0)
  }, [loc.pathname])

  const active = useMemo(
    () => ctx && loc.pathname === (ctx.target || '').split('?')[0],
    [ctx, loc.pathname]
  )
  if (!active || !ctx) return null

  return (
    <GuideOverlay
      ctx={ctx}
      index={index}
      onNext={() => setIndex((i) => (i < ctx.items.length - 1 ? i + 1 : i))}
      onPrev={() => setIndex((i) => (i > 0 ? i - 1 : i))}
      onExit={() => {
        clearTutorialGuide()
        setCtx(null)
      }}
      onBack={() => {
        nav(TUTORIAL_HOME)
      }}
    />
  )
}
