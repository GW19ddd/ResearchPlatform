/**
 * 工作台切换条（路由驱动，唯一真源）。
 *
 * 三个工作台各自独立：课题 Quest / 编排画布 Canvas / 调研 Research。
 * 由 App 层在三个满铺工作台上统一渲染一份，页面内不再各自挂页签，
 * 避免历史上「路由级 WorkflowTabs 叠在 state 级 ChatTabs 上」的双层页签。
 */
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon, IconName } from './Icon'

const TABS: { to: string; label: string; hint: string; icon: IconName }[] = [
  { to: '/chat', label: '课题 Quest', hint: '填契约 → 受控推进 → 随时接管', icon: 'sparkle' },
  { to: '/canvas', label: '编排画布', hint: '把多步 AI 任务连成可复用的流水线', icon: 'layers' },
  { to: '/research', label: '调研 Research', hint: '找文献 → 自动入库 → 带引用报告', icon: 'message' },
]

export default function WorkspaceTabs() {
  const { pathname } = useLocation()
  const nav = useNavigate()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {TABS.map((t) => {
        const active = pathname === t.to || pathname.startsWith(t.to + '/')
        return (
          <button
            key={t.to}
            type="button"
            onClick={() => nav(t.to)}
            title={t.hint}
            className={`wb-press flex items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 py-[7px] text-[12px] font-medium transition ${
              active
                ? 'bg-[color:var(--wb-text)] text-white'
                : 'border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-accent)]/50 hover:text-[color:var(--wb-accent)]'
            }`}
          >
            <Icon name={t.icon} size={13} />
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
