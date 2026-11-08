import { useEffect, useState } from 'react'
import {
  Btn,
  Card,
  Empty,
  Input,
  LoadError,
  Loading,
  MdBlock,
  PageHeader,
  Pill,
  Progress,
  Select,
  StatusTag,
} from '../components/ui'
import { AiError, AiMeta } from '../components/AiError'
import { Icon } from '../components/Icon'
import { get, patch, post } from '../lib/api'
import { useAiTask } from '../lib/hooks'
import { usePersist } from '../lib/state'

const STATUS = [
  { value: 'todo', label: '未开始' },
  { value: 'doing', label: '进行中' },
  { value: 'blocked', label: '阻塞' },
  { value: 'done', label: '完成' },
]

const STAGE_TONE: Record<string, 'gray' | 'busy' | 'danger' | 'ok'> = {
  todo: 'gray',
  doing: 'busy',
  blocked: 'danger',
  done: 'ok',
}

type AiOut = { title: string; text: string; meta?: any } | null

export default function Paper() {
  const [ov, setOv] = useState<any>(null)
  const [sections, setSections] = useState<any[]>([])
  const [ready, setReady] = useState<any>(null)
  const [out, setOut] = usePersist<AiOut>('paper.out', null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeId, setActiveId] = usePersist<number | null>('paper.stage', null)
  const unblockTask = useAiTask<any>()
  const diagTask = useAiTask<any>()
  const outlineTask = useAiTask<number>()
  const [outlineBusyId, setOutlineBusyId] = useState<number | null>(null)
  const [newStage, setNewStage] = usePersist('paper.newStage', '')

  const load = async () => {
    const o = await get('/paper/overview')
    setOv(o)
    setSections(await get('/paper/sections'))
    get('/paper/readiness').then(setReady).catch(() => setReady(null))
    if (activeId === null && o.stages?.length) setActiveId(o.current?.id || o.stages[0].id)
  }

  const boot = async () => {
    setLoadError(null)
    try {
      await load()
    } catch (e: any) {
      setLoadError(e?.message || '论文数据加载失败')
    }
  }

  useEffect(() => {
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateStage = async (id: number, body: any) => {
    await patch(`/paper/stages/${id}`, body)
    load()
  }

  const unblock = async (id: number, name: string) => {
    const r: any = await unblockTask.run(() => post(`/paper/stages/${id}/unblock`, undefined, { ok: false }))
    if (!r || r.ok === false) return
    setOut({ title: `解锁方案 · ${name}`, text: r.result, meta: r })
  }

  const diagnose = async (id: number, name: string) => {
    const r: any = await diagTask.run(() => post(`/paper/stages/${id}/diagnose`, {}, { ok: false }))
    if (!r || r.ok === false) return
    setOut({ title: `卡点诊断 · ${name}`, text: r.result, meta: r })
  }

  const outline = async (id: number, name: string) => {
    setOutlineBusyId(id)
    try {
      const r: any = await outlineTask.run(() => post(`/paper/sections/${id}/outline`, {}, { ok: false }))
      if (!r || r.ok === false) return
      setOut({ title: `写作提纲 · ${name}`, text: r.result, meta: r })
    } finally {
      setOutlineBusyId(null)
    }
  }

  const addStage = async () => {
    if (!newStage.trim()) return
    await post('/paper/stages', { name: newStage, sort_order: ov?.stages?.length || 0, status: 'todo' })
    setNewStage('')
    load()
  }

  const updateSection = async (id: number, body: any) => {
    await patch(`/paper/sections/${id}`, body)
    load()
  }

  if (loadError) return <LoadError error={loadError} onRetry={boot} what="论文数据" />
  if (!ov) return <Loading text="正在加载论文进度…" />

  const active = ov.stages.find((s: any) => s.id === activeId) || ov.current

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="执行 · 02"
        title="论文"
        desc="七阶段流水线：阶段阻塞超过 3 天会亮红牌"
      />

      {/* 横向 stepper：阶段节点 + 连接线，点选查看详情 */}
      <Card title="阶段流水线" tourId="tour-paper-stages" bodyClassName="p-4 pb-5">
        {ov.stages.length === 0 ? (
          <Empty text="还没有阶段" hint="在下方输入阶段名，从「选题与定位」开始建。" />
        ) : (
          <div className="flex items-start overflow-x-auto pb-1">
            {ov.stages.map((s: any, i: number) => {
              const isBlockedLong = s.status === 'blocked' && s.stuck_days >= 3
              return (
                <div key={s.id} className="flex min-w-0 flex-1 items-start">
                  {/* 节点 */}
                  <button
                    type="button"
                    onClick={() => setActiveId(s.id)}
                    className={`group flex min-w-[96px] flex-col items-center gap-1.5 rounded-lg px-2 py-1.5 transition ${
                      activeId === s.id ? 'bg-[color:var(--wb-surface-alt)]' : 'hover:bg-[color:var(--wb-bg-subtle)]'
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 items-center justify-center rounded-full border text-[12px] font-semibold ${
                        s.status === 'done'
                          ? 'border-transparent bg-[color:var(--wb-ok)] text-white'
                          : s.status === 'blocked'
                            ? `border-transparent bg-[color:var(--wb-danger)] text-white ${isBlockedLong ? 'wb-anim-pulse' : ''}`
                            : s.status === 'doing'
                              ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                              : 'border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] text-[color:var(--wb-muted)]'
                      }`}
                    >
                      {s.status === 'done' ? <Icon name="check" size={13} /> : i + 1}
                    </span>
                    <span className="whitespace-nowrap text-[12px] font-medium text-[color:var(--wb-text)]">
                      {s.name}
                    </span>
                    <StatusTag tone={STAGE_TONE[s.status] || 'gray'}>
                      {s.status === 'blocked' ? `卡 ${s.stuck_days} 天` : STATUS.find((x) => x.value === s.status)?.label}
                    </StatusTag>
                  </button>
                  {/* 连接线：done 段实色，其余虚 */}
                  {i < ov.stages.length - 1 && (
                    <span
                      aria-hidden
                      className={`mt-[18px] h-[2px] min-w-[16px] flex-1 rounded-full ${
                        s.status === 'done'
                          ? 'bg-[color:var(--wb-ok)]/60'
                          : 'border-t border-dashed border-[color:var(--wb-border-strong)]'
                      }`}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 选中阶段的详情条 */}
        {active && (
          <div className="mt-4 rounded-xl border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-[color:var(--wb-text)]">
                {active.name}
                {active.status === 'blocked' && active.stuck_days > 0 && (
                  <Pill tone="red">已卡 {active.stuck_days} 天</Pill>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={active.status} onChange={(v) => updateStage(active.id, { status: v })} options={STATUS} />
                <Btn size="sm" onClick={() => diagnose(active.id, active.name)} loading={diagTask.busy}>
                  卡点诊断
                </Btn>
                <Btn size="sm" onClick={() => unblock(active.id, active.name)} loading={unblockTask.busy}>
                  AI 解锁方案
                </Btn>
              </div>
            </div>
            <div className="mt-2.5 grid gap-2 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11.5px] text-[color:var(--wb-text-soft)]">当前卡点</span>
                <Input
                  defaultValue={active.blocker || ''}
                  onBlur={(e) => e.target.value !== (active.blocker || '') && updateStage(active.id, { blocker: e.target.value })}
                  placeholder="卡在哪"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11.5px] text-[color:var(--wb-text-soft)]">下一步动作</span>
                <Input
                  defaultValue={active.next_action || ''}
                  onBlur={(e) => e.target.value !== (active.next_action || '') && updateStage(active.id, { next_action: e.target.value })}
                  placeholder="今天下午就能做的第一个动作"
                />
              </label>
            </div>
            {(diagTask.error || unblockTask.error) && (
              <div className="mt-2.5">
                {diagTask.error && (
                  <AiError error={diagTask.error} onRetry={() => diagnose(active.id, active.name)} retrying={diagTask.busy} title="诊断没有跑通" />
                )}
                {unblockTask.error && (
                  <AiError
                    error={unblockTask.error}
                    onRetry={() => unblock(active.id, active.name)}
                    retrying={unblockTask.busy}
                    title="解锁方案没有生成"
                  />
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <Input placeholder="新增阶段（如：实验补充）" value={newStage} onChange={setNewStage} />
          <Btn onClick={addStage}>添加</Btn>
        </div>
      </Card>

      {/* 开跑前体检：规则化的准入检查，全绿才值得往下写 */}
      {ready && (
        <Card
          title="写作体检"
          extra={
            <StatusTag tone={ready.passed === ready.total ? 'ok' : 'warn'}>
              {ready.passed}/{ready.total} 项通过
            </StatusTag>
          }
        >
          <div className="grid gap-1.5 md:grid-cols-2">
            {ready.checks.map((c: any) => (
              <div key={c.key} className="flex items-start gap-2 text-[12.5px]">
                <span className="mt-[2px] shrink-0">
                  <StatusTag tone={c.ok ? 'ok' : 'danger'}>{c.ok ? '通过' : '缺'}</StatusTag>
                </span>
                <span className={c.ok ? 'text-[color:var(--wb-text-soft)]' : 'text-[color:var(--wb-text)]'}>{c.label}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 章节进度：字数双轨 + 每章 AI 提纲 */}
      <Card title="章节进度">
        {sections.length === 0 ? (
          <Empty text="还没有章节" hint="按目标论文的结构建章节（Introduction / Related Work / Method / Experiments / Conclusion）。" />
        ) : (
          <div className="flex flex-col gap-3">
            {sections.map((s) => {
              const pct = s.target_words ? Math.min(100, Math.round((s.word_count / s.target_words) * 100)) : 0
              return (
                <div key={s.id} className="rounded-lg border border-[color:var(--wb-border)] p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-[13px] font-medium text-[color:var(--wb-text)]">{s.name}</span>
                    <StatusTag tone={STAGE_TONE[s.status] || 'gray'}>
                      {STATUS.find((x) => x.value === s.status)?.label}
                    </StatusTag>
                    <div className="min-w-[140px] flex-1">
                      <Progress value={s.word_count} max={s.target_words || 1} tone={pct >= 100 ? 'ok' : pct > 0 ? 'accent' : 'warn'} showLabel />
                    </div>
                    <Input
                      className="w-20"
                      type="number"
                      defaultValue={s.word_count}
                      onBlur={(e) => updateSection(s.id, { word_count: Number(e.target.value) })}
                    />
                    <span className="w-16 text-[11.5px] tabular-nums text-[color:var(--wb-muted)]">/ {s.target_words}</span>
                    <Select value={s.status} onChange={(v) => updateSection(s.id, { status: v })} options={STATUS} />
                    <Btn size="sm" onClick={() => outline(s.id, s.name)} loading={outlineBusyId === s.id} title="基于真实实验数据生成章节提纲">
                      AI 提纲
                    </Btn>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {outlineTask.error && (
          <div className="mt-2.5">
            <AiError
              error={outlineTask.error}
              title="提纲没有生成，回到对应章节再点一次「AI 提纲」即可重试"
            />
          </div>
        )}
      </Card>

      {out && (
        <Card
          title={out.title}
          extra={
            <Btn variant="ghost" onClick={() => setOut(null)}>
              关闭
            </Btn>
          }
        >
          <MdBlock text={out.text} />
          <AiMeta res={out.meta || {}} />
        </Card>
      )}
    </div>
  )
}
