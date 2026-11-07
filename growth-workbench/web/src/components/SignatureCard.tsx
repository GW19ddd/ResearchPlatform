/**
 * 首屏「招牌卡」：每个模块只放最能代表它价值的那一项能力。
 *
 * 组合 ui.tsx 原语与 --wb-* 设计令牌，不引入新调色板、不引入 Unicode 符号当图标。
 * 规则：StatCard 一律降为页头副行或第二屏，招牌卡才是首屏主角。
 */
import { type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type SignatureMetric = {
  label: string
  value: string | number
  tone?: 'accent' | 'danger' | 'ok'
}

export type SignatureStep = {
  label: string
  value: string | number
  active?: boolean
}

export default function SignatureCard({
  eyebrow,
  title,
  desc,
  icon,
  tone = 'accent',
  metrics,
  steps,
  action,
}: {
  eyebrow: string
  title: string
  desc: string
  icon: IconName
  tone?: 'accent' | 'danger'
  metrics?: SignatureMetric[]
  steps?: SignatureStep[]
  action?: ReactNode
}) {
  const danger = tone === 'danger'
  return (
    <section
      className={`relative overflow-hidden rounded-[16px] border p-4 md:p-5 ${
        danger
          ? 'border-[color:var(--wb-border)] bg-[color:var(--wb-danger-soft)]'
          : 'border-[color:var(--wb-border)] bg-[color:var(--wb-accent-soft)]'
      }`}
    >
      <div className="flex flex-wrap items-start gap-4">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[color:var(--wb-surface)] ${
            danger ? 'text-[color:var(--wb-danger)]' : 'text-[color:var(--wb-accent)]'
          }`}
        >
          <Icon name={icon} size={20} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--wb-muted)]">
            {eyebrow}
          </div>
          <h2 className="mt-1 text-[17px] font-semibold leading-snug text-[color:var(--wb-text)]">{title}</h2>
          <p className="mt-1.5 max-w-[78ch] text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">{desc}</p>

          {steps && steps.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {steps.map((s, i) => (
                <div key={s.label} className="flex items-center gap-1.5">
                  <span
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] ${
                      s.active
                        ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface)] font-medium text-[color:var(--wb-accent)]'
                        : 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)]'
                    }`}
                  >
                    {s.label}
                    <span className="font-semibold">{s.value}</span>
                  </span>
                  {i < steps.length - 1 && (
                    <Icon name="chevronRight" size={12} className="text-[color:var(--wb-muted)]" />
                  )}
                </div>
              ))}
            </div>
          )}

          {metrics && metrics.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
              {metrics.map((m) => (
                <span key={m.label} className="text-[11.5px] text-[color:var(--wb-muted)]">
                  {m.label}{' '}
                  <span
                    className={`font-semibold ${
                      m.tone === 'danger'
                        ? 'text-[color:var(--wb-danger)]'
                        : m.tone === 'ok'
                          ? 'text-[color:var(--wb-ok)]'
                          : 'text-[color:var(--wb-accent)]'
                    }`}
                  >
                    {m.value}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>

        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
    </section>
  )
}
