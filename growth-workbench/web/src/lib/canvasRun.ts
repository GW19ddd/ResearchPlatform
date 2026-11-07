/**
 * 画布运行记录的最小结构（对应后端 canvas_runs 行的字段子集）。
 */
export interface CanvasRun {
  id: number
  status: string
  scope?: string
  started_at?: string
  out_count?: number
}

/**
 * 切回画布（或导航回来）时，挑一个「还在跑」的运行继续轮询。
 *
 * 后端 GET /canvas/{id} 返回的 runs 按 id DESC 排列，最新的在前。只要存在 running / queued
 * 的运行就返回 id 最大的那个；否则返回 null（说明没有需要续看的在途运行）。
 */
export function pickResumableRun(runs: CanvasRun[] | null | undefined): CanvasRun | null {
  if (!runs || runs.length === 0) return null
  const active = runs.filter((r) => r.status === 'running' || r.status === 'queued')
  if (active.length === 0) return null
  return active.reduce((a, b) => (b.id > a.id ? b : a))
}
