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
import { Icon, IconName } from './components/Icon'
import { usePersist } from './lib/state'

/** 侧边栏按科研流程分段：输入 → 执行 → 复盘 → 激励 */
const NAV_GROUPS: { group: string; items: { to: string; label: string; icon: IconName }[] }[] = [
  {
    group: 'I. 输入',
    items: [
      { to: '/ideas', label: '创新点', icon: 'sparkle' },
      { to: '/literature', label: '文献', icon: 'book' },
    ],
  },
  {
    group: 'II. 执行',
    items: [
      { to: '/experiments', label: '实验', icon: 'beaker' },
      { to: '/paper', label: '论文', icon: 'file' },
      { to: '/canvas', label: '科研画布', icon: 'hexagon' },
    ],
  },
  {
    group: 'III. 复盘',
    items: [
      { to: '/plan', label: '计划复盘', icon: 'clock' },
      { to: '/advisor', label: '导师', icon: 'phone' },
    ],
  },
  {
    group: 'IV. 激励',
    items: [{ to: '/points', label: '积分', icon: 'star' }],
  },
  {
    group: '',
    items: [
      { to: '/chat', label: '对话', icon: 'message' },
      { to: '/settings', label: '设置', icon: 'gear' },
    ],
  },
]

/** 激活态只靠左侧竖线与墨色文字，不用彩色软底 */
const itemCls = (active: boolean, collapsed: boolean) =>
  `wb-press-soft group relative flex h-8 items-center rounded-[var(--wb-radius-sm)] text-[12.5px] transition-colors duration-150 ${
    collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'
  } ${
    active
      ? 'font-medium text-[color:var(--wb-text)]'
      : 'text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'
  }`

/** 品牌标记：方形墨章，不用渐变、不用投影、不用彩色块 */
function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <div
      className="wb-serif flex shrink-0 items-center justify-center border border-[color:var(--wb-text)] bg-[color:var(--wb-surface)] font-medium text-[color:var(--wb-text)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
    >
      研
    </div>
  )
}

function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] transition-[width] duration-200 ${
        collapsed ? 'w-[58px]' : 'w-[188px]'
      }`}
    >
      <div className={`flex items-center gap-2.5 pb-2 pt-4 ${collapsed ? 'flex-col px-0' : 'px-4'}`}>
        <BrandMark />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold text-[color:var(--wb-text)]">
              科研工作台
            </div>
            <div className="truncate text-[9px] tracking-[0.06em] text-[color:var(--wb-muted)]">RESEARCH NOTES</div>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? '展开侧边栏（快捷键 [）' : '收起侧边栏（快捷键 [）'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          className="wb-press-strong mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--wb-radius-sm)] text-[color:var(--wb-muted)] transition-colors hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={13} />
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
                <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r-[var(--wb-radius-sm)] bg-[color:var(--wb-accent)]" />
              )}
              <Icon name="sun" size={15} />
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
                <div className="wb-running px-2.5 pb-1 pt-3">{g.group}</div>
              ))}
            <div className="flex flex-col gap-[1px]">
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} title={collapsed ? n.label : undefined} className={({ isActive }) => itemCls(isActive, collapsed)}>
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-r-[var(--wb-radius-sm)] bg-[color:var(--wb-accent)]" />
                      )}
                      <Icon name={n.icon} size={15} />
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

      <div className="shrink-0 border-t border-[color:var(--wb-border)] p-2.5">
        {collapsed ? (
          <div
            className="text-center text-[9px] font-medium text-[color:var(--wb-muted)]"
            title="数据存本地 · 可导出 Markdown / CSV"
          >
            DB
          </div>
        ) : (
          <div className="px-1 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
            本地存档 · 可导出 MD / CSV
          </div>
        )}
      </div>
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
          className="fixed inset-0 z-40 bg-[rgba(26,26,26,0.38)] lg:hidden"
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
        {/* 只做 opacity 淡入：页面容器带 transform / filter 会变成内部 fixed 弹层的 containing block */}
        <div
          className={
            full
              ? 'wb-page-enter h-full w-full'
              : 'wb-page-enter mx-auto w-full max-w-[1240px] px-6 py-7 md:px-8'
          }
        >
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
          className="wb-press-strong fixed bottom-4 left-4 z-30 flex h-11 w-11 items-center justify-center rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)] shadow-[var(--wb-shadow-md)] lg:hidden"
        >
          <Icon name="menu" size={18} />
        </button>
      )}

      <ToastHost />
    </div>
  )
}
