/**
 * 新手引导 v2（从零重做）
 *
 * 与 v1 的区别：
 *  1. 内容不再是纯文字说教 —— 每个功能点都带一条「可照抄的示例」（输入 → 你会得到），
 *     外加一张真实工作台界面截图，全部示例共用同一条研究线，来源只有一份：
 *     features/tour/tourContent.json。这份 JSON 同时驱动引导 / 教学视频 / 配套 PPT / 讲稿，
 *     保证四者严格对应。图片素材统一放在 /tutorial/ui/，由 tutorial/build/build_ui_assets.py 生成。
 *  2. 按章节组织，目录可任意跳步，不必线性走完 28 屏。
 *  3. 最后一步是教学视频页：内嵌播放器 + 章节跳转 + PPT / 讲稿 / 字幕下载。
 *  4. 四块遮罩挖洞保留 —— 高亮区域仍然是真实可操作的 UI，不是截图。
 *
 * 锚点约定：目标元素带 data-tour="<name>"；也允许直接写 CSS 选择器
 * （如 a[href="/ideas"]、main、header），没有锚点就降级为整屏遮罩 + 居中卡片。
 * 带 ?tab= 的步骤会同时比较 pathname 与 tab，避免 navigate 死循环。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Btn, IconBtn } from './ui'
import { Icon, IconName } from './Icon'
import CONTENT from '../features/tour/tourContent.json'

/* ---------------------------------- 内容类型 ---------------------------------- */

export type TourExample = {
  label: string
  inputLabel?: string
  input: string
  outputLabel?: string
  output: string
  note?: string
  /** 真实工作台界面截图，位于 /tutorial/ui/；缺失时整块图区自动隐藏 */
  image?: string
  imageCaption?: string
}

export type TourStep = {
  key: string
  chapter: string
  title: string
  goal: string
  body: string
  path?: string
  target?: string
  targets?: string[]
  example: TourExample
  tip?: string
}

type Chapter = { id: string; no: string; title: string; subtitle: string; desc: string }
type Slide = { no: number; kicker: string; title: string }
type TourContent = {
  meta: {
    title: string
    topic: string
    disclaimer: string
    assets: {
      video: string
      ppt: string
      slides: string
      script: string
      srt: string
      /** 科普速览片（90s 白板动效）与它的可编辑源码包，与逐页讲解版并列 */
      popular: string
      popularSource: string
    }
  }
  chapters: Chapter[]
  steps: TourStep[]
  slides: Slide[]
}

const DATA = CONTENT as unknown as TourContent
export const TOUR_STEPS = DATA.steps
export const TOUR_CHAPTERS = DATA.chapters

/** 视频每页固定 8 秒（生成脚本严格按此切，章节跳转才能用 (no-1)*8 定位） */
const SLIDE_SEC = 8

const CHAPTER_ICON: Record<string, IconName> = {
  start: 'compass',
  workspaces: 'layers',
  assets: 'library',
  rhythm: 'clock',
  tools: 'gear',
  video: 'slides',
}

/* ---------------------------------- 布局工具 ---------------------------------- */

type Box = { t: number; l: number; r: number; b: number }

const PAD = 6
const GAP = 16
const EDGE = 12
const CARD_W = 432
const VIDEO_W = 760
const EST_H = 420

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)))

/** 卡片优先放高亮框右侧，其次左 / 下 / 上，最后贴视口角落；始终不越界 */
function placeCard(box: Box | null, cw: number, ch: number) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!box) return { left: Math.max(EDGE, (vw - cw) / 2), top: Math.max(EDGE, (vh - ch) / 2) }

  const topAtSpot = clamp(box.t, EDGE, vh - ch - EDGE)
  if (box.r + GAP + cw <= vw - EDGE) return { left: box.r + GAP, top: topAtSpot }
  if (box.l - GAP - cw >= EDGE) return { left: box.l - GAP - cw, top: topAtSpot }

  const leftAtSpot = clamp(box.l, EDGE, vw - cw - EDGE)
  if (box.b + GAP + ch <= vh - EDGE) return { left: leftAtSpot, top: box.b + GAP }
  if (box.t - GAP - ch >= EDGE) return { left: leftAtSpot, top: box.t - GAP - ch }
  return {
    left: clamp(vw - cw - EDGE, EDGE, vw - cw - EDGE),
    top: clamp(vh - ch - EDGE, EDGE, vh - ch - EDGE),
  }
}

/** 名字 → 选择器：纯字母当标签名，含 [ # 或以 . 开头当 CSS，其余当 data-tour 锚点 */
function selectorFor(a: string) {
  const isCss = a.includes('[') || a.includes('#') || a.startsWith('.') || /^[a-z]+$/i.test(a)
  return isCss ? a : `[data-tour="${a}"]`
}

/** React 受控输入框必须用原型上的 native setter 写入，否则 onChange 不触发 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* 剪贴板不可用时静默降级，示例文本仍完整显示在卡片里 */
    }
    document.body.removeChild(ta)
  }
}

/* ---------------------------------- 子组件 ---------------------------------- */

/** 示例卡：引导里每个功能点的核心，真实界面截图 + 输入 / 产出两栏 + 一键复制或填入 */
function ExampleBlock({
  example,
  onCopy,
  onFill,
  canFill,
  state,
}: {
  example: TourExample
  onCopy: () => void
  onFill: () => void
  canFill: boolean
  state: '' | 'copied' | 'filled'
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-xs)]">
      <div className="flex items-center gap-1.5 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2 text-[11px] font-semibold text-[color:var(--wb-text-soft)]">
        <Icon name="sparkle" size={13} className="text-[color:var(--wb-accent)]" />
        配套示例 · {example.label}
      </div>

      {example.image && (
        <div
          data-tour-shot
          className="border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 pb-2 pt-2.5"
        >
          <div className="overflow-hidden rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
            <img
              src={example.image}
              alt={example.imageCaption || '功能界面截图'}
              loading="lazy"
              onError={(e) => {
                const box = e.currentTarget.closest('[data-tour-shot]') as HTMLElement | null
                if (box) box.style.display = 'none'
              }}
              className="block h-[124px] w-full object-cover object-top"
            />
          </div>
          {example.imageCaption && (
            <p className="mt-1.5 text-[10px] leading-snug text-[color:var(--wb-muted)]">
              {example.imageCaption}
            </p>
          )}
        </div>
      )}

      <div className="wb-tour-pipe px-3 py-3">
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.06em] text-[color:var(--wb-muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--wb-accent)]" />
            {example.inputLabel || '你可以这样填'}
          </div>
          <pre className="wb-tour-code max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-[9px] bg-[color:var(--wb-surface-alt)] px-2.5 py-2 text-[11px] leading-[1.65] text-[color:var(--wb-text)]">
            {example.input}
          </pre>
        </div>

        <div className="my-2 flex justify-center">
          <span className="wb-tour-node">
            <Icon name="chevronDown" size={13} strokeWidth={2.2} />
          </span>
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.06em] text-[color:var(--wb-accent)]">
            <Icon name="arrowRight" size={11} strokeWidth={2.2} />
            {example.outputLabel || '你会得到'}
          </div>
          <div className="rounded-[9px] border border-[color:var(--wb-accent)]/30 bg-[color:var(--wb-accent-soft)] px-2.5 py-2 text-[11.5px] leading-[1.7] text-[color:var(--wb-text-soft)]">
            {example.output}
          </div>
        </div>

        {example.note && (
          <p className="mt-2 border-l-2 border-[color:var(--wb-border-strong)] pl-2 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
            {example.note}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-2">
        <Btn size="xs" variant="ghost" onClick={onCopy}>
          <Icon name="copy" size={12} />
          复制示例
        </Btn>
        {canFill && (
          <Btn size="xs" variant="ghost" onClick={onFill}>
            <Icon name="arrowRight" size={12} />
            填入输入框
          </Btn>
        )}
        <span className="ml-auto text-[10.5px] text-[color:var(--wb-accent)]">
          {state === 'filled' ? '已填入，可直接运行' : state === 'copied' ? '已复制到剪贴板' : ''}
        </span>
      </div>
    </div>
  )
}

/** 章节进度签：六段轨道，段宽按该章步数，当前章内按比例填充；右侧是 02 / 28 这种精装页码感 */
function TourProgress({ stepIndex }: { stepIndex: number }) {
  const chapterOrder = DATA.chapters.map((c) => c.id)
  const counts = chapterOrder.map((cid) => DATA.steps.filter((s) => s.chapter === cid).length)
  const starts: number[] = []
  counts.reduce((acc, n) => {
    starts.push(acc)
    return acc + n
  }, 0)
  const curChap = chapterOrder.indexOf(DATA.steps[stepIndex].chapter)
  const within = stepIndex - starts[curChap] + 1
  const total = DATA.steps.length
  return (
    <div className="flex items-center gap-2 px-5 pt-2.5">
      <div className="wb-tour-prog flex-1">
        {counts.map((n, j) => {
          const frac = j < curChap ? 1 : j === curChap ? Math.max(0, Math.min(1, within / n)) : 0
          return (
            <div key={j} className="wb-tour-prog-seg" style={{ flexGrow: n }}>
              <div className="wb-tour-prog-fill" style={{ width: `${frac * 100}%` }} />
            </div>
          )
        })}
      </div>
      <span className="shrink-0 text-[10.5px] font-medium tabular-nums text-[color:var(--wb-muted)]">
        {String(stepIndex + 1).padStart(2, '0')}
        <span className="opacity-45"> / </span>
        {String(total).padStart(2, '0')}
      </span>
    </div>
  )
}

/** 欢迎首屏：把六章落成一张小地图，让第一步像「精装书的目录页」，而不是一堵文字墙 */
function WelcomeHero() {
  return (
    <div className="mb-3 grid grid-cols-2 gap-2">
      {DATA.chapters.map((c) => (
        <div
          key={c.id}
          className="flex items-start gap-2 rounded-[11px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-2"
        >
          <span className="mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-[color:var(--wb-accent-soft)] text-[10.5px] font-semibold text-[color:var(--wb-accent)]">
            {c.no}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[11.5px] font-semibold leading-tight text-[color:var(--wb-text)]">
              {c.title}
            </div>
            <div className="truncate text-[10px] text-[color:var(--wb-muted)]">{c.subtitle}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 章节目录：28 屏不必线性走完，随时跳到任意功能点 */
function Toc({ active, onJump }: { active: number; onJump: (i: number) => void }) {
  return (
    <div className="max-h-[300px] shrink-0 overflow-y-auto border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2 py-2">
      {DATA.chapters.map((c) => {
        const idx = DATA.steps.map((s, j) => ({ s, j })).filter(({ s }) => s.chapter === c.id)
        return (
          <div key={c.id} className="mb-1.5">
            <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] font-semibold tracking-[0.06em] text-[color:var(--wb-muted)]">
              <Icon name={CHAPTER_ICON[c.id] || 'sparkle'} size={11} className="text-[color:var(--wb-accent)]" />
              <span className="rounded-[5px] bg-[color:var(--wb-accent-soft)] px-1 py-[1px] text-[color:var(--wb-accent)]">
                {c.no}
              </span>
              {c.title}
              <span className="font-normal">— {c.subtitle}</span>
            </div>
            {idx.map(({ s, j }) => (
              <button
                key={s.key}
                type="button"
                onClick={() => onJump(j)}
                className={`flex w-full items-center gap-1.5 rounded-[7px] px-2 py-[5px] text-left text-[11.5px] transition-colors ${
                  j === active
                    ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
                    : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                }`}
              >
                <span className="w-4 shrink-0 text-right text-[10px] text-[color:var(--wb-muted)]">{j + 1}</span>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {j === active && <Icon name="check" size={11} />}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** 引导末页：教学视频 + 与视频逐页对应的 PPT / 讲稿 / 字幕 */
function VideoPanel({ onRestart }: { onRestart: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [broken, setBroken] = useState(false)
  // 两支片并列：逐页讲解版沿用 8s/页的章节跳转；科普速览版是 90s 白板动效，没有分页。
  const [mode, setMode] = useState<'slides' | 'popular'>('slides')
  const a = DATA.meta.assets

  const marks = DATA.chapters.map((c) => ({
    ...c,
    slideNo: DATA.slides.find((s) => s.kicker.startsWith(c.no))?.no ?? 1,
  }))

  const seek = (no: number) => {
    const v = videoRef.current
    if (!v) return
    try {
      v.currentTime = Math.max(0, (no - 1) * SLIDE_SEC)
      void v.play()
    } catch {
      /* 视频尚未加载完成时忽略 */
    }
  }

  return (
    <div className="pb-1">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10.5px] text-[color:var(--wb-muted)]">版本</span>
        {([
          { id: 'slides' as const, label: '逐页讲解 · 1:52' },
          { id: 'popular' as const, label: '科普速览 · 1:30' },
        ]).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => { setMode(m.id); setBroken(false) }}
            className={`rounded-[7px] border px-2 py-1 text-[10.5px] transition-colors ${
              mode === m.id
                ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface-alt)] font-semibold text-[color:var(--wb-accent)]'
                : 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-accent)] hover:text-[color:var(--wb-accent)]'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-text)]">
        {broken ? (
          <div className="flex aspect-video flex-col items-center justify-center gap-2 text-center text-[12px] text-white/80">
            <Icon name="slides" size={26} />
            视频文件尚未就绪
            <a href={a.slides} target="_blank" rel="noreferrer" className="text-[11.5px] underline underline-offset-2">
              先看网页版逐页幻灯片
            </a>
          </div>
        ) : (
          <video
            key={mode}
            ref={videoRef}
            src={mode === 'popular' ? a.popular : a.video}
            controls
            playsInline
            preload="metadata"
            onError={() => setBroken(true)}
            className="block aspect-video w-full bg-black"
          />
        )}
      </div>

      {mode === 'slides' ? (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10.5px] text-[color:var(--wb-muted)]">跳到章节</span>
            {marks.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => seek(m.slideNo)}
                className="rounded-[7px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2 py-1 text-[10.5px] text-[color:var(--wb-text-soft)] transition-colors hover:border-[color:var(--wb-accent)] hover:text-[color:var(--wb-accent)]"
              >
                {m.no} {m.title}
              </button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { href: a.ppt, label: '配套 PPT', icon: 'slides' as IconName },
              { href: a.script, label: '讲稿', icon: 'file' as IconName },
              { href: a.srt, label: '字幕 SRT', icon: 'quote' as IconName },
              { href: a.slides, label: '网页幻灯片', icon: 'layers' as IconName },
            ].map((x) => (
              <a
                key={x.label}
                href={x.href}
                download={x.href !== a.slides}
                target={x.href === a.slides ? '_blank' : undefined}
                rel="noreferrer"
                className="flex items-center justify-center gap-1.5 rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2 py-2 text-[11px] text-[color:var(--wb-text-soft)] transition-colors hover:border-[color:var(--wb-accent)] hover:text-[color:var(--wb-accent)]"
              >
                <Icon name={x.icon} size={13} />
                {x.label}
              </a>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="mt-2.5 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
            科普速览用白板图解讲「一条研究线怎么流动」，90 秒、离线中文口播；口播逐字摘自本教学包，画面不含任何实测数值。
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[
              { href: a.popular, label: '下载科普版 MP4', icon: 'slides' as IconName },
              { href: a.popularSource, label: '可编辑源码 ZIP', icon: 'file' as IconName },
            ].map((x) => (
              <a
                key={x.label}
                href={x.href}
                download
                rel="noreferrer"
                className="flex items-center justify-center gap-1.5 rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2 py-2 text-[11px] text-[color:var(--wb-text-soft)] transition-colors hover:border-[color:var(--wb-accent)] hover:text-[color:var(--wb-accent)]"
              >
                <Icon name={x.icon} size={13} />
                {x.label}
              </a>
            ))}
          </div>
        </>
      )}

      <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-2">
        <Icon name="info" size={13} className="mt-[2px] shrink-0 text-[color:var(--wb-warn)]" />
        <p className="text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">{DATA.meta.disclaimer}</p>
      </div>

      <button
        type="button"
        onClick={onRestart}
        className="mt-2.5 text-[11px] text-[color:var(--wb-accent)] underline underline-offset-2"
      >
        从第一步重新看引导
      </button>
    </div>
  )
}

/* ---------------------------------- 主组件 ---------------------------------- */

export default function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const here = location.pathname + location.search

  const [i, setI] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [cardH, setCardH] = useState(EST_H)
  const [tocOpen, setTocOpen] = useState(false)
  const [copyState, setCopyState] = useState<'' | 'copied' | 'filled'>('')
  const cardRef = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<number>(0)
  // 卡片定位记忆：跨页跳转（box 短暂为 null）时停在上一目标位置，
  // 避免「先滑到屏幕中央、再滑到目标」的中间帧把空白区扫进视野。
  const lastGoodPos = useRef<{ left: number; top: number }>({ left: 0, top: 0 })
  if (lastGoodPos.current.left === 0 && lastGoodPos.current.top === 0) {
    lastGoodPos.current = { left: Math.max(EDGE, (window.innerWidth - CARD_W) / 2), top: EDGE }
  }

  const step = DATA.steps[i]
  const total = DATA.steps.length
  const isVideo = step.key === 'video'
  const chapter = DATA.chapters.find((c) => c.id === step.chapter)
  const vw = window.innerWidth
  const vh = window.innerHeight
  const cw = Math.min(isVideo ? VIDEO_W : CARD_W, vw - 24)
  const maxH = Math.max(280, vh - 2 * EDGE)

  const anchors = useMemo(
    () => (step.targets?.length ? step.targets : step.target ? [step.target] : []),
    [step.targets, step.target],
  )

  const findEl = useCallback((): HTMLElement | null => {
    for (const a of anchors) {
      try {
        const el = document.querySelector(selectorFor(a))
        if (el) return el as HTMLElement
      } catch {
        /* 非法选择器忽略，继续试下一个锚点 */
      }
    }
    return null
  }, [anchors])

  const readBox = useCallback((): Box | null => {
    const el = findEl()
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { t: r.top - PAD, l: r.left - PAD, r: r.right + PAD, b: r.bottom + PAD }
  }, [findEl])

  /** 只在目标区域里确实能定位到唯一输入框时，才提供「填入输入框」 */
  const findEditable = useCallback((): HTMLInputElement | HTMLTextAreaElement | null => {
    const el = findEl()
    if (!el) return null
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el
    const list = Array.from(
      el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
      ),
    ).filter((x) => !x.disabled && !x.readOnly)
    if (list.length === 1) return list[0]
    const firstTa = list.find((x) => x instanceof HTMLTextAreaElement)
    return list.length <= 3 && firstTa ? firstTa : null
  }, [findEl])

  // 每次打开都从第一步开始
  useEffect(() => {
    if (!open) return
    setI(0)
    setBox(null)
    setTocOpen(false)
    setCopyState('')
  }, [open])

  // 进入步骤：必要时跳页（含 ?tab=）→ 等目标渲染 → 滚动到可见 → 量位置
  useEffect(() => {
    if (!open) return
    setBox(null)
    setCopyState('')

    if (step.path) {
      const [p, q] = step.path.split('?')
      const samePath = location.pathname === p
      const sameTab = !q || new URLSearchParams(location.search).get('tab') === new URLSearchParams(q).get('tab')
      if (!samePath || !sameTab) {
        navigate(step.path)
        return // here 变化会再次触发本 effect
      }
    }
    if (isVideo) return // 视频页居中大卡，不做挖洞

    let alive = true
    let tries = 0
    let raf = 0
    const tick = () => {
      if (!alive) return
      if (anchors.length) {
        const el = findEl()
        if (!el) {
          if (tries++ < 100) {
            raf = requestAnimationFrame(tick)
            return
          }
          setBox(null) // 降级：居中卡片，不阻断流程
          return
        }
        const before = el.getBoundingClientRect()
        if (before.bottom < 0 || before.top > window.innerHeight) {
          el.scrollIntoView({ block: 'center', behavior: 'auto' })
        }
      }
      setBox(readBox())
    }
    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [open, i, here, isVideo, step.path, location.pathname, location.search, navigate, anchors, findEl, readBox])

  // 窗口变化 / 内部容器滚动 / 高亮区内 DOM 变化时跟随，不让框漂移
  useEffect(() => {
    if (!open || isVideo) return
    const sync = () => setBox(readBox())
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    const timer = window.setInterval(sync, 600)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      window.clearInterval(timer)
    }
  }, [open, isVideo, readBox])

  // 卡片高度随文案变化，量真实值后才好算「放上面还是放下面」
  useLayoutEffect(() => {
    if (!open || !cardRef.current) return
    const h = cardRef.current.offsetHeight
    if (h && h !== cardH) setCardH(h)
  }, [open, i, tocOpen, cardH])

  const goto = useCallback((n: number) => {
    setBox(null)
    setI(n)
    setTocOpen(false)
  }, [])

  const next = useCallback(() => {
    if (i >= total - 1) onClose()
    else goto(i + 1)
  }, [i, total, onClose, goto])

  const prev = useCallback(() => {
    if (i > 0) goto(i - 1)
  }, [i, goto])

  // 键盘：← → 切换，Esc 退出；输入框与视频播放器里不抢键
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (tocOpen) setTocOpen(false)
        else onClose()
        return
      }
      if (isVideo) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        prev()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, isVideo, tocOpen, next, prev, onClose])

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const flash = (s: '' | 'copied' | 'filled') => {
    setCopyState(s)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyState(''), 2400)
  }

  const onCopy = () => {
    void copyText(step.example.input).then(() => flash('copied'))
  }

  const onFill = () => {
    const el = findEditable()
    if (!el) {
      void copyText(step.example.input).then(() => flash('copied'))
      return
    }
    setNativeValue(el, step.example.input)
    el.focus()
    flash('filled')
  }

  const pos = useMemo(() => {
    if (isVideo) {
      const p = { left: Math.max(EDGE, (vw - cw) / 2), top: Math.max(EDGE, (vh - Math.min(cardH, maxH)) / 2) }
      lastGoodPos.current = p
      return p
    }
    if (!box) return lastGoodPos.current
    const p = placeCard(box, cw, Math.min(cardH, maxH))
    lastGoodPos.current = p
    return p
  }, [isVideo, box, cw, cardH, maxH, vw, vh])

  if (!open) return null

  const maskCls = 'fixed z-[80] wb-tour-dim'
  const showSpot = !!box && !isVideo
  const spotW = showSpot ? Math.max(0, box!.r - box!.l) : 0
  const spotH = showSpot ? Math.max(0, box!.b - box!.t) : 0

  return (
    <>
      {/* 四块遮罩围出高亮区；中间留空 → 被框选的区域仍可真实操作 */}
      {showSpot ? (
        <>
          <div className={maskCls} style={{ left: 0, top: 0, width: vw, height: Math.max(0, box!.t) }} />
          <div className={maskCls} style={{ left: 0, top: box!.b, width: vw, height: Math.max(0, vh - box!.b) }} />
          <div className={maskCls} style={{ left: 0, top: box!.t, width: Math.max(0, box!.l), height: spotH }} />
          <div className={maskCls} style={{ left: box!.r, top: box!.t, width: Math.max(0, vw - box!.r), height: spotH }} />
        </>
      ) : (
        <div className={`${maskCls} inset-0`} />
      )}

      {showSpot && (
        <div
          aria-hidden
          className="wb-tour-spot pointer-events-none fixed z-[81] rounded-[14px] border-2 border-[color:var(--wb-accent)] transition-[transform,width,height] duration-200 will-change-transform"
          style={{ left: 0, top: 0, transform: `translate(${box!.l}px, ${box!.t}px)`, width: spotW, height: spotH }}
        />
      )}

      {/* 外层只负责定位与滑动（transform，走合成层不触发重排）；
          内层卡片保留 wb-anim-pop 的入场缩放，两者互不打架。 */}
      <div
        className="fixed z-[82] will-change-transform transition-transform duration-200"
        style={{ left: 0, top: 0, transform: `translate(${pos.left}px, ${pos.top}px)` }}
      >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="新手引导"
        className="wb-anim-pop wb-tour-card flex flex-col overflow-hidden rounded-[16px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]"
        style={{ width: cw, maxHeight: maxH }}
      >
        <div className="relative flex shrink-0 items-start gap-3 px-5 pb-3 pt-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-gradient-to-br from-[color:var(--wb-accent)] to-[color:var(--wb-accent-strong)] text-white shadow-[0_2px_8px_-2px_rgba(64,52,196,0.5)]">
            <Icon name={isVideo ? 'slides' : CHAPTER_ICON[step.chapter] || 'sparkle'} size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.08em] text-[color:var(--wb-muted)]">
              新手引导
              {chapter && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="text-[color:var(--wb-accent)]">
                    {chapter.no} {chapter.title}
                  </span>
                </>
              )}
            </div>
            <h2 className="mt-0.5 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-[color:var(--wb-text)]">
              {step.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setTocOpen((v) => !v)}
            title="章节目录"
            aria-label="章节目录"
            aria-expanded={tocOpen}
            className={`wb-press-soft flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] transition-colors ${
              tocOpen
                ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                : 'text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)]'
            }`}
          >
            <Icon name="menu" size={14} />
          </button>
          <IconBtn icon="close" size="sm" ariaLabel="退出引导" onClick={onClose} />
        </div>

        {!isVideo && <TourProgress stepIndex={i} />}

        {tocOpen && <Toc active={i} onJump={goto} />}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3.5">
          {isVideo ? (
            <VideoPanel onRestart={() => goto(0)} />
          ) : (
            <>
              {step.key === 'welcome' && <WelcomeHero />}
              <p className="text-[11.5px] font-medium leading-relaxed text-[color:var(--wb-accent)]">{step.goal}</p>
              <p className="mt-1.5 text-[12.5px] leading-[1.8] text-[color:var(--wb-text-soft)]">{step.body}</p>

              <ExampleBlock
                example={step.example}
                onCopy={onCopy}
                onFill={onFill}
                canFill={!!findEditable()}
                state={copyState}
              />

              {step.tip && (
                <div className="mt-3 flex gap-2 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-2">
                  <Icon name="info" size={13} className="mt-[2px] shrink-0 text-[color:var(--wb-accent)]" />
                  <span className="text-[11px] leading-relaxed text-[color:var(--wb-muted)]">{step.tip}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2.5">
          <Btn size="xs" variant="ghost" onClick={onClose}>
            跳过引导
          </Btn>
          <span className="truncate text-[10.5px] text-[color:var(--wb-muted)]">
            {isVideo ? '视频 / PPT / 讲稿 可直接下载' : '每个功能点都配了示例'}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {i > 0 && (
              <Btn size="sm" onClick={prev}>
                上一步
              </Btn>
            )}
            <Btn size="sm" variant="primary" onClick={next}>
              {i === total - 1 ? '开始使用' : i === total - 2 ? '看教学视频' : '下一步'}
            </Btn>
          </div>
        </div>

        {!isVideo && (
          <div className="shrink-0 border-t border-[color:var(--wb-border)] px-3 py-1.5 text-center text-[10px] text-[color:var(--wb-muted)]">
            ← → 切换 · Esc 退出 · 点目录跳章 · 高亮区域内可以直接操作
          </div>
        )}
      </div>
      </div>
    </>
  )
}
