import { useState } from 'react'
import { Btn, Pill, Segmented, Select } from './ui'
import { Icon } from './Icon'
import { ProBadge } from './ProBadge'
import { usePlan } from '../lib/plan'

/**
 * 定价展示核心组件：月付 / 年付切换 + Free vs Pro 对比 + 下单流程 + 成功态。
 * 同时被定价页（整页）与定价弹层（PlanProvider 控制）复用，本身不关心「在哪展示」。
 */
export function PricingView({
  initialCycle = 'monthly',
  onClose,
  compact = false,
}: {
  initialCycle?: 'monthly' | 'annual'
  onClose?: () => void
  compact?: boolean
}) {
  const { plans, currencySymbol, providers, isPro, upgrade, billing } = usePlan()
  const [cycle, setCycle] = useState<'monthly' | 'annual'>(initialCycle)
  const [provider, setProvider] = useState('manual')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const free = plans.find((p) => p.id === 'free')
  const pro = plans.find((p) => p.id === 'pro')
  const enabledProviders = providers.filter((p) => p.enabled)

  const priceLabel = (p: any) =>
    p.id === 'free' ? '免费' : `${currencySymbol}${cycle === 'annual' ? p.price_annual : p.price_monthly}`
  const perLabel = (p: any) => (p.id === 'free' ? '' : cycle === 'annual' ? '/年' : '/月')

  const onUpgrade = async () => {
    setBusy(true)
    setError('')
    try {
      const r: any = await upgrade(cycle, provider)
      if (r?.pay_url) {
        window.open(r.pay_url, '_blank')
        setError('已打开支付页面，完成支付后将自动升级。')
      } else if (r?.ok) {
        setDone(true)
      }
    } catch (e: any) {
      setError(String(e?.message || e || '升级失败'))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]">
          <Icon name="check" size={22} />
        </span>
        <div className="text-[15px] font-semibold text-[color:var(--wb-text)]">已升级到 Pro 会员 🎉</div>
        <div className="max-w-[42ch] text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
          无限 AI 额度、高级推理模型、无限画布节点与优先支持已全部解锁。
          {billing?.plan_expires_at ? ` 会员有效期至 ${billing.plan_expires_at.slice(0, 10)}。` : ''}
        </div>
        <Btn variant="primary" onClick={onClose}>
          开始使用 Pro
        </Btn>
      </div>
    )
  }

  if (isPro) {
    return (
      <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
        <ProBadge />
        <div className="text-[15px] font-semibold text-[color:var(--wb-text)]">你已是 Pro 会员</div>
        <div className="max-w-[42ch] text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
          {billing?.plan_expires_at
            ? `会员有效期至 ${billing.plan_expires_at.slice(0, 10)}。`
            : '所有 Pro 权益已解锁。'}
          如需管理订阅或续费，请在「设置 → 会员」中操作。
        </div>
        <Btn variant="primary" onClick={onClose}>
          好的
        </Btn>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">选择套餐</div>
        <Segmented
          value={cycle}
          onChange={setCycle}
          options={[
            { value: 'monthly', label: '月付' },
            { value: 'annual', label: `年付 ${currencySymbol}${pro?.price_annual} · 省约 17%` },
          ]}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* 免费版 */}
        <div className="flex flex-col rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-4">
          <div className="flex items-center justify-between">
            <span className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">{free?.name}</span>
            <Pill tone="gray">当前</Pill>
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-[26px] font-semibold tracking-[-0.03em] text-[color:var(--wb-text)]">免费</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{free?.tagline}</p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {(free?.features || []).map((f: string, i: number) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-[color:var(--wb-text-soft)]">
                <Icon name="check" size={13} className="mt-[2px] shrink-0 text-[color:var(--wb-muted)]" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Pro 版 */}
        <div className="relative flex flex-col rounded-[var(--wb-radius-lg)] border-2 border-[color:var(--wb-pro)] bg-[color:var(--wb-surface)] p-4 shadow-[var(--wb-shadow-md)]">
          <div className="absolute -top-2.5 left-4">
            <ProBadge />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">{pro?.name}</span>
            {cycle === 'annual' && <Pill tone="amber">年付更省</Pill>}
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-[26px] font-semibold tracking-[-0.03em] text-[color:var(--wb-pro-strong)]">
              {priceLabel(pro)}
            </span>
            <span className="text-[12px] text-[color:var(--wb-muted)]">{perLabel(pro)}</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{pro?.tagline}</p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {(pro?.features || []).map((f: string, i: number) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-[color:var(--wb-text-soft)]">
                <Icon name="check" size={13} className="mt-[2px] shrink-0 text-[color:var(--wb-pro)]" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {enabledProviders.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-[color:var(--wb-text-soft)]">支付方式</span>
          <Select
            value={provider}
            onChange={setProvider}
            options={providers.map((p: any) => ({
              value: p.key,
              label: p.enabled ? p.name : `${p.name}（未配置）`,
            }))}
          />
          <span className="text-[11px] text-[color:var(--wb-muted)]">
            {providers.find((p: any) => p.key === provider)?.desc}
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-[10px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-3 py-2 text-[12px] text-[color:var(--wb-danger)]">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {onClose && (
          <Btn onClick={onClose} variant="ghost">
            稍后再说
          </Btn>
        )}
        <Btn variant="primary" loading={busy} onClick={onUpgrade} disabled={enabledProviders.length === 0}>
          <Icon name="crown" size={13} />
          升级到 Pro
        </Btn>
      </div>
      {!compact && (
        <p className="text-center text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
          演示环境使用「本地模拟支付」，点击即升级，不产生任何真实扣费。接入 Stripe / 微信 / 支付宝 密钥后即为真实支付。
        </p>
      )}
    </div>
  )
}
