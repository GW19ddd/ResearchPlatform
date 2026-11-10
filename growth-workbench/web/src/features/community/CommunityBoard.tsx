import { useEffect, useState } from 'react'
import { Btn, Empty, LoadError, Loading, SearchInput, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { post } from '../../lib/api'
import { useApi } from '../../lib/hooks'
import PostCard from './PostCard'
import PostDetail from './PostDetail'
import PostEditor from './PostEditor'
import { CATEGORIES, CommunityList, CommunityPost, ReactionResult, SORT_OPTIONS } from './types'

/**
 * 科研社区主视图，布局对齐参考图：
 *  ① 标题 + 副描述在左，搜索框 + 个人收藏 + 发布在右
 *  ② 一整行可横滚的分类标签
 *  ③ 四列「大图封面 + 标题 + 作者」卡片网格
 * 卡片点开是详情抽屉：读正文、点赞收藏、评论交流。
 */
export default function CommunityBoard() {
  const [kw, setKw] = useState('')
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string>('全部')
  const [sort, setSort] = useState('latest')
  const [favOnly, setFavOnly] = useState(false)
  const [mineOnly, setMineOnly] = useState(false)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detailKey, setDetailKey] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<CommunityPost | null>(null)

  // 搜索防抖：不每敲一个字就打一次后端
  useEffect(() => {
    const t = window.setTimeout(() => setQ(kw.trim()), 220)
    return () => window.clearTimeout(t)
  }, [kw])

  const qs = new URLSearchParams({
    q,
    category,
    sort,
    favorites: String(favOnly),
    mine: String(mineOnly),
    limit: '120',
  })
  const { data, loading, error, reload, setData } = useApi<CommunityList>(
    `/community/posts?${qs.toString()}`,
  )

  const toggleFavorite = async (pid: number) => {
    try {
      const r = await post<ReactionResult>(
        `/community/posts/${pid}/favorite`,
        {},
        { ok: false, silent: true },
      )
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((x) =>
                x.id === pid ? { ...x, favorited: r.active, favorites: r.count } : x,
              ),
            }
          : prev,
      )
      if (favOnly) reload()
    } catch {
      /* api.ts 已弹错误 */
    }
  }

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }

  const onSaved = () => {
    setEditorOpen(false)
    setEditing(null)
    setDetailKey((n) => n + 1)
    reload()
  }

  const items = data?.items || []
  const filterOn = !!q || category !== '全部' || favOnly || mineOnly

  return (
    <div className="flex flex-col gap-3.5">
      {/* 参考图的顶部一行：社区名 + 一句话说明在左，搜索 / 收藏 / 发布在右。
          全站 PageHeader 已收敛成无标题的细行，这里按社区页的版式单独给一条标题行。 */}
      <div className="wb-anim-rise flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h1 className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-[color:var(--wb-text)]">
            科研社区
          </h1>
          <span className="text-[11.5px] text-[color:var(--wb-muted)]">
            发帖、读帖、交流：把研究里的想法、方法和坑都留在这里
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <SearchInput value={kw} onChange={setKw} placeholder="搜索帖子关键词" className="w-[196px]" />
          <Btn
            size="sm"
            variant={favOnly ? 'primary' : 'default'}
            onClick={() => setFavOnly((v) => !v)}
            ariaLabel="只看个人收藏"
          >
            <Icon name="star" size={13} fill={favOnly ? 'currentColor' : 'none'} />
            个人收藏
          </Btn>
          <Btn size="sm" variant="primary" onClick={openCreate}>
            <Icon name="plus" size={13} />
            发布帖子
          </Btn>
        </div>
      </div>

      <div className="flex items-center gap-3 border-b border-[color:var(--wb-border)] pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap pb-1">
          {CATEGORIES.map((c) => {
            const active = category === c
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                aria-pressed={active}
                className={`shrink-0 rounded-full border px-3 py-[5px] text-[11.5px] transition-colors ${
                  active
                    ? 'border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] font-medium text-[color:var(--wb-text)] shadow-[var(--wb-shadow-xs)]'
                    : 'border-transparent text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-surface)] hover:text-[color:var(--wb-text)]'
                }`}
              >
                {c}
              </button>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Btn
            size="xs"
            variant={mineOnly ? 'primary' : 'ghost'}
            onClick={() => setMineOnly((v) => !v)}
            ariaLabel="只看我的帖子"
          >
            <Icon name="user" size={12} />
            我的帖子
          </Btn>
          <Select value={sort} onChange={setSort} options={SORT_OPTIONS} />
        </div>
      </div>

      {loading && !data ? (
        <Loading text="正在加载社区帖子…" />
      ) : error ? (
        <LoadError error={error} onRetry={reload} retrying={loading} what="社区帖子" />
      ) : items.length === 0 ? (
        <Empty
          text={filterOn ? '没有匹配的帖子' : '社区里还没有帖子'}
          hint={
            filterOn
              ? '换个关键词、切回「全部」，或关掉收藏 / 我的帖子筛选试试。'
              : '发第一帖吧：可以是一篇论文的痛点整理、一次实验复盘，或一个想讨论的问题。'
          }
          action={
            filterOn ? (
              <Btn
                size="sm"
                onClick={() => {
                  setKw('')
                  setQ('')
                  setCategory('全部')
                  setFavOnly(false)
                  setMineOnly(false)
                }}
              >
                清除筛选
              </Btn>
            ) : (
              <Btn size="sm" variant="primary" onClick={openCreate}>
                <Icon name="plus" size={13} />
                发布帖子
              </Btn>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              onOpen={setSelectedId}
              onFavorite={toggleFavorite}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-[color:var(--wb-muted)]">
        <span>
          共 {data?.total ?? 0} 篇帖子{items.length < (data?.total ?? 0) ? ` · 当前显示前 ${items.length} 篇` : ''}
        </span>
        <span>内置「示例」帖可随时删除；发布的内容只保存在本机数据库</span>
      </div>

      <PostDetail
        id={selectedId}
        refreshKey={detailKey}
        onClose={() => setSelectedId(null)}
        onChanged={reload}
        onEdit={(p) => {
          setEditing(p)
          setEditorOpen(true)
        }}
        onDeleted={() => {
          setSelectedId(null)
          reload()
        }}
      />

      <PostEditor
        open={editorOpen}
        editing={editing}
        onClose={() => {
          setEditorOpen(false)
          setEditing(null)
        }}
        onSaved={onSaved}
      />
    </div>
  )
}
