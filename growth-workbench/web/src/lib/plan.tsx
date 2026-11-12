import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { get, post } from './api'
import { Modal } from '../components/ui'
import { PricingView } from '../components/PricingView'

type Plan = {
  id: string
  name: string
  price_monthly: number
  price_annual: number
  tagline: string
  features: string[]
  ai_credits_monthly: number | null
  advanced_models: boolean
  unlimited_canvas: boolean
  priority_support: boolean
  highlight?: boolean
}

type BillingState = {
  plan: string
  is_pro: boolean
  plan_expires_at: string | null
  plan_provider: string | null
  ai_credits_limit: number | null
  ai_credits_used: number
  ai_credits_remaining: number | null
  features: Record<string, boolean>
}

type ProviderMeta = { key: string; name: string; desc: string; kind: string; enabled: boolean }

type PlanCtx = {
  plans: Plan[]
  currency: string
  currencySymbol: string
  providers: ProviderMeta[]
  billing: BillingState | null
  isPro: boolean
  loading: boolean
  refresh: () => Promise<void>
  openPricing: (opts?: { cycle?: 'monthly' | 'annual' }) => void
  closePricing: () => void
  upgrade: (cycle: 'monthly' | 'annual', provider: string) => Promise<any>
  cancel: () => Promise<void>
}

const Ctx = createContext<PlanCtx | null>(null)

/**
 * 全站会员上下文：拉取套餐目录与当前会员状态，统一暴露 isPro / 额度 / 升级 / 取消，
 * 并内置一个定价弹层（openPricing 任意组件可唤起）。
 *
 * 设计：会员状态只读地从后端 /billing/state 计算，前端不自己算价格或额度，
 * 保证免费/Pro 的门禁口径与后端一致。
 */
export function PlanProvider({ children }: { children: ReactNode }) {
  const [plans, setPlans] = useState<Plan[]>([])
  const [currency, setCurrency] = useState('CNY')
  const [currencySymbol, setCurrencySymbol] = useState('¥')
  const [providers, setProviders] = useState<ProviderMeta[]>([])
  const [billing, setBilling] = useState<BillingState | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [initialCycle, setInitialCycle] = useState<'monthly' | 'annual'>('monthly')

  const loadPlans = useCallback(async () => {
    try {
      const p: any = await get('/billing/plans')
      setPlans(p.plans || [])
      setCurrency(p.currency || 'CNY')
      setCurrencySymbol(p.currency_symbol || '¥')
      setProviders(p.providers || [])
    } catch {
      /* 后端没起来不阻塞首屏 */
    }
  }, [])

  const loadState = useCallback(async () => {
    try {
      const s: any = await get('/billing/state')
      setBilling(s)
    } catch {
      /* 未登录 / 网络异常：保持 null，isPro=false */
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadPlans(), loadState()]).finally(() => setLoading(false))
  }, [loadPlans, loadState])

  const refresh = useCallback(async () => {
    await loadState()
  }, [loadState])

  const openPricing = useCallback((opts?: { cycle?: 'monthly' | 'annual' }) => {
    if (opts?.cycle) setInitialCycle(opts.cycle)
    setOpen(true)
  }, [])

  const closePricing = useCallback(() => setOpen(false), [])

  const upgrade = useCallback(
    async (cycle: 'monthly' | 'annual', provider: string) => {
      // 下单：演示 Provider（manual）直接走 confirm 模拟支付；真实网关返回 pay_url 跳转。
      const r: any = await post('/billing/checkout', { cycle, provider }, { silent: true })
      if (r.manual) {
        const c: any = await post('/billing/confirm', { order_id: r.order_id }, { silent: true })
        await refresh()
        return { ok: true, manual: true, state: c?.state }
      }
      await refresh()
      return { ok: false, pay_url: r.pay_url }
    },
    [refresh],
  )

  const cancel = useCallback(async () => {
    await post('/billing/cancel', {}, { ok: '已退回免费版' })
    await refresh()
  }, [refresh])

  const value = useMemo<PlanCtx>(
    () => ({
      plans,
      currency,
      currencySymbol,
      providers,
      billing,
      isPro: !!billing?.is_pro,
      loading,
      refresh,
      openPricing,
      closePricing,
      upgrade,
      cancel,
    }),
    [plans, currency, currencySymbol, providers, billing, loading, refresh, openPricing, closePricing, upgrade, cancel],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal open={open} onClose={closePricing} title="升级到 Pro" width="max-w-2xl">
        <PricingView initialCycle={initialCycle} onClose={closePricing} compact />
      </Modal>
    </Ctx.Provider>
  )
}

export function usePlan(): PlanCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePlan 必须在 PlanProvider 内使用')
  return v
}
