import { useEffect, useState } from 'react'
import { ConvoStore } from './convoStore'

/**
 * 订阅某个会话桶的 React 钩子：只渲染自己 sid 的消息 / live / busy。
 * 切走或卸载组件都不影响仓库里的在途任务，回来按 sid 取回即可。
 */
export function useConvoSession<M>(
  store: ConvoStore<M>,
  sid: number | null,
): { messages: M[]; live: M | null; busy: boolean } {
  const [, force] = useState(0)

  useEffect(() => {
    const bump = () => force((n) => n + 1)
    if (sid == null) return
    const offGlobal = store.subscribe(bump)
    const offSid = store.subscribeSid(sid, bump)
    // 挂载时先同步一次（可能仓库里已有该会话的缓存/在途结果）
    bump()
    return () => {
      offGlobal()
      offSid()
    }
  }, [store, sid])

  return {
    messages: sid == null ? [] : store.getMessages(sid),
    live: sid == null ? null : store.getLive(sid),
    busy: sid == null ? false : store.isBusy(sid),
  }
}
