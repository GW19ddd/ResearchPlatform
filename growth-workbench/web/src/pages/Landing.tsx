/**
 * 落地页（首页 /）：整个工作台的入口。
 *
 * 设计意图：
 *   - 首屏主路径是「新建课题」→ /chat（课题 Quest）；
 *   - 三个工作台用一组卡片明确摆出来，不再共用一个模糊的「对话工作流」名字；
 *   - 点「进入工作台」才进入带侧边栏的完整工作台；
 *   - 不贴「主打」之类的文字标签，靠位置与视觉权重体现主路径。
 *
 * 数据：拉 /chat/sessions 只为展示「继续最近的课题」，失败不影响页面。
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Btn, Pill } from '../components/ui'
import { Icon } from '../components/Icon'
import { get } from '../lib/api'

function Mark() {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-[color:var(--wb-accent)] to-[color:var(--wb-accent-strong)] text-[15px] font-bold text-white shadow-[0_6px_16px_-8px_rgba(64,52,196,0.65)]">
      研
    </div>
  )
}

/** 三个工作台：按术语字典一笔一名，和侧栏「工作台」三卡一致 */
const WORKSPACES = [
  { to: '/chat', label: '课题 Quest', hint: '契约 → 四阶段门禁 → 成文', icon: 'sparkle' as const },
  { to: '/canvas', label: '编排画布', hint: '多步 AI 任务连成流水线', icon: 'layers' as const },
  { to: '/research', label: '调研 Research', hint: '找文献 → 带引用报告', icon: 'message' as const },
]

const QUICK = [
  { to: '/ideas', label: '创新点', icon: 'sparkle' as const },
  { to: '/literature', label: '文献', icon: 'book' as const },
  { to: '/experiments', label: '实验', icon: 'beaker' as const },
  { to: '/paper', label: '论文', icon: 'file' as const },
]

export default function Landing() {
  const nav = useNavigate()
  const [latest, setLatest] = useState<any>(null)

  useEffect(() => {
    get('/chat/sessions')
      .then((r: any) => {
        const list = Array.isArray(r) ? r : []
        setLatest(list.find((s: any) => Number(s.msg_count) > 0) || list[0] || null)
      })
      .catch(() => setLatest(null))
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-[color:var(--wb-bg)]">
      {/* 柔光：给落地页一点分量，但保持清爽，不抢文字对比度 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -top-40 h-[420px] w-[420px] rounded-full bg-[color:var(--wb-accent)]/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 bottom-0 h-[360px] w-[360px] rounded-full bg-[color:var(--wb-accent)]/[0.06] blur-3xl"
      />

      <header className="relative flex items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center gap-2.5">
          <Mark />
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-[color:var(--wb-text)]">科研工作台</div>
            <div className="text-[10.5px] text-[color:var(--wb-muted)]">Research Workbench</div>
          </div>
        </div>
        <Btn variant="ghost" size="sm" onClick={() => nav('/today')}>
          <Icon name="grid" size={14} />
          进入工作台
        </Btn>
      </header>

      <main className="relative flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <Pill tone="indigo">
          <Icon name="sparkle" size={11} />
          课题 Quest
        </Pill>
        <h1 className="mt-4 max-w-[26ch] text-[34px] font-semibold leading-[1.25] tracking-[-0.03em] text-[color:var(--wb-text)] md:text-[46px]">
          把课题交给 AI 科研助手
        </h1>
        <p className="mt-4 max-w-[58ch] text-[14px] leading-relaxed text-[color:var(--wb-text-soft)]">
          按「调研 → 计划 → 实验 → 成文」受控推进：每道门禁前停下来等你确认，关键结论沉淀为「发现」，之后每一轮对话自动带上。
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Btn
            variant="primary"
            className="!h-12 !px-7 !text-[14px]"
            onClick={() => nav('/chat')}
          >
            <Icon name="sparkle" size={16} />
            新建课题
          </Btn>
          <Btn className="!h-12 !px-7 !text-[14px]" onClick={() => nav('/today')}>
            进入工作台
          </Btn>
          {latest && (
            <Btn className="!h-12 !px-7 !text-[14px]" onClick={() => nav('/chat')}>
              <Icon name="arrowRight" size={15} />
              继续「{String(latest.title || '未命名 Quest').slice(0, 16)}」
            </Btn>
          )}
        </div>

        {/* 三个工作台并列摆出：一个名字对应一个产品，避免「对话工作流」一名三义 */}
        <div className="mt-10 grid w-full max-w-[820px] grid-cols-1 gap-2.5 sm:grid-cols-3">
          {WORKSPACES.map((w) => (
            <button
              key={w.to}
              type="button"
              onClick={() => nav(w.to)}
              className="flex items-start gap-2.5 rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3.5 py-3 text-left transition-colors hover:border-[color:var(--wb-accent)]/50 hover:bg-[color:var(--wb-accent-soft)]"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
                <Icon name={w.icon} size={14} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">{w.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-[color:var(--wb-muted)]">{w.hint}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px] text-[color:var(--wb-muted)]">
          <span className="text-[color:var(--wb-text-soft)]">快速进入：</span>
          {QUICK.map((q) => (
            <button
              key={q.to}
              type="button"
              onClick={() => nav(q.to)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-1.5 transition-colors hover:border-[color:var(--wb-border-strong)] hover:text-[color:var(--wb-text)]"
            >
              <Icon name={q.icon} size={13} className="text-[color:var(--wb-accent)]" />
              {q.label}
            </button>
          ))}
        </div>
      </main>

      <footer className="relative px-6 py-5 text-center text-[11px] text-[color:var(--wb-muted)]">
        本地优先 · 数据留在你自己的电脑上
      </footer>
    </div>
  )
}
