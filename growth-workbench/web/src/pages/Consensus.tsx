import { useEffect, useRef, useState } from 'react'
import { Btn, Empty, Input, Loading, PageHeader, Pill } from '../components/ui'
import { Icon } from '../components/Icon'
import { post } from '../lib/api'

/**
 * 共识独立页（/consensus）：接 Consensus.app 做真实学术共识检索。
 *
 * - 搜索框输入研究问题 → POST /api/consensus/search（后端持 key 代理，明文不落前端）；
 * - 检索成功后异步调 POST /api/consensus/summarize：LLM 逐篇判立场，
 *   先出「共识度总结」卡（支持/部分支持/反对的百分比分段条 + 一句话总结），
 *   论文不再整列铺开，只在卡下出一排小序号（按立场着色），点序号才展开该篇详情；
 *   总结失败静默降级，序号仍可点开看论文；
 * - 「在 consensus.app 打开」按钮构建官方检索 URL，可在自己账号里看完整结果；
 * - 上次检索结果（问题 + 论文 + 共识度总结 + 展开的序号）存 localStorage，刷新/切走再回来直接还原，
 *   不重复打 Consensus（有月度额度，重查要计费）；只有主动重新检索才覆盖；
 * - Consensus 强制鉴权（2026-11 起）：无 key 一律 401，页面会提示去设置填 key。
 */
type CnsPaper = {
  title: string
  authors: string
  year: number | null
  journal_name: string
  doi: string
  url: string
  citation_count: number
  study_type: string
  sample_size: number | null
  takeaway: string
  abstract: string
  source: string
}

type Stance = 'support' | 'mixed' | 'oppose' | 'unclear'

type SumOut = {
  ok: boolean
  stances: Stance[]
  counts: Record<Stance, number>
  percents: Record<Stance, number>
  total: number
  summary: string
  model: string
}

const STANCE_LABEL: Record<Stance, { text: string; tone: string }> = {
  support: { text: '支持', tone: 'green' },
  oppose: { text: '反对', tone: 'red' },
  mixed: { text: '部分支持', tone: 'amber' },
  unclear: { text: '不确定', tone: 'gray' },
}

/** 小序号底色：和总结卡的图例颜色对得上，扫一眼就知道哪几篇在反对。 */
const STANCE_CHIP: Record<Stance, { bg: string; fg: string }> = {
  support: { bg: 'var(--wb-ok-soft)', fg: 'var(--wb-ok)' },
  oppose: { bg: 'var(--wb-danger-soft)', fg: 'var(--wb-danger)' },
  mixed: { bg: 'var(--wb-warn-soft)', fg: 'var(--wb-warn)' },
  unclear: { bg: 'var(--wb-bg-subtle)', fg: 'var(--wb-muted)' },
}

// 上次检索结果留在页面：刷新 / 切走再回来直接还原，不重复请求（Consensus 有月度额度，重查要计费）
const LS_KEY = 'wb:consensus.last'

type Snapshot = {
  q: string
  asked: string
  rows: CnsPaper[]
  sum: SumOut | null
  meta: { truncated?: boolean; has_key?: boolean; page?: number; is_end?: boolean }
  openId: number | null
  at: number
}

function readSnap(): Snapshot | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Snapshot
    if (!s || !Array.isArray(s.rows) || !s.asked) return null
    return s
  } catch {
    return null
  }
}

function fmtAt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function Consensus() {
  const [boot] = useState<Snapshot | null>(() => readSnap())
  const [q, setQ] = useState(boot?.q || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [rows, setRows] = useState<CnsPaper[]>(boot?.rows || [])
  const [meta, setMeta] = useState<{ truncated?: boolean; has_key?: boolean; page?: number; is_end?: boolean }>(
    boot?.meta || {},
  )
  const [asked, setAsked] = useState(boot?.asked || '')
  const [searched, setSearched] = useState(!!boot)
  const [sum, setSum] = useState<SumOut | null>(boot?.sum || null)
  const [sumBusy, setSumBusy] = useState(false)
  const [openId, setOpenId] = useState<number | null>(boot?.openId ?? null)
  const [restored, setRestored] = useState(!!boot)
  const sumFail = useRef(false)
  const runId = useRef(0)
  // 快照时间戳：还原时保持原值，只有真的重新检索才更新（否则每次挂载都会把「上次检索」刷成现在）
  const snapAt = useRef(boot?.at || 0)

  // 结果一有变化就落盘，下次进来直接还原
  useEffect(() => {
    if (!asked || rows.length === 0) return
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ q, asked, rows, sum, meta, openId, at: snapAt.current || Date.now() } satisfies Snapshot),
      )
    } catch {
      /* 存不下（隐私模式 / 超额）就退化成只保留本次会话，不阻塞页面 */
    }
  }, [q, asked, rows, sum, meta, openId])

  const run = async () => {
    const query = q.trim()
    if (!query || busy) return
    setBusy(true)
    setErr('')
    setRows([])
    setSearched(true)
    setOpenId(null)
    setRestored(false)
    snapAt.current = Date.now()
    const rid = ++runId.current
    setSum(null)
    sumFail.current = false
    try {
      const r = await post<any>('/consensus/search', { query, page_size: 10 }, { silent: true })
      setRows(r.results || [])
      setMeta({ truncated: r.truncated, has_key: r.has_key, page: r.page, is_end: r.is_end })
      setAsked(query)
      // 共识度总结：异步出卡，不阻塞论文列表（换查询时旧结果不落新卡）
      if ((r.results || []).length) {
        setSumBusy(true)
        post<SumOut>(
          '/consensus/summarize',
          {
            query,
            papers: (r.results || []).slice(0, 20).map((p: CnsPaper) => ({
              title: p.title,
              takeaway: p.takeaway,
              abstract: p.abstract,
              study_type: p.study_type,
            })),
          },
          { silent: true },
        )
          .then((s) => {
            if (runId.current !== rid) return
            if (s?.ok) setSum(s)
            else sumFail.current = true
          })
          .catch(() => {
            if (runId.current === rid) sumFail.current = true
          })
          .finally(() => {
            if (runId.current === rid) setSumBusy(false)
          })
      }
    } catch (e: any) {
      setErr(e?.message || '检索失败')
    } finally {
      setBusy(false)
    }
  }

  const openExternal = () => {
    if (!asked) return
    window.open(`https://consensus.app/search/${encodeURIComponent(asked)}/`, '_blank', 'noreferrer')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        desc="接 Consensus.app 检索 2 亿+ 同行评审文献，并给出每篇论文的结论 takeaway。"
        actions={
          <div className="flex items-center gap-2">
            <a
              href="https://consensus.app"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11.5px] text-[color:var(--wb-accent)] hover:underline"
            >
              <Icon name="link" size={12} />
              Consensus.app
            </a>
          </div>
        }
      />

      {/* 搜索条 */}
      <div className="shrink-0 px-5 pb-3 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[280px] flex-1">
            <Input
              value={q}
              onChange={setQ}
              placeholder="输入研究问题，例如：AI 测试大模型都使用图结构吗？"
              onKeyDown={(e) => {
                if (e.key === 'Enter') run()
              }}
            />
          </div>
          <Btn variant="primary" size="sm" onClick={run} disabled={!q.trim() || busy}>
            <Icon name="search" size={13} />
            {busy ? '检索中…' : '检索'}
          </Btn>
          {asked && (
            <Btn size="sm" onClick={openExternal}>
              <Icon name="arrowRight" size={12} />
              在 consensus.app 打开
            </Btn>
          )}
        </div>
        {meta.truncated && (
          <p className="mt-2 text-[11.5px] text-[color:var(--wb-warn)]">
            当前无 API key，检索能力受限。到「设置 → 数据源 → Consensus」填 key 可解锁每次 10 篇与论文结论 takeaway。
          </p>
        )}
      </div>

      {/* 结果区 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {busy ? (
          <div className="flex h-full items-center justify-center">
            <Loading text="正在向 Consensus 检索…" />
          </div>
        ) : sumBusy && !sum ? (
          /* 检索已回、归纳未完成：整块继续 loading，避免先冒出一排灰序号再被总结卡顶下去 */
          <div className="flex h-full items-center justify-center">
            <Loading text="正在归纳各论文的立场与共识度…" />
          </div>
        ) : err ? (
          <Empty text="检索失败" hint={err} />
        ) : !searched ? (
          <div className="flex h-full items-start justify-center pt-16">
            <Empty
              text="还没有检索"
              hint="输入一个研究问题回车检索，或打开下方的示例。Consensus 会返回同行评审论文与每篇的结论摘要。"
            />
          </div>
        ) : rows.length === 0 ? (
          <Empty text="没有命中" hint={`Consensus 对「${asked}」没有返回结果，换个问法试试。`} />
        ) : (
          <div className="mx-auto flex max-w-[960px] flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[color:var(--wb-muted)]">
              <Pill tone="gray">{rows.length} 篇</Pill>
              <span>关于「{asked}」</span>
              {restored && boot?.at && (
                <span className="text-[color:var(--wb-muted)]">· 已保留 {fmtAt(boot.at)} 的结果，重新检索会覆盖</span>
              )}
            </div>
            {/* 共识度总结卡：支持/部分支持/反对百分比 + 一句话总结 */}
            {sum && (
              <div className="rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon name="check" size={14} />
                  <span className="text-[13px] font-medium text-[color:var(--wb-text)]">共识度总结</span>
                  <Pill tone="gray">基于 {sum.total} 篇论文</Pill>
                </div>

                <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-[color:var(--wb-bg-subtle)]">
                  {(['support', 'mixed', 'oppose'] as Stance[]).map((k) =>
                    sum.percents?.[k] ? (
                      <div
                        key={k}
                        style={{
                          width: `${sum.percents[k]}%`,
                          background:
                            k === 'support'
                              ? 'var(--wb-ok)'
                              : k === 'oppose'
                                ? 'var(--wb-danger)'
                                : 'var(--wb-warn)',
                        }}
                      />
                    ) : null,
                  )}
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
                  {(['support', 'mixed', 'oppose', 'unclear'] as Stance[]).map((k) => (
                    <span key={k} className="inline-flex items-center gap-1.5 text-[color:var(--wb-text-soft)]">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{
                          background:
                            k === 'support'
                              ? 'var(--wb-ok)'
                              : k === 'oppose'
                                ? 'var(--wb-danger)'
                                : k === 'mixed'
                                  ? 'var(--wb-warn)'
                                  : 'var(--wb-border)',
                        }}
                      />
                      {STANCE_LABEL[k].text}
                      <b className="text-[color:var(--wb-text)]">{sum.percents?.[k] ?? 0}%</b>
                      <span className="text-[color:var(--wb-muted)]">（{sum.counts?.[k] ?? 0} 篇）</span>
                    </span>
                  ))}
                </div>
                {sum.summary && (
                  <p className="mt-2.5 border-l-2 border-[color:var(--wb-accent)] pl-3 text-[12.5px] leading-relaxed text-[color:var(--wb-text)]">
                    {sum.summary}
                  </p>
                )}
                <p className="mt-2 text-[11px] text-[color:var(--wb-muted)]">
                  立场由 AI 依据各论文的结论/摘要逐篇判定，百分比按篇数计算{sum.model ? `（${sum.model}）` : ''}，仅供研究参考。
                </p>
              </div>
            )}

            {/* 论文只出小序号，点开才看详情 */}
            <div className="rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-medium text-[color:var(--wb-text)]">论文</span>
                <span className="text-[11px] text-[color:var(--wb-muted)]">点序号展开详情，再点收起</span>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {rows.map((p, i) => {
                  const st = sum?.stances?.[i]
                  const chip = st ? STANCE_CHIP[st] : null
                  const active = openId === i
                  return (
                    <button
                      key={`${p.doi || p.url || i}`}
                      type="button"
                      onClick={() => setOpenId(active ? null : i)}
                      title={p.title || `论文 ${i + 1}`}
                      className={`inline-flex h-7 min-w-[28px] items-center justify-center rounded-[7px] border px-1.5 text-[12px] font-medium tabular-nums transition-colors ${
                        active
                          ? 'border-[color:var(--wb-accent)] text-[color:var(--wb-accent)]'
                          : 'border-[color:var(--wb-border)] hover:border-[color:var(--wb-accent)]'
                      }`}
                      style={
                        chip
                          ? {
                              background: active ? 'var(--wb-accent-soft)' : chip.bg,
                              color: active ? 'var(--wb-accent)' : chip.fg,
                            }
                          : undefined
                      }
                    >
                      {i + 1}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 展开的单篇详情 */}
            {openId !== null && rows[openId] && (
              <article className="rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-4">
                <div className="flex items-start gap-2">
                  <span className="mt-[3px] text-[11px] tabular-nums text-[color:var(--wb-muted)]">{openId + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={
                          rows[openId].url || rows[openId].doi
                            ? rows[openId].url || `https://doi.org/${rows[openId].doi}`
                            : undefined
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="text-[14px] font-medium leading-snug text-[color:var(--wb-text)] hover:text-[color:var(--wb-accent)] hover:underline"
                      >
                        {rows[openId].title || '（无标题）'}
                      </a>
                      {sum?.stances?.[openId] && (
                        <Pill tone={STANCE_LABEL[sum.stances[openId]].tone}>
                          {STANCE_LABEL[sum.stances[openId]].text}
                        </Pill>
                      )}
                      <button
                        type="button"
                        onClick={() => setOpenId(null)}
                        className="ml-auto text-[11px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-text)]"
                      >
                        收起
                      </button>
                    </div>
                    <div className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                      {rows[openId].authors}
                      {rows[openId].year ? ` · ${rows[openId].year}` : ''}
                      {rows[openId].journal_name ? ` · ${rows[openId].journal_name}` : ''}
                      {rows[openId].citation_count ? ` · 被引 ${rows[openId].citation_count}` : ''}
                      {rows[openId].study_type ? ` · ${rows[openId].study_type}` : ''}
                    </div>

                    {rows[openId].takeaway && (
                      <div className="mt-2.5 rounded-[9px] border-l-2 border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] px-3 py-2 text-[12.5px] leading-relaxed text-[color:var(--wb-text)]">
                        <span className="mr-1 font-medium text-[color:var(--wb-accent)]">结论</span>
                        {rows[openId].takeaway}
                      </div>
                    )}

                    {rows[openId].abstract && (
                      <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
                        {rows[openId].abstract}
                      </p>
                    )}

                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {rows[openId].doi && (
                        <a
                          href={`https://doi.org/${rows[openId].doi}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-accent)] hover:underline"
                        >
                          <Icon name="link" size={11} />
                          DOI
                        </a>
                      )}
                      {rows[openId].url && (
                        <a
                          href={rows[openId].url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-[color:var(--wb-muted)] hover:text-[color:var(--wb-accent)] hover:underline"
                        >
                          <Icon name="link" size={11} />
                          在 Consensus 打开
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
