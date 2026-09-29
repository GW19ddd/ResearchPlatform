/**
 * 居中大尺寸 PDF 浮层：整页阅读，不再挤在侧边抽屉里。
 *
 * 自己扛「定位 → 候选 → 重新定位」全套流程，对外只有 (item, onClose)。
 * 侧边抽屉只负责笔记与 Gloss，两者互不依赖，PDF 这一块可以单独替换。
 */
import { useEffect, useState } from 'react'
import { Btn, Input, Loading, Pill, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'
import PdfViewer from '../../components/PdfViewer'
import { get, patch } from '../../lib/api'

export default function PdfModal({
  item,
  onClose,
  onChanged,
}: {
  item: any | null
  onClose: () => void
  onChanged?: () => void
}) {
  const [info, setInfo] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState('')
  const [nonce, setNonce] = useState(0)

  const id = item?.id

  useEffect(() => {
    if (!id) return
    setPath(item?.pdf_path || '')
  }, [id])

  useEffect(() => {
    if (!id) return
    let alive = true
    setLoading(true)
    get(`/literature/${id}/pdf-info`)
      .then((r) => alive && setInfo(r))
      .catch(() => alive && setInfo(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
     
  }, [id, nonce])

  // Esc 关闭：读 PDF 时手不会离开键盘
  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, onClose])

  if (!item) return null

  const savePath = async () => {
    setBusy('save')
    try {
      await patch(`/literature/${item.id}`, { pdf_path: path })
      setNonce((n) => n + 1)
      onChanged?.()
    } finally {
      setBusy('')
    }
  }

  const choose = async (p: string) => {
    setPath(p)
    setBusy('save')
    try {
      await patch(`/literature/${item.id}`, { pdf_path: p })
      setNonce((n) => n + 1)
      onChanged?.()
    } finally {
      setBusy('')
    }
  }

  const isGloss = info?.source === 'gloss'
  const subtitle = [item.authors, item.year, item.venue].filter(Boolean).join(' · ')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
      <div className="wb-anim-fade absolute inset-0 bg-[rgba(16,24,40,0.55)]" onClick={onClose} />
      <div className="wb-anim-pop relative flex h-[94vh] w-[min(1500px,96vw)] flex-col overflow-hidden rounded-[16px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]">
        {/* 标题栏 */}
        <header className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-[color:var(--wb-danger-soft)] text-[11.5px] font-semibold text-[color:var(--wb-danger)]">
            PDF
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[color:var(--wb-text)]" title={item.title}>
              {item.title}
            </div>
            {subtitle && (
              <div className="truncate text-[11.5px] text-[color:var(--wb-muted)]">{subtitle}</div>
            )}
          </div>
          {!loading && info?.ok && (
            <Pill tone={isGloss ? 'indigo' : 'green'}>
              {isGloss ? `Gloss 馆藏 · ${info.gloss_id}` : '本地文件'}
            </Pill>
          )}
          <a
            href={`/api/literature/${item.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-[9px] border border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-2.5 py-[5px] text-[12px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)]"
          >
            新标签打开
          </a>
          <Btn size="sm" onClick={() => setNonce((n) => n + 1)} loading={loading}>
            重新定位
          </Btn>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[color:var(--wb-muted)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
          >
            <Icon name="close" size={17} />
          </button>
        </header>

        {/* 正文 */}
        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Loading text="正在定位 PDF…" />
          </div>
        ) : info?.ok ? (
          <div className="min-h-0 flex-1">
            <PdfViewer key={`${info.source}-${info.path}-${nonce}`} src={`/api/literature/${item.id}/pdf`} />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
            <div className="mx-auto flex w-full max-w-xl flex-col gap-3">
              <div className="rounded-[12px] border border-[color:var(--wb-warn)]/25 bg-[color:var(--wb-warn-soft)] px-3.5 py-3 text-[12.5px] text-[color:var(--wb-warn)]">
                <div className="font-medium">还没定位到这篇的 PDF</div>
                <div className="mt-1 leading-relaxed opacity-90">
                  填一个绝对路径，或从下面按标题搜到的候选里点一个。
                  {info?.gloss_id && !info?.gloss_running && (
                    <div className="mt-1">
                      这篇之前送进过 Gloss（id {info.gloss_id}），启动 Gloss 服务后也能直接读。
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                <Input
                  placeholder="PDF 绝对路径，例：D:\Zotero\storage\ABCD\paper.pdf"
                  value={path}
                  onChange={setPath}
                />
                <Btn variant="primary" onClick={savePath} loading={busy === 'save'}>
                  保存并加载
                </Btn>
              </div>

              {info?.candidates?.length > 0 && (
                <div className="flex flex-col gap-1">
                  <div className="text-[11.5px] text-[color:var(--wb-muted)]">
                    按标题在本地找到的候选（点一下直接用）：
                  </div>
                  <div className="max-h-72 overflow-y-auto rounded-[10px] border border-[color:var(--wb-border)]">
                    {info.candidates.map((c: any) => (
                      <button
                        key={c.path}
                        onClick={() => choose(c.path)}
                        title={c.path}
                        className="block w-full truncate px-2.5 py-1.5 text-left text-[11.5px] text-[color:var(--wb-text-soft)] transition hover:bg-[color:var(--wb-bg-subtle)] hover:text-[color:var(--wb-text)]"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {info?.dirs?.length > 0 && (
                <div className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                  搜索目录：{info.dirs.join(' , ')}
                </div>
              )}
              {busy === 'save' && (
                <div className="flex items-center gap-2 text-[11.5px] text-[color:var(--wb-muted)]">
                  <Spinner /> 正在重新定位…
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
