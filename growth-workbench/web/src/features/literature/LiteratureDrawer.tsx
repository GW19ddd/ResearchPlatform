/**
 * 文献详情抽屉：分段笔记 + Gloss 旁注。
 *
 * 从 pages/Literature.tsx 拆出来的独立组件：它自己管笔记、PDF 路径、Gloss 状态，
 * 对外只暴露「传入哪条文献 / 关闭 / 写操作后通知外层刷新 / 打开居中 PDF」几个口子。
 * PDF 阅读本身不在这里 —— 那是一个居中的大浮层（PdfModal），侧栏只留给文字类内容。
 */
import { useEffect, useRef, useState } from 'react'
import { Btn, Empty, IconBtn, Input, MdBlock, Pill, Select, TextArea, usePresence } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { AiError } from '../../components/AiError'
import { toast } from '../../components/toast'
import { del, get, patch, post, put } from '../../lib/api'
import { usePersist } from '../../lib/state'
import { STATUS } from './literature-shared'

export default function LiteratureDrawer({
  item: _item,
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
  /** 关闭时保留最后一次 item：先播退出动画再卸载，期间内容不会突然变空。
   *  prop 改名 _item 后重新声明 item，组件内所有 item.xxx 引用都不用改。 */
  const lastItem = useRef<any>(null)
  if (_item) lastItem.current = _item
  const presence = usePresence(!!_item, 200)
  const item = _item || lastItem.current

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
  // 痛点（阶段③：文献 → 痛点表 → 备选创新点）
  const [pps, setPps] = useState<any[]>([])
  const [ppFocus, setPpFocus] = useState('')
  const [ppBusy, setPpBusy] = useState(false)
  const [ppErr, setPpErr] = useState<any>(null)

  const id = item?.id
  const status = item?.status || 'todo'

  const reloadNotes = async (lid: number) => setNotes(await get(`/literature/${lid}/notes`))

  const reloadPps = async (lid: number) => {
    const all = await get('/painpoints')
    setPps((all as any[]).filter((p) => p.literature_id === lid))
  }

  // 换一篇文献就重新拉一遍：笔记 / PDF 路径 / Gloss 候选
  useEffect(() => {
    if (!item) return
    setPdfPath(item.pdf_path || '')
    setGres(null)
    setEditing(null)
    setAbsEdit(null)
    setDbusy('')
    setPpErr(null)
    ;(async () => {
      await reloadNotes(item.id)
      reloadPps(item.id).catch(() => setPps([]))
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

  if (!presence.mounted || !item) return null

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

  const extractPps = async () => {
    setPpBusy(true)
    setPpErr(null)
    try {
      const r: any = await post(
        `/literature/${item.id}/painpoints`,
        { focus: ppFocus.trim() || null },
        { ok: false },
      )
      if (r && r.ok === false) {
        setPpErr(r.error || { kind: 'unknown', label: '提炼没有跑通', message: '请重试' })
      } else {
        toast(r.items?.length ? `提炼出 ${r.items.length} 条痛点` : '这篇没有提炼出有支撑的痛点', r.items?.length ? 'ok' : 'info')
      }
      await reloadPps(item.id)
    } catch (e: any) {
      setPpErr(e?.body?.error || { kind: 'network', label: '请求失败', message: String(e) })
    } finally {
      setPpBusy(false)
    }
  }

  const ppToIdea = async (pid: number) => {
    await post(`/painpoints/${pid}/to-idea`, {})
    toast('已转为创新点（创新点页可见）', 'ok')
    await reloadPps(item.id)
  }

  const dropPp = async (pid: number) => {
    await del(`/painpoints/${pid}`)
    await reloadPps(item.id)
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
    { k: 'painpoints', label: `痛点（${pps.length}）` },
    { k: 'gloss', label: 'Gloss 旁注' },
  ]

  return (
    <>
      <div
        className={`fixed inset-0 z-30 bg-[rgba(16,24,40,0.28)] ${presence.leaving ? 'wb-overlay-out pointer-events-none' : 'wb-overlay-in'}`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 z-40 flex h-full w-full max-w-[38rem] flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)] ${presence.leaving ? 'wb-drawer-out pointer-events-none' : 'wb-drawer-in'}`}
      >
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
                        <IconBtn
                          icon="refresh"
                          size="sm"
                          title="只重新生成这一节"
                          disabled={dbusy === 'sec-' + n.section}
                          onClick={() => genNotes(n.section)}
                        />
                        <Btn
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setEditing(
                              editing?.id === n.id ? null : { id: n.id, text: n.content || '' },
                            )
                          }
                        >
                          {editing?.id === n.id ? '取消' : '编辑'}
                        </Btn>
                        <Btn size="xs" variant="danger" onClick={() => dropNote(n.id)}>
                          删除
                        </Btn>
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
          ) : tab === 'painpoints' ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Btn variant="primary" onClick={extractPps} loading={ppBusy} disabled={!item.id}>
                    {ppBusy ? '提炼中…' : pps.length ? '重新提炼痛点' : 'AI 提炼痛点'}
                  </Btn>
                  <Input
                    placeholder="侧重（可选），例：关注训练效率的局限"
                    value={ppFocus}
                    onChange={setPpFocus}
                  />
                </div>
                <span className="text-[11.5px] text-[color:var(--wb-muted)]">
                  从这篇文献提炼「研究机会」视角的痛点，逐条带原文证据；转成创新点后会带文献出处。
                </span>
              </div>

              {ppErr && (
                <AiError error={ppErr} onRetry={extractPps} retrying={ppBusy} title="痛点提炼没有跑通" />
              )}

              {pps.length === 0 && !ppBusy ? (
                <Empty text="这篇还没有痛点记录" hint="提炼出来的痛点是「文献 → 备选创新点」流水线的原料，可在创新点页一键转正。" />
              ) : (
                pps.map((p) => (
                  <div key={p.id} className="rounded-[10px] border border-[color:var(--wb-border)] p-3">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--wb-warn-soft)] text-[color:var(--wb-warn)]">
                        <Icon name="alert" size={11} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] leading-relaxed text-[color:var(--wb-text)]">{p.content}</div>
                        {p.evidence && (
                          <div className="mt-1.5 border-l-2 border-[color:var(--wb-border)] pl-2 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                            证据：{p.evidence}
                          </div>
                        )}
                        {p.direction && (
                          <div className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-accent)]">
                            方向：{p.direction}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {p.status === 'converted' ? (
                          <Pill tone="green">已转创新点</Pill>
                        ) : (
                          <Btn size="xs" variant="primary" onClick={() => ppToIdea(p.id)}>
                            转创新点
                          </Btn>
                        )}
                        <IconBtn icon="trash" size="sm" tone="danger" title="删除该痛点" onClick={() => dropPp(p.id)} />
                      </div>
                    </div>
                  </div>
                ))
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
