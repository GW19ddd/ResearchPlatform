import { useEffect, useState } from 'react'
import { Btn, Card, Empty, Input, MdBlock, Pill, Select, TextArea } from '../components/ui'
import { AiError, AiMeta } from '../components/AiError'
import { del, get, patch, post } from '../lib/api'
import { useAiTask, useIdemKey } from '../lib/hooks'
import { usePersist } from '../lib/state'

const SCENES = ['组会', '微信', '邮件', '走廊偶遇']
const DRAFT_SCENES = ['周报', '求助', '要资源', '推进度', '请假或缓期']

export default function Advisor() {
  const [notes, setNotes] = useState<any[]>([])
  const [pending, setPending] = useState<any[]>([])
  const [form, setForm] = usePersist<any>('adv.form', {
    scene: '组会',
    advisor_said: '',
    my_commitment: '',
    due_date: '',
  })
  const [draft, setDraft] = usePersist<any>('adv.draft', {
    scene: '周报',
    progress: '',
    blockers: '',
    ask: '',
    commitments: '',
  })
  const [out, setOut] = usePersist<string | null>('adv.out', null)
  const draftTask = useAiTask<any>()
  // 记承诺是一次性写操作：双击容易记两条，同 key 后端只写一次
  const idem = useIdemKey()

  const load = async () => {
    setNotes(await get('/advisor/notes'))
    setPending(await get('/advisor/pending'))
  }

  useEffect(() => {
    load()
  }, [])

  const add = async () => {
    if (!form.my_commitment.trim() && !form.advisor_said.trim()) return
    await post('/advisor/notes', form, { idem: idem.key })
    idem.reset()
    setForm({ scene: '组会', advisor_said: '', my_commitment: '', due_date: '' })
    load()
  }

  const close = async (id: number) => {
    await patch(`/advisor/notes/${id}`, { status: 'closed' })
    load()
  }

  const gen = async () => {
    const r: any = await draftTask.run(() => post('/advisor/draft', draft, { ok: false }))
    if (!r || r.ok === false) return
    setOut(r.result)
  }

  return (
    <div className="flex flex-col gap-4">
      {pending.filter((p) => p.overdue).length > 0 && (
        <div className="rounded-xl border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-4 py-3">
          <div className="text-[13px] font-medium text-[color:var(--wb-danger)]">
            有 {pending.filter((p) => p.overdue).length} 项对导师的承诺已逾期
          </div>
          {pending
            .filter((p) => p.overdue)
            .map((p) => (
              <div key={p.id} className="mt-1 text-[12px] text-[color:var(--wb-danger)]">
                · {p.my_commitment || '（空）'}（截止 {p.due_date}）
              </div>
            ))}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="记录一次沟通">
          <div className="flex flex-col gap-2">
            <Select
              value={form.scene}
              onChange={(v) => setForm({ ...form, scene: v })}
              options={SCENES.map((s) => ({ value: s, label: s }))}
            />
            <TextArea
              rows={2}
              placeholder="导师说了什么（记关键词即可）"
              value={form.advisor_said}
              onChange={(v) => setForm({ ...form, advisor_said: v })}
            />
            <TextArea
              rows={2}
              placeholder="我答应了什么（核心字段）"
              value={form.my_commitment}
              onChange={(v) => setForm({ ...form, my_commitment: v })}
            />
            <label className="flex items-center justify-between text-[12px] text-[color:var(--wb-text-soft)]">
              截止日期
              <Input
                className="w-40"
                type="date"
                value={form.due_date}
                onChange={(v) => setForm({ ...form, due_date: v })}
              />
            </label>
            <Btn variant="primary" onClick={add}>
              保存
            </Btn>
          </div>
        </Card>

        <Card title="AI 话术生成">
          <div className="flex flex-col gap-2">
            <Select
              value={draft.scene}
              onChange={(v) => setDraft({ ...draft, scene: v })}
              options={DRAFT_SCENES.map((s) => ({ value: s, label: s }))}
            />
            <TextArea
              rows={2}
              placeholder="本周实际进展"
              value={draft.progress}
              onChange={(v) => setDraft({ ...draft, progress: v })}
            />
            <TextArea
              rows={2}
              placeholder="遇到的困难 / 卡点"
              value={draft.blockers}
              onChange={(v) => setDraft({ ...draft, blockers: v })}
            />
            <TextArea
              rows={2}
              placeholder="我想向导师提出什么"
              value={draft.ask}
              onChange={(v) => setDraft({ ...draft, ask: v })}
            />
            <Btn variant="primary" onClick={gen} loading={draftTask.busy}>
              生成三版话术
            </Btn>
            {draftTask.error && (
              <AiError
                error={draftTask.error}
                onRetry={gen}
                retrying={draftTask.busy}
                title="话术没有生成"
              />
            )}
          </div>
        </Card>
      </div>

      {out && !draftTask.error && (
        <Card title="话术草稿" extra={<Btn variant="ghost" onClick={() => setOut(null)}>关闭</Btn>}>
          <MdBlock text={out} />
          <AiMeta res={draftTask.data || {}} />
        </Card>
      )}

      <Card title={`沟通档案（${notes.length}）`}>
        {notes.length === 0 ? (
          <Empty text="还没有记录。下次组会结束花 1 分钟记一条。" />
        ) : (
          <div className="flex flex-col gap-2">
            {notes.map((n) => (
              <div key={n.id} className="rounded-lg border border-[color:var(--wb-border)] p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Pill tone="blue">{n.scene}</Pill>
                    <span className="text-[11.5px] text-[color:var(--wb-muted)]">{n.date}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {n.status === 'open' ? (
                      <>
                        {n.due_date && (
                          <Pill tone={n.due_date < new Date().toISOString().slice(0, 10) ? 'red' : 'gray'}>
                            截止 {n.due_date}
                          </Pill>
                        )}
                        <Btn onClick={() => close(n.id)}>标记完成</Btn>
                      </>
                    ) : (
                      <Pill tone="green">已闭合</Pill>
                    )}
                    <Btn
                      variant="danger"
                      onClick={async () => {
                        await del(`/advisor/notes/${n.id}`)
                        load()
                      }}
                    >
                      删除
                    </Btn>
                  </div>
                </div>
                {n.advisor_said && (
                  <div className="mt-2 text-[12px] text-[color:var(--wb-text-soft)]">导师：{n.advisor_said}</div>
                )}
                {n.my_commitment && (
                  <div className="mt-1 text-[12px] font-medium text-[color:var(--wb-text)]">
                    我的承诺：{n.my_commitment}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
