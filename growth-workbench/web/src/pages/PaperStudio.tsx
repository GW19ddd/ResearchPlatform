/**
 * 论文工作室（/studio/paper）：.tex 文件树 → 编辑 → LaTeX 编译 → PDF 预览。
 *
 * 编译命令不接受用户输入：后端 /api/workspace/tex/compile 只认引擎名，
 * 参数由 server/workspace.py 白名单拼装并 shell=False 执行。
 * PDF 预览直接复用全站 PdfViewer（pdf.js），产物走 /api/workspace/artifact 直出。
 *
 * 页面身份由顶栏面包屑承担，这里不再渲染页首大标题（全站约定）。
 */
import { useEffect, useState } from 'react'
import { Btn, Details, IconBtn, Input, Modal, Select, StatusTag } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'
import PdfViewer from '../components/PdfViewer'
import { StudioProGate } from '../components/ProGate'
import { del, get, post, put } from '../lib/api'
import { useApi } from '../lib/hooks'
import { usePersist } from '../lib/state'
import { toast } from '../components/toast'

type FileRow = { name: string; size: number; ext: string }

const isText = (name: string) => !/\.(pdf|png|jpe?g|svg)$/i.test(name)
const artifactUrl = (name: string, v = 0) =>
  `/api/workspace/artifact?kind=tex&name=${encodeURIComponent(name)}&v=${v}`

const FILE_ICON: Record<string, IconName> = {
  '.tex': 'quill',
  '.bib': 'bookOpen',
  '.pdf': 'file',
  '.log': 'notebook',
  '.json': 'chart',
}

export default function PaperStudio() {
  const stApi = useApi<any>('/workspace/status')
  const filesApi = useApi<any[]>('/workspace/files?kind=tex')
  const paperApi = useApi<any>('/paper/overview')

  const [engine, setEngine] = usePersist<string>('studio.paper.engine', 'xelatex')
  const [sel, setSel] = usePersist<string>('studio.paper.file', '')
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [view, setView] = useState<'pdf' | 'log'>('pdf')
  const [pdfName, setPdfName] = useState('')
  const [pdfNonce, setPdfNonce] = useState(0)
  const [logText, setLogText] = useState('')
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('main.tex')
  const [delOpen, setDelOpen] = useState(false)
  const [binDir, setBinDir] = useState('')

  const st = stApi.data
  const files: FileRow[] = filesApi.data || []
  const dirty = !!sel && isText(sel) && text !== saved

  useEffect(() => {
    if (st?.bin_dir) setBinDir(st.bin_dir)
  }, [st?.bin_dir])

  // 首次进入自动选中第一份 .tex，省掉「页面是空的不知道点哪」
  useEffect(() => {
    if (sel || !files.length) return
    const first = files.find((f) => f.name.endsWith('.tex'))
    if (first) setSel(first.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, sel])

  // 选中文本文件才拉内容；PDF 只进右侧预览，不塞进编辑器
  useEffect(() => {
    if (!sel || !isText(sel)) return
    let alive = true
    get<any>(`/workspace/file?kind=tex&name=${encodeURIComponent(sel)}`)
      .then((r) => {
        if (alive) {
          setText(r.content || '')
          setSaved(r.content || '')
        }
      })
      .catch(() => {
        if (alive) {
          setText('')
          setSaved('')
        }
      })
    return () => {
      alive = false
    }
  }, [sel])

  const refreshFiles = () => filesApi.reload()

  const save = async (silent = false) => {
    if (!sel) return false
    try {
      await put('/workspace/file', { kind: 'tex', name: sel, content: text }, { ok: silent ? false : '已保存' })
      setSaved(text)
      return true
    } catch {
      return false
    }
  }

  const pick = (name: string) => {
    if (dirty && !window.confirm(`「${sel}」有未保存的修改，确定切换吗？`)) return
    setSel(name)
    if (/\.pdf$/i.test(name)) {
      setPdfName(name)
      setPdfNonce(Date.now())
      setView('pdf')
    }
  }

  const createFile = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await post('/workspace/file', { kind: 'tex', name }, { ok: '已创建' })
      setNewOpen(false)
      refreshFiles()
      setSel(name)
    } catch (e: any) {
      toast(e?.message || '创建失败', 'error')
    }
  }

  const removeFile = async () => {
    try {
      await del(`/workspace/file?kind=tex&name=${encodeURIComponent(sel)}`, { ok: '已删除' })
      setDelOpen(false)
      const rest = files.filter((f) => f.name !== sel)
      setSel(rest.find((f) => f.name.endsWith('.tex'))?.name || '')
      setText('')
      setSaved('')
      refreshFiles()
    } catch (e: any) {
      toast(e?.message || '删除失败', 'error')
    }
  }

  const compile = async () => {
    if (!sel.endsWith('.tex')) {
      toast('请先选中一个 .tex 文件', 'error')
      return
    }
    if (dirty && !(await save(true))) return
    setBusy(true)
    try {
      const r: any = await post('/workspace/tex/compile', { name: sel, engine }, { ok: false })
      setResult(r)
      setLogText(
        [
          r.error ? `[失败原因] ${r.error}` : '',
          r.log_tail ? '[LaTeX 日志]\n' + r.log_tail : '',
          r.tail ? '[命令输出]\n' + r.tail : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
      if (r.ok && r.pdf) {
        setPdfName(r.pdf)
        setPdfNonce(Date.now())
        setView('pdf')
      } else {
        setView('log')
      }
      refreshFiles()
    } catch (e: any) {
      toast(e?.message || '编译失败', 'error')
      setLogText(String(e?.message || ''))
      setView('log')
    } finally {
      setBusy(false)
    }
  }

  const saveSettings = async () => {
    try {
      await put('/workspace/settings', { bin_dir: binDir, engine }, { ok: '编译设置已保存' })
      stApi.reload()
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error')
    }
  }

  const detect = async () => {
    try {
      const r: any = await post('/workspace/settings/detect', {}, { ok: false })
      if (r.bin_dir) setBinDir(r.bin_dir)
      stApi.reload()
      toast(r.ready ? '已找到本机 LaTeX' : '没找到，请手动填 bin 目录', r.ready ? 'ok' : 'error')
    } catch (e: any) {
      toast(e?.message || '探测失败', 'error')
    }
  }

  const engineOptions = (st?.engines || ['xelatex', 'pdflatex', 'lualatex', 'latexmk']).map((e: string) => ({
    value: e,
    label: e,
  }))

  const pdfSrc = pdfName ? artifactUrl(pdfName, pdfNonce) : ''
  const words = paperApi.data?.words || 0
  const target = paperApi.data?.target_words || 0
  const stages = paperApi.data?.stages || []
  const stageDone = stages.filter((s: any) => s.status === 'done').length

  return (
    <StudioProGate className="h-full min-h-0" label="论文工作室">
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 操作条：只放说明小字与操作，不渲染页首大标题 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="min-w-0 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            .tex 编辑 → LaTeX 编译 → PDF 预览 · 编译命令由后端白名单拼装，不接受自定义命令
          </p>
          {paperApi.data && (
            <p className="mt-0.5 text-[10.5px] text-[color:var(--wb-muted)]">
              论文流水线：已完成 {stageDone}/{stages.length} 阶段 · 字数 {words}/{target || '—'}
            </p>
          )}
        </div>
        {result && (
          <StatusTag tone={result.ok ? 'ok' : 'danger'}>
            {result.ok ? '编译成功' : '编译失败'}
            {result.wall_ms ? ` · ${(result.wall_ms / 1000).toFixed(1)}s` : ''}
          </StatusTag>
        )}
        <Select value={engine} onChange={setEngine} options={engineOptions} />
        <Btn variant="primary" loading={busy} onClick={compile}>
          <Icon name="play" size={13} />
          编译
        </Btn>
        <Btn onClick={() => save()} disabled={!dirty} title="保存当前文件">
          保存
        </Btn>
        <IconBtn icon="plus" size="md" ariaLabel="新建文件" title="新建文件" onClick={() => setNewOpen(true)} />
        <IconBtn icon="refresh" size="md" ariaLabel="刷新文件列表" title="刷新" onClick={refreshFiles} />
      </div>

      {/* 编译设置：TeX 可执行文件目录走 settings 注入（服务进程 PATH 里不一定有 MiKTeX） */}
      <div className="shrink-0 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-1.5">
        <Details
          key={st?.ready ? 'ready' : 'missing'}
          summary="编译设置 · TeX bin 目录与引擎"
          defaultOpen={st?.ready === false}
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[11.5px]">
              <span className="text-[color:var(--wb-text-soft)]">状态：</span>
              {st?.ready ? (
                <StatusTag tone="ok">已就绪 · {st.resolved_exe}</StatusTag>
              ) : (
                <span className="text-[color:var(--wb-danger)]">{st?.hint || '尚未探测到 LaTeX 可执行文件'}</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={binDir}
                onChange={setBinDir}
                placeholder="MiKTeX / TeX Live 的 bin 目录，例：D:\01-App\06_Academic\MiKTeX\miktex\bin\x64"
                className="min-w-[280px] flex-1"
                ariaLabel="TeX bin 目录"
              />
              <Btn size="sm" onClick={detect}>
                自动探测
              </Btn>
              <Btn size="sm" variant="primary" onClick={saveSettings}>
                保存设置
              </Btn>
            </div>
            <p className="text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
              {'默认模板刻意不依赖 ctex：中文请在导言区自行加 \\usepackage[UTF8]{ctex} 并用 xelatex 编译；缺宏包会在编译日志里如实报出来，不会被静默吞掉。'}
            </p>
          </div>
        </Details>
      </div>

      {/* 三栏：文件树 / 编辑器 / 预览与日志 */}
      <div className="flex min-h-0 flex-1">
        {/* 左：文件树 */}
        <aside className="flex w-[208px] shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[color:var(--wb-border)] px-3 py-2">
            <Icon name="folder" size={13} className="text-[color:var(--wb-muted)]" />
            <span className="text-[11.5px] font-medium text-[color:var(--wb-text)]">工作区文件</span>
            <span className="ml-auto text-[10.5px] text-[color:var(--wb-muted)]">{files.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {files.length === 0 && (
              <p className="px-2 py-4 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                工作区还是空的。点右上角 + 新建一份 .tex 开始。
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

        {/* 中：编辑器 */}
        <section className="flex min-w-0 flex-1 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-2">
            <Icon name={FILE_ICON['.tex']} size={13} className="text-[color:var(--wb-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[color:var(--wb-text)]">
              {sel || '未选择文件'}
            </span>
            {dirty && <StatusTag tone="warn">未保存</StatusTag>}
          </div>
          {sel && isText(sel) ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder="在这里写 .tex 源码…"
              className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12.5px] leading-[1.75] text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
              {sel ? '这是二进制产物，请在左侧选择 .tex / .bib 等文本文件编辑，或到右侧预览。' : '从左侧选择一个文件开始编辑。'}
            </div>
          )}
        </section>

        {/* 右：PDF 预览 / 编译日志 */}
        <section className="flex w-[44%] min-w-[320px] shrink-0 flex-col bg-[color:var(--wb-surface)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-2">
            <div className="inline-flex gap-0.5 rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] p-[2px]">
              {(['pdf', 'log'] as const).map((v) => (
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
                  {v === 'pdf' ? 'PDF 预览' : '编译日志'}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            {pdfName && (
              <a
                href={artifactUrl(pdfName, pdfNonce)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-[8px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-2 py-[4px] text-[11px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)]"
              >
                <Icon name="download" size={12} />
                下载 / 新标签
              </a>
            )}
          </div>
          <div className="min-h-0 flex-1">
            {view === 'pdf' ? (
              pdfSrc ? (
                <PdfViewer key={pdfSrc} src={pdfSrc} />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                  还没有 PDF。选中 .tex 后点「编译」，成功会自动在这里预览。
                </div>
              )
            ) : (
              <div className="h-full overflow-auto p-3">
                {logText ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
                    {logText}
                  </pre>
                ) : (
                  <p className="text-[11.5px] text-[color:var(--wb-muted)]">
                    还没有编译日志。编译失败时这里会显示 LaTeX 日志尾部与命令输出。
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* 新建文件 */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="新建工作区文件"
        width="max-w-md"
        footer={
          <>
            <Btn onClick={() => setNewOpen(false)}>取消</Btn>
            <Btn variant="primary" onClick={createFile}>
              创建
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <Input value={newName} onChange={setNewName} placeholder="main.tex" ariaLabel="文件名" />
          <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            填 .tex 会用可编译的最小英文模板；填 .bib / .csv / .py / .json 会给对应起始内容。
            文件名只支持工作区相对路径，不能带 .. 或盘符。
          </p>
        </div>
      </Modal>

      {/* 删除确认 */}
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
          确定删除「{sel}」吗？此操作不可撤销。
        </p>
      </Modal>
    </div>
    </StudioProGate>
  )
}
