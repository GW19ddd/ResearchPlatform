/**
 * 论文速递主视图：抖音式竖滑卡片流。
 * - 滚动容器 snap-y snap-mandatory，一屏一张卡；↑/↓ 与 j/k 切卡；
 * - 数据来源：arXiv 拉取、邮箱投喂（IMAP）、手动粘贴。
 * 收藏 / 点赞 / 笔记等动作与主菜单栏重复，右侧动作竖条已按需求移除。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Empty, Loading, Modal, Segmented, TextArea } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { post } from '../../lib/api'
import { useAction, useApi, useToggle } from '../../lib/hooks'
import { FeedCard } from './FeedCard'
import PaperHall from './PaperHall'
import PaperDetail from './PaperDetail'
import SettingsPanel from '../settings/SettingsPanel'
import type { Lang, Paper } from './types'

type View = 'inbox' | 'liked' | 'saved' | 'hidden'
type Layout = 'stream' | 'hall'

const TABS: { value: View; label: string }[] = [
  { value: 'inbox', label: '速递' },
  { value: 'liked', label: '点赞' },
  { value: 'saved', label: '收藏' },
  { value: 'hidden', label: '不看' },
]

function relTime(s: string | null): string {
  if (!s) return ''
  const t = new Date(String(s).replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 60000) return '刚刚'
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

export default function PaperFeedView() {
  const [view, setView] = useState<View>('inbox')
  const [layout, setLayout] = useState<Layout>('hall')
  const { data, loading, error, reload } = useApi<Paper[]>(
    `/paperfeed/papers?view=${view}`,
    [view],
  )
  const papers = useMemo(() => (Array.isArray(data) ? data : []), [data])
  const [idx, setIdx] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 设置统一在全局设置里；这里只负责打开它并定位到「论文速递」分类 */
  const settingsPanel = useToggle()
  const ingest = useToggle()
  // 详情弹窗 + 语言显示（默认值来自全局设置的「内容语言显示」）
  const [detail, setDetail] = useState<Paper | null>(null)
  const { data: feedCfg } = useApi<any>('/paperfeed/settings')
  const defaultLang: Lang =
    feedCfg?.language === 'zh' || feedCfg?.language === 'en' ? feedCfg.language : 'both'
  const [fetching, setFetching] = useState(false)
  const [lastFetchAt, setLastFetchAt] = useState<string | null>(null)
  const { busy: polling, run: runPoll } = useAction()
  const [ingestText, setIngestText] = useState('')
  const { busy: ingesting, run: runIngest } = useAction()

  /** 拉取 arXiv 最新论文（只在点「拉取最新」时触发，平时打开页面不自动拉）。
   * 拉完立即开一轮补图批处理 + 渐进轮询，让新卡片的封面陆续亮出。 */
  const [batchActive, setBatchActive] = useState(false)
  const refresh = useCallback(
    async (silent: boolean) => {
      setFetching(true)
      try {
        const r = await post<{ added: number; last_fetch_at: string }>(
          '/paperfeed/fetch',
          {},
        )
        setLastFetchAt(r?.last_fetch_at || null)
        await reload()
        if (!silent && (r?.added ?? 0) > 0) toast(`已更新 ${r!.added} 篇新论文`, 'ok')
        // 触发一轮补图：后台批量 + 前端轮询，缺图的卡陆续亮出（见下方 effect）
        backfillTried.current = 0
        figPolls.current = 0
        setBatchActive(true)
        return r
      } catch (e: any) {
        if (!silent) toast(e?.message || '拉取失败', 'error')
        return null
      } finally {
        setFetching(false)
      }
    },
    [reload],
  )

  const goto = useCallback(
    (i: number) => {
      const n = papers.length
      if (!n) return
      const next = Math.max(0, Math.min(i, n - 1))
      setIdx(next)
      const el = scrollRef.current?.children[next] as HTMLElement | undefined
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    [papers.length],
  )

  // 滚动同步当前卡索引；换 tab 时回到第一张
  useEffect(() => setIdx(0), [view])
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const i = Math.round(el.scrollTop / Math.max(1, el.clientHeight))
    if (i !== idx) setIdx(i)
  }

  // 键盘：↑/↓ / j/k 切卡
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
      if (layout === 'hall') return
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        goto(idx + 1)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        goto(idx - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [idx, goto, layout])

  // 补图：只在「拉取最新」后进行（batchActive）。批处理跑的时候每 4 秒轮询刷新，
  // 让新抓到的封面陆续亮出；全部有图后自动停。平时打开页面不拉任何东西。
  const backfillTried = useRef(0)
  const figPolls = useRef(0)
  useEffect(() => {
    backfillTried.current = 0
    figPolls.current = 0
  }, [view])
  useEffect(() => {
    if (!batchActive || loading || !papers.length) return
    // 'none'=已确认全空（img/svg/PDF 四层都试过）——不算缺图，避免反复空跑补图
    const missing = papers.filter(
      (p) => !p.figure_url && p.arxiv_id && p.figure_kind !== 'none',
    ).length
    if (!missing) {
      figPolls.current = 0
      setBatchActive(false)
      return
    }
    if (backfillTried.current < 3) {
      backfillTried.current += 1
      post('/paperfeed/figures?limit=120', {}, { silent: true }).catch(() => {})
    }
    // 补图进行中：最多轮询 30 次（~2 分钟），图一到就逐张亮出
    if (figPolls.current >= 30) {
      setBatchActive(false)
      return
    }
    const t = setTimeout(() => {
      figPolls.current += 1
      reload()
    }, 4000)
    return () => clearTimeout(t)
  }, [batchActive, papers, loading, reload])

  const doFetch = () => refresh(false)

  const doPoll = () =>
    runPoll(
      () => post('/paperfeed/poll_email', {}, { ok: '' }),
      { ok: '', after: reload },
    )

  const doIngest = () =>
    runIngest(async () => {
      if (!ingestText.trim()) throw new Error('先粘贴内容')
      const r = await post<{ added: number; msg?: string }>('/paperfeed/ingest', { text: ingestText }, { silent: true })
      toast(r?.added ? `已加入 ${r.added} 篇` : r?.msg || '没有识别出论文', r?.added ? 'ok' : 'error')
      setIngestText('')
      ingest.hide()
      reload()
    })

  const feed = (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full snap-y snap-mandatory overflow-y-auto"
    >
      {papers.map((p) => (
        <div
          key={p.id}
          className="flex min-h-full snap-center items-center justify-center px-4 py-5"
        >
          <FeedCard paper={p} onOpen={setDetail} lang={defaultLang} />
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：视图切换 + 数据来源操作 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-2">
        <Segmented
          value={view}
          onChange={(v) => setView(v as View)}
          options={TABS.map((t) => ({ value: t.value, label: t.label }))}
        />
        <Segmented
          value={layout}
          onChange={(v) => setLayout(v as Layout)}
          options={[
            { value: 'stream', label: '速递流' },
            { value: 'hall', label: '大厅' },
          ]}
        />
        <div className="ml-auto flex items-center gap-1.5">
          {lastFetchAt && (
            <span className="mr-1 hidden text-[10.5px] text-[color:var(--wb-muted)] sm:inline">
              更新于 {relTime(lastFetchAt)}
            </span>
          )}
          <Btn size="xs" onClick={() => ingest.show()}>
            <Icon name="paperclip" size={13} />
            粘贴投喂
          </Btn>
          <Btn size="xs" loading={polling} onClick={doPoll}>
            <Icon name="inbox" size={13} />
            检查邮箱
          </Btn>
          <Btn size="xs" variant="primary" loading={fetching} onClick={doFetch}>
            <Icon name="refresh" size={13} />
            拉取最新
          </Btn>
          <Btn size="xs" onClick={settingsPanel.show}>
            <Icon name="gear" size={13} />
            设置
          </Btn>
        </div>
      </div>

      {/* 实时拉取提示条：自动刷新或手动「拉取最新」时显示 */}
      {fetching && (
        <div className="shrink-0 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-4 py-1.5 text-center text-[11px] text-[color:var(--wb-muted)]">
          正在从 arXiv 实时拉取最新论文…
        </div>
      )}

      {/* 卡片流 / 大厅 */}
      <div className="min-h-0 flex-1 bg-[color:var(--wb-bg)]">
        {loading ? (
          <Loading />
        ) : error ? (
          <div className="p-8">
            <Empty text={`加载失败：${error}`} />
          </div>
        ) : papers.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8">
            <Empty
              text={
                view === 'inbox'
                  ? '卡片流还是空的：点右上「设置」选学科和研究方向，再「拉取最新」或用邮箱投喂论文。'
                  : '这里还没有内容。'
              }
            />
          </div>
        ) : layout === 'hall' ? (
          <PaperHall papers={papers} onOpen={setDetail} />
        ) : (
          feed
        )}
      </div>

      {/* 状态提示：第几张卡（仅速递流） */}
      {papers.length > 0 && layout === 'stream' && (
        <div className="shrink-0 pb-1 pt-1 text-center text-[10.5px] text-[color:var(--wb-muted)]">
          {idx + 1} / {papers.length} · ↑↓ 或 j/k 切卡
        </div>
      )}

      {/* 设置：统一进全局设置面板，直达「论文速递」分类 */}
      <SettingsPanel open={settingsPanel.open} onClose={settingsPanel.hide} initialSection="paperfeed" />

      {/* 详情：大图 + 中 / 英 / 双语 */}
      <PaperDetail paper={detail} defaultLang={defaultLang} onClose={() => setDetail(null)} />

      {/* 粘贴投喂 */}
      <Modal
        open={ingest.open}
        onClose={ingest.hide}
        title="粘贴投喂"
        width="max-w-lg"
        footer={
          <>
            <Btn onClick={ingest.hide}>取消</Btn>
            <Btn variant="primary" loading={ingesting} onClick={doIngest}>
              识别并加入
            </Btn>
          </>
        }
      >
        <TextArea
          value={ingestText}
          onChange={setIngestText}
          rows={8}
          placeholder={'把转发邮件正文 / arXiv 链接 / id 粘进来，例如：\nhttps://arxiv.org/abs/2611.08457\n或「Subject: 论文标题 + 摘要」'}
        />
        <div className="mt-2 text-[11px] text-[color:var(--wb-muted)]">
          有 arXiv 链接或 id 时会自动拉取真实元数据；只有标题摘要时按文本入库。
        </div>
      </Modal>
    </div>
  )
}
