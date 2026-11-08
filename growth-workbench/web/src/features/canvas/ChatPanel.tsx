import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import { IconBtn, MdBlock } from '../../components/ui'

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

export type ChipConf = { icon: IconName; label: string; text: string; tag: string; onClick?: () => void }
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
  /** 提案卡插槽：渲染在快捷 chips 与输入框之间（点 chip 先出提案、确认才发送） */
  proposal?: ReactNode
  /** 常驻卡插槽：渲染在底部操作区最上方（进度框 / 文献检索结果卡），不随消息流滚走 */
  dock?: ReactNode
  /** 可选最小宽度：多栏拖拽时保证对话面板不被两侧栏压没；不传则沿用 min-w-0 */
  minWidth?: number
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

/** 引用小签行（对标 Undermind 的文献引用 chips，点击开 DOI） */
function CiteChips({ cits }: { cits: Citation[] }) {
  if (!cits.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {cits.map((c, k) => {
        const url = citeUrl(c)
        return url ? (
          <a
            key={k}
            href={url}
            target="_blank"
            rel="noreferrer"
            title={`${c.title || ''}${c.venue ? ` · ${c.venue}` : ''}`}
            className="flex max-w-[16rem] items-center gap-1 rounded-full border border-[color:var(--wb-accent)]/25 bg-[color:var(--wb-accent-soft)] px-2 py-[2px] text-[10.5px] text-[color:var(--wb-accent-strong)] transition hover:brightness-[0.96]"
          >
            <span className="truncate">{citeLabel(c)}</span>
          </a>
        ) : (
          <span
            key={k}
            title={c.title || ''}
            className="flex max-w-[16rem] items-center gap-1 rounded-full border border-[color:var(--wb-accent)]/25 bg-[color:var(--wb-accent-soft)] px-2 py-[2px] text-[10.5px] text-[color:var(--wb-accent-strong)]"
          >
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
}: {
  m: ChatMsg
  onSend: (t: string) => void
  onReport?: (m: ChatMsg) => void
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
        <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[color:var(--wb-text)]">
          {m.md ? <MdBlock text={m.content} /> : m.content}
        </div>
      )}

      {/* 引用小签 / 已执行小签 */}
      {cits.length > 0 && <CiteChips cits={cits} />}
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
  dock,
  minWidth,
}: Props) {
  const [plusOpen, setPlusOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const busyStart = useRef(0)
  const [, forceTick] = useState(0)

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
                <div key={i} className="flex flex-col items-end gap-1.5">
                  <span className="flex items-center gap-1 rounded-full border border-dashed border-[color:var(--wb-border)] px-2.5 py-[3px] text-[10.5px] text-[color:var(--wb-muted)]">
                    <Icon name="sparkle" size={10} />
                    {m.skillTag || '研究对话'}
                  </span>
                  <div className="max-w-[85%] rounded-[18px] bg-[color:var(--wb-accent-soft)] px-3.5 py-2 text-[12.5px] leading-relaxed text-[color:var(--wb-accent-strong)]">
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  </div>
                </div>
              ) : (
                <AssistantMsg key={i} m={m} onSend={(t) => onSend(t, '追问')} onReport={onReport} />
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
                  className="flex items-center gap-1.5 rounded-full border border-[color:var(--wb-border)] px-2.5 py-1 text-[11px] text-[color:var(--wb-text-soft)] transition hover:border-[color:var(--wb-accent)]/50 hover:text-[color:var(--wb-accent)] disabled:opacity-40"
                >
                  <Icon name={c.icon} size={11} />
                  {c.label}
                </button>
              ))}
            </div>
          )}

          {proposal}

          <div className="relative rounded-[20px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] transition focus-within:border-[color:var(--wb-accent)]/60">
            {/* + 菜单：示例指令 + 导入入口（对标 Add papers / Import bibliography） */}
            {plusOpen && hasPlus && (
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

            <textarea
              rows={2}
              value={input}
              onChange={(e: any) => onInput(e.target.value)}
              onKeyDown={(e: any) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onSend()
                  setPlusOpen(false)
                }
              }}
              placeholder="输入消息…"
              className="block w-full resize-none bg-transparent px-3.5 pt-2.5 text-[12.5px] leading-relaxed text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
            />
            <div className="flex items-center gap-1 px-2 pb-2 pt-1">
              {hasPlus && (
                <IconBtn
                  icon="plus"
                  size="sm"
                  ariaLabel="导入与示例"
                  onClick={() => setPlusOpen(!plusOpen)}
                />
              )}
              <span className="flex-1 pl-1 text-[10.5px] text-[color:var(--wb-muted)]">
                Enter 发送 · Shift+Enter 换行
              </span>
              <button
                onClick={() => {
                  onSend()
                  setPlusOpen(false)
                }}
                disabled={!input.trim() || busy}
                title="发送"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--wb-accent)] text-white transition hover:opacity-90 disabled:opacity-40"
              >
                <Icon name="arrowUp" size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
