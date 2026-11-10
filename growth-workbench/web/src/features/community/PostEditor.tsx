import { useEffect, useState } from 'react'
import { Btn, Field, Input, Modal, Select, TextArea } from '../../components/ui'
import { toast } from '../../components/toast'
import { patch, post } from '../../lib/api'
import { useIdemKey } from '../../lib/hooks'
import PostCover, { coverPalette } from './PostCover'
import {
  COVER_STYLES,
  CommunityPost,
  POST_CATEGORIES,
  POST_KINDS,
  PostDraft,
  emptyDraft,
} from './types'

/** 发布 / 编辑帖子。正文用 Markdown，封面可选内置风格或自填图片地址。 */
export default function PostEditor({
  open,
  onClose,
  onSaved,
  editing,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  editing: CommunityPost | null
}) {
  const [draft, setDraft] = useState<PostDraft>(emptyDraft())
  const [saving, setSaving] = useState(false)
  const { key, reset } = useIdemKey()

  useEffect(() => {
    if (!open) return
    setDraft(
      editing
        ? {
            title: editing.title,
            summary: editing.summary || '',
            content: editing.content || '',
            category: editing.category,
            kind: editing.kind,
            tags: editing.tags || '',
            cover_style: editing.cover_style,
            cover_url: editing.cover_url || '',
          }
        : emptyDraft(),
    )
  }, [open, editing])

  const set = (k: keyof PostDraft, v: string) => setDraft((d) => ({ ...d, [k]: v }))

  const submit = async () => {
    if (!draft.title.trim() || !draft.content.trim()) {
      toast('标题和正文都要填', 'error')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await patch(`/community/posts/${editing.id}`, draft, { ok: '已更新', idem: key })
      } else {
        await post('/community/posts', draft, { ok: '已发布', idem: key })
      }
      reset()
      onSaved()
    } catch {
      /* api.ts 已经弹过错误，这里只负责解锁按钮 */
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={editing ? '编辑帖子' : '发布帖子'}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" loading={saving} onClick={submit}>
            {editing ? '保存修改' : '发布'}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="标题">
          <Input
            value={draft.title}
            onChange={(v) => set('title', v)}
            placeholder="一句话说清这篇帖子讲什么"
            ariaLabel="帖子标题"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="分类">
            <Select
              value={draft.category}
              onChange={(v) => set('category', v)}
              options={POST_CATEGORIES.map((c) => ({ value: c, label: c }))}
              className="w-full"
            />
          </Field>
          <Field label="类型">
            <Select
              value={draft.kind}
              onChange={(v) => set('kind', v)}
              options={POST_KINDS}
              className="w-full"
            />
          </Field>
        </div>

        <Field label="一句话摘要" hint="列表卡片与详情页会显示，留空也可以">
          <Input
            value={draft.summary}
            onChange={(v) => set('summary', v)}
            placeholder="这篇帖子想解决什么问题"
            ariaLabel="帖子摘要"
          />
        </Field>

        <Field label="正文" hint="支持 Markdown：标题、列表、表格、代码块、链接">
          <TextArea
            value={draft.content}
            onChange={(v) => set('content', v)}
            rows={10}
            placeholder={'## 背景\n\n## 做法\n\n## 想讨论的问题'}
            className="min-h-[220px] font-mono text-[12px]"
          />
        </Field>

        <Field label="标签" hint="用逗号分隔，例如：消融,基线,复现">
          <Input value={draft.tags} onChange={(v) => set('tags', v)} placeholder="可选" ariaLabel="帖子标签" />
        </Field>

        {/* 不用 Field：它渲染成 <label>，把 8 个封面按钮包进 label 会让可访问名串成一团 */}
        <div>
          <div className="mb-1 block text-[12px] font-medium text-[color:var(--wb-text-soft)]">封面风格</div>
          <div className="mb-2 h-[132px] overflow-hidden rounded-[10px] border border-[color:var(--wb-border)]">
            <PostCover
              title={draft.title || '帖子标题预览'}
              headline={draft.summary || draft.title || '帖子标题预览'}
              category={draft.category}
              kind={draft.kind}
              style={draft.cover_style}
              url={draft.cover_url}
            />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {COVER_STYLES.map((s) => {
              const p = coverPalette(s.value)
              const active = draft.cover_style === s.value
              return (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => set('cover_style', s.value)}
                  aria-pressed={active}
                  className={`flex items-center gap-1.5 rounded-[9px] border px-2 py-1.5 text-[11.5px] transition-colors ${
                    active
                      ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                      : 'border-[color:var(--wb-border-strong)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                  }`}
                >
                  <span
                    className="h-[18px] w-[24px] shrink-0 rounded-[4px]"
                    style={{ background: p.bg, borderLeft: `3px solid ${p.accent}` }}
                  />
                  {s.label}
                </button>
              )
            })}
          </div>
          <div className="mt-1 block text-[11.5px] text-[color:var(--wb-muted)]">
            不填图片地址时，用这里的风格生成一张离线可用的封面
          </div>
        </div>

        <Field label="封面图片地址" hint="可选。填了就优先用图片，加载失败会自动回退到上面的生成封面">
          <Input
            value={draft.cover_url}
            onChange={(v) => set('cover_url', v)}
            placeholder="https://… 或 /本地图片.png"
            ariaLabel="封面图片地址"
          />
        </Field>
      </div>
    </Modal>
  )
}
