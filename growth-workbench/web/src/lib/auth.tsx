import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { get, patch, post } from './api'
import { cloud } from './cloudAuth'

export type User = {
  id: number
  username: string
  display_name: string
  initial: string
  avatar_hue: number
  created_at?: string
  last_login_at?: string
  cloud_linked?: boolean
}

/** 云端账户还没关到本机账户时后端回的结果：交给登录页让用户选「关联」还是「新建」 */
export type CloudPending = {
  needs_binding: true
  cloud_email?: string | null
  cloud_phone?: string | null
  linkable: boolean
}

type CloudExchangeResult = { user: User } | CloudPending

type AuthValue = {
  loading: boolean
  hasUser: boolean
  user: User | null
  refresh: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  setup: (username: string, password: string, displayName: string) => Promise<void>
  logout: () => Promise<void>
  updateProfile: (body: { display_name?: string; avatar_hue?: number }) => Promise<void>
  /** 把云端 SDK 拿到的 access token 换成会话；返回 needs_binding 表示还要用户选绑定策略 */
  cloudExchange: (
    accessToken: string,
    mode?: 'auto' | 'link' | 'create',
    linkUserId?: number,
  ) => Promise<CloudPending | null>
}

const Ctx = createContext<AuthValue | null>(null)

/**
 * 登录态。
 *
 * 凭证是 HttpOnly Cookie，前端读不到也不该读 —— 所以「我是谁」永远问后端，
 * 不在 localStorage 里缓存用户信息（改了资料、换了设备都不会对不上）。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [hasUser, setHasUser] = useState(false)
  const [user, setUser] = useState<User | null>(null)

  const refresh = useCallback(async () => {
    try {
      // 扫码回跳优先兑换：code 单次有效，晚一步就被门卫撕掉页面了
      if (/[?&]code=/.test(location.search)) {
        try {
          const { data: session } = await cloud.auth.handleWechatWebCallback()
          // getAccessToken 直接回字符串，不走 {data,error} 信封
          const token = session ? String((await cloud.auth.getAccessToken()) || '') : ''
          // code/state 是单次的，成功失败都要从地址栏抹掉，否则刷新就报登录失败
          history.replaceState(null, '', location.pathname)
          if (token) {
            const need = await post(
              '/auth/cloud/exchange',
              { access_token: token, mode: 'auto' },
              { silent: true },
            )
            if ((need as any)?.needs_binding) {
              sessionStorage.setItem(
                'wb:cloud-pending',
                JSON.stringify({ token, ...(need as object) }),
              )
            }
          }
        } catch {
          history.replaceState(null, '', location.pathname)
        }
      }
      const r: any = await get('/auth/state')
      setHasUser(!!r?.has_user)
      setUser(r?.user || null)
    } catch {
      // 后端没起来时不要卡在空白页：交给具体页面展示「连接失败」
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 任意请求拿到 401（会话过期 / 服务端重置账户）→ 立刻回到登录页
  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null)
      get('/auth/state')
        .then((r: any) => setHasUser(!!r?.has_user))
        .catch(() => {})
    }
    window.addEventListener('wb:unauthorized', onUnauthorized)
    return () => window.removeEventListener('wb:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const r: any = await post('/auth/login', { username, password }, { silent: true })
    setUser(r.user)
    setHasUser(true)
  }, [])

  const setup = useCallback(async (username: string, password: string, displayName: string) => {
    const r: any = await post(
      '/auth/setup',
      { username, password, display_name: displayName || username, avatar_hue: Math.floor(Math.random() * 360) },
      { silent: true },
    )
    setUser(r.user)
    setHasUser(true)
  }, [])

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout', {}, { silent: true })
    } finally {
      setUser(null)
    }
  }, [])

  const updateProfile = useCallback(async (body: { display_name?: string; avatar_hue?: number }) => {
    const r: any = await patch('/auth/profile', body, { ok: '资料已更新' })
    setUser(r.user)
  }, [])

  const cloudExchange = useCallback(
    async (accessToken: string, mode: 'auto' | 'link' | 'create' = 'auto', linkUserId?: number) => {
      const r = (await post(
        '/auth/cloud/exchange',
        { access_token: accessToken, mode, link_user_id: linkUserId ?? null },
        { silent: true },
      )) as CloudExchangeResult
      if ((r as CloudPending)?.needs_binding) return r as CloudPending
      setUser((r as { user: User }).user)
      setHasUser(true)
      return null
    },
    [],
  )

  const value = useMemo<AuthValue>(
    () => ({
      loading,
      hasUser,
      user,
      refresh,
      login,
      setup,
      logout,
      updateProfile,
      cloudExchange,
    }),
    [
      loading,
      hasUser,
      user,
      refresh,
      login,
      setup,
      logout,
      updateProfile,
      cloudExchange,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return v
}

/** 常驻显示用的称呼：优先显示名，退回账号 */
export function displayNameOf(user: User | null): string {
  return (user?.display_name || user?.username || '').trim()
}
