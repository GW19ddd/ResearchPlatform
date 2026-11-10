import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Btn, IconBtn, Modal, TextArea } from '../components/ui'
import { Icon } from '../components/Icon'
import { ResizeHandle } from '../components/ResizeHandle'
import { toast } from '../components/toast'
import { get, patch, post, del } from '../lib/api'
import { usePersist } from '../lib/state'
import { ConvoStore } from '../lib/convoStore'
import { useConvoSession } from '../lib/useConvoSession'
import ChatPanel, { type ChatMsg, type ChipConf, type PlusItem, type Citation } from '../features/canvas/ChatPanel'
import { relTime } from '../lib/time'
import { streamChat, type ChatStreamEvent, type RchatServerMsg, type PaperHit } from '../lib/rchatStream'
import { chatEnvelope } from '../features/chat/prefs'
import SkillPicker, { type SkillGroup, type SkillOption } from '../features/skills/SkillPicker'
import { RESEARCH_SKILLS } from '../features/skills/presets'
import ResearchDock, {
  LiteraturePane, useResearchRun, beginRun, pushStage, setPapers, finishRun, hydratePapers, clearRun,
} from '../features/research/ResearchDock'
import PaperDetailModal, { type PaperInfo } from '../features/research/PaperDetail'
import ConsensusPane from '../features/research/ConsensusPane'

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

/** 快捷能力：点 chip 只挂到输入框，不再弹提案大卡；三个值都会走真实的后端模式 */
type ModeTag = '深度检索' | '报告撰写' | '文献检索'

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
    // 研究回答按 Markdown 渲染（标题 / 加粗 / 列表 / 表格），[n] 由 ChatPanel 变成可点引用
    md: true,
  }
}

/** Undermind 左栏的时间格式：2w / 3d / 5h —— 实现见 lib/time.ts（已单测） */

const CHIPS: ChipConf[] = [
  { icon: 'search', label: '深度检索', text: '', tag: '深度检索' },
  { icon: 'file', label: '撰写报告', text: '', tag: '报告撰写' },
  { icon: 'book', label: '文献检索', text: '', tag: '文献检索' },
]

/** 右侧附属栏：报告文档 / 文献检索二选一，始终只开一栏，保持「对话 + 一栏」的双栏。
 *  docId 只在从左栏「文档」点开时带上，用于给该文档项加选中态；聊天卡入口不带。 */
type Pane =
  | { kind: 'report'; msg: ChatMsg; docId?: number }
  | { kind: 'literature' }
  | { kind: 'consensus' }

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
  // 左栏可完全收起：收起后留 36px 图标 rail，刷新 / 切页签都保持
  const [leftOpen, setLeftOpen] = usePersist('rchat.leftOpen', true)
  // 深度检索想保留的文献篇数上限：仅 deep 模式生效，4–40，刷新保持
  const [maxPapers, setMaxPapers] = usePersist('rchat.maxPapers', 15)
  const [docs, setDocs] = useState<DocRow[]>([])
  /** 正文 [n] / 引用 chips / 文献标题点开的文献详情弹窗 */
  const [paperInfo, setPaperInfo] = useState<PaperInfo | null>(null)
  /** 提问历史导航：列表开关 + 跳转目标 + 上次选中的条目（图 3 的高亮行） */
  const [histOpen, setHistOpen] = useState(false)
  const [jumpTo, setJumpTo] = useState<{ index: number; nonce: number } | null>(null)
  const [activeHist, setActiveHist] = useState<number | null>(null)
  /** 输入框里挂着的快捷能力（三选一）与技能（可多个）：都只对下一轮生效 */
  const [modeTag, setModeTag] = useState<ModeTag | null>(null)
  const [mounted, setMounted] = useState<SkillOption[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')
  const [localSkills, setLocalSkills] = useState<{ id: string; name: string; desc: string; path: string }[]>([])
  const [ghSkills, setGhSkills] = useState<{ id: string; name: string; desc: string; category: string }[]>([])
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
  // 文献结果栏仍由左栏入口 / 上方常驻卡打开；快捷 chip 不再把它「跳」出来
  const openLit = () => setPane({ kind: 'literature' })
  const openConsensus = () => setPane({ kind: 'consensus' })

  /** 左栏文档：先立即打开报告双栏，再按 session 补回该报告的引用元数据（/documents 不带 meta） */
  const openDoc = async (d: DocRow) => {
    const cached = docCitsRef.current[d.id] || d.citations || []
    setPane({
      kind: 'report',
      msg: { role: 'assistant', content: d.content, kind: 'report', citations: cached },
      docId: d.id,
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
          ? { ...prev, msg: { ...prev.msg, citations: cits } }
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

  // 加号「添加技能」的技能源：本机 SKILL.md + 对话白名单里的 GitHub 技能（与 /chat 同源）
  useEffect(() => {
    ;(async () => {
      try {
        const r = await get<any>('/skills/chat')
        setGhSkills(r.skills || [])
      } catch {
        setGhSkills([])
      }
      try {
        const r = await get<any>('/skills/local')
        setLocalSkills(r.skills || [])
      } catch {
        setLocalSkills([])
      }
    })()
  }, [])

  // 提问历史浮层点外面收起；不用 Modal，保持「输入框上方一列小条目」的轻量感
  useEffect(() => {
    if (!histOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest?.('[data-history-root]')) setHistOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [histOpen])

  const pickerGroups: SkillGroup[] = useMemo(
    () => [
      {
        key: 'local',
        label: `本机技能 (${localSkills.length})`,
        icon: 'bookOpen',
        items: localSkills.map((s) => ({
          key: s.id, id: s.id, name: s.name, desc: s.desc, group: '本机技能', path: s.path,
        })),
      },
      {
        key: 'github',
        label: `GitHub 技能 (${ghSkills.length})`,
        icon: 'gitBranch',
        items: ghSkills.map((s) => ({
          key: s.id, id: s.id, name: s.name, desc: s.desc, group: 'GitHub 技能',
        })),
      },
      {
        key: 'research',
        label: `科研技能 (${RESEARCH_SKILLS.length})`,
        icon: 'sparkle',
        items: RESEARCH_SKILLS.map((sk) => ({
          key: 'preset:' + sk.name, id: '', name: sk.name, desc: sk.desc,
          group: '科研技能', text: sk.prompt,
        })),
      },
    ],
    [localSkills, ghSkills],
  )

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

  /** 流式请求共用收尾：登记 abort → 消费事件 → 追加落库消息 → 进度收尾。send / reviewSelected 共用。 */
  const driveStream = async (useSid: number, payload: Record<string, unknown>, ctrl: AbortController) => {
    rchatStore.registerTask(useSid, ctrl)
    try {
      const msg = await streamChat(
        useSid,
        payload as Parameters<typeof streamChat>[1],
        (ev: ChatStreamEvent) => {
          if (removedRef.current.has(useSid)) return
          if (ev.type === 'stage') pushStage(useSid, ev)
          else if (ev.type === 'papers') {
            setPapers(useSid, ev.papers, ev.total, ev.query_count, ev.raw_hits)
          }
        },
        ctrl.signal,
      )
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

  /** mode: auto | deep | report。deep/report 的正文由后端生成，输入框内容作为研究问题。
   *  输入框里挂的能力 chip 决定本轮模式，挂的技能 chip 随请求注入 system，发完即清。 */
  const send = async (raw?: string, tag?: string) => {
    const question = (raw ?? input).trim()
    if (!question || busy) return
    const activeTag = tag ?? modeTag ?? undefined
    let mode: 'auto' | 'deep' | 'report' = 'auto'
    if (activeTag === '深度检索') mode = 'deep'
    else if (activeTag === '报告撰写') mode = 'report'
    // 后端只有 deep 会真的查 OpenAlex 并入库；「文献检索」复用同一条真实检索链路，
    // 命中显示在上方常驻文献卡，左栏入口仍可打开结果栏回看。
    else if (activeTag === '文献检索') mode = 'deep'
    const skillRefs = mounted.map((o) => ({
      id: o.id || null, name: o.name, path: o.path || null, text: o.text || null,
    }))
    let useSid: number
    if (!sid) {
      const s = await post('/rchat/sessions', {})
      useSid = s.id
      setSid(s.id)
      await loadSessions()
    } else {
      useSid = sid
    }
    const optimistic: ChatMsg = {
      role: 'user',
      content: question,
      skillTag:
        activeTag ||
        (mounted.length ? `技能 · ${mounted.slice(0, 2).map((o) => o.name).join(' / ')}` : '研究对话'),
    }
    // 关键修复：一律写进 useSid 自己的桶，切走对话不串台
    rchatStore.appendMessage(useSid, optimistic)
    setInput('')
    // 挂载的能力 / 技能只对这一轮生效
    setModeTag(null)
    setMounted([])
    setPickerOpen(false)
    setPickerQ('')
    rchatStore.setBusy(useSid, true)
    // 立刻把进度框亮出来：点「启动」后不再只是往消息流里加一条，而是有明确的阶段反馈
    beginRun(useSid, mode)
    // 登记 AbortController：删会话时 ConvoStore.removeSession 会 abort，
    // 在途 SSE 立刻断开，不必等 LLM 跑完（结果本来也会被 removedRef 丢弃）
    await driveStream(
      useSid,
      { instruction: question, mode, tag: activeTag, skill_refs: skillRefs, max_papers: mode === 'deep' ? maxPapers : undefined, ...chatEnvelope() },
      new AbortController(),
    )
  }

  /** 文献检索栏勾选子集 → 只对勾选的文献写综述（后端 review 模式，只引用勾选来源） */
  const reviewSelected = async (papers: PaperHit[]) => {
    if (busy) return
    const ids = Array.from(new Set(papers.map((p) => p.lit_id).filter((x): x is number => typeof x === 'number')))
    if (!ids.length) {
      toast('勾选的文献没有入库 id，无法定向综述', 'error')
      return
    }
    let useSid: number
    if (!sid) {
      const s = await post('/rchat/sessions', {})
      useSid = s.id
      setSid(s.id)
      await loadSessions()
    } else {
      useSid = sid
    }
    const question = `对勾选的 ${ids.length} 篇文献写综述`
    rchatStore.appendMessage(useSid, { role: 'user', content: question, skillTag: '综述撰写' })
    rchatStore.setBusy(useSid, true)
    beginRun(useSid, 'review')
    await driveStream(
      useSid,
      { instruction: question, mode: 'review', lit_ids: ids, ...chatEnvelope() },
      new AbortController(),
    )
  }

  /** 快捷 chip：只切换输入框里的能力 chip，不弹提案大卡、不新开面板；再点一次取消 */
  const toggleMode = (t: ModeTag) => {
    setModeTag((cur) => (cur === t ? null : t))
    setPickerOpen(false)
  }

  /** 加号 → 技能选择器：选中后挂成输入框内的 chip，发送时才转成 skill_refs */
  const addSkill = (o: SkillOption) => {
    setMounted((prev) => (prev.some((x) => x.key === o.key) ? prev : [...prev, o]))
    setPickerOpen(false)
    setPickerQ('')
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
    { icon: 'sparkle', label: '添加技能', desc: '本机 SKILL.md / GitHub 技能 / 内置科研技能，挂上后只对这一轮生效', onClick: () => { setPickerQ(''); setPickerOpen(true) } },
    { icon: 'inbox', label: 'Add papers', desc: '上传已发表的论文或预印本（PDF，一次最多 5 篇）', onClick: () => pdfRef.current?.click() },
    { icon: 'library', label: 'Import bibliography', desc: '粘贴或上传 BibTeX / RIS / CSL JSON 参考文献列表', onClick: () => setBibOpen(true) },
  ]

  const composerPlaceholder =
    modeTag === '深度检索'
      ? '写检索主题（可补充年份 / 会议 / 关注角度 / 排除项），回车启动检索'
      : modeTag === '报告撰写'
        ? '写报告主题与要求（结构 / 篇幅 / 受众），回车生成报告'
        : modeTag === '文献检索'
          ? '写要检索的方向，回车查 OpenAlex 真数据并入库'
          : '输入消息…'

  const cur = sessions.find((s) => s.id === sid)
  const reportName =
    pane?.kind === 'report' ? pane.msg.content.match(/^#\s+(.+)$/m)?.[1]?.trim() : undefined

  /** 当前会话的提问列表：点一条滚到对话里的对应消息（图 3 的高亮行 = 最近跳转的那条） */
  const userMsgs = useMemo(
    () => messages.map((m, i) => ({ m, i })).filter((x) => x.m.role === 'user'),
    [messages],
  )
  const lastQuestion = userMsgs.length ? userMsgs[userMsgs.length - 1].m.content : ''
  const PAPER_OPTS = [8, 15, 25, 40]
  const historyExtra = (
    <>
      <div className="flex items-center gap-1.5" title="深度检索保留的文献篇数上限（仅「深度检索 / 文献检索」生效）">
        <span className="text-[10.5px] text-[color:var(--wb-muted)]">检索数量</span>
        <div className="flex items-center rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-0.5">
          {PAPER_OPTS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setMaxPapers(n)}
              className={`rounded-[6px] px-1.5 py-[2px] text-[11px] transition ${
                maxPapers === n
                  ? 'bg-[color:var(--wb-accent)] text-white'
                  : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div data-history-root className="relative">
      <button
        type="button"
        onClick={() => setHistOpen((v) => !v)}
        title="跳转到对应历史提问"
        className={`flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11.5px] transition ${
          histOpen
            ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent-strong)]'
            : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
        }`}
      >
        <Icon name="clock" size={12} />
        历史{userMsgs.length ? ` · ${userMsgs.length}` : ''}
      </button>
      {histOpen && (
        <div className="absolute right-0 top-full z-40 mt-2 w-[340px] overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-md)]">
          <div className="border-b border-[color:var(--wb-border)] px-3.5 py-2.5 text-[11px] font-semibold text-[color:var(--wb-muted)]">
            提问历史 · 点击跳到对话中对应位置
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">
            {userMsgs.length ? (
              userMsgs.map(({ m, i }) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setActiveHist(i)
                    setJumpTo({ index: i, nonce: Date.now() })
                    setHistOpen(false)
                  }}
                  className={`block w-full px-3.5 py-2 text-left text-[12px] leading-relaxed transition ${
                    activeHist === i
                      ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent-strong)]'
                      : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                  }`}
                >
                  <span className="line-clamp-2">{m.content}</span>
                </button>
              ))
            ) : (
              <p className="px-3.5 py-4 text-[11px] text-[color:var(--wb-muted)]">这个会话还没有提问。</p>
            )}
          </div>
        </div>
      )}
    </div>
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
      {/* 左栏：对话管理（对标 Undermind 侧栏）；可整体收起，展开时右边缘可拖拽调宽 */}
      {leftOpen ? (
        <>
      <aside
        data-resizable
        data-tour="tour-research-dock"
        className="flex shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)]"
        style={{ width: leftW, minWidth: 180, maxWidth: 400 }}
      >
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
            Chats
          </span>
          <div className="flex items-center gap-0.5">
            <IconBtn icon="plus" size="sm" ariaLabel="新对话" onClick={newChat} />
            <IconBtn
              icon="chevronsLeft"
              size="sm"
              ariaLabel="收起侧栏"
              title="收起侧栏（保留图标条）"
              onClick={() => setLeftOpen(false)}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex items-center gap-1 border-l-2 px-2 py-[7px] transition ${
                s.id === sid
                  ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface)]'
                  : 'border-transparent hover:bg-[color:var(--wb-surface)]/50'
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
          <div className="mt-1 border-t border-[color:var(--wb-border)]" />
          <div className="px-2 pb-1.5 pt-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
              文档
            </span>
          </div>
          {docs.map((d) => {
            // 当前双栏打开的正是这篇 → 整行加深（与左栏会话激活态同款）
            const active = pane?.kind === 'report' && pane.docId === d.id
            return (
              <div
                key={d.id}
                className={`group flex items-center gap-1 border-l-2 px-2 py-[7px] transition ${
                  active
                    ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface)]'
                    : 'border-transparent hover:bg-[color:var(--wb-surface)]/50'
                }`}
              >
                <button
                  onClick={() => openDoc(d)}
                  aria-current={active ? 'true' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title="打开报告"
                >
                  <Icon
                    name="file"
                    size={12}
                    className={`shrink-0 ${active ? 'text-[color:var(--wb-accent)]' : 'text-[color:var(--wb-muted)]'}`}
                  />
                  <span
                    className={`truncate text-[12px] ${
                      active
                        ? 'font-medium text-[color:var(--wb-accent-strong)]'
                        : 'text-[color:var(--wb-text-soft)]'
                    }`}
                  >
                    {d.title}
                  </span>
                </button>
                <span className="shrink-0 text-[10px] text-[color:var(--wb-muted)]">{relTime(d.created_at)}</span>
              </div>
            )
          })}
          {!docs.length && (
            <p className="px-2 py-2 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
              点「撰写报告」生成的报告会沉淀在这里，随时回看。
            </p>
          )}
        </div>
        <div className="mt-1 flex flex-col border-t border-[color:var(--wb-border)]">
          {/* 与左栏「文档」对称的入口：点开在右侧双栏看本次检索结果 */}
          <button
            onClick={openLit}
            className={`flex w-full items-center gap-2 border-l-2 px-2 py-2 text-[12px] transition ${
              pane?.kind === 'literature'
                ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface)] font-medium text-[color:var(--wb-accent-strong)]'
                : 'border-transparent text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-surface)]/50'
            }`}
          >
            <Icon name="search" size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
            文献检索
            {(run?.papers.length || 0) > 0 && (
              <span className="rounded-[3px] bg-[color:var(--wb-accent-soft)] px-1.5 py-[1px] text-[10px] text-[color:var(--wb-accent-strong)]">
                {run?.papers.length}
              </span>
            )}
            <Icon name="arrowRight" size={11} className="ml-auto text-[color:var(--wb-muted)]" />
          </button>
          {/* 共识：对本次命中的文献做人工投票 + Agent 立场判定（对标 Consensus 的 Paper / Answer） */}
          <button
            onClick={openConsensus}
            className={`flex w-full items-center gap-2 border-l-2 px-2 py-2 text-[12px] transition ${
              pane?.kind === 'consensus'
                ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-surface)] font-medium text-[color:var(--wb-accent-strong)]'
                : 'border-transparent text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-surface)]/50'
            }`}
          >
            <Icon name="layers" size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
            共识
            {(run?.papers.length || 0) > 0 && (
              <span className="rounded-[3px] bg-[color:var(--wb-accent-soft)] px-1.5 py-[1px] text-[10px] text-[color:var(--wb-accent-strong)]">
                {run?.papers.length} 篇
              </span>
            )}
            <Icon name="arrowRight" size={11} className="ml-auto text-[color:var(--wb-muted)]" />
          </button>
          <button
            onClick={() => nav('/literature')}
            className="flex w-full items-center gap-2 border-l-2 border-transparent px-2 py-2 text-[12px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-surface)]/50"
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
        </>
      ) : (
        /* 收起态：36px 图标条，随时恢复左栏；常用入口不丢 */
        <aside className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] py-2">
          <IconBtn icon="chevronsRight" size="sm" ariaLabel="展开侧栏" title="展开侧栏" onClick={() => setLeftOpen(true)} />
          <span className="my-1 h-px w-4 bg-[color:var(--wb-border)]" />
          <IconBtn icon="plus" size="sm" ariaLabel="新对话" title="新对话" onClick={newChat} />
          <IconBtn icon="search" size="sm" ariaLabel="文献检索" title="文献检索" onClick={openLit} />
          <IconBtn icon="layers" size="sm" ariaLabel="共识" title="共识" onClick={openConsensus} />
          <IconBtn icon="book" size="sm" ariaLabel="文献库" title="文献库" onClick={() => nav('/literature')} />
        </aside>
      )}

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
          active: modeTag === c.tag,
          onClick: () => toggleMode(c.tag as ModeTag),
        }))}
        composerChips={
          modeTag || mounted.length ? (
            <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2.5">
              {modeTag && (
                <span className="inline-flex items-center gap-1 rounded-[8px] border border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] px-2 py-1 text-[11.5px] font-medium text-[color:var(--wb-accent)]">
                  <Icon name={CHIPS.find((c) => c.tag === modeTag)?.icon || 'sparkle'} size={11} />
                  {modeTag}
                  <button
                    onClick={() => setModeTag(null)}
                    aria-label={`移除${modeTag}`}
                    className="ml-0.5 rounded-full transition hover:opacity-70"
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              )}
              {mounted.map((o) => (
                <span
                  key={o.key}
                  title={o.desc || o.path || o.group}
                  className="inline-flex max-w-full items-center gap-1 rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2 py-1 text-[11.5px] text-[color:var(--wb-text-soft)]"
                >
                  <Icon
                    name={o.group === 'GitHub 技能' ? 'gitBranch' : o.group === '科研技能' ? 'sparkle' : 'bookOpen'}
                    size={11}
                  />
                  <span className="max-w-[180px] truncate">{o.name}</span>
                  <button
                    onClick={() => setMounted((prev) => prev.filter((x) => x.key !== o.key))}
                    aria-label={`移除技能 ${o.name}`}
                    className="ml-0.5 rounded-full transition hover:opacity-70"
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : undefined
        }
        composerOverlay={
          <SkillPicker
            open={pickerOpen}
            groups={pickerGroups}
            query={pickerQ}
            onQuery={setPickerQ}
            onPick={addSkill}
            onClose={() => {
              setPickerOpen(false)
              setPickerQ('')
            }}
          />
        }
        overlayOpen={pickerOpen}
        placeholder={composerPlaceholder}
        samples={[]}
        plusItems={plusItems}
        exportName={cur?.title || '研究对话'}
        onCite={(c) => setPaperInfo(c)}
        headerExtra={historyExtra}
        jumpTo={jumpTo}
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
        <ReportPane
          report={pane.msg}
          name={reportName}
          width={paneW}
          onClose={closePane}
          onOpenPaper={(c) => setPaperInfo(c)}
        />
      )}
      {pane?.kind === 'literature' && (
        <LiteraturePane
          run={run}
          width={paneW}
          onClose={closePane}
          onOpenPaper={(p) => setPaperInfo(p)}
          onReview={reviewSelected}
        />
      )}
      {pane?.kind === 'consensus' && (
        <ConsensusPane
          sid={sid}
          question={lastQuestion}
          papers={run?.papers || []}
          width={paneW}
          onClose={closePane}
          onOpenPaper={(p) => setPaperInfo(p)}
        />
      )}

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

      {/* 正文 [n] / 引用 chips / 文献标题 / 报告引用 → 同一个文献详情弹窗 */}
      <PaperDetailModal
        info={paperInfo}
        onClose={() => setPaperInfo(null)}
        onOpenLibrary={() => nav('/literature')}
      />

      </div>
    </div>
  )
}

/**
 * 报告文档栏：与右侧对话栏并排组成双栏，不再用点击后「跳出来」的弹窗。
 * 栏头右上角的叉 = 收起这一栏、对话恢复单栏全宽；导出 Markdown 保留。
 */
function ReportPane({
  report, name, width, onClose, onOpenPaper,
}: {
  report: ChatMsg
  name?: string
  width: number
  onClose: () => void
  onOpenPaper?: (c: Citation) => void
}) {
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
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
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
        <div className="px-4 py-3">
          <ReportMd text={report.content} citations={report.citations} onOpenPaper={onOpenPaper} />
        </div>
      </div>
    </aside>
  )
}

/** 报告 Markdown 轻渲染：标题/列表 + [n] 可点引用（点开在序号下方浮出半透明说明框） */
function ReportMd({
  text,
  citations = [],
  onOpenPaper,
}: {
  text: string
  citations?: Citation[]
  onOpenPaper?: (c: Citation) => void
}) {
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
    onOpenPaper,
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
  onOpenPaper?: (c: Citation) => void
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
          onOpenPaper={ctx.onOpenPaper}
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
  onOpenPaper,
}: {
  n: number
  info?: Citation
  open: boolean
  onToggle: () => void
  onClose: () => void
  onOpenPaper?: (c: Citation) => void
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
              {onOpenPaper && (
                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    onOpenPaper(info)
                  }}
                  className="mt-2 block w-full rounded-[8px] bg-[color:var(--wb-accent)] px-2 py-1.5 text-[11px] font-medium text-white transition hover:opacity-90"
                >
                  查看这篇文献的对应内容
                </button>
              )}
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
