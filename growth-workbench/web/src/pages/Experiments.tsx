import { useEffect, useMemo, useState } from 'react'
import {
  Btn,
  Card,
  Empty,
  IconBtn,
  Input,
  MdBlock,
  Modal,
  Pill,
  Progress,
  Segmented,
  Select,
  StatusTag,
  TextArea,
} from '../components/ui'
import { AgentLab } from '../features/experiments/AgentLab'
import { ResultChart } from '../features/experiments/ResultChart'
import { AiError, AiMeta } from '../components/AiError'
import { Icon } from '../components/Icon'
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

// 数据口径三分层（借鉴 Open Science experiment-suite 的 provenance 契约）：
// 实测可进结论；模拟/示意必须与实测分开评估，严禁冒充实测
const PROV = [
  { value: 'measured', label: '实测' },
  { value: 'simulated', label: '模拟' },
  { value: 'illustrative', label: '示意' },
]
const PROV_TONE: Record<string, 'green' | 'amber' | 'gray'> = {
  measured: 'green',
  simulated: 'amber',
  illustrative: 'gray',
}
const provLabel = (p?: string) =>
  PROV.find((x) => x.value === (p || 'measured'))?.label || p || '实测'

// 运行溯源（借鉴 Open Science record_run）：算力面三 + 状态三
const RUN_SURFACE = [
  { value: 'local', label: '本地' },
  { value: 'ssh', label: 'SSH' },
  { value: 'slurm', label: 'Slurm' },
  { value: 'modal', label: 'Modal 云' },
]
const RUN_STATUS = [
  { value: 'ok', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '运行中' },
]
const RUN_STATUS_TONE: Record<string, 'green' | 'red' | 'blue'> = {
  ok: 'green',
  failed: 'red',
  running: 'blue',
}

const AUDIT_LEVEL: Record<string, { tone: 'red' | 'amber' | 'green'; label: string }> = {
  error: { tone: 'red', label: '问题' },
  warn: { tone: 'amber', label: '存疑' },
  ok: { tone: 'green', label: '通过' },
}
const AUDIT_CHECK_LABEL: Record<string, string> = {
  traceability: '溯源',
  stats: '统计',
  domain: '领域',
  integrity: '完整性',
  coverage: '覆盖',
}

const EMPTY_RUN_FORM = {
  command: '',
  surface: 'local',
  status: 'ok',
  host: '',
  job_id: '',
  wall_ms: '',
  notes: '',
  env_text: '',
  code_paths: '',
  output_paths: '',
}

const fmtSize = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

const fmtMs = (n: number) =>
  n >= 60000 ? `${(n / 60000).toFixed(1)} min` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`

const parseFiles = (s?: string): any[] => {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
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
  const [runs, setRuns] = useState<any[]>([])
  const [form, setForm] = usePersist<any>('exp.form', { name: '', hypothesis: '', design: '', idea_id: '' })
  const [res, setRes] = usePersist<any>('exp.res', {
    case_name: '',
    method: '',
    success: 0,
    metrics_json: '',
    notes: '',
    provenance: 'measured',
  })
  // 运行溯源：登记弹窗 + 展开详情的 run id
  const [runOpen, setRunOpen] = useState(false)
  const [runForm, setRunForm] = useState({ ...EMPTY_RUN_FORM })
  const [openRun, setOpenRun] = useState<number | null>(null)
  // 筛选与弹窗
  const [kw, setKw] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [formOpen, setFormOpen] = useState(false)
  // 详情台形态：agent=对话驱动（默认，Open Science 形态） / classic=表单录入
  const [tab, setTab] = usePersist<'agent' | 'classic'>('exp.tab', 'agent')
  // AI 输出统一走一张卡：{title, text, meta}
  const [out, setOut] = usePersist<AiOut>('exp.out', null)
  // 分析失败不覆盖已有结论：后端只在成功时写库，这里只在成功时展示
  const anTask = useAiTask<any>()
  const failTask = useAiTask<any>()
  const reviewTask = useAiTask<any>()
  const cmpTask = useAiTask<any>()
  const auditTask = useAiTask<any>()
  // 结构化审查 findings（level/check/title/evidence），按实验切换时清空
  const [audit, setAudit] = usePersist<any>('exp.audit', null)
  const idem = useIdemKey()
  // 列表多选（跟「当前查看的实验」sel 各管各的）：默认关闭，点「多选」才出现复选框
  const bulk = useBulk()
  const [multi, setMulti] = useState(false)
  const [bulkDel, setBulkDel] = useState(false)
  // 编辑假设/设计弹窗（默认不占视觉，点「设计」才开）
  const [designOpen, setDesignOpen] = useState(false)

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
  const loadResults = async (id: number) => {
    setResults(await get(`/experiments/${id}/results`))
    setRuns(await get(`/experiments/${id}/runs`))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (sel !== null) {
      loadResults(sel)
      setAudit(null) // 换实验后旧审查结果不再适用
    }
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

  /** 删除单个实验：列表 dock 与详情头都用它 */
  const dropExp = async (id: number) => {
    const name = exps.find((e) => e.id === id)?.name || '该实验'
    if (!window.confirm(`删掉「${name}」？结果记录一起清掉，不可撤销`)) return
    await del(`/experiments/${id}`)
    if (id === sel) setSel(null)
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
    setRes({ case_name: '', method: '', success: 0, metrics_json: '', notes: '', provenance: 'measured' })
    loadResults(sel)
    load()
  }

  // 登记运行溯源：文件 sha1 由后端现场计算；输出路径撞车时后端 409，弹窗保持打开、表单不丢
  const submitRun = async () => {
    if (!runForm.command.trim() || sel === null) return
    const paths = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
    const wm = Number(runForm.wall_ms)
    await post(
      `/experiments/${sel}/runs`,
      {
        command: runForm.command,
        surface: runForm.surface,
        status: runForm.status,
        host: runForm.host || null,
        job_id: runForm.job_id || null,
        wall_ms: runForm.wall_ms && Number.isFinite(wm) ? wm : null,
        notes: runForm.notes || null,
        env_text: runForm.env_text || null,
        code_paths: paths(runForm.code_paths),
        output_paths: paths(runForm.output_paths),
      },
      { ok: '运行已登记，输出路径此后不可复用' },
    )
    setRunOpen(false)
    setRunForm({ ...EMPTY_RUN_FORM })
    loadResults(sel)
  }

  const dropRun = async (id: number) => {
    if (!window.confirm('删除这条运行记录？（只删记录，不动磁盘上的结果文件）')) return
    await del(`/exp_runs/${id}`, { ok: false })
    if (sel !== null) loadResults(sel)
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

  // 结果审查：结构化 findings（借鉴 Open Science reviewer 的 evidence-or-silence 契约）
  const runAudit = async () => {
    if (sel === null) return
    const r: any = await auditTask.run(() => post(`/experiments/${sel}/audit`, undefined, { ok: false }))
    if (r && r.ok !== false) setAudit({ note: r.note, findings: r.findings || [], meta: r })
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

  // 满铺：根容器吃掉顶栏与状态栏之间的全部高度，两个 tab 各自 flex-1 撑满；
  // 页面身份仍由顶栏面包屑承担，不再出现右侧居中留白与底部灰底
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[color:var(--wb-surface)]">
      {/* 紧凑操作条：背景贴边满宽，只在文字上留内边距 */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-2">
        <span className="min-w-0 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
          假设 → 设计 → 记录 → 结论：每个实验都要闭环
        </span>
        <Btn variant="primary" size="sm" onClick={() => setFormOpen(true)}>
          新建实验
        </Btn>
      </div>

      {current && (
        <div className="shrink-0 border-b border-[color:var(--wb-border)] px-4 py-1.5">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'agent', label: 'Agent 实验' },
              { value: 'classic', label: '结果与运行' },
            ]}
            className="w-fit"
          />
        </div>
      )}

    {tab === 'agent' && current ? (
      <div className="flex min-h-0 flex-1 flex-col">
        {(anTask.error || failTask.error || reviewTask.error || auditTask.error) && (
          <div className="flex shrink-0 flex-col gap-2 px-4 pt-2">
            {anTask.error && (
              <AiError error={anTask.error} onRetry={analyze} retrying={anTask.busy} title="分析没有跑通，已有结论保持不变" />
            )}
            {failTask.error && (
              <AiError error={failTask.error} onRetry={failAttrib} retrying={failTask.busy} title="归因没有跑通" />
            )}
            {reviewTask.error && (
              <AiError error={reviewTask.error} onRetry={designReview} retrying={reviewTask.busy} title="预审没有跑通" />
            )}
            {auditTask.error && (
              <AiError error={auditTask.error} onRetry={runAudit} retrying={auditTask.busy} title="审查没有跑通" />
            )}
          </div>
        )}
        <div className="min-h-0 flex-1">
        <AgentLab
          exp={current}
        exps={exps}
        onSelect={setSel}
        onNew={() => setFormOpen(true)}
        onDelete={dropExp}
        onEditDesign={() => setDesignOpen(true)}
        onChanged={() => {
          if (sel !== null) loadResults(sel)
          load()
        }}
        actions={
          <>
            <Btn size="xs" variant="ghost" onClick={designReview} loading={reviewTask.busy} title="开跑前先挑一遍设计毛病">
              <span className="flex items-center gap-1 whitespace-nowrap">
                <Icon name="lightbulb" size={12} /> 设计预审
              </span>
            </Btn>
            <Btn size="xs" variant="ghost" onClick={analyze} loading={anTask.busy} title="基于全部结果验证假设">
              <span className="flex items-center gap-1 whitespace-nowrap">
                <Icon name="chart" size={12} /> 分析结果
              </span>
            </Btn>
            <Btn size="xs" variant="ghost" onClick={failAttrib} loading={failTask.busy} title="只看失败样本归因">
              <span className="flex items-center gap-1 whitespace-nowrap">
                <Icon name="target" size={12} /> 失败归因
              </span>
            </Btn>
            <Btn size="xs" variant="ghost" onClick={runAudit} loading={auditTask.busy} title="结构化审查：只查可溯源与一致性">
              <span className="flex items-center gap-1 whitespace-nowrap">
                <Icon name="shield" size={12} /> 结果审查
              </span>
            </Btn>
          </>
        }
        />
        </div>
      </div>
    ) : (
    /* 结果与运行：同样 flex-1 铺满剩余区域，内容多了在内部滚动，不再留底部灰底 */
    <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto bg-[color:var(--wb-surface)] px-4 py-3 lg:grid-cols-5">
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
            {/* 极简头部：实验名 + 状态 + 假设一句话 + 设计/删除入口 */}
            <Card
              bodyClassName="p-3"
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <Icon name="beaker" size={15} className="shrink-0 text-[color:var(--wb-accent)]" />
                  <span className="truncate">{current.name}</span>
                  <StatusTag tone={STATUS_TONE[current.status] || 'gray'}>
                    {STATUS.find((s) => s.value === current.status)?.label}
                  </StatusTag>
                </span>
              }
              extra={
                <>
                  <Btn size="sm" variant="ghost" onClick={() => setDesignOpen(true)} title="编辑假设与设计">
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      <Icon name="pencil" size={13} /> 设计
                    </span>
                  </Btn>
                  <IconBtn
                    icon="trash"
                    size="sm"
                    tone="danger"
                    title="删除该实验"
                    onClick={() => dropExp(current.id)}
                  />
                </>
              }
            >
              {current.hypothesis && (
                <div className="text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                  <span className="mr-1 font-medium text-[color:var(--wb-text)]">假设</span>
                  {current.hypothesis}
                </div>
              )}
            </Card>

            {tab === 'classic' && (
              <>
            <Card
              title="结果记录"
              tourId="tour-exp-form"
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
                <Select
                  value={res.provenance || 'measured'}
                  onChange={(v) => setRes({ ...res, provenance: v })}
                  options={PROV}
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
                <Empty text="还没有结果记录" hint="跑完一组就录一条：case 名 + 方法 + 成败 + 指标 + 数据口径。后续 AI 归因和分析全靠这些记录。" />
              ) : (
                <>
                  {results.some((r) => (r.provenance || 'measured') !== 'measured') && (
                    <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-[color:var(--wb-warn-soft)] px-2.5 py-1.5 text-[12px] text-[color:var(--wb-warn)]">
                      <Icon name="alert" size={13} />
                      <span>
                        含 {results.filter((r) => (r.provenance || 'measured') !== 'measured').length} 条
                        模拟/示意口径数据——分析结论须与实测口径分开评估，模拟数据不得冒充实测
                      </span>
                    </div>
                  )}
                  <div className="mb-3">
                    <Progress value={results.filter((r) => r.success).length} max={results.length} tone="ok" showLabel />
                  </div>
                  <div className="max-h-[320px] overflow-auto">
                    <table className="w-full min-w-[640px] border-collapse text-[12px]">
                      <thead className="sticky top-0 bg-[color:var(--wb-surface)]">
                        <tr>
                          {['case', '方法', '结果', '口径', '指标', '备注', ''].map((h) => (
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
                            <td className="border-b border-[color:var(--wb-border)] px-2 py-1.5">
                              <Pill tone={PROV_TONE[r.provenance || 'measured'] || 'gray'}>
                                {provLabel(r.provenance)}
                              </Pill>
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

            <ResultChart expId={current.id} resultsCount={results.length} />

            <Card
              title="运行记录"
              extra={
                <Btn size="sm" onClick={() => setRunOpen(true)}>
                  登记运行
                </Btn>
              }
            >
              {runs.length === 0 ? (
                <Empty
                  text="还没有运行记录"
                  hint="每跑一次就登记一条：命令、算力面、环境快照、代码与输出文件。文件会被 sha1 钉码，输出路径登记后不可被新 run 复用——重跑覆盖旧结果在机制上被禁止。"
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {runs.map((r) => {
                    const codeFiles = parseFiles(r.code_json)
                    const outFiles = parseFiles(r.output_json)
                    const missing = [...codeFiles, ...outFiles].filter((f) => f.missing)
                    return (
                      <div key={r.id} className="rounded-lg border border-[color:var(--wb-border)] px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Pill tone={RUN_STATUS_TONE[r.status] || 'gray'}>
                            {RUN_STATUS.find((s) => s.value === r.status)?.label || r.status}
                          </Pill>
                          <Pill tone="slate">
                            {RUN_SURFACE.find((s) => s.value === r.surface)?.label || r.surface}
                          </Pill>
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[color:var(--wb-text)]">
                            {r.command}
                          </span>
                          {missing.length > 0 && (
                            <span className="flex items-center gap-1 whitespace-nowrap text-[11px] text-[color:var(--wb-warn)]">
                              <Icon name="alert" size={12} />
                              {missing.length} 个文件缺失
                            </span>
                          )}
                          <span className="whitespace-nowrap text-[11px] text-[color:var(--wb-muted)]">
                            {r.wall_ms ? `${fmtMs(r.wall_ms)} · ` : ''}
                            {(r.created_at || '').replace('T', ' ')}
                          </span>
                          <Btn size="xs" variant="ghost" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                            {openRun === r.id ? '收起' : '详情'}
                          </Btn>
                          <IconBtn
                            icon="trash"
                            size="sm"
                            tone="danger"
                            title="删除该运行记录（不动磁盘上的结果文件）"
                            onClick={() => dropRun(r.id)}
                          />
                        </div>
                        {openRun === r.id && (
                          <div className="mt-2 flex flex-col gap-2 border-t border-[color:var(--wb-border)] pt-2">
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[color:var(--wb-text-soft)]">
                              <span>
                                run_id <span className="font-mono">{r.run_id}</span>
                              </span>
                              {r.host && <span>主机 {r.host}</span>}
                              {r.job_id && (
                                <span>
                                  作业 <span className="font-mono">{r.job_id}</span>
                                </span>
                              )}
                              <span>
                                环境{' '}
                                {r.env_hash ? (
                                  <span className="font-mono" title="内容寻址：环境快照全文的 sha1">
                                    {r.env_hash}
                                  </span>
                                ) : (
                                  '未登记'
                                )}
                              </span>
                              {r.notes && <span className="w-full">{r.notes}</span>}
                            </div>
                            {(
                              [
                                ['代码文件', codeFiles],
                                ['输出文件', outFiles],
                              ] as const
                            ).map(([label, files]) =>
                              files.length ? (
                                <div key={label}>
                                  <div className="mb-1 text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">
                                    {label}（{files.length}）
                                  </div>
                                  <div className="flex flex-col gap-0.5">
                                    {files.map((f: any) => (
                                      <div key={f.path} className="flex items-center gap-2 text-[11.5px]">
                                        <Pill tone={f.missing ? 'red' : 'green'}>
                                          {f.missing ? '缺失' : f.sha1}
                                        </Pill>
                                        <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                                          {f.path}
                                        </span>
                                        <span className="whitespace-nowrap text-[color:var(--wb-muted)]">
                                          {f.missing ? '磁盘上没找到（抓取被跳过？）' : fmtSize(f.size)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : null,
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
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
              </>
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
      )}

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

      {/* 结果审查卡：结构化 findings，借鉴 Open Science reviewer（error/warn/ok + 证据原文） */}
      {audit && (
        <Card
          title="结果审查"
          extra={
            <Btn variant="ghost" onClick={() => setAudit(null)}>
              关闭
            </Btn>
          }
        >
          <div className="mb-3 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">{audit.note}</div>
          {audit.findings.length === 0 ? (
            <Empty text="审查未报告任何条目" hint="审查只对结果记录和运行溯源负责——先录数据和登记运行，审查才有可对照的证据。" />
          ) : (
            <div className="flex flex-col gap-2">
              {audit.findings.map((f: any, i: number) => {
                const lv = AUDIT_LEVEL[f.level] || AUDIT_LEVEL.ok
                return (
                  <div
                    key={i}
                    className={`rounded-lg border px-3 py-2 ${
                      f.level === 'error'
                        ? 'border-[color:var(--wb-danger-soft)] bg-[color:var(--wb-danger-soft)]'
                        : f.level === 'warn'
                          ? 'border-[color:var(--wb-warn-soft)] bg-[color:var(--wb-warn-soft)]'
                          : 'border-[color:var(--wb-border)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={lv.tone}>{lv.label}</Pill>
                      <Pill tone="slate">{AUDIT_CHECK_LABEL[f.check] || f.check}</Pill>
                      <span className="min-w-0 flex-1 text-[13px] font-medium text-[color:var(--wb-text)]">
                        {f.title}
                      </span>
                    </div>
                    <div className="mt-1.5 whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                      {f.evidence}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <AiMeta res={audit.meta || {}} />
        </Card>
      )}

      {/* 编辑设计弹窗（默认不占视觉，点「设计」才开） */}
      <Modal open={designOpen} onClose={() => setDesignOpen(false)} title="编辑实验设计" width="max-w-xl">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">状态</span>
            <Select
              value={current?.status}
              onChange={(v) => current && setStatus(current.id, v)}
              options={STATUS}
            />
          </div>
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">假设</span>
            <TextArea
              rows={3}
              defaultValue={current?.hypothesis || ''}
              placeholder="我预期 X 会优于 Y，因为…"
              onBlur={(e) => {
                if (e.target.value !== (current?.hypothesis || '')) saveDetail('hypothesis', e.target.value)
              }}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">设计（方法 × 样本 × 指标）</span>
            <TextArea
              rows={4}
              defaultValue={current?.design || ''}
              placeholder="基线 / 数据集 / 评价指标 / 重复次数…"
              onBlur={(e) => {
                if (e.target.value !== (current?.design || '')) saveDetail('design', e.target.value)
              }}
            />
          </label>
          <div className="flex justify-end">
            <Btn variant="primary" onClick={() => setDesignOpen(false)}>
              完成
            </Btn>
          </div>
        </div>
      </Modal>

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

      {/* 登记运行弹窗（借鉴 Open Science record_run：agent/用户只报路径，指纹与校验由系统做） */}
      <Modal open={runOpen} onClose={() => setRunOpen(false)} title="登记运行记录" width="max-w-2xl">
        <div className="flex flex-col gap-2.5">
          <TextArea
            rows={2}
            placeholder="命令（必填），如 python train.py --config cfg.yaml"
            value={runForm.command}
            onChange={(v) => setRunForm({ ...runForm, command: v })}
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <Select
              value={runForm.surface}
              onChange={(v) => setRunForm({ ...runForm, surface: v })}
              options={RUN_SURFACE}
            />
            <Select
              value={runForm.status}
              onChange={(v) => setRunForm({ ...runForm, status: v })}
              options={RUN_STATUS}
            />
            <Input
              placeholder="耗时 ms（可选）"
              value={runForm.wall_ms}
              onChange={(v) => setRunForm({ ...runForm, wall_ms: v })}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="主机（可选）" value={runForm.host} onChange={(v) => setRunForm({ ...runForm, host: v })} />
            <Input
              placeholder="作业 ID（可选，集群/云端任务号）"
              value={runForm.job_id}
              onChange={(v) => setRunForm({ ...runForm, job_id: v })}
            />
          </div>
          <TextArea
            rows={3}
            placeholder="环境快照（可选）：粘贴 pip freeze 输出，落库存内容寻址 sha1，跨机器可对环境是否漂移"
            value={runForm.env_text}
            onChange={(v) => setRunForm({ ...runForm, env_text: v })}
          />
          <TextArea
            rows={2}
            placeholder="代码/脚本文件路径，每行一个（磁盘上存在则自动 sha1 钉码；不存在标缺失）"
            value={runForm.code_paths}
            onChange={(v) => setRunForm({ ...runForm, code_paths: v })}
          />
          <TextArea
            rows={2}
            placeholder="输出结果文件路径，每行一个（登记后这些路径不可被本实验的新 run 复用）"
            value={runForm.output_paths}
            onChange={(v) => setRunForm({ ...runForm, output_paths: v })}
          />
          <TextArea
            rows={2}
            placeholder="备注（可选）"
            value={runForm.notes}
            onChange={(v) => setRunForm({ ...runForm, notes: v })}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Btn variant="ghost" onClick={() => setRunOpen(false)}>
              取消
            </Btn>
            <Btn variant="primary" onClick={submitRun} disabled={!runForm.command.trim()}>
              登记
            </Btn>
          </div>
          <div className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            借鉴 Open Science 的运行溯源协议：只填路径，文件指纹（sha1/大小/缺失告警）由系统现场计算；
            输出路径一经登记即不可变——重跑必须换新目录，防止悄悄覆盖旧结果。
          </div>
        </div>
      </Modal>
    </div>
  )
}
