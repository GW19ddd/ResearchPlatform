/**
 * 全站细顶栏 / 底部状态栏。
 *
 * 布局参考 Docker Desktop：顶部一条 ~40px 的定位栏，左侧负责「我在哪 / 去哪」，
 * 右侧放全局操作；内容区不再渲染页面大标题，点菜单后直接进重点。
 * 工作台（课题 / 画布 / 调研）只从左侧菜单进入，顶栏不再重复放切换 tab。
 * 配色一律走 --wb-* 令牌，不引入截图的蓝色顶栏（那属于配色不是布局）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon, IconName } from './Icon'
import { Avatar, IconBtn } from './ui'
import { displayNameOf } from '../lib/auth'
import { useApi } from '../lib/hooks'

/** pathname → [分组, 页面名]；?tab= 子视图只补一层小字，不另起大标题 */
function crumbs(pathname: string, search: string): [string, string] {
  const tab = new URLSearchParams(search).get('tab')
  const MAIN: Record<string, [string, string]> = {
    '/today': ['工作台', '今日'],
    '/ideas': ['研究资产', '创新点'],
    '/literature': ['研究资产', '文献'],
    '/experiments': ['研究资产', '实验'],
    '/paper': ['研究资产', '论文'],
    '/community': ['社区', '科研社区'],
    '/paperfeed': ['速递', '论文速递'],
    '/plan': ['节奏', '计划复盘'],
    '/advisor': ['节奏', '导师'],
    '/points': ['节奏', '激励规则'],
    '/stats': ['工具', '概览指标'],
    '/navigator': ['工具', '站点快搜'],
    '/search': ['工具', '文献检索'],
    '/settings': ['工具', '设置'],
    '/chat': ['工作台', '课题 Quest'],
    '/canvas': ['工作台', '编排画布'],
    '/research': ['工作台', '调研 Research'],
  }
  if (pathname === '/') return ['工作台', '编排']
  const base = MAIN[pathname] || ['科研工作台', '工作台']
  const SUB: Record<string, string> = {
    library: '文献库',
    matrix: '对比矩阵',
    search: '文献检索',
    build: '编排',
    access: '访问点',
    logs: '日志',
    monitor: '监测',
  }
  return tab && SUB[tab] ? [base[1], SUB[tab]] : base
}

function useClock() {
  const [t, setT] = useState('')
  useEffect(() => {
    const tick = () => setT(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  return t
}

/** 一条待处理通知：数字与文案全部来自 /dashboard 的真实数据，不造未读数 */
type Notice = { icon: IconName; text: string; to: string }

/**
 * 顶栏通知铃铛：聚合论文阻塞红警、逾期承诺、今日未打卡三类真实待办。
 * 没有待处理就只显示铃铛本身，不摆假的角标。
 */
function NotificationBell() {
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const { data, reload } = useApi<any>('/dashboard')

  const notices = useMemo<Notice[]>(() => {
    if (!data) return []
    const out: Notice[] = []
    for (const s of data?.paper?.blocked || []) {
      out.push({
        icon: 'alert',
        text: `论文阶段「${s.name}」已阻塞 ${s.stuck_days} 天`,
        to: '/paper',
      })
    }
    for (const n of (data?.commitments?.overdue || []).slice(0, 4)) {
      out.push({
        icon: 'clock',
        text: `给导师的承诺「${n.my_commitment || n.scene}」已逾期`,
        to: '/advisor',
      })
    }
    if (data?.checkin_today === false) {
      out.push({ icon: 'sun', text: '今天还没打卡，别让积分断签', to: '/today' })
    }
    return out
  }, [data])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const count = notices.length
  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <IconBtn
        icon="bell"
        size="md"
        ariaLabel={count ? `通知，${count} 条待处理` : '通知'}
        title="通知"
        onClick={() => {
          if (!open) reload()
          setOpen((v) => !v)
        }}
      />
      {count > 0 && (
        <span
          className="pointer-events-none absolute right-0 top-0 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[color:var(--wb-danger)] px-[3px] text-[9px] font-medium leading-none text-white shadow-[var(--wb-shadow-xs)]"
          aria-hidden
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
      {open && (
        <div
          role="menu"
          className="wb-anim-pop absolute right-0 top-[calc(100%+8px)] z-50 w-[300px] overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]"
        >
          <div className="flex items-center border-b border-[color:var(--wb-border)] px-3 py-2">
            <span className="text-[12px] font-semibold text-[color:var(--wb-text)]">通知</span>
          </div>
          {count === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-3 py-7 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-muted)]">
                <Icon name="bell" size={16} />
              </span>
              <span className="text-[12px] text-[color:var(--wb-text-soft)]">暂无新通知</span>
            </div>
          ) : (
            <div className="max-h-[280px] overflow-y-auto p-1">
              {notices.map((n, i) => (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    nav(n.to)
                  }}
                  className="wb-press-soft flex w-full items-start gap-2 rounded-[8px] px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--wb-bg-subtle)]"
                >
                  <Icon
                    name={n.icon}
                    size={14}
                    className="mt-[1px] shrink-0 text-[color:var(--wb-warn)]"
                  />
                  <span className="min-w-0 flex-1 text-[12px] leading-snug text-[color:var(--wb-text-soft)]">
                    {n.text}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function TopBar({ onProfile, onTour, user }: { onProfile: () => void; onTour: () => void; user: any }) {
  const { pathname, search } = useLocation()
  const nav = useNavigate()
  const clock = useClock()
  const [group, page] = crumbs(pathname, search)
  const name = displayNameOf(user)

  return (
    <header className="wb-app-topbar flex h-10 shrink-0 items-center gap-3 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3">
      {/* 左：返回主页（主页 = 编排选择页，即「发布的应用」小卡片）+ 定位面包屑。
          整条面包屑都可点回主页，避免「只有小箭头能点、面包屑文字点了没反应」的错觉 */}
      <button
        type="button"
        onClick={() => nav('/')}
        title="回到主页"
        className="wb-press flex shrink-0 items-center gap-1.5 text-[11.5px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-accent)]"
      >
        <Icon name="chevronLeft" size={12} />
        <span className="hidden sm:inline">{group}</span>
        <span className="hidden text-[11.5px] text-[color:var(--wb-border-strong)] sm:inline">/</span>
        <span className="hidden text-[12px] font-medium text-[color:var(--wb-text)] sm:inline">{page}</span>
      </button>

      {/* 中：运行状态（本地工具，没有云端自动保存，写清楚口径） */}
      <div className="ml-auto hidden items-center gap-1.5 text-[11px] text-[color:var(--wb-muted)] md:flex">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--wb-ok)]" />
        本地运行 · 数据只在这台电脑
        <span className="tabular-nums text-[color:var(--wb-text-soft)]">{clock}</span>
      </div>

      {/* 右：全局操作。设置只保留头像入口（点头像 → 设置），不再放独立齿轮 */}
      <div className="flex shrink-0 items-center gap-0.5">
        <IconBtn icon="search" size="md" ariaLabel="站点快搜" title="站点快搜" onClick={() => nav('/navigator')} />
        <IconBtn icon="info" size="md" ariaLabel="新手引导" title="新手引导" onClick={onTour} />
        <NotificationBell />
        <button
          type="button"
          onClick={onProfile}
          title="账户"
          className="wb-press-soft ml-1 flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 hover:bg-[color:var(--wb-bg-subtle)]"
        >
          <Avatar name={name} hue={user?.avatar_hue} size={24} />
          <span className="hidden max-w-[9rem] truncate text-[11.5px] text-[color:var(--wb-text-soft)] sm:inline">
            {name || '本机账户'}
          </span>
        </button>
      </div>
    </header>
  )
}

/** 底部一条 ~22px 状态栏：只放真实可得的本机信息，不做假的服务指标 */
export function StatusBar() {
  const clock = useClock()
  return (
    <footer className="wb-app-statusbar flex h-[22px] shrink-0 items-center gap-3 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 text-[10.5px] text-[color:var(--wb-muted)]">
      <span className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--wb-ok)]" />
        本地运行
      </span>
      <span className="hidden sm:inline">数据：growth-workbench/data/workbench.db</span>
      <span className="ml-auto tabular-nums">{clock}</span>
    </footer>
  )
}
