import { useEffect, useRef, useState } from 'react'

const PREFIX = 'wb:'

function serialize(v: any): string {
  return JSON.stringify(v, (_k, val) => (val instanceof Set ? { __set: Array.from(val) } : val))
}

function deserialize<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback
  try {
    const v = JSON.parse(raw, (_k, val) =>
      val && typeof val === 'object' && '__set' in val ? new Set(val.__set) : val
    )
    return (v ?? fallback) as T
  } catch {
    return fallback
  }
}

/**
 * 页面级持久化 state：切换菜单 / 刷新页面都不丢。
 * key 变化时会自动读取新 key 的值（用于按 id 分区存储的场景）。
 */
export function usePersist<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => deserialize<T>(localStorage.getItem(PREFIX + key), initial))
  const keyRef = useRef(key)

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key
      setState(deserialize<T>(localStorage.getItem(PREFIX + key), initial))
    }
  }, [key])

  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + key, serialize(state))
    } catch {
      /* 容量超限时忽略 */
    }
  }, [key, state])

  return [state, setState]
}

export function clearPersist(key: string) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    /* ignore */
  }
}
