/**
 * 概览指标：全站数字的单一汇总页。
 *
 * 各模块页不再内嵌「概览指标」区块 —— 模块页留纯操作区，数字集中在这一页看。
 * 数据全部来自 GET /dashboard 的实时汇总，不手动填第二遍；本页只读，不提供任何写操作。
 */
import { useCallback, useEffect, useState } from 'react'
import { LoadError, Loading, PageHeader, StatCard } from '../components/ui'
import { get } from '../lib/api'

/** 一组指标：组名 + 四张卡（不足四张也按 4 列网格排，空位自然留白） */
function MetricGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
        {label}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
    </section>
  )
}

export default function Overview() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    get('/dashboard')
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  if (error) return <LoadError error={error} onRetry={load} retrying={loading} what="概览数据" />
  if (loading || !data) return <Loading text="正在汇总各模块指标…" />

  const lit = data.literature || {}
  const litTotal = (lit.todo || 0) + (lit.reading || 0) + (lit.done || 0)
  const ideas = data.ideas || {}
  const ideaKeys = Object.keys(ideas)
  const ideaTotal = ideaKeys.reduce((s, k) => s + (ideas[k] || 0), 0)
  const exp = data.experiments || {}
  const expTotal = Object.keys(exp).reduce((s, k) => s + (exp[k] || 0), 0)
  const expDone = exp.done || 0
  const paper = data.paper || {}
  const points = data.points || {}
  const commitments = data.commitments || {}

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="概览指标"
        desc="文献 / 创新点 / 实验 / 论文 / 节奏激励的数字都汇总在这一页；模块页只留操作区"
      />

      <MetricGroup label="文献">
        <StatCard label="文献总数" value={litTotal} unit="篇" tone="accent" />
        <StatCard label="待读" value={lit.todo || 0} unit="篇" />
        <StatCard label="在读" value={lit.reading || 0} unit="篇" tone="warn" />
        <StatCard
          label="已读"
          value={lit.done || 0}
          unit="篇"
          tone="ok"
          hint={litTotal ? `完成度 ${Math.round(((lit.done || 0) / litTotal) * 100)}%` : undefined}
        />
      </MetricGroup>

      <MetricGroup label="创新点">
        <StatCard label="合计" value={ideaTotal} unit="条" tone="accent" />
        <StatCard label="已捕获" value={ideas.captured || 0} unit="条" />
        <StatCard label="筛选中" value={ideas.screening || 0} unit="条" tone="warn" />
        <StatCard
          label="已验证 / 选定"
          value={(ideas.validated || 0) + (ideas.selected || 0)}
          unit="条"
          tone="ok"
          hint={ideaTotal ? `已放弃 ${ideas.dropped || 0} 条` : undefined}
        />
      </MetricGroup>

      <MetricGroup label="实验">
        <StatCard label="实验总数" value={expTotal} unit="个" tone="accent" />
        <StatCard
          label="进行中"
          value={(exp.running || 0) + (exp.analyzing || 0)}
          unit="个"
          tone="warn"
          hint={`待跑 ${exp.planned || 0} 个`}
        />
        <StatCard
          label="已完成"
          value={expDone}
          unit="个"
          tone={expTotal > 0 && expDone === expTotal ? 'ok' : 'default'}
          hint={expTotal ? `完成率 ${Math.round((expDone / expTotal) * 100)}%` : undefined}
        />
        <StatCard label="待跑" value={exp.planned || 0} unit="个" />
      </MetricGroup>

      <MetricGroup label="论文">
        <StatCard label="阶段进度" value={paper.progress || 0} unit="%" tone="accent" />
        <StatCard
          label="字数"
          value={paper.words || 0}
          unit="字"
          hint={paper.target_words ? `目标 ${paper.target_words} 字 · 已完成 ${paper.word_progress || 0}%` : '章节还没设目标字数'}
        />
        <StatCard
          label="阻塞阶段"
          value={paper.blocked?.length || 0}
          unit="个"
          tone={paper.blocked?.length > 0 ? 'danger' : 'ok'}
          hint={paper.blocked?.length > 0 ? '阻塞超过 3 天会亮红牌' : '一切顺畅'}
        />
        <StatCard
          label="当前阶段"
          value={<span className="text-[14px] font-semibold leading-snug">{paper.current?.name || '—'}</span>}
        />
      </MetricGroup>

      <MetricGroup label="节奏与激励">
        <StatCard
          label="积分余额"
          value={points.balance ?? 0}
          unit="分"
          tone={(points.balance ?? 0) >= 0 ? 'ok' : 'danger'}
          hint={`本周净 ${points.week_net >= 0 ? '+' : ''}${points.week_net ?? 0} 分（保护下限 ${points.floor} 分）`}
        />
        <StatCard
          label="未闭合承诺"
          value={commitments.open || 0}
          unit="项"
          tone={commitments.overdue > 0 ? 'danger' : 'default'}
          hint={commitments.overdue > 0 ? `逾期 ${commitments.overdue} 项` : '暂无逾期'}
        />
        <StatCard
          label="待办任务"
          value={data.open_tasks || 0}
          unit="项"
          hint={`未结算赌约 ${data.open_bets || 0} 个`}
        />
        <StatCard
          label="今日打卡"
          value={data.checkin_today ? '已打卡' : '未打卡'}
          tone={data.checkin_today ? 'ok' : 'default'}
        />
      </MetricGroup>
    </div>
  )
}
