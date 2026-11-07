import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { relTime } from './time'

// 注意：relTime 把后端 "YYYY-MM-DD HH:MM:SS" 当作「本地时间」解析（无 Z 后缀）。
// BASE 也必须用本地时间，否则会和输入的本地时间差一个时区偏移。
const BASE = new Date('2026-01-01T12:00:00').getTime()

beforeEach(() => {
  // 直接钉死 Date.now()，比 useFakeTimers 更可控（后者在本环境未能稳定劫持）
  vi.spyOn(Date, 'now').mockReturnValue(BASE)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('relTime · 相对时间分桶', () => {
  it('不到 1 分钟 → now', () => {
    expect(relTime('2026-01-01 11:59:30')).toBe('now')
  })
  it('59 分钟 → 59m', () => {
    expect(relTime('2026-01-01 11:01:00')).toBe('59m')
  })
  it('整 60 分钟 → 1h', () => {
    expect(relTime('2026-01-01 11:00:00')).toBe('1h')
  })
  it('整 1 分钟 → 1m（m===1 边界）', () => {
    expect(relTime('2026-01-01 11:59:00')).toBe('1m')
  })
  it('23 小时 → 23h', () => {
    expect(relTime('2025-12-31 13:00:00')).toBe('23h') // BASE 前 23h
  })
  it('整 24 小时 → 1d', () => {
    expect(relTime('2025-12-31 12:00:00')).toBe('1d')
  })
  it('6 天 → 6d', () => {
    expect(relTime('2025-12-26 12:00:00')).toBe('6d')
  })
  it('整 7 天 → 1w', () => {
    expect(relTime('2025-12-25 12:00:00')).toBe('1w')
  })
  it('≥ 2 周 → 2w', () => {
    expect(relTime('2025-12-18 12:00:00')).toBe('2w') // BASE 前 14 天
  })
  it('未来时间戳（负差）→ now，不崩', () => {
    expect(relTime('2026-01-01 12:00:30')).toBe('now')
  })
  it('空 / 非法 → 空串', () => {
    expect(relTime(undefined)).toBe('')
    expect(relTime('not-a-date')).toBe('')
  })
})
