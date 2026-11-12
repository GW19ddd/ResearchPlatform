import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import { Btn, IconBtn } from '../../components/ui'
import { post } from '../../lib/api'
import type { PaperHit } from '../../lib/rchatStream'

/**
 * 共识栏（对标 Consensus 的 References 面板：Paper / Answer / Popularity 三列）。
 *
 * 两种判定严格分开，不混为一谈：
 * - 「我的投票」：用户逐篇点支持 / 中立 / 反对，只存在本机 localStorage，按会话隔离；
 * - 「Agent 判定」：调 /rchat/consensus，LLM 只依据真实标题 + OpenAlex 摘要给立场与依据，
 *   界面上明写「模型推断 · 非原文结论」；摘要缺失时后端返回 unknown，前端不替它猜。
 * 被引数 / 年份 / 期刊是 OpenAlex 原样字段，不参与投票计算。
 */

type Vote = 'support' | 'neutral' | 'oppose'
type Stance = Vote | 'unknown'
type AgentItem = { n: number; stance: Stance; reason: string }

const STANCE_LABEL: Record<Stance, string> = {
  support: '支持',
  neutral: '中立',
  oppose: '反对',
  unknown: '未判定',
}
const VOTE_ICON: Record<Vote, IconName> = {
  support: 'check',
  neutral: 'minus',
  oppose: 'close',
}
const VOTES: Vote[] = ['support', 'neutral', 'oppose']
const COLS = 'minmax(0,1.05fr) minmax(0,1.25fr) 74px'

const voteKey = (p: PaperHit) => `${p.n}:${p.openalex_id || p.lit_id || p.title || ''}`

export default function ConsensusPane({
  sid,
  question,
  papers,
  width,
  onClose,
  onOpenPaper,
  full = false,
}: {
  sid: number | null
  question: string
  papers: PaperHit[]
  width: number
  onClose?: () => void
  onOpenPaper?: (p: PaperHit) => void
  /** full=true：作为 /consensus 独立页占满内容区（无固定宽度、无关闭按钮、去掉左侧描边） */
  full?: boolean
}) {
  const storeKey = `wb:rchat.votes.${sid ?? 'none'}`
  const [votes, setVotes] = useState<Record<string, Vote>>({})
  const [agent, setAgent] = useState<AgentItem[]>([])
  const [agentNote, setAgentNote] = useState('')
  const [agentBusy, setAgentBusy] = useState(false)
  const [agentErr, setAgentErr] = useState('')

  // 切会话时换一份投票：不同会话的判定不串台
  useEffect(() => {
    try {
      setVotes(JSON.parse(localStorage.getItem(storeKey) || '{}') || {})
    } catch {
      setVotes({})
    }
    setAgent([])
    setAgentNote('')
    setAgentErr('')
  }, [storeKey])

  const setVote = (p: PaperHit, v: Vote) => {
    const k = voteKey(p)
    const next = { ...votes }
    if (next[k] === v) delete next[k] // 再点一次取消
    else next[k] = v
    setVotes(next)
    try {
      localStorage.setItem(storeKey, JSON.stringify(next))
    } catch {
      /* 隐私模式下写不进去也不影响本次会话内的展示 */
    }
  }

  const counts: Record<Vote, number> = { support: 0, neutral: 0, oppose: 0 }
  for (const p of papers) {
    const v = votes[voteKey(p)]
    if (v) counts[v] += 1
  }
  const voted = counts.support + counts.neutral + counts.oppose
  const agentMap = new Map(agent.map((a) => [a.n, a]))

  const runAgent = async () => {
    if (!question.trim() || !papers.length || agentBusy) return
    setAgentBusy(true)
    setAgentErr('')
    setAgent([])
    try {
      const r = await post<any>(
        '/rchat/consensus',
        {
          question: question.trim(),
          papers: papers.map((p) => ({
            n: p.n, title: p.title, year: p.year, abstract: p.abstract || '',
          })),
        },
        { silent: true },
      )
      setAgent(r.items || [])
      setAgentNote(r.note || '')
    } catch (e: any) {
      setAgentErr(e?.message || 'Agent 判定失败，稍后再试')
    } finally {
      setAgentBusy(false)
    }
  }

  return (
    <aside
      data-resizable={!full}
      className={`flex min-h-0 shrink-0 flex-col ${full ? 'min-w-0 flex-1' : 'border-l border-[color:var(--wb-border)]'} bg-[color:var(--wb-surface-alt)]`}
      style={full ? undefined : { width, minWidth: 280, maxWidth: 'calc(100vw - 700px)' }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-3.5 py-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
          <Icon name="layers" size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">共识</span>
        <span className="shrink-0 whitespace-nowrap rounded-[3px] bg-[color:var(--wb-accent-soft)] px-1.5 py-[1px] text-[10px] text-[color:var(--wb-accent-strong)]">
          {papers.length} 篇
        </span>
        <Btn
          size="xs"
          variant="subtle"
          onClick={runAgent}
          disabled={!papers.length || !question.trim() || agentBusy}
          title="让 Agent 依据标题与摘要逐篇给立场（模型推断，需人工复核）"
        >
          <Icon name="sparkle" size={11} />
          {agentBusy ? '判定中…' : 'Agent 判定'}
        </Btn>
        {!full && (
          <IconBtn icon="close" size="sm" ariaLabel="关闭共识栏" title="关闭共识" onClick={onClose} />
        )}
      </div>
      <div className="shrink-0 px-4 pt-3 text-[11px] text-[color:var(--wb-muted)]">
        基于本次真实检索 · 人工投票与模型推断分开标注
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2.5">
        <div className="px-4 py-3">
          {/* 研究问题 */}
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--wb-muted)]">
            研究问题
          </div>
          <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-[color:var(--wb-text)]">
            {question.trim() || '先发一个研究问题，再运行文献检索。'}
          </p>

          {/* 共识条：只统计人工投票，且只对当前这批文献 */}
          <div className="mt-3 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-2.5">
            <div className="flex items-center justify-between text-[10.5px] text-[color:var(--wb-text-soft)]">
              <span>我的投票</span>
              <span className="text-[color:var(--wb-muted)]">
                {voted ? `已投 ${voted} / ${papers.length} 篇` : '还没有投票'}
              </span>
            </div>
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-[color:var(--wb-border)]">
              {voted > 0 &&
                VOTES.map((v) =>
                  counts[v] ? (
                    <div
                      key={v}
                      style={{ width: `${(counts[v] / voted) * 100}%` }}
                      className={
                        v === 'support'
                          ? 'bg-[color:var(--wb-accent)]'
                          : v === 'neutral'
                            ? 'bg-[color:var(--wb-muted)]'
                            : 'bg-[color:var(--wb-danger)]'
                      }
                    />
                  ) : null,
                )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[color:var(--wb-muted)]">
              {VOTES.map((v) => (
                <span key={v}>
                  {STANCE_LABEL[v]} {counts[v]}
                </span>
              ))}
              <span>· 仅存本机，不是文献结论</span>
            </div>
          </div>

          {agentNote && (
            <div className="mt-2 rounded-[8px] border border-dashed border-[color:var(--wb-border)] px-2.5 py-2 text-[10.5px] leading-relaxed text-[color:var(--wb-muted)]">
              {agentNote}
            </div>
          )}
          {agentErr && (
            <div className="mt-2 rounded-[8px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-2.5 py-2 text-[10.5px] text-[color:var(--wb-danger)]">
              {agentErr}
            </div>
          )}

          {/* Paper / Answer / 投票 —— 对齐 Consensus 的三列表格 */}
          <div
            className="mt-3 grid gap-x-2 border-b border-[color:var(--wb-border)] pb-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--wb-muted)]"
            style={{ gridTemplateColumns: COLS }}
          >
            <span>Paper</span><span>Answer</span><span className="text-right">投票</span>
          </div>

          {!papers.length ? (
            <div className="py-6 text-center text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
              还没有检索结果。点「深度检索」或「文献检索」，命中会出现在这里。
            </div>
          ) : (
            papers.map((p) => {
              const my = votes[voteKey(p)]
              const a = agentMap.get(p.n)
              return (
                <div
                  key={`${p.n}-${p.openalex_id || p.lit_id || ''}`}
                  className="grid gap-x-2 border-b border-[color:var(--wb-border)]/60 py-2.5 text-[10.5px] last:border-0"
                  style={{ gridTemplateColumns: COLS }}
                >
                  <div className="min-w-0">
                    {onOpenPaper ? (
                      <button
                        type="button"
                        onClick={() => onOpenPaper(p)}
                        title="查看这篇文献的对应内容"
                        className="block w-full truncate text-left font-medium leading-snug text-[color:var(--wb-text)] hover:text-[color:var(--wb-accent)] hover:underline"
                      >
                        [{p.n}] {p.title || '（无标题）'}
                      </button>
                    ) : (
                      <span className="block truncate font-medium leading-snug text-[color:var(--wb-text)]">
                        [{p.n}] {p.title || '（无标题）'}
                      </span>
                    )}
                    <div className="mt-0.5 truncate text-[9.5px] text-[color:var(--wb-muted)]">
                      {[p.year, p.venue].filter(Boolean).join(' · ')}
                      {p.cited_by_count != null ? ` · 被引 ${p.cited_by_count}` : ''}
                    </div>
                  </div>

                  <div className="min-w-0">
                    {a ? (
                      <>
                        <div className="mb-0.5 flex items-center gap-1.5">
                          <span className="rounded-[3px] bg-[color:var(--wb-accent-soft)] px-1.5 py-[1px] text-[9.5px] font-medium text-[color:var(--wb-accent-strong)]">
                            {STANCE_LABEL[a.stance]}
                          </span>
                          <span className="text-[9px] text-[color:var(--wb-muted)]">模型推断</span>
                        </div>
                        <p className="text-[10px] leading-relaxed text-[color:var(--wb-text-soft)]">
                          {a.reason || '（未给依据）'}
                        </p>
                      </>
                    ) : (
                      <span className="text-[10px] text-[color:var(--wb-muted)]">
                        {agentBusy ? '判定中…' : '未运行 Agent 判定'}
                      </span>
                    )}
                    {my && (
                      <p className="mt-1 text-[9.5px] text-[color:var(--wb-accent-strong)]">
                        我的投票：{STANCE_LABEL[my]}
                      </p>
                    )}
                  </div>

                  <div className="flex items-start justify-end gap-0.5">
                    {VOTES.map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setVote(p, v)}
                        title={`投「${STANCE_LABEL[v]}」${my === v ? '（再点取消）' : ''}`}
                        aria-label={`投${STANCE_LABEL[v]}票`}
                        className={`flex h-5 w-5 items-center justify-center rounded-[5px] border transition ${
                          my === v
                            ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent-strong)]'
                            : 'border-[color:var(--wb-border)] text-[color:var(--wb-muted)] hover:border-[color:var(--wb-accent)]/50 hover:text-[color:var(--wb-accent)]'
                        }`}
                      >
                        <Icon name={VOTE_ICON[v]} size={10} />
                      </button>
                    ))}
                  </div>
                </div>
              )
            })
          )}

          <div className="mt-3 border-t border-[color:var(--wb-border)] pt-2 text-[10px] leading-relaxed text-[color:var(--wb-muted)]">
            投票仅保存在本机浏览器（按会话隔离），不上传、不落库；「模型推断」是 Agent
            依据标题 / OpenAlex 摘要给出的立场，不是文献原文结论，需人工复核。
            年份 / 期刊 / 被引取自 OpenAlex 原样字段。
          </div>
        </div>
      </div>
    </aside>
  )
}
