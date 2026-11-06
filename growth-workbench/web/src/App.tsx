import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useCallback, useRef, useState } from 'react'
import Dashboard from './pages/Dashboard'
import Ideas from './pages/Ideas'
import Literature from './pages/Literature'
import Navigator from './pages/Navigator'
import Experiments from './pages/Experiments'
import Paper from './pages/Paper'
import Plan from './pages/Plan'
import Advisor from './pages/Advisor'
import Points from './pages/Points'
import Settings from './pages/Settings'
import Chat from './pages/Chat'
import Login from './pages/Login'
import { ToastHost } from './components/toast'
import Tour from './components/Tour'
import { Icon, IconName } from './components/Icon'
import { Avatar, Btn, IconBtn, Input, Modal } from './components/ui'
import { usePersist } from './lib/state'
import { get } from './lib/api'
import { displayNameOf, useAuth } from './lib/auth'
import SettingsPanel from './features/settings/SettingsPanel'

/** 侧边栏按科研流程分段：输入 → 执行 → 复盘 → 激励 */
const NAV_GROUPS: { group: string; items: { to: string; label: string; icon: IconName }[] }[] = [
  {
    group: '输入',
    items: [
      { to: '/ideas', label: '创新点', icon: 'sparkle' },
      { to: '/literature', label: '文献', icon: 'book' },
      { to: '/navigator', label: '科研导航', icon: 'search' },
    ],
  },
  {
    group: '执行',
    items: [
      { to: '/experiments', label: '实验', icon: 'beaker' },
      { to: '/paper', label: '论文', icon: 'file' },
    ],
  },
  {
    group: '复盘',
    items: [
      { to: '/plan', label: '计划复盘', icon: 'clock' },
      { to: '/advisor', label: '导师', icon: 'phone' },
    ],
  },
  {
    group: '激励',
    items: [{ to: '/points', label: '积分', icon: 'star' }],
  },
  {
    group: '',
    items: [{ to: '/chat', label: '对话 / 工作流', icon: 'message' }],
  },
]

/** 头像色板：色相按 40° 分布，够区分又不至于跳脱 */
const HUES = [240, 268, 300, 336, 12, 32, 152, 190]

type NavBadge = { n: number; tone: 'accent' | 'warn' | 'neutral' }

/**
 * 侧边栏「未读 / 待处理」小气泡：数字全部来自 /dashboard 的真实统计，为 0 就不显示。
 * 今日 = 待办任务 + 未结算赌约；文献 = 待读；实验 = 计划中；计划复盘 = 未闭合承诺。
 */
function navBadges(d: any): Record<string, NavBadge> {
  const out: Record<string, NavBadge> = {}
  if (!d) return out
  const put = (to: string, n: number, tone: NavBadge['tone']) => {
    if (n > 0) out[to] = { n, tone }
  }
  put('/', (d.open_tasks || 0) + (d.open_bets || 0), 'accent')
  put('/literature', d.literature?.todo || 0, 'warn')
  put('/experiments', d.experiments?.planned || 0, 'neutral')
  put('/plan', d.commitments?.open || 0, 'warn')
  return out
}

/** 数字气泡：展开态跟在文字右侧，折叠态缩成图标右上角的小角标 */
function NavCount({ badge, collapsed }: { badge?: NavBadge; collapsed: boolean }) {
  if (!badge) return null
  const tone: Record<NavBadge['tone'], string> = {
    accent: 'bg-[color:var(--wb-accent)] text-white',
    warn: 'bg-[color:var(--wb-warn-soft)] text-[color:var(--wb-warn)]',
    neutral: 'bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-muted)]',
  }
  const text = badge.n > 99 ? '99+' : String(badge.n)
  if (collapsed) {
    return (
      <span
        className={`absolute right-0 top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-[3px] text-[9px] font-medium leading-none shadow-[var(--wb-shadow-xs)] ${tone[badge.tone]}`}
        aria-label={`${badge.n} 项待处理`}
      >
        {text}
      </span>
    )
  }
  return (
    <span
      className={`ml-auto flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-medium leading-none ${tone[badge.tone]}`}
      aria-label={`${badge.n} 项待处理`}
    >
      {text}
    </span>
  )
}

const itemCls = (active: boolean, collapsed: boolean) =>
  `group relative flex items-center rounded-[9px] text-[12.5px] transition-colors duration-150 ${
    collapsed ? 'h-8 justify-center px-0' : 'h-8 gap-2.5 px-2.5'
  } ${
    active
      ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
      : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'
  }`

function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-[color:var(--wb-accent)] to-[color:var(--wb-accent-strong)] font-bold text-white shadow-[0_6px_16px_-8px_rgba(64,52,196,0.65)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      研
    </div>
  )
}

/** 头像菜单：靠点击外部与 Esc 关闭，不做 hover —— 移动端 hover 根本不存在 */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

function Sidebar({
  collapsed,
  badges,
  onToggle,
  onProfile,
  onTour,
  onSettings,
}: {
  collapsed: boolean
  badges: Record<string, NavBadge>
  onToggle: () => void
  onProfile: () => void
  onTour: () => void
  onSettings: () => void
}) {
  const { user, logout } = useAuth()
  const [menu, setMenu] = useState(false)
  const menuRef = useDismiss(menu, () => setMenu(false))
  const name = displayNameOf(user)

  const menuItem =
    'flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left text-[12.5px] text-[color:var(--wb-text-soft)] transition-colors hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] transition-[width] duration-200 ${
        collapsed ? 'w-[60px]' : 'w-[216px]'
      }`}
      aria-label="侧边栏"
    >
      <div className={`flex items-center gap-2.5 pb-2 pt-4 ${collapsed ? 'flex-col px-0' : 'px-4'}`}>
        <BrandMark />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold text-[color:var(--wb-text)]">科研工作台</div>
            <div className="truncate text-[10.5px] text-[color:var(--wb-muted)]">Research Workbench</div>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? '展开侧边栏（快捷键 [）' : '收起侧边栏（快捷键 [）'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[color:var(--wb-muted)] transition-colors hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={13} />
        </button>
      </div>

      <nav
        data-tour="tour-sidebar"
        className={`mt-2 min-h-0 flex-1 overflow-y-auto pb-2 ${collapsed ? 'px-2' : 'px-3'}`}
        aria-label="主导航"
      >
        <NavLink to="/" end title={collapsed ? '今日' : undefined} className={({ isActive }) => itemCls(isActive, collapsed)}>
          <Icon name="sun" size={15} />
          {!collapsed && <span className="truncate">今日</span>}
          {collapsed && <span className="sr-only">今日</span>}
          <NavCount badge={badges['/']} collapsed={collapsed} />
        </NavLink>

        {NAV_GROUPS.map((g, gi) => (
          <div key={gi}>
            {g.group &&
              (collapsed ? (
                gi > 0 && <div className="mx-1 my-2 border-t border-[color:var(--wb-border)]" />
              ) : (
                <div className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
                  {g.group}
                </div>
              ))}
            <div className="flex flex-col gap-[2px]">
              {g.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  title={collapsed ? n.label : undefined}
                  className={({ isActive }) => itemCls(isActive, collapsed)}
                >
                  <Icon name={n.icon} size={15} />
                  {collapsed ? <span className="sr-only">{n.label}</span> : <span className="truncate">{n.label}</span>}
                  <NavCount badge={badges[n.to]} collapsed={collapsed} />
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* 底部工具：新手引导 + 左下角设置齿轮（常驻，折叠态只留图标） */}
      <div
        data-tour="tour-settings-entry"
        className={`flex shrink-0 items-center gap-1 p-2 ${collapsed ? 'flex-col' : ''}`}
      >
        {collapsed ? (
          <>
            <IconBtn icon="info" size="md" ariaLabel="打开新手引导" title="新手引导" onClick={onTour} />
            <IconBtn icon="gear" size="md" ariaLabel="打开设置" title="设置" onClick={onSettings} />
          </>
        ) : (
          <>
            <Btn variant="ghost" size="sm" className="min-w-0 flex-1" onClick={onTour}>
              <Icon name="info" size={14} />
              新手引导
            </Btn>
            <IconBtn icon="gear" size="md" ariaLabel="打开设置" title="设置" onClick={onSettings} />
          </>
        )}
      </div>

      {/* 账户区：始终钉在左下角 */}
      <div className="relative shrink-0 border-t border-[color:var(--wb-border)] p-2.5" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenu((v) => !v)}
          title={name || '账户'}
          aria-haspopup="menu"
          aria-expanded={menu}
          className={`flex w-full items-center gap-2.5 rounded-[10px] p-1.5 transition-colors hover:bg-[color:var(--wb-bg-subtle)] ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          <Avatar name={name} hue={user?.avatar_hue} size={30} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[12px] font-medium text-[color:var(--wb-text)]">
                  {name || '本机账户'}
                </span>
                <span className="block truncate text-[10.5px] text-[color:var(--wb-muted)]">本机账户</span>
              </span>
              <Icon name="chevronUp" size={13} className="text-[color:var(--wb-muted)]" />
            </>
          )}
        </button>

        {menu && (
          <div
            role="menu"
            className={`wb-anim-pop absolute bottom-[calc(100%-2px)] z-50 w-[232px] overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-1.5 shadow-[var(--wb-shadow-lg)] ${
              collapsed ? 'left-1/2 -translate-x-1/2' : 'left-2.5'
            }`}
          >
            <div className="flex items-center gap-2.5 px-2 py-2">
              <Avatar name={name} hue={user?.avatar_hue} size={34} />
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">{name || '本机账户'}</div>
                <div className="truncate text-[10.5px] text-[color:var(--wb-muted)]">
                  @{user?.username || 'local'}
                </div>
              </div>
            </div>
            <div className="my-1 border-t border-[color:var(--wb-border)]" />
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => {
                setMenu(false)
                onProfile()
              }}
            >
              <Icon name="user" size={14} />
              个人资料
            </button>
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => {
                setMenu(false)
                onSettings()
              }}
            >
              <Icon name="gear" size={14} />
              设置
            </button>
            <div className="my-1 border-t border-[color:var(--wb-border)]" />
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left text-[12.5px] text-[color:var(--wb-danger)] transition-colors hover:bg-[color:var(--wb-danger-soft)]"
              onClick={() => {
                setMenu(false)
                logout()
              }}
            >
              <Icon name="logout" size={14} />
              退出登录
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

function Splash({ label = '正在打开工作台' }: { label?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[color:var(--wb-bg)]">
      <div className="relative">
        <span className="absolute -inset-3 rounded-[18px] bg-[color:var(--wb-accent)]/10 blur-md" aria-hidden />
        <span className="relative block">
          <BrandMark size={40} />
        </span>
      </div>
      <div className="text-[12px] text-[color:var(--wb-muted)]">{label}…</div>
    </div>
  )
}

export default function App() {
  const path = useLocation().pathname
  /** canvas 与 chat 都满铺整个内容区 */
  const full = path === '/canvas' || path === '/chat'
  const [navOpen, setNavOpen] = useState(false)
  const [collapsed, setCollapsed] = usePersist('app.navCollapsed', false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { loading, user, updateProfile, logout } = useAuth()

  const [nameDraft, setNameDraft] = useState('')
  const [hueDraft, setHueDraft] = useState(240)
  const [saving, setSaving] = useState(false)

  /** 新手引导：首次登录自动走一遍，之后只在侧边栏底部手动打开 */
  const [tourSeen, setTourSeen] = usePersist('app.tourSeen', false)
  const [tourOpen, setTourOpen] = useState(false)
  const hasUser = !!user
  useEffect(() => {
    if (loading || !hasUser || tourSeen) return
    const t = window.setTimeout(() => setTourOpen(true), 900)
    return () => window.clearTimeout(t)
  }, [loading, hasUser, tourSeen])
  const closeTour = useCallback(() => {
    setTourOpen(false)
    setTourSeen(true)
  }, [setTourSeen])

  useEffect(() => {
    if (!profileOpen) return
    setNameDraft(user?.display_name || '')
    setHueDraft(user?.avatar_hue ?? 240)
  }, [profileOpen, user])

  // `[` 收放侧边栏；在输入框里打字时不抢按键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return
      e.preventDefault()
      setCollapsed((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCollapsed])

  // 侧边栏气泡：登录后拉一次 /dashboard；换页、窗口回焦、别的模块改了数据时重算
  const [dash, setDash] = useState<any>(null)
  useEffect(() => {
    if (!hasUser) return
    let alive = true
    const loadCounts = () => {
      get('/dashboard')
        .then((d) => {
          if (alive) setDash(d)
        })
        .catch(() => {})
    }
    loadCounts()
    window.addEventListener('focus', loadCounts)
    window.addEventListener('wb:data-changed', loadCounts)
    return () => {
      alive = false
      window.removeEventListener('focus', loadCounts)
      window.removeEventListener('wb:data-changed', loadCounts)
    }
  }, [hasUser, path])
  const badges = navBadges(dash)

  if (loading) return <Splash />
  if (!user) return <Login />

  const saveProfile = async () => {
    setSaving(true)
    try {
      await updateProfile({ display_name: nameDraft.trim(), avatar_hue: hueDraft })
      setProfileOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full bg-[color:var(--wb-bg)]">
      {/* 窄屏：抽屉式导航（点遮罩或左上角按钮收起）；宽屏：常驻，可折叠成图标条 */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-[rgba(16,17,20,0.36)] backdrop-blur-[2px] lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}
      <div className={`${navOpen ? 'fixed z-50 flex h-full' : 'hidden'} lg:relative lg:z-auto lg:flex`}>
        <Sidebar
          collapsed={navOpen ? false : collapsed}
          badges={badges}
          onToggle={() => (navOpen ? setNavOpen(false) : setCollapsed((v) => !v))}
          onProfile={() => setProfileOpen(true)}
          onTour={() => setTourOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
      </div>

      <main className={`flex min-w-0 flex-1 flex-col ${full ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        {/* key=path：路由切换时整页淡入，页面之间不再「硬切」 */}
        <div
          key={path}
          className={
            full ? 'wb-anim-fade h-full w-full' : 'wb-anim-fade mx-auto w-full max-w-[1240px] px-6 py-7 md:px-8'
          }
        >
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/ideas" element={<Ideas />} />
            <Route path="/literature" element={<Literature />} />
            <Route path="/navigator" element={<Navigator />} />
            <Route path="/experiments" element={<Experiments />} />
            <Route path="/paper" element={<Paper />} />
            <Route path="/plan" element={<Plan />} />
            <Route path="/advisor" element={<Advisor />} />
            <Route path="/points" element={<Points />} />
            {/* 画布已并入「对话 / 工作流」分区；旧链接直接落到工作流 tab */}
            <Route path="/canvas" element={<Chat initialTab="flow" />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>

      {!navOpen && (
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="打开导航"
          className="fixed bottom-4 left-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)] shadow-[var(--wb-shadow-md)] lg:hidden"
        >
          <Icon name="menu" size={18} />
        </button>
      )}

      <Modal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="个人资料"
        width="max-w-md"
        footer={
          <>
            <Btn onClick={() => setProfileOpen(false)}>取消</Btn>
            <Btn variant="primary" loading={saving} onClick={saveProfile}>
              保存
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3.5">
            <Avatar name={nameDraft || displayNameOf(user)} hue={hueDraft} size={52} />
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-[color:var(--wb-text)]">
                {nameDraft.trim() || displayNameOf(user) || '本机账户'}
              </div>
              <div className="text-[11.5px] text-[color:var(--wb-muted)]">@{user.username}</div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-medium text-[color:var(--wb-text-soft)]">称呼</div>
            <Input value={nameDraft} onChange={setNameDraft} placeholder="希望怎么称呼你" />
            <div className="mt-1 text-[11px] text-[color:var(--wb-muted)]">
              显示在侧边栏和对话里，首字会作为头像。
            </div>
          </div>

          <div>
            <div className="mb-2 text-[12px] font-medium text-[color:var(--wb-text-soft)]">头像颜色</div>
            <div className="flex flex-wrap gap-2">
              {HUES.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHueDraft(h)}
                  aria-label={`头像色相 ${h}`}
                  aria-pressed={hueDraft === h}
                  className={`h-8 w-8 rounded-full transition-transform ${
                    hueDraft === h ? 'ring-2 ring-[color:var(--wb-text)] ring-offset-2' : 'hover:scale-105'
                  }`}
                  style={{
                    backgroundImage: `linear-gradient(145deg, hsl(${h} 62% 58%), hsl(${(h + 34) % 360} 64% 42%))`,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2.5 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
            账户与数据都在这台电脑上。
            <button
              type="button"
              onClick={() => {
                setProfileOpen(false)
                logout()
              }}
              className="ml-1 font-medium text-[color:var(--wb-danger)] underline decoration-dotted underline-offset-2"
            >
              退出登录
            </button>
          </div>
        </div>
      </Modal>

      <ToastHost />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Tour open={tourOpen} onClose={closeTour} />
    </div>
  )
}
