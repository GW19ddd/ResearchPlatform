import { FormEvent, ReactNode, useEffect, useState } from 'react'
import { Icon, IconName } from '../components/Icon'
import { Spinner } from '../components/ui'
import { useAuth } from '../lib/auth'

/* ============================================================
   登录 / 首次创建账户

   没有注册流程、没有找回密码邮件 —— 这是跑在本机的单用户工作台。
   第一次打开是「创建账户」，之后每次打开是「解锁」。
   ============================================================ */

const HIGHLIGHTS: { icon: IconName; title: string; desc: string }[] = [
  { icon: 'sparkle', title: '从想法到实验', desc: '创新点打分、文献矩阵、实验记录，一条线串起来' },
  { icon: 'file', title: '论文阶段流水线', desc: '卡住超过三天会亮红灯，不用靠记性' },
  { icon: 'star', title: '正反馈不断线', desc: '打卡与推进换积分，积分换你真正想要的奖励' },
]

function AuthField({
  icon,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoFocus,
  autoComplete,
  trailing,
  hint,
}: {
  icon: IconName
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  autoFocus?: boolean
  autoComplete?: string
  trailing?: ReactNode
  hint?: ReactNode
}) {
  const [focused, setFocused] = useState(false)
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-[color:var(--wb-text-soft)]">{label}</span>
        {hint && <span className="text-[11px] text-[color:var(--wb-muted)]">{hint}</span>}
      </span>
      <span
        className={`flex items-center gap-2 rounded-[12px] border bg-[color:var(--wb-surface)] px-3 transition-[border-color,box-shadow] duration-150 ${
          focused
            ? 'border-[color:var(--wb-accent)] shadow-[var(--wb-ring)]'
            : 'border-[color:var(--wb-border-strong)] hover:border-[color:var(--wb-text-soft)]/40'
        }`}
      >
        <Icon name={icon} size={15} className="shrink-0 text-[color:var(--wb-muted)]" />
        <input
          type={type}
          value={value}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="min-w-0 flex-1 bg-transparent py-[11px] text-[13.5px] text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
        />
        {trailing}
      </span>
    </label>
  )
}

export default function Login() {
  const { hasUser, login, setup } = useAuth()
  const [mode, setMode] = useState<'login' | 'setup'>(hasUser ? 'login' : 'setup')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 登录态回来后才知道该显示哪一种，避免先闪一下「创建账户」
  useEffect(() => {
    setMode(hasUser ? 'login' : 'setup')
  }, [hasUser])

  const isSetup = mode === 'setup'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError('')
    if (!username.trim()) return setError('请填写账号')
    if (!password) return setError('请填写密码')
    if (isSetup && password.length < 6) return setError('密码至少 6 位')
    setBusy(true)
    try {
      if (isSetup) await setup(username.trim(), password, displayName.trim())
      else await login(username.trim(), password)
    } catch (err: any) {
      setError(String(err?.message || err || '登录失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wb-auth-bg relative flex min-h-full items-center justify-center overflow-hidden px-5 py-10">
      {/* 两团缓慢漂移的光：给纯白背景一点呼吸，不抢文字 */}
      <div
        aria-hidden
        className="wb-anim-drift pointer-events-none absolute -left-24 top-10 h-[380px] w-[380px] rounded-full bg-[radial-gradient(circle,rgba(81,69,224,0.18),transparent_65%)] blur-2xl"
      />
      <div
        aria-hidden
        className="wb-anim-drift pointer-events-none absolute -right-24 bottom-0 h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,rgba(20,97,143,0.16),transparent_65%)] blur-2xl"
        style={{ animationDelay: '-6s' }}
      />

      <div className="relative grid w-full max-w-[1040px] items-center gap-14 lg:grid-cols-[1.05fr_420px]">
        {/* ---------- 左：品牌与主张 ---------- */}
        <div className="hidden lg:block">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-[13px] bg-gradient-to-br from-[color:var(--wb-accent)] to-[color:var(--wb-accent-strong)] text-[15px] font-bold text-white shadow-[0_6px_18px_-6px_rgba(64,52,196,0.55)]">
              研
            </div>
            <div>
              <div className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">科研工作台</div>
              <div className="text-[11px] text-[color:var(--wb-muted)]">Research Workbench</div>
            </div>
          </div>

          <h2 className="mt-12 text-[40px] font-semibold leading-[1.16] tracking-[-0.035em] text-[color:var(--wb-text)]">
            让每一个想法
            <br />
            都有下一步。
          </h2>
          <p className="mt-4 max-w-[36ch] text-[13.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
            创新点、文献、实验、论文，加上计划复盘与导师承诺 —— 一条贴着科研主线的流水线，而不是又一个待办清单。
          </p>

          <ul className="mt-9 flex flex-col gap-3.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h.title} className="flex items-start gap-3">
                <span className="mt-[1px] flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-accent)] shadow-[var(--wb-shadow-xs)]">
                  <Icon name={h.icon} size={15} />
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-[color:var(--wb-text)]">{h.title}</div>
                  <div className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{h.desc}</div>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-10 flex items-center gap-2 text-[11px] text-[color:var(--wb-muted)]">
            <Icon name="shield" size={13} />
            数据只存本机 SQLite · 可导出 Markdown / CSV · 无云端同步
          </div>
        </div>

        {/* ---------- 右：表单 ---------- */}
        <div className="mx-auto w-full max-w-[420px]">
          {/* 窄屏时把品牌挪到卡片上方 */}
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-[12px] bg-gradient-to-br from-[color:var(--wb-accent)] to-[color:var(--wb-accent-strong)] text-[13px] font-bold text-white">
              研
            </div>
            <div className="text-[13px] font-semibold text-[color:var(--wb-text)]">科研工作台</div>
          </div>

          <form
            onSubmit={submit}
            className="rounded-[24px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-7 shadow-[var(--wb-shadow-lg)] sm:p-8"
          >
            <div className="mb-6">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-1 text-[10.5px] font-medium tracking-[0.04em] text-[color:var(--wb-muted)]">
                <span className="h-[5px] w-[5px] rounded-full bg-[color:var(--wb-ok)]" />
                {isSetup ? '首次使用 · 本机初始化' : '本机账户 · 已锁定'}
              </div>
              <h1 className="mt-3 text-[24px] font-semibold tracking-[-0.028em] text-[color:var(--wb-text)]">
                {isSetup ? '创建你的工作台' : '欢迎回来'}
              </h1>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[color:var(--wb-muted)]">
                {isSetup
                  ? '设置一个账号和密码，之后每次打开都要先解锁。密码只保存在这台电脑上。'
                  : '输入账号密码继续。同一台电脑上的会话会保持 30 天。'}
              </p>
            </div>

            <div className="flex flex-col gap-3.5">
              <AuthField
                icon="user"
                label="账号"
                value={username}
                onChange={setUsername}
                placeholder={isSetup ? '例如 amber' : '你的账号'}
                autoComplete="username"
                autoFocus
              />
              <AuthField
                icon="lock"
                label="密码"
                value={password}
                onChange={setPassword}
                type={showPwd ? 'text' : 'password'}
                placeholder={isSetup ? '至少 6 位' : '输入密码'}
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPwd((v) => !v)}
                    aria-label={showPwd ? '隐藏密码' : '显示密码'}
                    className="flex h-7 w-7 items-center justify-center rounded-[7px] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                  >
                    <Icon name={showPwd ? 'eyeOff' : 'eye'} size={14} />
                  </button>
                }
              />
              {isSetup && (
                <AuthField
                  icon="sparkle"
                  label="称呼"
                  value={displayName}
                  onChange={setDisplayName}
                  placeholder="头像上会显示首字，可留空"
                  hint="可选"
                />
              )}
            </div>

            {error && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-[10px] border border-[color:var(--wb-danger)]/25 bg-[color:var(--wb-danger-soft)] px-3 py-2.5 text-[12px] leading-relaxed text-[color:var(--wb-danger)]"
              >
                <Icon name="alert" size={13} className="mt-[2px]" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="mt-5 flex h-[44px] w-full items-center justify-center gap-2 rounded-[12px] bg-[color:var(--wb-accent)] text-[13.5px] font-medium text-white shadow-[0_8px_20px_-10px_rgba(64,52,196,0.75)] transition-all duration-150 hover:bg-[color:var(--wb-accent-strong)] active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? <Spinner /> : null}
              {isSetup ? '创建并进入' : '进入工作台'}
              {!busy && <Icon name="arrowRight" size={15} />}
            </button>

            {hasUser && (
              <div className="mt-5 border-t border-[color:var(--wb-border)] pt-4 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
                忘记密码？在 <code className="rounded bg-[color:var(--wb-bg-subtle)] px-1 py-[1px]">server</code>{' '}
                目录运行 <code className="rounded bg-[color:var(--wb-bg-subtle)] px-1 py-[1px]">python auth.py --reset</code>{' '}
                清空账户后可重新创建。数据不会丢。
              </div>
            )}
          </form>

          <div className="mt-4 text-center text-[11px] text-[color:var(--wb-muted)]">
            本地应用 · 不上传任何内容到第三方服务器
          </div>
        </div>
      </div>
    </div>
  )
}
