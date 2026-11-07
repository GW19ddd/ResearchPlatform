import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Btn, IconBtn, Modal, TextArea } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'
import { ResizeHandle } from '../components/ResizeHandle'
import { toast } from '../components/toast'
import { get, patch, post, del } from '../lib/api'
import { usePersist } from '../lib/state'
import { ConvoStore } from '../lib/convoStore'
import { useConvoSession } from '../lib/useConvoSession'
import ChatPanel, { type ChatMsg, type ChipConf, type PlusItem, type Citation } from '../features/canvas/ChatPanel'
import { relTime } from '../lib/time'
import { streamChat, type ChatStreamEvent, type RchatServerMsg } from '../lib/rchatStream'
import ResearchDock, {
  LiteraturePane, useResearchRun, beginRun, pushStage, setPapers, finishRun, hydratePapers, clearRun,
} from '../features/research/ResearchDock'

/**
 * 模块级会话仓库：消息 / busy 按 sid 分桶，跨组件、跨路由存活。
 * 切走对话或在途请求都不会丢；切回来按 sid 取回自己的状态。
 */
const rchatStore = new ConvoStore<ChatMsg>()

/**
 * 研究对话（Undermind 式工作台）：
 * 左栏 = 对话管理（新对话 / 会话列表 / 重命名 / 删除 / 文献库入口）；
 * 右侧 = 共用的 Undermind 版式对话面板：
 *   深度检索（LLM 检索式 → OpenAlex 真数据 → 自动入文献库 → 带 [n] 引用的综述）、
 *   报告撰写（整段会话 → Markdown 报告，文档式预览 + 导出）、
 *   文献导入（粘贴 BibTeX/CSL/RIS 或上传 PDF）。
 */

type SessionRow = { id: number; title: string; updated_at: string; msg_count?: number }

/** 左栏「文档」：历次生成的报告（kind=report 的消息沉淀） */
type DocRow = { id: number; session_id: number; title: string; created_at: string; content: string; citations?: Citation[] }

/** 深度检索 / 撰写报告的提案：点 chip 先编辑，确认才发送 */
type Proposal = { mode: 'deep' | 'report'; title: string; desc: string }

type ServerMsg = RchatServerMsg

/** 把后端消息行转成面板的消息结构 */
function toChatMsg(m: ServerMsg): ChatMsg {
  return {
    role: m.role,
    content: m.content,
    kind: (m.kind as ChatMsg['kind']) || 'text',
    citations: m.meta?.citations || [],
    queries: m.meta?.queries || [],
    suggests: m.meta?.suggests || [],
    applied: m.meta?.applied || [],
    plan: m.meta?.plan || [],
    elapsed: m.elapsed_ms || undefined,
    skillTag: m.meta?.tag,
  }
}

/** Undermind 左栏的时间格式：2w / 3d / 5h —— 实现见 lib/time.ts（已单测） */

const CHIPS: ChipConf[] = [
  { icon: 'search', label: '深度检索', text: '', tag: '深度检索' },
  { icon: 'file', label: '撰写报告', text: '', tag: '报告撰写' },
  { icon: 'book', label: '文献检索', text: '', tag: '文献检索' },
]

/** 右侧附属栏：报告文档 / 文献检索二选一，始终只开一栏，保持「对话 + 一栏」的双栏 */
type Pane = { kind: 'report'; msg: ChatMsg } | { kind: 'literature' }

export default function ResearchChat() {
  const nav = useNavigate()
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [sid, setSid] = usePersist<number | null>('rchat.sid', null)
  const [input, setInput] = usePersist('rchat.input', '')
  // 消息 / 流式状态按 sid 走仓库：切走对话、切走路由都不丢，回来按 sid 取回
  const { messages, busy } = useConvoSession<ChatMsg>(rchatStore, sid)
  // 调研进度 + 文献检索卡：同样按 sid 分桶，切会话/切路由不丢
  const run = useResearchRun(sid)
  const [renaming, setRenaming] = useState<SessionRow | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [bibOpen, setBibOpen] = useState(false)
  const [bibText, setBibText] = useState('')
  const [bibBusy, setBibBusy] = useState(false)
  const [pane, setPane] = useState<Pane | null>(null)
  // 各栏宽度持久化：刷新 / 切页签都保持。报告栏与文献栏互斥，但共用同一个右侧栏宽度。
  const [leftW, setLeftW] = usePersist('rchat.leftW', 224)
  const [paneW, setPaneW] = usePersist('rchat.paneW', 480)
  const [docs, setDocs] = useState<DocRow[]>([])
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  /** 左栏文档点开时按需补的引用元数据缓存（/documents 不返回 meta） */
  const docCitsRef = useRef<Record<number, Citation[]>>({})
  // 记录「已被删除」的会话：在途请求回来时若会话已删，丢弃结果，避免为已删 sid 重建幽灵桶
  const removedRef = useRef<Set<number>>(new Set())

  const loadSessions = useCallback(async (): Promise<SessionRow[]> => {
    try {
      const r = await get('/rchat/sessions')
      const rows: SessionRow[] = r.sessions || []
      setSessions(rows)
      return rows
    } catch {
      toast('会话列表加载失败，刷新页面重试', 'error')
      return []
    }
  }, [])

  const loadDocs = useCallback(async () => {
    try {
      const r = await get('/rchat/documents')
      setDocs(r.documents || [])
    } catch {
      toast('文档列表加载失败', 'error')
    }
  }, [])

  const closePane = () => setPane(null)
  const openReport = (m: ChatMsg) => setPane({ kind: 'report', msg: m })
  const openLit = () => setPane({ kind: 'literature' })
  /** chip 上的「文献检索」是可开可收的 toggle */
  const toggleLit = () =>
    setPane((p) => (p?.kind === 'literature' ? null : { kind: 'literature' }))

  /** 左栏文档：先立即打开报告双栏，再按 session 补回该报告的引用元数据（/documents 不带 meta） */
  const openDoc = async (d: DocRow) => {
    const cached = docCitsRef.current[d.id] || d.citations || []
    setPane({
      kind: 'report',
      msg: { role: 'assistant', content: d.content, kind: 'report', citations: cached },
    })
    if (cached.length) return
    try {
      const r = await get(`/rchat/sessions/${d.session_id}`)
      const hit = (r.messages || []).find(
        (m: ServerMsg) => m.kind === 'report' && m.content === d.content,
      )
      const cits: Citation[] = hit?.meta?.citations || []
      if (!cits.length) return
      docCitsRef.current[d.id] = cits
      setPane((prev) =>
        prev?.kind === 'report' && prev.msg.content === d.content
          ? { kind: 'report', msg: { ...prev.msg, citations: cits } }
          : prev,
      )
    } catch {
      // 引用元数据是可选增强，取不到不影响报告正文阅读
    }
  }

  const openSession = useCallback(async (id: number) => {
    setSid(id)
    try {
      const r = await get(`/rchat/sessions/${id}`)
      const list: ServerMsg[] = r.messages || []
      // 整桶替换：从后端拉全量写进该 sid 自己的桶（不碰别的会话）
      rchatStore.setMessages(id, list.map(toChatMsg))
      // 历史会话也把文献卡回填成「常驻」状态（缺的派生字段留空，不编造）
      const deep = [...list].reverse().find((m) => m.kind === 'deep' && (m.meta?.citations || []).length)
      if (deep) hydratePapers(id, deep.meta.citations)
    } catch {
      toast('打开会话失败，请重试', 'error')
    }
  }, [setSid])

  // 首次进入：有会话就开最近一个，没有就建一个
  useEffect(() => {
    ;(async () => {
      const list = await loadSessions()
      if (list.length && Number(localStorage.getItem('wb:rchat.sid') || 0)) {
        const cur = Number(localStorage.getItem('wb:rchat.sid'))
        if (list.some((s) => s.id === cur)) return openSession(cur)
      }
      if (list.length) return openSession(list[0].id)
      const s = await post('/rchat/sessions', {})
      await loadSessions()
      setSid(s.id)
      rchatStore.setMessages(s.id, [])
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 文档列表（报告沉淀）独立加载：进入页面 + 每次生成报告后刷新
  useEffect(() => {
    loadDocs()
  }, [loadDocs])

  const newChat = async () => {
    const s = await post('/rchat/sessions', {}, { ok: '已新建对话' })
    await loadSessions()
    setSid(s.id)
    rchatStore.setMessages(s.id, [])
    setInput('')
  }

  const removeSession = async (s: SessionRow) => {
    removedRef.current.add(s.id)
    try {
      await del(`/rchat/sessions/${s.id}`, { ok: '已删除对话' })
    } catch {
      // 删除失败要撤回标记：否则会话还在，在途请求的结果却被永久丢弃
      removedRef.current.delete(s.id)
      return
    }
    // abort 在途 SSE + 清掉该会话的进度/文献状态，避免为已删 sid 留幽灵桶
    rchatStore.removeSession(s.id)
    clearRun(s.id)
    const list = await loadSessions()
    if (sid === s.id) {
      if (list.length) await openSession(list[0].id)
      else {
        setSid(null)
      }
    }
  }

  const doRename = async () => {
    if (!renaming || !renameVal.trim()) return
    await patch(`/rchat/sessions/${renaming.id}`, { title: renameVal.trim() }, { ok: '已重命名' })
    setRenaming(null)
    await loadSessions()
  }

  /** mode: auto | deep | report。deep/report 的正文由后端生成，输入框内容作为研究问题。 */
  const send = async (raw?: string, tag?: string) => {
    const question = (raw ?? input).trim()
    if (!question || busy) return
    let mode: 'auto' | 'deep' | 'report' = 'auto'
    if (tag === '深度检索') mode = 'deep'
    else if (tag === '报告撰写') mode = 'report'
    let useSid: number
    if (!sid) {
      const s = await post('/rchat/sessions', {})
      useSid = s.id
      setSid(s.id)
      await loadSessions()
    } else {
      useSid = sid
    }
    const optimistic: ChatMsg = { role: 'user', content: question, skillTag: tag || '研究对话' }
    // 关键修复：一律写进 useSid 自己的桶，切走对话不串台
    rchatStore.appendMessage(useSid, optimistic)
    setInput('')
    rchatStore.setBusy(useSid, true)
    // 立刻把进度框亮出来：点「启动」后不再只是往消息流里加一条，而是有明确的阶段反馈
    beginRun(useSid, mode)
    // 登记 AbortController：删会话时 ConvoStore.removeSession 会 abort，
    // 在途 SSE 立刻断开，不必等 LLM 跑完（结果本来也会被 removedRef 丢弃）
    const ctrl = new AbortController()
    const p = streamChat(
      useSid,
      { instruction: question, mode, tag },
      (ev: ChatStreamEvent) => {
        if (removedRef.current.has(useSid)) return
        if (ev.type === 'stage') pushStage(useSid, ev)
        else if (ev.type === 'papers') {
          setPapers(useSid, ev.papers, ev.total, ev.query_count, ev.raw_hits)
        }
      },
      ctrl.signal,
    )
    rchatStore.registerTask(useSid, ctrl)
    try {
      const msg = await p
      // 会话可能在请求期间被删除：丢弃结果，不为已删 sid 重建幽灵桶
      if (removedRef.current.has(useSid)) return
      rchatStore.appendMessage(useSid, toChatMsg(msg))
      finishRun(useSid)
      loadSessions()
      loadDocs()
    } catch (e: any) {
      const reason = e?.message || '稍后再试或换个问法'
      finishRun(useSid, reason)
      if (!removedRef.current.has(useSid)) {
        rchatStore.appendMessage(useSid, {
          role: 'assistant',
          content: `（这次没成功：${reason}）`,
        })
      }
    } finally {
      rchatStore.clearTask(useSid)
      if (!removedRef.current.has(useSid)) rchatStore.setBusy(useSid, false)
    }
  }

  /** 快捷 chip：深度检索 / 撰写报告 —— 不立即发送，先打开提案卡确认（对标 Undermind 的 Search proposal） */
  const openProposal = (c: ChipConf) => {
    const draft = input.trim()
    setProposal({
      mode: c.tag === '深度检索' ? 'deep' : 'report',
      title: draft.slice(0, 80),
      desc: '',
    })
    if (draft) setInput('')
  }

  /** 提案卡「启动」：标题 + 详情合成指令，确认后才真正发送 */
  const launchProposal = () => {
    if (!proposal || busy) return
    const text = [proposal.title.trim(), proposal.desc.trim()].filter(Boolean).join('\n')
    const tag = proposal.mode === 'deep' ? '深度检索' : '报告撰写'
    setProposal(null)
    if (text) send(text, tag)
  }

  const importBib = async () => {
    if (!bibText.trim()) return
    setBibBusy(true)
    try {
      const r = await post<any>('/rchat/import/bibtex', { text: bibText }, { ok: false })
      toast(`导入完成：新增 ${r.imported}，更新 ${r.updated}，跳过 ${r.skipped}`, 'ok')
      setBibOpen(false)
      setBibText('')
    } catch (e: any) {
      toast(e?.message || '导入失败', 'error')
    } finally {
      setBibBusy(false)
    }
  }

  const uploadPdf = async (files: FileList | null) => {
    if (!files?.length) return
    let okN = 0
    for (const f of Array.from(files).slice(0, 5)) {
      try {
        const fd = new FormData()
        fd.append('file', f)
        const res = await fetch(`/api/rchat/import/pdf`, { method: 'POST', body: fd })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          throw new Error(t || `HTTP ${res.status}`)
        }
        okN++
      } catch (e: any) {
        let msg = e?.message || '上传失败'
        try {
          msg = JSON.parse(msg).detail || msg
        } catch {}
        toast(`${f.name}：${msg.slice(0, 80)}`, 'error')
      }
    }
    if (okN) toast(`已导入 ${okN} 篇 PDF 到文献库`, 'ok')
    if (pdfRef.current) pdfRef.current.value = ''
  }

  const plusItems: PlusItem[] = [
    { icon: 'inbox', label: 'Add papers', desc: '上传已发表的论文或预印本（PDF，一次最多 5 篇）', onClick: () => pdfRef.current?.click() },
    { icon: 'library', label: 'Import bibliography', desc: '粘贴或上传 BibTeX / RIS / CSL JSON 参考文献列表', onClick: () => setBibOpen(true) },
  ]

  const cur = sessions.find((s) => s.id === sid)
  const reportName =
    pane?.kind === 'report' ? pane.msg.content.match(/^#\s+(.+)$/m)?.[1]?.trim() : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
      {/* 左栏：对话管理（对标 Undermind 侧栏）；右边缘可拖拽调宽 */}
      <aside
        data-resizable
        data-tour="tour-research-dock"
        className="flex shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)]"
        style={{ width: leftW, minWidth: 180, maxWidth: 400 }}
      >
        <div className="flex items-center justify-between px-3 pb-2 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
            Chats
          </span>
          <IconBtn icon="plus" size="sm" ariaLabel="新对话" onClick={newChat} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex items-center gap-1 rounded-[10px] px-2 py-[7px] transition ${
                s.id === sid ? 'bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-sm)]' : 'hover:bg-[color:var(--wb-surface)]/60'
              }`}
            >
              <button onClick={() => openSession(s.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Icon name="message" size={12} className="shrink-0 text-[color:var(--wb-muted)]" />
                <span
                  className={`truncate text-[12px] ${
                    s.id === sid
                      ? 'font-medium text-[color:var(--wb-text)]'
                      : 'text-[color:var(--wb-text-soft)]'
                  }`}
                >
                  {s.title || '新对话'}
                </span>
              </button>
              <span className="shrink-0 text-[10px] text-[color:var(--wb-muted)] group-hover:hidden">
                {relTime(s.updated_at)}
              </span>
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <IconBtn
                  icon="pencil"
                  size="sm"
                  ariaLabel="重命名"
                  onClick={() => {
                    setRenaming(s)
                    setRenameVal(s.title || '')
                  }}
                />
                <IconBtn icon="trash" size="sm" ariaLabel="删除对话" onClick={() => removeSession(s)} />
              </span>
            </div>
          ))}
          {!sessions.length && (
            <p className="px-2 py-4 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
              还没有对话。点右上角 + 开始第一段研究对话。
            </p>
          )}

          {/* 文档：历次「撰写报告」的产出沉淀（对标 Undermind 左栏 Documents） */}
          <div className="mx-2 mt-2 border-t border-[color:var(--wb-border)]" />
          <div className="px-1 pb-1 pt-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
              文档
            </span>
          </div>
          {docs.map((d) => (
            <div
              key={d.id}
              className="group flex items-center gap-1 rounded-[10px] px-2 py-[7px] transition hover:bg-[color:var(--wb-surface)]/60"
            >
              <button
                onClick={() => openDoc(d)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title="打开报告"
              >
                <Icon name="file" size={12} className="shrink-0 text-[color:var(--wb-muted)]" />
                <span className="truncate text-[12px] text-[color:var(--wb-text-soft)]">{d.title}</span>
              </button>
              <span className="shrink-0 text-[10px] text-[color:var(--wb-muted)]">{relTime(d.created_at)}</span>
            </div>
          ))}
          {!docs.length && (
            <p className="px-2 py-2 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
              点「撰写报告」生成的报告会沉淀在这里，随时回看。
            </p>
          )}
        </div>
        <div className="flex flex-col gap-0.5 border-t border-[color:var(--wb-border)] p-2">
          {/* 与左栏「文档」对称的入口：点开在右侧双栏看本次检索结果 */}
          <button
            onClick={openLit}
            className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-[12px] transition ${
              pane?.kind === 'literature'
                ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent-strong)]'
                : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-surface)]'
            }`}
          >
            <Icon name="search" size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
            文献检索
            {(run?.papers.length || 0) > 0 && (
              <span className="rounded-full bg-[color:var(--wb-accent-soft)] px-1.5 py-[1px] text-[10px] text-[color:var(--wb-accent-strong)]">
                {run?.papers.length}
              </span>
            )}
            <Icon name="arrowRight" size={11} className="ml-auto text-[color:var(--wb-muted)]" />
          </button>
          <button
            onClick={() => nav('/literature')}
            className="flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-[12px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-surface)]"
          >
            <Icon name="book" size={13} className="text-[color:var(--wb-muted)]" />
            文献库
            <Icon name="arrowRight" size={11} className="ml-auto text-[color:var(--wb-muted)]" />
          </button>
        </div>
      </aside>
      <ResizeHandle
        width={leftW}
        onResize={setLeftW}
        onReset={() => setLeftW(224)}
        min={180}
        max={400}
        label="调整对话列表宽度"
      />

      {/* 右侧：Undermind 版式对话面板；minWidth 保证三栏都拖到极限时聊天区仍可见 */}
      <ChatPanel
        minWidth={300}
        title={cur?.title || '研究对话'}
        messages={messages}
        busy={busy}
        input={input}
        onInput={setInput}
        onSend={send}
        onClear={() => {
          if (sid != null) {
            rchatStore.setMessages(sid, [])
            clearRun(sid)
          }
        }}
        onReport={openReport}
        dock={<ResearchDock run={run} onOpenLiterature={openLit} />}
        chips={CHIPS.map((c) => ({
          ...c,
          onClick: () => (c.tag === '文献检索' ? toggleLit() : openProposal(c)),
        }))}
        proposal={
          proposal ? (
            <div className="mb-2 overflow-hidden rounded-[14px] border border-[color:var(--wb-accent)]/35 bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-sm)]">
              {/* 明确的「提案已就绪」抬头：点 chip 后交互落在这张卡上，不是回到输入框继续打字 */}
              <div className="flex items-center gap-1.5 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-accent-soft)] px-3.5 py-1.5">
                <Icon name="sparkle" size={10} className="shrink-0 text-[color:var(--wb-accent)]" />
                <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--wb-accent-strong)]">
                  {proposal.mode === 'deep' ? 'Search proposal · 检索提案' : 'Report proposal · 报告提案'}
                </span>
                <span className="ml-auto whitespace-nowrap text-[10px] text-[color:var(--wb-muted)]">
                  提案已就绪 · 确认后才执行
                </span>
              </div>
              <div className="flex items-center gap-2 border-b border-[color:var(--wb-border)] px-3.5 py-2.5">
                <Icon
                  name={proposal.mode === 'deep' ? 'search' : 'file'}
                  size={13}
                  className="shrink-0 text-[color:var(--wb-accent)]"
                />
                <input
                  autoFocus
                  value={proposal.title}
                  onChange={(e: any) => setProposal({ ...proposal, title: e.target.value })}
                  placeholder={proposal.mode === 'deep' ? '检索主题（可留空，直接写下方补充）' : '报告主题（可留空，直接写下方补充）'}
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium text-[color:var(--wb-text)] outline-none placeholder:font-normal placeholder:text-[color:var(--wb-muted)]"
                />
                <IconBtn icon="close" size="sm" ariaLabel="取消提案" onClick={() => setProposal(null)} />
              </div>
              <textarea
                rows={3}
                value={proposal.desc}
                onChange={(e: any) => setProposal({ ...proposal, desc: e.target.value })}
                placeholder={
                  proposal.mode === 'deep'
                    ? '补充检索范围：年份、会议/期刊、关注角度、排除项…'
                    : '补充报告要求：结构、篇幅、受众、必须覆盖的问题…'
                }
                className="block w-full resize-none bg-transparent px-3.5 py-2.5 text-[12px] leading-relaxed text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
              />
              <div className="flex items-center gap-2 px-3.5 pb-3">
                <Btn
                  variant="primary"
                  onClick={launchProposal}
                  disabled={busy || !(proposal.title.trim() || proposal.desc.trim())}
                >
                  <Icon name="play" size={12} />
                  {proposal.mode === 'deep' ? '启动检索' : '生成报告'}
                </Btn>
                <Btn onClick={() => setProposal(null)}>取消</Btn>
                <span className="ml-auto whitespace-nowrap text-[10.5px] text-[color:var(--wb-muted)]">
                  启动后进度显示在上方卡片
                </span>
              </div>
            </div>
          ) : undefined
        }
        samples={[]}
        plusItems={plusItems}
        exportName={cur?.title || '研究对话'}
      />

      {/* 右侧附属栏：报告文档 / 文献检索二选一，与对话栏并排组成双栏；栏内右上角叉收起，回到单栏对话 */}
      {pane && (
        <ResizeHandle
          width={paneW}
          onResize={setPaneW}
          onReset={() => setPaneW(480)}
          min={320}
          max={900}
          edge="before"
          label="调整文档 / 文献栏宽度"
        />
      )}
      {pane?.kind === 'report' && (
        <ReportPane report={pane.msg} name={reportName} width={paneW} onClose={closePane} />
      )}
      {pane?.kind === 'literature' && <LiteraturePane run={run} width={paneW} onClose={closePane} />}

      {/* 隐藏的 PDF 选择器（Add papers） */}
      <input
        ref={pdfRef}
        type="file"
        accept=".pdf"
        multiple
        className="hidden"
        onChange={(e) => uploadPdf(e.target.files)}
      />

      {/* Import bibliography 弹窗 */}
      <Modal open={bibOpen} onClose={() => setBibOpen(false)} title="导入参考文献" width="max-w-[560px]">
        <div className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-[color:var(--wb-muted)]">
            粘贴 BibTeX / RIS / CSL JSON（自动识别格式），或从 Zotero / Google Scholar 导出的
            .bib 文件里整段复制进来。条目按 DOI / 标题去重后写入文献库。
          </p>
          <TextArea
            rows={9}
            value={bibText}
            onChange={(v) => setBibText(v)}
            placeholder={'@inproceedings{reflex2026,\n  title = {REFLEX: ...},\n  author = {Wu, ...},\n  year = {2026}\n}'}
          />
          <div className="flex items-center justify-end gap-2">
            <Btn variant="ghost" onClick={() => setBibOpen(false)}>
              取消
            </Btn>
            <Btn onClick={importBib} disabled={!bibText.trim() || bibBusy}>
              {bibBusy ? '导入中…' : '导入文献库'}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* 重命名弹窗 */}
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="重命名对话" width="max-w-[400px]">
        <div className="flex flex-col gap-3">
          <input
            autoFocus
            value={renameVal}
            onChange={(e: any) => setRenameVal(e.target.value)}
            onKeyDown={(e: any) => e.key === 'Enter' && doRename()}
            className="w-full rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-2 text-[12.5px] text-[color:var(--wb-text)] outline-none focus:border-[color:var(--wb-accent)]/60"
          />
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setRenaming(null)}>
              取消
            </Btn>
            <Btn onClick={doRename} disabled={!renameVal.trim()}>
              保存
            </Btn>
          </div>
        </div>
      </Modal>

      </div>
    </div>
  )
}

/**
 * 报告文档栏：与右侧对话栏并排组成双栏，不再用点击后「跳出来」的弹窗。
 * 栏头右上角的叉 = 收起这一栏、对话恢复单栏全宽；导出 Markdown 保留。
 */
function ReportPane({ report, name, width, onClose }: { report: ChatMsg; name?: string; width: number; onClose: () => void }) {
  const exportMd = () => {
    const blob = new Blob([report.content], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name || '研究报告'}-${Date.now()}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <aside
      data-resizable
      className="flex shrink-0 flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)]"
      style={{ width, minWidth: 280, maxWidth: 'calc(100vw - 700px)' }}
    >
      {/* 栏头：文件标识 + 标题 + 导出 + 关闭叉 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3.5 py-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
          <Icon name="file" size={12} />
        </span>
        <span
          title={name || '研究报告'}
          className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[color:var(--wb-text)]"
        >
          {name || '研究报告'}
        </span>
        <Btn size="xs" variant="subtle" onClick={exportMd} title="导出 Markdown">
          <Icon name="download" size={11} />
          导出
        </Btn>
        <IconBtn icon="close" size="sm" ariaLabel="关闭报告栏" title="关闭报告" onClick={onClose} />
      </div>
      <div className="shrink-0 px-4 pt-3 text-[11px] text-[color:var(--wb-muted)]">
        基于本对话生成 · 引用与文献已同步文献库
      </div>
      {/* 文档式白底正文：常驻面板高度写死为 flex-1，滚动只在内部 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2.5">
        <div className="min-h-full rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-6 py-5">
          <ReportMd text={report.content} citations={report.citations} />
        </div>
      </div>
    </aside>
  )
}

/** 报告 Markdown 轻渲染：标题/列表 + [n] 可点引用（点开在序号下方浮出半透明说明框） */
function ReportMd({ text, citations = [] }: { text: string; citations?: Citation[] }) {
  // 一次只开一个说明框；key 用「行-序号」区分报告里同编号的多个 [n]
  const [openKey, setOpenKey] = useState<string | null>(null)
  useEffect(() => {
    if (!openKey) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest?.('[data-cite-root]')) setOpenKey(null)
    }
    // 说明框是 fixed 浮层，滚动会让它脱离序号，滚动即收起
    const onScroll = () => setOpenKey(null)
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [openKey])

  const ctx: CiteCtx = {
    cits: citations,
    openKey,
    toggle: (key: string) => setOpenKey((cur) => (cur === key ? null : key)),
    close: () => setOpenKey(null),
  }

  const lines = text.split('\n')
  const out: any[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) {
      const base = `ul${out.length}`
      out.push(
        <ul key={base} className="my-2 flex list-disc flex-col gap-1 pl-5">
          {list.map((li, i) => (
            <li key={i} className="text-[12.5px] leading-relaxed text-[color:var(--wb-text)]">
              {inline(li, `${base}-${i}`, ctx)}
            </li>
          ))}
        </ul>,
      )
      list = []
    }
  }
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trimEnd()
    if (/^#{1,3}\s/.test(line)) {
      flush()
      const level = line.match(/^#+/)![0].length
      const key = `h${out.length}`
      out.push(
        level === 1 ? (
          <h1 key={out.length} className="mb-2 mt-1 text-[17px] font-semibold text-[color:var(--wb-text)]">
            {inline(line.replace(/^#\s+/, ''), key, ctx)}
          </h1>
        ) : (
          <h2
            key={out.length}
            className="mb-1.5 mt-4 border-b border-[color:var(--wb-border)] pb-1 text-[13.5px] font-semibold text-[color:var(--wb-text)]"
          >
            {inline(line.replace(/^#+\s+/, ''), key, ctx)}
          </h2>
        ),
      )
    } else if (/^[-*]\s/.test(line)) {
      list.push(line.replace(/^[-*]\s+/, ''))
    } else if (!line.trim()) {
      flush()
    } else {
      flush()
      out.push(
        <p key={out.length} className="my-1.5 text-[12.5px] leading-relaxed text-[color:var(--wb-text)]">
          {inline(line, `p${out.length}`, ctx)}
        </p>,
      )
    }
  }
  flush()
  return <div>{out}</div>
}

type CiteCtx = {
  cits: Citation[]
  openKey: string | null
  toggle: (key: string) => void
  close: () => void
}

/** 行内渲染：**加粗** + [n] 引用（可点，点开浮层说明引用的是哪篇文献） */
function inline(s: string, lineKey: string, ctx: CiteCtx): any[] {
  const parts = s.split(/(\*\*[^*]+\*\*|\[\d+\])/g).filter(Boolean)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**'))
      return (
        <strong key={i} className="font-semibold text-[color:var(--wb-text)]">
          {p.slice(2, -2)}
        </strong>
      )
    if (/^\[\d+\]$/.test(p)) {
      const n = Number(p.slice(1, -1))
      const key = `${lineKey}-${i}`
      return (
        <CiteMark
          key={key}
          n={n}
          info={ctx.cits.find((c) => Number(c.n) === n)}
          open={ctx.openKey === key}
          onToggle={() => ctx.toggle(key)}
          onClose={ctx.close}
        />
      )
    }
    return <span key={i}>{p}</span>
  })
}

/** 可点的 [n]：点开后在序号下方浮一层半透明说明框，讲清这个引用指向哪条参考文献 */
function CiteMark({
  n,
  info,
  open,
  onToggle,
  onClose,
}: {
  n: number
  info?: Citation
  open: boolean
  onToggle: () => void
  onClose: () => void
}) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null)
  const click = (e: any) => {
    if (open) {
      onClose()
      return
    }
    const r = e.currentTarget.getBoundingClientRect() as DOMRect
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - 288))
    // 下方空间不足就翻到按钮上方（用 bottom 定位，不必知道浮层实际高度）
    setPos(
      window.innerHeight - r.bottom >= 220
        ? { top: r.bottom + 6, left }
        : { bottom: window.innerHeight - r.top + 6, left },
    )
    onToggle()
  }
  const cited = info
    ? Number((info as Citation & { cited_by_count?: number }).cited_by_count ?? info.cited_by ?? 0)
    : 0
  const url = info?.doi ? `https://doi.org/${info.doi}` : info?.url || ''
  return (
    <span data-cite-root className="relative inline-block align-middle">
      <button
        type="button"
        onClick={click}
        aria-label={`查看引用 [${n}] 的来源说明`}
        title={`引用 [${n}] · 点击查看来源`}
        className={`mx-[1px] cursor-pointer rounded-full px-1.5 py-[1px] align-middle text-[10px] font-medium transition ${
          open
            ? 'bg-[color:var(--wb-accent)] text-white'
            : 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent-strong)] hover:brightness-95'
        }`}
      >
        {n}
      </button>
      {open && pos && (
        <span
          className="fixed z-[60] block w-[17.5rem] rounded-[12px] border border-[color:var(--wb-border)] p-3 text-left shadow-[var(--wb-shadow-md)] backdrop-blur-[8px]"
          style={{
            ...pos,
            backgroundColor: 'color-mix(in srgb, var(--wb-surface) 90%, transparent)',
          }}
        >
          <span className="mb-1.5 flex items-center gap-1.5">
            <span className="rounded-full bg-[color:var(--wb-accent-soft)] px-1.5 py-[1px] text-[10px] font-semibold text-[color:var(--wb-accent-strong)]">
              引用 [{n}]
            </span>
            <span className="text-[10.5px] text-[color:var(--wb-muted)]">来源说明</span>
            <IconBtn icon="close" size="sm" ariaLabel="收起引用说明" onClick={onClose} className="ml-auto" />
          </span>
          {info ? (
            <>
              <span className="block text-[12px] font-semibold leading-snug text-[color:var(--wb-text)]">
                {info.title || '（无标题）'}
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
                {[info.authors || '佚名', info.year].filter(Boolean).join(' · ')}
              </span>
              {info.venue && (
                <span className="mt-0.5 block text-[11px] text-[color:var(--wb-accent)]">{info.venue}</span>
              )}
              <span className="mt-1.5 flex flex-wrap gap-2 text-[10.5px] text-[color:var(--wb-muted)]">
                {cited > 0 && <span>被引 {cited}</span>}
                {info.lit_id != null && <span>已入文献库 #{info.lit_id}</span>}
              </span>
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 block truncate text-[10.5px] text-[color:var(--wb-accent)] hover:underline"
                >
                  {info.doi ? `doi:${info.doi}` : url}
                </a>
              )}
              <span className="mt-2 block border-t border-[color:var(--wb-border)] pt-1.5 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
                本报告在此处引用了该来源（会话检索命中的参考文献 [{n}]）
              </span>
            </>
          ) : (
            <span className="block text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
              未取到该序号的文献元数据（可能来自早期会话）。报告中的 [{n}] 仍指向会话检索时对应的参考文献。
            </span>
          )}
        </span>
      )}
    </span>
  )
}
