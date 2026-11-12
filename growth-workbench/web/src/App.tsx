import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useCallback, useRef, useState } from 'react'
import Dashboard from './pages/Dashboard'
import Ideas from './pages/Ideas'
import Literature from './pages/Literature'
import Navigator from './pages/Navigator'
import Search from './pages/Search'
import Experiments from './pages/Experiments'
import Paper from './pages/Paper'
import Plan from './pages/Plan'
import Advisor from './pages/Advisor'
import Points from './pages/Points'
import Settings from './pages/Settings'
import Chat from './pages/Chat'
import Community from './pages/Community'
import PaperFeed from './pages/PaperFeed'
import Canvas from './pages/Canvas'
import ResearchChat from './pages/ResearchChat'
import Consensus from './pages/Consensus'
import Workbench from './pages/Workbench'
import PaperStudio from './pages/PaperStudio'
import FigureStudio from './pages/FigureStudio'
import AnalysisStudio from './pages/AnalysisStudio'
import CodeStudio from './pages/CodeStudio'
import Landing from './pages/Landing'
import Login from './pages/Login'
import TutorialFrame from './features/tutorial/TutorialFrame'
import TutorialGuideHost from './features/tutorial/TutorialGuide'
import { TopBar, StatusBar } from './components/TopBar'
import { ToastHost } from './components/toast'
import Tour from './components/Tour'
import { Icon, IconName } from './components/Icon'
import { ResizeHandle } from './components/ResizeHandle'
import { Avatar, Btn, IconBtn, Input, Modal, usePresence } from './components/ui'
import { usePersist } from './lib/state'
import { get } from './lib/api'
import { displayNameOf, useAuth } from './lib/auth'
import SettingsPanel from './features/settings/SettingsPanel'
import { PlanProvider } from './lib/plan'
import Pricing from './pages/Pricing'

/**
 * 两层信息架构：① 工作台（做科研的地方，侧栏顶部）→ ② 研究 / 工具 / 节奏 / 更多（产出的东西与收纳）。
 * 统一工作台（/）是唯一首页：对话 / 调研 / 实验 三模式一句话启动；画布与课题从侧栏进入。
 * 工作台用与下方导航同款的普通列表项（不再用渐变大卡，避免层级倒挂）；
 * 术语字典见 docs/feature-ia-redesign-2026-11-08.md 第 5.3 节，但分组以本文件 NAV_GROUPS 为准
 * （2026-11-12 已由 9 组收敛为 5 组，那份文档记录的是当时的方案）。
 */
const WORKSPACES: { to: string; label: string; hint: string; icon: IconName }[] = [
  { to: '/canvas', label: '编排画布 Canvas', hint: '多步 AI 任务连成流水线', icon: 'layers' },
  { to: '/', label: '工作台', hint: '对话 · 调研 · 实验 一站式启动', icon: 'home' },
  { to: '/research', label: '对话 · 调研', hint: '研究对话：深度检索 → 入库 → 带引用报告', icon: 'message' },
  { to: '/chat', label: '课题 Quest', hint: '契约 → 四阶段门禁 → 成文', icon: 'sparkle' },
  { to: '/consensus', label: '共识 Consensus', hint: '接 consensus.app 做真实学术共识检索', icon: 'check' },
]

type NavItem = { to: string; label: string; icon: IconName; badge?: boolean }

/** 导航结构（2026-11-12 收紧为 5 分组 + 顶部工作台组 + 今日独立项）：
 *  - 顶部「工作台」组 5 项：编排画布（置顶）/ 工作台 / 对话·调研 / 课题 Quest / 共识——
 *    即「工作台·调研·课题·共识」合并进同一个小菜单，画布置顶；共识由独立项并入本组。
 *  - 页面内 tab 不再提升为侧栏项：文献的 关联图/对比矩阵/检索 回归页面内切换条，侧栏只留「文献库」；
 *  - 站点快搜从侧栏撤掉（顶栏已有同款入口）；单项孤组（速递/社区）并入相邻分组；
 *  - 低频的「工作室」降级到工具组，高频的文献/实验靠 badge 气泡保持在第一屏。
 *  - 直达项合计 20：工作台组 5 + 今日 1 + 研究 5 + 工具 4 + 节奏 3 + 更多 2。
 *  - 概览指标已并入「今日」（2026-11-12），/stats 重定向到 /today。 */
const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: '研究',
    items: [
      { to: '/literature?tab=library', label: '文献库', icon: 'book', badge: true },
      { to: '/paperfeed', label: '论文速递', icon: 'inbox' },
      { to: '/ideas', label: '创新点', icon: 'sparkle' },
      { to: '/experiments', label: '实验', icon: 'beaker', badge: true },
      { to: '/paper', label: '论文', icon: 'file' },
    ],
  },
  {
    group: '工具',
    items: [
      { to: '/studio/paper', label: '论文工作室', icon: 'quill' },
      { to: '/studio/figure', label: '绘图工作室', icon: 'chart' },
      { to: '/studio/analysis', label: '数据分析', icon: 'sigma' },
      { to: '/studio/code', label: '代码工作室', icon: 'cpu' },
    ],
  },
  {
    group: '节奏',
    items: [
      { to: '/plan', label: '计划复盘', icon: 'clock', badge: true },
      { to: '/advisor', label: '导师', icon: 'phone' },
      { to: '/points', label: '激励规则', icon: 'star' },
    ],
  },
  {
    group: '更多',
    items: [
      { to: '/community', label: '科研社区', icon: 'users' },
      { to: '/tutorial/llmutg', label: '案例教程', icon: 'book' },
    ],
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
  put('/today', (d.open_tasks || 0) + (d.open_bets || 0), 'accent')
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
  `wb-press-soft group relative flex items-center rounded-[9px] text-[12.5px] transition-colors duration-150 ${
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

/** ① 工作台：与下方导航同款普通列表项，只保留当前页 accent 高亮（不再用渐变大卡）
 *  2026-11-12：「今日」提到品牌区正下方、全侧栏第一个位置（带真实待办气泡），
 *  这里仍是「工作台」组本身；今日不并进 WORKSPACES 数组（那会丢掉角标）。 */
function TodayItem({ collapsed, badge }: { collapsed: boolean; badge?: NavBadge }) {
  return (
    <div className={collapsed ? 'px-2 pb-1 pt-1' : 'px-3 pb-1 pt-1'}>
      <NavLink
        to="/today"
        end
        title={collapsed ? '今日' : '今日：待办 · 打卡 · 概览'}
        className={({ isActive }) =>
          `${itemCls(isActive, collapsed)} ${
            isActive
              ? ''
              : 'bg-[color:var(--wb-accent-soft)]/55 text-[color:var(--wb-text)]'
          }`
        }
      >
        <Icon name="sun" size={15} className="text-[color:var(--wb-accent)]" />
        {collapsed ? <span className="sr-only">今日</span> : <span className="truncate font-medium">今日</span>}
        <NavCount badge={badge} collapsed={collapsed} />
      </NavLink>
    </div>
  )
}

function WorkspaceGroup({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={collapsed ? 'px-2 pb-1 pt-1' : 'px-3 pb-1 pt-1'}>
      {collapsed ? (
        <div className="mx-1 my-2 border-t border-[color:var(--wb-border)]" />
      ) : (
        <div className="px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
          工作台
        </div>
      )}
      <div className="flex flex-col gap-[2px]">
        {WORKSPACES.map((w) => (
          <NavLink
            key={w.to}
            to={w.to}
            end={w.to === '/'}
            title={collapsed ? w.label : w.hint}
            className={({ isActive }) => itemCls(isActive, collapsed)}
          >
            <Icon name={w.icon} size={15} />
            {collapsed ? <span className="sr-only">{w.label}</span> : <span className="truncate">{w.label}</span>}
          </NavLink>
        ))}
      </div>
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
  width,
  badges,
  onToggle,
  onProfile,
  onTour,
  onSettings,
}: {
  collapsed: boolean
  /** 展开态宽度由 App 用 usePersist 持有，可拖拽；折叠态固定 60px 图标条 */
  width: number
  badges: Record<string, NavBadge>
  onToggle: () => void
  onProfile: () => void
  onTour: () => void
  onSettings: () => void
}) {
  const { user, logout } = useAuth()
  const [menu, setMenu] = useState(false)
  const menuRef = useDismiss(menu, () => setMenu(false))
  /** 菜单关闭时先播退出动画再卸载，不要「啪」地消失 */
  const menuPresence = usePresence(menu, 160)
  const name = displayNameOf(user)
  const { pathname, search } = useLocation()

  /** 侧栏收紧后只剩「文献库」一个带 ?tab= 的入口：按 pathname + tab 精确高亮，
   *  无 ?tab= 时按文献模块的默认视图（library）命中。画布等子视图已回归页面内切换条。 */
  const isItemActive = (to: string) => {
    const [p, q] = to.split('?')
    if (pathname !== p) return false
    if (!q) return true
    const want = new URLSearchParams(q).get('tab')
    const got = new URLSearchParams(search).get('tab')
    return (got || 'library') === want
  }

  const menuItem =
    'wb-press-soft flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left text-[12.5px] text-[color:var(--wb-text-soft)] transition-colors hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'

  return (
    <aside
      data-resizable
      className={`flex h-full shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] transition-[width] duration-200 ${
        collapsed ? 'w-[60px]' : ''
      }`}
      style={collapsed ? undefined : { width }}
      aria-label="侧边栏"
    >
      <div className={`flex items-center gap-2.5 pb-2 pt-4 ${collapsed ? 'flex-col px-0' : 'px-4'}`}>
        <BrandMark />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold text-[color:var(--wb-text)]">研流</div>
            <div className="truncate text-[10.5px] text-[color:var(--wb-muted)]">科研一站式工作台</div>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? '展开侧边栏（快捷键 [）' : '收起侧边栏（快捷键 [）'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          className="wb-press-strong mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[color:var(--wb-muted)] transition-colors hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={13} />
        </button>
      </div>

      {/* 「今日」钉在品牌区正下方：每天的第一入口，带真实待办气泡。
          它不属于任何分组，所以不并进 WORKSPACES / NAV_GROUPS（那会丢掉角标）。 */}
      <TodayItem collapsed={collapsed} badge={badges['/today']} />

      {/* ① 工作台组：入口用与下方导航同款的普通列表项，路由驱动、不用渐变大卡 */}
      <WorkspaceGroup collapsed={collapsed} />

      <nav
        data-tour="tour-sidebar"
        className={`min-h-0 flex-1 overflow-y-auto pb-2 ${collapsed ? 'px-2' : 'px-3'}`}
        aria-label="主导航"
      >
      {/* 「共识」已并入顶部「工作台」组（与 画布/工作台/调研/课题 同块），
          接 consensus.app 做真实学术共识检索；不再作为独立项渲染。 */}

        {NAV_GROUPS.map((g, gi) => (
          <div key={gi}>
            {collapsed ? (
              gi > 0 && <div className="mx-1 my-2 border-t border-[color:var(--wb-border)]" />
            ) : (
              <div className="px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
                {g.group}
              </div>
            )}
            <div className="flex flex-col gap-[2px]">
              {g.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  title={collapsed ? n.label : undefined}
                  className={() => itemCls(isItemActive(n.to), collapsed)}
                >
                  <Icon name={n.icon} size={15} />
                  {collapsed ? <span className="sr-only">{n.label}</span> : <span className="truncate">{n.label}</span>}
                  {n.badge && <NavCount badge={badges[n.to.split('?')[0]]} collapsed={collapsed} />}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* 底部工具：只留新手引导；设置统一从左下角账户头像进入，不再放独立齿轮 */}
      <div className={`flex shrink-0 items-center gap-1 p-2 ${collapsed ? 'flex-col' : ''}`}>
        {collapsed ? (
          <IconBtn icon="info" size="md" ariaLabel="打开新手引导" title="新手引导" onClick={onTour} />
        ) : (
          <Btn variant="ghost" size="sm" className="min-w-0 flex-1" onClick={onTour}>
            <Icon name="info" size={14} />
            新手引导
          </Btn>
        )}
      </div>

      {/* 账户区：始终钉在左下角（账户 / 个人资料 / 设置都从这里进） */}
      <div
        data-tour="tour-settings-entry"
        className="relative shrink-0 border-t border-[color:var(--wb-border)] p-2.5"
        ref={menuRef}
      >
        <button
          type="button"
          onClick={() => setMenu((v) => !v)}
          title={name || '账户'}
          aria-haspopup="menu"
          aria-expanded={menu}
          className={`wb-press-soft flex w-full items-center gap-2.5 rounded-[10px] p-1.5 transition-colors hover:bg-[color:var(--wb-bg-subtle)] ${
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

        {menuPresence.mounted && (
          <div
            role="menu"
            /* 折叠态用负 margin 居中而不是 -translate-x-1/2：
               入场动画的 transform 会覆盖 Tailwind 的 translate，菜单会先跳一下再归位 */
            style={collapsed ? { marginLeft: -116 } : undefined}
            className={`absolute bottom-[calc(100%-2px)] z-50 w-[232px] overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-1.5 shadow-[var(--wb-shadow-lg)] ${
              menuPresence.leaving ? 'wb-overlay-out' : 'wb-anim-pop'
            } ${collapsed ? 'left-1/2' : 'left-2.5'}`}
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
              className="wb-press-soft flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-left text-[12.5px] text-[color:var(--wb-danger)] transition-colors hover:bg-[color:var(--wb-danger-soft)]"
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
    <div className="wb-anim-fade flex h-full flex-col items-center justify-center gap-4 bg-[color:var(--wb-bg)]">
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
  const loc = useLocation()
  const path = loc.pathname
  /** 三个工作台 + 落地页满铺；顶栏只做定位，不再挂工作台切换条 */
  const isWorkspace = path === '/chat' || path === '/canvas' || path === '/research'
  // 文献页四个视图（文献库 / 关联图 / 对比矩阵 / 检索）满铺：占满顶栏与状态栏之间的
  // 整个内容区，与侧栏边线直接相接；页面身份由顶栏面包屑承担，页内不再渲染大标题
  // 实验页与文献页同款满铺：Agent 实验三栏 / 结果与运行都要占满顶栏与状态栏之间的整个内容区，
  // 不能再被 max-w-[1240px] 居中限制出右侧与下方的灰底留白
  // 共识页同款满铺：共识表内部自滚动，被 max-w 居中会截断三列表格
  const full = isWorkspace || path === '/landing' || path === '/paperfeed' || path === '/literature' || path === '/experiments' || path === '/consensus' || path.startsWith('/studio/') || path === '/tutorial/llmutg'
  const isLanding = path === '/landing'
  const [navOpen, setNavOpen] = useState(false)
  const [collapsed, setCollapsed] = usePersist('app.navCollapsed', false)
  /** 展开态侧边栏宽度：可拖拽，全站共用（拖一次所有页面都生效），折叠态仍是固定 60px */
  const [sidebarW, setSidebarW] = usePersist('app.sidebarW', 216)
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
    <PlanProvider>
    <div className="flex h-full bg-[color:var(--wb-bg)]">
      {/* 窄屏：抽屉式导航（点遮罩或左上角按钮收起）；宽屏：常驻，可折叠成图标条 */}
      {!isLanding && navOpen && (
        <div
          className="fixed inset-0 z-40 bg-[rgba(16,17,20,0.36)] backdrop-blur-[2px] lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}
      {!isLanding && (
        <div className={`wb-app-nav ${navOpen ? 'fixed z-50 flex h-full' : 'hidden'} lg:relative lg:z-auto lg:flex`}>
          <Sidebar
            collapsed={navOpen ? false : collapsed}
            width={sidebarW}
            badges={badges}
            onToggle={() => (navOpen ? setNavOpen(false) : setCollapsed((v) => !v))}
            onProfile={() => setProfileOpen(true)}
            onTour={() => setTourOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />
          {/* 展开态才给拖拽把手；窄屏抽屉与折叠图标条都不占这条 6px。
              拖动只改宽度，侧边栏内的导航 / 折叠 / 账户 / 设置等功能原样保留。 */}
          {!collapsed && !navOpen && (
            <ResizeHandle
              className="hidden lg:block"
              width={sidebarW}
              onResize={setSidebarW}
              onReset={() => setSidebarW(216)}
              min={188}
              max={360}
              label="调整菜单栏宽度"
            />
          )}
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 全站细顶栏：定位 + 全局操作。
            页面身份由顶栏面包屑与左侧导航高亮承担，内容区不再渲染大标题；
            工作台切换只在左侧菜单，顶栏不重复。 */}
        {!isLanding && (
          <TopBar
            onProfile={() => setProfileOpen(true)}
            onTour={() => setTourOpen(true)}
            user={user}
          />
        )}
        {/* key=path：路由切换重播进入动画，整页柔和淡入而不是硬切。
            只用 opacity —— 带 transform 的容器会成为内部 fixed 弹层的 containing block。
            页面内 ?tab= 之类的视图切换由各页自己的 .wb-view-enter 负责，不重挂载整页。 */}
        <div
          key={path}
          className={
            full
              ? 'wb-page-enter min-h-0 flex-1 overflow-hidden'
              : 'wb-page-enter mx-auto w-full min-h-0 max-w-[1240px] flex-1 overflow-y-auto px-6 py-7 md:px-8'
          }
        >
            <Routes>
              {/* 主页 = 统一工作台启动面（对话 / 调研 / 实验 三胶囊 + 一句话输入框） */}
              <Route path="/" element={<Workbench />} />
              <Route path="/landing" element={<Landing />} />
              <Route path="/studio/paper" element={<PaperStudio />} />
              <Route path="/studio/figure" element={<FigureStudio />} />
              <Route path="/studio/analysis" element={<AnalysisStudio />} />
              <Route path="/studio/code" element={<CodeStudio />} />
              <Route path="/today" element={<Dashboard />} />
              <Route path="/ideas" element={<Ideas />} />
            <Route path="/literature" element={<Literature />} />
            <Route path="/research" element={<ResearchChat />} />
            <Route path="/consensus" element={<Consensus />} />
            <Route path="/navigator" element={<Navigator />} />
            <Route path="/search" element={<Search />} />
            <Route path="/experiments" element={<Experiments />} />
            <Route path="/paper" element={<Paper />} />
              <Route path="/community" element={<Community />} />
              <Route path="/paperfeed" element={<PaperFeed />} />
              <Route path="/pricing" element={<Pricing />} />
            <Route path="/plan" element={<Plan />} />
            {/* 概览指标已并入「今日」页（2026-11-12）：旧地址重定向，避免收藏夹/引用扑空 */}
            <Route path="/stats" element={<Navigate to="/today" replace />} />
            <Route path="/advisor" element={<Advisor />} />
            <Route path="/points" element={<Points />} />
            {/* 课题 / 画布各自独立：不再经 Chat 的 tab 转发，URL 就是唯一真源 */}
            <Route path="/canvas" element={<Canvas />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/settings" element={<Settings />} />
            {/* 案例教程：把静态教程页以 iframe 嵌入，作为工作台内功能 */}
            <Route path="/tutorial/llmutg" element={<TutorialFrame />} />
          </Routes>
        </div>
        {!isLanding && <StatusBar />}
      </main>

      {/* 案例教程跨页指引：教程页「前往实操」后，在目标页接住并浮出引导 */}
      <TutorialGuideHost />

      {!isLanding && !navOpen && (
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="打开导航"
          className="wb-app-nav-fab wb-press-strong fixed bottom-4 left-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)] shadow-[var(--wb-shadow-md)] lg:hidden"
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
                  className={`wb-press-strong h-8 w-8 rounded-full transition-transform ${
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
    </PlanProvider>
  )
}
