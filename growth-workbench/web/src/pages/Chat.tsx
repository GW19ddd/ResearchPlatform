import { useEffect, useRef, useState } from 'react'
import { Btn, Card, Empty, Input, MdBlock, Select, TextArea } from '../components/ui'
import { aiErrorOf } from '../components/AiError'
import { del, get, patch, post } from '../lib/api'
import { usePersist } from '../lib/state'

const STARTERS = [
  '我的创新点池里，最值得先做的是哪个？给理由',
  '把当前最靠谱的创新点拆成三步可验证实验',
  '挑我文献库里最该先读的 3 篇，说为什么',
  '用审稿人的眼光挑我这个方向的三个致命漏洞',
  '帮我写一段这周组会汇报的开场（两分钟版）',
]

type Msg = {
  id: number
  role: string
  content: string
  provider?: string
  model?: string
  tokens_out?: number
}

export default function Chat() {
  const [sessions, setSessions] = useState<any[]>([])
  const [sid, setSid] = usePersist<number | null>('chat.sid', null)
  const [detail, setDetail] = useState<any>(null)
  const [roles, setRoles] = useState<{ value: string; label: string }[]>([])
  const [ctxOptions, setCtxOptions] = useState<{ value: string; label: string }[]>([])
  const [input, setInput] = usePersist('chat.input', '')
  const [busy, setBusy] = useState('')
  const [mode, setMode] = usePersist('chat.mode', 'fast')
  const [role, setRole] = usePersist('chat.role', 'assistant')
  const [ctxKeys, setCtxKeys] = usePersist<string[]>('chat.ctx', ['ideas'])
  const [showCtx, setShowCtx] = useState(false)
  const [err, setErr] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadSessions = async () => setSessions(await get('/chat/sessions'))

  const open = async (id: number) => {
    setSid(id)
    const d = await get(`/chat/sessions/${id}`)
    setDetail(d)
    if (d?.role) setRole(d.role)
    scrollDown()
  }

  const scrollDown = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 60)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      get('/chat/roles').then((r) => setRoles(r.roles || []))
      get('/chat/context/options').then((r) => setCtxOptions(r.options || []))
      const list = await get('/chat/sessions')
      if (cancelled) return
      setSessions(list || [])
      const cur = Number(localStorage.getItem('wb:chat.sid') || 0)
      if (cur && (list || []).some((s: any) => s.id === cur)) {
        await open(cur)
        return
      }
      // 会话列表里还有，但没选中过 → 打开最近一个
      if ((list || []).length > 0) {
        await open(list[0].id)
        return
      }
      // 一条都没有 → 直接建一个，页面进来就能聊
      await newSession()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const newSession = async () => {
    const s = await post('/chat/sessions', {
      title: '',
      role,
      mode,
      context_keys: ctxKeys,
    })
    await loadSessions()
    await open(s.id)
  }

  const send = async (regenerate = false, override?: string) => {
    if (!sid) return
    const text = (override ?? input).trim()
    if (!regenerate && !text) return
    setBusy('send')
    setErr('')
    if (!regenerate) setInput('')
    // 先把用户消息顶到界面上，避免长时间等待看起来像卡住
    if (!regenerate && detail) {
      setDetail({
        ...detail,
        messages: [
          ...detail.messages,
          { id: -Date.now(), role: 'user', content: text },
          { id: -Date.now() + 1, role: 'assistant', content: '思考中…' },
        ],
      })
      scrollDown()
    }
    try {
      const r = await post(
        `/chat/sessions/${sid}/messages`,
        {
          content: text,
          mode,
          regenerate,
        },
        // 回复本身会渲染出来，再弹一次「已保存」是噪音
        { ok: false },
      )
      // 失败时后端不落任何助手消息：这里把原因说清楚，输入框内容原样保留
      if (r.ok === false) {
        const e = aiErrorOf(r)
        setErr([e.label, e.message, e.hint].filter(Boolean).join(' · '))
      } else setErr('')
      const d = await get(`/chat/sessions/${sid}`)
      setDetail(d)
      loadSessions()
      scrollDown()
    } catch (e: any) {
      setErr(String(e?.message || e))
      const d = await get(`/chat/sessions/${sid}`)
      setDetail(d)
    } finally {
      setBusy('')
    }
  }

  const applyRole = async (v: string) => {
    setRole(v)
    if (sid) {
      await patch(`/chat/sessions/${sid}`, { role: v })
      setDetail(await get(`/chat/sessions/${sid}`))
    }
  }

  const refreshCtx = async () => {
    if (!sid) return
    setBusy('ctx')
    await patch(`/chat/sessions/${sid}`, { context_keys: ctxKeys })
    setDetail(await get(`/chat/sessions/${sid}`))
    setBusy('')
    setShowCtx(false)
  }

  const remove = async (id: number) => {
    await del(`/chat/sessions/${id}`)
    if (sid === id) {
      setSid(null)
      setDetail(null)
    }
    loadSessions()
  }

  const exportMd = async () => {
    if (!sid) return
    const r = await post(`/chat/sessions/${sid}/export`, {})
    const blob = new Blob([r.markdown || ''], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${r.title || '对话'}.md`
    a.click()
  }

  const clear = async () => {
    if (!sid) return
    await post(`/chat/sessions/${sid}/clear`, {}, { ok: '已清空对话' })
    setDetail(await get(`/chat/sessions/${sid}`))
    loadSessions()
  }

  const msgs: Msg[] = detail?.messages || []

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        <Card
          title={`会话（${sessions.length}）`}
          extra={
            <Btn variant="primary" onClick={newSession}>
              新建
            </Btn>
          }
        >
          <div className="flex flex-col gap-1">
            {sessions.length === 0 ? (
              <Empty text="还没有对话" />
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] ${
                    sid === s.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <button onClick={() => open(s.id)} className="min-w-0 flex-1 text-left">
                    <div className="truncate">{s.title || '新对话'}</div>
                    <div
                      className={`text-[10px] ${
                        sid === s.id ? 'text-slate-300' : 'text-slate-400'
                      }`}
                    >
                      {s.msg_count || 0} 条 · {roles.find((r) => r.value === s.role)?.label || '助手'}
                    </div>
                  </button>
                  <button
                    onClick={() => remove(s.id)}
                    className="shrink-0 text-[11px] text-slate-400 opacity-0 hover:text-rose-500 group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <Card
            title={detail?.title || '对话'}
            extra={
              <div className="flex flex-wrap items-center gap-2">
                <Select value={role} onChange={applyRole} options={roles} />
                <Select
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'fast', label: '快模型' },
                    { value: 'reason', label: '推理模型（慢·深）' },
                  ]}
                />
                <Btn onClick={() => setShowCtx(!showCtx)}>
                  {showCtx ? '收起上下文' : '上下文'}
                </Btn>
                {sid && (
                  <>
                    <Btn onClick={clear}>清空记录</Btn>
                    <Btn onClick={exportMd}>导出 MD</Btn>
                  </>
                )}
              </div>
            }
          >
            {showCtx && (
              <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] text-slate-500">
                  勾选要塞进对话背景的工作台数据（会自动拼进 system prompt）：
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {ctxOptions.map((o) => (
                    <button
                      key={o.value}
                      onClick={() =>
                        setCtxKeys(
                          ctxKeys.includes(o.value)
                            ? ctxKeys.filter((k) => k !== o.value)
                            : [...ctxKeys, o.value]
                        )
                      }
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        ctxKeys.includes(o.value)
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                          : 'border-slate-200 text-slate-500'
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex justify-end">
                  <Btn variant="primary" onClick={refreshCtx} disabled={busy === 'ctx'}>
                    {busy === 'ctx' ? '写入中…' : '应用到这个对话'}
                  </Btn>
                </div>
              </div>
            )}

            {!sid ? (
              <Empty text="左侧点「新建」开一轮对话，或直接选一个已有会话" />
            ) : msgs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 px-3 py-6">
                <div className="text-center text-[12px] text-slate-500">
                  当前角色：<b>{roles.find((r) => r.value === role)?.label || '科研助手'}</b>
                  {ctxKeys.length > 0 && ' · 已带入工作台上下文'}
                  <br />
                  点下面的问题直接开聊，或自己在下面输入框写
                </div>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {STARTERS.map((q) => (
                    <button
                      key={q}
                      onClick={() => {
                        setInput(q)
                        setTimeout(() => send(false, q), 30)
                      }}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-600 hover:border-slate-400 hover:text-slate-900"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pr-1">
                {msgs.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-[13px] ${
                        m.role === 'user'
                          ? 'bg-slate-900 text-white'
                          : 'border border-slate-200 bg-white text-slate-800'
                      }`}
                    >
                      {m.role === 'user' ? (
                        <div className="whitespace-pre-wrap">{m.content}</div>
                      ) : (
                        <MdBlock text={m.content} />
                      )}
                      {m.role === 'assistant' && m.model && (
                        <div className="mt-1 text-[10px] text-slate-400">
                          {m.model}
                          {m.tokens_out ? ` · ${m.tokens_out} tokens` : ''}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}

            {err && (
              <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[12px] text-rose-600">
                {err}
              </div>
            )}

            {sid && (
              <div className="mt-3 flex flex-col gap-2">
                <TextArea
                  rows={3}
                  placeholder="Enter 发送，Shift+Enter 换行"
                  value={input}
                  onChange={setInput}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send(false)
                    }
                  }}
                />
                <div className="flex items-center gap-2">
                  <Btn variant="primary" onClick={() => send(false)} disabled={busy === 'send' || !input.trim()}>
                    {busy === 'send' ? '思考中…' : '发送'}
                  </Btn>
                  <Btn onClick={() => send(true)} disabled={busy === 'send' || msgs.length === 0}>
                    重跑上一条
                  </Btn>
                  <span className="text-[11px] text-slate-400">
                    {mode === 'reason' ? '推理模式通常要等 20-40 秒' : '快模式一般几秒内回'}
                  </span>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
