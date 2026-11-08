import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Btn, IconBtn, Modal, Pill } from '../../components/ui'
import { Icon, type IconName } from '../../components/Icon'
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

/** 实验技能（对标调研页左栏的技能区）：点一下即作为指令发到对话 */
const SKILLS: { icon: IconName; label: string; text: string }[] = [
  { icon: 'play', label: '生成基线脚本并落账', text: '按设计生成基线脚本，跑一遍并把指标落账' },
  { icon: 'chart', label: '对比两方法表现', text: '对比两种方法在测试集上的表现并落账' },
  { icon: 'lightbulb', label: '设计漏洞分析', text: '这个实验设计有什么漏洞？先别跑代码' },
]

/** 快捷指令 chips（对标工作台的 Deep search / Write report 行） */
const CHIPS: ChipConf[] = SKILLS.map((s) => ({
  icon: s.icon,
  label: s.label,
  text: s.text,
  tag: '实验指令',
}))

type ViewFile = { name: string; content: string; size: number } | null

/**
 * 实验 Agent —— 版式与调研（研究对话）对齐的三栏工作台：
 * 左 dock = 实验列表 + 新建实验 + 技能（可拖宽，对标调研页 Chats/文档/文献 左栏）；
 * 中栏 = ChatPanel（Undermind 式气泡 + chips + 圆角输入框）；
 * 右栏 = 工作区文件面板（可拖宽附属栏）。
 */
export function AgentLab({
  exp,
  exps,
  onSelect,
  onNew,
  onDelete,
  onEditDesign,
  onChanged,
  actions,
}: {
  exp: any
  exps: any[]
  onSelect: (id: number) => void
  onNew: () => void
  onDelete: (id: number) => void
  onEditDesign?: () => void
  onChanged: () => void
  actions?: ReactNode
}) {
  const [rows, setRows] = useState<any[]>([])
  const [files, setFiles] = useState<any[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<any>(null)
  const [viewFile, setViewFile] = useState<ViewFile>(null)
  // 左右两栏宽度各自持久化：刷新 / 切页签都保持（对标调研页 leftW / paneW）
  const [leftW, setLeftW] = usePersist('exp.labLeftW', 220)
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

  /** 左栏技能：点一下即作为指令发送 */
  const runSkill = (s: (typeof SKILLS)[number]) => send(s.text)

  return (
    <div className="flex h-[calc(100vh-260px)] min-h-[560px] overflow-hidden rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-sm)]">
      {/* 左栏 dock：实验列表 + 新建实验 + 技能，可拖宽（对标调研页左栏） */}
      <aside
        data-resizable
        className="flex shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)]"
        style={{ width: leftW, minWidth: 180, maxWidth: 400 }}
      >
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
            实验
          </span>
          <IconBtn icon="plus" size="sm" ariaLabel="新建实验" onClick={onNew} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {exps.map((e) => (
            <div
              key={e.id}
              className={`group flex items-center gap-1 border-l-2 px-2 py-[7px] transition ${
                e.id === exp.id
                  ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface)]'
                  : 'border-transparent hover:bg-[color:var(--wb-surface)]/50'
              }`}
            >
              <button
                onClick={() => onSelect(e.id)}
                aria-current={e.id === exp.id ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title={e.name}
              >
                <Icon
                  name="beaker"
                  size={12}
                  className={`shrink-0 ${e.id === exp.id ? 'text-[color:var(--wb-accent)]' : 'text-[color:var(--wb-muted)]'}`}
                />
                <span
                  className={`truncate text-[12px] ${
                    e.id === exp.id ? 'font-medium text-[color:var(--wb-text)]' : 'text-[color:var(--wb-text-soft)]'
                  }`}
                >
                  {e.name}
                </span>
              </button>
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                {onEditDesign && e.id === exp.id && (
                  <IconBtn
                    icon="pencil"
                    size="sm"
                    ariaLabel="编辑假设与设计"
                    onClick={() => onEditDesign()}
                  />
                )}
                <IconBtn
                  icon="trash"
                  size="sm"
                  tone="danger"
                  ariaLabel="删除实验"
                  onClick={() => onDelete(e.id)}
                />
              </span>
            </div>
          ))}
          {!exps.length && (
            <p className="px-2 py-4 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
              还没有实验。点右上角 + 新建一个，把假设写下来再跑。
            </p>
          )}
        </div>
        <div className="mt-1 border-t border-[color:var(--wb-border)]">
          <span className="block px-2 pb-1.5 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
            技能
          </span>
          <div className="flex flex-col">
            {SKILLS.map((s) => (
              <button
                key={s.label}
                onClick={() => runSkill(s)}
                className="flex w-full items-center gap-2 px-2 py-2 text-left text-[12px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-surface)]/60"
                title={s.text}
              >
                <Icon name={s.icon} size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
                <span className="truncate">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>
      <ResizeHandle
        width={leftW}
        onResize={setLeftW}
        onReset={() => setLeftW(220)}
        min={180}
        max={400}
        label="调整实验列表宽度"
      />

      {/* 中栏对话面板（工作台同款） */}
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
              <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-[color:var(--wb-border)] pb-2">
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
          <span className="rounded-[3px] bg-[color:var(--wb-bg-subtle)] px-1.5 text-[11px] text-[color:var(--wb-muted)]">
            {files.length}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {files.length === 0 ? (
            <div className="px-2 py-3 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
              Agent 写的脚本与产物会出现在这里，点击查看代码。
            </div>
          ) : (
            <div className="flex flex-col">
              {files.map((f) => (
                <button
                  key={f.name}
                  onClick={() => openFile(f.name)}
                  className="flex items-center gap-1.5 px-2 py-1 text-left hover:bg-[color:var(--wb-surface)]/60"
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
