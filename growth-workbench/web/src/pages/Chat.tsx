/**
 * 课题 Quest 工作台（/chat）：结构借 DeepScientist（启动面 → 课题契约 → quest 工作区），
 * 配色与其他模块完全一致，统一走 --wb-* 设计令牌。
 *
 * 对话渲染是「连续正文流」而不是卡片墙：AI 回复 = 研流小助手 头部 + 无边框正文
 * + 一条细操作条；用户消息是轻气泡。输入框内可直接挂技能 chip（@ 唤起浮层）。
 *
 * 三层结构：
 *   1. 启动面 —— 一句话开题 + quest 项目面板
 *   2. 详细课题契约（可选）—— 左边填契约，右边实时生成 kickoff prompt
 *   3. Quest 工作区 —— 过程可回看，底部随时接管
 *
 * 一题一 quest：每个会话就是一个 quest，标题 = 课题名，第一条消息 = kickoff prompt。
 * 编排画布已拆成独立路由 /canvas；顶部工作台切换条由 App 层统一渲染，本页不再挂页签。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Card, Empty, IconBtn, Input, MdBlock, Modal, Pill, Select, Spinner, TextArea } from '../components/ui'
import { Icon } from '../components/Icon'
import { del, get, patch, post } from '../lib/api'
import { usePersist } from '../lib/state'
import { composeKickoff, EMPTY_QUEST, type Quest } from '../lib/chatKickoff'
import { parseSse } from '../lib/sse'
import SkillMarket from '../features/skills/SkillMarket'
import SkillPicker, { type SkillGroup, type SkillOption } from '../features/skills/SkillPicker'
import { RESEARCH_SKILLS as SKILLS } from '../features/skills/presets'
import {
  ApprovalChip,
  AttachmentChips,
  ComposerTools,
  ContextBar,
  MessageActions,
  ModelPicker,
} from '../features/chat/ComposerTools'
import { chatEnvelope } from '../features/chat/prefs'
import { toast } from '../components/toast'

/** 课题契约（对齐 DeepScientist Start Research 字段）—— 实现见 lib/chatKickoff.ts（已单测） */

/** 全站统一走快模型，不再提供推理档 */
const MODES = [{ value: 'fast', label: 'Balanced（快）' }]

/** Quest 阶段（与后端 chat.STAGES 一致）：调研 → 计划 → 实验 → 成文。
 *  sopf/deliverables/gate 与后端同源，用于阶段切换时把方法纪律真正带进对话，而非一句空话。 */
const STAGES = [
  {
    value: 'survey',
    label: '调研',
    brief: '梳理研究现状：关键工作、主流方法、已知缺口，产出调研小结',
    sop: '系统梳理研究现状：关键工作、主流方法、已知缺口、潜在 baseline 与可复用数据集/指标。优先用工作台已注入的文献与创新点；需要外部文献时给出检索式与优先级，绝不臆造文献、数字或引用。',
    deliverables: '①研究地图（主干技术脉络 2-4 条）②关键工作对比表（方法/优缺点/适用条件）③缺口与机会点清单 ④推荐 baseline 候选 + 评估契约（指标与判据）⑤待确认的研究问题。',
    gate: '「调研→计划」门前，必须向用户呈现研究地图与缺口，等用户确认研究方向与 baseline 后再进入计划，不得自行假定研究问题。',
  },
  {
    value: 'plan',
    label: '计划',
    brief: '输出分阶段研究计划：每阶段有可验证产出与判据，等我确认后执行',
    sop: '基于已确认的调研，建立可信 baseline 与分阶段研究计划。采用发散-收敛-精炼：先列多个候选方向，再给选择理由与证据强度，最后收敛到一个方向，拆成可验证的分阶段计划。',
    deliverables: '①baseline 复现/对齐方案（同数据/同预算/同调参的公平前提）②分阶段计划（每阶段有可验证产出与判据）③选定方向 + 取舍理由 ④风险与所需资源清单。',
    gate: '「计划→实验」门前，必须呈现分阶段计划与选定方向，等用户确认后才细化实验设计、动代码或跑实验，不得在门禁前执行主实验。',
  },
  {
    value: 'experiment',
    label: '实验',
    brief: '把当前计划的第一步细化成可执行任务/实验设计；需要我提供数据时明确列出格式',
    sop: '把计划第一步细化为可执行实验：变量与控制、随机化/重复、样本量依据、指标与判据、混淆因素。需要用户提供数据时，明确列出格式与字段，绝不伪造数据。每轮只推进执行清单中一项「进行中」。',
    deliverables: '①实验协议（设计+参数+判据）②主实验结果（与 baseline 可比的指标）③消融/鲁棒性切片（证据账本）④与计划的偏差说明。',
    gate: '主实验产出达到计划判据后，才可进入成文；未达则先回到计划或补实验，并说明原因，不得把未达标的实验当结论写进论文。',
  },
  {
    value: 'write',
    label: '成文',
    brief: '基于已确认的发现，整理研究报告/论文骨架与核心论证',
    sop: '基于已确认发现整理研究报告/论文骨架。证据优先：每个主张必须能追溯到一条实验/调研产物；整理后从审稿人视角自检（新颖性/严谨性/说服力），预判 3 个最可能被追问的点。',
    deliverables: '①论文骨架（标题候选/摘要/各节要点与字数）②核心论证链（每环对应证据）③图表方案与 caption 草稿 ④局限性与下一步。',
    gate: '成稿后必须做一次苛刻自审（Reviewer 视角），标出致命漏洞与补救，再交付给用户；无证据支撑的声明一律标注「待验证」。',
  },
] as const

/** 进入某阶段时发给 AI 的结构化指令（DeepScientist 的受控推进，带 SOP + 交付物 + 门禁） */
const stagePrompt = (v: string) => {
  const st = STAGES.find((x: any) => x.value === v) as any
  const idx = STAGES.findIndex((x: any) => x.value === v)
  const prev = idx > 0 ? (STAGES[idx - 1] as any).label : ''
  return [
    `【进入「${st.label}」阶段】`,
    prev ? `上一阶段（${prev}）的结论已沉淀到发现记忆，现在` : '课题已立项，现在',
    '请严格按本阶段的 DeepScientist 方法推进：',
    `SOP：${st.sop}`,
    `本阶段交付物：${st.deliverables}`,
    `阶段门禁：${st.gate}`,
    '先给出本阶段产出结构，等我确认方向无误后再展开内容；越过本阶段门禁前不要擅自进入下一阶段执行。',
  ].join('\n')
}

/** 自动推进时每轮发送的「继续」指令（按当前阶段） */
const CONTINUE_PROMPTS: Record<string, string> = {
  survey: '请继续调研：补充关键工作与方法对比，完善调研小结，直到覆盖研究目标涉及的主要方向。',
  plan: '请继续细化研究计划：把下一个阶段拆成更可验证的产出与判据，指出风险与所需资源。',
  experiment: '请继续推进实验：给出下一步具体任务、参数设置与判据；需要我提供数据时明确列出格式。',
  write: '请继续撰写：基于已确认的发现完善报告/论文的下一部分。',
}

/** 内置科研技能清单见 features/skills/presets.ts（/chat 与 /research 共用同一份） */

type Msg = {
  id: number
  role: string
  content: string
  provider?: string
  model?: string
  tokens_out?: number
  created_at?: string
}

/** 小号 uppercase 字段标签（DeepScientist 的表单排版，颜色走令牌） */
function Field({ label, required, children }: { label: string; required?: boolean; children: any }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
        {label}
        {required && <span className="text-[color:var(--wb-danger)]">*</span>}
      </span>
      {children}
    </label>
  )
}

/** HeroScene：寻优山径 —— 契约出发，途经阶段产出，抵达全局最优（配色 = 令牌 hex 副本） */
function HeroScene() {
  return (
    <div className="relative hidden select-none lg:block">
      <svg viewBox="0 0 560 360" className="w-full">
        <defs>
          <radialGradient id="fogA" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(79,70,229,0.08)" />
            <stop offset="100%" stopColor="rgba(79,70,229,0)" />
          </radialGradient>
          <radialGradient id="fogB" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(16,24,40,0.06)" />
            <stop offset="100%" stopColor="rgba(16,24,40,0)" />
          </radialGradient>
          <linearGradient id="pathStroke" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#cfd4dc" />
            <stop offset="100%" stopColor="#4f46e5" />
          </linearGradient>
        </defs>
        <circle cx="120" cy="90" r="110" fill="url(#fogA)" />
        <circle cx="440" cy="250" r="130" fill="url(#fogB)" />
        <path
          d="M60 300 C 160 300, 180 210, 280 195 S 420 150, 490 70"
          fill="none"
          stroke="url(#pathStroke)"
          strokeWidth="2.5"
          strokeDasharray="1 9"
          strokeLinecap="round"
        />
        {(
          [
            { x: 60, y: 300, label: '研究契约', sub: 'Start' },
            { x: 280, y: 195, label: '阶段产出', sub: 'Milestones' },
            { x: 490, y: 70, label: '全局最优', sub: 'Global optimum' },
          ] as const
        ).map((n, i) => (
          <g key={n.sub}>
            <circle
              cx={n.x}
              cy={n.y}
              r={i === 2 ? 26 : 18}
              fill="#ffffff"
              stroke={i === 2 ? '#4f46e5' : '#cfd4dc'}
              strokeWidth="2"
            />
            <circle cx={n.x} cy={n.y} r={i === 2 ? 10 : 6} fill={i === 2 ? '#4f46e5' : '#8a94a6'} opacity={0.9} />
            <text x={n.x} y={n.y + (i === 2 ? 46 : 36)} textAnchor="middle" fontSize="12" fill="#475467">
              {n.label}
            </text>
            <text x={n.x} y={n.y + (i === 2 ? 62 : 52)} textAnchor="middle" fontSize="9.5" fill="#8a94a6" letterSpacing="2">
              {n.sub.toUpperCase()}
            </text>
          </g>
        ))}
        <circle cx="490" cy="70" r="40" fill="url(#fogA)">
          <animate attributeName="r" values="34;46;34" dur="4s" repeatCount="indefinite" />
        </circle>
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------- 页面
export default function Chat() {
  const [sessions, setSessions] = useState<any[]>([])
  const [sid, setSid] = usePersist<number | null>('chat.sid', null)
  const [detail, setDetail] = useState<any>(null)
  const [ctxOptions, setCtxOptions] = useState<{ value: string; label: string }[]>([])
  const [input, setInput] = usePersist('chat.input', '')
  /** 技能市场装进来、允许在对话页挂载的 GitHub 技能 */
  const [ghSkills, setGhSkills] = useState<{ id: string; name: string; desc: string; category: string; repo: string }[]>([])
  /** 本机 ~/.workbuddy/skills 下的 SKILL.md（后端扫描，浏览器读不到本机文件） */
  const [localSkills, setLocalSkills] = useState<{ id: string; name: string; desc: string; dir: string; path: string }[]>([])
  /** 输入框内已挂载的技能 chip：本轮生效，发送后清空 */
  const [mounted, setMounted] = useState<SkillOption[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerHost, setPickerHost] = useState<'chat' | 'home'>('chat')
  const [pickerQ, setPickerQ] = useState('')
  const [marketOpen, setMarketOpen] = useState(false)
  /** 用户消息编辑：改的是服务端那条 user 记录，最后一条会顺带重新生成 */
  const [editId, setEditId] = useState<number | null>(null)
  const [editVal, setEditVal] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState('')
  /** 启动期门闸：挂载时若上次会话还在（chat.sid 持久化），要等 detail 拉回才能进工作区；
   *  这期间不渲染启动面，否则每次进 /chat 都会先闪一下「长得像首页」的启动面再跳走。 */
  const [booting, setBooting] = useState(true)
  // 流式按会话分桶：记录「当前正在生成」的会话，切走对话不中断、也不串台
  const [streamSid, setStreamSid] = useState<number | null>(null)
  const streaming = streamSid === sid
  // 切走对话 / 切走路由时，在途流式继续跑（服务端落库）；只有「还是当前会话 + 组件还活着」才写 UI
  const sidRef = useRef<number | null>(sid)
  const mountedRef = useRef(true)
  useEffect(() => {
    sidRef.current = sid
  }, [sid])
  useEffect(() => () => {
    mountedRef.current = false
  }, [])
  // 全站统一 fast：保留 setter 供选择器使用，档位不再随历史会话变化
  const [, setMode] = usePersist('chat.mode', 'fast')
  const mode = 'fast'
  const [ctxKeys, setCtxKeys] = usePersist<string[]>('chat.ctx', ['ideas'])
  const [questOpen, setQuestOpen] = useState(false)
  /** 快速开题：一句话直接开跑（不想填契约时的默认路径） */
  const [quick, setQuick] = useState('')
  const quickRef = useRef<HTMLTextAreaElement>(null)
  const [quest, setQuest] = usePersist<Quest>('ds.quest', EMPTY_QUEST)
  const [err, setErr] = useState('')
  const [findings, setFindings] = useState<any[]>([])
  const [showFindings, setShowFindings] = useState(false)
  const [autoLeft, setAutoLeft] = useState(0)
  const stopRef = useRef(false)
  // 每个会话各自的 AbortController（按 sid 分桶）：允许 A 后台流式时切到 B 再发 B，
  // 互不覆盖可中止句柄（修复「单例 abortRef 在并发流式下串台」）。
  const abortMapRef = useRef(new Map<number, AbortController>())
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadSessions = async () => setSessions(await get('/chat/sessions'))

  /** 对话页可用的技能：GitHub 白名单 + 本机 skills 目录。装/卸之后调一次即可。 */
  const loadGhSkills = useCallback(async () => {
    try {
      const r = await get<any>('/skills/chat')
      setGhSkills((r.skills || []).map((s: any) => ({
        id: s.id, name: s.name, desc: s.desc, category: s.category, repo: s.repo,
      })))
    } catch {
      setGhSkills([])
    }
    try {
      const r = await get<any>('/skills/local')
      setLocalSkills(r.skills || [])
    } catch {
      setLocalSkills([])
    }
  }, [])

  /** 三组合一：本机 SKILL.md / GitHub 技能 / 内置科研技能 */
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
        label: `科研技能 (${SKILLS.length})`,
        icon: 'sparkle',
        items: SKILLS.map((sk) => ({
          key: 'preset:' + sk.name, id: '', name: sk.name, desc: sk.desc,
          group: '科研技能', text: sk.prompt,
        })),
      },
    ],
    [localSkills, ghSkills],
  )

  const openPicker = (host: 'chat' | 'home') => {
    setPickerHost(host)
    setPickerQ('')
    setPickerOpen(true)
  }

  const closePicker = () => {
    setPickerOpen(false)
    setPickerQ('')
  }

  /** 选中技能 → 输入框内加 chip，并吃掉末尾的 @query */
  const addSkill = (o: SkillOption) => {
    setMounted((prev) => (prev.some((x) => x.key === o.key) ? prev : [...prev, o]))
    closePicker()
    if (pickerHost === 'chat') {
      setInput((v) => v.replace(/(?:^|\s)@[\w-]*$/, '').trimEnd())
      setTimeout(() => composerRef.current?.focus(), 0)
    } else {
      setQuick((v) => v.replace(/(?:^|\s)@[\w-]*$/, '').trimEnd())
      setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-quick-start-wrapper] textarea')?.focus(), 0)
    }
  }

  /** 输入框变更：解析粘贴的 @skill:"路径" 成 chip；敲 @ 唤起浮层 */
  const onComposerChange = (v: string, host: 'chat' | 'home') => {
    const setter = host === 'chat' ? setInput : setQuick
    const re = /@skill:\s*"([^"]+)"|@skill:\s*([^\s]+)/gi
    const found: SkillOption[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(v))) {
      const p = (m[1] || m[2] || '').trim()
      if (!p) continue
      const norm = p.replace(/\\/g, '/').toLowerCase()
      const hit = localSkills.find((s) => s.path.replace(/\\/g, '/').toLowerCase() === norm)
      found.push(
        hit
          ? { key: hit.id, id: hit.id, name: hit.name, desc: hit.desc, group: '本机技能', path: hit.path }
          : {
              key: 'path:' + p,
              id: '',
              name: p.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || p,
              desc: p,
              group: '本机技能',
              path: p,
            },
      )
    }
    let cleaned = v
    if (found.length) {
      cleaned = v.replace(re, ' ').replace(/[ \t]{2,}/g, ' ').trim()
      setMounted((prev) => {
        const keys = new Set(prev.map((x) => x.key))
        return [...prev, ...found.filter((f) => !keys.has(f.key))]
      })
    }
    setter(cleaned)
    const at = cleaned.match(/(?:^|\s)@([\w-]*)$/)
    if (at) {
      setPickerHost(host)
      setPickerQ(at[1])
      setPickerOpen(true)
    } else if (pickerOpen && pickerHost === host) {
      closePicker()
    }
  }

  /** 发送时把 chip 转成后端 skill_refs，发完清空（本轮生效） */
  const takeRefs = () => {
    const refs = mounted.map((o) => ({
      id: o.id || null,
      name: o.name,
      path: o.path || null,
      text: o.text || null,
    }))
    if (mounted.length) setMounted([])
    return refs
  }

  const open = async (id: number) => {
    const d = await get(`/chat/sessions/${id}`)
    setDetail(d)
    setSid(id)
    sidRef.current = id
    // 全站统一 fast：不再按会话里存的历史档位切换
    get(`/chat/sessions/${id}/findings`).then(setFindings).catch(() => {})
    scrollDown()
  }

  const backHome = () => {
    setSid(null)
    setDetail(null)
    sidRef.current = null
  }

  const scrollDown = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 60)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        get('/chat/context/options').then((r) => setCtxOptions(r.options || []))
        loadGhSkills()
        const list = await get('/chat/sessions')
        if (cancelled) return
        setSessions(list || [])
        /** 画布「成果立项 Quest」跳 /chat?quest=<id> 时以 URL 为准；否则回退到上次会话 */
        const fromUrl = Number(new URLSearchParams(window.location.search).get('quest') || 0)
        const cur = fromUrl || Number(localStorage.getItem('wb:chat.sid') || 0)
        if (cur && (list || []).some((s: any) => s.id === cur)) await open(cur)
      } catch {
        /* 拉会话失败：照常落到启动面 */
      } finally {
        // 无论恢复成功与否，启动期结束 —— 后续 open() 走「启动面 → 工作区」的正常交互
        if (!cancelled) setBooting(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Start Research：建 quest + 把 kickoff prompt 作为第一条消息发出去（详细契约版，可选） */
  const startQuest = async () => {
    if (!quest.request.trim()) return
    setBusy('quest')
    setErr('')
    try {
      const s = await post(
        '/chat/sessions',
        { title: quest.title.trim() || quest.request.trim().slice(0, 24), role: 'assistant', mode, context_keys: ctxKeys },
        { ok: false },
      )
      setQuestOpen(false)
      await loadSessions()
      await open(s.id)
      await sendKickoff(composeKickoff(quest), s.id, takeRefs())
      setQuest(EMPTY_QUEST)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  /** 快速开题（默认路径）：一句话 = 一个新 quest。想填完整契约再用「详细设置」弹窗。 */
  const quickStart = async () => {
    const text = quick.trim()
    if (!text || busy) return
    setBusy('quest')
    setErr('')
    try {
      const s = await post(
        '/chat/sessions',
        { title: text.slice(0, 24), role: 'assistant', mode, context_keys: ctxKeys },
        { ok: false },
      )
      setQuick('')
      await loadSessions()
      await open(s.id)
      await sendKickoff(text, s.id, takeRefs())
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  /** 开题首条消息：走流式（弹窗已关，直接在 quest 里看逐字输出） */
  const sendKickoff = (text: string, sidOverride?: number, refs?: any[]) =>
    sendStream(text, false, sidOverride, refs)

  /** 流式发送：乐观加一个 live 泡，SSE 逐字填充；失败撤掉 live 泡（错误文本不当成果）。
   *  修复：流式状态按 sid 分桶——切走对话 / 切走路由都不中断（服务端照常落库），
   *  且只把增量写回「当前停留会话」的 UI，绝不串台。 */
  const sendStream = async (
    text: string,
    regenerate = false,
    sidOverride?: number,
    skillRefs: any[] = [],
  ) => {
    // sidOverride：刚 create 完会话就发首条消息时，React 的 setSid 还没落地，
    // 读 state 会拿到 null 直接 return —— 开题第一句话就这么丢的，所以允许显式传。
    const mySid = sidOverride ?? sid
    if (!mySid || !text) return
    setStreamSid(mySid)
    setErr('')
    const liveId = -Date.now()
    // 只有当前停在该会话，才把乐观泡写进 detail；否则只让服务端跑，回来再拉全量
    if (detail && sidRef.current === mySid) {
      const extra: any[] = []
      if (!regenerate) extra.push({ id: liveId, role: 'user', content: text })
      extra.push({ id: liveId - 1, role: 'assistant', content: '' })
      setDetail({
        ...detail,
        messages: regenerate
          ? [...detail.messages.filter((m: any) => m.content !== '推进中…'), ...extra]
          : [...detail.messages, ...extra],
      })
      scrollDown()
    }
    const ac = new AbortController()
    abortMapRef.current.set(mySid, ac)
    const safeSetDetail = (updater: (d: any) => any) => {
      if (mountedRef.current && sidRef.current === mySid) setDetail(updater)
    }
    const appendLive = (chunk: string) =>
      safeSetDetail((d: any) =>
        d
          ? {
              ...d,
              messages: d.messages.map((m: any) =>
                m.id === liveId - 1 ? { ...m, content: m.content + chunk } : m,
              ),
            }
          : d,
      )
    let failed = false
    try {
      const res = await fetch(`/api/chat/sessions/${mySid}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 注意：流式请求不能带 Idempotency-Key（幂等中间件会缓存整个响应体）
        // skill_refs：输入框里挂的技能 chip，本轮注入 SKILL.md 原文，发完前端已清空
        // chatEnvelope：审批模式 / 本轮模型 / 工作区与附件，后端注入 system 并覆盖模型名
        body: JSON.stringify({
          content: text, mode, regenerate, skill_refs: skillRefs,
          ...chatEnvelope(),
        }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        if (res.status === 401) window.dispatchEvent(new Event('wb:unauthorized'))
        throw new Error(`HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const { events, rest } = parseSse(buf)
        buf = rest
        for (const ev of events) {
          if (ev.type === 'delta') appendLive(String(ev.text ?? ''))
          else if (ev.type === 'error') {
            failed = true
            if (sidRef.current === mySid) {
              const e = ev.error as { label?: unknown; message?: unknown; hint?: unknown }
              setErr([e?.label, e?.message, e?.hint].filter(Boolean).join(' · '))
            }
          }
        }
      }
      const d = await get(`/chat/sessions/${mySid}`)
      safeSetDetail(d)
      loadSessions()
      if (sidRef.current === mySid) scrollDown()
    } catch (e: any) {
      if (e?.name !== 'AbortError' && sidRef.current === mySid)
        setErr(String(e?.message || e))
      const d = await get(`/chat/sessions/${mySid}`)
      safeSetDetail(d)
    } finally {
      if (failed && sidRef.current === mySid) {
        // 失败不落库，前端也不留下半截 AI 内容冒充成果
        safeSetDetail((d: any) =>
          d ? { ...d, messages: d.messages.filter((m: any) => m.id !== liveId - 1) } : d,
        )
      }
      if (abortMapRef.current.get(mySid) === ac) abortMapRef.current.delete(mySid)
      setStreamSid((cur) => (cur === mySid ? null : cur))
    }
  }

  /** 人类接管：随时插话，AI 结合全部历史继续推进（流式） */
  const takeover = (regenerate = false) => {
    if (!sid) return
    // 守卫：当前会话正在流式时，禁止再起一个同会话流（否则 live 气泡与 abort 句柄会互相覆盖）
    if (streaming) return
    const text = input.trim()
    if (!regenerate && !text) return
    if (!regenerate) setInput('')
    const refs = takeRefs()
    sendStream(text, regenerate, undefined, refs)
  }

  /** 编辑用户消息：改服务端那条 user 记录；若是最后一条，按新内容重生成这一轮 */
  const saveEdit = async (m: Msg) => {
    const text = editVal.trim()
    if (!sid || !text) {
      setEditId(null)
      return
    }
    try {
      await patch(`/chat/sessions/${sid}/messages/${m.id}`, { content: text }, { ok: false })
      const d = await get(`/chat/sessions/${sid}`)
      setDetail(d)
      setEditId(null)
      const lastUser = [...(d.messages || [])].reverse().find((x: any) => x.role === 'user')
      if (lastUser?.id === m.id && !streaming) {
        toast('已更新，正在按新内容重新生成', 'ok')
        await takeover(true)
      } else {
        toast('这条消息已更新', 'ok')
      }
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  const setQuestMode = async (v: string) => {
    setMode(v)
    if (sid) {
      await patch(`/chat/sessions/${sid}`, { mode: v })
      setDetail(await get(`/chat/sessions/${sid}`))
    }
  }

  // ---------------------------------------------------------- 阶段推进
  const gotoStage = async (v: string) => {
    if (!sid || !detail || streaming) return
    const cur = detail.stage || 'survey'
    if (v === cur) return
    const st = STAGES.find((x) => x.value === v)!
    const goingBack = STAGES.findIndex((x) => x.value === v) < STAGES.findIndex((x) => x.value === cur)
    const ok = window.confirm(
      goingBack
        ? `回到「${st.label}」阶段？（之后可随时再切换）`
        : `进入「${st.label}」阶段？会发送一条阶段指令，让 AI 产出本阶段成果`,
    )
    if (!ok) return
    setErr('')
    try {
      const d = await patch(`/chat/sessions/${sid}`, { stage: v }, { ok: false })
      setDetail(d)
      await sendStream(stagePrompt(v), false)
      loadSessions()
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  // ---------------------------------------------------------- 发现沉淀（Findings Memory）
  const addFinding = async (content: string, msgId: number) => {
    if (!sid) return
    const text = content.replace(/\s+/g, ' ').trim().slice(0, 400)
    if (!text) return
    try {
      await post(`/chat/sessions/${sid}/findings`, {
        content: text,
        source_msg_id: msgId > 0 ? msgId : null,
      })
      setFindings(await get(`/chat/sessions/${sid}/findings`))
      setShowFindings(true)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }

  const removeFinding = async (fid: number) => {
    await del(`/chat/findings/${fid}`)
    if (sid) setFindings(await get(`/chat/sessions/${sid}/findings`))
  }

  const findingToIdea = async (f: any) => {
    await post('/ideas', {
      title: (detail?.title || '来自 quest 的发现').slice(0, 40),
      one_liner: f.content,
      notes: `来自 quest「${detail?.title || ''}」的发现沉淀`,
    }, { ok: '已存入创新点池' })
  }

  // ---------------------------------------------------------- 自动推进（自治循环，可随时停）
  const AUTO_ROUNDS = 5
  const autoDrive = async () => {
    if (!sid || autoLeft > 0) return
    stopRef.current = false
    setErr('')
    let stageNow = detail?.stage || 'survey'
    for (let i = AUTO_ROUNDS; i > 0; i--) {
      if (stopRef.current) break
      setAutoLeft(i)
      try {
        await sendStream(CONTINUE_PROMPTS[stageNow] || CONTINUE_PROMPTS.survey, false)
        if (stopRef.current) break
        const d = await get(`/chat/sessions/${sid}`)
        stageNow = d.stage || 'survey'
        loadSessions()
      } catch (e: any) {
        setErr(String(e?.message || e))
        break
      }
    }
    setAutoLeft(0)
  }

  const remove = async (id: number) => {
    if (!window.confirm('删掉这个 quest？产出记录一起清掉，不可恢复')) return
    await del(`/chat/sessions/${id}`)
    if (sid === id) backHome()
    loadSessions()
  }

  const exportMd = async () => {
    if (!sid) return
    const r = await post(`/chat/sessions/${sid}/export`, {})
    const blob = new Blob([r.markdown || ''], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${r.title || 'quest'}.md`
    a.click()
  }

  const clear = async () => {
    if (!sid) return
    await post(`/chat/sessions/${sid}/clear`, {}, { ok: '已清空过程记录' })
    setDetail(await get(`/chat/sessions/${sid}`))
    loadSessions()
  }

  const toggleCtx = (v: string) =>
    setCtxKeys(ctxKeys.includes(v) ? ctxKeys.filter((k) => k !== v) : [...ctxKeys, v])

  const ErrBar = (
    <div className="rounded-[9px] bg-[color:var(--wb-danger-soft)] px-3 py-2 text-[12px] text-[color:var(--wb-danger)]">
      {err}
    </div>
  )

  // ------------------------------------------------------------ 启动期：恢复上次会话期间先给个静默的加载态，不渲染启动面
  if (booting) {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--wb-bg)]" aria-busy="true">
        <Spinner className="h-5 w-5" />
      </div>
    )
  }

  // ------------------------------------------------------------ Quest 工作区（Codeg 式：极简顶栏 + 居中问候/时间线 + 居中大输入框）
  if (sid && detail) {
    const msgs: Msg[] = detail.messages || []
    const isEmpty = msgs.length === 0
    return (
      <div className="flex h-full flex-col">
        {/* 顶栏：面包屑 + 右侧轻操作 */}
        <div className="flex items-center gap-1.5 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2">
          <button
            onClick={backHome}
            className="whitespace-nowrap rounded-[7px] px-1.5 py-1 text-[12.5px] text-[color:var(--wb-muted)] transition hover:text-[color:var(--wb-accent)]"
          >
            研流
          </button>
          <Icon name="chevronRight" size={12} className="shrink-0 text-[color:var(--wb-border-strong)]" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--wb-text)]">
            {detail.title || '未命名 Quest'}
          </span>
          <Select value={mode} onChange={setQuestMode} options={MODES} />
          <IconBtn
            icon="download"
            size="md"
            title="导出 Markdown"
            onClick={exportMd}
            className="rounded-[8px]"
          />
          <IconBtn
            icon="trash"
            size="md"
            tone="danger"
            title="清空过程记录"
            onClick={clear}
            className="rounded-[8px]"
          />
        </div>

        {/* 阶段推进条 + 发现记忆 + 自动推进（DeepScientist 的受控自治节奏，收成贴边细条） */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-1.5">
          <div className="flex flex-wrap items-center gap-1">
            {STAGES.map((st, i) => {
              const curIdx = STAGES.findIndex((x) => x.value === (detail.stage || 'survey'))
              const state = i < curIdx ? 'done' : i === curIdx ? 'cur' : 'todo'
              return (
                <button
                  key={st.value}
                  onClick={() => gotoStage(st.value)}
                  disabled={state === 'cur' || streaming || autoLeft > 0}
                  title={`${st.label}：${st.brief}`}
                  className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] transition ${
                    state === 'cur'
                      ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
                      : state === 'done'
                        ? 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] text-[color:var(--wb-ok)]'
                        : 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-muted)] hover:border-[color:var(--wb-border-strong)] hover:text-[color:var(--wb-text-soft)]'
                  } disabled:cursor-default`}
                >
                  {state === 'done' ? <Icon name="check" size={11} /> : <span>{i + 1}</span>}
                  {st.label}
                </button>
              )
            })}
          </div>
          <span className="min-w-2 flex-1" />
          <Btn size="sm" onClick={() => setShowFindings(!showFindings)}>
            <Icon name="star" size={12} />
            发现 {findings.length}
          </Btn>
          {autoLeft > 0 ? (
            <Btn
              size="sm"
              variant="primary"
              onClick={() => {
                stopRef.current = true
                abortMapRef.current.get(sid ?? -1)?.abort()
              }}
            >
              停止（剩 {autoLeft} 轮）
            </Btn>
          ) : (
            <Btn
              size="sm"
              variant="primary"
              onClick={autoDrive}
              disabled={streaming}
              title={`连续自主推进 ${AUTO_ROUNDS} 轮，随时可停`}
            >
              <Icon name="refresh" size={12} />
              自动推进
            </Btn>
          )}
        </div>

        {/* 发现记忆面板：后续每一轮都会自动注入上下文 */}
        {showFindings && (
          <div className="max-h-[30vh] overflow-y-auto rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] p-3">
            {findings.length === 0 ? (
              <div className="py-2 text-center text-[12px] text-[color:var(--wb-muted)]">
                还没有沉淀发现 —— 把 AI 产出里确认成立的结论点「沉淀」存下来，之后每轮对话都会自动带上
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {findings.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-start gap-2 rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-2.5 py-2"
                  >
                    <Icon name="check" size={13} className="mt-0.5 shrink-0 text-[color:var(--wb-ok)]" />
                    <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-[color:var(--wb-text)]">
                      {f.content}
                    </span>
                    <Btn size="sm" variant="ghost" onClick={() => findingToIdea(f)}>
                      存为创新点
                    </Btn>
                    <IconBtn
                      icon="trash"
                      size="sm"
                      tone="danger"
                      ariaLabel="删除该发现"
                      onClick={() => removeFinding(f.id)}
                      className="mt-0.5"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 主区：连续正文流（不是卡片墙）。无消息时只留一句问候，保持干净 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isEmpty ? (
            <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6 py-8">
              <h1 className="text-center text-[34px] font-semibold leading-[1.18] tracking-[-0.035em] text-[color:var(--wb-text)]">
                今天准备做些<span className="text-[color:var(--wb-accent)]">什么</span>呢?
              </h1>
              <p className="mt-4 text-center text-[12.5px] leading-relaxed text-[color:var(--wb-muted)]">
                在下面写下研究目标，输入 <span className="font-medium text-[color:var(--wb-accent)]">@</span> 或点 + 可以挂载技能
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl px-5 py-6">
              <div className="flex flex-col gap-8">
                {msgs.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="flex flex-col items-end gap-1">
                      {editId === m.id ? (
                        <div className="w-full max-w-[80%] rounded-[14px] border border-[color:var(--wb-accent)]/50 bg-[color:var(--wb-surface)] p-2 shadow-[var(--wb-shadow-sm)]">
                          <textarea
                            autoFocus
                            rows={3}
                            value={editVal}
                            onChange={(e) => setEditVal(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') setEditId(null)
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(m)
                            }}
                            className="block w-full resize-none bg-transparent px-1 py-0.5 text-[13.5px] leading-relaxed text-[color:var(--wb-text)] outline-none"
                          />
                          <div className="mt-1 flex items-center justify-end gap-1.5">
                            <span className="mr-auto text-[10.5px] text-[color:var(--wb-muted)]">
                              Ctrl+Enter 保存
                            </span>
                            <Btn size="xs" onClick={() => setEditId(null)}>
                              取消
                            </Btn>
                            <Btn size="xs" variant="primary" onClick={() => saveEdit(m)}>
                              保存并重发
                            </Btn>
                          </div>
                        </div>
                      ) : (
                        <div className="max-w-[80%] whitespace-pre-wrap rounded-[16px] rounded-br-[6px] bg-[color:var(--wb-bg-subtle)] px-3.5 py-2 text-[13.5px] leading-relaxed text-[color:var(--wb-text)]">
                          {m.content}
                        </div>
                      )}
                      <MessageActions
                        time={m.created_at ? String(m.created_at).slice(11, 16) : ''}
                        content={m.content}
                        onEdit={
                          // 流式的乐观消息 id 为负数、服务端还不存在，不能编辑
                          m.id > 0
                            ? () => {
                                setEditId(m.id)
                                setEditVal(m.content)
                              }
                            : undefined
                        }
                        editTitle="编辑这条消息（最后一条会自动重新生成）"
                      />
                    </div>
                  ) : (
                    <div key={m.id} className="wb-chat-prose group">
                      {/* 头部：研流小助手 + 状态，正文无边框无背景，像文档一样连续铺开 */}
                      <div className="mb-2 flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
                          <Icon name="sparkle" size={13} />
                        </span>
                        <span className="text-[12.5px] font-semibold text-[color:var(--wb-text)]">研流小助手</span>
                        <span className="text-[11px] text-[color:var(--wb-muted)]">
                          {m.content ? '已完成' : '生成中…'}
                          {m.created_at ? ` · ${String(m.created_at).slice(11, 16)}` : ''}
                        </span>
                      </div>
                      <div className="pl-8">
                        {m.content ? (
                          <MdBlock text={m.content} />
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--wb-muted)]">
                            <span className="wb-spinner inline-block h-3 w-3" /> 正在组织回答…
                          </span>
                        )}
                      </div>
                      {m.content && m.content.trim() && m.content !== '推进中…' && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-0.5 pl-8 text-[11px] text-[color:var(--wb-muted)]">
                          <button
                            onClick={() => navigator.clipboard?.writeText(m.content)}
                            title="复制全文"
                            className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                          >
                            <Icon name="copy" size={13} />
                          </button>
                          <button
                            onClick={() => addFinding(m.content, m.id)}
                            title="把这条结论存进发现记忆，之后每轮对话自动带上"
                            className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                          >
                            <Icon name="star" size={13} />
                          </button>
                          <button
                            onClick={() => setInput(`> ${m.content.replace(/\s+/g, ' ').slice(0, 160)}\n\n`)}
                            title="引用这条产出，在输入框里追问"
                            className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                          >
                            <Icon name="quote" size={13} />
                          </button>
                          <button
                            onClick={() => takeover(true)}
                            title="重新生成这一轮"
                            className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                          >
                            <Icon name="refresh" size={13} />
                          </button>
                          <span className="flex-1" />
                          {m.model && (
                            <span className="whitespace-nowrap">
                              {m.model}
                              {m.tokens_out ? ` · ${m.tokens_out} tok` : ''}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ),
                )}
                <div ref={bottomRef} className="h-1" />
              </div>
            </div>
          )}
        </div>

        {/* 输入区：技能 chip 在框内，@ 浮层贴在框上方（absolute，不撑高文档流） */}
        <div className="px-4 pb-4 pt-1">
          {err && <div className="mx-auto mb-2 max-w-3xl">{ErrBar}</div>}
          <div className="relative mx-auto max-w-3xl">
            <SkillPicker
              open={pickerOpen && pickerHost === 'chat'}
              groups={pickerGroups}
              query={pickerQ}
              onQuery={setPickerQ}
              onPick={addSkill}
              onClose={closePicker}
            />
            <div
              className="rounded-[20px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-md)] transition-[border-color,box-shadow] duration-150"
              data-tour="tour-chat-composer"
            >
              {/* 已挂载技能：输入框内的 chip，× 可摘掉 */}
              {mounted.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
                  {mounted.map((o) => (
                    <span
                      key={o.key}
                      title={o.desc || o.path || o.group}
                      className="inline-flex max-w-full items-center gap-1 rounded-[8px] border border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] px-2 py-1 text-[11.5px] font-medium text-[color:var(--wb-accent)]"
                    >
                      <Icon
                        name={o.group === 'GitHub 技能' ? 'gitBranch' : o.group === '科研技能' ? 'sparkle' : 'bookOpen'}
                        size={11}
                      />
                      <span className="max-w-[180px] truncate">{o.name}</span>
                      <button
                        onClick={() => setMounted((prev) => prev.filter((x) => x.key !== o.key))}
                        className="ml-0.5 rounded-full transition hover:opacity-70"
                        aria-label={`移除技能 ${o.name}`}
                      >
                        <Icon name="close" size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <AttachmentChips />
              <textarea
                ref={composerRef}
                rows={3}
                placeholder="今天帮你做些什么？@ 添加技能，/ 调用指令"
                value={input}
                onChange={(e: any) => onComposerChange(e.target.value, 'chat')}
                onKeyDown={(e: any) => {
                  // 浮层开着时 Enter 由 SkillPicker 接管（capture 阶段已拦，这里是双保险）
                  if (pickerOpen && pickerHost === 'chat') return
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    takeover(false)
                  }
                }}
                className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[13.5px] leading-relaxed text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
              />
              <div className="flex flex-wrap items-center gap-1 px-3 pb-2.5 pt-1">
                <button
                  onClick={() => openPicker('chat')}
                  title="添加技能（也可直接输入 @）"
                  className={`flex h-7 w-7 items-center justify-center rounded-[8px] transition ${
                    pickerOpen && pickerHost === 'chat'
                      ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                      : 'text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'
                  }`}
                >
                  <Icon name="plus" size={15} />
                </button>
                <button
                  onClick={() => setMarketOpen(true)}
                  title="从 GitHub 技能市场安装"
                  className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                >
                  <Icon name="gitBranch" size={14} />
                </button>
                <button
                  onClick={() => takeover(true)}
                  disabled={streaming || msgs.length === 0}
                  title="重新生成上一轮"
                  className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)] disabled:opacity-40"
                >
                  <Icon name="refresh" size={14} />
                </button>
                <ComposerTools
                  getInput={() => input}
                  onTranscript={(t) => setInput((v) => v + t)}
                  onEnhance={(t) => setInput(t)}
                />
                <span className="flex-1" />
                <ModelPicker />
                {streaming ? (
                  <button
                    onClick={() => abortMapRef.current.get(sid ?? -1)?.abort()}
                    title="停止生成"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--wb-danger)] text-white transition hover:opacity-90"
                  >
                    <Icon name="close" size={15} />
                  </button>
                ) : (
                  <button
                    onClick={() => takeover(false)}
                    disabled={!input.trim()}
                    title="发送（Enter）"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--wb-accent)] text-white transition hover:opacity-90 disabled:opacity-40"
                  >
                    <Icon name="send" size={15} />
                  </button>
                )}
              </div>
            </div>
            <ContextBar />
          </div>
          <SkillMarket
            open={marketOpen}
            onClose={() => setMarketOpen(false)}
            onInstalled={loadGhSkills}
          />
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------ 启动面
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1240px] px-6 py-8 md:px-10 md:py-10">
        {/* Hero：研究工作区启动面 */}
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-1 text-[10.5px] font-medium uppercase tracking-[0.22em] text-[color:var(--wb-muted)]">
                自动化科研
              </span>
            </div>
            <h1 className="text-[28px] font-semibold leading-[1.3] text-[color:var(--wb-text)] md:text-[34px]">
              课题 Quest：从契约到成文
            </h1>
            <div className="text-[11.5px] font-medium uppercase tracking-[0.26em] text-[color:var(--wb-accent)]">
              调研 · 计划 · 实验 · 成文
            </div>
            <p className="max-w-xl text-[13px] leading-relaxed text-[color:var(--wb-text-soft)]">
              一句话就是一个新课题：写下你想研究什么，回车直接开跑。
              想把 Baseline / 成功标准一次说清，再用详细契约。
            </p>
            {/* 快速开题：像聊天一样输入，回车 = 建会话 + 开跑；@ 可挂技能 */}
            <div className="relative w-full max-w-xl">
              <SkillPicker
                open={pickerOpen && pickerHost === 'home'}
                groups={pickerGroups}
                query={pickerQ}
                onQuery={setPickerQ}
                onPick={addSkill}
                onClose={closePicker}
              />
              <div
                className="group w-full rounded-[14px] border bg-[color:var(--wb-surface)] px-3 py-2.5 shadow-[var(--wb-shadow-xs)] transition-[border-color,box-shadow] border-[color:var(--wb-border-strong)]"
                onKeyDown={(e) => {
                  if (pickerOpen && pickerHost === 'home') return
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    quickStart()
                  }
                }}
                data-quick-start-wrapper
              >
                {mounted.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    {mounted.map((o) => (
                      <span
                        key={o.key}
                        className="inline-flex items-center gap-1 rounded-[8px] border border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] px-2 py-1 text-[11.5px] font-medium text-[color:var(--wb-accent)]"
                      >
                        <Icon name="bookOpen" size={11} />
                        <span className="max-w-[160px] truncate">{o.name}</span>
                        <button
                          onClick={() => setMounted((prev) => prev.filter((x) => x.key !== o.key))}
                          className="rounded-full transition hover:opacity-70"
                          aria-label={`移除技能 ${o.name}`}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <TextArea
                    rows={1}
                    value={quick}
                    onChange={(v) => onComposerChange(v, 'home')}
                    placeholder="要研究什么？例如：LLM agent 修复 OpenFOAM 报错的能力评测"
                    className="!border-0 !bg-transparent !px-0 !py-1 focus:!shadow-none"
                  />
                  <Btn
                    variant="primary"
                    loading={busy === 'quest'}
                    disabled={!quick.trim()}
                    onClick={quickStart}
                    className="mb-0.5 shrink-0"
                  >
                    <Icon name="arrowRight" size={14} />
                    开跑
                  </Btn>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => openPicker('home')}
                    className="inline-flex items-center gap-1 rounded-full border border-[color:var(--wb-border)] px-2 py-1 text-[11px] text-[color:var(--wb-text-soft)] transition hover:border-[color:var(--wb-accent)] hover:text-[color:var(--wb-accent)]"
                  >
                    <Icon name="plus" size={11} />
                    @ 添加技能
                  </button>
                  <ApprovalChip />
                  <span className="hidden text-[11px] text-[color:var(--wb-muted)] sm:inline">
                    挂上的技能随第一句话一起生效
                  </span>
                  <span className="flex-1" />
                  <ModelPicker />
                </div>
                <ContextBar />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
              <Btn variant="ghost" size="sm" onClick={() => setQuestOpen(true)}>
                <Icon name="clipboardCheck" size={13} />
                详细课题契约（可选）
              </Btn>
            </div>
            <div className="space-y-1.5 pt-1 text-[11.5px] text-[color:var(--wb-muted)]">
              <div>开题时自动带入工作台上下文：</div>
              <div className="flex flex-wrap gap-1.5">
                {ctxOptions.length === 0 && <span>（暂无可用上下文）</span>}
                {ctxOptions.map((o) => {
                  const on = ctxKeys.includes(o.value)
                  return (
                    <button
                      key={o.value}
                      onClick={() => toggleCtx(o.value)}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] transition ${
                        on
                          ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
                          : 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-border-strong)]'
                      }`}
                    >
                      {on && <Icon name="check" size={11} />}
                      {o.label}
                    </button>
                  )
                })}
              </div>
            </div>
            {err && <div className="max-w-xl">{ErrBar}</div>}
          </div>
          <HeroScene />
        </div>

        {/* Quest 项目面板 */}
        <div className="mt-10">
          <Card
            title={`Quests（${sessions.length}）`}
            tourId="tour-chat-launch"
            extra={
              <Btn
                onClick={() => {
                  window.scrollTo?.({ top: 0, behavior: 'smooth' })
                  document.querySelector<HTMLTextAreaElement>('[data-quick-start-wrapper] textarea')?.focus()
                }}
              >
                <Icon name="plus" size={13} />
                新课题
              </Btn>
            }
          >
            {sessions.length === 0 ? (
              <Empty
                text="还没有 quest"
                hint="在上面输入框写一句话研究目标，回车直接开跑；或点「详细课题契约」慢慢填"
              />
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {sessions.map((s) => {
                  const active = Number(s.msg_count) > 0
                  return (
                    <div
                      key={s.id}
                      className="group relative cursor-pointer rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3.5 py-3 transition hover:border-[color:var(--wb-accent)] hover:shadow-[var(--wb-shadow-sm)]"
                      onClick={() => open(s.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-semibold text-[color:var(--wb-text)] transition group-hover:text-[color:var(--wb-accent)]">
                            {s.title || '未命名 Quest'}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[color:var(--wb-muted)]">
                            <span
                              className={`inline-block h-1.5 w-1.5 rounded-full ${
                                active ? 'bg-[color:var(--wb-ok)]' : 'bg-[color:var(--wb-warn)]'
                              }`}
                            />
                            {active ? '进行中' : '待启动'}
                            <span className="text-[color:var(--wb-border-strong)]">·</span>
                            {STAGES.find((x) => x.value === s.stage)?.label || '调研'}
                            <span className="text-[color:var(--wb-border-strong)]">·</span>
                            Balanced
                          </div>
                        </div>
                        <IconBtn
                          icon="trash"
                          size="sm"
                          tone="danger"
                          ariaLabel="删除该 quest"
                          onClick={(e) => {
                            e.stopPropagation()
                            remove(s.id)
                          }}
                          className="absolute right-2 top-2 opacity-0 group-hover:opacity-100"
                        />
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
                        {(s.first_msg || '').replace(/\s+/g, ' ').slice(0, 90) || '（kickoff 还没执行）'}
                      </p>
                      <div className="mt-2.5 flex items-center justify-between border-t border-[color:var(--wb-border)] pt-2 text-[11px] text-[color:var(--wb-muted)]">
                        <span>{s.msg_count || 0} 条产出</span>
                        <span>更新 {String(s.updated_at || '').slice(5, 16)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Start Research：左契约右 prompt，Create 前先检查（DeepScientist 核心交互） */}
      <Modal
        open={questOpen}
        onClose={() => setQuestOpen(false)}
        title="Start Research · 课题契约"
        width="max-w-4xl"
        footer={
          <>
            <Btn onClick={() => setQuestOpen(false)}>取消</Btn>
            <Btn variant="primary" onClick={startQuest} loading={busy === 'quest'} disabled={!quest.request.trim()}>
              创建 Quest 并执行 Kickoff
            </Btn>
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-2.5">
            <Field label="课题标题">
              <Input
                placeholder="例：LLM agent 修复 OpenFOAM 报错的能力评测"
                value={quest.title}
                onChange={(v) => setQuest({ ...quest, title: v })}
              />
            </Field>
            <Field label="研究目标" required>
              <TextArea
                rows={4}
                placeholder="要研究 / 复现什么？研究问题是什么？边界在哪？"
                value={quest.request}
                onChange={(v) => setQuest({ ...quest, request: v })}
              />
            </Field>
            <Field label="已有基础与 Baseline">
              <TextArea
                rows={2}
                placeholder="仓库 / 路径 / 已有实验数据…"
                value={quest.baseline}
                onChange={(v) => setQuest({ ...quest, baseline: v })}
              />
            </Field>
            <Field label="参考文献">
              <TextArea
                rows={2}
                placeholder="关键论文、综述、优先阅读的材料…"
                value={quest.papers}
                onChange={(v) => setQuest({ ...quest, papers: v })}
              />
            </Field>
            <Field label="成功标准">
              <TextArea
                rows={2}
                placeholder="什么算验证成功？看哪个指标？"
                value={quest.goals}
                onChange={(v) => setQuest({ ...quest, goals: v })}
              />
            </Field>
            <Field label="硬约束">
              <TextArea
                rows={2}
                placeholder="不能用什么方法、必须对齐什么、时间 / 算力边界…"
                value={quest.constraints}
                onChange={(v) => setQuest({ ...quest, constraints: v })}
              />
            </Field>
            <Field label="研究强度">
              <Select value={mode} onChange={setMode} options={MODES} />
            </Field>
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[10.5px] uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
              Kickoff Prompt 预览 · 创建后作为第一条产出，全程可回看
            </div>
            <div className="max-h-[52vh] min-h-[180px] overflow-y-auto whitespace-pre-wrap rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] p-3 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
              {quest.request.trim() ? composeKickoff(quest) : '（填写研究目标后自动生成）'}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
              创建前一定检查右边：scope 对不对、参考有没有丢、约束全不全 ——
              这是成本最低的纠错点。
            </p>
          </div>
        </div>
      </Modal>

      <SkillMarket
        open={marketOpen}
        onClose={() => setMarketOpen(false)}
        onInstalled={loadGhSkills}
      />
    </div>
  )
}
