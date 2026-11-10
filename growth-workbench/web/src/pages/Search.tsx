/**
 * 检索页：主视图改为 Litmaps 式「大搜索框 → 检索过程 → 检索结果」三段发现流程，
 * 入口仍在文献页页头的「在线检索」按钮。
 *
 * 原来的 OpenAlex 命中列表收进底部可折叠的「经典检索」，AI 检索方案仍在页头 ——
 * 两条老链路都没丢，只是不再跟新流程抢首屏。
 */
import { useEffect, useState } from 'react'
import { Btn, Input, Loading, MdBlock, Modal, PageHeader } from '../components/ui'
import { AiError, AiMeta } from '../components/AiError'
import { Icon } from '../components/Icon'
import { get, post } from '../lib/api'
import { useAiTask } from '../lib/hooks'
import { usePersist } from '../lib/state'
import LitSearchCard from '../features/literature/LitSearchCard'
import Discover from '../features/literature/Discover'

type Out = { title: string; text: string } | null

export default function Search({ embedded = false }: { embedded?: boolean }) {
  const [titles, setTitles] = useState<string[]>([])
  const loadTitles = async () => {
    try {
      const rows: any[] = await get('/literature')
      setTitles(rows.map((r) => r.title))
    } catch {
      // 去重清单是可选增强，拉不到就只影响「已在库」标记，不挡检索
    }
  }
  useEffect(() => {
    loadTitles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [classicOpen, setClassicOpen] = usePersist('lit.classicSearchOpen', false)
  const [topic, setTopic] = usePersist('lit.topic', '')
  const [out, setOut] = usePersist<Out>('lit.out', null)
  const kwTask = useAiTask<any>()
  const [planOpen, setPlanOpen] = useState(false)

  const keywords = async () => {
    if (!topic.trim()) return
    const r: any = await kwTask.run(() => post('/literature/keywords', { topic }, { ok: false }))
    if (!r || r.ok === false) return
    setOut({ title: `检索方案 · ${topic}`, text: r.result })
  }

  /** 老链路：关键词 / DOI 命中列表，折叠收在底部（独立路由与嵌入 tab 共用）。
   *  与上面的发现区同属一整片：只用一条细分隔线，不套独立卡片、也不留块间空隙。 */
  const classicBlock = () => (
    <div className="border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-6 py-3">
      <button
        type="button"
        onClick={() => setClassicOpen(!classicOpen)}
        className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--wb-muted)] transition hover:text-[color:var(--wb-accent)]"
      >
        <Icon name="scan" size={13} />
        经典关键词检索（OpenAlex 命中列表）
        <Icon name={classicOpen ? 'chevronUp' : 'chevronDown'} size={12} />
      </button>
      {classicOpen && (
        <div className="mt-1">
          <LitSearchCard libTitles={titles} onImported={loadTitles} flat={embedded} />
        </div>
      )}
    </div>
  )

  return (
    <div
      className={
        embedded
          ? /* 满铺（文献页检索 tab）：标题条贴住顶栏边线，内容区内部滚动 */
            'flex h-full min-h-0 flex-1 flex-col'
          : 'flex flex-col gap-3.5'
      }
    >
      {/* 独立路由时带完整页头；嵌入文献页 tab 时改满铺标题条，避免双页头与顶部空隙 */}
      {embedded ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3.5 py-2.5">
            <Icon name="scan" size={15} className="text-[color:var(--wb-accent)]" />
            <span className="text-[14px] font-medium text-[color:var(--wb-text)]">文献检索</span>
            <span className="text-[11.5px] text-[color:var(--wb-muted)]">
              以一篇论文为起点，顺着真实引用关系发现相关研究
            </span>
            <Btn
              size="sm"
              className="ml-auto"
              onClick={() => {
                setPlanOpen(true)
                setOut(null)
              }}
            >
              <Icon name="sparkle" size={13} />
              检索方案
            </Btn>
          </div>
          {/* 满铺连续面：标题条、发现区、经典检索之间不留白、不套外框，靠细线分段 */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[color:var(--wb-surface)]">
            <Discover onImported={loadTitles} />
            {classicBlock()}
          </div>
        </>
      ) : (
        <>
          <PageHeader
            eyebrow="输入 · 检索"
            title="文献检索"
            desc="以一篇论文为起点，顺着真实引用关系发现相关研究；命中一键入库，之后走文献库同一条链路"
            actions={
              <Btn
                onClick={() => {
                  setPlanOpen(true)
                  setOut(null)
                }}
              >
                <Icon name="sparkle" size={13} />
                检索方案
              </Btn>
            }
          />
          <Discover onImported={loadTitles} />
          {classicBlock()}
        </>
      )}

      {/* AI 检索方案：原来挂在文献页页头，随检索一起搬到这里 */}
      <Modal
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        title="AI 检索方案"
        width="max-w-3xl"
        footer={
          <>
            <Btn onClick={() => setPlanOpen(false)}>关闭</Btn>
            <Btn
              variant="primary"
              onClick={keywords}
              loading={kwTask.busy}
              disabled={!topic.trim()}
            >
              生成检索式
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            placeholder="研究主题，例：LLM agent for CFD case repair"
            value={topic}
            onChange={setTopic}
          />
          <p className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
            输出可直接粘贴到 Google Scholar / IEEE Xplore / arXiv 的布尔检索式、必追关键词与反向检索建议。
          </p>
          {kwTask.error && (
            <AiError error={kwTask.error} onRetry={keywords} retrying={kwTask.busy} />
          )}
          {kwTask.busy ? (
            <Loading text="正在生成检索方案…" />
          ) : out && !kwTask.error ? (
            <div className="max-h-[52vh] overflow-y-auto rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] p-3">
              <MdBlock text={out.text} />
              <AiMeta res={kwTask.data || {}} />
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
