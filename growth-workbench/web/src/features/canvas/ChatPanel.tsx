import {
  cloneElement, isValidElement, useEffect, useRef, useState,
  type ReactElement, type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon, type IconName } from '../../components/Icon'
import { IconBtn } from '../../components/ui'
import {
  AttachmentChips,
  ComposerTools,
  ContextBar,
  MessageActions,
  ModelPicker,
  hhmm,
} from '../chat/ComposerTools'

/**
 * Undermind 式对话面板 —— 画布对话与研究对话（/research）共用：
 * 用户消息 = 右侧胶囊 + 上方「触发指令」小签；
 * 助手消息 = 无气泡，顶部「Worked for Xs ›」可展开步骤 → 「Thinking ›」可折叠思路
 *          → 正文 → 引用/已执行小签 → 右对齐的后续建议胶囊；报告消息渲染成「查看报告」卡；
 * 底部 = 快捷操作 chips（调用方注入）+ 圆角输入框（+ 菜单 = 示例 + 导入入口、圆形↑发送键）。
 */
export type Citation = {
  n: number
  lit_id?: number
  title?: string
  authors?: string
  year?: number | string
  doi?: string
  url?: string
  cited_by?: number
  venue?: string
}

export type ChatMsg = {
  role: 'user' | 'assistant'
  content: string
  kind?: 'text' | 'deep' | 'report'
  applied?: string[]
  plan?: string[]
  suggests?: string[]
  citations?: Citation[]
  queries?: string[]
  elapsed?: number
  skillTag?: string
  /** 正文按 Markdown 渲染（默认纯文本；实验 Agent 等非流式场景用） */
  md?: boolean
  /** 消息附属块插槽（产物 chips / 执行块 / 落账条等），渲染在引用小签之后 */
  extra?: ReactNode
}

export type ChipConf = {
  icon: IconName
  label: string
  text: string
  tag: string
  onClick?: () => void
  /** 选中态：chip 已挂到输入框时用，避免再开弹窗也能看出当前模式 */
  active?: boolean
}
export type PlusItem = { icon: IconName; label: string; desc: string; onClick: () => void }

type Props = {
  title: string
  messages: ChatMsg[]
  busy: boolean
  input: string
  onInput: (v: string) => void
  onSend: (text?: string, tag?: string) => void
  onClear: () => void
  onClose?: () => void
  onReport?: (m: ChatMsg) => void
  chips?: ChipConf[]
  samples?: string[]
  plusItems?: PlusItem[]
  exportName?: string
  /** 提案卡插槽：渲染在快捷 chips 与输入框之间（兼容保留；研究对话已改为输入框内挂载） */
  proposal?: ReactNode
  /** 输入框内已挂载的能力 / 技能 chip，渲染在 textarea 上方 */
  composerChips?: ReactNode
  /** 贴在输入框上方的浮层插槽（技能选择器），由调用方控制开关 */
  composerOverlay?: ReactNode
  /** 浮层打开时，textarea 的 Enter 不触发发送（避免和技能选择器的 Enter 抢） */
  overlayOpen?: boolean
  /** 调用方按挂载的能力给不同的输入提示，不传用默认 */
  placeholder?: string
  /** 常驻卡插槽：渲染在底部操作区最上方（进度框 / 文献检索结果卡），不随消息流滚走 */
  dock?: ReactNode
  /** 可选最小宽度：多栏拖拽时保证对话面板不被两侧栏压没；不传则沿用 min-w-0 */
  minWidth?: number
  /** /research：点正文 [n] 或引用 chips 时打开对应文献详情；不传则保持旧的外链行为 */
  onCite?: (c: Citation) => void
  /** 顶栏右侧自定义插槽（提问历史跳转等） */
  headerExtra?: ReactNode
  /** 跳到第 index 条消息并短暂高亮；nonce 变化才触发（同一条可重复点） */
  jumpTo?: { index: number; nonce: number } | null
}

/** 把一段文本里的 [n] 变成可点的引用按钮；找不到对应文献时保留原文，不造引用 */
function citeText(s: string, cits: Citation[], onCite: (c: Citation) => void, key: string): ReactNode {
  const re = /\[(\d+)\]/g
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(<span key={`${key}-t${i++}`}>{s.slice(last, m.index)}</span>)
    const n = Number(m[1])
    const c = cits.find((x) => Number(x.n) === n)
    out.push(
      c ? (
        <button
          key={`${key}-c${i++}`}
          type="button"
          onClick={() => onCite(c)}
          title={`查看引用 [${n}] 对应的文献：${c.title || ''}`}
          className="wb-cite-mark"
        >
          [{n}]
        </button>
      ) : (
        <span key={`${key}-c${i++}`}>[{n}]</span>
      ),
    )
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(<span key={`${key}-t${i++}`}>{s.slice(last)}</span>)
  return out
}

/** 递归穿过 react-markdown 生成的元素树，只替换文本节点里的 [n] */
function withCites(
  nodes: ReactNode, cits: Citation[], onCite: (c: Citation) => void, key: string,
): ReactNode {
  if (typeof nodes === 'string') return citeText(nodes, cits, onCite, key)
  if (Array.isArray(nodes)) return nodes.map((n, i) => withCites(n, cits, onCite, `${key}-${i}`))
  if (isValidElement(nodes)) {
    const el = nodes as ReactElement<any>
    const children = el.props?.children
    if (children === undefined || children === null) return nodes
    return cloneElement(el, undefined, withCites(children, cits, onCite, `${key}-c`))
  }
  return nodes
}

/** 聊天正文的 Markdown：标题/列表/表格 + 可点 [n] 引用；md=false 的调用方仍走纯文本 */
function RichMd({
  text, cits, onCite,
}: {
  text: string
  cits: Citation[]
  onCite?: (c: Citation) => void
}) {
  const enabled = !!onCite && cits.length > 0
  const dec = (nodes: ReactNode, key: string) =>
    enabled && onCite ? withCites(nodes, cits, onCite, key) : nodes
  const components: any = {
    p: ({ node: _n, children }: any) => <p>{dec(children, 'p')}</p>,
    li: ({ node: _n, children }: any) => <li>{dec(children, 'li')}</li>,
    h1: ({ node: _n, children }: any) => <h1>{dec(children, 'h1')}</h1>,
    h2: ({ node: _n, children }: any) => <h2>{dec(children, 'h2')}</h2>,
    h3: ({ node: _n, children }: any) => <h3>{dec(children, 'h3')}</h3>,
    h4: ({ node: _n, children }: any) => <h4>{dec(children, 'h4')}</h4>,
    strong: ({ node: _n, children }: any) => <strong>{dec(children, 'strong')}</strong>,
    em: ({ node: _n, children }: any) => <em>{dec(children, 'em')}</em>,
    td: ({ node: _n, children }: any) => <td>{dec(children, 'td')}</td>,
    th: ({ node: _n, children }: any) => <th>{dec(children, 'th')}</th>,
    a: ({ node: _n, ...props }: any) => <a {...props} target="_blank" rel="noreferrer" />,
  }
  return (
    <div className="markdown-block wb-chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text || ''}
      </ReactMarkdown>
    </div>
  )
}

const fmtSec = (ms?: number) => `${Math.max(1, Math.round((ms || 0) / 1000))}s`

/** 从「已执行」描述猜一个小图标（新增/连线/改名/配置/删除） */
function opIcon(text: string): IconName {
  if (text.startsWith('新增')) return 'plus'
  if (text.startsWith('连线')) return 'link'
  if (text.startsWith('重命名')) return 'pencil'
  if (text.startsWith('配置')) return 'gear'
  if (text.startsWith('删除')) return 'trash'
  return 'check'
}

/** 引用小签的短标签：[1] First-author Year */
export function citeLabel(c: Citation): string {
  const first = (c.authors || '').split(',')[0]?.trim() || '佚名'
  return `[${c.n}] ${first} ${c.year ?? ''}`.trim()
}

function citeUrl(c: Citation): string {
  if (c.doi) return `https://doi.org/${c.doi}`
  return c.url || ''
}

function exportMd(name: string, msgs: ChatMsg[]) {
  const lines = [`# ${name}`, '']
  for (const m of msgs) {
    lines.push(m.role === 'user' ? `**> ${m.content}**` : m.content)
    if (m.citations?.length) {
      lines.push('', '参考文献：')
      for (const c of m.citations) lines.push(`- ${citeLabel(c)} ${c.title || ''} ${c.doi ? `（doi:${c.doi}）` : ''}`)
    }
    lines.push('')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}-${Date.now()}.md`
  a.click()
  URL.revokeObjectURL(a.href)
}

/** 引用小签行：/research 传 onCite 时显示文献标题、点开对应详情；其它入口保持点开 DOI */
function CiteChips({ cits, onCite }: { cits: Citation[]; onCite?: (c: Citation) => void }) {
  if (!cits.length) return null
  const cls =
    'flex max-w-[20rem] items-center gap-1 rounded-full border border-[color:var(--wb-accent)]/25 ' +
    'bg-[color:var(--wb-accent-soft)] px-2 py-[2px] text-[10.5px] text-[color:var(--wb-accent-strong)] transition hover:brightness-[0.96]'
  return (
    <div className="flex flex-wrap gap-1.5">
      {cits.map((c, k) => {
        const url = citeUrl(c)
        if (onCite) {
          return (
            <button
              key={k}
              type="button"
              onClick={() => onCite(c)}
              title={`查看文献：${c.title || ''}${c.venue ? ` · ${c.venue}` : ''}`}
              className={cls}
            >
              <span className="shrink-0">[{c.n}]</span>
              <span className="truncate">{c.title || citeLabel(c)}</span>
              <Icon name="chevronRight" size={10} className="shrink-0 opacity-60" />
            </button>
          )
        }
        return url ? (
          <a key={k} href={url} target="_blank" rel="noreferrer"
            title={`${c.title || ''}${c.venue ? ` · ${c.venue}` : ''}`} className={cls}>
            <span className="truncate">{citeLabel(c)}</span>
          </a>
        ) : (
          <span key={k} title={c.title || ''} className={cls}>
            <span className="truncate">{citeLabel(c)}</span>
          </span>
        )
      })}
    </div>
  )
}

/** 一条助手消息：Worked for › / Thinking › / 正文 / 引用签 / 建议胶囊 */
function AssistantMsg({
  m,
  onSend,
  onReport,
  onCite,
}: {
  m: ChatMsg
  onSend: (t: string) => void
  onReport?: (m: ChatMsg) => void
  onCite?: (c: Citation) => void
}) {
  const [stepsOpen, setStepsOpen] = useState(false)
  const [thinkOpen, setThinkOpen] = useState(false)
  const isReport = m.kind === 'report'
  const cits = m.citations || []
  return (
    <div className="flex flex-col items-start gap-2">
      {/* Worked for Xs › —— 点开看执行步骤 */}
      <button
        onClick={() => setStepsOpen(!stepsOpen)}
        className="flex items-center gap-1 text-[11.5px] text-[color:var(--wb-muted)] transition hover:text-[color:var(--wb-text-soft)]"
      >
        Worked for {fmtSec(m.elapsed)}
        <Icon name={stepsOpen ? 'chevronDown' : 'chevronRight'} size={12} />
      </button>
      {stepsOpen && (
        <div className="flex w-full flex-col gap-1.5 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11.5px] text-[color:var(--wb-text-soft)]">
            <Icon name="search" size={12} className="text-[color:var(--wb-muted)]" />
            {(m.queries || []).length > 0
              ? `检索式：${m.queries!.join('；')}`
              : '读取上下文'}
          </div>
          {(m.applied || []).map((a, k) => (
            <div key={k} className="flex items-center gap-2 text-[11.5px] text-[color:var(--wb-text-soft)]">
              <Icon name={opIcon(a)} size={12} className="text-[color:var(--wb-muted)]" />
              {a}
            </div>
          ))}
          {cits.length > 0 && (
            <div className="flex items-center gap-2 text-[11.5px] text-[color:var(--wb-text-soft)]">
              <Icon name="book" size={12} className="text-[color:var(--wb-muted)]" />
              命中 {cits.length} 篇文献（已自动存入文献库）
            </div>
          )}
        </div>
      )}

      {/* Thinking › —— 折叠的执行思路 */}
      {(m.plan || []).length > 0 && (
        <>
          <button
            onClick={() => setThinkOpen(!thinkOpen)}
            className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--wb-muted)] transition hover:text-[color:var(--wb-text-soft)]"
          >
            <Icon name="lightbulb" size={12} />
            Thinking
            <Icon name={thinkOpen ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
          {thinkOpen && (
            <ol className="ml-1 flex flex-col gap-1 border-l-2 border-[color:var(--wb-border)] pl-3">
              {(m.plan || []).map((p, k) => (
                <li key={k} className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                  {p}
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {/* 正文：报告渲染成「查看报告」卡，普通回复直接排版 */}
      {isReport ? (
        <button
          onClick={() => onReport?.(m)}
          className="group flex w-full flex-col gap-1.5 rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-3.5 text-left transition hover:border-[color:var(--wb-accent)]/50"
        >
          <span className="flex items-center gap-2 text-[12.5px] font-semibold text-[color:var(--wb-text)]">
            <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
              <Icon name="file" size={13} />
            </span>
            报告已生成 · 点击查看
          </span>
          <span className="line-clamp-2 pl-9 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
            {m.content.replace(/[#*`>\-]/g, ' ').replace(/\s+/g, ' ').slice(0, 120)}…
          </span>
        </button>
      ) : (
        <div className="text-[12.5px] leading-relaxed text-[color:var(--wb-text)]">
          {m.md ? (
            <RichMd text={m.content} cits={cits} onCite={onCite} />
          ) : (
            <span className="whitespace-pre-wrap">{m.content}</span>
          )}
        </div>
      )}

      {/* 引用小签 / 已执行小签 */}
      {cits.length > 0 && <CiteChips cits={cits} onCite={onCite} />}
      {!cits.length && (m.applied || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(m.applied || []).map((a, k) => (
            <span
              key={k}
              title={a}
              className="flex max-w-full items-center gap-1 rounded-full border border-[color:var(--wb-accent)]/25 bg-[color:var(--wb-accent-soft)] px-2 py-[2px] text-[10.5px] text-[color:var(--wb-accent-strong)]"
            >
              <Icon name={opIcon(a)} size={10} className="shrink-0" />
              <span className="truncate">{a}</span>
            </span>
          ))}
        </div>
      )}

      {/* 调用方自定义附属块（产物文件 / 执行记录 / 落账条…） */}
      {m.extra}

      {/* 后续建议：右对齐胶囊（对标 Undermind 的追问 pills） */}
      {(m.suggests || []).length > 0 && (
        <div className="mt-1 flex w-full flex-col items-end gap-1.5">
          {(m.suggests || []).map((s, k) => (
            <button
              key={k}
              onClick={() => onSend(s)}
              className="max-w-[90%] rounded-full bg-[color:var(--wb-accent-soft)] px-3 py-1.5 text-right text-[11.5px] text-[color:var(--wb-accent-strong)] transition hover:brightness-[0.97]"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ChatPanel({
  title,
  messages,
  busy,
  input,
  onInput,
  onSend,
  onClear,
  onClose,
  onReport,
  chips = [],
  samples = [],
  plusItems = [],
  exportName = '对话',
  proposal,
  composerChips,
  composerOverlay,
  overlayOpen = false,
  placeholder = '输入消息…',
  dock,
  minWidth,
  onCite,
  headerExtra,
  jumpTo,
}: Props) {
  const [plusOpen, setPlusOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const msgRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const [flashIdx, setFlashIdx] = useState<number | null>(null)
  /** 本页消息没有服务端 created_at，用「消息出现在页面上的真实本地时间」 */
  const seenAt = useRef<Record<number, string>>({})
  const busyStart = useRef(0)
  const [, forceTick] = useState(0)

  useEffect(() => {
    const seen = seenAt.current
    for (let i = 0; i < messages.length; i++) if (!seen[i]) seen[i] = hhmm()
    for (const k of Object.keys(seen)) if (Number(k) >= messages.length) delete seen[Number(k)]
  }, [messages])

  // 忙碌时每 0.5s 刷一次「Worked for Xs…」的计时
  useEffect(() => {
    if (busy) {
      if (!busyStart.current) busyStart.current = Date.now()
      const t = setInterval(() => forceTick((x) => x + 1), 500)
      return () => clearInterval(t)
    }
    busyStart.current = 0
  }, [busy])

  // 新消息自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, busy])

  // 提问历史跳转：滚到对应消息并短暂高亮（nonce 变化才触发，同一条可重复点）
  useEffect(() => {
    if (!jumpTo) return
    const el = msgRefs.current[jumpTo.index]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashIdx(jumpTo.index)
    const t = window.setTimeout(() => setFlashIdx(null), 1800)
    return () => window.clearTimeout(t)
  }, [jumpTo?.nonce])

  const busySec = busy ? fmtSec(Date.now() - busyStart.current) : ''
  const hasPlus = samples.length > 0 || plusItems.length > 0

  return (
    <div
      className="flex min-w-0 flex-1 flex-col bg-[color:var(--wb-surface)]"
      style={minWidth ? { minWidth } : undefined}
    >
      {/* 顶栏：标题 + 导出 / 清空（对标 Export / Request Edit） */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--wb-border)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="sparkle" size={14} className="shrink-0 text-[color:var(--wb-accent)]" />
          <span className="truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">{title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerExtra}
          <button
            onClick={() => exportMd(exportName || title, messages)}
            disabled={!messages.length}
            className="flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11.5px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)] disabled:opacity-40"
            title="把这段对话导出成 Markdown"
          >
            <Icon name="download" size={12} />
            导出
          </button>
          <IconBtn icon="trash" size="sm" ariaLabel="清空对话" onClick={onClear} />
          {onClose && <IconBtn icon="close" size="sm" ariaLabel="收起对话面板" onClick={onClose} />}
        </div>
      </div>

      {/* 消息流 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !busy ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
              <Icon name="sparkle" size={18} />
            </span>
            <div className="text-[13px] font-semibold text-[color:var(--wb-text)]">
              跟我说一句，我来做研究
            </div>
            <p className="max-w-[16rem] text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
              点下面的快捷操作开始，或点输入框左侧的 + 导入文献 / 看示例。
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[42rem] flex-col gap-5">
            {messages.map((m, i) =>
              m.role === 'user' ? (
                // 用户：上方小签 + 右侧胶囊
                <div
                  key={i}
                  ref={(el) => { msgRefs.current[i] = el }}
                  data-msg-index={i}
                  className={`flex flex-col items-end gap-1.5 rounded-[12px] ${flashIdx === i ? 'wb-msg-flash' : ''}`}
                >
                  <span className="flex items-center gap-1 rounded-full border border-dashed border-[color:var(--wb-border)] px-2.5 py-[3px] text-[10.5px] text-[color:var(--wb-muted)]">
                    <Icon name="sparkle" size={10} />
                    {m.skillTag || '研究对话'}
                  </span>
                  <div className="max-w-[85%] rounded-[18px] bg-[color:var(--wb-accent-soft)] px-3.5 py-2 text-[12.5px] leading-relaxed text-[color:var(--wb-accent-strong)]">
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  </div>
                  <MessageActions
                    time={seenAt.current[i]}
                    content={m.content}
                    editTitle="把这条放回输入框，修改后重发"
                    onEdit={() => {
                      // 这里的消息是各页本地 state，没有服务端 id：
                      // 编辑 = 把原话放回输入框，改完后由用户重新发送一轮，不伪造历史改写。
                      onInput(m.content)
                      setPlusOpen(false)
                      setTimeout(() => inputRef.current?.focus(), 0)
                    }}
                  />
                </div>
              ) : (
                <div
                  key={i}
                  ref={(el) => { msgRefs.current[i] = el }}
                  data-msg-index={i}
                  className={`rounded-[12px] ${flashIdx === i ? 'wb-msg-flash' : ''}`}
                >
                  <AssistantMsg
                    m={m}
                    onSend={(t) => onSend(t, '追问')}
                    onReport={onReport}
                    onCite={onCite}
                  />
                </div>
              ),
            )}

            {/* 忙碌态：Worked for Xs… + Thinking 动画（与助手消息同版式） */}
            {busy && (
              <div className="flex flex-col items-start gap-2">
                <div className="flex items-center gap-1 text-[11.5px] text-[color:var(--wb-muted)]">
                  Worked for {busySec}
                  <span className="wb-anim-pulse">…</span>
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--wb-muted)]">
                  <Icon name="lightbulb" size={12} />
                  Thinking
                  <span className="wb-anim-pulse">···</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部：快捷操作 chips + 圆角输入框（对标 Deep search / Write report 行） */}
      <div className="shrink-0 px-4 pb-3.5 pt-1">
        <div className="mx-auto max-w-[42rem]">
          {dock}
          {chips.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <button
                  key={c.label}
                  disabled={busy}
                  onClick={() => (c.onClick ? c.onClick() : onSend(c.text, c.tag))}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition disabled:opacity-40 ${
                    c.active
                      ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent-strong)]'
                      : 'border-[color:var(--wb-border)] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-accent)]/50 hover:text-[color:var(--wb-accent)]'
                  }`}
                >
                  <Icon name={c.icon} size={11} />
                  {c.label}
                </button>
              ))}
            </div>
          )}

          {proposal}

          <div className="relative rounded-[20px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] transition focus-within:border-[color:var(--wb-accent)]/60">
            {/* 技能选择器等调用方浮层：与输入框同一个 containing block，不另起弹窗 */}
            {composerOverlay}
            {/* + 菜单：示例指令 + 导入 / 添加技能入口（对标 Add papers / Import bibliography） */}
            {plusOpen && hasPlus && !overlayOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-full rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-1.5 shadow-[var(--wb-shadow-md)]">
                {plusItems.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => {
                      p.onClick()
                      setPlusOpen(false)
                    }}
                    className="flex w-full items-start gap-2.5 rounded-[8px] px-2 py-2 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
                  >
                    <Icon name={p.icon} size={14} className="mt-[1px] shrink-0 text-[color:var(--wb-muted)]" />
                    <span className="leading-tight">
                      <span className="block text-[12px] font-medium text-[color:var(--wb-text)]">{p.label}</span>
                      <span className="block text-[10.5px] text-[color:var(--wb-muted)]">{p.desc}</span>
                    </span>
                  </button>
                ))}
                {plusItems.length > 0 && samples.length > 0 && (
                  <div className="mx-2 border-t border-[color:var(--wb-border)] pt-1.5" />
                )}
                {samples.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      onInput(s)
                      setPlusOpen(false)
                    }}
                    className="block w-full rounded-[8px] px-2 py-1.5 text-left text-[11.5px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {composerChips}
            <AttachmentChips />
            <textarea
              ref={inputRef}
              rows={2}
              value={input}
              onChange={(e: any) => onInput(e.target.value)}
              onKeyDown={(e: any) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (overlayOpen) return
                  onSend()
                  setPlusOpen(false)
                }
              }}
              placeholder={placeholder}
              className="block w-full resize-none bg-transparent px-3.5 pt-2.5 text-[12.5px] leading-relaxed text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
            />
            <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1">
              {hasPlus && (
                <IconBtn
                  icon="plus"
                  size="sm"
                  ariaLabel="导入与示例"
                  onClick={() => setPlusOpen(!plusOpen)}
                />
              )}
              <ComposerTools
                getInput={() => input}
                onTranscript={(t) => onInput(input + t)}
                onEnhance={(t) => onInput(t)}
                disabled={busy}
              />
              <span className="hidden flex-1 pl-1 text-[10.5px] text-[color:var(--wb-muted)] sm:inline">
                Enter 发送 · Shift+Enter 换行
              </span>
              <span className="flex-1 sm:hidden" />
              <ModelPicker />
              <button
                onClick={() => {
                  onSend()
                  setPlusOpen(false)
                }}
                disabled={!input.trim() || busy}
                title="发送"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--wb-accent)] text-white transition hover:opacity-90 disabled:opacity-40"
              >
                <Icon name="arrowUp" size={14} />
              </button>
            </div>
          </div>
          <ContextBar />
        </div>
      </div>
    </div>
  )
}
