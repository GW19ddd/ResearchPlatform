import { useEffect, useState } from 'react'
import { Btn, Card, Empty, Input, MdBlock, Pill, ScoreBar, Select, TextArea } from '../components/ui'
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

const IDEA_COLS: ExportCol[] = [
  { key: 'title', label: '标题' },
  { key: 'one_liner', label: '一句话主张' },
  { key: 'category', label: '分类' },
  { key: 'direction', label: '方向' },
  { key: 'status', label: '状态' },
  { key: 'novelty', label: '新颖' },
  { key: 'feasibility', label: '可行' },
  { key: 'impact', label: '影响' },
  { key: 'effort', label: '工作量' },
  { key: 'notes', label: '备注' },
]

const STATUS_OPTIONS = [
  { value: 'captured', label: '已捕获' },
  { value: 'screening', label: '筛选中' },
  { value: 'validated', label: '已验证' },
  { value: 'selected', label: '已选定' },
  { value: 'dropped', label: '已放弃' },
]

const REVIEW_ROLES = [
  { value: 'reviewer', label: '挑剔审稿人' },
  { value: 'mentor', label: '务实导师' },
  { value: 'rival', label: '竞争同行' },
]

const SCORE_LABELS: Record<string, string> = {
  novelty: '新颖',
  feasibility: '可行',
  impact: '影响',
  effort: '工作量',
}

/** 可点击打分的 1-5 分条（列表里的 ScoreBar 只读，抽屉里要能改）。 */
function ScorePicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  const v = Math.max(0, Math.min(5, Number(value) || 0))
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-10 shrink-0 text-[11.5px] text-[color:var(--wb-text-soft)]">{label}</span>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            title={`${label} ${n}`}
            className={`h-4 w-5 rounded-sm transition ${
              n <= v ? 'bg-[color:var(--wb-accent)]' : 'bg-[color:var(--wb-border-strong)] hover:bg-[color:var(--wb-muted)]'
            }`}
          />
        ))}
      </div>
      <span className="text-[11.5px] text-[color:var(--wb-muted)]">{v}</span>
    </div>
  )
}

export default function Ideas() {
  const [ideas, setIdeas] = useState<any[]>([])
  const [cats, setCats] = useState<{ name: string; count: number; avg_score: number }[]>([])
  const [cat, setCat] = usePersist('ideas.catFilter', '')
  const [groupBy, setGroupBy] = usePersist('ideas.groupby', true)
  const [sort, setSort] = usePersist('ideas.sort', 'id')
  const [form, setForm] = usePersist<any>('ideas.form', {
    title: '',
    one_liner: '',
    direction: '',
    category: '',
    novelty: 3,
    feasibility: 3,
    impact: 3,
    effort: 3,
  })
  const [brain, setBrain] = usePersist('ideas.brain', { direction: '', context: '', count: 5 })
  const [out, setOut] = usePersist<{ title: string; text: string } | null>('ideas.out', null)
  const [cands, setCands] = usePersist<any[] | null>('ideas.cands', null)
  const [picked, setPicked] = usePersist<Set<number>>('ideas.picked', new Set())
  // 两个 AI 动作各持一份状态机：失败时保留输入、给出原因和重试入口
  const brainTask = useAiTask<any>()
  const revTask = useAiTask<any>()
  // 一次「加入想法池」一把 key：双击只写一条，成功后换 key，下次有意再建才写第二条
  const idem = useIdemKey()
  const [saving, setSaving] = useState(false)
  // 想法池的多选：默认关闭，点「多选」才出现复选框；勾中的 id 只存在内存里
  const bulk = useBulk()
  const [multi, setMulti] = useState(false)
  const [bulkDel, setBulkDel] = useState(false)

  const toggleMulti = () => {
    // 退出多选顺手清空勾选，否则下次进来会带着看不见的旧选择
    if (multi) bulk.clear()
    setMulti(!multi)
  }

  const load = async () => setIdeas(await get('/ideas'))
  const loadCats = async () => setCats((await get('/ideas/categories')).groups || [])

  useEffect(() => {
    load()
    loadCats()
  }, [])

  const add = async () => {
    if (!form.title.trim() || saving) return
    setSaving(true)
    try {
      await post('/ideas', { ...form, status: 'captured' }, { idem: idem.key, ok: '已加入想法池' })
      idem.reset()
      setForm({ ...form, title: '', one_liner: '' })
      load()
      loadCats()
    } finally {
      setSaving(false)
    }
  }

  const setStatus = async (id: number, status: string) => {
    await patch(`/ideas/${id}`, { status })
    load()
    loadCats()
  }

  const setCategory = async (id: number, value: string) => {
    let v = value
    if (v === '__new') {
      v = (window.prompt('新分类名称（例：agent 架构、评测基准、CFD 数值）') || '').trim()
      if (!v) return
    }
    await patch(`/ideas/${id}`, { category: v || null })
    load()
    loadCats()
  }

  const brainstorm = async () => {
    if (!brain.direction.trim()) return
    const existing = cats.map((c) => c.name).filter((n) => n && n !== '未分类')
    const r: any = await brainTask.run(() =>
      post<any>('/ideas/brainstorm', { ...brain, categories: existing }, { ok: false }),
    )
    // 信封里 ok=false 时 r.result 恒为空串 —— 绝不拿它当成果渲染
    if (!r || r.ok === false) return
    if (r.candidates && r.candidates.length > 0) {
      setCands(r.candidates)
      setPicked(new Set(r.candidates.map((_: any, i: number) => i)))
      setOut(null)
    } else {
      setCands(null)
      setOut({ title: `创新点头脑风暴 · ${brain.direction}`, text: r.result })
    }
  }

  const togglePick = (i: number) => {
    const next = new Set(picked)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setPicked(next)
  }

  const addPicked = async () => {
    for (const i of picked) {
      const c = cands![i]
      const notes = [
        c.defect && `【解决缺陷】${c.defect}`,
        c.mve && `【验证路径】${c.mve}`,
        c.risk && `【风险】${c.risk}`,
      ]
        .filter(Boolean)
        .join('\n')
      await post('/ideas', {
        title: c.title,
        one_liner: c.one_liner,
        direction: brain.direction,
        novelty: c.novelty,
        feasibility: c.feasibility,
        impact: c.impact,
        effort: c.effort,
        category: c.category || form.category || null,
        status: 'captured',
        notes,
      })
    }
    setCands(null)
    setPicked(new Set())
    load()
    loadCats()
  }

  // ---- 详情抽屉：点条目进去改全部字段 ----
  const [detail, setDetail] = useState<any>(null)
  const [reviews, setReviews] = useState<any[]>([])
  const [dout, setDout] = useState('')
  const [dbusy, setDbusy] = useState('')

  const loadReviews = async (id: number) => {
    try {
      setReviews(await get(`/ideas/${id}/reviews`))
    } catch {
      setReviews([])
    }
  }

  const openDetail = async (i: any) => {
    setDetail({ ...i })
    setDout('')
    setDbusy('')
    await loadReviews(i.id)
  }

  const setField = (k: string, v: any) => setDetail((d: any) => ({ ...d, [k]: v }))

  const pickCategory = async (v: string) => {
    if (v === '__new') {
      const name = (window.prompt('新分类名称（例：agent 架构、评测基准、CFD 数值）') || '').trim()
      if (!name) return
      setField('category', name)
      return
    }
    setField('category', v || null)
  }

  const saveDetail = async () => {
    if (!detail) return
    if (!String(detail.title || '').trim()) {
      window.alert('标题不能为空')
      return
    }
    setDbusy('save')
    try {
      await patch(`/ideas/${detail.id}`, {
        title: detail.title,
        one_liner: detail.one_liner,
        direction: detail.direction,
        category: detail.category || null,
        status: detail.status,
        novelty: Number(detail.novelty) || 3,
        feasibility: Number(detail.feasibility) || 3,
        impact: Number(detail.impact) || 3,
        effort: Number(detail.effort) || 3,
        notes: detail.notes,
      })
      load()
      loadCats()
    } finally {
      setDbusy('')
    }
  }

  const dropDetail = async () => {
    if (!detail) return
    if (!window.confirm(`删掉「${detail.title}」？此操作不可撤销`)) return
    await del(`/ideas/${detail.id}`)
    setDetail(null)
    load()
    loadCats()
  }

  const review = async (id: number, role: string) => {
    const r: any = await revTask.run(() => post(`/ideas/${id}/review`, { role }, { ok: false }))
    if (!r || r.ok === false) return
    setOut({
      title: `质疑意见 · ${REVIEW_ROLES.find((x) => x.value === role)?.label}`,
      text: r.result,
    })
    if (detail?.id === id) {
      setDout(r.result)
      await loadReviews(id)
    }
  }

  const catOf = (i: any) => (i.category || '').trim() || '未分类'
  const scoreOf = (i: any) =>
    ((i.novelty || 0) + (i.feasibility || 0) + (i.impact || 0)) / 3

  const catOptions = [
    { value: '', label: '未分类' },
    ...cats.filter((c) => c.name !== '未分类').map((c) => ({ value: c.name, label: c.name })),
    { value: '__new', label: '＋ 新建分类…' },
  ]

  const shown = (() => {
    const list = cat ? ideas.filter((i) => catOf(i) === cat) : ideas
    const arr = [...list]
    if (sort === 'score') arr.sort((a, b) => scoreOf(b) - scoreOf(a))
    else if (sort === 'effort') arr.sort((a, b) => (a.effort || 0) - (b.effort || 0))
    return arr
  })()

  const grouped = (() => {
    if (!groupBy) return []
    const m = new Map<string, any[]>()
    for (const i of shown) {
      const k = catOf(i)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(i)
    }
    return [...m.entries()]
      .map(([name, list]) => ({ name, list }))
      .sort((a, b) => b.list.length - a.list.length)
  })()

  // ---- 批量操作：按勾选顺序取行，导出时把状态 / 分类翻成中文 ----
  const selectedRows = () => {
    const byId = new Map(shown.map((i) => [i.id, i]))
    return bulk.ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((i: any) => ({
        ...i,
        category: catOf(i),
        status: STATUS_OPTIONS.find((s) => s.value === i.status)?.label || i.status,
      }))
  }

  const exportIdeas = (fmt: 'md' | 'csv') => {
    const rows = selectedRows()
    if (!rows.length) return
    const base = stamp('创新点')
    if (fmt === 'csv') {
      downloadText(`${base}.csv`, toCsv(rows, IDEA_COLS), 'text/csv;charset=utf-8')
    } else {
      downloadText(
        `${base}.md`,
        toMarkdown('创新点', rows, IDEA_COLS),
        'text/markdown;charset=utf-8',
      )
    }
    toast(`已导出 ${rows.length} 个想法`, 'ok')
  }

  const bulkDrop = async () => {
    const ids = bulk.ids
    if (!ids.length) return
    if (!window.confirm(`删掉选中的 ${ids.length} 个想法？此操作不可撤销`)) return
    setBulkDel(true)
    try {
      await post('/ideas/bulk-delete', { ids }, { ok: `已删除 ${ids.length} 个想法` })
      bulk.clear()
      if (detail && ids.includes(detail.id)) setDetail(null)
      load()
      loadCats()
    } finally {
      setBulkDel(false)
    }
  }

  const renderIdea = (i: any) => (
    <div
      key={i.id}
      className={`rounded-lg border p-3 ${
        multi && bulk.has(i.id) ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)]' : 'border-[color:var(--wb-border)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        {multi && (
          <RowCheck
            checked={bulk.has(i.id)}
            onChange={() => bulk.toggle(i.id)}
            className="mt-1"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => openDetail(i)}
              className="text-left text-[13px] font-medium text-[color:var(--wb-text)] hover:text-[color:var(--wb-accent)] hover:underline"
            >
              {i.title}
            </button>
            <button
              onClick={() => setCat(cat === catOf(i) ? '' : catOf(i))}
              className={`rounded px-1.5 py-0.5 text-[11.5px] ${
                catOf(i) === '未分类'
                  ? 'bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-muted)]'
                  : 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)] hover:bg-[color:var(--wb-accent-soft)]'
              }`}
            >
              {catOf(i)}
            </button>
            <span className="text-[11.5px] text-[color:var(--wb-muted)]">综合 {scoreOf(i).toFixed(1)}</span>
          </div>
          {i.one_liner && <div className="mt-0.5 text-[12px] text-[color:var(--wb-text-soft)]">{i.one_liner}</div>}
          {i.direction && <div className="mt-1 text-[11.5px] text-[color:var(--wb-muted)]">{i.direction}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Pill tone={i.status === 'selected' ? 'green' : 'gray'}>
            {STATUS_OPTIONS.find((s) => s.value === i.status)?.label || i.status}
          </Pill>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
        <ScoreBar label="新颖" value={i.novelty} />
        <ScoreBar label="可行" value={i.feasibility} />
        <ScoreBar label="影响" value={i.impact} />
        <ScoreBar label="工作量" value={i.effort} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Select value={i.status} onChange={(v) => setStatus(i.id, v)} options={STATUS_OPTIONS} />
        <Select
          value={catOf(i) === '未分类' ? '' : catOf(i)}
          onChange={(v) => setCategory(i.id, v)}
          options={catOptions}
        />
        {REVIEW_ROLES.map((r) => (
          <Btn
            key={r.value}
            onClick={() => review(i.id, r.value)}
            disabled={revTask.busy}
            loading={revTask.busy}
          >
            {`${r.label}质疑`}
          </Btn>
        ))}
        <Btn onClick={() => openDetail(i)}>编辑</Btn>
        <Btn
          variant="danger"
          onClick={async () => {
            await del(`/ideas/${i.id}`)
            load()
            loadCats()
          }}
        >
          删除
        </Btn>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="捕获新想法" className="md:col-span-1">
          <div className="flex flex-col gap-2">
            <Input
              placeholder="标题（必填）"
              value={form.title}
              onChange={(v) => setForm({ ...form, title: v })}
            />
            <TextArea
              rows={2}
              placeholder="一句话主张：必须具体到可验证"
              value={form.one_liner}
              onChange={(v) => setForm({ ...form, one_liner: v })}
            />
            <div className="flex gap-2">
              <Input
                placeholder="所属方向"
                value={form.direction}
                onChange={(v) => setForm({ ...form, direction: v })}
              />
              <Input
                placeholder="分类（例：agent 架构）"
                value={form.category}
                onChange={(v) => setForm({ ...form, category: v })}
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {cats
                .filter((c) => c.name !== '未分类')
                .map((c) => (
                  <button
                    key={c.name}
                    onClick={() => setForm({ ...form, category: c.name })}
                    className={`rounded-full border px-2 py-0.5 text-[11.5px] ${
                      form.category === c.name
                        ? 'border-[color:var(--wb-accent-strong)] bg-[color:var(--wb-accent)] text-white'
                        : 'border-[color:var(--wb-border)] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-border-strong)]'
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {['novelty', 'feasibility', 'impact', 'effort'].map((k) => (
                <label key={k} className="flex items-center justify-between text-[11.5px] text-[color:var(--wb-text-soft)]">
                  {SCORE_LABELS[k]}
                  <Input
                    className="w-12"
                    type="number"
                    value={form[k]}
                    onChange={(v) => setForm({ ...form, [k]: Number(v) })}
                  />
                </label>
              ))}
            </div>
            <Btn
              variant="primary"
              onClick={add}
              disabled={!form.title.trim()}
              loading={saving}
            >
              加入想法池
            </Btn>
          </div>
        </Card>

        <Card title="AI 头脑风暴" className="md:col-span-2">
          <div className="flex flex-col gap-2">
            <Input
              placeholder="研究方向，例：LLM 智能体自动修复 OpenFOAM 配置故障"
              value={brain.direction}
              onChange={(v) => setBrain({ ...brain, direction: v })}
            />
            <TextArea
              rows={2}
              placeholder="现有背景 / 已跑过的实验 / 已知缺陷"
              value={brain.context}
              onChange={(v) => setBrain({ ...brain, context: v })}
            />
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-[color:var(--wb-text-soft)]">数量</span>
              <Input
                className="w-16"
                type="number"
                value={brain.count}
                onChange={(v) => setBrain({ ...brain, count: Number(v) })}
              />
              <Btn
                variant="primary"
                onClick={brainstorm}
                disabled={!brain.direction.trim()}
                loading={brainTask.busy}
              >
                生成候选创新点
              </Btn>
            </div>
            {brainTask.error && (
              <AiError
                error={brainTask.error}
                onRetry={brainstorm}
                retrying={brainTask.busy}
                title="头脑风暴没有跑通"
              />
            )}
          </div>
        </Card>
      </div>

      {cands && cands.length > 0 && (
        <Card
          title={`候选创新点（${cands.length} 个，已选 ${picked.size}）`}
          extra={
            <div className="flex items-center gap-2">
              <Btn variant="primary" onClick={addPicked} disabled={picked.size === 0}>
                加入候选池（{picked.size}）
              </Btn>
              <Btn variant="ghost" onClick={() => setCands(null)}>
                取消
              </Btn>
            </div>
          }
        >
          <div className="flex flex-col gap-2">
            {cands.map((c: any, i: number) => (
              <div
                key={i}
                className={`rounded-lg border p-3 transition-colors ${
                  picked.has(i) ? 'border-[color:var(--wb-accent-strong)] bg-[color:var(--wb-surface-alt)]' : 'border-[color:var(--wb-border)]'
                }`}
              >
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={picked.has(i)}
                    onChange={() => togglePick(i)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-[color:var(--wb-text)]">{c.title}</span>
                      <span className="text-[11.5px] text-[color:var(--wb-muted)]">
                        新颖 {c.novelty} · 可行 {c.feasibility} · 影响 {c.impact} · 工作量 {c.effort}
                      </span>
                      {c.category && (
                        <span className="rounded bg-[color:var(--wb-accent-soft)] px-1.5 py-0.5 text-[11.5px] text-[color:var(--wb-accent)]">
                          {c.category}
                        </span>
                      )}
                    </div>
                    {c.one_liner && (
                      <div className="mt-1 text-[12px] text-[color:var(--wb-text)]">{c.one_liner}</div>
                    )}
                    {c.defect && (
                      <div className="mt-1 text-[11.5px] text-[color:var(--wb-text-soft)]">
                        <b>解决缺陷：</b>
                        {c.defect}
                      </div>
                    )}
                    {c.mve && (
                      <div className="mt-1 text-[11.5px] text-[color:var(--wb-text-soft)]">
                        <b>验证路径：</b>
                        {c.mve}
                      </div>
                    )}
                    {c.risk && (
                      <div className="mt-1 text-[11.5px] text-[color:var(--wb-danger)]">
                        <b>风险：</b>
                        {c.risk}
                      </div>
                    )}
                  </div>
                </label>
              </div>
            ))}
          </div>
        </Card>
      )}

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
        </Card>
      )}

      <Card
        title={`想法池（${ideas.length}）`}
        extra={
          <div className="flex items-center gap-2">
            <Select
              value={cat}
              onChange={setCat}
              options={[
                { value: '', label: '全部分类' },
                ...cats.map((c) => ({ value: c.name, label: `${c.name}（${c.count}）` })),
              ]}
            />
            <Select
              value={sort}
              onChange={setSort}
              options={[
                { value: 'id', label: '按录入时间' },
                { value: 'score', label: '按综合分' },
                { value: 'effort', label: '按工作量' },
              ]}
            />
            <Btn onClick={() => setGroupBy(!groupBy)}>{groupBy ? '取消分组' : '按分类分组'}</Btn>
            {ideas.length > 0 && (
              <SelectToggle
                on={multi}
                onToggle={toggleMulti}
                title="进入多选，可批量导出或删除想法"
              />
            )}
          </div>
        }
      >
        {ideas.length === 0 ? (
          <Empty text="还没有想法，先捕获一个或让 AI 帮你风暴一轮" />
        ) : (
          <>
            {multi && (
              <BulkBar
                count={bulk.count}
                total={shown.length}
                unit="个"
                onSelectAll={() => bulk.setAll(shown.map((i) => i.id))}
                onClear={bulk.clear}
                onDelete={bulkDrop}
                deleting={bulkDel}
                exports={[
                  { label: '导出 Markdown', run: () => exportIdeas('md') },
                  { label: '导出 CSV', run: () => exportIdeas('csv') },
                ]}
              />
            )}
            {cats.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {cats.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => setCat(cat === c.name ? '' : c.name)}
                    className={`rounded-full border px-2 py-0.5 text-[11.5px] ${
                      cat === c.name
                        ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent-strong)]'
                        : 'border-[color:var(--wb-border)] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-border-strong)]'
                    }`}
                  >
                    {c.name} {c.count}
                    {c.avg_score ? (
                      <span className="ml-1 text-[color:var(--wb-muted)]">均分 {c.avg_score}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}

            {groupBy ? (
              <div className="flex flex-col gap-3">
                {grouped.map((g) => (
                  <div key={g.name}>
                    <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-[color:var(--wb-text)]">
                      <span className="rounded bg-[color:var(--wb-bg-subtle)] px-1.5 py-0.5">{g.name}</span>
                      <span className="text-[11.5px] font-normal text-[color:var(--wb-muted)]">
                        {g.list.length} 个
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">{g.list.map(renderIdea)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">{shown.map(renderIdea)}</div>
            )}
          </>
        )}
      </Card>

      {detail && (
        <>
          <div className="fixed inset-0 z-30 bg-[color:var(--wb-accent)]/20" onClick={() => setDetail(null)} />
          <div className="fixed right-0 top-0 z-40 flex h-full w-full max-w-[34rem] flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-2xl">
            <div className="flex items-center justify-between gap-2 border-b border-[color:var(--wb-border)] px-4 py-3">
              <div className="text-[13px] font-medium text-[color:var(--wb-text)]">编辑想法</div>
              <div className="flex items-center gap-2">
                <Btn variant="primary" onClick={saveDetail} disabled={dbusy === 'save'}>
                  {dbusy === 'save' ? '保存中…' : '保存'}
                </Btn>
                <Btn variant="ghost" onClick={() => setDetail(null)}>
                  关闭
                </Btn>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">标题</div>
                  <Input value={detail.title || ''} onChange={(v) => setField('title', v)} />
                </div>

                <div>
                  <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">一句话主张（要具体到可验证）</div>
                  <TextArea
                    rows={2}
                    value={detail.one_liner || ''}
                    onChange={(v) => setField('one_liner', v)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">所属方向</div>
                    <Input
                      value={detail.direction || ''}
                      onChange={(v) => setField('direction', v)}
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">分类</div>
                    <Select
                      value={catOf(detail) === '未分类' ? '' : catOf(detail)}
                      onChange={pickCategory}
                      options={catOptions}
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">状态</div>
                  <Select
                    value={detail.status || 'captured'}
                    onChange={(v) => setField('status', v)}
                    options={STATUS_OPTIONS}
                  />
                </div>

                <div>
                  <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">评分（点格子改分）</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {(['novelty', 'feasibility', 'impact', 'effort'] as const).map((k) => (
                      <ScorePicker
                        key={k}
                        label={SCORE_LABELS[k]}
                        value={detail[k] ?? 3}
                        onChange={(v) => setField(k, v)}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">
                    备注（缺陷 / 验证路径 / 风险，支持 Markdown）
                  </div>
                  <TextArea
                    rows={8}
                    value={detail.notes || ''}
                    onChange={(v) => setField('notes', v)}
                  />
                  {detail.notes && (
                    <div className="mt-2 rounded-lg border border-[color:var(--wb-border)] px-3 py-2">
                      <MdBlock text={detail.notes} />
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1 border-t border-[color:var(--wb-border)] pt-3">
                  <span className="mr-1 text-[11.5px] text-[color:var(--wb-muted)]">AI 质疑</span>
                  {REVIEW_ROLES.map((r) => (
                    <Btn
                      key={r.value}
                      onClick={() => review(detail.id, r.value)}
                      disabled={revTask.busy}
                      loading={revTask.busy}
                    >
                      {r.label}
                    </Btn>
                  ))}
                  <Btn variant="danger" className="ml-auto" onClick={dropDetail}>
                    删除这个想法
                  </Btn>
                </div>

                {revTask.error && (
                  <AiError
                    error={revTask.error}
                    onRetry={() => review(detail.id, 'reviewer')}
                    retrying={revTask.busy}
                    title="质疑没有生成"
                  />
                )}

                {dout && <AiMeta res={revTask.data || {}} />}
                {dout && (
                  <div className="rounded-lg bg-[color:var(--wb-surface-alt)] px-3 py-2">
                    <MdBlock text={dout} />
                  </div>
                )}

                {reviews.length > 0 && (
                  <details className="rounded-lg border border-[color:var(--wb-border)] px-3 py-2">
                    <summary className="cursor-pointer text-[12px] text-[color:var(--wb-text-soft)]">
                      历史质疑（{reviews.length}）
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                      {reviews.map((r: any) => (
                        <div key={r.id} className="rounded-lg bg-[color:var(--wb-surface-alt)] px-2.5 py-2">
                          <div className="flex items-center gap-2 text-[11.5px] text-[color:var(--wb-muted)]">
                            <Pill tone="blue">
                              {REVIEW_ROLES.find((x) => x.value === r.role)?.label || r.role}
                            </Pill>
                            {String(r.created_at || '').slice(0, 16)}
                          </div>
                          <div className="mt-1">
                            <MdBlock text={r.content || ''} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
