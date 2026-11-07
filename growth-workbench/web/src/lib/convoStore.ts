/**
 * 跨组件、跨路由存活的「会话级」消息/任务仓库。
 *
 * 痛点：以前每条对话（research chat / quest chat）的消息和「正在生成」状态都挂在页面组件的
 * useState 上。一旦切换会话或切走路由（组件卸载），在途的请求/流式还会继续跑，但结果会被写进
 * 「当前」会话的状态 —— 于是出现串台（A 的回复跑到 B 里）和切走后状态丢失。
 *
 * 这里把状态下沉到一个模块级单例：按 sid 分桶存消息、live（流式草稿）、busy，再附带一个
 * 在途任务登记表（用来防重发 + 取消）。组件订阅自己关心的 sid，切走/卸载都不影响在途任务，
 * 回来时按 sid 取回自己的状态 —— 「切换对话不会中断流程」。
 *
 * 本文件不依赖 React，纯粹可单测。
 */

export type ConvoStatus = 'idle' | 'busy'

/** 在途任务登记：流式用 AbortController；普通请求用 { promise }（仅用于去重/判忙） */
export type ConvoTask = AbortController | { promise: Promise<unknown> }

export class ConvoStore<M> {
  private msgs = new Map<number, M[]>()
  private live = new Map<number, M | null>()
  private status = new Map<number, ConvoStatus>()
  private tasks = new Map<number, ConvoTask>()
  private globalListeners = new Set<() => void>()
  private sidListeners = new Map<number, Set<() => void>>()

  /** 取某会话的消息（永远返回数组，便于直接渲染） */
  getMessages(sid: number): M[] {
    return this.msgs.get(sid) ?? []
  }

  /** 整桶替换（open 会话时从后端拉全量） */
  setMessages(sid: number, list: M[]): void {
    this.msgs.set(sid, [...list])
    this.emit(sid)
  }

  /** 追加一条消息到指定会话桶（绝不写到别的 sid） */
  appendMessage(sid: number, msg: M): void {
    const cur = this.msgs.get(sid) ?? []
    this.msgs.set(sid, [...cur, msg])
    this.emit(sid)
  }

  /** 用 pred 找到旧消息并替换（流式结束用最终消息顶掉草稿） */
  replaceMessage(sid: number, pred: (m: M) => boolean, msg: M): void {
    const cur = this.msgs.get(sid)
    if (!cur) return
    let hit = false
    const next = cur.map((m) => {
      if (!hit && pred(m)) {
        hit = true
        return msg
      }
      return m
    })
    this.msgs.set(sid, next)
    this.emit(sid)
  }

  /** 取流式草稿（正在逐字生成的 assistant 气泡） */
  getLive(sid: number): M | null {
    return this.live.get(sid) ?? null
  }

  /** 写入/清空流式草稿（null = 没有进行中的草稿） */
  setLive(sid: number, msg: M | null): void {
    if (msg === null) this.live.delete(sid)
    else this.live.set(sid, msg)
    this.emit(sid)
  }

  isBusy(sid: number): boolean {
    return this.status.get(sid) === 'busy'
  }

  setBusy(sid: number, busy: boolean): void {
    this.status.set(sid, busy ? 'busy' : 'idle')
    this.emit(sid)
  }

  /** 登记在途任务（同一 sid 同时只允许一个，用 getTask 判重） */
  registerTask(sid: number, task: ConvoTask): void {
    this.tasks.set(sid, task)
  }

  getTask(sid: number): ConvoTask | undefined {
    return this.tasks.get(sid)
  }

  clearTask(sid: number): void {
    this.tasks.delete(sid)
  }

  /** 删除会话：清掉它所有的桶与在途任务（删对话时调用，避免残留） */
  removeSession(sid: number): void {
    this.msgs.delete(sid)
    this.live.delete(sid)
    this.status.delete(sid)
    const t = this.tasks.get(sid)
    if (t && 'abort' in t) t.abort()
    this.tasks.delete(sid)
    this.emit(sid)
  }

  subscribe(cb: () => void): () => void {
    this.globalListeners.add(cb)
    return () => this.globalListeners.delete(cb)
  }

  subscribeSid(sid: number, cb: () => void): () => void {
    let set = this.sidListeners.get(sid)
    if (!set) {
      set = new Set()
      this.sidListeners.set(sid, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }

  emit(sid?: number): void {
    this.globalListeners.forEach((cb) => cb())
    if (sid != null) {
      const set = this.sidListeners.get(sid)
      if (set) set.forEach((cb) => cb())
    }
  }
}
