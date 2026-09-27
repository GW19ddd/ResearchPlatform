import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import Dashboard from './pages/Dashboard'
import Ideas from './pages/Ideas'
import Literature from './pages/Literature'
import Experiments from './pages/Experiments'
import Paper from './pages/Paper'
import Plan from './pages/Plan'
import Advisor from './pages/Advisor'
import Points from './pages/Points'
import Settings from './pages/Settings'
import Canvas from './pages/Canvas'
import Chat from './pages/Chat'
import { ToastHost } from './components/toast'
import { usePersist } from './lib/state'

/** 侧边栏按科研流程分段：输入 → 执行 → 复盘 → 激励 */
const NAV_GROUPS: { group: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    group: '输入',
    items: [
      { to: '/ideas', label: '创新点', icon: '✦' },
      { to: '/literature', label: '文献', icon: '❐' },
    ],
  },
  {
    group: '执行',
    items: [
      { to: '/experiments', label: '实验', icon: '⌗' },
      { to: '/paper', label: '论文', icon: '▤' },
      { to: '/canvas', label: '科研画布', icon: '⬡' },
    ],
  },
  {
    group: '复盘',
    items: [
      { to: '/plan', label: '计划复盘', icon: '◷' },
      { to: '/advisor', label: '导师', icon: '☏' },
    ],
  },
  {
    group: '激励',
    items: [{ to: '/points', label: '积分', icon: '★' }],
  },
  {
    group: '',
    items: [
      { to: '/chat', label: '对话', icon: '❢' },
      { to: '/settings', label: '设置', icon: '⚙' },
    ],
  },
]

const itemCls = (active: boolean, collapsed: boolean) =>
  `group relative flex items-center rounded-[9px] text-[12.5px] transition ${
    collapsed ? 'justify-center px-0 py-[7px]' : 'gap-2 px-2.5 py-[6px]'
  } ${
    active
      ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
      : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'
  }`

function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] transition-[width] duration-200 ${
        collapsed ? 'w-[58px]' : 'w-[188px]'
      }`}
    >
      <div
        className={`flex items-center gap-2 px-3 pb-3 pt-4 ${
          collapsed ? 'flex-col gap-2 px-0' : ''
        }`}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--wb-accent)] text-[13px] font-bold text-white shadow-[var(--wb-shadow-xs)]">
          研
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold text-[color:var(--wb-text)]">
              科研工作台
            </div>
            <div className="truncate text-[10.5px] text-[color:var(--wb-muted)]">创新 · 文献 · 实验</div>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? '展开侧边栏（快捷键 [）' : '收起侧边栏（快捷键 [）'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface-alt)] text-[11px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]`}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <nav
        className={`min-h-0 flex-1 overflow-y-auto pb-2 ${collapsed ? 'px-1.5' : 'px-2.5'}`}
        aria-label="主导航"
      >
        <NavLink to="/" end className={({ isActive }) => `${itemCls(isActive, collapsed)} mb-2`}>
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r-full bg-[color:var(--wb-accent)]" />
              )}
              <span className="w-3.5 text-center text-[11px] opacity-75">◆</span>
              {!collapsed && <span className="truncate">今日</span>}
              {collapsed && <span className="sr-only">今日</span>}
            </>
          )}
        </NavLink>

        {NAV_GROUPS.map((g, gi) => (
          <div key={gi} className="mb-1.5">
            {g.group &&
              (collapsed ? (
                gi > 0 && <div className="mx-1 my-2 border-t border-[color:var(--wb-border)]" />
              ) : (
                <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-[color:var(--wb-muted)]">
                  {g.group}
                </div>
              ))}
            <div className="flex flex-col gap-[1px]">
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} title={collapsed ? n.label : undefined} className={({ isActive }) => itemCls(isActive, collapsed)}>
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r-full bg-[color:var(--wb-accent)]" />
                      )}
                      <span className="w-3.5 text-center text-[11px] opacity-70">{n.icon}</span>
                      {collapsed ? (
                        <span className="sr-only">{n.label}</span>
                      ) : (
                        <span className="truncate">{n.label}</span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {collapsed ? (
        <div className="border-t border-[color:var(--wb-border)] py-2 text-center text-[9px] text-[color:var(--wb-muted)]">
          SQLite
        </div>
      ) : (
        <div className="border-t border-[color:var(--wb-border)] px-4 py-3 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
          数据存本地 SQLite
          <br />
          可一键导出 Markdown / CSV
        </div>
      )}
    </aside>
  )
}

export default function App() {
  const full = useLocation().pathname === '/canvas'
  const [navOpen, setNavOpen] = useState(false)
  const [collapsed, setCollapsed] = usePersist('app.navCollapsed', false)

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

  return (
    <div className="flex h-full bg-[color:var(--wb-bg)]">
      {/* 窄屏：抽屉式导航（点遮罩或左上角按钮收起）；宽屏：常驻，可折叠成图标条 */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-[rgba(16,24,40,0.4)] lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}
      <div
        className={`${
          navOpen ? 'fixed z-50 flex h-full' : 'hidden'
        } lg:relative lg:z-auto lg:flex`}
      >
        <Sidebar
          collapsed={navOpen ? false : collapsed}
          onToggle={() => (navOpen ? setNavOpen(false) : setCollapsed((v) => !v))}
        />
      </div>

      <main className={`flex min-w-0 flex-1 flex-col ${full ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        <div className={full ? 'h-full w-full' : 'mx-auto w-full max-w-[1180px] px-5 py-6'}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/ideas" element={<Ideas />} />
            <Route path="/literature" element={<Literature />} />
            <Route path="/experiments" element={<Experiments />} />
            <Route path="/paper" element={<Paper />} />
            <Route path="/plan" element={<Plan />} />
            <Route path="/advisor" element={<Advisor />} />
            <Route path="/points" element={<Points />} />
            <Route path="/canvas" element={<Canvas />} />
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
          className="fixed bottom-4 left-4 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[15px] text-[color:var(--wb-text-soft)] shadow-[var(--wb-shadow-md)] lg:hidden"
        >
          ☰
        </button>
      )}

      <ToastHost />
    </div>
  )
}
