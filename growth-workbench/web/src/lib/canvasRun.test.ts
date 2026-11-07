import { describe, it, expect } from 'vitest'
import { pickResumableRun, type CanvasRun } from './canvasRun'

const run = (id: number, status: string): CanvasRun => ({ id, status })

describe('pickResumableRun · 挂载续跑挑选', () => {
  it('空列表 / null / undefined → null', () => {
    expect(pickResumableRun([])).toBeNull()
    expect(pickResumableRun(null)).toBeNull()
    expect(pickResumableRun(undefined)).toBeNull()
  })

  it('全是终态（done/failed/cancelled）→ null', () => {
    expect(pickResumableRun([run(1, 'done'), run(2, 'failed'), run(3, 'cancelled')])).toBeNull()
  })

  it('单个 running → 返回它', () => {
    const r = run(7, 'running')
    expect(pickResumableRun([run(1, 'done'), r])).toBe(r)
  })

  it('running + queued 混在：返回 id 最大的活跃运行', () => {
    // 后端 runs 按 id DESC 排，最新的在前；这里验证「最大 id」而非「第一个」
    expect(pickResumableRun([run(1, 'running'), run(2, 'queued')])?.id).toBe(2)
    expect(pickResumableRun([run(5, 'queued'), run(9, 'running'), run(3, 'failed')])?.id).toBe(9)
  })

  it('忽略额外字段也不影响', () => {
    const runs = [
      { id: 4, status: 'done', scope: 'x', started_at: '2026', out_count: 2 },
      { id: 8, status: 'running', scope: 'y' },
    ]
    expect(pickResumableRun(runs)?.id).toBe(8)
  })
})
