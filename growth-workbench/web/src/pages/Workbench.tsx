/**
 * 统一工作台（/）：WorkBuddy 式启动面 —— 问候 + 模式切换（对话 / 调研 / 实验）+ 大输入框。
 *
 * 三种模式的去向（后端一律不动，只换入口）：
 *   - 对话 / 调研 → 建 rchat 会话，通过 sessionStorage「launch 信封」带第一句话
 *     跳到 /research 的对话壳里自动开跑（含能力 chip 与技能 refs）；
 *   - 实验 → 一句话创建实验实体，落 wb:exp.sel 后进入 /experiments 的 Agent 对话。
 *
 * 设计口径：居中问候 + 大输入框，输入框底部是 WorkBuddy 式工具条——
 * 左：+（挂技能）· 模式下拉（对话/调研/实验）· 能力下拉（调研模式），
 * 右：圆形上箭头发送键。素底，不铺背景图；配色全部走 --wb-* 令牌。
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconBtn, TextArea } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'
import { get, post } from '../lib/api'
import { useIdemKey } from '../lib/hooks'
import { usePersist } from '../lib/state'
import { displayNameOf, useAuth } from '../lib/auth'
import { relTime } from '../lib/time'
import SkillPicker, { type SkillGroup, type SkillOption } from '../features/skills/SkillPicker'
import { RESEARCH_SKILLS } from '../features/skills/presets'
import { STUDIO_ROLES } from '../features/studio/roles'
import TaskStrip from '../features/studio/TaskStrip'
import { toast } from '../components/toast'

type Mode = 'chat' | 'research' | 'exp'

/** 调研模式的能力 chip：与 /research 的三个真实后端模式一一对应 */
const RESEARCH_CHIPS = [
  { icon: 'search', label: '深度检索', tag: '深度检索' },
  { icon: 'file', label: '撰写报告', tag: '报告撰写' },
  { icon: 'book', label: '文献检索', tag: '文献检索' },
] as const

/** 调研能力下拉第一项：不挂任何能力，走普通对话链路 */
const CAP_AUTO = { icon: 'message', label: '自动', tag: null } as const

const MODES: { value: Mode; icon: IconName; label: string; hint: string }[] = [
  { value: 'chat', icon: 'message', label: '对话', hint: '问答、讨论、随便聊' },
  { value: 'research', icon: 'search', label: '调研', hint: '深度检索 → 自动入库 → 带引用报告' },
  { value: 'exp', icon: 'beaker', label: '实验', hint: '一句话建实验，进入 Agent 对话' },
]

function greet(): string {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

type SessionRow = { id: number; title: string; updated_at: string; msg_count?: number }
type ExpRow = { id: number; name: string; status: string; updated_at?: string }

export default function Workbench() {
  const nav = useNavigate()
  const { user } = useAuth()
  const name = displayNameOf(user)
  const idem = useIdemKey()

  const [mode, setMode] = usePersist<Mode>('home.mode', 'chat')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 调研模式挂的能力 chip（最多一个，同 /research 口径）；对话模式不挂
  const [capTag, setCapTag] = useState<string | null>(null)
  // 底栏下拉：'mode' = 模式选择，'cap' = 调研能力选择
  const [menu, setMenu] = useState<null | 'mode' | 'cap'>(null)
  // 技能：三种模式里对话 / 调研可挂（实验创建用不上）
  const [mounted, setMounted] = useState<SkillOption[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')
  const [localSkills, setLocalSkills] = useState<{ id: string; name: string; desc: string; path: string }[]>([])
  const [ghSkills, setGhSkills] = useState<{ id: string; name: string; desc: string; category: string }[]>([])
  // 继续入口：最近对话 + 最近实验（实验模式时也当「选已有实验」列表用）
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [exps, setExps] = useState<ExpRow[]>([])

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
      try {
        const r = await get<any>('/rchat/sessions')
        setSessions((r.sessions || []).slice(0, 6))
      } catch {
        setSessions([])
      }
    })()
  }, [])

  // 实验列表：切到实验模式才拉（含「选已有实验」与防重名提示）
  useEffect(() => {
    if (mode !== 'exp') return
    ;(async () => {
      try {
        const list = await get<any>('/experiments')
        setExps(list || [])
      } catch {
        setExps([])
      }
    })()
  }, [mode])

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

  const addSkill = (o: SkillOption) => {
    setMounted((prev) => (prev.some((x) => x.key === o.key) ? prev : [...prev, o]))
    setPickerOpen(false)
    setPickerQ('')
  }

  /** 对话 / 调研：建 rchat 会话 → launch 信封 → /research 对话壳自动开跑 */
  const sendRchat = async (text: string) => {
    const s = await post('/rchat/sessions', { title: text.slice(0, 30) }, { ok: false })
    const skills = mounted.map((o) => ({
      id: o.id || null, name: o.name, desc: o.desc, group: o.group, path: o.path || '', text: o.text || '',
      key: o.key,
    }))
    sessionStorage.setItem(
      'wb:rchat.launch',
      JSON.stringify({ text, tag: mode === 'research' ? capTag : undefined, skills }),
    )
    localStorage.setItem('wb:rchat.sid', String(s.id))
    nav('/research')
  }

  /** 实验：一句话建实验实体 → 选中 → 进 Agent 对话 */
  const sendExperiment = async (text: string) => {
    const dup = exps.find((e) => e.name === text.slice(0, 60))
    if (dup) {
      toast(`已有同名实验「${dup.name}」，正在打开`, 'ok')
      localStorage.setItem('wb:exp.sel', String(dup.id))
      localStorage.setItem('wb:exp.tab', JSON.stringify('agent'))
      nav('/experiments')
      return
    }
    const r = await post(
      '/experiments',
      { name: text.slice(0, 60), hypothesis: text, design: '', idea_id: null, status: 'planned' },
      { idem: idem.key, ok: false },
    )
    idem.reset()
    localStorage.setItem('wb:exp.sel', String(r.id))
    localStorage.setItem('wb:exp.tab', JSON.stringify('agent'))
    toast('实验已创建，进入 Agent 对话', 'ok')
    nav('/experiments')
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      if (mode === 'exp') await sendExperiment(text)
      else await sendRchat(text)
    } catch (e: any) {
      toast(e?.message || '启动失败，请重试', 'error')
      setBusy(false)
      return
    }
    // 成功即走，不复位 busy（组件随路由卸载）
  }

  const openSession = (s: SessionRow) => {
    localStorage.setItem('wb:rchat.sid', String(s.id))
    nav('/research')
  }

  const openExp = (e: ExpRow) => {
    localStorage.setItem('wb:exp.sel', String(e.id))
    localStorage.setItem('wb:exp.tab', JSON.stringify('agent'))
    nav('/experiments')
  }

  const placeholder =
    mode === 'chat'
      ? '想聊什么？直接输入，回车开始对话'
      : mode === 'research'
        ? '研究问题或主题，回车开始调研'
        : '要验证什么？一句话描述实验想法，回车创建实验'

  const curMode = MODES.find((m) => m.value === mode)!

  /** 底栏下拉 chip 的统一外观（对标 WorkBuddy 输入框底部的浅色小胶囊） */
  const chipCls =
    'flex items-center gap-1.5 rounded-full border border-[color:var(--wb-border)] px-2.5 py-1.5 text-[12px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col px-6 pb-10 pt-[9vh]">
        {/* 问候 + 模式胶囊 */}
        <h1 className="text-center text-[30px] font-semibold leading-[1.2] tracking-[-0.03em] text-[color:var(--wb-text)]">
          {greet()}，{name || '研究者'}
        </h1>
        <p className="mt-2.5 text-center text-[12.5px] leading-relaxed text-[color:var(--wb-muted)]">
          {curMode.hint} · 论文调研到实验执行，从这里一句话开始
        </p>

        {/* 大输入框（模式/能力选择都在底栏工具条里） */}
        <div className="mt-6">
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
          <div
            data-tour="tour-wb-composer"
            className="rounded-[18px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-md)] transition-[border-color,box-shadow]"
          >
            {mounted.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-3">
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
                      aria-label={`移除技能 ${o.name}`}
                      className="ml-0.5 rounded-full transition hover:opacity-70"
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              autoFocus
              rows={3}
              value={input}
              onChange={(e) => {
                const v = e.target.value
                setInput(v)
                const at = v.match(/(?:^|\s)@([\w-]*)$/)
                if (at) setPickerOpen(true)
                else if (pickerOpen) setPickerOpen(false)
              }}
              onKeyDown={(e) => {
                if (pickerOpen) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={placeholder}
              className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[13.5px] leading-relaxed text-[color:var(--wb-text)] outline-none placeholder:text-[color:var(--wb-muted)]"
            />
            <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
              {mode !== 'exp' && (
                <IconBtn
                  icon="plus"
                  size="md"
                  ariaLabel="添加技能"
                  title="添加技能（也可直接输入 @）"
                  onClick={() => {
                    setPickerQ('')
                    setPickerOpen(true)
                  }}
                />
              )}
              {/* 模式下拉 chip（对话 / 调研 / 实验） */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenu(menu === 'mode' ? null : 'mode')}
                  title={curMode.hint}
                  className={chipCls}
                >
                  <Icon name={curMode.icon} size={13} className="text-[color:var(--wb-accent)]" />
                  {curMode.label}
                  <Icon name="chevronDown" size={12} className="opacity-50" />
                </button>
                {menu === 'mode' && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
                    <div className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-60 rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] py-1 shadow-[var(--wb-shadow-md)]">
                      {MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => {
                            setMode(m.value)
                            setCapTag(null)
                            setMenu(null)
                          }}
                          className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
                        >
                          <Icon name={m.icon} size={14} className="mt-0.5 shrink-0 text-[color:var(--wb-muted)]" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12.5px] font-medium text-[color:var(--wb-text)]">{m.label}</span>
                            <span className="block text-[11px] leading-snug text-[color:var(--wb-muted)]">{m.hint}</span>
                          </span>
                          {mode === m.value && (
                            <Icon name="check" size={13} className="mt-0.5 shrink-0 text-[color:var(--wb-accent)]" />
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* 能力下拉 chip（仅调研模式）：自动 / 深度检索 / 撰写报告 / 文献检索 */}
              {mode === 'research' && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenu(menu === 'cap' ? null : 'cap')}
                    title="本轮调研能力"
                    className={chipCls}
                  >
                    <Icon
                      name={(capTag ? RESEARCH_CHIPS.find((c) => c.tag === capTag)?.icon : CAP_AUTO.icon) as IconName}
                      size={13}
                      className="text-[color:var(--wb-accent)]"
                    />
                    {capTag ?? CAP_AUTO.label}
                    <Icon name="chevronDown" size={12} className="opacity-50" />
                  </button>
                  {menu === 'cap' && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
                      <div className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-44 rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] py-1 shadow-[var(--wb-shadow-md)]">
                        {[CAP_AUTO, ...RESEARCH_CHIPS].map((c) => (
                          <button
                            key={c.label}
                            type="button"
                            onClick={() => {
                              setCapTag(c.tag)
                              setMenu(null)
                            }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[color:var(--wb-bg-subtle)]"
                          >
                            <Icon name={c.icon as IconName} size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
                            <span className="min-w-0 flex-1 text-[12.5px] text-[color:var(--wb-text)]">{c.label}</span>
                            {(c.tag ?? null) === capTag && (
                              <Icon name="check" size={13} className="shrink-0 text-[color:var(--wb-accent)]" />
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <span className="pl-1.5 text-[11px] text-[color:var(--wb-muted)]">
                {mode === 'exp' ? '回车 = 创建实验' : 'Enter 发送'}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={send}
                disabled={!input.trim() || busy}
                aria-label="开始"
                title="开始（Enter）"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--wb-accent)] text-white shadow-[var(--wb-shadow-xs)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-white/40 border-t-white" />
                ) : (
                  <Icon name="arrowUp" size={16} />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* 角色带：8 个能力入口。不是 8 个自治 agent，只把「想做什么」映射到已有模块 */}
        <div className="mt-8">
          <div className="mb-2 flex items-center justify-between px-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
              能力入口
            </span>
            <span className="text-[10.5px] text-[color:var(--wb-muted)]">按你要做的事选一个</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {STUDIO_ROLES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => nav(r.to)}
                title={r.hint}
                className="group flex items-start gap-2.5 rounded-[11px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-2.5 text-left transition hover:border-[color:var(--wb-border-strong)] hover:bg-[color:var(--wb-surface-alt)]"
              >
                <Icon
                  name={r.icon}
                  size={15}
                  className="mt-0.5 shrink-0 text-[color:var(--wb-muted)] transition group-hover:text-[color:var(--wb-accent)]"
                />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">
                    {r.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] leading-snug text-[color:var(--wb-muted)]">
                    {r.hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 继续入口：最近对话 + 最近实验 */}
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between px-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
                最近对话
              </span>
              <button
                onClick={() => nav('/research')}
                className="flex items-center gap-0.5 text-[11px] text-[color:var(--wb-muted)] transition hover:text-[color:var(--wb-accent)]"
              >
                全部
                <Icon name="arrowRight" size={11} />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {sessions.length === 0 && (
                <p className="px-0.5 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                  还没有对话。在上面输入一句话开始。
                </p>
              )}
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => openSession(s)}
                  className="flex items-center gap-2 rounded-[10px] border border-transparent px-2 py-2 text-left transition hover:border-[color:var(--wb-border)] hover:bg-[color:var(--wb-surface)]"
                >
                  <Icon name="message" size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[color:var(--wb-text-soft)]">
                    {s.title || '新对话'}
                  </span>
                  <span className="shrink-0 text-[10px] text-[color:var(--wb-muted)]">{relTime(s.updated_at)}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between px-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
                最近实验
              </span>
              <button
                onClick={() => nav('/experiments')}
                className="flex items-center gap-0.5 text-[11px] text-[color:var(--wb-muted)] transition hover:text-[color:var(--wb-accent)]"
              >
                全部
                <Icon name="arrowRight" size={11} />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {exps.length === 0 && (
                <p className="px-0.5 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                  {mode === 'exp' ? '在上面输入一句话创建实验。' : '切到「实验」模式，一句话开一个新实验。'}
                </p>
              )}
              {exps.slice(0, 6).map((e) => (
                <button
                  key={e.id}
                  onClick={() => openExp(e)}
                  className="flex items-center gap-2 rounded-[10px] border border-transparent px-2 py-2 text-left transition hover:border-[color:var(--wb-border)] hover:bg-[color:var(--wb-surface)]"
                >
                  <Icon name="beaker" size={13} className="shrink-0 text-[color:var(--wb-muted)]" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[color:var(--wb-text-soft)]">
                    {e.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-[color:var(--wb-muted)]">
                    {e.status === 'done'
                      ? '已完成'
                      : e.status === 'running'
                        ? '进行中'
                        : e.status === 'analyzing'
                          ? '分析中'
                          : '待跑'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 全局任务带：底部运行任务卡，数字全部来自真实运行留痕 */}
        <div className="mt-8">
          <TaskStrip />
        </div>
      </div>
    </div>
  )
}
