import { Btn, Card, Loading, Pill, Progress } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { ProBadge } from '../../components/ProBadge'
import { usePlan } from '../../lib/plan'

const FEATURE_ROWS: { key: string; label: string }[] = [
  { key: 'advanced-models', label: '高级推理模型' },
  { key: 'unlimited-canvas', label: '无限画布节点' },
  { key: 'priority-support', label: '优先支持 & 新功能抢先' },
]

/** 会员与订阅：当前档位、续费时间、额度用量、权益清单、升级 / 取消。 */
export default function BillingCard() {
  const { billing, isPro, openPricing, cancel, loading } = usePlan()

  if (loading || !billing) return <Card title="会员与订阅"><Loading text="加载会员状态…" /></Card>

  return (
    <Card
      title="会员与订阅"
      extra={isPro ? <ProBadge /> : <Pill tone="gray">免费版</Pill>}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[12px] text-[color:var(--wb-muted)]">当前套餐</div>
            <div className="mt-0.5 flex items-center gap-2 text-[15px] font-semibold text-[color:var(--wb-text)]">
              {isPro ? 'Pro 版' : '免费版'}
            </div>
          </div>
          {isPro && billing.plan_expires_at && (
            <div className="text-right">
              <div className="text-[12px] text-[color:var(--wb-muted)]">有效期至</div>
              <div className="text-[13px] font-medium text-[color:var(--wb-text-soft)]">
                {billing.plan_expires_at.slice(0, 10)}
              </div>
            </div>
          )}
        </div>

        {/* AI 额度用量 */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[12px]">
            <span className="text-[color:var(--wb-text-soft)]">AI 调用额度（本月）</span>
            <span className="tabular-nums text-[color:var(--wb-muted)]">
              {isPro ? '无限' : `${billing.ai_credits_used} / ${billing.ai_credits_limit} 次`}
            </span>
          </div>
          {isPro ? (
            <div className="rounded-full bg-[color:var(--wb-pro-soft)] px-3 py-1.5 text-center text-[11.5px] text-[color:var(--wb-pro-strong)]">
              Pro 会员：AI 调用无限量
            </div>
          ) : (
            <Progress value={billing.ai_credits_used} max={billing.ai_credits_limit || 1} tone="accent" />
          )}
        </div>

        {/* 权益清单 */}
        <div className="rounded-[var(--wb-radius)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] p-3">
          <div className="mb-2 text-[12px] font-medium text-[color:var(--wb-text-soft)]">权益对比</div>
          <div className="flex flex-col gap-1.5">
            {FEATURE_ROWS.map((f) => {
              const on = !!billing.features?.[f.key]
              return (
                <div key={f.key} className="flex items-center gap-2 text-[12px]">
                  <Icon
                    name={on ? 'check' : 'minus'}
                    size={13}
                    className={on ? 'text-[color:var(--wb-ok)]' : 'text-[color:var(--wb-muted)]'}
                  />
                  <span className={on ? 'text-[color:var(--wb-text)]' : 'text-[color:var(--wb-muted)]'}>
                    {f.label}
                  </span>
                  {on && <span className="ml-auto text-[11px] text-[color:var(--wb-pro-strong)]">Pro</span>}
                </div>
              )
            })}
          </div>
        </div>

        {/* 操作 */}
        <div className="flex flex-wrap items-center gap-2">
          {!isPro ? (
            <Btn variant="primary" onClick={() => openPricing()}>
              <Icon name="crown" size={13} />
              升级到 Pro
            </Btn>
          ) : (
            <>
              <Btn variant="primary" onClick={() => openPricing()}>
                管理订阅
              </Btn>
              <Btn
                variant="ghost"
                onClick={async () => {
                  if (confirm('确定要取消 Pro，退回免费版吗？（已解锁的权益将失效）')) await cancel()
                }}
              >
                取消 Pro
              </Btn>
            </>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
          演示环境使用本地模拟支付，不产生真实扣费；接入 Stripe / 微信 / 支付宝 密钥后即转为真实支付。
        </p>
      </div>
    </Card>
  )
}
