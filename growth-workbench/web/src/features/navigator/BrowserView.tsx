/**
 * 站点快搜 · 应用内浏览器。
 *
 * 点站点不再 window.open，而是打开这个铺满工作台的浮层：地址栏 + iframe。
 * 默认走 /api/browse 兼容代理（绕过站点的 X-Frame-Options）；站点需要登录态
 * 或代理渲染不全时，可一键切「直连」，再不行才「在浏览器打开」。
 *
 * 全屏浮层而不是抽屉：网页需要横向宽度，抽屉会把搜索结果挤成一条。
 */
import { useEffect, useRef, useState } from 'react'
import { Btn, IconBtn, Input, Segmented, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'

type Mode = 'proxy' | 'direct'

const proxyUrl = (u: string) => `/api/browse?url=${encodeURIComponent(u)}`

/** 地址栏里手敲 arxiv.org 也认，补个协议再走 */
function normalize(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (/^[a-z]+:/i.test(s)) return '' // javascript: / file: 之类一律不收
  return `https://${s}`
}

export default function BrowserView({
  name,
  url,
  onClose,
}: {
  name: string
  url: string
  onClose: () => void
}) {
  const [current, setCurrent] = useState(url)
  const [addr, setAddr] = useState(url)
  const [mode, setMode] = useState<Mode>('proxy')
  const [nonce, setNonce] = useState(0)
  const [loading, setLoading] = useState(true)
  const currentRef = useRef(url)
  currentRef.current = current

  // Esc 关闭（地址栏里也生效，跟浏览器 Esc 停加载不冲突，本浮层是查看器）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 代理页内的链接跳转会 postMessage 上报新的真实 URL，用来同步地址栏
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d || d.__wbBrowse !== 1 || typeof d.url !== 'string') return
      try {
        const u = new URL(d.url, window.location.href)
        const target = u.searchParams.get('url')
        if (target && target !== currentRef.current) {
          setCurrent(target)
          setAddr(target)
        }
      } catch {
        // 消息格式不对就忽略，不影响页面
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const navigate = (raw: string) => {
    const next = normalize(raw)
    if (!next) return
    setLoading(true)
    setCurrent(next)
    setAddr(next)
    setNonce((n) => n + 1)
  }

  const reload = () => {
    setLoading(true)
    setNonce((n) => n + 1)
  }

  const src = mode === 'proxy' ? proxyUrl(current) : current

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-[color:var(--wb-surface)]">
      {/* 工具条：返回 / 站点名 / 地址栏 / 刷新 / 模式 / 外部打开 / 关闭 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2">
        <Btn size="sm" variant="ghost" onClick={onClose} title="返回站点快搜">
          <Icon name="chevronLeft" size={13} />
          <span className="whitespace-nowrap">返回</span>
        </Btn>
        <span className="hidden shrink-0 rounded-full bg-[color:var(--wb-accent-soft)] px-2.5 py-1 text-[11.5px] font-medium text-[color:var(--wb-accent-strong)] md:inline">
          {name}
        </span>
        <Input
          value={addr}
          onChange={setAddr}
          onKeyDown={(e) => e.key === 'Enter' && navigate(addr)}
          placeholder="输入网址后回车"
          autoComplete="off"
          className="min-w-[180px] flex-1"
          ariaLabel="网页地址"
        />
        <IconBtn icon="refresh" size="md" ariaLabel="刷新" title="刷新" onClick={reload} />
        <Segmented
          value={mode}
          onChange={(v) => {
            setMode(v)
            setLoading(true)
            setNonce((n) => n + 1)
          }}
          options={[
            { value: 'proxy', label: '兼容' },
            { value: 'direct', label: '直连' },
          ]}
        />
        <Btn
          size="sm"
          onClick={() => window.open(current, '_blank', 'noreferrer')}
          title="在系统浏览器里打开当前网页"
        >
          <Icon name="link" size={13} />
          <span className="whitespace-nowrap">浏览器打开</span>
        </Btn>
        <IconBtn icon="close" size="md" tone="danger" ariaLabel="关闭网页" title="关闭" onClick={onClose} />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-4 py-1.5 text-[11px] text-[color:var(--wb-muted)]">
        <Icon name="info" size={11} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {mode === 'proxy'
            ? '兼容模式：网页由本机代理后在工作台内打开，站内链接继续留在这里；登录类站点请切「直连」或用「浏览器打开」。'
            : '直连模式：直接加载原站点，若显示空白说明该站点禁止内嵌，请切回「兼容」。'}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 bg-white">
        {loading && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/85 text-[12px] text-[color:var(--wb-muted)]">
            <Spinner />
            正在打开网页…
          </div>
        )}
        {/* key 里不放 current：站内跳转是 iframe 自己导航过去的，
            postMessage 只用来同步地址栏，改 key 会导致整页重挂 + 重复加载 */}
        <iframe
          key={`${mode}-${nonce}`}
          src={src}
          title={`${name} · 应用内浏览`}
          className="h-full w-full border-0 bg-white"
          onLoad={() => setLoading(false)}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-downloads"
        />
      </div>
    </div>
  )
}
