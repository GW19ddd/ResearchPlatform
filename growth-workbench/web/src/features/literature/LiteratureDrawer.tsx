/**
 * 文献详情抽屉：分段笔记 + Gloss 旁注。
 *
 * 从 pages/Literature.tsx 拆出来的独立组件：它自己管笔记、PDF 路径、Gloss 状态，
 * 对外只暴露「传入哪条文献 / 关闭 / 写操作后通知外层刷新 / 打开居中 PDF」几个口子。
 * PDF 阅读本身不在这里 —— 那是一个居中的大浮层（PdfModal），侧栏只留给文字类内容。
 */
import { useEffect, useState } from 'react'
import { Btn, Empty, Input, MdBlock, Pill, Select, TextArea } from '../../components/ui'
import { del, get, patch, post, put } from '../../lib/api'
import { usePersist } from '../../lib/state'
import { STATUS } from './literature-shared'

export default function LiteratureDrawer({
  item,
  nonce = 0,
  onClose,
  onMutated,
  onStatusChange,
  onOpenPdf,
}: {
  item: any | null
  /** 变一次就强制重拉笔记/PDF，用于「同一篇重新生成」这种 id 不变的场景 */
  nonce?: number
  onClose: () => void
  onMutated?: () => void
  onStatusChange?: (id: number, status: string) => void
  /** 打开居中的 PDF 浮层；由页面统一控制，抽屉自己先让位 */
  onOpenPdf?: () => void
}) {
  const [notes, setNotes] = useState<any[]>([])
  const [tab, setTab] = usePersist('lit.detail.tab', 'notes')
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)
  const [newSec, setNewSec] = useState('')
  const [gstatus, setGstatus] = useState<any>(null)
  const [gres, setGres] = useState<any>(null)
  const [pdfPath, setPdfPath] = useState('')
  const [cands, setCands] = useState<any[]>([])
  const [gdir, setGdir] = useState('')
  const [gpdfdir, setGpdfdir] = useState('')
  const [absEdit, setAbsEdit] = useState<string | null>(null)
  const [dbusy, setDbusy] = useState('')

  const id = item?.id
  const status = item?.status || 'todo'

  const reloadNotes = async (lid: number) => setNotes(await get(`/literature/${lid}/notes`))

  // 换一篇文献就重新拉一遍：笔记 / PDF 路径 / Gloss 候选
  useEffect(() => {
    if (!item) return
    setPdfPath(item.pdf_path || '')
    setGres(null)
    setEditing(null)
    setAbsEdit(null)
    setDbusy('')
    ;(async () => {
      await reloadNotes(item.id)
      try {
        const st = await get('/gloss/status')
        setGstatus(st)
        setGdir(st.dir || '')
        setGpdfdir((st.pdf_dirs || []).join(';'))
        const f = await get(`/gloss/find?title=${encodeURIComponent(item.title)}`)
        setCands(f.candidates || [])
      } catch {
        setCands([])
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nonce])

  if (!item) return null

  const saveGlossCfg = async () => {
    setDbusy('gloss-cfg')
    try {
      setGstatus(await put('/gloss/config', { dir: gdir, pdf_dir: gpdfdir }))
    } finally {
      setDbusy('')
    }
  }

  const saveAbs = async () => {
    if (absEdit === null) return
    await patch(`/literature/${item.id}`, { notes: absEdit })
    setAbsEdit(null)
    onMutated?.()
  }

  const genNotes = async (section?: string) => {
    setDbusy(section ? 'sec-' + section : 'all')
    try {
      const r = await post(`/literature/${item.id}/digest`, section ? { section } : {})
      setNotes(r.notes || [])
    } finally {
      setDbusy('')
      onMutated?.()
    }
  }

  const addSection = async () => {
    if (!newSec.trim()) return
    await post(`/literature/${item.id}/notes`, { section: newSec.trim(), content: '' })
    setNewSec('')
    await reloadNotes(item.id)
  }

  const saveNote = async (nid: number, text: string) => {
    await patch(`/lit_notes/${nid}`, { content: text })
    setEditing(null)
    await reloadNotes(item.id)
  }

  const dropNote = async (nid: number) => {
    await del(`/lit_notes/${nid}`)
    await reloadNotes(item.id)
  }

  const savePdfPath = async () => {
    await patch(`/literature/${item.id}`, { pdf_path: pdfPath })
    onMutated?.()
  }

  const choosePdf = async (p: string) => {
    setPdfPath(p)
    await patch(`/literature/${item.id}`, { pdf_path: p })
    onMutated?.()
  }

  const startGloss = async () => {
    setDbusy('gloss-start')
    try {
      setGstatus(await post('/gloss/start'))
    } finally {
      setDbusy('')
    }
  }

  const openInGloss = async () => {
    setDbusy('gloss')
    try {
      const r = await post(`/literature/${item.id}/gloss`, { pdf_path: pdfPath })
      setGres(r)
      if (r.status) setGstatus(r.status)
      if (r.ok && r.url) window.open(r.url, '_blank')
    } finally {
      setDbusy('')
      onMutated?.()
    }
  }

  const TABS = [
    { k: 'notes', label: `笔记（${notes.length}）` },
    { k: 'gloss', label: 'Gloss 旁注' },
  ]

  return (
    <>
      <div className="fixed inset-0 z-30 bg-[rgba(16,24,40,0.28)]" onClick={onClose} />
      <div className="wb-anim-slide fixed right-0 top-0 z-40 flex h-full w-full max-w-[38rem] flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)]">
        {/* 第一行：标题 · 作者/年份 · 打开 PDF · 状态 · 关闭 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--wb-border)] px-4 py-2.5">
          <span
            className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[color:var(--wb-text)]"
            title={item.title}
          >
            {item.title}
          </span>
          {[item.authors, item.year, item.venue].filter(Boolean).join(' · ') && (
            <span
              className="max-w-[20rem] shrink-0 truncate text-[11.5px] text-[color:var(--wb-muted)]"
              title={[item.authors, item.year, item.venue].filter(Boolean).join(' · ')}
            >
              {[item.authors, item.year, item.venue].filter(Boolean).join(' · ')}
            </span>
          )}
          <Btn
            size="sm"
            onClick={() => {
              onClose()
              onOpenPdf?.()
            }}
            title="在页面正中的大窗口里打开 PDF"
          >
            全屏读 PDF
          </Btn>
          <Select
            value={status}
            onChange={(v) => onStatusChange?.(item.id, v)}
            options={STATUS}
          />
          <Btn variant="ghost" onClick={onClose}>
            关闭
          </Btn>
        </div>

        {/* 第二行：标签 */}
        <div className="flex shrink-0 gap-1 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-2">
          {TABS.map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`flex-1 rounded-[8px] px-2 py-1.5 text-[12px] transition ${
                tab === t.k
                  ? 'bg-[color:var(--wb-accent)] font-medium text-white'
                  : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 第三行：内容 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {tab === 'notes' ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Btn variant="primary" onClick={() => genNotes()} disabled={dbusy === 'all'}>
                  {dbusy === 'all' ? '生成中…' : notes.length ? '重新生成全部' : 'AI 生成笔记'}
                </Btn>
                <span className="text-[11.5px] text-[color:var(--wb-muted)]">
                  按小节分开存，每节可单独重生成 / 编辑
                </span>
              </div>

              {notes.length === 0 ? (
                <Empty text="还没有笔记，点上面的按钮生成" />
              ) : (
                notes.map((n: any) => (
                  <div
                    key={n.id}
                    className="rounded-[10px] border border-[color:var(--wb-border)] p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-medium text-[color:var(--wb-text)]">
                          {n.section}
                        </span>
                        <Pill tone={n.source === 'ai' ? 'blue' : 'gray'}>
                          {n.source === 'ai' ? 'AI' : '我'}
                        </Pill>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          title="只重新生成这一节"
                          onClick={() => genNotes(n.section)}
                          disabled={dbusy === 'sec-' + n.section}
                          className="rounded px-1.5 py-0.5 text-[12px] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)] disabled:opacity-40"
                        >
                          {dbusy === 'sec-' + n.section ? '…' : '↻'}
                        </button>
                        <button
                          onClick={() =>
                            setEditing(
                              editing?.id === n.id ? null : { id: n.id, text: n.content || '' },
                            )
                          }
                          className="rounded px-1.5 py-0.5 text-[12px] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]"
                        >
                          {editing?.id === n.id ? '取消' : '编辑'}
                        </button>
                        <button
                          onClick={() => dropNote(n.id)}
                          className="rounded px-1.5 py-0.5 text-[12px] text-[color:var(--wb-danger)] hover:bg-[color:var(--wb-danger-soft)]"
                        >
                          删除
                        </button>
                      </div>
                    </div>

                    {editing?.id === n.id ? (
                      <div className="mt-2 flex flex-col gap-2">
                        <TextArea
                          rows={6}
                          value={editing?.text ?? ''}
                          onChange={(v) => setEditing({ id: n.id, text: v })}
                        />
                        <div className="flex justify-end">
                          <Btn onClick={() => saveNote(n.id, editing?.text ?? '')}>保存</Btn>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1.5">
                        <MdBlock text={n.content || ''} />
                      </div>
                    )}
                  </div>
                ))
              )}

              <div className="flex items-center gap-2">
                <Input
                  placeholder="自己加一节，例：可复用的实验设置"
                  value={newSec}
                  onChange={setNewSec}
                />
                <Btn onClick={addSection} disabled={!newSec.trim()}>
                  加一节
                </Btn>
              </div>

              {(item.notes || absEdit !== null) && (
                <details className="rounded-[10px] border border-[color:var(--wb-border)] px-3 py-2">
                  <summary className="cursor-pointer text-[12px] text-[color:var(--wb-text-soft)]">
                    摘要 · 备注
                    <span className="ml-1 text-[11.5px] text-[color:var(--wb-muted)]">
                      （Zotero 摘要 / 历史备注，不会出现在列表里）
                    </span>
                  </summary>
                  {absEdit === null ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <MdBlock text={item.notes || ''} />
                      <div className="flex justify-end">
                        <Btn onClick={() => setAbsEdit(item.notes || '')}>编辑</Btn>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-col gap-2">
                      <TextArea rows={8} value={absEdit} onChange={setAbsEdit} />
                      <div className="flex justify-end gap-2">
                        <Btn variant="ghost" onClick={() => setAbsEdit(null)}>
                          取消
                        </Btn>
                        <Btn onClick={saveAbs}>保存</Btn>
                      </div>
                    </div>
                  )}
                </details>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-[10px] border border-[color:var(--wb-border)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium text-[color:var(--wb-text)]">
                    Gloss（旁注）
                  </span>
                  {gstatus?.running ? (
                    <Pill tone="green">已运行 · {gstatus.port}</Pill>
                  ) : gstatus?.installed ? (
                    <Pill tone="amber">未启动</Pill>
                  ) : (
                    <Pill tone="red">未找到</Pill>
                  )}
                </div>
                <div className="mt-1 text-[11.5px] text-[color:var(--wb-muted)]">
                  {gstatus?.dir || '—'}
                  {gstatus?.url ? ` · ${gstatus.url}` : ''}
                </div>
                {gstatus && !gstatus.running && (
                  <div className="mt-2">
                    <Btn onClick={startGloss} disabled={dbusy === 'gloss-start'}>
                      {dbusy === 'gloss-start' ? '启动中…' : '启动 Gloss'}
                    </Btn>
                  </div>
                )}

                <details className="mt-2">
                  <summary className="cursor-pointer text-[11.5px] text-[color:var(--wb-text-soft)]">
                    配置（Gloss 目录 / 找 PDF 的目录）
                  </summary>
                  <div className="mt-2 flex flex-col gap-2">
                    <Input placeholder="Gloss 项目目录" value={gdir} onChange={setGdir} />
                    <Input
                      placeholder="PDF 搜索目录（多个用 ; 隔开），例：D:\Zotero\storage"
                      value={gpdfdir}
                      onChange={setGpdfdir}
                    />
                    <div className="flex items-center gap-2">
                      <Btn onClick={saveGlossCfg}>保存配置</Btn>
                      {gstatus?.pdf_dirs?.length > 0 && (
                        <span className="text-[11.5px] text-[color:var(--wb-muted)]">
                          当前搜索：{gstatus.pdf_dirs.join(' , ')}
                        </span>
                      )}
                    </div>
                  </div>
                </details>
              </div>

              <div className="flex flex-col gap-2">
                <div className="text-[12.5px] font-medium text-[color:var(--wb-text)]">
                  这篇的 PDF
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="PDF 绝对路径，例：D:\Zotero\storage\ABCD\paper.pdf"
                    value={pdfPath}
                    onChange={setPdfPath}
                  />
                  <Btn
                    onClick={async () => {
                      await savePdfPath()
                      onClose()
                      onOpenPdf?.()
                    }}
                    title="保存路径并在页面正中的大窗口里打开"
                  >
                    保存并打开
                  </Btn>
                </div>
                {cands.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="text-[11.5px] text-[color:var(--wb-muted)]">
                      按标题在本地找到的候选（点一下填到上面）：
                    </div>
                    {cands.map((c: any) => (
                      <button
                        key={c.path}
                        onClick={() => setPdfPath(c.path)}
                        className={`truncate rounded-[8px] px-2 py-1 text-left text-[11.5px] ${
                          pdfPath === c.path
                            ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                            : 'bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-border)]'
                        }`}
                        title={c.path}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
                <Btn variant="primary" onClick={openInGloss} disabled={dbusy === 'gloss'}>
                  {dbusy === 'gloss' ? '正在送进 Gloss…' : '用 Gloss 打开 PDF'}
                </Btn>
                {gres && (
                  <div
                    className={`rounded-[10px] px-3 py-2 text-[12px] ${
                      gres.ok
                        ? 'bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]'
                        : 'bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]'
                    }`}
                  >
                    {gres.ok ? (
                      <div className="flex flex-col gap-1">
                        <div>
                          已导入 Gloss：{gres.title}
                          {gres.paper_id ? `（id ${gres.paper_id}）` : ''}
                        </div>
                        {gres.pdf && <div className="text-[11.5px]">{gres.pdf}</div>}
                        <a
                          href={gres.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11.5px] underline"
                        >
                          再打开一次 Gloss
                        </a>
                      </div>
                    ) : (
                      gres.message || '打开失败'
                    )}
                  </div>
                )}
              </div>

              {item.url && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] text-[color:var(--wb-accent)] underline"
                >
                  原文链接 / DOI
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
