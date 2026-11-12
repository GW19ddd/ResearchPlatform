/**
 * 数据分析工作室（/studio/analysis）：上传 CSV/XLSX → 选分析模板 → 真实 Python（pandas）出表与图。
 *
 * 后端 /api/workspace/analysis/run 只认 4 个模板（preview/describe/compare/correlate），
 * 由 server/workspace.py 生成 pandas 脚本、用服务进程所在 venv（已装 pandas/matplotlib）跑，
 * 图表是 matplotlib 真实渲染的 PNG（analysis_chart.png），复用 /api/workspace/artifact 直出。
 * 不开放任意分析代码，模板由后端白名单给出。
 */
import { useEffect, useRef, useState } from 'react'
import { Btn, IconBtn, Input, Modal, Select, StatusTag } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'
import { del, get, post } from '../lib/api'
import { useApi } from '../lib/hooks'
import { usePersist } from '../lib/state'
import { toast } from '../components/toast'
import { StudioProGate } from '../components/ProGate'

type FileRow = { name: string; size: number; ext: string }
type ColsInfo = { name: string; cols: string[]; numeric: string[] }
type AnalysisOut = {
  ok: boolean
  status: string
  wall_ms: number
  stdout: string
  error: string | null
  result: {
    template: string
    rows: number
    cols: string[]
    n_numeric: number
    table: { headers: string[]; rows: string[][] } | null
    chart_png: string | null
    summary: string
  } | null
}

const TEMPLATES = [
  { value: 'describe', label: '描述统计' },
  { value: 'compare', label: '分组对比' },
  { value: 'correlate', label: '相关性' },
  { value: 'preview', label: '数据预览' },
]

const FILE_ICON: Record<string, IconName> = {
  '.csv': 'grid',
  '.xlsx': 'grid',
  '.json': 'chart',
  '.png': 'image',
  '.py': 'cpu',
}

const isDataset = (name: string) => /\.(csv|xlsx)$/i.test(name)

async function uploadDataset(file: File) {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/workspace/analysis/upload', { method: 'POST', body: fd })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    try {
      const j = JSON.parse(text)
      if (j?.detail) throw new Error(j.detail)
    } catch {
      /* keep raw */
    }
    throw new Error(text || `上传失败（HTTP ${res.status}）`)
  }
  return res.json()
}

export default function AnalysisStudio() {
  const filesApi = useApi<FileRow[]>('/workspace/files?kind=analysis')
  const [sel, setSel] = usePersist<string>('studio.analysis.file', '')
  const [template, setTemplate] = usePersist<string>('studio.analysis.template', 'describe')
  const [groupCol, setGroupCol] = useState('')
  const [valueCol, setValueCol] = useState('')
  const [colsInfo, setColsInfo] = useState<ColsInfo | null>(null)
  const [out, setOut] = useState<AnalysisOut | null>(null)
  const [busy, setBusy] = useState(false)
  const [chartNonce, setChartNonce] = useState(0)
  const [delOpen, setDelOpen] = useState(false)
  const [view, setView] = useState<'chart' | 'log'>('chart')
  const fileRef = useRef<HTMLInputElement>(null)

  const files: FileRow[] = filesApi.data || []
  const datasets = files.filter((f) => isDataset(f.name))

  useEffect(() => {
    if (!sel || !isDataset(sel)) return
    let alive = true
    get<ColsInfo>(`/workspace/analysis/columns?name=${encodeURIComponent(sel)}`)
      .then((c) => {
        if (!alive) return
        setColsInfo(c)
        setGroupCol((g) => g && c.cols.includes(g) ? g : (c.cols.find((x) => !c.numeric.includes(x)) || c.cols[0] || ''))
        setValueCol((v) => v && c.cols.includes(v) ? v : (c.numeric[0] || ''))
      })
      .catch(() => alive && setColsInfo(null))
    return () => {
      alive = false
    }
  }, [sel, filesApi.data])

  const refresh = () => filesApi.reload()

  // 打开页面即恢复「最近一次分析」：结果落盘在 analysis_result.json，刷新/重开不丢现场
  useEffect(() => {
    let alive = true
    get<{ content: string }>('/workspace/file?kind=analysis&name=analysis_result.json')
      .then((r) => {
        if (!alive) return
        const result = JSON.parse(r.content)
        if (!result?.template) return
        setOut({
          ok: true,
          status: 'restored',
          wall_ms: 0,
          stdout: '',
          error: null,
          result,
        })
        if (result.dataset) setSel(result.dataset)
        setTemplate(result.template)
        if (result.chart_png) {
          setChartNonce(Date.now())
          setView('chart')
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = (name: string) => {
    setSel(name)
    setOut(null)
  }

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const r: any = await uploadDataset(f)
      toast(`已上传 ${r.name}`, 'ok')
      refresh()
      setSel(r.name)
    } catch (err: any) {
      toast(err?.message || '上传失败', 'error')
    }
  }

  const removeFile = async () => {
    try {
      await del(`/workspace/file?kind=analysis&name=${encodeURIComponent(sel)}`, { ok: '已删除' })
      setDelOpen(false)
      setSel('')
      setOut(null)
      setColsInfo(null)
      refresh()
    } catch (e: any) {
      toast(e?.message || '删除失败', 'error')
    }
  }

  const run = async () => {
    if (!sel) {
      toast('请先上传或选择一个数据集', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await post<AnalysisOut>(
        '/workspace/analysis/run',
        { name: sel, template, group_col: groupCol, value_col: valueCol },
        { ok: false },
      )
      setOut(r)
      setView(r.result?.chart_png ? 'chart' : 'log')
      if (r.result?.chart_png) setChartNonce(Date.now())
      refresh()
    } catch (e: any) {
      toast(e?.message || '分析失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const chartUrl = out?.result?.chart_png
    ? `/api/workspace/artifact?kind=analysis&name=${encodeURIComponent(out.result.chart_png)}&v=${chartNonce}`
    : ''
  const table = out?.result?.table

  return (
    <StudioProGate className="h-full min-h-0" label="数据分析工作室">
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 操作条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="min-w-0 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            上传 CSV / XLSX → 选模板 → 真实 pandas 出表与图 · 模板由后端白名单给出，不开放任意代码
          </p>
        </div>
        {out && (
          <StatusTag tone={out.ok ? 'ok' : 'danger'}>
            {out.ok ? '分析完成' : '分析失败'}
            {out.wall_ms ? ` · ${(out.wall_ms / 1000).toFixed(1)}s` : ''}
          </StatusTag>
        )}
        {out?.ok && out.status === 'restored' && (
          <span className="text-[10.5px] text-[color:var(--wb-muted)]">已恢复上次分析结果 · 点「运行分析」可重跑</span>
        )}
        <Btn variant="primary" loading={busy} onClick={run} disabled={!sel}>
          <Icon name="play" size={13} />
          运行分析
        </Btn>
        <Btn onClick={() => fileRef.current?.click()}>
          <Icon name="paperclip" size={13} />
          上传数据集
        </Btn>
        <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={onUpload} />
        <IconBtn icon="refresh" size="md" ariaLabel="刷新文件列表" title="刷新" onClick={refresh} />
      </div>

      {/* 配置条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-2 text-[12px]">
        <span className="text-[color:var(--wb-text-soft)]">分析模板</span>
        <Select value={template} onChange={setTemplate} options={TEMPLATES} />
        {template === 'compare' && (
          <>
            <span className="ml-1 text-[color:var(--wb-text-soft)]">分组列</span>
            <Select
              value={groupCol}
              onChange={setGroupCol}
              options={[{ value: '', label: '（选择列）' }, ...(colsInfo?.cols || []).map((c) => ({ value: c, label: c }))]}
            />
            <span className="text-[color:var(--wb-text-soft)]">数值列</span>
            <Select
              value={valueCol}
              onChange={setValueCol}
              options={[{ value: '', label: '（选择列）' }, ...(colsInfo?.numeric || []).map((c) => ({ value: c, label: c }))]}
            />
          </>
        )}
        {sel && colsInfo && (
          <span className="ml-auto text-[10.5px] text-[color:var(--wb-muted)]">
            {sel} · {colsInfo.cols.length} 列 · {colsInfo.numeric.length} 数值列
          </span>
        )}
      </div>

      {/* 三栏：文件树 / 配置与结果表 / 图表与日志 */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[208px] shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[color:var(--wb-border)] px-3 py-2">
            <Icon name="folder" size={13} className="text-[color:var(--wb-muted)]" />
            <span className="text-[11.5px] font-medium text-[color:var(--wb-text)]">分析工作区</span>
            <span className="ml-auto text-[10.5px] text-[color:var(--wb-muted)]">{files.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {files.length === 0 && (
              <p className="px-2 py-4 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                工作区还是空的。点右上角「上传数据集」导入 CSV / XLSX 开始。
              </p>
            )}
            {files.map((f) => (
              <button
                key={f.name}
                type="button"
                onClick={() => pick(f.name)}
                title={f.name}
                className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-[6px] text-left transition ${
                  sel === f.name
                    ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                    : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                }`}
              >
                <Icon name={FILE_ICON[f.ext] || 'file'} size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[11.5px]">{f.name}</span>
                <span className="shrink-0 text-[9.5px] tabular-nums opacity-60">
                  {f.size > 1024 ? `${Math.round(f.size / 1024)}K` : f.size}
                </span>
              </button>
            ))}
          </div>
          {sel && (
            <div className="shrink-0 border-t border-[color:var(--wb-border)] p-2">
              <Btn size="sm" variant="danger" className="w-full" onClick={() => setDelOpen(true)}>
                <Icon name="trash" size={12} />
                删除当前文件
              </Btn>
            </div>
          )}
        </aside>

        {/* 中：结果表 */}
        <section className="flex min-w-0 flex-1 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-2">
            <Icon name="grid" size={13} className="text-[color:var(--wb-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[color:var(--wb-text)]">
              {out?.result?.summary || '结果表'}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!out && (
              <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                {sel ? '选好模板后点「运行分析」，结果会显示在这里。' : '上传或选择一个数据集开始。'}
              </div>
            )}
            {out && !out.ok && (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[color:var(--wb-danger)]">
                {out.error || out.stdout || '分析失败'}
              </pre>
            )}
            {out?.ok && table && (
              <div className="overflow-auto rounded-lg border border-[color:var(--wb-border)]">
                <table className="w-full border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-[color:var(--wb-surface-alt)]">
                    <tr>
                      {table.headers.map((h) => (
                        <th
                          key={h}
                          className="border-b border-[color:var(--wb-border)] px-2.5 py-1.5 text-left font-medium text-[color:var(--wb-text-soft)]"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td
                            key={j}
                            className="border-b border-[color:var(--wb-border)] px-2.5 py-1 font-mono text-[color:var(--wb-text-soft)]"
                          >
                            {c === null || c === undefined ? '—' : String(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {out?.ok && !table && (
              <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                {out.result?.summary || '该模板没有生成表格。'}
              </p>
            )}
          </div>
        </section>

        {/* 右：图表 / 日志 */}
        <section className="flex w-[44%] min-w-[320px] shrink-0 flex-col bg-[color:var(--wb-surface)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-2">
            <div className="inline-flex gap-0.5 rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] p-[2px]">
              {(['chart', 'log'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded-[7px] px-2.5 py-[3px] text-[11.5px] transition ${
                    view === v
                      ? 'bg-[color:var(--wb-surface)] font-medium text-[color:var(--wb-text)] shadow-[var(--wb-shadow-xs)]'
                      : 'text-[color:var(--wb-muted)]'
                  }`}
                >
                  {v === 'chart' ? '图表' : '运行日志'}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            {chartUrl && (
              <a
                href={chartUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-[8px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-2 py-[4px] text-[11px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)]"
              >
                <Icon name="download" size={12} />
                下载
              </a>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {view === 'chart' ? (
              chartUrl ? (
                <img src={chartUrl} alt="分析图表" className="mx-auto max-w-full rounded-lg border border-[color:var(--wb-border)]" />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                  {out?.ok ? '该模板未生成图表。' : '运行分析后，matplotlib 图表会显示在这里。'}
                </div>
              )
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
                {out?.stdout || '还没有运行日志。'}
              </pre>
            )}
          </div>
        </section>
      </div>

      <Modal
        open={delOpen}
        onClose={() => setDelOpen(false)}
        title="删除文件"
        width="max-w-md"
        footer={
          <>
            <Btn onClick={() => setDelOpen(false)}>取消</Btn>
            <Btn variant="danger" onClick={removeFile}>
              删除
            </Btn>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
          确定删除「{sel}」吗？此操作不可撤销（含该数据集的分析产物）。
        </p>
      </Modal>
    </div>
    </StudioProGate>
  )
}
