import { useEffect, useState } from 'react'
import { Btn, Card, Empty, Input, LoadError, Loading, MdBlock, Select } from '../components/ui'
import { AiError, AiMeta } from '../components/AiError'
import { get, patch, post } from '../lib/api'
import { useAiTask } from '../lib/hooks'
import { usePersist } from '../lib/state'

const STATUS = [
  { value: 'todo', label: '未开始' },
  { value: 'doing', label: '进行中' },
  { value: 'blocked', label: '阻塞' },
  { value: 'done', label: '完成' },
]

export default function Paper() {
  const [ov, setOv] = useState<any>(null)
  const [sections, setSections] = useState<any[]>([])
  const [out, setOut] = usePersist<{ title: string; text: string } | null>('paper.out', null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const unblockTask = useAiTask<any>()
  const [newStage, setNewStage] = usePersist('paper.newStage', '')

  const load = async () => {
    setOv(await get('/paper/overview'))
    setSections(await get('/paper/sections'))
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
     
  }, [])

  const updateStage = async (id: number, body: any) => {
    await patch(`/paper/stages/${id}`, body)
    load()
  }

  const unblock = async (id: number, name: string) => {
    const r: any = await unblockTask.run(() =>
      post(`/paper/stages/${id}/unblock`, undefined, { ok: false }),
    )
    if (!r || r.ok === false) return
    setOut({ title: `解锁方案 · ${name}`, text: r.result })
  }

  const addStage = async () => {
    if (!newStage.trim()) return
    await post('/paper/stages', { name: newStage, sort_order: (ov?.stages?.length || 0), status: 'todo' })
    setNewStage('')
    load()
  }

  const updateSection = async (id: number, body: any) => {
    await patch(`/paper/sections/${id}`, body)
    load()
  }

  if (loadError) return <LoadError error={loadError} onRetry={boot} what="论文数据" />
  if (!ov) return <Loading text="正在加载论文进度…" />

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <div className="text-[12px] text-[color:var(--wb-text-soft)]">阶段进度</div>
          <div className="mt-1 text-2xl font-medium text-[color:var(--wb-text)]">{ov.progress}%</div>
        </Card>
        <Card>
          <div className="text-[12px] text-[color:var(--wb-text-soft)]">字数</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-medium tabular-nums text-[color:var(--wb-text)]">{ov.words}</span>
            <span className="text-[11.5px] text-[color:var(--wb-muted)]">字</span>
          </div>
          <div className="mt-1 text-[11.5px] text-[color:var(--wb-muted)]">目标 {ov.target_words} 字</div>
        </Card>
        <Card>
          <div className="text-[12px] text-[color:var(--wb-text-soft)]">阻塞阶段</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-medium tabular-nums text-[color:var(--wb-danger)]">
              {ov.blocked.length}
            </span>
            <span className="text-[11.5px] text-[color:var(--wb-muted)]">个</span>
          </div>
        </Card>
        <Card>
          <div className="text-[12px] text-[color:var(--wb-text-soft)]">当前阶段</div>
          <div className="mt-1 truncate text-[13px] font-medium text-[color:var(--wb-text)]">
            {ov.current?.name || '—'}
          </div>
        </Card>
      </div>

      <Card title="阶段流水线">
        <div className="mb-3 flex flex-wrap gap-2">
          {ov.stages.map((s: any) => {
            const tone =
              s.status === 'done'
                ? 'border-emerald-300 bg-emerald-50'
                : s.status === 'blocked'
                ? 'border-rose-400 bg-[color:var(--wb-danger-soft)]'
                : s.status === 'doing'
                ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface-alt)]'
                : 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]'
            return (
              <div key={s.id} className={`w-[150px] rounded-lg border p-2 ${tone}`}>
                <div className="text-[12px] font-medium text-[color:var(--wb-text)]">{s.name}</div>
                <div className="mt-1">
                  <Select
                    value={s.status}
                    onChange={(v) => updateStage(s.id, { status: v })}
                    options={STATUS}
                  />
                </div>
                {s.status === 'blocked' && (
                  <div className="mt-1 text-[11.5px] text-[color:var(--wb-danger)]">已卡 {s.stuck_days} 天</div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex gap-2">
          <Input placeholder="新增阶段" value={newStage} onChange={setNewStage} />
          <Btn onClick={addStage}>添加</Btn>
        </div>
      </Card>

      <Card title="卡点明细">
        {unblockTask.error && (
          <div className="mb-2.5">
            <AiError
              error={unblockTask.error}
              onRetry={ov.blocked[0] ? () => unblock(ov.blocked[0].id, ov.blocked[0].name) : undefined}
              retrying={unblockTask.busy}
              title="解锁方案没有生成"
            />
          </div>
        )}
        {ov.stages.length === 0 ? (
          <Empty />
        ) : (
          <div className="flex flex-col gap-2">
            {ov.stages.map((s: any) => (
              <div key={s.id} className="rounded-lg border border-[color:var(--wb-border)] p-3">
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium text-[color:var(--wb-text)]">{s.name}</div>
                  {s.status === 'blocked' && (
                    <Btn onClick={() => unblock(s.id, s.name)} loading={unblockTask.busy}>
                      AI 解锁方案
                    </Btn>
                  )}
                </div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <label className="block">
                    <span className="text-[11.5px] text-[color:var(--wb-text-soft)]">当前卡点</span>
                    <Input
                      defaultValue={s.blocker || ''}
                      onBlur={(e) => updateStage(s.id, { blocker: e.target.value })}
                      placeholder="卡在哪"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11.5px] text-[color:var(--wb-text-soft)]">下一步动作</span>
                    <Input
                      defaultValue={s.next_action || ''}
                      onBlur={(e) => updateStage(s.id, { next_action: e.target.value })}
                      placeholder="今天下午就能做的第一个动作"
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="章节进度">
        {sections.length === 0 ? (
          <Empty />
        ) : (
          <div className="flex flex-col gap-2">
            {sections.map((s) => {
              const pct = s.target_words ? Math.min(100, Math.round((s.word_count / s.target_words) * 100)) : 0
              return (
                <div key={s.id} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-[12px] text-[color:var(--wb-text)]">{s.name}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--wb-bg-subtle)]">
                    <div className="h-full bg-[color:var(--wb-accent)]" style={{ width: `${pct}%` }} />
                  </div>
                  <Input
                    className="w-20"
                    type="number"
                    defaultValue={s.word_count}
                    onBlur={(e) => updateSection(s.id, { word_count: Number(e.target.value) })}
                  />
                  <span className="w-16 text-[11.5px] text-[color:var(--wb-muted)]">/ {s.target_words}</span>
                  <Select
                    value={s.status}
                    onChange={(v) => updateSection(s.id, { status: v })}
                    options={STATUS}
                  />
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {out && !unblockTask.error && (
        <Card title={out.title} extra={<Btn variant="ghost" onClick={() => setOut(null)}>关闭</Btn>}>
          <MdBlock text={out.text} />
          <AiMeta res={unblockTask.data || {}} />
        </Card>
      )}
    </div>
  )
}
