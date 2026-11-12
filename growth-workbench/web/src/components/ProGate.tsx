import { ReactNode } from 'react'
import { Btn, Progress } from './ui'
import { Icon } from './Icon'
import { ProBadge } from './ProBadge'
import { usePlan } from '../lib/plan'

/**
 * 功能门禁：某功能是 Pro 专享时，免费用户看到的是升级引导而不是功能本身。
 * feature 与后端 plans.features 的键对应（advanced-models / unlimited-canvas / priority-support）。
 */
export function ProGate({
  feature,
  children,
  title = 'Pro 专享功能',
  desc,
  compact = false,
}: {
  feature: string
  children: ReactNode
  title?: string
  desc?: string
  compact?: boolean
}) {
  const { isPro, billing, openPricing } = usePlan()
  const allowed = isPro || !!billing?.features?.[feature]
  if (allowed) return <>{children}</>

  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-[var(--wb-radius-lg)] border border-dashed border-[color:var(--wb-pro)]/40 bg-[color:var(--wb-pro-soft)]/40 px-5 py-7 text-center ${
        compact ? 'py-5' : ''
      }`}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--wb-pro-soft)] text-[color:var(--wb-pro)]">
        <Icon name="crown" size={20} />
      </span>
      <div className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">{title}</div>
      <p className="max-w-[40ch] text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
        {desc || '升级到 Pro 后即可使用此功能，并解锁无限 AI 额度与高级推理模型。'}
      </p>
      <Btn variant="primary" onClick={() => openPricing()}>
        <Icon name="crown" size={13} />
        升级到 Pro 解锁
      </Btn>
    </div>
  )
}

/**
 * 工作室门禁：包住 AI 工作室（论文 / 绘图 / 分析 / 代码）整页。
 * - 免费用户：顶部一条「本月免费额度」进度条 + 升级入口；额度用尽则整页替换为升级引导（硬门禁）。
 * - Pro 用户：无障碍放行。
 * 这样免费用户能真实体验工作室，但受月度额度约束；Pro 解锁无限使用。
 */
export function StudioProGate({
  children,
  label = '工作室',
  className = '',
}: {
  children: ReactNode
  label?: string
  /** 透传到外层容器，工作室整页传 'h-full min-h-0' 以撑满父容器 */
  className?: string
}) {
  const { isPro, billing, openPricing } = usePlan()

  const overQuota =
    !isPro && billing && billing.ai_credits_remaining !== null && billing.ai_credits_remaining <= 0

  if (overQuota) {
    return (
      <div className={`flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 text-center ${className}`}>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--wb-pro-soft)] text-[color:var(--wb-pro)]">
          <Icon name="crown" size={24} />
        </span>
        <div className="text-[15px] font-semibold text-[color:var(--wb-text)]">本月免费额度已用完</div>
        <p className="max-w-[42ch] text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
          免费版每月包含 {billing?.ai_credits_limit ?? 0} 次 AI 调用，当前已用尽。升级到 Pro 解锁无限 AI 额度与高级推理模型，继续在{label}中高效产出。
        </p>
        <Btn variant="primary" onClick={() => openPricing()}>
          <Icon name="crown" size={13} />
          升级到 Pro
        </Btn>
      </div>
    )
  }

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`}>
      {!isPro && billing && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-[var(--wb-radius)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-2">
          <Icon name="sparkle" size={13} className="text-[color:var(--wb-pro)]" />
          <span className="text-[11.5px] text-[color:var(--wb-text-soft)]">免费额度</span>
          <div className="min-w-[120px] flex-1">
            <Progress
              value={billing.ai_credits_used}
              max={billing.ai_credits_limit || 1}
              tone="accent"
            />
          </div>
          <span className="text-[11px] tabular-nums text-[color:var(--wb-muted)]">
            {billing.ai_credits_used}/{billing.ai_credits_limit} 次
          </span>
          <Btn size="xs" variant="primary" onClick={() => openPricing()}>
            <Icon name="crown" size={11} />
            升级 Pro 解锁无限
          </Btn>
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
