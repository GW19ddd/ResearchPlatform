import { FormEvent, ReactNode, useState } from 'react'
import { Avatar, Btn, Card, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { displayNameOf, useAuth } from '../../lib/auth'
import { post } from '../../lib/api'

/** 账户与安全：本机单用户，能改显示名（头像菜单）/ 改密码 / 退出。 */
export default function AccountCard() {
  const { user, logout } = useAuth()
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setMsg(null)
    if (!oldPwd) return setMsg({ tone: 'error', text: '请先输入原密码' })
    if (newPwd.length < 6) return setMsg({ tone: 'error', text: '新密码至少 6 位' })
    if (newPwd !== confirm) return setMsg({ tone: 'error', text: '两次输入的新密码不一致' })
    setBusy(true)
    try {
      // 自己显示结果，不走 api 层的默认 toast
      await post('/auth/password', { old_password: oldPwd, new_password: newPwd }, { silent: true })
      setMsg({ tone: 'ok', text: '密码已更新，其它设备上的登录已失效' })
      setOldPwd('')
      setNewPwd('')
      setConfirm('')
    } catch (err: any) {
      setMsg({ tone: 'error', text: String(err?.message || err || '修改失败') })
    } finally {
      setBusy(false)
    }
  }

  if (!user) return null
  const name = displayNameOf(user)

  return (
    <Card title="账户与安全" extra={<PillLike>本机单用户</PillLike>}>
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-8">
        <div className="flex shrink-0 items-center gap-3 md:w-56">
          <Avatar name={name} hue={user.avatar_hue} size={40} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[color:var(--wb-text)]">{name}</div>
            <div className="truncate text-[11.5px] text-[color:var(--wb-muted)]">@{user.username}</div>
            <div className="mt-0.5 text-[11px] text-[color:var(--wb-muted)]">
              点头像可改称呼与颜色
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="min-w-0 flex-1">
          <div className="mb-2.5 text-[12.5px] font-medium text-[color:var(--wb-text)]">修改密码</div>
          <div className="grid gap-2.5 sm:grid-cols-3">
            <Input type="password" value={oldPwd} onChange={setOldPwd} placeholder="原密码" autoComplete="current-password" />
            <Input type="password" value={newPwd} onChange={setNewPwd} placeholder="新密码（≥6 位）" autoComplete="new-password" />
            <Input type="password" value={confirm} onChange={setConfirm} placeholder="再输一次" autoComplete="new-password" />
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Btn type="submit" variant="primary" loading={busy} disabled={!oldPwd || !newPwd || !confirm}>
              更新密码
            </Btn>
            <Btn onClick={logout}>
              <Icon name="logout" size={13} />
              退出登录
            </Btn>
            {msg && (
              <span
                role="status"
                className={`text-[12px] ${
                  msg.tone === 'ok' ? 'text-[color:var(--wb-ok)]' : 'text-[color:var(--wb-danger)]'
                }`}
              >
                {msg.text}
              </span>
            )}
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
            密码以 PBKDF2-SHA256 加盐保存在本机 SQLite，忘记密码可在 server 目录运行{' '}
            <code className="rounded bg-[color:var(--wb-bg-subtle)] px-1 py-[1px]">python auth.py --reset</code>{' '}
            清空账户后重新创建，科研数据不受影响。
          </div>
        </form>
      </div>
    </Card>
  )
}

function PillLike({ children }: { children: ReactNode }) {
  return <span className="text-[11.5px] text-[color:var(--wb-muted)]">{children}</span>
}
