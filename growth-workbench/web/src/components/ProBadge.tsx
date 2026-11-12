import { Icon } from './Icon'

/** Pro 金色徽章：标在档位、功能、页面标题上，统一会员视觉语言。 */
export function ProBadge({
  size = 'md',
  label = 'Pro',
  className = '',
}: {
  size?: 'sm' | 'md'
  label?: string
  className?: string
}) {
  const pad = size === 'sm' ? 'px-1.5 py-[0.5px] text-[10px]' : 'px-2 py-[1px] text-[11.5px]'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-[color:var(--wb-pro)]/35 bg-[color:var(--wb-pro-soft)] font-semibold leading-[18px] text-[color:var(--wb-pro-strong)] ${pad} ${className}`}
    >
      <Icon name="crown" size={size === 'sm' ? 10 : 12} className="text-[color:var(--wb-pro)]" />
      {label}
    </span>
  )
}
