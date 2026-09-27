import { useEffect, useState } from 'react'
import { Btn, Card, Empty, Input, MdBlock, Pill, Select, TextArea } from '../components/ui'
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

const EXP_COLS: ExportCol[] = [
  { key: 'name', label: '实验名称' },
  { key: 'hypothesis', label: '假设' },
  { key: 'design', label: '设计' },
  { key: 'status', label: '状态' },
  { key: 'conclusion', label: '结论' },
]

export default function Experiments() {
  const [exps, setExps] = useState<any[]>([])
  const [ideas, setIdeas] = useState<any[]>([])
  const [sel, setSel] = usePersist<number | null>('exp.sel', null)
  const [results, setResults] = useState<any[]>([])
  const [form, setForm] = usePersist<any>('exp.form', { name: '', hypothesis: '', design: '', idea_id: '' })
  const [res, setRes] = usePersist<any>('exp.res', { case_name: '', method: '', success: 0, metrics_json: '', notes: '' })
  const [out, setOut] = usePersist<string | null>('exp.out', null)
  // 分析失败不覆盖已有结论：后端只在成功时写库，这里只在成功时展示
  const anTask = useAiTask<any>()
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
  }, [])

  useEffect(() => {
    if (sel !== null) loadResults(sel)
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
    setSel(r.id)
    load()
  }

  const setStatus = async (id: number, status: string) => {
    await patch(`/experiments/${id}`, { status })
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
    const r: any = await anTask.run(() =>
      post(`/experiments/${sel}/analysis`, undefined, { ok: false }),
    )
    if (!r || r.ok === false) return
    setOut(r.result)
    load()
  }

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
    results.length > 0
      ? Math.round((results.filter((r) => r.success).length / results.length) * 100)
      : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="新建实验">
          <div className="flex flex-col gap-2">
            <Input placeholder="实验名称（必填）" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <TextArea
              rows={2}
              placeholder="假设：我预期 X 会优于 Y，因为…"
              value={form.hypothesis}
              onChange={(v) => setForm({ ...form, hypothesis: v })}
            />
            <TextArea
              rows={2}
              placeholder="设计：方法 × 样本 × 指标"
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
            <Btn variant="primary" onClick={add}>
              创建
            </Btn>
          </div>
        </Card>

        <Card
          title="实验列表"
          className="md:col-span-2"
          extra={
            exps.length > 0 ? (
              <SelectToggle
                on={multi}
                onToggle={toggleMulti}
                title="进入多选，可批量导出或删除实验"
              />
            ) : null
          }
        >
          {exps.length === 0 ? (
            <Empty text="还没有实验" />
          ) : (
            <div className="flex flex-col gap-2">
              {multi && (
                <BulkBar
                  count={bulk.count}
                  total={exps.length}
                  unit="个"
                  onSelectAll={() => bulk.setAll(exps.map((e) => e.id))}
                  onClear={bulk.clear}
                  onDelete={bulkDrop}
                  deleting={bulkDel}
                  exports={[
                    { label: '导出 Markdown', run: () => exportExps('md') },
                    { label: '导出 CSV', run: () => exportExps('csv') },
                  ]}
                />
              )}
              {exps.map((e) => (
                <div
                  key={e.id}
                  onClick={() => (multi ? bulk.toggle(e.id) : setSel(e.id))}
                  className={`cursor-pointer rounded-lg border p-3 transition ${
                    multi && bulk.has(e.id)
                      ? 'border-indigo-300 bg-indigo-50/40'
                      : sel === e.id
                        ? 'border-slate-900 bg-slate-50'
                        : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    {multi && (
                      <RowCheck checked={bulk.has(e.id)} onChange={() => bulk.toggle(e.id)} />
                    )}
                    <div className="min-w-0 flex-1 text-[13px] font-medium text-slate-900">
                      {e.name}
                    </div>
                    <div className="flex items-center gap-1">
                      <Pill tone={e.status === 'done' ? 'green' : 'gray'}>
                        {STATUS.find((s) => s.value === e.status)?.label}
                      </Pill>
                    </div>
                  </div>
                  {e.hypothesis && (
                    <div className="mt-1 line-clamp-2 text-[12px] text-slate-600">{e.hypothesis}</div>
                  )}
                  {sel === e.id && (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <Select value={e.status} onChange={(v) => setStatus(e.id, v)} options={STATUS} />
                      <Btn onClick={analyze} loading={anTask.busy}>
                        AI 分析结果
                      </Btn>
                      <Btn
                        variant="danger"
                        onClick={async () => {
                          await del(`/experiments/${e.id}`)
                          setSel(null)
                          load()
                        }}
                      >
                        删除
                      </Btn>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {current && (
        <Card
          title={`结果记录 · ${current.name}`}
          extra={<span className="text-[12px] text-slate-500">成功率 {successRate}%</span>}
        >
          <div className="mb-3 grid grid-cols-4 gap-2">
            <Input placeholder="case 名" value={res.case_name} onChange={(v) => setRes({ ...res, case_name: v })} />
            <Input placeholder="方法" value={res.method} onChange={(v) => setRes({ ...res, method: v })} />
            <Input
              placeholder='指标 JSON，例 {"acc":0.6,"t":0.3}'
              value={res.metrics_json}
              onChange={(v) => setRes({ ...res, metrics_json: v })}
            />
            <div className="flex items-center gap-1">
              <label className="flex items-center gap-1 text-[12px] text-slate-600">
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
            <Empty text="还没有结果记录" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-[12px]">
                <thead>
                  <tr>
                    {['case', '方法', '结果', '指标', '备注', ''].map((h) => (
                      <th
                        key={h}
                        className="border-b border-slate-200 px-2 py-2 text-left font-medium text-slate-500"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.id}>
                      <td className="border-b border-slate-100 px-2 py-1.5">{r.case_name}</td>
                      <td className="border-b border-slate-100 px-2 py-1.5">{r.method || '—'}</td>
                      <td className="border-b border-slate-100 px-2 py-1.5">
                        <Pill tone={r.success ? 'green' : 'red'}>
                          {r.success ? '成功' : '失败'}
                        </Pill>
                      </td>
                      <td className="border-b border-slate-100 px-2 py-1.5 font-mono text-[11px]">
                        {r.metrics_json || '—'}
                      </td>
                      <td className="border-b border-slate-100 px-2 py-1.5 text-slate-500">
                        {r.notes || '—'}
                      </td>
                      <td className="border-b border-slate-100 px-2 py-1.5">
                        <button
                          className="text-slate-300 hover:text-rose-500"
                          onClick={async () => {
                            await del(`/results/${r.id}`)
                            if (sel !== null) loadResults(sel)
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {anTask.error && (
            <div className="mt-3">
              <AiError
                error={anTask.error}
                onRetry={analyze}
                retrying={anTask.busy}
                title="分析没有跑通，已有结论保持不变"
              />
            </div>
          )}

          {current.conclusion && (
            <div className="mt-3">
              <div className="mb-1 text-[12px] text-slate-500">AI 结论</div>
              <MdBlock text={current.conclusion} />
            </div>
          )}
        </Card>
      )}

      {out && !anTask.error && (
        <Card title="AI 分析" extra={<Btn variant="ghost" onClick={() => setOut(null)}>关闭</Btn>}>
          <MdBlock text={out} />
          <AiMeta res={anTask.data || {}} />
        </Card>
      )}
    </div>
  )
}
