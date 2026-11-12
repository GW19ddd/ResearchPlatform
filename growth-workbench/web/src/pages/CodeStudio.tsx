/**
 * 代码工作室（/studio/code）：code 工作区里写 .py → 用服务进程所在 venv（含 pandas/numpy…）真实运行。
 *
 * 运行入口 /api/workspace/code/run 只允许跑工作区内已存在的 .py 文件，
 * 命令由后端拼装、subprocess.run(shell=False)，不开放任意命令行输入。
 * 产物（CSV / PNG / TXT）落在工作区，复用 /api/workspace/artifact 直出与下载。
 */
import { useEffect, useState } from 'react'
import { Btn, IconBtn, Input, Modal, StatusTag } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'
import { del, get, post, put } from '../lib/api'
import { useApi } from '../lib/hooks'
import { usePersist } from '../lib/state'
import { toast } from '../components/toast'
import { StudioProGate } from '../components/ProGate'

type FileRow = { name: string; size: number; ext: string }
type RunOut = {
  ok: boolean
  status: string
  wall_ms: number
  stdout: string
  outputs: string[]
  error: string | null
}

const FILE_ICON: Record<string, IconName> = {
  '.py': 'cpu',
  '.csv': 'grid',
  '.json': 'chart',
  '.png': 'image',
  '.txt': 'notebook',
}

const isText = (name: string) => !/\.(png|jpe?g|svg|gif)$/i.test(name)
const artifactUrl = (name: string, v = 0) =>
  `/api/workspace/artifact?kind=code&name=${encodeURIComponent(name)}&v=${v}`

export default function CodeStudio() {
  const filesApi = useApi<FileRow[]>('/workspace/files?kind=code')
  const [sel, setSel] = usePersist<string>('studio.code.file', '')
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [result, setResult] = useState<RunOut | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'stdout' | 'outputs'>('stdout')
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('script.py')
  const [delOpen, setDelOpen] = useState(false)

  const files: FileRow[] = filesApi.data || []
  const dirty = !!sel && isText(sel) && text !== saved

  useEffect(() => {
    if (sel || !files.length) return
    const first = files.find((f) => f.name.endsWith('.py'))
    if (first) setSel(first.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, sel])

  useEffect(() => {
    if (!sel || !isText(sel)) return
    let alive = true
    get<any>(`/workspace/file?kind=code&name=${encodeURIComponent(sel)}`)
      .then((r) => {
        if (alive) {
          setText(r.content || '')
          setSaved(r.content || '')
        }
      })
      .catch(() => alive && setText(''))
    return () => {
      alive = false
    }
  }, [sel])

  const refresh = () => filesApi.reload()

  const save = async (silent = false) => {
    if (!sel) return false
    try {
      await put('/workspace/file', { kind: 'code', name: sel, content: text }, { ok: silent ? false : '已保存' })
      setSaved(text)
      return true
    } catch {
      return false
    }
  }

  const pick = (name: string) => {
    if (dirty && !window.confirm(`「${sel}」有未保存的修改，确定切换吗？`)) return
    setSel(name)
    setResult(null)
  }

  const createFile = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await post('/workspace/file', { kind: 'code', name }, { ok: '已创建' })
      setNewOpen(false)
      refresh()
      setSel(name)
    } catch (e: any) {
      toast(e?.message || '创建失败', 'error')
    }
  }

  const removeFile = async () => {
    try {
      await del(`/workspace/file?kind=code&name=${encodeURIComponent(sel)}`, { ok: '已删除' })
      setDelOpen(false)
      const rest = files.filter((f) => f.name !== sel)
      setSel(rest.find((f) => f.name.endsWith('.py'))?.name || '')
      setText('')
      setSaved('')
      setResult(null)
      refresh()
    } catch (e: any) {
      toast(e?.message || '删除失败', 'error')
    }
  }

  const run = async () => {
    if (!sel.endsWith('.py')) {
      toast('请先选中一个 .py 文件', 'error')
      return
    }
    if (dirty && !(await save(true))) return
    setBusy(true)
    try {
      const r = await post<RunOut>('/workspace/code/run', { name: sel }, { ok: false })
      setResult(r)
      setView(r.ok ? 'outputs' : 'stdout')
      refresh()
    } catch (e: any) {
      toast(e?.message || '运行失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const outputs = result?.outputs || []

  return (
    <StudioProGate className="h-full min-h-0" label="代码工作室">
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* 操作条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="min-w-0 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            编辑 .py → 用服务进程所在 venv 真实运行 · 命令由后端白名单拼装（shell=False），不开放任意命令行
          </p>
        </div>
        {result && (
          <StatusTag tone={result.ok ? 'ok' : 'danger'}>
            {result.ok ? '运行成功' : '运行失败'}
            {result.wall_ms ? ` · ${(result.wall_ms / 1000).toFixed(1)}s` : ''}
          </StatusTag>
        )}
        <Btn variant="primary" loading={busy} onClick={run} disabled={!sel}>
          <Icon name="play" size={13} />
          运行
        </Btn>
        <Btn onClick={() => save()} disabled={!dirty}>
          保存
        </Btn>
        <IconBtn icon="plus" size="md" ariaLabel="新建脚本" title="新建脚本" onClick={() => setNewOpen(true)} />
        <IconBtn icon="refresh" size="md" ariaLabel="刷新文件列表" title="刷新" onClick={refresh} />
      </div>

      {/* 三栏：文件树 / 编辑器 / 输出 */}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[208px] shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[color:var(--wb-border)] px-3 py-2">
            <Icon name="folder" size={13} className="text-[color:var(--wb-muted)]" />
            <span className="text-[11.5px] font-medium text-[color:var(--wb-text)]">代码工作区</span>
            <span className="ml-auto text-[10.5px] text-[color:var(--wb-muted)]">{files.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {files.length === 0 && (
              <p className="px-2 py-4 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                工作区还是空的。点右上角 + 新建一份 .py 开始。
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
            <Icon name={FILE_ICON['.py']} size={13} className="text-[color:var(--wb-muted)]" />
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
              placeholder="在这里写 Python 脚本…"
              className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12.5px] leading-[1.75] text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
              {sel ? '这是二进制产物，请在左侧选择 .py 编辑，或到右侧查看输出。' : '从左侧选择一个文件开始编辑。'}
            </div>
          )}
        </section>

        {/* 右：stdout / 产物 */}
        <section className="flex w-[44%] min-w-[320px] shrink-0 flex-col bg-[color:var(--wb-surface)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3 py-2">
            <div className="inline-flex gap-0.5 rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] p-[2px]">
              {(['stdout', 'outputs'] as const).map((v) => (
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
                  {v === 'stdout' ? '标准输出' : `产物 ${outputs.length}`}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {view === 'stdout' ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
                {result?.stdout || '还没有运行输出。点「运行」后，脚本的 stdout / stderr 会显示在这里。'}
              </pre>
            ) : outputs.length ? (
              <div className="flex flex-col gap-2">
                {outputs.map((o) => (
                  <div
                    key={o}
                    className="flex items-center gap-2 rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-2"
                  >
                    <Icon name={FILE_ICON[('.' + o.split('.').pop()) || ''] || 'file'} size={14} className="shrink-0 text-[color:var(--wb-muted)]" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[color:var(--wb-text-soft)]">{o}</span>
                    <a
                      href={artifactUrl(o, Date.now())}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 rounded-[8px] border border-[color:var(--wb-border-strong)] px-2 py-[3px] text-[11px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)]"
                    >
                      <Icon name="download" size={11} />
                      打开
                    </a>
                  </div>
                ))}
                {outputs.filter((o) => /\.png$/i.test(o)).map((o) => (
                  <img
                    key={'img-' + o}
                    src={artifactUrl(o, Date.now())}
                    alt={o}
                    className="mx-auto max-w-full rounded-lg border border-[color:var(--wb-border)]"
                  />
                ))}
              </div>
            ) : (
              <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                这次运行没有产生新文件产物（脚本只打印了内容，或运行失败）。
              </p>
            )}
          </div>
        </section>
      </div>

      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="新建脚本"
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
          <Input value={newName} onChange={setNewName} placeholder="script.py" ariaLabel="文件名" />
          <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            填 .py 会给一段起始脚本；工作区已带 pandas / matplotlib / scipy / openpyxl，直接 import 即可。
          </p>
        </div>
      </Modal>

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
