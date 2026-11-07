import { describe, it, expect, vi } from 'vitest'
import { ConvoStore } from './convoStore'

describe('ConvoStore · 按 sid 分桶隔离（防串台）', () => {
  it('追加到 sid A 不影响 sid B', () => {
    const s = new ConvoStore<{ id: number }>()
    s.appendMessage(1, { id: 1 })
    s.appendMessage(2, { id: 2 })
    expect(s.getMessages(1)).toEqual([{ id: 1 }])
    expect(s.getMessages(2)).toEqual([{ id: 2 }])
    // 未触及的 sid 返回空数组而非 undefined / 共享引用
    expect(s.getMessages(3)).toEqual([])
  })

  it('setMessages 整桶替换', () => {
    const s = new ConvoStore<number>()
    s.appendMessage(5, 1)
    s.setMessages(5, [2, 3])
    expect(s.getMessages(5)).toEqual([2, 3])
  })

  it('replaceMessage 只顶掉首个命中的消息，未命中则不动', () => {
    const s = new ConvoStore<{ id: number; v: string }>()
    s.setMessages(1, [
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
      { id: 1, v: 'c' },
    ])
    s.replaceMessage(1, (m) => m.id === 1, { id: 1, v: 'X' })
    expect(s.getMessages(1)).toEqual([
      { id: 1, v: 'X' },
      { id: 2, v: 'b' },
      { id: 1, v: 'c' },
    ])
    s.replaceMessage(1, (m) => m.id === 99, { id: 99, v: 'Y' })
    // 没命中，第三个元素保持 c
    expect(s.getMessages(1)[2]).toEqual({ id: 1, v: 'c' })
  })

  it('live 草稿写入 / 清空（null 删除）', () => {
    const s = new ConvoStore<string>()
    expect(s.getLive(1)).toBeNull()
    s.setLive(1, 'partial')
    expect(s.getLive(1)).toBe('partial')
    s.setLive(1, null)
    expect(s.getLive(1)).toBeNull()
  })

  it('busy 状态按 sid 独立', () => {
    const s = new ConvoStore<unknown>()
    s.setBusy(1, true)
    expect(s.isBusy(1)).toBe(true)
    expect(s.isBusy(2)).toBe(false)
    s.setBusy(1, false)
    expect(s.isBusy(1)).toBe(false)
  })
})

describe('ConvoStore · 在途任务登记（防重发）', () => {
  it('未登记时 getTask 为 undefined，登记后可取回，clear 后回到 undefined', () => {
    const s = new ConvoStore<unknown>()
    expect(s.getTask(1)).toBeUndefined()
    const ctrl = new AbortController()
    s.registerTask(1, ctrl)
    expect(s.getTask(1)).toBe(ctrl)
    s.clearTask(1)
    expect(s.getTask(1)).toBeUndefined()
  })

  it('removeSession 取消 AbortController 任务并清空桶', () => {
    const s = new ConvoStore<number>()
    const ctrl = new AbortController()
    s.registerTask(1, ctrl)
    s.appendMessage(1, 10)
    s.setBusy(1, true)
    const onAbort = vi.fn()
    ctrl.signal.addEventListener('abort', onAbort)

    s.removeSession(1)

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(s.getMessages(1)).toEqual([])
    expect(s.isBusy(1)).toBe(false)
    expect(s.getTask(1)).toBeUndefined()
  })

  it('removeSession 同时清掉 live 草稿', () => {
    const s = new ConvoStore<string>()
    s.setLive(1, 'partial streaming text')
    s.removeSession(1)
    expect(s.getLive(1)).toBeNull()
  })

  it('removeSession 对纯 promise 任务只删除不报错', () => {
    const s = new ConvoStore<unknown>()
    const p = Promise.resolve()
    s.registerTask(2, { promise: p })
    expect(() => s.removeSession(2)).not.toThrow()
    expect(s.getTask(2)).toBeUndefined()
  })
})

describe('ConvoStore · 订阅通知', () => {
  it('subscribe（全局）在任何 sid 变更时触发', () => {
    const s = new ConvoStore<number>()
    const cb = vi.fn()
    const off = s.subscribe(cb)
    s.appendMessage(1, 1)
    s.appendMessage(2, 2)
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    s.appendMessage(1, 3)
    expect(cb).toHaveBeenCalledTimes(2) // 退订后不再触发
  })

  it('subscribeSid 只在该 sid 变更时触发', () => {
    const s = new ConvoStore<number>()
    const cb = vi.fn()
    const off = s.subscribeSid(1, cb)
    s.appendMessage(2, 99) // 别的 sid，不应触发
    expect(cb).not.toHaveBeenCalled()
    s.appendMessage(1, 1)
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    s.appendMessage(1, 2)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
