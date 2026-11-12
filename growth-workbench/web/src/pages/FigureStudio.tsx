/**
 * 绘图工作室（/studio/figure）：参考画廊 + 编辑器双模式。
 *
 * 编辑器有两条路径，口径不同，别混：
 *   1. Python 渲染（主路径）—— 真 matplotlib 代码，交给工作区 venv 的 python 跑，
 *      出的是真图（PNG / PDF / SVG 可导出）。默认示例就是画廊第 1 名那张
 *      χ1 三联散点图的复刻代码。代码可改、可重跑。
 *   2. 图表 spec（JSON）—— 浏览器端 Recharts 实时预览，改一行即时重绘，用于快速调版式；
 *      它出的是屏幕预览，不是出版级矢量图。
 * 两条路径的数字都必须是真实数字：手填的一律是 illustrative，
 * 要实测结果请走「从实验导入」，直接复用 POST /api/experiments/{id}/chart。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Btn, IconBtn, Input, Modal, Select, StatusTag } from '../components/ui'
import { Icon } from '../components/Icon'
import ChartCanvas, { type ChartSpec } from '../features/studio/ChartCanvas'
import FigureGallery, { type GalleryCandidate } from '../features/studio/FigureGallery'
import { fallbackSpec, specFromCandidate } from '../features/studio/exampleSpec'
import { get, post, put } from '../lib/api'
import { useApi } from '../lib/hooks'
import { usePersist } from '../lib/state'
import { toast } from '../components/toast'
import { StudioProGate } from '../components/ProGate'

const stringify = (s: ChartSpec) => JSON.stringify(s, null, 2)

/** 切类型只重排已有数据，绝不补点、不推算；维度对不上就交给 ChartCanvas 报错。 */
function convertSpec(s: ChartSpec, t: 'bar' | 'line' | 'scatter'): ChartSpec {
  if (t === 'scatter') {
    const pts = s.points?.length
      ? s.points
      : (s.series?.[0]?.values || []).map((y, i) => ({
          x: i + 1,
          y,
          label: s.categories?.[i] || null,
        }))
    return {
      ...s,
      type: 'scatter',
      points: pts,
      note: (s.note ? s.note + ' ｜ ' : '') + '类型已切换为散点，请核对每个 x / y 是否为真实数字',
    }
  }
  const cats = s.categories?.length ? s.categories : (s.points || []).map((p) => String(p.x))
  const series = s.series?.length
    ? s.series
    : [{ name: '数值', values: (s.points || []).map((p) => p.y) }]
  return {
    ...s,
    type: t,
    categories: cats,
    series,
    points: [],
    note: (s.note ? s.note + ' ｜ ' : '') + '类型已切换，请核对 series.values 与 categories 是否等长',
  }
}

type RenderOutput = { name: string; url: string; ext: string }
type RenderResult = {
  ok: boolean
  status: string
  script: string
  code?: string
  log: string
  error: string | null
  image: string
  outputs: RenderOutput[]
  run_id?: string
}

const EXT_LABEL: Record<string, string> = { '.png': 'PNG 位图', '.pdf': 'PDF 矢量', '.svg': 'SVG 矢量' }

/** 产物下载：同源直链 + download 属性，浏览器直接落盘（PDF 也不会被内置预览接管）。 */
async function download(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export default function FigureStudio() {
  const filesApi = useApi<any[]>('/workspace/files?kind=figure')
  const expsApi = useApi<any[]>('/experiments')

  const [selFile, setSelFile] = usePersist<string>('studio.figure.file', '')
  const [raw, setRaw] = useState(() => stringify(fallbackSpec()))
  const [spec, setSpec] = useState<ChartSpec>(() => fallbackSpec())
  const [parseErr, setParseErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [expId, setExpId] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('figure.json')
  const [dirty, setDirty] = useState(false)

  // 绘图工作室双模式：编辑器 / 参考画廊（agent-figure-gallery 形态）
  const [mode, setMode] = useState<'editor' | 'gallery'>('gallery')
  const [reference, setReference] = useState<GalleryCandidate | null>(null)
  const [exampleLoading, setExampleLoading] = useState(false)

  // 左侧页签：Python 代码（出真图）/ 图表 spec（浏览器实时预览）
  const [left, setLeft] = useState<'python' | 'spec'>('python')
  const [pyCode, setPyCode] = useState('')
  const [pyDirty, setPyDirty] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [result, setResult] = useState<RenderResult | null>(null)
  const bootRef = useRef(false)

  // 右侧页签：matplotlib 渲染结果 / Recharts 实时预览
  const [right, setRight] = useState<'render' | 'live'>('render')

  /** 把画廊候选落成编辑器草稿：spec 由 exampleSpec 统一生成（版式照参考图、数字示意）。 */
  const applySpecFrom = useCallback(
    (c: GalleryCandidate, markDirty: boolean) => {
      const next = specFromCandidate(c)
      setRaw(stringify(next))
      setSpec(next)
      setSelFile('')
      setDirty(markDirty)
      setReference(c)
    },
    [setSelFile],
  )

  /** 真渲染：把当前 Python 代码交给工作区 venv 的 python 跑一遍，回图 + 可导出产物。 */
  const renderPython = useCallback(
    async (code?: string) => {
      setRendering(true)
      try {
        const r: RenderResult = await post(
          '/figure-gallery/render-python',
          { code: code ?? pyCode, stem: 'chi1_scatter' },
          { silent: true },
        )
        setResult(r)
        if (r.ok) {
          setRight('render')
          if (code) setPyDirty(false)
        } else {
          toast(r.error || '渲染失败，看下方日志', 'error')
        }
        return r.ok
      } catch (e: any) {
        toast(e?.message || '渲染请求失败', 'error')
        return false
      } finally {
        setRendering(false)
      }
    },
    [pyCode],
  )

  /** 画廊精选榜第 1 名 → 编辑器默认示例（打开工作室即所见，不再是内置假例子）。 */
  const loadGalleryExample = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      setExampleLoading(true)
      try {
        const r: any = await get('/figure-gallery/top')
        const cand: GalleryCandidate | null = r?.candidate || null
        if (!cand) {
          if (!opts.silent) toast('画廊暂不可用，已保留内置示例', 'error')
          return false
        }
        applySpecFrom(cand, false)
        if (!opts.silent) toast(`已载入 ${cand.display_id || cand.candidate_id} 的版式（数字为示意）`, 'ok')
        return true
      } catch (e: any) {
        if (!opts.silent) toast(e?.message || '画廊示例加载失败', 'error')
        return false
      } finally {
        setExampleLoading(false)
      }
    },
    [applySpecFrom],
  )

  const useReference = (c: GalleryCandidate) => {
    applySpecFrom(c, true)
    setMode('editor')
    toast(`已按 ${c.display_id || c.candidate_id} 生成可编辑 spec（示意数字，请替换为真实数据）`, 'ok')
  }

  // 挂载：取画廊第 1 名做默认示例 + 取内置 matplotlib 模板代码并真跑一次
  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    if (!selFile) loadGalleryExample({ silent: true })
    ;(async () => {
      try {
        const t: any = await get('/figure-gallery/python-template?template=chi1_scatter')
        const code = t?.code || ''
        if (code) {
          setPyCode(code)
          await renderPython(code)
        }
      } catch {
        /* 模板取不到就留空，用户可自行粘贴 */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const files: { name: string; ext: string }[] = filesApi.data || []
  const jsonFiles = files.filter((f) => f.ext === '.json')
  const exps: { id: number; name: string }[] = expsApi.data || []

  // debounce 解析：打一半的 JSON 不会让右侧图消失，保留上一次有效 spec
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        const s = JSON.parse(raw)
        if (!s || typeof s !== 'object') throw new Error('spec 必须是一个 JSON 对象')
        setSpec(s as ChartSpec)
        setParseErr('')
      } catch (e: any) {
        setParseErr(e?.message || 'JSON 解析失败')
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [raw])

  // 选中文件才拉内容；没选文件就保持草稿示例
  useEffect(() => {
    if (!selFile) return
    let alive = true
    get<any>(`/workspace/file?kind=figure&name=${encodeURIComponent(selFile)}`)
      .then((r) => {
        if (alive) {
          setRaw(r.content || '')
          setDirty(false)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [selFile])

  const fileOptions = useMemo(
    () => [
      { value: '', label: '（草稿，未存文件）' },
      ...jsonFiles.map((f) => ({ value: f.name, label: f.name })),
    ],
    [jsonFiles],
  )

  const type = (['bar', 'line', 'scatter'].includes(spec.type) ? spec.type : 'bar') as
    | 'bar'
    | 'line'
    | 'scatter'

  const changeType = (t: string) => {
    const next = convertSpec(spec, t as 'bar' | 'line' | 'scatter')
    setRaw(stringify(next))
    setSpec(next)
    setDirty(true)
    setLeft('spec')
    setRight('live')
  }

  const loadExample = () => {
    loadGalleryExample()
  }

  const importFromExp = async () => {
    if (!expId) {
      toast('先选一个实验', 'error')
      return
    }
    setBusy(true)
    try {
      const r: any = await post(`/experiments/${expId}/chart`, {}, { ok: false })
      if (!r?.ok || !r?.chart) {
        toast(r?.error?.message || '这个实验暂时生成不了图表', 'error')
        return
      }
      // 后端 spec 的 note 已注明数据来源与口径；这里再补一句来源，避免被当成手填示意数据
      const imported: ChartSpec = {
        ...r.chart,
        note: (r.chart.note ? r.chart.note + ' ｜ ' : '') + '来源：实验结果记录 exp_results（经 /experiments/{id}/chart 生成）',
      }
      setRaw(stringify(imported))
      setSpec(imported)
      setSelFile('')
      setDirty(true)
      setLeft('spec')
      setRight('live')
      toast('已从实验结果导入图表 spec', 'ok')
    } catch (e: any) {
      toast(e?.message || '导入失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveSpec = async (name: string) => {
    try {
      await put('/workspace/file', { kind: 'figure', name, content: raw }, { ok: '已保存到工作区' })
      setSelFile(name)
      setDirty(false)
      setNewOpen(false)
      filesApi.reload()
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error')
    }
  }

  const onSave = () => {
    if (parseErr) {
      toast('JSON 还没改对，先修好再保存', 'error')
      return
    }
    if (selFile) saveSpec(selFile)
    else setNewOpen(true)
  }

  const outputs = result?.outputs || []
  const png = outputs.find((o) => o.ext === '.png')

  return (
    <StudioProGate className="h-full min-h-0" label="绘图工作室">
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 模式切换：编辑器 / 参考画廊 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2">
        <div className="inline-flex overflow-hidden rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border-strong)]">
          <button
            onClick={() => setMode('editor')}
            className={`px-3 py-1 text-[12px] transition ${mode === 'editor' ? 'bg-[color:var(--wb-accent)] text-white' : 'bg-[color:var(--wb-surface)] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'}`}
          >
            编辑器
          </button>
          <button
            onClick={() => setMode('gallery')}
            className={`px-3 py-1 text-[12px] transition ${mode === 'gallery' ? 'bg-[color:var(--wb-accent)] text-white' : 'bg-[color:var(--wb-surface)] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'}`}
          >
            参考画廊
          </button>
        </div>
        {reference && mode === 'editor' && (
          <span className="text-[11px] text-[color:var(--wb-muted)]">
            当前样板：{reference.display_id || reference.candidate_id} · {reference.source_repo}
          </span>
        )}
      </div>

      {mode === 'gallery' ? (
        <FigureGallery onUseReference={useReference} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {reference && (
            <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-accent-soft)] px-4 py-2">
              <img
                src={`/api/figure-gallery/media?path=${encodeURIComponent(reference.preview_path || '')}`}
                alt=""
                className="h-12 w-12 shrink-0 rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border)] bg-white object-contain"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] font-medium text-[color:var(--wb-text)]">
                  风格样板 · {reference.display_id || reference.candidate_id}
                </p>
                <p className="truncate text-[10.5px] text-[color:var(--wb-muted)]">
                  {reference.source_repo}
                  {reference.why_suggested ? ` · ${reference.why_suggested}` : ''}
                </p>
                {Array.isArray(reference.palette) && reference.palette.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {reference.palette.slice(0, 6).map((hex, i) => (
                      <span
                        key={i}
                        className="h-3 w-3 rounded-[3px] border border-[color:var(--wb-border)]"
                        style={{ background: hex }}
                        title={hex}
                      />
                    ))}
                  </div>
                )}
              </div>
              <Btn size="xs" onClick={() => setReference(null)}>
                清除样板
              </Btn>
            </div>
          )}

          {/* 操作条 */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="min-w-0 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                matplotlib 代码交给本机 python 真跑，出的是可导出的真图（PNG / PDF / SVG）；spec 页签是浏览器端实时预览，调版式用
              </p>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
                两条路径的数字都必须是真实数字；手填的一律是示意数据（illustrative），不作实测结论
              </p>
            </div>
            {parseErr && <StatusTag tone="danger">JSON 有误</StatusTag>}
            {dirty && !parseErr && <StatusTag tone="warn">spec 未保存</StatusTag>}
            {pyDirty && <StatusTag tone="warn">代码已改未渲染</StatusTag>}
            <Btn size="sm" onClick={loadExample} loading={exampleLoading}>
              加载画廊示例
            </Btn>
            <Btn size="sm" onClick={importFromExp} loading={busy}>
              从实验导入
            </Btn>
            {exps.length > 0 && (
              <Select
                value={expId}
                onChange={setExpId}
                options={[
                  { value: '', label: '选择实验…' },
                  ...exps.map((e) => ({ value: String(e.id), label: e.name.slice(0, 26) })),
                ]}
              />
            )}
            <Btn size="sm" onClick={onSave}>
              保存 spec
            </Btn>
            <IconBtn icon="refresh" size="md" ariaLabel="刷新文件列表" title="刷新" onClick={() => filesApi.reload()} />
          </div>

          {/* 文件选择条 */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-1.5">
            <Icon name="folder" size={12} className="text-[color:var(--wb-muted)]" />
            <span className="text-[11px] text-[color:var(--wb-muted)]">工作区 spec</span>
            <Select value={selFile} onChange={(v) => setSelFile(v)} options={fileOptions} />
            <span className="text-[10.5px] text-[color:var(--wb-muted)]">
              共 {jsonFiles.length} 份 · 保存后可在别处复用
            </span>
          </div>

          {/* 左编辑 / 右预览 */}
          <div className="flex min-h-0 flex-1">
            <section className="flex w-[46%] min-w-[320px] shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
              <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-1.5">
                <div className="inline-flex overflow-hidden rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border-strong)]">
                  <button
                    onClick={() => setLeft('python')}
                    className={`px-2.5 py-0.5 text-[11.5px] transition ${left === 'python' ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]' : 'text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'}`}
                  >
                    Python 代码
                  </button>
                  <button
                    onClick={() => setLeft('spec')}
                    className={`px-2.5 py-0.5 text-[11.5px] transition ${left === 'spec' ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]' : 'text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'}`}
                  >
                    图表 spec
                  </button>
                </div>
                {left === 'python' ? (
                  <>
                    <span className="text-[10.5px] text-[color:var(--wb-muted)]">matplotlib · 本机 venv python</span>
                    <div className="ml-auto flex items-center gap-1">
                      <IconBtn
                        icon="copy"
                        size="sm"
                        ariaLabel="复制代码"
                        title="复制代码"
                        onClick={() => {
                          navigator.clipboard?.writeText(pyCode).then(
                            () => toast('代码已复制', 'ok'),
                            () => toast('复制失败，请手动选中', 'error'),
                          )
                        }}
                      />
                      <Btn
                        size="xs"
                        variant="primary"
                        loading={rendering}
                        onClick={() => renderPython()}
                      >
                        <Icon name="play" size={11} />
                        渲染
                      </Btn>
                    </div>
                  </>
                ) : (
                  <span className="ml-auto text-[10.5px] text-[color:var(--wb-muted)]">
                    type: bar / line / scatter · panels / guides 可选
                  </span>
                )}
              </div>

              {left === 'python' ? (
                <>
                  <textarea
                    value={pyCode}
                    onChange={(e) => {
                      setPyCode(e.target.value)
                      setPyDirty(true)
                    }}
                    spellCheck={false}
                    placeholder="# 粘贴或编写 matplotlib 脚本，点右上「渲染」交给本机 python 跑"
                    className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[11.5px] leading-[1.65] text-[color:var(--wb-text)] outline-none"
                  />
                  <div className="shrink-0 border-t border-[color:var(--wb-border)] px-3 py-2">
                    {result?.error ? (
                      <p className="text-[11px] leading-relaxed text-[color:var(--wb-danger)]">
                        渲染失败：{result.error}
                        {result.log ? ` · ${result.log.slice(-260)}` : ''}
                      </p>
                    ) : (
                      <p className="text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
                        脚本存在 workbench 的 figure 工作区里执行，产物（png / pdf / svg）落在同一目录；
                        {result?.script ? ` 当前文件 ${result.script}` : ' 点「渲染」即运行'}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <textarea
                    value={raw}
                    onChange={(e) => {
                      setRaw(e.target.value)
                      setDirty(true)
                    }}
                    spellCheck={false}
                    className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12px] leading-[1.7] text-[color:var(--wb-text)] outline-none"
                  />
                  <div className="shrink-0 border-t border-[color:var(--wb-border)] px-3 py-2">
                    {parseErr ? (
                      <p className="text-[11px] leading-relaxed text-[color:var(--wb-danger)]">
                        JSON 解析失败：{parseErr}（右侧保留上一次有效的图）
                      </p>
                    ) : (
                      <p className="text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
                        categories 与 series.values 必须等长；散点图用 points；多面板写 panels、虚线阈值写 guides。不补点、不平滑、不推算。
                      </p>
                    )}
                  </div>
                </>
              )}
            </section>

            <section className="flex min-w-0 flex-1 flex-col bg-[color:var(--wb-surface)]">
              <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-1.5">
                <div className="inline-flex overflow-hidden rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border-strong)]">
                  <button
                    onClick={() => setRight('render')}
                    className={`px-2.5 py-0.5 text-[11.5px] transition ${right === 'render' ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]' : 'text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'}`}
                  >
                    渲染结果
                  </button>
                  <button
                    onClick={() => setRight('live')}
                    className={`px-2.5 py-0.5 text-[11.5px] transition ${right === 'live' ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]' : 'text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]'}`}
                  >
                    spec 实时预览
                  </button>
                </div>
                {right === 'render' ? (
                  <>
                    <span className="text-[10.5px] text-[color:var(--wb-muted)]">
                      {result?.ok ? `matplotlib · ${result.run_id ? '已渲染' : ''}` : 'matplotlib · 未渲染'}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      {outputs.map((o) => (
                        <Btn
                          key={o.name}
                          size="xs"
                          title={`导出 ${o.name}`}
                          onClick={() => download(o.url, o.name)}
                        >
                          <Icon name="download" size={11} />
                          {EXT_LABEL[o.ext] || o.ext}
                        </Btn>
                      ))}
                      {outputs.length === 0 && (
                        <Btn size="xs" loading={rendering} onClick={() => renderPython()}>
                          <Icon name="play" size={11} />
                          渲染
                        </Btn>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="ml-auto text-[10.5px] text-[color:var(--wb-muted)]">Recharts · 数值口径同源</span>
                )}
              </div>

              {right === 'render' ? (
                result?.image ? (
                  <div className="min-h-0 flex-1 overflow-auto bg-[color:var(--wb-surface-alt)] p-4">
                    <img
                      src={`${result.image}&v=${result.run_id || Date.now()}`}
                      alt="matplotlib 渲染结果"
                      className="mx-auto w-full max-w-[960px] rounded-[var(--wb-radius-sm)] border border-[color:var(--wb-border)] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.06)]"
                    />
                    <p className="mt-3 text-center text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
                      {png ? `${png.name} · 300 dpi` : ''} 点右上按钮导出；PDF / SVG 为矢量，可直接进 LaTeX
                    </p>
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                    <Icon name="code" size={22} className="text-[color:var(--wb-muted)]" />
                    <p className="max-w-[380px] text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                      左侧写 / 改 matplotlib 代码，点「渲染」交给本机 python 真跑，出图后这里可导出 PNG / PDF / SVG
                    </p>
                    <Btn size="sm" variant="primary" loading={rendering} onClick={() => renderPython()}>
                      <Icon name="play" size={12} />
                      渲染这段代码
                    </Btn>
                  </div>
                )
              ) : (
                <div className="min-h-0 flex-1">
                  <ChartCanvas spec={spec} height={300} />
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="保存图表 spec"
        width="max-w-md"
        footer={
          <>
            <Btn onClick={() => setNewOpen(false)}>取消</Btn>
            <Btn variant="primary" onClick={() => saveSpec(newName.trim() || 'figure.json')}>
              保存
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <Input value={newName} onChange={setNewName} placeholder="figure.json" ariaLabel="spec 文件名" />
          <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            保存到 data/workspace/figure/ 下，之后可从上方「工作区 spec」下拉里直接选回来。
          </p>
        </div>
      </Modal>
    </div>
    </StudioProGate>
  )
}
