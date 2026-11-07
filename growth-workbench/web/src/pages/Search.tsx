/**
 * 检索页：原本文献页里的「在线检索」分区与「AI 检索方案」移到这里，
 * 由左侧菜单栏统一进入，文献页只管文献库 / 对比矩阵 / 关联图，不再重复放检索。
 *
 * 数据链路不变：OpenAlex 检索结果仍走 POST /literature 入库，
 * 之后复用去重、AI 笔记、对比矩阵整条链路。
 */
import { useEffect, useState } from 'react'
import {
  Btn,
  Input,
  Loading,
  MdBlock,
  Modal,
  PageHeader,
} from '../components/ui'
import { AiError, AiMeta } from '../components/AiError'
import { Icon } from '../components/Icon'
import { get, post } from '../lib/api'
import { useAiTask } from '../lib/hooks'
import { usePersist } from '../lib/state'
import LitSearchCard from '../features/literature/LitSearchCard'

type Out = { title: string; text: string } | null

export default function Search() {
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

  return (
    <div className="flex flex-col gap-3.5">
      <PageHeader
        eyebrow="输入 · 检索"
        title="检索"
        desc="在线检索论文、生成布尔检索式；命中的文献一键入库，之后走文献库同一条链路"
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

      <LitSearchCard libTitles={titles} onImported={loadTitles} />

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
