import { useEffect, useState } from 'react'
import { Avatar, Btn, Drawer, IconBtn, Loading, MdBlock, Pill, TextArea } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { del, get, post as apiPost } from '../../lib/api'
import { useIdemKey } from '../../lib/hooks'
import { useAuth } from '../../lib/auth'
import PostCover from './PostCover'
import {
  CommunityComment,
  CommunityPost,
  PostDetail as PostDetailData,
  ReactionResult,
  formatWhen,
  kindLabel,
  tagList,
} from './types'

/** 帖子详情：读正文 + 点赞 / 收藏 + 评论交流。 */
export default function PostDetail({
  id,
  onClose,
  onChanged,
  onEdit,
  onDeleted,
  refreshKey = 0,
}: {
  id: number | null
  onClose: () => void
  /** 任一写操作后通知列表刷新计数 */
  onChanged: () => void
  onEdit: (post: CommunityPost) => void
  onDeleted: () => void
  /** 编辑保存后 +1，强制重新拉一次详情 */
  refreshKey?: number
}) {
  const { user } = useAuth()
  const [post, setPost] = useState<CommunityPost | null>(null)
  const [comments, setComments] = useState<CommunityComment[]>([])
  const [loading, setLoading] = useState(false)
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<CommunityComment | null>(null)
  const [busy, setBusy] = useState(false)
  const { key, reset } = useIdemKey()

  useEffect(() => {
    if (!id) {
      setPost(null)
      setComments([])
      return
    }
    let alive = true
    setLoading(true)
    get<PostDetailData>(`/community/posts/${id}`)
      .then((r) => {
        if (!alive) return
        setPost(r.post)
        setComments(r.comments || [])
        setText('')
        setReplyTo(null)
      })
      .catch(() => {
        if (alive) setPost(null)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id, refreshKey])

  const react = async (kind: 'like' | 'favorite') => {
    if (!post) return
    const path = kind === 'like' ? 'like' : 'favorite'
    try {
      const r = await apiPost<ReactionResult>(`/community/posts/${post.id}/${path}`, {}, { ok: false, silent: true })
      setPost((p) =>
        p
          ? {
              ...p,
              liked: kind === 'like' ? r.active : p.liked,
              favorited: kind === 'favorite' ? r.active : p.favorited,
              likes: kind === 'like' ? r.count : p.likes,
              favorites: kind === 'favorite' ? r.count : p.favorites,
            }
          : p,
      )
      onChanged()
    } catch {
      /* 错误提示由 api.ts 负责 */
    }
  }

  const send = async () => {
    if (!post) return
    const content = text.trim()
    if (!content) {
      toast('写点什么再发', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await apiPost<{ ok: boolean; comment: CommunityComment }>(
        `/community/posts/${post.id}/comments`,
        { content, parent_id: replyTo?.id ?? null },
        { ok: '评论已发布', idem: key },
      )
      setComments((cs) => [...cs, r.comment])
      setPost((p) => (p ? { ...p, comments_count: p.comments_count + 1 } : p))
      setText('')
      setReplyTo(null)
      reset()
      onChanged()
    } catch {
      /* 保留输入，别让用户白写一遍 */
    } finally {
      setBusy(false)
    }
  }

  const removeComment = async (cid: number) => {
    try {
      await del(`/community/comments/${cid}`, { ok: '已删除' })
      setComments((cs) => cs.filter((c) => c.id !== cid))
      setPost((p) => (p ? { ...p, comments_count: Math.max(0, p.comments_count - 1) } : p))
      onChanged()
    } catch {
      /* noop */
    }
  }

  const removePost = async () => {
    if (!post) return
    if (!window.confirm('确定删除这篇帖子？评论与点赞也会一起删除。')) return
    try {
      await del(`/community/posts/${post.id}`, { ok: '已删除' })
      onDeleted()
    } catch {
      /* noop */
    }
  }

  const canManage = !!post && (post.is_sample || post.author_id === user?.id)
  const tags = tagList(post?.tags)

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width="w-[640px]"
      title={<span className="block truncate">{post?.title || '帖子详情'}</span>}
      footer={
        <div className="flex flex-col gap-2">
          {replyTo && (
            <div className="flex items-center gap-2 text-[11.5px] text-[color:var(--wb-muted)]">
              <Icon name="reply" size={12} />
              回复 {replyTo.author_name}：
              <span className="min-w-0 flex-1 truncate">{replyTo.content}</span>
              <IconBtn icon="close" size="sm" ariaLabel="取消回复" onClick={() => setReplyTo(null)} />
            </div>
          )}
          <div className="flex items-end gap-2">
            <TextArea
              value={text}
              onChange={setText}
              rows={2}
              placeholder="写下你的想法、追问或补充…"
              className="min-h-[62px] flex-1"
            />
            <Btn variant="primary" loading={busy} onClick={send} className="mb-[1px]">
              <Icon name="send" size={13} />
              发送
            </Btn>
          </div>
        </div>
      }
    >
      {loading && !post ? (
        <Loading text="正在打开帖子…" />
      ) : !post ? (
        <div className="py-10 text-center text-[12px] text-[color:var(--wb-muted)]">
          帖子不存在或已被删除
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="h-[210px] overflow-hidden rounded-[12px] border border-[color:var(--wb-border)]">
            <PostCover
              title={post.title}
              category={post.category}
              kind={post.kind}
              style={post.cover_style}
              url={post.cover_url}
              pinned={!!post.pinned}
              compact
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Avatar name={post.author_name} hue={post.author_hue} size={28} />
            <div className="min-w-0">
              <div className="truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">
                {post.author_name}
              </div>
              <div className="text-[10.5px] text-[color:var(--wb-muted)]">
                {formatWhen(post.created_at)} · {post.views} 次阅读
              </div>
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <Pill tone="indigo">{post.category}</Pill>
              <Pill>{kindLabel(post.kind)}</Pill>
              {post.is_sample && <Pill>示例</Pill>}
            </div>
          </div>

          {post.summary && (
            <div className="rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
              {post.summary}
            </div>
          )}

          {/* 全局 .markdown-block 自带 480px 内滚动；抽屉里套一层滚动很难用，这里放开 */}
          <div className="[&_.markdown-block]:max-h-none [&_.markdown-block]:overflow-visible [&_.markdown-block]:text-[13px]">
            <MdBlock text={post.content || ''} />
          </div>

          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="rounded-[6px] bg-[color:var(--wb-bg-subtle)] px-2 py-[2px] text-[11px] text-[color:var(--wb-text-soft)]"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-y border-[color:var(--wb-border)] py-2.5">
            <Btn
              size="sm"
              variant={post.liked ? 'primary' : 'subtle'}
              onClick={() => react('like')}
              ariaLabel="点赞"
            >
              <Icon name="heart" size={13} fill={post.liked ? 'currentColor' : 'none'} />
              {post.likes}
            </Btn>
            <Btn
              size="sm"
              variant={post.favorited ? 'primary' : 'subtle'}
              onClick={() => react('favorite')}
              ariaLabel="收藏"
            >
              <Icon name="bookmark" size={13} fill={post.favorited ? 'currentColor' : 'none'} />
              {post.favorited ? '已收藏' : '收藏'}
            </Btn>
            <span className="flex items-center gap-1 text-[11.5px] text-[color:var(--wb-muted)]">
              <Icon name="message" size={13} />
              {post.comments_count} 条交流
            </span>
            {canManage && (
              <div className="ml-auto flex items-center gap-1">
                <IconBtn icon="pencil" size="md" ariaLabel="编辑帖子" title="编辑帖子" onClick={() => onEdit(post)} />
                <IconBtn icon="trash" size="md" tone="danger" ariaLabel="删除帖子" title="删除帖子" onClick={removePost} />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="text-[12.5px] font-semibold text-[color:var(--wb-text)]">
              交流 · {comments.length} 条
            </div>
            {comments.length === 0 && (
              <div className="rounded-[10px] border border-dashed border-[color:var(--wb-border-strong)] py-6 text-center text-[11.5px] text-[color:var(--wb-muted)]">
                还没有人留言，来补第一条吧
              </div>
            )}
            {comments.map((c) => (
              <div key={c.id} className="flex gap-2.5">
                <Avatar name={c.author_name} hue={c.author_hue} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-[color:var(--wb-text)]">
                      {c.author_name}
                    </span>
                    <span className="text-[10.5px] text-[color:var(--wb-muted)]">{formatWhen(c.created_at)}</span>
                    <div className="ml-auto flex shrink-0 items-center">
                      <IconBtn icon="reply" size="sm" ariaLabel="回复这条评论" title="回复" onClick={() => setReplyTo(c)} />
                      {(c.author_id === user?.id || post.is_sample) && (
                        <IconBtn
                          icon="trash"
                          size="sm"
                          tone="danger"
                          ariaLabel="删除这条评论"
                          title="删除"
                          onClick={() => removeComment(c.id)}
                        />
                      )}
                    </div>
                  </div>
                  {c.parent_id && (
                    <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-[color:var(--wb-accent)]">
                      <Icon name="reply" size={10} />
                      回复 {comments.find((x) => x.id === c.parent_id)?.author_name || '楼上'}
                    </div>
                  )}
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                    {c.content}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  )
}
