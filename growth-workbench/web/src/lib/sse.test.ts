import { describe, it, expect } from 'vitest'
import { parseSse } from './sse'

describe('parseSse · 分块边界', () => {
  it('完整单事件：解析出 1 条，rest 为空', () => {
    const buf = 'data: {"type":"delta","text":"hi"}\n\n'
    const { events, rest } = parseSse(buf)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'delta', text: 'hi' })
    expect(rest).toBe('')
  })

  it('事件恰巧在分块边界被切断：第一次无完整事件，续传后拼出 1 条', () => {
    const first = parseSse('data: {"type":"de')
    expect(first.events).toHaveLength(0)
    expect(first.rest).toBe('data: {"type":"de')

    const second = parseSse(first.rest + 'lta"}\n\n')
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({ type: 'delta' })
    expect(second.rest).toBe('')
  })

  it('多个事件挤在一个 chunk：全部分离', () => {
    const buf =
      'data: {"type":"a"}\n\ndata: {"type":"b"}\n\n'
    const { events } = parseSse(buf)
    expect(events.map((e) => e.type)).toEqual(['a', 'b'])
  })

  it('空缓冲：0 事件，rest 为空', () => {
    const { events, rest } = parseSse('')
    expect(events).toEqual([])
    expect(rest).toBe('')
  })

  it('末块不完整（无结尾空行）：保留到 rest，不丢', () => {
    const buf = 'data: {"type":"delta","text":"hel'
    const { events, rest } = parseSse(buf)
    expect(events).toHaveLength(0)
    expect(rest).toBe(buf)
  })

  it('非法 JSON 事件被跳过，其余正常解析', () => {
    const buf =
      'data: {not json}\n\ndata: {"type":"ok"}\n\n'
    const { events } = parseSse(buf)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'ok' })
  })

  it('非 data: 行被忽略（event 行在前、data 行在后也能解析）', () => {
    const buf = 'event: ping\ndata: {"type":"x"}\n\n'
    const { events } = parseSse(buf)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'x' })
  })

  it('块内 data 行位置无关：data 在前、非 data 行在后仍解析', () => {
    const buf = 'data: {"type":"x"}\nevent: ping\n\n'
    const { events } = parseSse(buf)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'x' })
  })

  it('保留事件上的额外字段', () => {
    const buf = 'data: {"type":"delta","text":"a","extra":42}\n\n'
    const { events } = parseSse(buf)
    expect(events[0].extra).toBe(42)
  })
})
