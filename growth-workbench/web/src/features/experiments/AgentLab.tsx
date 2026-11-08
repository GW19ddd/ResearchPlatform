import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Btn, Modal, Pill } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { AiError } from '../../components/AiError'
import ChatPanel, { type ChatMsg, type ChipConf } from '../canvas/ChatPanel'
import { ResizeHandle } from '../../components/ResizeHandle'
import { del, get, post } from '../../lib/api'
import { usePersist } from '../../lib/state'

const fmtSize = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

const RUN_STATUS_TONE: Record<string, 'green' | 'red' | 'blue'> = {
  ok: 'green',
  failed: 'red',
  running: 'blue',
}

const PROV_LABEL: Record<string, string> = {
  measured: '实测',
  simulated: '模拟',
  illustrative: '示意',
}

/** 快捷指令 chips（对标工作台的 Deep search / Write report 行） */
const CHIPS: ChipConf[] = [
  { icon: 'play', label: '生成基线脚本并落账', text: '按设计生成基线脚本，跑一遍并把指标落账', tag: '实验指令' },
  { icon: 'chart', label: '对比两方法表现', text: '对比两种方法在测试集上的表现并落账', tag: '实验指令' },
  { icon: 'lightbulb', label: '设计漏洞分析', text: '这个实验设计有什么漏洞？先别跑代码', tag: '追问' },
]

type ViewFile = { name: string; content: string; size: number } | null

/**
 * 实验 Agent —— 版式与工作台（研究对话）对齐：
 * ChatPanel 版式的对话为主角（Undermind 式气泡 + Worked for + chips + 圆角输入框），
 * 右侧工作区文件面板为可拖宽附属栏。
 */
export function AgentLab({
  exp,
  onChanged,
  actions,
}: {
  exp: any
  onChanged: () => void
  actions?: ReactNode
}) {
  const [rows, setRows] = useState<any[]>([])
  const [files, setFiles] = useState<any[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<any>(null)
  const [viewFile, setViewFile] = useState<ViewFile>(null)
  const [paneW, setPaneW] = usePersist('exp.paneW', 260)

  const load = async () => {
    setRows(await get(`/experiments/${exp.id}/agent/messages`))
    setFiles(await get(`/experiments/${exp.id}/agent/files`))
  }

  useEffect(() => {
    setErr(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exp.id])

  const openFile = async (name: string) => {
    const r: any = await get(`/experiments/${exp.id}/agent/file?name=${encodeURIComponent(name)}`)
    if (r && r.name) setViewFile(r)
  }

  /** DB 行 → ChatMsg：耗时按「本条助手消息 − 上一条用户消息」的间隔估算 */
  const msgs: ChatMsg[] = useMemo(
    () =>
      rows.map((m, i) => {
        if (m.role === 'user') {
          return { role: 'user', content: m.content, skillTag: '实验指令' }
        }
        let elapsed: number | undefined
        for (let j = i - 1; j >= 0; j--) {
          if (rows[j].role === 'user') {
            const d = (Date.parse(m.created_at) || 0) - (Date.parse(rows[j].created_at) || 0)
            if (d > 0) elapsed = d
            break
          }
        }
        const meta = m.meta || {}
        return {
          role: 'assistant',
          content: m.content,
          md: true,
          elapsed,
          applied: meta.run
            ? [
                `${meta.run.status === 'ok' ? '执行成功' : '执行失败'} · ${meta.run.command} · ${(
                  (meta.run.wall_ms || 0) / 1000
                ).toFixed(1)}s`,
              ]
            : meta.files?.length
              ? [`写出 ${meta.files.length} 个文件`]
              : undefined,
          extra: <MetaBlocks meta={meta} onOpenFile={openFile} />,
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  )

  const send = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || busy) return
    setBusy(true)
    setErr(null)
    setInput('')
    try {
      const r: any = await post(`/experiments/${exp.id}/agent`, { message: msg }, { ok: false })
      if (r && r.ok === false) {
        setErr(r.error || { kind: 'unknown', label: 'Agent 没有跑通', message: '请重试' })
      }
    } catch (e: any) {
      setErr(e?.body?.error || { kind: 'network', label: '请求失败', message: String(e) })
    } finally {
      setBusy(false)
      await load()
      onChanged()
    }
  }

  const clearChat = async () => {
    if (!window.confirm('清空对话记录？（工作区文件与运行记录保留）')) return
    await del(`/experiments/${exp.id}/agent/messages`, { ok: false })
    load()
  }

  return (
    <div className="flex h-[680px] overflow-hidden rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-sm)]">
      {/* 对话面板（工作台同款） */}
      <ChatPanel
        title={`实验 Agent · ${exp.name}`}
        exportName={`实验Agent-${exp.name}`}
        messages={msgs}
        busy={busy}
        input={input}
        onInput={setInput}
        onSend={send}
        onClear={clearChat}
        chips={CHIPS}
        minWidth={420}
        dock={
          <>
            {err && (
              <div className="mb-2">
                <AiError
                  error={err}
                  onRetry={() => setErr(null)}
                  retrying={busy}
                  title="这一轮没有跑通，对话历史保留"
                />
              </div>
            )}
            {actions && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-1.5">
                <span className="mr-0.5 flex items-center gap-1 text-[11px] text-[color:var(--wb-muted)]">
                  <Icon name="wand" size={12} /> AI 助手
                </span>
                {actions}
              </div>
            )}
          </>
        }
      />

      {/* 可拖宽分隔条 */}
      <ResizeHandle
        width={paneW}
        onResize={setPaneW}
        onReset={() => setPaneW(260)}
        edge="before"
        min={200}
        max={480}
        label="拖动调整工作区栏宽"
      />

      {/* 工作区文件面板：附属栏 */}
      <div
        style={{ width: paneW }}
        className="flex min-w-0 shrink-0 flex-col bg-[color:var(--wb-surface-alt)]"
      >
        <div className="flex items-center justify-between border-b border-[color:var(--wb-border)] px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">
            <Icon name="file" size={13} className="text-[color:var(--wb-muted)]" />
            工作区文件
          </span>
          <span className="rounded-full bg-[color:var(--wb-bg-subtle)] px-1.5 text-[11px] text-[color:var(--wb-muted)]">
            {files.length}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {files.length === 0 ? (
            <div className="px-2 py-3 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
              Agent 写的脚本与产物会出现在这里，点击查看代码。
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {files.map((f) => (
                <button
                  key={f.name}
                  onClick={() => openFile(f.name)}
                  className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-[color:var(--wb-surface)]"
                  title={f.name}
                >
                  <Icon name="file" size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[color:var(--wb-text-soft)]">
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-[color:var(--wb-muted)]">{fmtSize(f.size)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-[color:var(--wb-border)] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
          输出固定写 runs/&lt;新时间戳&gt;，旧结果永不被覆盖
        </div>
      </div>

      {/* 文件查看器 */}
      <Modal
        open={!!viewFile}
        onClose={() => setViewFile(null)}
        title={
          <span className="flex items-center gap-2 font-mono text-[13px]">
            <Icon name="file" size={14} />
            {viewFile?.name}
          </span>
        }
        width="max-w-3xl"
      >
        <div className="mb-2 text-[11.5px] text-[color:var(--wb-muted)]">
          {viewFile && `${fmtSize(viewFile.size)} · data/exp_ws/${exp.id}/${viewFile.name}`}
        </div>
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-[color:var(--wb-surface-alt)] p-3 font-mono text-[12px] leading-relaxed text-[color:var(--wb-text)]">
          {viewFile?.content}
        </pre>
      </Modal>
    </div>
  )
}

/** 助手消息的附属块：产物文件 chips + 执行块（可展开日志）+ 落账条 */
function MetaBlocks({
  meta,
  onOpenFile,
}: {
  meta: any
  onOpenFile: (name: string) => void
}) {
  const [openLog, setOpenLog] = useState(false)
  const run = meta?.run
  const recorded = meta?.recorded
  const fileNames: string[] = meta?.files || []
  if (!run && !recorded?.id && !fileNames.length) return null
  return (
    <div className="mt-2 flex flex-col items-start gap-2">
      {/* 产物文件 chips */}
      {fileNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[color:var(--wb-muted)]">产物</span>
          {fileNames.map((n: string) => (
            <button
              key={n}
              onClick={() => onOpenFile(n)}
              className="wb-press flex items-center gap-1 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-2 py-0.5 text-[11.5px] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-accent)] hover:text-[color:var(--wb-accent-strong)]"
              title="查看文件内容"
            >
              <Icon name="file" size={11} />
              <span className="font-mono">{n}</span>
            </button>
          ))}
        </div>
      )}

      {/* 执行块：状态 + 命令 + 耗时 + 可展开日志 */}
      {run && (
        <div className="w-full rounded-xl border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Pill tone={RUN_STATUS_TONE[run.status] || 'gray'}>
              {run.status === 'ok' ? '执行成功' : '执行失败'}
            </Pill>
            <Icon name="play" size={12} className="shrink-0 text-[color:var(--wb-muted)]" />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[12px] text-[color:var(--wb-text)]"
              title={run.command}
            >
              {run.command}
            </span>
            <span className="whitespace-nowrap text-[11px] text-[color:var(--wb-muted)]">
              {((run.wall_ms || 0) / 1000).toFixed(1)}s
            </span>
            <Btn size="xs" variant="ghost" onClick={() => setOpenLog(!openLog)}>
              {openLog ? '收起日志' : '日志'}
            </Btn>
          </div>
          {openLog && (
            <pre className="mt-2 max-h-[240px] overflow-auto rounded-lg bg-[color:var(--wb-surface)] p-2 font-mono text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
              {run.tail || '（无输出）'}
            </pre>
          )}
          {run.outputs?.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[color:var(--wb-muted)]">
              <span className="font-medium text-[color:var(--wb-text-soft)]">已登记输出：</span>
              {run.outputs.map((o: any) => (
                <span key={o.path} className="font-mono" title={`${o.path} · sha1 ${o.sha1 || '缺失'}`}>
                  {o.path.split(/[\\/]/).slice(-2).join('/')}
                  {o.missing ? '（缺失）' : ` · ${o.sha1}`}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 自动落账的结果 */}
      {recorded && (
        <div className="flex items-start gap-1.5 rounded-lg bg-[color:var(--wb-ok-soft)] px-2.5 py-1.5 text-[12px] text-[color:var(--wb-ok)]">
          <Icon name="check" size={13} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">
            已落账 <b className="text-[color:var(--wb-text)]">{recorded.case_name}</b>
            {recorded.metrics_json ? ` · ${recorded.metrics_json}` : ''}
            <span className="ml-1 text-[color:var(--wb-muted)]">
              （{PROV_LABEL[recorded.provenance] || recorded.provenance}
              {recorded.provenance !== 'measured' ? ' · 非实测，不进结论' : ''}）
            </span>
          </span>
        </div>
      )}
    </div>
  )
}
