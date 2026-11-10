import { Avatar } from '../../components/ui'
import { Icon } from '../../components/Icon'
import PostCover from './PostCover'
import { CommunityPost } from './types'

/**
 * 社区卡片：大图封面 + 标题 + 作者行，四列网格中的一格。
 * 卡片整体是一个真正的 button，收藏按钮作为它的兄弟节点绝对定位，
 * 避免「button 套 button」这种屏幕阅读器读不清的结构。
 */
export default function PostCard({
  post,
  onOpen,
  onFavorite,
}: {
  post: CommunityPost
  onOpen: (id: number) => void
  onFavorite: (id: number) => void
}) {
  return (
    <article className="group relative flex rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-[9px] shadow-[var(--wb-shadow-xs)] transition-all duration-150 hover:-translate-y-[2px] hover:border-[color:var(--wb-border-strong)] hover:shadow-[var(--wb-shadow-md)]">
      <button
        type="button"
        onClick={() => onOpen(post.id)}
        aria-label={`阅读帖子：${post.title}`}
        title={`${post.title} · ${post.summary || '点击阅读全文'}`}
        className="wb-press-soft flex w-full flex-col text-left"
      >
        <div className="aspect-[16/10] w-full overflow-hidden rounded-[10px] border border-[color:var(--wb-border)]">
          <PostCover
            title={post.title}
            headline={post.summary || post.title}
            category={post.category}
            kind={post.kind}
            style={post.cover_style}
            url={post.cover_url}
            pinned={!!post.pinned}
          />
        </div>

        <div className="flex flex-1 flex-col px-1 pb-0.5 pt-2.5">
          <h3 className="line-clamp-2 min-h-[38px] text-[13px] font-semibold leading-[1.45] text-[color:var(--wb-text)] transition-colors group-hover:text-[color:var(--wb-accent)]">
            {post.title}
          </h3>
          <div className="mt-auto flex items-center gap-1.5 pt-2 text-[11px] text-[color:var(--wb-muted)]">
            <Avatar name={post.author_name} hue={post.author_hue} size={16} />
            <span className="min-w-0 truncate">{post.author_name}</span>
            {post.is_sample && (
              <span className="shrink-0 rounded-[4px] border border-[color:var(--wb-border)] px-1 text-[9.5px] leading-[15px]">
                示例
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
              <span className="flex items-center gap-[3px]" title="点赞">
                <Icon name="heart" size={11} />
                {post.likes}
              </span>
              <span className="flex items-center gap-[3px]" title="评论">
                <Icon name="message" size={11} />
                {post.comments_count}
              </span>
            </span>
          </div>
        </div>
      </button>

      <button
        type="button"
        onClick={() => onFavorite(post.id)}
        aria-label={post.favorited ? '取消收藏' : '收藏帖子'}
        title={post.favorited ? '取消收藏' : '收藏帖子'}
        aria-pressed={!!post.favorited}
        className={`absolute right-[17px] top-[17px] flex h-[26px] w-[26px] items-center justify-center rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]/90 shadow-[var(--wb-shadow-xs)] transition-all duration-150 focus:opacity-100 group-hover:opacity-100 ${
          post.favorited
            ? 'text-[color:var(--wb-accent)] opacity-100'
            : 'text-[color:var(--wb-muted)] opacity-0 hover:text-[color:var(--wb-accent)]'
        }`}
      >
        <Icon name="bookmark" size={13} fill={post.favorited ? 'currentColor' : 'none'} />
      </button>
    </article>
  )
}
