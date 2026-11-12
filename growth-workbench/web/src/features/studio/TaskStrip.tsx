/**
 * 全局任务带：工作台底部的「运行中 N / 共 M」卡片。
 *
 * 数字与条目全部来自 GET /api/workspace/runs —— 只读聚合
 * workspace_runs / canvas_runs / exp_runs，既不造未读数，也不改动既有表。
 * 参照 S1 首页底部运行任务卡的语义：一眼看清现在有什么在跑、跑没跑成。
 */
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Dot, IconBtn } from '../../components/ui'
import { useApi } from '../../lib/hooks'
import { relTime } from '../../lib/time'

type RunStatus = 'running' | 'ok' | 'failed'

type Run = {
  id: number
  source: string
  kind: string
  label: string
  command?: string | null
  status: RunStatus
  created_at: string
  finished_at?: string | null
  wall_ms?: number | null
  error?: string | null
}

const DOT_TONE: Record<RunStatus, 'indigo' | 'green' | 'red'> = {
  running: 'indigo',
  ok: 'green',
  failed: 'red',
}
const STATUS_TEXT: Record<RunStatus, string> = {
  running: '运行中',
  ok: '成功',
  failed: '失败',
}
const SOURCE_TEXT: Record<string, string> = {
  workspace: '工作室',
  canvas: '画布',
  exp: '实验',
}

const fmtWall = (ms?: number | null) => {
  if (!ms || ms < 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export default function TaskStrip() {
  const { data, loading, error, reload } = useApi<any>('/workspace/runs?limit=8')
  const [expanded, setExpanded] = useState(false)

  const runs: Run[] = data?.runs || []
  const counts = data?.counts || { running: 0, ok: 0, failed: 0, total: 0 }
  const shown = expanded ? runs : runs.slice(0, 4)

  return (
    <section className="overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-xs)]">
      <header className="flex items-center gap-2 border-b border-[color:var(--wb-border)] px-3.5 py-2.5">
        <Icon name="play" size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
        <span className="shrink-0 text-[12px] font-semibold text-[color:var(--wb-text)]">运行任务</span>
        <span className="min-w-0 truncate text-[11px] text-[color:var(--wb-muted)]">
          运行中 {counts.running} · 成功 {counts.ok} · 失败 {counts.failed} · 共 {counts.total}
        </span>
        <span className="flex-1" />
        <IconBtn icon="refresh" size="sm" ariaLabel="刷新运行记录" title="刷新" onClick={reload} />
      </header>

      {loading && (
        <div className="px-3.5 py-4 text-[11.5px] text-[color:var(--wb-muted)]">正在读取运行记录…</div>
      )}

      {error && (
        <div className="px-3.5 py-4 text-[11.5px] leading-relaxed text-[color:var(--wb-danger)]">
          运行记录加载失败：{error}
        </div>
      )}

      {!loading && !error && runs.length === 0 && (
        <div className="px-3.5 py-4 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
          还没有运行记录。在论文工作室编译一份 .tex，或跑一次画布流水线，这里就会留下真实留痕。
        </div>
      )}

      {!loading && !error && runs.length > 0 && (
        <>
          <div className="flex flex-col">
            {shown.map((r) => (
              <div
                key={`${r.source}-${r.id}`}
                title={r.command || r.label}
                className="flex items-center gap-2 border-b border-[color:var(--wb-border)] px-3.5 py-[7px] last:border-b-0"
              >
                <Dot tone={DOT_TONE[r.status] || 'gray'} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--wb-text-soft)]">
                  {r.label}
                </span>
                {r.error && (
                  <span className="max-w-[130px] shrink-0 truncate text-[10.5px] text-[color:var(--wb-danger)]">
                    {r.error}
                  </span>
                )}
                <span className="shrink-0 text-[10.5px] text-[color:var(--wb-muted)]">
                  {SOURCE_TEXT[r.source] || r.source}
                </span>
                <span className="shrink-0 text-[10.5px] text-[color:var(--wb-muted)]">
                  {STATUS_TEXT[r.status] || r.status}
                </span>
                {fmtWall(r.wall_ms) && (
                  <span className="shrink-0 tabular-nums text-[10.5px] text-[color:var(--wb-muted)]">
                    {fmtWall(r.wall_ms)}
                  </span>
                )}
                <span className="w-[52px] shrink-0 text-right text-[10.5px] text-[color:var(--wb-muted)]">
                  {relTime(r.created_at)}
                </span>
              </div>
            ))}
          </div>
          {runs.length > 4 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-center gap-1 border-t border-[color:var(--wb-border)] py-2 text-[11px] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
            >
              {expanded ? '收起' : `展开其余 ${runs.length - 4} 条`}
              <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={11} />
            </button>
          )}
        </>
      )}
    </section>
  )
}
