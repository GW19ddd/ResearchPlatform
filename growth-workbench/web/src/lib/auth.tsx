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

export type User = {
  id: number
  username: string
  display_name: string
  initial: string
  avatar_hue: number
  created_at?: string
  last_login_at?: string
}

type AuthValue = {
  loading: boolean
  hasUser: boolean
  user: User | null
  refresh: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  setup: (username: string, password: string, displayName: string) => Promise<void>
  logout: () => Promise<void>
  updateProfile: (body: { display_name?: string; avatar_hue?: number }) => Promise<void>
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

  const value = useMemo<AuthValue>(
    () => ({ loading, hasUser, user, refresh, login, setup, logout, updateProfile }),
    [loading, hasUser, user, refresh, login, setup, logout, updateProfile],
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
