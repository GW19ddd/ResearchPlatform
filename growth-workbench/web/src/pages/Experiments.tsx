import { useEffect, useMemo, useState } from 'react'
import {
  Btn,
  Card,
  Empty,
  IconBtn,
  Input,
  MdBlock,
  Modal,
  PageHeader,
  Pill,
  Progress,
  Select,
  StatCard,
  StatusTag,
  TextArea,
} from '../components/ui'
import { AiError, AiMeta } from '../components/AiError'
import {
  BulkBar,
  ExportCol,
  RowCheck,
  SelectToggle,
  downloadText,
  stamp,
  toCsv,
  toMarkdown,
  useBulk,
} from '../components/BulkBar'
import { toast } from '../components/toast'
import { del, get, patch, post } from '../lib/api'
import { useAiTask, useIdemKey } from '../lib/hooks'
import { usePersist } from '../lib/state'

const STATUS = [
  { value: 'planned', label: '待跑' },
  { value: 'running', label: '进行中' },
  { value: 'analyzing', label: '分析中' },
  { value: 'done', label: '已完成' },
]

const STATUS_TONE: Record<string, 'gray' | 'busy' | 'info' | 'ok'> = {
  planned: 'gray',
  running: 'busy',
  analyzing: 'info',
  done: 'ok',
}

const EXP_COLS: ExportCol[] = [
  { key: 'name', label: '实验名称' },
  { key: 'hypothesis', label: '假设' },
  { key: 'design', label: '设计' },
  { key: 'status', label: '状态' },
  { key: 'conclusion', label: '结论' },
]

type AiOut = { title: string; text: string; meta?: any } | null

export default function Experiments() {
  const [exps, setExps] = useState<any[]>([])
  const [ideas, setIdeas] = useState<any[]>([])
  const [sel, setSel] = usePersist<number | null>('exp.sel', null)
  const [results, setResults] = useState<any[]>([])
  const [form, setForm] = usePersist<any>('exp.form', { name: '', hypothesis: '', design: '', idea_id: '' })
  const [res, setRes] = usePersist<any>('exp.res', { case_name: '', method: '', success: 0, metrics_json: '', notes: '' })
  // 筛选与弹窗
  const [kw, setKw] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [formOpen, setFormOpen] = useState(false)
  // AI 输出统一走一张卡：{title, text, meta}
  const [out, setOut] = usePersist<AiOut>('exp.out', null)
  // 分析失败不覆盖已有结论：后端只在成功时写库，这里只在成功时展示
  const anTask = useAiTask<any>()
  const failTask = useAiTask<any>()
  const reviewTask = useAiTask<any>()
  const cmpTask = useAiTask<any>()
  const idem = useIdemKey()
  // 列表多选（跟「当前查看的实验」sel 各管各的）：默认关闭，点「多选」才出现复选框
  const bulk = useBulk()
  const [multi, setMulti] = useState(false)
  const [bulkDel, setBulkDel] = useState(false)

  const toggleMulti = () => {
    if (multi) bulk.clear() // 退出时清空，避免下次进来带着看不见的旧勾选
    setMulti(!multi)
  }

  const load = async () => {
    const e = await get('/experiments')
    setExps(e)
    setIdeas(await get('/ideas'))
    if (sel === null && e.length) setSel(e[0].id)
  }
  const loadResults = async (id: number) => setResults(await get(`/experiments/${id}/results`))

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (sel !== null) loadResults(sel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])

  const add = async () => {
    if (!form.name.trim()) return
    const r = await post(
      '/experiments',
      {
        name: form.name,
        hypothesis: form.hypothesis,
        design: form.design,
        idea_id: form.idea_id ? Number(form.idea_id) : null,
        status: 'planned',
      },
      { idem: idem.key },
    )
    idem.reset()
    setForm({ name: '', hypothesis: '', design: '', idea_id: '' })
    setFormOpen(false)
    setSel(r.id)
    load()
  }

  const setStatus = async (id: number, status: string) => {
    await patch(`/experiments/${id}`, { status })
    load()
  }

  const saveDetail = async (field: 'hypothesis' | 'design', value: string) => {
    if (sel === null) return
    await patch(`/experiments/${sel}`, { [field]: value }, { ok: false })
    load()
  }

  const addResult = async () => {
    if (!res.case_name.trim() || sel === null) return
    await post(`/experiments/${sel}/results`, res)
    setRes({ case_name: '', method: '', success: 0, metrics_json: '', notes: '' })
    loadResults(sel)
    load()
  }

  const analyze = async () => {
    if (sel === null) return
    const r: any = await anTask.run(() => post(`/experiments/${sel}/analysis`, undefined, { ok: false }))
    if (!r || r.ok === false) return
    setOut({ title: 'AI 分析 · 假设验证', text: r.result, meta: r })
    load()
  }

  const failAttrib = async () => {
    if (sel === null) return
    const r: any = await failTask.run(() => post(`/experiments/${sel}/failures`, undefined, { ok: false }))
    if (r && r.ok !== false) setOut({ title: 'AI 归因 · 失败模式分析', text: r.result, meta: r })
  }

  const designReview = async () => {
    if (sel === null) return
    const r: any = await reviewTask.run(() => post(`/experiments/${sel}/design-review`, {}, { ok: false }))
    if (r && r.ok !== false) setOut({ title: 'AI 预审 · 实验设计', text: r.result, meta: r })
  }

  const compare = async () => {
    const ids = bulk.ids
    if (ids.length < 2) return
    const r: any = await cmpTask.run(() => post('/experiments/compare', { ids }, { ok: false }))
    if (r && r.ok !== false) setOut({ title: `AI 对比 · ${ids.length} 个实验`, text: r.result, meta: r })
  }

  // ---- 筛选：关键字 + 状态 ----
  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return exps.filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false
      if (!k) return true
      return [e.name, e.hypothesis, e.design].some((t: string) => (t || '').toLowerCase().includes(k))
    })
  }, [exps, kw, statusFilter])

  // ---- 批量操作：按勾选顺序取行，状态翻中文 ----
  const selectedRows = () => {
    const byId = new Map(exps.map((e) => [e.id, e]))
    return bulk.ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((e: any) => ({
        ...e,
        status: STATUS.find((s) => s.value === e.status)?.label || e.status,
      }))
  }

  const exportExps = (fmt: 'md' | 'csv') => {
    const rows = selectedRows()
    if (!rows.length) return
    const base = stamp('实验')
    if (fmt === 'csv') {
      downloadText(`${base}.csv`, toCsv(rows, EXP_COLS), 'text/csv;charset=utf-8')
    } else {
      downloadText(`${base}.md`, toMarkdown('实验', rows, EXP_COLS), 'text/markdown;charset=utf-8')
    }
    toast(`已导出 ${rows.length} 个实验`, 'ok')
  }

  const bulkDrop = async () => {
    const ids = bulk.ids
    if (!ids.length) return
    if (!window.confirm(`删掉选中的 ${ids.length} 个实验？结果记录会一起清掉，不可撤销`)) return
    setBulkDel(true)
    try {
      await post('/experiments/bulk-delete', { ids }, { ok: `已删除 ${ids.length} 个实验` })
      bulk.clear()
      if (sel !== null && ids.includes(sel)) setSel(null)
      load()
    } finally {
      setBulkDel(false)
    }
  }

  const current = exps.find((e) => e.id === sel)
  const successRate =
    results.length > 0 ? Math.round((results.filter((r) => r.success).length / results.length) * 100) : 0
  const countBy = (s: string) => exps.filter((e) => e.status === s).length

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="执行 · 01"
        title="实验"
        desc="假设 → 设计 → 记录 → 结论：每个实验都要闭环"
        actions={
          <Btn variant="primary" onClick={() => setFormOpen(true)}>
            新建实验
          </Btn>
        }
      />

      {/* 顶部统计条 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="实验总数" value={exps.length} unit="个" />
        <StatCard
          label="进行中"
          value={countBy('running') + countBy('analyzing')}
          unit="个"
          tone="accent"
          hint={`待跑 ${countBy('planned')} 个`}
        />
        <StatCard
          label="已完成"
          value={countBy('done')}
          unit="个"
          tone={exps.length > 0 && countBy('done') === exps.length ? 'ok' : 'default'}
          hint={
            exps.length > 0
              ? `完成率 ${Math.round((countBy('done') / exps.length) * 100)}%`
              : undefined
          }
        />
        <StatCard
          label="当前实验成功率"
          value={successRate}
          unit="%"
          tone={successRate >= 60 ? 'ok' : successRate > 0 ? 'warn' : 'default'}
          hint={current ? results.length > 0 ? `「${current.name}」共 ${results.length} 条记录` : '暂无结果记录' : '未选中实验'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* 左：实验列表（筛选 + 多选） */}
        <Card
          title={`实验列表（${filtered.length}）`}
          className="lg:col-span-2"
          bodyClassName="p-3"
          extra={
            exps.length > 0 ? (
              <SelectToggle on={multi} onToggle={toggleMulti} title="进入多选，可批量导出、删除或 AI 对比" />
            ) : null
          }
        >
          <div className="mb-2 flex items-center gap-2">
            <Input
              placeholder="搜名称 / 假设 / 设计…"
              value={kw}
              onChange={setKw}
              className="flex-1"
            />
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              options={[{ value: 'all', label: '全部状态' }, ...STATUS]}
            />
          </div>

          {exps.length === 0 ? (
            <Empty
              text="还没有实验"
              hint="点右上角「新建实验」，把假设写下来再跑——事后想补假设是科研里最贵的债。"
            />
          ) : filtered.length === 0 ? (
            <Empty text="没有匹配的实验" hint="换个关键词或状态筛选试试。" />
          ) : (
            <div className="flex flex-col gap-1.5">
              {multi && (
                <BulkBar
                  count={bulk.count}
                  total={exps.length}
                  unit="个"
                  onSelectAll={() => bulk.setAll(filtered.map((e) => e.id))}
                  onClear={bulk.clear}
                  onDelete={bulkDrop}
                  deleting={bulkDel}
                  exports={[
                    { label: 'AI 对比分析', run: compare },
                    { label: '导出 Markdown', run: () => exportExps('md') },
                    { label: '导出 CSV', run: () => exportExps('csv') },
                  ]}
                />
              )}
              {filtered.map((e) => (
                <div
                  key={e.id}
                  onClick={() => (multi ? bulk.toggle(e.id) : setSel(e.id))}
                  className={`cursor-pointer rounded-lg border px-3 py-2.5 transition ${
                    multi && bulk.has(e.id)
                      ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)]'
                      : sel === e.id
                        ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface-alt)]'
                        : 'border-[color:var(--wb-border)] hover:bg-[color:var(--wb-surface-alt)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    {multi && <RowCheck checked={bulk.has(e.id)} onChange={() => bulk.toggle(e.id)} />}
                    <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--wb-text)]">
                      {e.name}
                    </div>
                    <StatusTag tone={STATUS_TONE[e.status] || 'gray'}>
                      {STATUS.find((s) => s.value === e.status)?.label}
                    </StatusTag>
                  </div>
                  {e.hypothesis && (
                    <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
                      {e.hypothesis}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* 右：实验详情台（假设/设计 → 结果 → 结论） */}
        {current ? (
          <div className="flex flex-col gap-4 lg:col-span-3">
            <Card
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{current.name}</span>
                  <StatusTag tone={STATUS_TONE[current.status] || 'gray'}>
                    {STATUS.find((s) => s.value === current.status)?.label}
                  </StatusTag>
                </span>
              }
              extra={
                <>
                  <Select
                    value={current.status}
                    onChange={(v) => setStatus(current.id, v)}
                    options={STATUS}
                  />
                  <IconBtn
                    icon="trash"
                    size="sm"
                    tone="danger"
                    title="删除该实验"
                    onClick={async () => {
                      if (!window.confirm(`删掉「${current.name}」？结果记录一起清掉，不可撤销`)) return
                      await del(`/experiments/${current.id}`)
                      setSel(null)
                      load()
                    }}
                  />
                </>
              }
            >
              {/* 假设 / 设计：直接编辑，失焦保存 */}
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">假设</span>
                  <TextArea
                    rows={3}
                    defaultValue={current.hypothesis || ''}
                    placeholder="我预期 X 会优于 Y，因为…"
                    onBlur={(e) => {
                      if (e.target.value !== (current.hypothesis || '')) saveDetail('hypothesis', e.target.value)
                    }}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">设计（方法 × 样本 × 指标）</span>
                  <TextArea
                    rows={3}
                    defaultValue={current.design || ''}
                    placeholder="基线 / 数据集 / 评价指标 / 重复次数…"
                    onBlur={(e) => {
                      if (e.target.value !== (current.design || '')) saveDetail('design', e.target.value)
                    }}
                  />
                </label>
              </div>

              {/* AI 操作条：按「跑前 → 跑后」排列 */}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[color:var(--wb-border)] pt-3">
                <span className="mr-1 flex items-center gap-1 text-[11.5px] text-[color:var(--wb-muted)]">
                  AI 助手
                </span>
                <Btn size="sm" onClick={designReview} loading={reviewTask.busy} title="开跑之前先让 AI 挑一遍设计毛病">
                  设计预审
                </Btn>
                <Btn size="sm" onClick={analyze} loading={anTask.busy} title="基于全部结果记录验证假设">
                  分析结果
                </Btn>
                <Btn size="sm" onClick={failAttrib} loading={failTask.busy} title="只看失败样本，归因并给验证动作">
                  失败归因
                </Btn>
                <span className="ml-auto text-[11.5px] text-[color:var(--wb-muted)]">
                  多选 2+ 个实验可做 AI 对比
                </span>
              </div>
              {(anTask.error || failTask.error || reviewTask.error) && (
                <div className="mt-2.5">
                  {anTask.error && (
                    <AiError error={anTask.error} onRetry={analyze} retrying={anTask.busy} title="分析没有跑通，已有结论保持不变" />
                  )}
                  {failTask.error && (
                    <AiError error={failTask.error} onRetry={failAttrib} retrying={failTask.busy} title="归因没有跑通" />
                  )}
                  {reviewTask.error && (
                    <AiError error={reviewTask.error} onRetry={designReview} retrying={reviewTask.busy} title="预审没有跑通" />
                  )}
                </div>
              )}
            </Card>

            <Card
              title="结果记录"
              extra={
                <span className="text-[12px] text-[color:var(--wb-text-soft)]">
                  {results.length > 0 ? `${results.filter((r) => r.success).length}/${results.length} 成功` : '暂无'}
                </span>
              }
            >
              <div className="mb-3 grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                <Input placeholder="case 名" value={res.case_name} onChange={(v) => setRes({ ...res, case_name: v })} />
                <Input placeholder="方法" value={res.method} onChange={(v) => setRes({ ...res, method: v })} />
                <Input
                  placeholder='指标 JSON，例 {"acc":0.6}'
                  value={res.metrics_json}
                  onChange={(v) => setRes({ ...res, metrics_json: v })}
                />
                <div className="flex items-center gap-1">
                  <label className="flex items-center gap-1 text-[12px] text-[color:var(--wb-text-soft)]">
                    <input
                      type="checkbox"
                      checked={!!res.success}
                      onChange={(e) => setRes({ ...res, success: e.target.checked ? 1 : 0 })}
                    />
                    成功
                  </label>
                  <Btn variant="primary" onClick={addResult}>
                    记录
                  </Btn>
                </div>
              </div>

              {results.length === 0 ? (
                <Empty text="还没有结果记录" hint="跑完一组就录一条：case 名 + 方法 + 成败 + 指标。后续 AI 归因和分析全靠这些记录。" />
              ) : (
                <>
                  <div className="mb-3">
                    <Progress value={results.filter((r) => r.success).length} max={results.length} tone="ok" showLabel />
                  </div>
                  <div className="max-h-[320px] overflow-auto">
                    <table className="w-full min-w-[560px] border-collapse text-[12px]">
                      <thead className="sticky top-0 bg-[color:var(--wb-surface)]">
                        <tr>
                          {['case', '方法', '结果', '指标', '备注', ''].map((h) => (
                            <th
                              key={h}
                              className="border-b border-[color:var(--wb-border)] px-2 py-2 text-left font-medium text-[color:var(--wb-text-soft)]"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r) => (
                          <tr key={r.id}>
                            <td className="border-b border-[color:var(--wb-border)] px-2 py-1.5">{r.case_name}</td>
                            <td className="border-b border-[color:var(--wb-border)] px-2 py-1.5">{r.method || '—'}</td>
                            <td className="border-b border-[color:var(--wb-border)] px-2 py-1.5">
                              <Pill tone={r.success ? 'green' : 'red'}>{r.success ? '成功' : '失败'}</Pill>
                            </td>
                            <td className="border-b border-[color:var(--wb-border)] px-2 py-1.5 font-mono text-[11.5px]">
                              {r.metrics_json || '—'}
                            </td>
                            <td className="border-b border-[color:var(--wb-border)] px-2 py-1.5 text-[color:var(--wb-text-soft)]">
                              {r.notes || '—'}
                            </td>
                            <td className="border-b border-[color:var(--wb-border)] px-2 py-1.5">
                              <IconBtn
                                icon="trash"
                                size="sm"
                                tone="danger"
                                title="删除该结果"
                                onClick={async () => {
                                  await del(`/results/${r.id}`)
                                  if (sel !== null) loadResults(sel)
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>

            {current.conclusion && (
              <Card
                title="AI 结论（已存档）"
                extra={<span className="text-[11.5px] text-[color:var(--wb-muted)]">来自「分析结果」，重新分析会覆盖</span>}
              >
                <MdBlock text={current.conclusion} />
              </Card>
            )}
          </div>
        ) : (
          <Card className="lg:col-span-3">
            <Empty
              text="从左侧选一个实验"
              hint="详情台会展示假设、设计、结果记录与 AI 结论。"
            />
          </Card>
        )}
      </div>

      {/* AI 输出（统一一张卡，随内容渲染） */}
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

      {/* 新建实验弹窗 */}
      <Modal open={formOpen} onClose={() => setFormOpen(false)} title="新建实验" width="max-w-xl">
        <div className="flex flex-col gap-2.5">
          <Input placeholder="实验名称（必填）" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <TextArea
            rows={3}
            placeholder="假设：我预期 X 会优于 Y，因为…"
            value={form.hypothesis}
            onChange={(v) => setForm({ ...form, hypothesis: v })}
          />
          <TextArea
            rows={3}
            placeholder="设计：方法 × 样本 × 指标（基线、数据集、重复次数…）"
            value={form.design}
            onChange={(v) => setForm({ ...form, design: v })}
          />
          <Select
            value={form.idea_id}
            onChange={(v) => setForm({ ...form, idea_id: v })}
            options={[
              { value: '', label: '关联创新点（可选）' },
              ...ideas.map((i) => ({ value: String(i.id), label: i.title })),
            ]}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="ghost" onClick={() => setFormOpen(false)}>
              取消
            </Btn>
            <Btn
              variant="primary"
              onClick={add}
              loading={false}
              disabled={!form.name.trim()}
            >
              创建
            </Btn>
          </div>
          <div className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            提示：创建后可以先「设计预审」，AI 会按方法学挑一遍毛病再开跑，省下白跑一周的代价。
          </div>
        </div>
      </Modal>
    </div>
  )
}
