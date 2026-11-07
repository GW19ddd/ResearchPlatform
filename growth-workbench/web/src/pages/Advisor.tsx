import { useEffect, useState } from 'react'
import {
  Btn,
  Card,
  Empty,
  Input,
  MdBlock,
  Modal,
  PageHeader,
  Pill,
  Select,
  StatCard,
  StatusTag,
  TextArea,
} from '../components/ui'
import { AiError, AiMeta } from '../components/AiError'
import { del, get, patch, post } from '../lib/api'
import { useAiTask, useIdemKey } from '../lib/hooks'
import { usePersist } from '../lib/state'

const SCENES = ['组会', '微信', '邮件', '走廊偶遇']
const DRAFT_SCENES = ['周报', '求助', '要资源', '推进度', '请假或缓期']

type AiOut = { title: string; text: string; meta?: any } | null

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
  const [out, setOut] = usePersist<AiOut>('adv.out', null)
  const draftTask = useAiTask<any>()
  const extractTask = useAiTask<any>()
  // 记承诺是一次性写操作：双击容易记两条，同 key 后端只写一次
  const idem = useIdemKey()
  // 纪要抽取弹窗
  const [extractOpen, setExtractOpen] = useState(false)
  const [rawText, setRawText] = useState('')
  const [ext, setExt] = useState<any>(null)

  const load = async () => {
    setNotes(await get('/advisor/notes'))
    setPending(await get('/advisor/pending'))
  }

  useEffect(() => {
    load()
  }, [])

  const add = async (data?: any) => {
    const body = data || form
    if (!String(body.my_commitment || '').trim() && !String(body.advisor_said || '').trim()) return
    await post('/advisor/notes', body, { idem: data ? undefined : idem.key })
    if (!data) idem.reset()
    setForm({ scene: '组会', advisor_said: '', my_commitment: '', due_date: '' })
    load()
  }

  const close = async (id: number) => {
    await patch(`/advisor/notes/${id}`, { status: 'closed' })
    load()
  }

  const reopen = async (id: number) => {
    await patch(`/advisor/notes/${id}`, { status: 'open' }, { ok: false })
    load()
  }

  const gen = async () => {
    const r: any = await draftTask.run(() => post('/advisor/draft', draft, { ok: false }))
    if (!r || r.ok === false) return
    setOut({ title: '话术草稿（三版 + 风险标注）', text: r.result, meta: r })
  }

  // ---- AI 纪要抽取：贴原文 → 抽结构化 → 确认入库 ----
  const doExtract = async () => {
    const r: any = await extractTask.run(() => post('/advisor/extract', { raw: rawText }, { ok: false }))
    if (!r || r.ok === false) return
    setExt(r.extracted)
  }

  const saveExtracted = async () => {
    if (!ext) return
    await add({
      scene: ext.scene || '组会',
      advisor_said: ext.advisor_said || '',
      my_commitment: ext.my_commitment || '',
      due_date: ext.due_date || '',
    })
    setExtractOpen(false)
    setRawText('')
    setExt(null)
  }

  const overdue = pending.filter((p) => p.overdue)
  const closedCount = notes.filter((n) => n.status === 'closed').length
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="复盘 · 02"
        title="导师"
        desc="记承诺 → 写话术：先别漏掉任何一句答应过的话"
        actions={
          <Btn variant="primary" onClick={() => { setExtractOpen(true); setExt(null) }}>
            AI 纪要抽取
          </Btn>
        }
      />

      {/* 逾期红警：置顶展示，无法忽略 */}
      {overdue.length > 0 && (
        <div className="rounded-xl border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--wb-danger)]">
            <StatusTag tone="danger">逾期</StatusTag>
            有 {overdue.length} 项对导师的承诺已逾期
          </div>
          {overdue.map((p) => (
            <div key={p.id} className="mt-1.5 flex items-center justify-between gap-2 pl-1 text-[12px] text-[color:var(--wb-danger)]">
              <span>
                · {p.my_commitment || '（空承诺）'}（截止 {p.due_date}）
              </span>
              <Btn size="xs" onClick={() => close(p.id)}>
                标记完成
              </Btn>
            </div>
          ))}
        </div>
      )}

      {/* 台账统计 */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="进行中的承诺" value={pending.length} unit="项" tone={pending.length > 0 ? 'accent' : 'default'} />
        <StatCard label="已闭合" value={closedCount} unit="项" tone="ok" />
        <StatCard label="逾期" value={overdue.length} unit="项" tone={overdue.length > 0 ? 'danger' : 'ok'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* 左：沟通档案时间线 */}
        <Card title={`沟通档案（${notes.length}）`} className="lg:col-span-3" bodyClassName="p-4">
          {notes.length === 0 ? (
            <Empty
              text="还没有记录"
              hint="下次组会结束花 1 分钟记一条，或者把聊天记录直接丢给「AI 纪要抽取」。"
            />
          ) : (
            <div className="relative">
              {/* 时间线竖线 */}
              <span aria-hidden className="absolute bottom-2 left-[7px] top-2 w-px bg-[color:var(--wb-border)]" />
              <div className="flex flex-col gap-3">
                {notes.map((n) => (
                  <div key={n.id} className="relative pl-6">
                    {/* 时间线圆点 */}
                    <span
                      aria-hidden
                      className={`absolute left-0 top-[14px] h-[15px] w-[15px] rounded-full border-[3px] bg-[color:var(--wb-surface)] ${
                        n.status === 'closed'
                          ? 'border-[color:var(--wb-ok)]'
                          : n.due_date && n.due_date < today
                            ? 'border-[color:var(--wb-danger)]'
                            : 'border-[color:var(--wb-accent)]'
                      }`}
                    />
                    <div className="rounded-lg border border-[color:var(--wb-border)] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Pill tone="blue">{n.scene}</Pill>
                          <span className="text-[11.5px] text-[color:var(--wb-muted)]">{n.date}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          {n.status === 'open' ? (
                            <>
                              {n.due_date && (
                                <Pill tone={n.due_date < today ? 'red' : 'gray'}>截止 {n.due_date}</Pill>
                              )}
                              <Btn size="xs" onClick={() => close(n.id)}>
                                完成承诺
                              </Btn>
                            </>
                          ) : (
                            <>
                              <StatusTag tone="ok">已闭合</StatusTag>
                              <Btn size="xs" variant="ghost" onClick={() => reopen(n.id)} title="重新打开这条承诺">
                                重开
                              </Btn>
                            </>
                          )}
                          <Btn
                            size="xs"
                            variant="danger"
                            onClick={async () => {
                              if (!window.confirm('删掉这条沟通记录？不可撤销')) return
                              await del(`/advisor/notes/${n.id}`)
                              load()
                            }}
                          >
                            删
                          </Btn>
                        </div>
                      </div>
                      {n.advisor_said && (
                        <div className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
                          导师：{n.advisor_said}
                        </div>
                      )}
                      {n.my_commitment && (
                        <div className="mt-1.5 whitespace-pre-wrap rounded-md bg-[color:var(--wb-bg-subtle)] px-2.5 py-1.5 text-[12px] font-medium leading-relaxed text-[color:var(--wb-text)]">
                          我的承诺：{n.my_commitment}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* 右：承诺台账 + 记沟通 + AI 话术 */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card title="承诺台账" bodyClassName="p-4">
            {pending.length === 0 ? (
              <Empty text="没有进行中的承诺" hint="要么都做完了，要么还没记过。" />
            ) : (
              <div className="flex flex-col gap-2">
                {pending.map((p) => (
                  <div
                    key={p.id}
                    className={`flex items-start justify-between gap-2 rounded-lg border p-2.5 ${
                      p.overdue
                        ? 'border-[color:var(--wb-danger)]/35 bg-[color:var(--wb-danger-soft)]'
                        : 'border-[color:var(--wb-border)]'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium leading-snug text-[color:var(--wb-text)]">
                        {p.my_commitment || '（空承诺）'}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-[color:var(--wb-muted)]">
                        <Pill tone="blue">{p.scene}</Pill>
                        {p.due_date ? (
                          <Pill tone={p.overdue ? 'red' : 'gray'}>{p.overdue ? '已逾期' : '截止'} {p.due_date}</Pill>
                        ) : (
                          <span>未设截止</span>
                        )}
                      </div>
                    </div>
                    <Btn size="xs" onClick={() => close(p.id)}>
                      完成
                    </Btn>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="快速记一次沟通" bodyClassName="p-4">
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
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] leading-snug text-[color:var(--wb-muted)]">
                  懒得整理？把原始记录丢给
                  <button
                    type="button"
                    className="mx-0.5 text-[color:var(--wb-accent)] underline-offset-2 hover:underline"
                    onClick={() => { setExtractOpen(true); setExt(null) }}
                  >
                    AI 纪要抽取
                  </button>
                </span>
                <Btn variant="primary" onClick={() => add()}>
                  保存
                </Btn>
              </div>
            </div>
          </Card>

          <Card title="AI 话术生成" bodyClassName="p-4">
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
                生成三版话术（含风险标注）
              </Btn>
              {draftTask.error && (
                <AiError error={draftTask.error} onRetry={gen} retrying={draftTask.busy} title="话术没有生成" />
              )}
            </div>
          </Card>
        </div>
      </div>

      {out && !draftTask.error && (
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

      {/* AI 纪要抽取弹窗 */}
      <Modal open={extractOpen} onClose={() => setExtractOpen(false)} title="AI 纪要抽取" width="max-w-2xl">
        {!ext ? (
          <div className="flex flex-col gap-3">
            <div className="text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
              把跟导师的聊天记录、组会速记或邮件原文贴进来，AI 会拆出「导师说的 / 我答应的 / 截止日」，确认后再入库。
            </div>
            <TextArea
              rows={10}
              placeholder={'例如：\n今天组会导师说我实验对比不够，让我把 baseline 补全，下周五之前给他看结果。还说论文框架可以先搭起来…'}
              value={rawText}
              onChange={setRawText}
            />
            {extractTask.error && (
              <AiError error={extractTask.error} onRetry={doExtract} retrying={extractTask.busy} title="抽取没有跑通" />
            )}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setExtractOpen(false)}>
                取消
              </Btn>
              <Btn variant="primary" onClick={doExtract} loading={extractTask.busy} disabled={!rawText.trim()}>
                抽取
              </Btn>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">场景</span>
                <Select
                  value={ext.scene || '组会'}
                  onChange={(v) => setExt({ ...ext, scene: v })}
                  options={SCENES.map((s) => ({ value: s, label: s }))}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">截止日期</span>
                <Input
                  type="date"
                  value={ext.due_date || ''}
                  onChange={(v) => setExt({ ...ext, due_date: v })}
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">导师说了什么</span>
              <TextArea
                rows={3}
                value={ext.advisor_said || ''}
                onChange={(v) => setExt({ ...ext, advisor_said: v })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">我答应了什么</span>
              <TextArea
                rows={3}
                value={ext.my_commitment || ''}
                onChange={(v) => setExt({ ...ext, my_commitment: v })}
              />
            </label>
            {ext.risks && (
              <div className="rounded-lg border border-[color:var(--wb-warn)]/35 bg-[color:var(--wb-warn-soft)] px-3 py-2 text-[12px] leading-relaxed text-[color:var(--wb-warn)]">
                风险提示：{ext.risks}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setExt(null)}>
                重新抽取
              </Btn>
              <Btn variant="primary" onClick={saveExtracted}>
                确认入库
              </Btn>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
