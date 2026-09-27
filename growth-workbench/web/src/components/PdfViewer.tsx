import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// 用 ?url 把 worker 作为静态资源带出来（Vite 会自动打包并给出地址）
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Icon } from './Icon'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

type Size = { w: number; h: number }

/**
 * 内置 PDF 阅读器（pdf.js canvas 渲染）。
 * 不依赖浏览器自带的 PDF 插件 —— 内嵌预览窗口里 iframe 方案会一片白，所以自己画。
 * 连续滚动 + 视口附近懒渲染 + 文本层（可选中复制）。
 */
export default function PdfViewer({ src }: { src: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<(HTMLDivElement | null)[]>([])
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const scaleRef = useRef(0)
  const tasksRef = useRef<Map<number, { cancel: () => void }>>(new Map())
  const renderedRef = useRef<Map<number, number>>(new Map()) // idx -> 渲染时的缩放

  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(0)
  const [fit, setFit] = useState(true)
  const [size1, setSize1] = useState<Size | null>(null) // 第 1 页在 scale=1 下的尺寸
  const [err, setErr] = useState('')

  // ---------- 1) 加载文档 ----------
  useEffect(() => {
    let dead = false
    setNumPages(0)
    setPage(1)
    setScale(0)
    setSize1(null)
    setErr('')
    scaleRef.current = 0
    renderedRef.current.clear()
    pdfjs.getDocument({ url: src, isEvalSupported: false }).promise.then(
      (d) => {
        if (dead) {
          d.destroy().catch(() => {})
          return
        }
        docRef.current = d
        setNumPages(d.numPages)
        d.getPage(1).then(
          (p) => {
            if (dead) return
            const v = p.getViewport({ scale: 1 })
            setSize1({ w: v.width, h: v.height })
          },
          () => {},
        )
      },
      (e) => {
        if (!dead) setErr(String(e?.message || e))
      },
    )
    return () => {
      dead = true
      tasksRef.current.forEach((t) => {
        try {
          t.cancel()
        } catch {
          /* noop */
        }
      })
      tasksRef.current.clear()
      docRef.current?.destroy().catch(() => {})
      docRef.current = null
    }
  }, [src])

  // ---------- 2) 适应宽度 ----------
  const computeFit = useCallback(() => {
    if (!fit || !size1 || !wrapRef.current) return
    const w = wrapRef.current.clientWidth - 32
    const s = clamp(w / size1.w, 0.2, 5)
    scaleRef.current = s
    setScale(s)
  }, [fit, size1])

  useEffect(() => {
    computeFit()
  }, [computeFit])

  useEffect(() => {
    const el = wrapRef.current
    if (!el || !fit) return
    const ro = new ResizeObserver(() => computeFit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit, computeFit])

  // ---------- 3) 渲染一页（canvas + 文本层） ----------
  const renderPage = useCallback(async (idx: number) => {
    const doc = docRef.current
    const holder = pageRefs.current[idx]
    const s = scaleRef.current
    if (!doc || !holder || !s) return
    if (renderedRef.current.get(idx) === s && holder.querySelector('canvas')) return

    const prev = tasksRef.current.get(idx)
    if (prev) {
      try {
        prev.cancel()
      } catch {
        /* noop */
      }
      tasksRef.current.delete(idx)
    }

    let p
    try {
      p = await doc.getPage(idx + 1)
    } catch {
      return
    }
    if (docRef.current !== doc || scaleRef.current !== s) return

    const dpr = window.devicePixelRatio || 1
    const vp = p.getViewport({ scale: s })
    const box = holder.querySelector('.pdfjs-box') as HTMLElement | null
    if (!box) return

    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(vp.width * dpr)
    canvas.height = Math.floor(vp.height * dpr)
    canvas.style.width = `${Math.floor(vp.width)}px`
    canvas.style.height = `${Math.floor(vp.height)}px`
    canvas.style.display = 'block'
    box.innerHTML = ''
    box.style.width = `${Math.floor(vp.width)}px`
    box.style.height = `${Math.floor(vp.height)}px`
    box.appendChild(canvas)

    const render = p.render({
      canvasContext: canvas.getContext('2d')!,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    })
    tasksRef.current.set(idx, render)
    try {
      await render.promise
    } catch {
      return // 被取消
    }
    if (docRef.current !== doc) return
    renderedRef.current.set(idx, s)

    // 文本层：让文字可以选中、复制（画布本身不可选）
    const tl = document.createElement('div')
    tl.className = 'textLayer'
    box.appendChild(tl)
    try {
      await pdfjs.renderTextLayer({
        textContentSource: p.streamTextContent(),
        container: tl,
        viewport: vp,
      }).promise
    } catch {
      /* noop */
    }
  }, [])

  // ---------- 4) 视口附近懒渲染（IntersectionObserver） ----------
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !numPages || !scale) return
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (!e.isIntersecting) continue
          const idx = Number((e.target as HTMLElement).dataset.idx)
          renderPage(idx)
        }
      },
      { root: el, rootMargin: '700px 0px' },
    )
    pageRefs.current.forEach((p, i) => p && io.observe(p))
    return () => io.disconnect()
  }, [numPages, scale, renderPage])

  // ---------- 5) 当前页码（滚动同步） ----------
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const top = el.scrollTop
        let cur = 1
        pageRefs.current.forEach((pdiv, i) => {
          if (pdiv && pdiv.offsetTop <= top + 80) cur = i + 1
        })
        setPage(cur)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const goPage = (n: number) => {
    const t = clamp(n, 1, numPages || 1)
    pageRefs.current[t - 1]?.scrollIntoView({ block: 'start' })
    setPage(t)
  }
  const zoom = (f: number) => {
    setFit(false)
    setScale((s) => clamp(+(s * f).toFixed(3), 0.2, 5))
  }

  const pw = size1 && scale ? Math.round(size1.w * scale) : 0
  const ph = size1 && scale ? Math.round(size1.h * scale) : 0

  const smallBtn =
    'flex h-6 min-w-[24px] items-center justify-center rounded-[7px] px-1.5 text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)] disabled:opacity-30'

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--wb-bg-subtle)]">
      {/* 工具栏：翻页在左，缩放在右 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-1.5 text-[12px] text-[color:var(--wb-text-soft)]">
        <div className="flex items-center gap-1">
          <button onClick={() => goPage(1)} disabled={page <= 1} className={smallBtn} title="第一页" aria-label="第一页">
            <Icon name="chevronsLeft" size={14} />
          </button>
          <button
            onClick={() => goPage(page - 1)}
            disabled={page <= 1}
            className={smallBtn}
            title="上一页"
            aria-label="上一页"
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <input
            value={page}
            onChange={(e) => setPage(clamp(Number(e.target.value) || 1, 1, numPages || 1))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') goPage(Number(page))
            }}
            className="w-11 rounded-[6px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-1 py-[1px] text-center text-[12px] tabular-nums outline-none focus:border-[color:var(--wb-accent)]"
            aria-label="页码"
          />
          <span className="tabular-nums text-[color:var(--wb-muted)]">/ {numPages || '…'}</span>
          <button
            onClick={() => goPage(page + 1)}
            disabled={page >= numPages}
            className={smallBtn}
            title="下一页"
            aria-label="下一页"
          >
            <Icon name="chevronRight" size={14} />
          </button>
          <button
            onClick={() => goPage(numPages)}
            disabled={page >= numPages}
            className={smallBtn}
            title="最后一页"
            aria-label="最后一页"
          >
            <Icon name="chevronsRight" size={14} />
          </button>
        </div>

        <span className="hidden text-[11.5px] text-[color:var(--wb-muted)] sm:inline">
          可选中复制 · 划词高亮请用「Gloss 旁注」
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => zoom(1 / 1.25)} className={smallBtn} title="缩小">
            －
          </button>
          <span className="min-w-[2.6rem] text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button onClick={() => zoom(1.25)} className={smallBtn} title="放大">
            ＋
          </button>
          <button
            onClick={() => setFit(true)}
            className={`ml-1 rounded-[7px] px-2 py-[2px] text-[12px] transition ${
              fit
                ? 'bg-[color:var(--wb-accent)] text-white'
                : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
            }`}
            title="适应宽度"
          >
            适宽
          </button>
        </div>
      </div>

      {/* 页面区 */}
      <div ref={wrapRef} className="flex-1 overflow-auto bg-[#4a4d52] px-4 py-4">
        {err ? (
          <div className="mx-auto max-w-lg rounded-[10px] bg-[color:var(--wb-danger-soft)] px-3 py-2 text-[12px] text-[color:var(--wb-danger)]">
            PDF 加载失败：{err}
          </div>
        ) : numPages === 0 ? (
          <div className="flex items-center justify-center gap-2 pt-20 text-[12px] text-white/70">
            <span className="wb-spinner" /> 正在加载 PDF…
          </div>
        ) : (
          <div className="flex min-w-max flex-col items-center gap-4">
            {Array.from({ length: numPages }, (_, i) => (
              <div
                key={i}
                data-idx={i}
                ref={(el) => {
                  pageRefs.current[i] = el
                }}
                className="pdfjs-page relative shrink-0 bg-[color:var(--wb-surface)] shadow-[0_2px_10px_rgba(0,0,0,0.4)]"
                style={pw && ph ? { width: pw, height: ph } : undefined}
              >
                <div
                  className="pdfjs-box absolute left-0 top-0 overflow-hidden"
                  style={{ '--scale-factor': scale } as CSSProperties}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
