/**
 * 科研工作区（对话）：结构借 DeepScientist（启动面 → 课题契约 → quest 工作区），
 * 配色与其他模块完全一致，统一走 --wb-* 设计令牌。
 *
 * 三层结构：
 *   1. 启动面 —— 不是聊天框：Start Research 主入口 + quest 项目卡片面板
 *   2. Start Research 弹窗 —— 左边填课题契约（目标/Baseline/参考/成功标准/硬约束/研究强度），
 *      右边实时生成 kickoff prompt，Create 之前必须检查（DeepScientist 的核心纠错点）
 *   3. Quest 工作区 —— 过程可回看（每条产出带模型与时间），底部「人类接管」随时介入
 *
 * 一题一 quest：每个会话就是一个 quest，标题 = 课题名，第一条消息 = kickoff prompt（契约全文）。
 * 后端零改动：复用 /chat/sessions 与消息接口。
 */
import { useEffect, useRef, useState } from 'react'
import { Btn, Card, Empty, IconBtn, Input, MdBlock, Modal, Pill, SearchInput, Segmented, Select, TextArea } from '../components/ui'
import { Icon } from '../components/Icon'
import { del, get, patch, post } from '../lib/api'
import { usePersist } from '../lib/state'
import Canvas from './Canvas'

/** 课题契约（对齐 DeepScientist Start Research 字段） */
type Quest = {
  title: string
  request: string
  baseline: string
  papers: string
  goals: string
  constraints: string
}
const EMPTY_QUEST: Quest = { title: '', request: '', baseline: '', papers: '', goals: '', constraints: '' }

const composeKickoff = (q: Quest) => {
  const block = (label: string, v: string, fallback: string) =>
    `【${label}】\n${v.trim() || fallback}`
  return [
    `【研究目标】\n${q.request.trim()}`,
    block('已有基础与 Baseline', q.baseline, '（无，请先自行调研并给出可复现的起点）'),
    block('参考文献', q.papers, '（无）'),
    block('成功标准', q.goals, '（未定，请在研究计划里先给出可验证的判据）'),
    block('硬约束', q.constraints, '（无）'),
    [
      '【研究方法纪律 · DeepScientist】',
      '1. 三层契约：课题根计划（全局研究地图）→ 阶段契约（本阶段目标/交付物/判据）→ 执行清单（一次只推进一项）。每轮先对齐再动手。',
      '2. 阶段门禁：调研→计划、计划→实验 之间需我（用户）明确确认方向后才可越过；门禁前只做当前阶段准备，不得擅自跳阶段执行。',
      '3. 证据优先：成文阶段每个主张必须能追溯到一条调研/实验产物；无证据的断言标注「待验证」。',
      '4. 发现记忆：对话中沉淀为「发现」的结论，之后每轮自动带上，不得遗忘或重复质疑。',
      '5. 受控自治：阶段内可连续推进，但遇门禁、证据不足或需我提供数据时主动停下并列出所需输入，不编造。',
      '',
      '推进节奏：先输出分阶段研究计划（每阶段有可验证产出），等我确认后再逐步执行；每个阶段结束给「阶段小结：做了什么 / 结论 / 下一步」；执行中要改动上述任何边界，先说明再动手。',
    ].join('\n'),
  ].join('\n\n')
}

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

/** 科研技能（布局借鉴 Codeg 的技能卡片网格）：点卡片把技能提示词装进输入框 */
const SKILL_CATS = ['构思', '实验与数据', '写作', '批判'] as const
/** 分类图标（Codeg 卡片左上角的小彩图标同款位置） */
const CAT_ICONS: Record<string, any> = { 构思: 'sparkle', 实验与数据: 'beaker', 写作: 'file', 批判: 'search' }
const SKILLS: { cat: (typeof SKILL_CATS)[number]; name: string; desc: string; prompt: string }[] = [
  { cat: '构思', name: '科学头脑风暴', desc: '围绕课题发散 10 个可检验的想法', prompt: '请围绕当前课题做一轮科学头脑风暴：给出 10 个可检验的具体想法，每个附一句「为什么值得 / 怎么证伪」，标出你最推荐的 3 个。' },
  { cat: '构思', name: '假设生成', desc: '把观察转化为可检验假设', prompt: '请把目前掌握的观察与发现转化为 3 条可检验的研究假设：每条给出自变量、因变量、预期方向与验证手段，并说明证据强度。' },
  { cat: '构思', name: '开放式科研构思', desc: '探索跨学科联系与缺口', prompt: '请从跨学科视角审视当前课题：相邻领域有哪些可借鉴的方法？当前文献里被忽视的缺口是什么？给出 2 个差异化的切入角度。' },
  { cat: '构思', name: '方法选型', desc: '对比候选方法并给出推荐', prompt: '请对比解决当前问题的主要方法路线（至少 3 种）：用表格列出原理、优缺点、算力/数据要求、在本课题条件下的可行性，最后给出推荐与理由。' },
  { cat: '实验与数据', name: '实验设计', desc: '采集数据前的严谨设计', prompt: '请为当前假设设计一个严谨的实验方案：变量与控制、随机化与重复、样本量/规模依据、评测指标与判据、可能的混淆因素及应对。' },
  { cat: '实验与数据', name: '基线核查', desc: '确保对比公平可复现', prompt: '请列出本课题必须对比的基线方法清单：每个基线给出公平比较的前提（同数据/同预算/同调参）、代表性论文与复现要点。' },
  { cat: '实验与数据', name: '统计分析', desc: '选对检验与显著性口径', prompt: '请针对我的实验数据类型推荐统计检验方法：说明前提假设、多重比较校正、效应量与置信区间的报告口径，并指出常见统计误用。' },
  { cat: '实验与数据', name: '统计功效', desc: '样本量够不够', prompt: '请做一次统计功效分析：基于预期效应量与方差，估算达到 0.8 功效所需样本量/实验次数，并说明若功效不足结论会有什么风险。' },
  { cat: '实验与数据', name: '探索性数据分析', desc: '拿到数据先看什么', prompt: '请给我一份探索性数据分析（EDA）清单：分布、离群点、缺失、相关性、分组差异各看什么图什么统计量，以及哪些信号提示数据有问题。' },
  { cat: '实验与数据', name: '科学可视化', desc: '图怎么画才有说服力', prompt: '请针对我要展示的结论设计图表方案：每张图用什么图型、坐标与编码方式、要突出什么信息、常见画法错误，并给出 caption 草稿。' },
  { cat: '写作', name: '论文骨架', desc: '从结论倒推论文结构', prompt: '请基于当前发现草拟论文骨架：标题候选、摘要（150 字版）、各节要点与字数分配、每节要回答的审稿人问题。' },
  { cat: '写作', name: '相关工作', desc: '按脉络组织而非罗列', prompt: '请帮我把相关工作按技术脉络分成 2-4 条主线组织综述段落：每条线代表工作、演进逻辑、与本工作的关系，结尾点出我们的差异化位置。' },
  { cat: '写作', name: '回复审稿人', desc: '逐条礼貌而有力地回应', prompt: '请帮我起草审稿人回复：逐条先复述对方关切，再给「感谢 + 回应 + 修改位置」三段式回复；对无法满足的要求给出体面的替代方案。' },
  { cat: '写作', name: '组会汇报', desc: '两分钟讲清进展', prompt: '请把当前进展整理成两分钟组会汇报：一句话结论开头，然后「做了什么 / 关键数字 / 下一步」，最后预判导师最可能追问的 3 个问题。' },
  { cat: '批判', name: '审稿人视角', desc: '挑三个最致命的漏洞', prompt: '请用顶会审稿人的眼光审视当前方案：找出 3 个最致命的漏洞（新颖性/严谨性/说服力各至少考虑一遍），每个给 1 条补救建议。' },
  { cat: '批判', name: '证伪演练', desc: '主动寻找推翻自己的证据', prompt: '请做一次证伪演练：如果我的结论是错的，最可能是因为什么？列出 5 个能区分「对」与「错」的判别性实验或观察。' },
  { cat: '批判', name: '过度声明检查', desc: '把话说得与证据一样大', prompt: '请检查我当前的结论表述：哪些地方声明超出证据支持（过度泛化/因果当相关/单次当普遍）？逐句给出更克制的改写。' },
]

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

const CHAT_TABS = [
  { value: 'chat' as const, label: '对话 / Quest' },
  { value: 'flow' as const, label: '工作流' },
]

/** 两个分区共用的顶栏：画布已并入对话，不再单独占一个导航项 */
function ChatTabs({
  tab,
  setTab,
}: {
  tab: 'chat' | 'flow'
  setTab: (v: 'chat' | 'flow') => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-6 py-2">
      <Segmented value={tab} onChange={setTab} options={CHAT_TABS} />
      <span className="truncate text-[11.5px] text-[color:var(--wb-muted)]">
        {tab === 'chat'
          ? '一题一 quest：填契约 → 受控推进 → 随时接管'
          : '固定框式流水线：按顺序执行，结果可逐步回看'}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- 页面
export default function Chat({ initialTab }: { initialTab?: 'chat' | 'flow' } = {}) {
  const [sessions, setSessions] = useState<any[]>([])
  const [sid, setSid] = usePersist<number | null>('chat.sid', null)
  const [detail, setDetail] = useState<any>(null)
  const [ctxOptions, setCtxOptions] = useState<{ value: string; label: string }[]>([])
  const [input, setInput] = usePersist('chat.input', '')
  const [busy, setBusy] = useState('')
  // 全站统一 fast：保留 setter 供选择器使用，档位不再随历史会话变化
  const [, setMode] = usePersist('chat.mode', 'fast')
  const mode = 'fast'
  const [ctxKeys, setCtxKeys] = usePersist<string[]>('chat.ctx', ['ideas'])
  const [questOpen, setQuestOpen] = useState(false)
  const [quest, setQuest] = usePersist<Quest>('ds.quest', EMPTY_QUEST)
  const [err, setErr] = useState('')
  const [findings, setFindings] = useState<any[]>([])
  const [showFindings, setShowFindings] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [skillCat, setSkillCat] = useState<string>('全部')
  const [skillQ, setSkillQ] = useState('')
  /** 空状态首页的分类（Codeg：默认选中「构思」） */
  const [homeCat, setHomeCat] = useState<string>('构思')
  /** 对话 / 工作流两个分区；旧 /canvas 链接通过 initialTab 直接落到工作流 */
  const [tab, setTab] = usePersist<'chat' | 'flow'>('chat.tab', 'chat')
  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab, setTab])
  const chipRef = useRef<HTMLDivElement>(null)
  const scrollChips = (dir: number) => chipRef.current?.scrollBy({ left: dir * 260, behavior: 'smooth' })
  const [autoLeft, setAutoLeft] = useState(0)
  const stopRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadSessions = async () => setSessions(await get('/chat/sessions'))

  const open = async (id: number) => {
    const d = await get(`/chat/sessions/${id}`)
    setDetail(d)
    setSid(id)
    // 全站统一 fast：不再按会话里存的历史档位切换
    get(`/chat/sessions/${id}/findings`).then(setFindings).catch(() => {})
    scrollDown()
  }

  const backHome = () => {
    setSid(null)
    setDetail(null)
  }

  const scrollDown = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 60)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      get('/chat/context/options').then((r) => setCtxOptions(r.options || []))
      const list = await get('/chat/sessions')
      if (cancelled) return
      setSessions(list || [])
      const cur = Number(localStorage.getItem('wb:chat.sid') || 0)
      if (cur && (list || []).some((s: any) => s.id === cur)) await open(cur)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Start Research：建 quest + 把 kickoff prompt 作为第一条消息发出去 */
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
      await sendKickoff(composeKickoff(quest))
      setQuest(EMPTY_QUEST)
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  /** 开题首条消息：走流式（弹窗已关，直接在 quest 里看逐字输出） */
  const sendKickoff = (text: string) => sendStream(text, false)

  /** 流式发送：乐观加一个 live 泡，SSE 逐字填充；失败撤掉 live 泡（错误文本不当成果） */
  const sendStream = async (text: string, regenerate = false) => {
    if (!sid || !text) return
    setBusy('send')
    setErr('')
    const liveId = -Date.now()
    if (detail) {
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
    abortRef.current = ac
    const appendLive = (chunk: string) =>
      setDetail((d: any) =>
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
      const res = await fetch(`/api/chat/sessions/${sid}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 注意：流式请求不能带 Idempotency-Key（幂等中间件会缓存整个响应体）
        body: JSON.stringify({ content: text, mode, regenerate }),
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
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          const ev = JSON.parse(line.slice(5))
          if (ev.type === 'delta') appendLive(ev.text)
          else if (ev.type === 'error') {
            failed = true
            setErr([ev.error.label, ev.error.message, ev.error.hint].filter(Boolean).join(' · '))
          }
        }
      }
      const d = await get(`/chat/sessions/${sid}`)
      setDetail(d)
      loadSessions()
      scrollDown()
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(String(e?.message || e))
      const d = await get(`/chat/sessions/${sid}`)
      setDetail(d)
    } finally {
      if (failed) {
        // 失败不落库，前端也不留下半截 AI 内容冒充成果
        setDetail((d: any) =>
          d ? { ...d, messages: d.messages.filter((m: any) => m.id !== liveId - 1) } : d,
        )
      }
      abortRef.current = null
      setBusy('')
    }
  }

  /** 人类接管：随时插话，AI 结合全部历史继续推进（流式） */
  const takeover = (regenerate = false) => {
    if (!sid) return
    const text = input.trim()
    if (!regenerate && !text) return
    if (!regenerate) setInput('')
    sendStream(text, regenerate)
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
    if (!sid || !detail || busy) return
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

  /** 画布成果立项后切回「对话」并打开刚建的 quest */
  const goChat = () => {
    setTab('chat')
    get('/chat/sessions')
      .then((list: any) => {
        setSessions(list || [])
        const cur = Number(localStorage.getItem('wb:chat.sid') || 0)
        if (cur && (list || []).some((s: any) => s.id === cur)) open(cur)
      })
      .catch(() => {})
  }

  if (tab === 'flow') {
    return (
      <div className="flex h-full flex-col">
        <ChatTabs tab={tab} setTab={setTab} />
        <div className="min-h-0 flex-1">
          <Canvas onGoChat={goChat} />
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------ Quest 工作区（Codeg 式：极简顶栏 + 居中问候/时间线 + 居中大输入框）
  if (sid && detail) {
    const msgs: Msg[] = detail.messages || []
    const isEmpty = msgs.length === 0
    const catSkills = SKILLS.filter((sk) => sk.cat === homeCat)
    const featured = catSkills.slice(0, 3)
    const rest = catSkills.slice(3)
    return (
      <div className="flex h-full flex-col">
        {/* 顶栏：面包屑 + 右侧轻操作 */}
        <div className="flex items-center gap-1.5 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2">
          <button
            onClick={backHome}
            className="whitespace-nowrap rounded-[7px] px-1.5 py-1 text-[12.5px] text-[color:var(--wb-muted)] transition hover:text-[color:var(--wb-accent)]"
          >
            科研工作台
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
                  disabled={state === 'cur' || busy === 'send' || autoLeft > 0}
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
                abortRef.current?.abort()
              }}
            >
              停止（剩 {autoLeft} 轮）
            </Btn>
          ) : (
            <Btn
              size="sm"
              variant="primary"
              onClick={autoDrive}
              disabled={busy === 'send'}
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

        {/* 主区：无消息 = Codeg 式居中问候 + 技能面板；有消息 = 居中时间线 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isEmpty ? (
            <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6 py-8">
              <h1 className="text-center text-[34px] font-semibold leading-[1.18] tracking-[-0.035em] text-[color:var(--wb-text)]">
                今天准备做些<span className="text-[color:var(--wb-accent)]">什么</span>呢?
              </h1>
              {/* 分类标签（胶囊组，选中高亮） */}
              <div className="mt-6 flex items-center gap-0.5 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-1 shadow-[var(--wb-shadow-xs)]">
                {SKILL_CATS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setHomeCat(c)}
                    className={`whitespace-nowrap rounded-full px-3.5 py-[6px] text-[12.5px] transition-colors duration-150 ${
                      homeCat === c
                        ? 'bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
                        : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              {/* 技能卡片：当前分类前 3 个 */}
              <div className="wb-stagger mt-4 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
                {featured.map((sk, i) => (
                  <button
                    key={sk.name}
                    style={{ '--i': i } as any}
                    onClick={() => setInput(sk.prompt)}
                    title="点击把技能提示词装进下方输入框，可再编辑"
                    className="group wb-lift rounded-[var(--wb-radius-lg)] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-4 text-left shadow-[var(--wb-shadow-xs)]"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
                      <Icon name={CAT_ICONS[sk.cat]} size={15} />
                    </span>
                    <div className="mt-2.5 text-[13px] font-semibold text-[color:var(--wb-text)] transition-colors group-hover:text-[color:var(--wb-accent)]">
                      {sk.name}
                    </div>
                    <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                      {sk.desc}
                    </div>
                  </button>
                ))}
              </div>
              {/* 其余技能：横向胶囊行（可左右滚动） */}
              {rest.length > 0 && (
                <div className="mt-3.5 flex w-full items-center gap-1">
                  <button
                    onClick={() => scrollChips(-1)}
                    aria-label="向左滚动技能"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                  >
                    <Icon name="chevronLeft" size={13} />
                  </button>
                  <div
                    ref={chipRef}
                    className="flex flex-1 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  >
                    {rest.map((sk) => (
                      <button
                        key={sk.name}
                        onClick={() => setInput(sk.prompt)}
                        title={sk.desc}
                        className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-[6px] text-[12px] text-[color:var(--wb-text-soft)] transition hover:border-[color:var(--wb-accent)] hover:text-[color:var(--wb-accent)]"
                      >
                        <Icon name={CAT_ICONS[sk.cat]} size={12} />
                        {sk.name}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => scrollChips(1)}
                    aria-label="向右滚动技能"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                  >
                    <Icon name="chevronRight" size={13} />
                  </button>
                </div>
              )}
              <div className="mt-7 text-center text-[11.5px] text-[color:var(--wb-muted)]">
                Enter 发送 · Shift+Enter 换行 —— AI 会带着课题契约与发现记忆推进
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl px-5 py-4">
            <div className="flex flex-col gap-3.5">
              {msgs.map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[86%] px-4 py-2.5 text-[13px] ${
                      m.role === 'user'
                        ? 'rounded-[16px] rounded-br-[6px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent-strong)]'
                        : 'rounded-[16px] rounded-bl-[6px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text)]'
                    }`}
                  >
                    {m.role === 'user' ? (
                      <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
                    ) : (
                      <MdBlock text={m.content} />
                    )}
                    {m.role === 'assistant' && (
                      <div className="mt-1.5 flex items-center gap-2 border-t border-[color:var(--wb-border)] pt-1.5 text-[11px] text-[color:var(--wb-muted)]">
                        {m.model && (
                          <span>
                            {m.model}
                            {m.tokens_out ? ` · ${m.tokens_out} tokens` : ''}
                            {m.created_at ? ` · ${String(m.created_at).slice(5, 16)}` : ''}
                          </span>
                        )}
                        <span className="flex-1" />
                        {m.content !== '推进中…' && m.content.trim() && (
                          <>
                            <Btn
                              size="xs"
                              variant="ghost"
                              onClick={() => addFinding(m.content, m.id)}
                              title="把这条结论存进发现记忆，之后每轮对话自动带上"
                            >
                              <Icon name="star" size={11} />
                              沉淀为发现
                            </Btn>
                            <Btn
                              size="xs"
                              variant="ghost"
                              onClick={() => navigator.clipboard?.writeText(m.content)}
                              title="复制全文"
                            >
                              复制
                            </Btn>
                            <Btn
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                setInput(`> ${m.content.replace(/\s+/g, ' ').slice(0, 160)}\n\n`)
                              }
                              title="引用这条产出，在输入框里追问"
                            >
                              引用
                            </Btn>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} className="h-1" />
            </div>
            </div>
          )}
        </div>

        {/* 人类接管：Codeg 式居中大输入框（+ 打开技能面板，右侧圆形发送） */}
        <div className="px-4 pb-4 pt-1">
          {err && <div className="mx-auto mb-2 max-w-3xl">{ErrBar}</div>}
          {/* 科研技能面板（Codeg 同款：搜索 + 分类 + 卡片网格，点卡片装提示词） */}
          {showSkills && (
            <div className="mx-auto mb-2.5 max-w-3xl rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-2.5 shadow-[var(--wb-shadow-sm)]">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <SearchInput value={skillQ} onChange={setSkillQ} className="w-52" placeholder="搜技能…" />
                <div className="flex flex-wrap gap-1">
                  {['全部', ...SKILL_CATS].map((c) => (
                    <button
                      key={c}
                      onClick={() => setSkillCat(c)}
                      className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] transition ${
                        skillCat === c
                          ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] font-medium text-[color:var(--wb-accent)]'
                          : 'border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] text-[color:var(--wb-text-soft)] hover:border-[color:var(--wb-border-strong)]'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <span className="flex-1" />
                <IconBtn
                  icon="close"
                  size="sm"
                  ariaLabel="收起技能面板"
                  onClick={() => setShowSkills(false)}
                />
              </div>
              <div className="grid max-h-[38vh] gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
                {SKILLS.filter(
                  (sk) =>
                    (skillCat === '全部' || sk.cat === skillCat) &&
                    (!skillQ.trim() ||
                      (sk.name + sk.desc + sk.prompt).toLowerCase().includes(skillQ.trim().toLowerCase())),
                ).map((sk) => (
                  <button
                    key={sk.name}
                    onClick={() => {
                      setInput(sk.prompt)
                      setShowSkills(false)
                    }}
                    className="group rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-2.5 text-left transition hover:border-[color:var(--wb-accent)] hover:shadow-[var(--wb-shadow-sm)]"
                    title="点击把技能提示词装进下方输入框，可再编辑"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-medium text-[color:var(--wb-text)] transition group-hover:text-[color:var(--wb-accent)]">
                        {sk.name}
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
                        {sk.cat}
                      </span>
                    </div>
                    <div className="mt-0.5 line-clamp-1 text-[11.5px] text-[color:var(--wb-muted)]">{sk.desc}</div>
                  </button>
                ))}
                {SKILLS.filter(
                  (sk) =>
                    (skillCat === '全部' || sk.cat === skillCat) &&
                    (!skillQ.trim() ||
                      (sk.name + sk.desc + sk.prompt).toLowerCase().includes(skillQ.trim().toLowerCase())),
                ).length === 0 && (
                  <div className="col-span-full py-4 text-center text-[12px] text-[color:var(--wb-muted)]">
                    没有匹配的技能
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="mx-auto max-w-3xl rounded-[20px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-md)] transition-[border-color,box-shadow] duration-150 focus-within:border-[color:var(--wb-accent)]/60 focus-within:shadow-[0_1px_3px_rgba(16,17,20,0.05),0_12px_32px_-16px_rgba(81,69,224,0.35)]" data-tour="tour-chat-composer">
            <textarea
              rows={3}
              placeholder="发送消息…"
              value={input}
              onChange={(e: any) => setInput(e.target.value)}
              onKeyDown={(e: any) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  takeover(false)
                }
              }}
              className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[13.5px] leading-relaxed text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
            />
            <div className="flex items-center gap-1 px-3 pb-2.5 pt-1">
              <button
                onClick={() => setShowSkills(!showSkills)}
                title="科研技能面板"
                className={`flex h-8 w-8 items-center justify-center rounded-full border transition ${
                  showSkills
                    ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                    : 'border-[color:var(--wb-border)] text-[color:var(--wb-muted)] hover:border-[color:var(--wb-border-strong)] hover:text-[color:var(--wb-text)]'
                }`}
              >
                <Icon name="plus" size={15} />
              </button>
              <button
                onClick={() => takeover(true)}
                disabled={busy === 'send' || msgs.length === 0}
                title="重跑上一阶段（用上一条提问重新生成）"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--wb-border)] text-[color:var(--wb-muted)] transition hover:border-[color:var(--wb-border-strong)] hover:text-[color:var(--wb-text)] disabled:opacity-40"
              >
                <Icon name="refresh" size={14} />
              </button>
              <span className="flex-1" />
              <span className="whitespace-nowrap text-[11px] text-[color:var(--wb-muted)]">
                Balanced
              </span>
              {busy === 'send' ? (
                <button
                  onClick={() => abortRef.current?.abort()}
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
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------ 启动面
  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10">
        <ChatTabs tab={tab} setTab={setTab} />
      </div>
      <div className="mx-auto w-full max-w-[1240px] px-6 py-8 md:px-10 md:py-10">
        {/* Hero：研究工作区启动面 */}
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-5">
            <div className="inline-flex items-center gap-2 rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-1 text-[10.5px] font-medium uppercase tracking-[0.22em] text-[color:var(--wb-muted)]">
              自动化科研
            </div>
            <h1 className="text-[28px] font-semibold leading-[1.3] text-[color:var(--wb-text)] md:text-[34px]">
              由自治 AI 科研智能体驱动的课题工作区
            </h1>
            <div className="text-[11.5px] font-medium uppercase tracking-[0.26em] text-[color:var(--wb-accent)]">
              调研 · 实验 · 发表
            </div>
            <p className="max-w-xl text-[13px] leading-relaxed text-[color:var(--wb-text-soft)]">
              一题一 quest：开题时把「目标 / Baseline / 成功标准 / 硬约束」一次说清，AI 按受控节奏推进，
              每一步可回看，人类随时接管。
            </p>
            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <Btn variant="primary" className="!h-11 !px-6 !text-[13.5px]" onClick={() => setQuestOpen(true)}>
                <Icon name="sparkle" size={15} />
                Start Research · 开新课题
              </Btn>
              <Btn className="!h-11" onClick={() => setQuestOpen(true)}>
                <Icon name="file" size={14} />
                打开 Quest
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
              <Btn onClick={() => setQuestOpen(true)}>
                <Icon name="plus" size={13} />
                新课题
              </Btn>
            }
          >
            {sessions.length === 0 ? (
              <Empty
                text="还没有 quest"
                hint="点「Start Research」开第一个课题：填契约 → 检查 kickoff prompt → 启动"
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
    </div>
  )
}
