/**
 * 对话框工具条（/chat 工作台 + 共用 ChatPanel 复用）。
 *
 * 参考的输入框能力：
 *   - 回形针附件 / 文件夹上下文（本轮随请求发给后端，注入 system）
 *   - 「代理操作应如何获得批准？」：由我批准 / 完全访问（带说明与勾选）
 *   - 模型下拉（拉 /api/settings/llm/models，档位仍统一 fast，只覆盖本轮模型名）
 *   - 提示词增强、语音输入
 *   - 输入框下方的工作区 / 分支 / Worktree 上下文行
 *   - 用户消息条：时间戳 / 编辑 / 复制
 *
 * 视觉一律走 --wb-* 令牌与 Icon.tsx 图标；浮层用 absolute（不用 fixed，
 * 页面容器一旦带 transform 会变成 fixed 的 containing block）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import { toast } from '../../components/toast'
import { get, post } from '../../lib/api'
import {
  addFiles,
  removeAttachment,
  removeWorkspaceFile,
  setPrefs,
  useChatPrefs,
  type ApprovalMode,
} from './prefs'

// ---------------------------------------------------------------- 基础件

function Dropdown({
  open,
  onClose,
  align = 'left',
  width = 268,
  children,
}: {
  open: boolean
  onClose: () => void
  align?: 'left' | 'right'
  width?: number
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      ref={ref}
      className={`absolute bottom-full z-40 mb-2 ${align === 'right' ? 'right-0' : 'left-0'} rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-1.5 shadow-[var(--wb-shadow-lg)]`}
      style={{ width, maxWidth: 'calc(100vw - 32px)' }}
    >
      {children}
    </div>
  )
}

function ToolButton({
  icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: IconName
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] transition disabled:opacity-40 ${
        active
          ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
          : 'text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'
      }`}
    >
      <Icon name={icon} size={14} />
    </button>
  )
}

// ---------------------------------------------------------------- 审批模式

const APPROVAL_OPTS: { value: ApprovalMode; icon: IconName; title: string; desc: string }[] = [
  { value: 'ask', icon: 'hand', title: '由我批准', desc: '在删除、安装或访问远程资源前询问' },
  { value: 'full', icon: 'bolt', title: '完全访问', desc: '不询问即运行所有命令' },
]

/** variant='text' 用于输入框下方的状态行（参考图里的红色「允许完全访问」） */
export function ApprovalChip({ variant = 'chip' }: { variant?: 'chip' | 'text' }) {
  const { approval } = useChatPrefs()
  const [open, setOpen] = useState(false)
  const full = approval === 'full'
  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="代理操作应如何获得批准？"
        className={`inline-flex items-center gap-1 whitespace-nowrap transition ${
          variant === 'text'
            ? `rounded-[6px] px-1 py-0.5 text-[11px] hover:bg-[color:var(--wb-bg-subtle)] ${full ? 'text-[color:var(--wb-danger)]' : 'text-[color:var(--wb-muted)]'}`
            : `rounded-full border px-2 py-[3px] text-[11px] ${
                full
                  ? 'border-[color:var(--wb-danger)]/35 bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]'
                  : 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-border-strong)]'
              }`
        }`}
      >
        <Icon name={full ? 'bolt' : 'hand'} size={12} />
        <span>{full ? '允许完全访问' : '由我批准'}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      <Dropdown open={open} onClose={() => setOpen(false)} align={variant === 'text' ? 'right' : 'left'} width={286}>
        <div className="px-2 pb-1 pt-1 text-[11.5px] text-[color:var(--wb-muted)]">代理操作应如何获得批准？</div>
        {APPROVAL_OPTS.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => {
              setPrefs({ approval: o.value })
              setOpen(false)
              toast(o.value === 'full' ? '已切换为完全访问' : '已切换为由我批准', 'ok')
            }}
            className="flex w-full items-start gap-2.5 rounded-[8px] px-2 py-2 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
          >
            <Icon name={o.icon} size={15} className="mt-[2px] shrink-0 text-[color:var(--wb-muted)]" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-[12.5px] font-medium text-[color:var(--wb-text)]">{o.title}</span>
              <span className="block text-[10.5px] text-[color:var(--wb-muted)]">{o.desc}</span>
            </span>
            {approval === o.value && (
              <Icon name="check" size={14} className="mt-1 shrink-0 text-[color:var(--wb-accent)]" />
            )}
          </button>
        ))}
        <div className="mx-2 mt-1 border-t border-[color:var(--wb-border)] px-0 pb-0.5 pt-1.5 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
          当前仅随请求传给后端并写入本轮提示词；命令执行闸门尚未接入。
        </div>
      </Dropdown>
    </div>
  )
}

// ---------------------------------------------------------------- 模型下拉

type ModelState = { models: string[]; fallback: string; loaded: boolean; error?: string }

export function ModelPicker() {
  const { model } = useChatPrefs()
  const [open, setOpen] = useState(false)
  const [st, setSt] = useState<ModelState>({ models: [], fallback: '', loaded: false })

  useEffect(() => {
    if (!open || st.loaded) return
    let alive = true
    ;(async () => {
      try {
        const cfg: any = await get('/settings/llm')
        const ps: any[] = cfg?.providers || []
        const def = ps.find((p) => p.id === cfg?.default_provider) || ps[0]
        const fallback = String(def?.model_fast || def?.model_reason || '')
        let models: string[] = []
        if (def?.id) {
          const r: any = await post('/settings/llm/models', { id: def.id }, { silent: true })
          models = (r?.models || []).filter((x: unknown) => typeof x === 'string')
        }
        if (!models.length && fallback) models = [fallback]
        if (alive) setSt({ models, fallback, loaded: true, error: models.length ? '' : '未拉取到模型列表' })
      } catch (e: any) {
        if (alive) setSt({ models: [], fallback: '', loaded: true, error: e?.message || '模型列表读取失败' })
      }
    })()
    return () => {
      alive = false
    }
  }, [open, st.loaded])

  const label = model || st.fallback || '默认模型'
  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="选择本轮使用的模型"
        className="inline-flex max-w-[168px] items-center gap-1 rounded-[8px] px-1.5 py-1 text-[11px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)]"
      >
        <Icon name="cpu" size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
        <span className="truncate">{label}</span>
        <Icon name="chevronDown" size={10} className="shrink-0" />
      </button>
      <Dropdown open={open} onClose={() => setOpen(false)} align="right" width={262}>
        <div className="px-2 pb-1 pt-1 text-[11.5px] text-[color:var(--wb-muted)]">本轮模型</div>
        <div className="px-2 pb-1.5 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
          档位仍由全站设置统一 fast，这里只临时覆盖模型名。
        </div>
        <div className="max-h-52 overflow-y-auto">
          <button
            type="button"
            onClick={() => {
              setPrefs({ model: '' })
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-[color:var(--wb-text)]">跟随全局设置</span>
              <span className="block truncate text-[10.5px] text-[color:var(--wb-muted)]">
                {st.fallback ? `当前：${st.fallback}` : '未配置默认模型'}
              </span>
            </span>
            {!model && <Icon name="check" size={14} className="text-[color:var(--wb-accent)]" />}
          </button>
          {st.models.length > 0 && <div className="mx-2 my-1 border-t border-[color:var(--wb-border)]" />}
          {st.models.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setPrefs({ model: m })
                setOpen(false)
                toast(`本轮模型：${m}`, 'ok')
              }}
              className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--wb-text)]" title={m}>
                {m}
              </span>
              {model === m && <Icon name="check" size={14} className="shrink-0 text-[color:var(--wb-accent)]" />}
            </button>
          ))}
          {st.error && (
            <div className="px-2 py-2 text-[10.5px] leading-relaxed text-[color:var(--wb-danger)]">{st.error}</div>
          )}
        </div>
        <div className="mx-2 mt-1 border-t border-[color:var(--wb-border)] pt-1.5">
          <button
            type="button"
            onClick={() => setSt({ models: [], fallback: '', loaded: false })}
            className="flex w-full items-center gap-1.5 rounded-[8px] px-2 py-1 text-left text-[11px] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)]"
          >
            <Icon name="refresh" size={12} />
            重新拉取模型列表
          </button>
        </div>
      </Dropdown>
    </div>
  )
}

// ---------------------------------------------------------------- 附件 chips

export function AttachmentChips() {
  const p = useChatPrefs()
  if (!p.attachments.length && !p.workspaceFiles.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-3.5 pt-2.5">
      {p.attachments.map((a, i) => (
        <span
          key={`a-${i}`}
          title={`${a.name} · ${Math.round(a.size / 1024)} KB${a.text ? ' · 正文随本轮发送' : ' · 仅文件名'}`}
          className="inline-flex max-w-[190px] items-center gap-1 rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2 py-1 text-[11px] text-[color:var(--wb-text-soft)]"
        >
          <Icon name="paperclip" size={11} className="shrink-0 text-[color:var(--wb-muted)]" />
          <span className="truncate">{a.name}</span>
          <button
            type="button"
            onClick={() => removeAttachment(i)}
            aria-label={`移除附件 ${a.name}`}
            className="ml-0.5 rounded-full transition hover:opacity-60"
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      {p.workspaceFiles.map((f, i) => (
        <span
          key={`d-${i}`}
          title={f}
          className="inline-flex max-w-[190px] items-center gap-1 rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2 py-1 text-[11px] text-[color:var(--wb-text-soft)]"
        >
          <Icon name="folder" size={11} className="shrink-0 text-[color:var(--wb-muted)]" />
          <span className="truncate">{f.split('/').slice(-1)[0]}</span>
          <button
            type="button"
            onClick={() => removeWorkspaceFile(i)}
            aria-label={`移除文件 ${f}`}
            className="ml-0.5 rounded-full transition hover:opacity-60"
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- 工具组

const ENHANCE: { label: string; desc: string; apply: (t: string) => string }[] = [
  {
    label: '补充背景与限制',
    desc: '要求说明适用条件与已知局限',
    apply: (t) => `${t}\n\n请补充：研究背景、适用条件与已知限制；不确定的地方明确标注。`,
  },
  {
    label: '要求证据与出处',
    desc: '结论必须有可追溯的证据',
    apply: (t) =>
      `${t}\n\n每个结论请给出可追溯的证据或出处；没有证据支撑的断言标注「待验证」，不要编造数据或引用。`,
  },
  {
    label: '分点并给判据',
    desc: '每点附可验证的判据与下一步',
    apply: (t) => `${t}\n\n请分点作答，每点给出可验证的判据与下一步操作。`,
  },
]

export function ComposerTools({
  getInput,
  onTranscript,
  onEnhance,
  disabled,
}: {
  getInput: () => string
  onTranscript: (text: string) => void
  onEnhance: (text: string) => void
  disabled?: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const recRef = useRef<any>(null)
  const [enhanceOpen, setEnhanceOpen] = useState(false)
  const [listening, setListening] = useState(false)

  useEffect(
    () => () => {
      try {
        recRef.current?.stop()
      } catch {
        /* ignore */
      }
    },
    [],
  )

  const toggleVoice = () => {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!Ctor) {
      toast('当前浏览器不支持语音输入（需 Chrome / Edge）', 'error')
      return
    }
    if (listening) {
      try {
        recRef.current?.stop()
      } catch {
        /* ignore */
      }
      setListening(false)
      return
    }
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = false
    rec.interimResults = false
    rec.onresult = (e: any) => {
      const t = e?.results?.[0]?.[0]?.transcript || ''
      if (t) onTranscript(t)
    }
    rec.onerror = () => {
      setListening(false)
      toast('语音识别失败，请检查麦克风权限', 'error')
    }
    rec.onend = () => setListening(false)
    recRef.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      toast('无法启动语音识别', 'error')
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={async (e) => {
          if (e.target.files?.length) await addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {/* 文件夹选择器：webkitdirectory 非标准属性，用对象展开避免 TS 报错 */}
      <input
        ref={dirRef}
        type="file"
        multiple
        className="hidden"
        {...({ webkitdirectory: '' } as any)}
        onChange={async (e) => {
          if (e.target.files?.length) await addFiles(e.target.files, true)
          e.target.value = ''
        }}
      />
      <ToolButton icon="paperclip" label="添加附件（文本类文件正文随本轮发送）" disabled={disabled} onClick={() => fileRef.current?.click()} />
      <ToolButton icon="folder" label="添加文件夹文件树作为上下文" disabled={disabled} onClick={() => dirRef.current?.click()} />
      <div className="relative inline-flex">
        <ToolButton icon="wand" label="提示词增强" active={enhanceOpen} onClick={() => setEnhanceOpen((o) => !o)} />
        <Dropdown open={enhanceOpen} onClose={() => setEnhanceOpen(false)} width={252}>
          <div className="px-2 pb-1 pt-1 text-[11.5px] text-[color:var(--wb-muted)]">给这句话加点约束</div>
          {ENHANCE.map((e) => (
            <button
              key={e.label}
              type="button"
              onClick={() => {
                const t = getInput().trim()
                if (!t) {
                  toast('先在输入框写一句话，再点增强', 'error')
                  return
                }
                onEnhance(e.apply(t))
                setEnhanceOpen(false)
              }}
              className="flex w-full flex-col gap-0.5 rounded-[8px] px-2 py-1.5 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
            >
              <span className="text-[12px] font-medium text-[color:var(--wb-text)]">{e.label}</span>
              <span className="text-[10.5px] text-[color:var(--wb-muted)]">{e.desc}</span>
            </button>
          ))}
        </Dropdown>
      </div>
      <ToolButton
        icon="mic"
        label={listening ? '停止语音输入' : '语音输入'}
        active={listening}
        onClick={toggleVoice}
      />
      <ApprovalChip />
    </>
  )
}

// ---------------------------------------------------------------- 工作区上下文行

export function ContextBar() {
  const p = useChatPrefs()
  const [editing, setEditing] = useState<null | 'workspace' | 'branch'>(null)
  const [draft, setDraft] = useState('')
  const start = (which: 'workspace' | 'branch') => {
    setDraft(which === 'workspace' ? p.workspace : p.branch)
    setEditing(which)
  }
  const commit = () => {
    if (editing) setPrefs({ [editing]: draft.trim() } as any)
    setEditing(null)
  }
  const field = (which: 'workspace' | 'branch', icon: IconName, value: string) => (
    <span className="inline-flex items-center gap-1 rounded-[6px] px-1 py-0.5 transition hover:bg-[color:var(--wb-bg-subtle)]">
      <Icon name={icon} size={12} className="shrink-0" />
      {editing === which ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(null)
          }}
          className="w-28 bg-transparent text-[11px] text-[color:var(--wb-text)] outline-none"
        />
      ) : (
        <button type="button" onClick={() => start(which)} title="点击修改" className="max-w-[160px] truncate">
          {value || '未设置'}
        </button>
      )}
      <Icon name="chevronDown" size={9} />
    </span>
  )
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 px-1 text-[11px] text-[color:var(--wb-muted)]">
      {field('workspace', 'folder', p.workspace)}
      {field('branch', 'gitBranch', p.branch)}
      <button
        type="button"
        onClick={() => setPrefs({ worktree: !p.worktree })}
        title="标记本轮在 worktree 中工作"
        className={`inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 transition ${
          p.worktree
            ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
            : 'hover:bg-[color:var(--wb-bg-subtle)]'
        }`}
      >
        <Icon name="layers" size={11} />
        Worktree
      </button>
      <span className="flex-1" />
      <ApprovalChip variant="text" />
    </div>
  )
}

// ---------------------------------------------------------------- 消息操作条

export function MessageActions({
  time,
  content,
  onEdit,
  editTitle = '编辑这条消息',
  extra,
  align = 'right',
}: {
  time?: string
  content: string
  onEdit?: () => void
  editTitle?: string
  extra?: ReactNode
  align?: 'right' | 'left'
}) {
  const copy = () => {
    navigator.clipboard?.writeText(content)
    toast('已复制到剪贴板', 'ok')
  }
  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-0.5 text-[11px] text-[color:var(--wb-muted)] ${align === 'right' ? 'justify-end' : ''}`}
    >
      {time && <span className="mr-1 tabular-nums">{time}</span>}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          title={editTitle}
          aria-label={editTitle}
          className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
        >
          <Icon name="pencil" size={13} />
        </button>
      )}
      <button
        type="button"
        onClick={copy}
        title="复制"
        aria-label="复制"
        className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
      >
        <Icon name="copy" size={13} />
      </button>
      {extra}
    </div>
  )
}

/** 本地时钟格式：ChatPanel 的消息没有服务端时间戳，用消息出现在页面上的真实时间 */
export function hhmm(d = new Date()) {
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
