import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../components/ui'
import { Icon } from '../components/Icon'
import { PricingView } from '../components/PricingView'

/** 定价页：整页展示 Free / Pro 与下单流程。顶栏的「升级 Pro」按钮与设置页都跳到这里。 */
export default function Pricing() {
  const nav = useNavigate()
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-5">
      <PageHeader
        desc="免费版即可完整体验科研流水线；升级 Pro 解锁无限 AI 额度、高级推理模型与无限画布节点。"
        actions={
          <button
            type="button"
            onClick={() => nav('/')}
            className="wb-press-soft flex items-center gap-1 rounded-[10px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-3 py-[7px] text-[12.5px] text-[color:var(--wb-text-soft)] hover:text-[color:var(--wb-text)]"
          >
            <Icon name="chevronLeft" size={13} />
            返回工作台
          </button>
        }
      />
      <div className="mt-3 rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-5 shadow-[var(--wb-shadow-xs)]">
        <PricingView compact />
      </div>
    </div>
  )
}
