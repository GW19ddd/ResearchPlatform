import { useEffect, useState } from 'react'
import {
  Btn,
  Card,
  Details,
  Empty,
  Input,
  LoadError,
  Loading,
  MdBlock,
  Pill,
  TextArea,
} from '../components/ui'
import { AiError, AiMeta } from '../components/AiError'
import { del, get, patch, post } from '../lib/api'
import { useAiTask } from '../lib/hooks'
import { usePersist } from '../lib/state'

export default function Plan() {
  const [week, setWeek] = useState<any>(null)
  const [outcome, setOutcome] = usePersist('plan.outcome', '')
  const [task, setTask] = usePersist('plan.task', { title: '', points: 10 })
  const [review, setReview] = usePersist<any>('plan.review', {
    done: [] as string[],
    missed: [] as string[],
    blockers: '',
    next_min_action: '',
    self_score: 3,
  })
  const [summary, setSummary] = usePersist<string | null>('plan.summary', null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const biTask = useAiTask<any>()

  const load = async () => setWeek(await get('/plan/current'))

  const boot = async () => {
    setLoadError(null)
    try {
      await load()
    } catch (e: any) {
      setLoadError(e?.message || '周计划加载失败')
    }
  }

  useEffect(() => {
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addOutcome = async () => {
    if (!outcome.trim() || !week) return
    await post('/plan/week', { outcomes: [...week.outcomes, outcome] })
    setOutcome('')
    load()
  }

  const removeOutcome = async (i: number) => {
    if (!week) return
    const next = week.outcomes.filter((_: string, idx: number) => idx !== i)
    await post('/plan/week', { outcomes: next })
    load()
  }

  const addTask = async () => {
    if (!task.title.trim()) return
    await post('/plan/tasks', { title: task.title, points: Number(task.points) })
    setTask({ title: '', points: 10 })
    load()
  }

  const toggleTask = async (t: any) => {
    await patch(`/plan/tasks/${t.id}`, { status: t.status === 'done' ? 'todo' : 'done' })
    load()
  }

  const toggle = (key: 'done' | 'missed', value: string) => {
    const list = review[key] as string[]
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
    const other = key === 'done' ? 'missed' : 'done'
    setReview({
      ...review,
      [key]: next,
      [other]: (review[other] as string[]).filter((v) => v !== value),
    })
  }

  const submitReview = async () => {
    await post('/plan/review', review)
    load()
  }

  const biweekly = async () => {
    const r: any = await biTask.run(() => get('/plan/biweekly'))
    if (!r || r.ok === false) return
    setSummary(r.result)
  }

  if (loadError) return <LoadError error={loadError} onRetry={boot} what="周计划" />
  if (!week) return <Loading text="正在加载本周计划…" />

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={`本周成果 · ${week.week_start} 起`}>
          <div className="flex gap-2">
            <Input
              placeholder="必须是可交付物，例：完成 F2 组数据整理"
              value={outcome}
              onChange={setOutcome}
            />
            <Btn variant="primary" onClick={addOutcome}>
              添加
            </Btn>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {week.outcomes.length === 0 ? (
              <Empty text="本周还没定成果" />
            ) : (
              week.outcomes.map((o: string, i: number) => (
                <div key={i} className="flex items-start justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                  <span className="text-[12px] text-slate-700">
                    {i + 1}. {o}
                  </span>
                  <button className="text-slate-300 hover:text-rose-500" onClick={() => removeOutcome(i)}>
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            只写 3 条。写「推进研究」这类无法验证的话，等于没写。
          </p>
        </Card>

        <Card title="支撑任务">
          <div className="flex gap-2">
            <Input placeholder="具体动作" value={task.title} onChange={(v) => setTask({ ...task, title: v })} />
            <Input
              className="w-16"
              type="number"
              value={task.points}
              onChange={(v) => setTask({ ...task, points: Number(v) })}
            />
            <Btn variant="primary" onClick={addTask}>
              添加
            </Btn>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {week.tasks.length === 0 ? (
              <Empty text="暂无任务" />
            ) : (
              week.tasks.map((t: any) => (
                <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input type="checkbox" checked={t.status === 'done'} onChange={() => toggleTask(t)} />
                    <span
                      className={`truncate text-[12px] ${t.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}
                    >
                      {t.title}
                    </span>
                  </label>
                  <Pill>{t.points} 分</Pill>
                  <button
                    className="text-slate-300 hover:text-rose-500"
                    onClick={async () => {
                      await del(`/plan/tasks/${t.id}`)
                      load()
                    }}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card title="周复盘">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] text-slate-500">完成了哪些成果</div>
            {week.outcomes.map((o: string, i: number) => (
              <label key={i} className="flex items-center gap-2 py-0.5 text-[12px] text-slate-700">
                <input
                  type="checkbox"
                  checked={review.done.includes(o)}
                  onChange={() => toggle('done', o)}
                />
                {o}
              </label>
            ))}
            {week.outcomes.length === 0 && <Empty text="先定本周成果" />}
          </div>
          <div>
            <div className="mb-1 text-[12px] text-slate-500">没完成哪些</div>
            {week.outcomes.map((o: string, i: number) => (
              <label key={i} className="flex items-center gap-2 py-0.5 text-[12px] text-slate-700">
                <input
                  type="checkbox"
                  checked={review.missed.includes(o)}
                  onChange={() => toggle('missed', o)}
                />
                {o}
              </label>
            ))}
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <TextArea
            rows={2}
            placeholder="卡在哪（诚实写）"
            value={review.blockers}
            onChange={(v) => setReview({ ...review, blockers: v })}
          />
          <TextArea
            rows={2}
            placeholder="下周最小动作"
            value={review.next_min_action}
            onChange={(v) => setReview({ ...review, next_min_action: v })}
          />
          <label className="flex items-center justify-between text-[12px] text-slate-600">
            本周状态自评(1-5)
            <Input
              className="w-16"
              type="number"
              value={review.self_score}
              onChange={(v) => setReview({ ...review, self_score: Number(v) })}
            />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <Btn variant="primary" onClick={submitReview}>
            提交周复盘
          </Btn>
          <Btn onClick={biweekly} loading={biTask.busy}>
            生成双周组会汇报
          </Btn>
        </div>
        {biTask.error && (
          <div className="mt-2.5">
            <AiError
              error={biTask.error}
              onRetry={biweekly}
              retrying={biTask.busy}
              title="汇报材料没有生成"
            />
          </div>
        )}
      </Card>

      {summary && !biTask.error && (
        <Card
          title="双周组会汇报（可直接带走）"
          extra={<Btn variant="ghost" onClick={() => setSummary(null)}>关闭</Btn>}
        >
          <MdBlock text={summary} />
          <AiMeta res={biTask.data || {}} />
          {/* 统计口径：AI 汇总到底看了什么范围，必须能自查 */}
          {biTask.data?.scope && (
            <Details summary="这份汇报的统计口径" className="mt-2">
              <div className="flex flex-col gap-1">
                <div>
                  窗口：{biTask.data.scope.since} → {biTask.data.scope.until}（
                  {biTask.data.scope.window_days} 天）
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {Object.entries(biTask.data.scope.counts || {}).map(([k, v]) => (
                    <span key={k}>
                      {k} {String(v)}
                    </span>
                  ))}
                </div>
                <ul className="mt-1 list-inside list-disc">
                  {(biTask.data.scope.notes || []).map((n: string, i: number) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            </Details>
          )}
        </Card>
      )}
    </div>
  )
}
