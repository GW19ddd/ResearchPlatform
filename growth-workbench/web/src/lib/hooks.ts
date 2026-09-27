import { useCallback, useEffect, useRef, useState } from 'react'
import { api, newIdemKey } from './api'
import { toast } from '../components/toast'
import { aiErrorOf, AiErrorInfo } from '../components/AiError'

/**
 * 数据请求的状态机：loading / error / data + reload。
 *
 * 之前每个页面都手写一遍 useState + try/catch + 重新拉取，
 * 复制了十几份还各漏一半错误处理。这里收敛成一处。
 */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(!!path)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(async () => {
    if (!path) {
      setData(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<T>(path)
      if (alive.current) setData(res)
    } catch (e: any) {
      if (alive.current) setError(e?.message || '加载失败')
    } finally {
      if (alive.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps])

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload])

  return { data, loading, error, reload, setData }
}

/**
 * 写操作的统一包装：自动 loading、自动报错 toast、成功后回调刷新。
 * 页面里就只剩「点一下 → 调 action()」，不再满屏 try/catch。
 */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(
    async (
      fn: () => Promise<unknown>,
      opts: { ok?: string; silent?: boolean; after?: () => void } = {},
    ) => {
      setBusy(true)
      try {
        await fn()
        if (alive.current && opts.ok) toast(opts.ok, 'ok')
        if (alive.current) opts.after?.()
        return true
      } catch (e: any) {
        if (alive.current && !opts.silent) toast(e?.message || '操作失败', 'error')
        return false
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [],
  )

  return { busy, run }
}

/**
 * 一次 AI 调用的完整状态机：idle → running → ok / error。
 *
 * 关键约定：**失败不清空调用方的输入**。用户填了十分钟的研究方向，
 * 因为没配 API Key 失败一次就被清掉，是最劝退的一种设计。
 */
export type AiState = 'idle' | 'running' | 'ok' | 'error'

export function useAiTask<T = any>() {
  const [state, setState] = useState<AiState>('idle')
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<AiErrorInfo | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(async (fn: () => Promise<T>, opts: { ok?: string } = {}) => {
    setState('running')
    setError(null)
    try {
      const res = await fn()
      // 后端信封里 ok===false 也算失败：成功提示只在真的成功时弹
      if (!alive.current) return res
      const failed = (res as any)?.ok === false
      if (failed) {
        setState('error')
        setError(aiErrorOf(res))
        setData(null)
        return res
      }
      setData(res)
      setState('ok')
      if (opts.ok) toast(opts.ok, 'ok')
      return res
    } catch (e: any) {
      if (alive.current) {
        setState('error')
        setError(aiErrorOf(null, e?.message || '调用失败'))
      }
      return null as unknown as T
    }
  }, [])

  const reset = useCallback(() => {
    setState('idle')
    setData(null)
    setError(null)
  }, [])

  return { state, data, error, run, reset, busy: state === 'running' }
}

/** 一次「提交」专用的幂等键：成功后 reset() 拿新 key，下次提交才会再写一条 */
export function useIdemKey() {
  const [key, setKey] = useState(() => newIdemKey())
  const reset = useCallback(() => setKey(newIdemKey()), [])
  return { key, reset }
}

/** 受控弹层开关：open / show / hide / toggle，省掉重复的 useState(true/false) */
export function useToggle(initial = false) {
  const [open, setOpen] = useState(initial)
  const show = useCallback(() => setOpen(true), [])
  const hide = useCallback(() => setOpen(false), [])
  const toggle = useCallback(() => setOpen((v) => !v), [])
  return { open, show, hide, toggle, setOpen }
}
