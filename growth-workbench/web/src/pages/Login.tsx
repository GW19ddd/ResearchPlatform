import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react'
import { Icon, IconName } from '../components/Icon'
import { Spinner } from '../components/ui'
import { get } from '../lib/api'
import { CloudPending, useAuth } from '../lib/auth'
import { cloud, cloudErrText, wechatRedirectTo } from '../lib/cloudAuth'

/* ============================================================
   登录 / 注册

   账户体系在云端（WorkBuddy 云服务 Auth）：手机验证码 / 邮箱密码 / 微信扫码，
   三种方式共用一个云端身份。本机后端只负责把云端会话换成工作台会话，
   密码、验证码、openid 都不落本机。

   另有「本机账户」兜底：老用户原来创建的本地账户仍可登录，
   数据在那台机器上，不联网也能进。
   ============================================================ */

const HIGHLIGHTS: { icon: IconName; title: string; desc: string }[] = [
  { icon: 'sparkle', title: '从想法到实验', desc: '创新点打分、文献矩阵、实验记录，一条线串起来' },
  { icon: 'file', title: '论文阶段流水线', desc: '卡住超过三天会亮红灯，不用靠记性' },
  { icon: 'star', title: '正反馈不断线', desc: '打卡与推进换积分，积分换你真正想要的奖励' },
]

type Tab = 'code' | 'password' | 'wechat'

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
  inputMode,
  maxLength,
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
  inputMode?: 'text' | 'numeric' | 'email'
  maxLength?: number
}) {
  const [focused, setFocused] = useState(false)
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-[color:var(--wb-text-soft)]">{label}</span>
        {hint && <span className="text-[11px] text-[color:var(--wb-muted)]">{hint}</span>}
      </span>
      <span
        className={`flex items-center gap-2 rounded-[12px] border bg-[color:var(--wb-surface)] px-3 transition-[border-color] duration-150 ${
          focused
            ? 'border-[color:var(--wb-accent)]'
            : 'border-[color:var(--wb-border-strong)] hover:border-[color:var(--wb-text-soft)]/40'
        }`}
      >
        <Icon name={icon} size={15} className="shrink-0 text-[color:var(--wb-muted)]" />
        <input
          type={type}
          value={value}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          inputMode={inputMode}
          maxLength={maxLength}
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

const TABS: { id: Tab; label: string }[] = [
  { id: 'code', label: '验证码登录' },
  { id: 'password', label: '密码登录' },
  { id: 'wechat', label: '微信登录' },
]

const isEmail = (v: string) => v.includes('@')

/** 云端 auth 的结果统一是 { data, error }；有 error 就抛，调用方只管 try/catch */
function unwrap<T>(r: { data: T; error: any }): T {
  if (r?.error) throw r.error
  return r.data
}

export default function Login() {
  const { hasUser, login, setup, cloudExchange } = useAuth()
  const [tab, setTab] = useState<Tab>('code')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // 账号密码
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)

  // 验证码
  const [dest, setDest] = useState('')
  const [code, setCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [signupPwd, setSignupPwd] = useState('')
  const [needPwd, setNeedPwd] = useState(false)

  // 发送验证码的结果留在组件状态里，提交时必须复用它，不能重新发一次
  const [challenge, setChallenge] = useState<{
    id: string
    isExisting: boolean
    to: string
  } | null>(null)

  // 首次云端登录、还没关到本机账户
  const [pending, setPending] = useState<{ token: string; info: CloudPending } | null>(null)
  const [linkUserId, setLinkUserId] = useState('')
  const [localUsers, setLocalUsers] = useState<{ id: number; username: string; display_name: string }[]>([])

  useEffect(() => {
    // 扫码回跳时 AuthProvider 已经把结果放进 sessionStorage
    const raw = sessionStorage.getItem('wb:cloud-pending')
    if (!raw) return
    sessionStorage.removeItem('wb:cloud-pending')
    try {
      const j = JSON.parse(raw)
      if (j?.token) setPending({ token: String(j.token), info: j })
    } catch {
      /* 坏数据直接忽略 */
    }
  }, [])

  useEffect(() => {
    if (!countdown) return
    const t = window.setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => window.clearTimeout(t)
  }, [countdown])

  const linkable = pending?.info?.linkable ?? false
  useEffect(() => {
    if (!linkable) return
    get('/auth/cloud/local-users')
      .then((r: any) => setLocalUsers(Array.isArray(r?.users) ? r.users : []))
      .catch(() => setLocalUsers([]))
  }, [linkable])

  /** 拿云端会话换本机会话；后端回 needs_binding 就停在「选择数据归属」 */
  const exchange = useCallback(
    async (access: string, mode: 'auto' | 'link' | 'create' = 'auto', uid?: number) => {
      const need = await cloudExchange(access, mode, uid)
      if (need) setPending({ token: access, info: need })
      return need
    },
    [cloudExchange],
  )

  const accessToken = async (): Promise<string> => {
    // getAccessToken 是唯一不走 {data,error} 信封的方法：直接回 token 字符串
    const s = String((await cloud.auth.getAccessToken()) || '')
    if (!s) throw new Error('拿不到云端登录凭证，请重试')
    return s
  }

  const run = async (fn: () => Promise<void>) => {
    setError('')
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setError(cloudErrText(e))
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- 验证码
  const sendCode = () =>
    run(async () => {
      setNotice('')
      const to = dest.trim()
      if (!to) throw new Error('请填写手机号或邮箱')
      if (!isEmail(to) && !/^1\d{10}$/.test(to)) throw new Error('请输入正确的 11 位手机号')
      const sent = unwrap(await cloud.auth.sendOtp(isEmail(to) ? { email: to } : { phone: to })) as any
      setChallenge({
        id: String(sent?.verificationId || ''),
        isExisting: !!sent?.isExistingUser,
        to,
      })
      setNeedPwd(!sent?.isExistingUser)
      setCountdown(60)
      setNotice('验证码已发送')
    })

  const submitCode = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      const to = dest.trim()
      if (!challenge || challenge.to !== to) throw new Error('请先获取验证码')
      if (!/^\d{4,8}$/.test(code.trim())) throw new Error('请输入验证码')
      if (needPwd && signupPwd.length < 6) throw new Error('新账户需设置至少 6 位密码')

      unwrap(
        await cloud.auth.verifyOtp({
          ...(isEmail(to) ? { email: to } : { phone: to }),
          verificationId: challenge.id,
          isExistingUser: challenge.isExisting,
          token: code.trim(),
          password: challenge.isExisting ? undefined : signupPwd,
        }),
      )
      setChallenge(null)
      await exchange(await accessToken(), 'auto')
    })
  }

  // ---------------------------------------------------------------- 邮箱密码
  const submitPassword = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      if (!isEmail(email)) throw new Error('请输入邮箱地址')
      if (!password) throw new Error('请填写密码')
      try {
        unwrap(await cloud.auth.signInWithPassword({ email: email.trim(), password }))
      } catch {
        // 不区分「账号不存在」和「密码错」
        throw new Error('账号或密码不正确')
      }
      await exchange(await accessToken(), 'auto')
    })
  }

  // ---------------------------------------------------------------- 微信
  const startWechat = () =>
    run(async () => {
      const r = unwrap(
        await cloud.auth.signInWithOAuth({ provider: 'wechat', redirectTo: wechatRedirectTo() }),
      ) as any
      if (!r?.url) throw new Error('微信登录地址获取失败')
      location.assign(r.url)
    })

  // ================================================================ 绑定策略
  if (pending) {
    const info = pending.info
    const who = info.cloud_email || info.cloud_phone || '这个云端账号'
    return (
      <div className="wb-auth-bg relative flex min-h-full items-center justify-center px-5 py-10">
        <div className="w-full max-w-[460px] rounded-[24px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-7 shadow-[var(--wb-shadow-lg)] sm:p-8">
          <div className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-1 text-[10.5px] font-medium text-[color:var(--wb-muted)]">
            <span className="h-[5px] w-[5px] rounded-full bg-[color:var(--wb-ok)]" />
            云端账号已验证
          </div>
          <h1 className="mt-3 text-[21px] font-semibold tracking-[-0.02em] text-[color:var(--wb-text)]">
            选择数据归属
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-[color:var(--wb-muted)]">
            {who} 还没有和这台电脑上的工作台关联。关联后云端账号就能直接打开原有数据。
          </p>

          {info.linkable && (
            <div className="mt-5 rounded-[14px] border border-[color:var(--wb-border)] p-3.5">
              <div className="text-[12px] font-medium text-[color:var(--wb-text)]">关联本机已有账户</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
                保留这台电脑上已有的实验、文献与积分，以后用云端账号登录即可。
              </div>
              <div className="mt-2.5 flex gap-2">
                <select
                  value={linkUserId}
                  onChange={(e) => setLinkUserId(e.target.value)}
                  className="min-w-0 flex-1 rounded-[10px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-2.5 py-2 text-[12.5px] text-[color:var(--wb-text)] outline-none"
                >
                  <option value="">选择一个账户</option>
                  {localUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name || u.username}（{u.username}）
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy || !linkUserId}
                  onClick={() => run(async () => void (await exchange(pending.token, 'link', Number(linkUserId))))}
                  className="shrink-0 rounded-[10px] bg-[color:var(--wb-accent)] px-3.5 text-[12.5px] font-medium text-white disabled:opacity-50"
                >
                  关联并进入
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => run(async () => void (await exchange(pending.token, 'create')))}
            className="mt-3 flex h-[42px] w-full items-center justify-center gap-2 rounded-[12px] border border-[color:var(--wb-border-strong)] text-[12.5px] font-medium text-[color:var(--wb-text)] transition hover:bg-[color:var(--wb-bg-subtle)] disabled:opacity-50"
          >
            {busy ? <Spinner /> : <Icon name="plus" size={14} />}
            新建空白工作台
          </button>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-[color:var(--wb-danger)]/25 bg-[color:var(--wb-danger-soft)] px-3 py-2.5 text-[12px] text-[color:var(--wb-danger)]">
              <Icon name="alert" size={13} className="mt-[2px]" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setPending(null)
              setError('')
            }}
            className="mt-4 w-full text-center text-[11.5px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]"
          >
            换一个账号登录
          </button>
        </div>
      </div>
    )
  }

  // ================================================================ 主登录
  return (
    <div className="wb-auth-bg relative flex min-h-full items-center justify-center overflow-hidden px-5 py-10">
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
              <div className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">研流</div>
              <div className="text-[11px] text-[color:var(--wb-muted)]">科研一站式工作台</div>
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
            云端账户 · 数据存本机 SQLite · 可导出 Markdown / CSV
          </div>
        </div>

        {/* ---------- 右：表单 ---------- */}
        <div className="mx-auto w-full max-w-[420px]">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-[12px] bg-gradient-to-br from-[color:var(--wb-accent)] to-[color:var(--wb-accent-strong)] text-[13px] font-bold text-white">
              研
            </div>
            <div className="text-[13px] font-semibold text-[color:var(--wb-text)]">研流</div>
          </div>

          <div className="rounded-[24px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-7 shadow-[var(--wb-shadow-lg)] sm:p-8">
            <div className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-1 text-[10.5px] font-medium tracking-[0.04em] text-[color:var(--wb-muted)]">
              <span className="h-[5px] w-[5px] rounded-full bg-[color:var(--wb-ok)]" />
              云端账户 · 安全登录
            </div>
            <h1 className="text-[24px] font-semibold tracking-[-0.028em] text-[color:var(--wb-text)]">
              登录研流
            </h1>

            {/* tab 切换 */}
            <div className="mt-4 flex gap-1 rounded-[11px] bg-[color:var(--wb-bg-subtle)] p-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setTab(t.id)
                    setError('')
                    setNotice('')
                  }}
                  className={`flex-1 rounded-[8px] py-[7px] text-[12px] font-medium transition ${
                    tab === t.id
                      ? 'bg-[color:var(--wb-surface)] text-[color:var(--wb-text)] shadow-[var(--wb-shadow-xs)]'
                      : 'text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* ---------------- 验证码 ---------------- */}
            {tab === 'code' && (
              <form onSubmit={submitCode} className="mt-5 flex flex-col gap-3.5">
                <AuthField
                  icon="user"
                  label="手机号 / 邮箱"
                  value={dest}
                  onChange={(v) => {
                    setDest(v)
                    setError('')
                    setNotice('')
                  }}
                  placeholder="输入手机号或邮箱"
                  autoComplete="username"
                  autoFocus
                />
                <AuthField
                  icon="lock"
                  label="验证码"
                  value={code}
                  onChange={setCode}
                  placeholder="短信 / 邮件验证码"
                  inputMode="numeric"
                  maxLength={8}
                  autoComplete="one-time-code"
                  trailing={
                    <button
                      type="button"
                      onClick={sendCode}
                      disabled={busy || countdown > 0}
                      className="shrink-0 rounded-[7px] px-1.5 py-1 text-[11.5px] font-medium text-[color:var(--wb-accent)] disabled:text-[color:var(--wb-muted)]"
                    >
                      {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
                    </button>
                  }
                />
                {needPwd && (
                  <AuthField
                    icon="sparkle"
                    label="设置密码"
                    value={signupPwd}
                    onChange={setSignupPwd}
                    type="password"
                    placeholder="新账户至少 6 位"
                    autoComplete="new-password"
                    hint="首次登录"
                  />
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="mt-1 flex h-[44px] w-full items-center justify-center gap-2 rounded-[12px] bg-[color:var(--wb-accent)] text-[13.5px] font-medium text-white shadow-[0_8px_20px_-10px_rgba(64,52,196,0.75)] transition-all duration-150 hover:bg-[color:var(--wb-accent-strong)] active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? <Spinner /> : null}
                  登录 / 注册
                  {!busy && <Icon name="arrowRight" size={15} />}
                </button>
              </form>
            )}

            {/* ---------------- 密码 ---------------- */}
            {tab === 'password' && (
              <form onSubmit={submitPassword} className="mt-5 flex flex-col gap-3.5">
                <AuthField
                  icon="inbox"
                  label="邮箱"
                  value={email}
                  onChange={(v) => {
                    setEmail(v)
                    setError('')
                  }}
                  placeholder="you@example.com"
                  autoComplete="username"
                  inputMode="email"
                  autoFocus
                />
                <AuthField
                  icon="lock"
                  label="密码"
                  value={password}
                  onChange={setPassword}
                  type={showPwd ? 'text' : 'password'}
                  placeholder="输入密码"
                  autoComplete="current-password"
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
                <button
                  type="submit"
                  disabled={busy}
                  className="mt-1 flex h-[44px] w-full items-center justify-center gap-2 rounded-[12px] bg-[color:var(--wb-accent)] text-[13.5px] font-medium text-white shadow-[0_8px_20px_-10px_rgba(64,52,196,0.75)] transition-all duration-150 hover:bg-[color:var(--wb-accent-strong)] active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? <Spinner /> : null}
                  登录
                  {!busy && <Icon name="arrowRight" size={15} />}
                </button>
                <p className="text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
                  没有密码？切到「验证码登录」，首次使用验证码即注册并设置密码。
                </p>
              </form>
            )}

            {/* ---------------- 微信 ---------------- */}
            {tab === 'wechat' && (
              <div className="mt-5">
                <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[color:var(--wb-border-strong)] py-8">
                  <button
                    type="button"
                    onClick={startWechat}
                    disabled={busy}
                    className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-[#07C160] text-white transition hover:brightness-105 disabled:opacity-60"
                    aria-label="微信扫码登录"
                  >
                    {busy ? <Spinner /> : <Icon name="message" size={20} />}
                  </button>
                  <div className="text-center">
                    <div className="text-[13px] font-medium text-[color:var(--wb-text)]">微信扫码登录</div>
                    <div className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                      在微信里打开的会直接确认，其它环境自动出示二维码
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
                  微信登录需要在已发布的域名上完成回跳；本地预览若提示失败，请改用验证码登录。
                </p>
              </div>
            )}

            {notice && !error && (
              <div className="mt-4 flex items-start gap-2 rounded-[10px] border border-[color:var(--wb-ok)]/25 bg-[color:var(--wb-ok-soft)] px-3 py-2.5 text-[12px] text-[color:var(--wb-ok)]">
                <Icon name="check" size={13} className="mt-[2px]" />
                <span className="min-w-0 break-words">{notice}</span>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-[10px] border border-[color:var(--wb-danger)]/25 bg-[color:var(--wb-danger-soft)] px-3 py-2.5 text-[12px] leading-relaxed text-[color:var(--wb-danger)]"
              >
                <Icon name="alert" size={13} className="mt-[2px]" />
                <span className="min-w-0 break-words">{error}</span>
              </div>
            )}

            {/* 本机账户兜底：老数据在本机，离线也能进 */}
            <details className="mt-5 border-t border-[color:var(--wb-border)] pt-4">
              <summary className="cursor-pointer text-[11.5px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]">
                {hasUser ? '用这台电脑原有的本机账户登录' : '在这台电脑上创建一个本机账户'}
              </summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const f = e.currentTarget
                  const u = (f.elements.namedItem('lu') as HTMLInputElement).value.trim()
                  const p = (f.elements.namedItem('lp') as HTMLInputElement).value
                  return run(async () => {
                    if (!u) throw new Error('请填写账号')
                    if (hasUser) {
                      if (!p) throw new Error('请填写密码')
                      await login(u, p)
                    } else {
                      if (p.length < 6) throw new Error('密码至少 6 位')
                      await setup(u, p, u)
                    }
                  })
                }}
                className="mt-3 flex flex-col gap-2.5"
              >
                <input
                  name="lu"
                  placeholder="本机账号"
                  autoComplete="username"
                  className="rounded-[10px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-3 py-2.5 text-[13px] text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
                />
                <input
                  name="lp"
                  type="password"
                  placeholder={hasUser ? '本机密码' : '设置密码，至少 6 位'}
                  autoComplete={hasUser ? 'current-password' : 'new-password'}
                  className="rounded-[10px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-3 py-2.5 text-[13px] text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="flex h-[38px] items-center justify-center rounded-[10px] border border-[color:var(--wb-border-strong)] text-[12.5px] font-medium text-[color:var(--wb-text)] hover:bg-[color:var(--wb-bg-subtle)] disabled:opacity-50"
                >
                  {hasUser ? '进入本机工作台' : '创建并进入'}
                </button>
              </form>
            </details>
          </div>

          <div className="mt-4 text-center text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
            登录由 WorkBuddy 云服务提供 · 密码与验证码不保存在本机
          </div>
        </div>
      </div>
    </div>
  )
}
