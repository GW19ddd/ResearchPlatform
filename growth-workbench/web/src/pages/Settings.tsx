import { useEffect, useState } from 'react'
import { Btn, Card, Input, LoadError, Loading, Pill, Select } from '../components/ui'
import { del, get, post, put } from '../lib/api'
import BackupCard from '../features/settings/BackupCard'
import SuspectsCard from '../features/settings/SuspectsCard'

const ROUTING = [
  { value: 'all', label: '所有任务' },
  { value: 'fast', label: '仅轻量任务（话术、笔记、归类）' },
  { value: 'reason', label: '仅推理任务（头脑风暴、分析、汇总）' },
]

const HINTS: Record<string, string> = {
  openai: 'DeepSeek、本地 Qwen、以及绝大多数中转站都走这条。base_url 末尾不要带斜杠。',
  responses: 'Codex / GPT 系列走 Responses API。若你用 ChatGPT 账号登录的 Codex，需要一个本地代理把它转成标准端点。',
  ollama: 'Ollama 原生接口，不需要 API Key。默认 http://localhost:11434，可点「拉取模型」自动填。',
}

export default function Settings() {
  const [cfg, setCfg] = useState<any>(null)
  const [types, setTypes] = useState<any[]>([])
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [usage, setUsage] = useState<any[]>([])
  const [saved, setSaved] = useState('')
  const [openProv, setOpenProv] = useState<Set<string>>(new Set())

  const [dify, setDify] = useState<any>(null)
  const [difyMsg, setDifyMsg] = useState('')
  const [difySaved, setDifySaved] = useState('')
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [editApp, setEditApp] = useState<string | null>(null)

  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)

  const load = async () => {
    const c = await get('/settings/llm')
    setCfg({ default_provider: c.default_provider, providers: c.providers })
    setTypes(c.types)
    setUsage(await get('/settings/llm/usage'))
    setDify(await get('/settings/dify'))
  }

  const boot = async () => {
    setLoadErr(null)
    setBooting(true)
    try {
      await load()
    } catch (e: any) {
      setLoadErr(e?.message || '设置加载失败')
    } finally {
      setBooting(false)
    }
  }

  useEffect(() => {
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flash = (t: string) => {
    setSaved(t)
    setTimeout(() => setSaved(''), 2000)
  }

  const save = async () => {
    // 页面上有独立的「已保存」角标，不再重复弹 toast
    await put('/settings/llm', cfg, { ok: false })
    flash('已保存')
    load()
  }

  const patchProvider = (id: string, key: string, value: any) => {
    setCfg({
      ...cfg,
      providers: cfg.providers.map((p: any) => (p.id === id ? { ...p, [key]: value } : p)),
    })
  }

  const toggleProv = (id: string) => {
    const next = new Set(openProv)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpenProv(next)
  }

  const test = async (p: any) => {
    setMsg({ ...msg, [p.id]: '测试中…' })
    const r = await post('/settings/llm/test', p)
    setMsg({ ...msg, [p.id]: r.message })
  }

  const fetchModels = async (p: any) => {
    setMsg({ ...msg, [p.id]: '拉取模型列表…' })
    const r = await post('/settings/llm/models', p)
    if (!r.ok) {
      setMsg({ ...msg, [p.id]: r.message })
      return
    }
    if (r.models.length === 0) {
      setMsg({ ...msg, [p.id]: '没拉到模型，可能该端点不支持 /models 或 /api/tags' })
      return
    }
    setMsg({ ...msg, [p.id]: `可选：${r.models.slice(0, 8).join('、')}${r.models.length > 8 ? ' …' : ''}` })
    patchProvider(p.id, 'model_fast', r.models[0])
    patchProvider(p.id, 'model_reason', r.models[0])
  }

  const addProvider = async () => {
    const p = {
      name: '新供应商',
      type: 'openai',
      base_url: 'https://api.xxx.com/v1',
      api_key: '',
      model_fast: '',
      model_reason: '',
      routing: 'all',
      enabled: true,
    }
    const r = await post('/settings/llm/providers', p)
    setCfg({ default_provider: r.config.default_provider, providers: r.config.providers })
    setOpenProv(new Set([...openProv, r.provider?.id || p.name]))
  }

  const remove = async (id: string) => {
    const r = await del(`/settings/llm/providers/${id}`)
    setCfg({ default_provider: r.config.default_provider, providers: r.config.providers })
  }

  const makeDefault = async (id: string) => {
    const r = await post(`/settings/llm/providers/${id}/default`)
    setCfg({ default_provider: r.config.default_provider, providers: r.config.providers })
  }

  // ---------- Dify ----------
  const saveDify = async () => {
    await put(
      '/settings/dify',
      {
        enabled: !!dify?.enabled,
        base_url: dify?.base_url || '',
        apps: dify?.apps || [],
      },
      { ok: false },
    )
    setDifySaved('已保存')
    setKeyDraft({})
    setEditApp(null)
    setTimeout(() => setDifySaved(''), 2000)
    load()
  }

  const patchApp = (i: number, key: string, value: any) => {
    const apps = [...(dify?.apps || [])]
    apps[i] = { ...apps[i], [key]: value }
    setDify({ ...dify, apps })
  }

  const addDifyApp = async () => {
    const r = await post('/settings/dify/apps', { name: '新应用', api_key: '', mode: 'workflow' })
    setDify(r.config)
    setEditApp(r.app?.id || null)
  }

  const removeApp = async (i: number) => {
    const a = (dify?.apps || [])[i]
    if (!a) return
    const r = await del(`/settings/dify/apps/${a.id}`)
    setDify(r.config)
    if (editApp === a.id) setEditApp(null)
  }

  const cancelEditApp = (i: number) => {
    // 还原为服务端已保存的值（丢弃本地未保存修改）
    const id = (dify?.apps || [])[i]?.id
    setEditApp(null)
    setKeyDraft((d) => {
      const n = { ...d }
      delete n[id]
      return n
    })
    load()
  }

  if (loadErr) return <LoadError error={loadErr} onRetry={boot} retrying={booting} what="设置" />
  if (!cfg) return <Loading text="正在加载设置…" />

  return (
    <div className="flex flex-col gap-4">
      {/* ============ ① API 设置（模型供应商） ============ */}
      <Card
        title="① API 设置 · 模型供应商"
        extra={
          <div className="flex items-center gap-2">
            {saved && <span className="text-[12px] text-emerald-600">{saved}</span>}
            <Btn onClick={addProvider}>新增供应商</Btn>
          </div>
        }
      >
        <p className="text-[12px] leading-relaxed text-slate-500">
          DeepSeek、OpenAI/Codex、Ollama、本地 Qwen、任意中转站——都只是列表里的一条记录，统一在这里增删改。
          选中的「默认」供应商处理所有任务，也可以用「用途」把轻量/推理任务分派给不同供应商。配置存本地数据库，保存即生效。
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {cfg.providers.length === 0 && (
            <p className="text-[12px] text-slate-400">还没有供应商，点右上角「新增供应商」。</p>
          )}
          {cfg.providers.map((p: any) => {
            const isDefault = cfg.default_provider === p.id
            const isOpen = openProv.has(p.id)
            return (
              <div key={p.id} className="rounded-lg border border-slate-200">
                {/* 收起态：一行摘要 */}
                <div className="flex flex-wrap items-center gap-2 p-3">
                  <button
                    className="text-[13px] font-medium text-slate-900 hover:underline"
                    onClick={() => toggleProv(p.id)}
                  >
                    {isOpen ? '▾' : '▸'} {p.name}
                  </button>
                  <span className="text-[11px] text-slate-400">
                    {types.find((t: any) => t.value === p.type)?.label || p.type} · {p.base_url}
                  </span>
                  {isDefault && <Pill tone="green">默认</Pill>}
                  {!p.enabled && <Pill tone="gray">已停用</Pill>}
                  <span className="flex-1" />
                  <Btn onClick={() => toggleProv(p.id)}>{isOpen ? '收起' : '编辑'}</Btn>
                  <Btn onClick={() => makeDefault(p.id)} disabled={isDefault}>
                    设为默认
                  </Btn>
                  <Btn variant="danger" onClick={() => remove(p.id)}>
                    删除
                  </Btn>
                </div>

                {/* 展开态：完整编辑 */}
                {isOpen && (
                  <div className="border-t border-slate-100 p-3">
                    <div className="grid gap-2 md:grid-cols-2">
                      <label className="block">
                        <span className="text-[11px] text-slate-500">名称</span>
                        <Input value={p.name} onChange={(v) => patchProvider(p.id, 'name', v)} />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">类型</span>
                        <Select
                          value={p.type}
                          onChange={(v) => patchProvider(p.id, 'type', v)}
                          options={types}
                        />
                      </label>
                      <label className="block md:col-span-2">
                        <span className="text-[11px] text-slate-500">Base URL</span>
                        <Input value={p.base_url} onChange={(v) => patchProvider(p.id, 'base_url', v)} />
                      </label>
                      <label className="block md:col-span-2">
                        <span className="text-[11px] text-slate-500">API Key（Ollama 可留空）</span>
                        <Input
                          type="password"
                          value={p.api_key}
                          onChange={(v) => patchProvider(p.id, 'api_key', v)}
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">轻量任务模型</span>
                        <Input
                          value={p.model_fast}
                          onChange={(v) => patchProvider(p.id, 'model_fast', v)}
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">推理任务模型</span>
                        <Input
                          value={p.model_reason}
                          onChange={(v) => patchProvider(p.id, 'model_reason', v)}
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">用途分派</span>
                        <Select
                          value={p.routing || 'all'}
                          onChange={(v) => patchProvider(p.id, 'routing', v)}
                          options={ROUTING}
                        />
                      </label>
                      <label className="flex items-center gap-2 pt-4 text-[12px] text-slate-600">
                        <input
                          type="checkbox"
                          checked={!!p.enabled}
                          onChange={(e) => patchProvider(p.id, 'enabled', e.target.checked)}
                        />
                        启用
                      </label>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <Btn onClick={() => test(p)}>测试连接</Btn>
                      <Btn onClick={() => fetchModels(p)}>拉取模型列表</Btn>
                      <Btn variant="primary" onClick={save}>
                        保存
                      </Btn>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-400">{HINTS[p.type] || ''}</p>
                    {msg[p.id] && (
                      <p
                        className={`mt-1 text-[11px] ${
                          msg[p.id].startsWith('连通正常') ? 'text-emerald-600' : 'text-slate-500'
                        }`}
                      >
                        {msg[p.id]}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      {/* ============ ② Dify 设置 ============ */}
      <Card
        title="② Dify 设置"
        extra={
          <div className="flex items-center gap-2">
            {difySaved && <span className="text-[12px] text-emerald-600">{difySaved}</span>}
            <Btn onClick={addDifyApp}>新增应用</Btn>
            <Btn variant="primary" onClick={saveDify}>
              保存全部
            </Btn>
          </div>
        }
      >
        <p className="text-[12px] leading-relaxed text-slate-500">
          填一次，画布里的 Dify 节点就能直接用。地址填 Dify 的 API 入口（本机 docker 部署一般是{' '}
          <code className="rounded bg-slate-100 px-1">http://localhost/v1</code>）。
        </p>

        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <label className="flex items-center gap-2 text-[12px] text-slate-600">
            <input
              type="checkbox"
              checked={!!dify?.enabled}
              onChange={(e) => setDify({ ...dify, enabled: e.target.checked })}
            />
            启用 Dify 节点
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-500">API 地址</span>
            <Input
              value={dify?.base_url || ''}
              onChange={(v) => setDify({ ...dify, base_url: v })}
              placeholder="http://localhost/v1"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn
            onClick={async () => {
              setDifyMsg('测试中…')
              const r = await post(
                '/settings/dify/test',
                {
                  base_url: dify?.base_url || '',
                },
                { ok: false },
              )
              setDifyMsg(r.message)
            }}
          >
            测试连接
          </Btn>
          {difyMsg && (
            <span
              className={`text-[11px] ${difyMsg.startsWith('地址不通') || difyMsg.includes('失败') ? 'text-rose-600' : 'text-slate-500'}`}
            >
              {difyMsg}
            </span>
          )}
        </div>

        {/* 已保存的应用：列表 + 编辑态 */}
        <div className="mt-4 flex flex-col gap-2">
          {(dify?.apps || []).length === 0 && (
            <p className="text-[12px] text-slate-400">
              还没有应用。在 Dify 里发布 workflow → 右上角「访问 API」拿 Key → 点「新增应用」填进来。
            </p>
          )}
          {(dify?.apps || []).map((a: any, i: number) => {
            const editing = editApp === a.id
            return (
              <div key={a.id} className="rounded-lg border border-slate-200 p-3">
                {!editing ? (
                  /* 只读态 */
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-slate-900">{a.name}</span>
                    <span className="text-[11px] text-slate-400">
                      {a.mode === 'chat' ? '对话应用' : '工作流'}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Key：{a.api_key_masked || '未填'}
                    </span>
                    <span className="flex-1" />
                    <Btn onClick={() => setEditApp(a.id)}>编辑</Btn>
                    <Btn
                      onClick={async () => {
                        setDifyMsg('测试中…')
                        const r = await post(
                          '/settings/dify/test',
                          {
                            base_url: dify?.base_url || '',
                            app_id: a.id,
                          },
                          { ok: false },
                        )
                        setDifyMsg(`${a.name}：${r.message}`)
                      }}
                    >
                      测试
                    </Btn>
                    <Btn variant="danger" onClick={() => removeApp(i)}>
                      删除
                    </Btn>
                  </div>
                ) : (
                  /* 编辑态 */
                  <>
                    <div className="grid gap-2 md:grid-cols-3">
                      <label className="block">
                        <span className="text-[11px] text-slate-500">应用名称</span>
                        <Input
                          value={a.name}
                          onChange={(v) => patchApp(i, 'name', v)}
                          placeholder="例：选题工作流"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">类型</span>
                        <Select
                          value={a.mode || 'workflow'}
                          onChange={(v) => patchApp(i, 'mode', v)}
                          options={[
                            { value: 'workflow', label: '工作流' },
                            { value: 'chat', label: '对话应用' },
                          ]}
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] text-slate-500">
                          API Key{`（当前：${a.api_key_masked || '未填'}）`}
                        </span>
                        <Input
                          type="password"
                          value={keyDraft[a.id] ?? ''}
                          onChange={(v) => {
                            setKeyDraft({ ...keyDraft, [a.id]: v })
                            patchApp(i, 'api_key', v)
                          }}
                          placeholder={a.api_key_masked ? '粘贴新密钥可替换' : '粘贴 app- 开头的密钥'}
                        />
                      </label>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Btn
                        onClick={async () => {
                          setDifyMsg('测试中…')
                          const r = await post(
                            '/settings/dify/test',
                            {
                              base_url: dify?.base_url || '',
                              app_id: a.id,
                              api_key: keyDraft[a.id] || '',
                            },
                            { ok: false },
                          )
                          setDifyMsg(`${a.name}：${r.message}`)
                        }}
                      >
                        测试这个应用
                      </Btn>
                      <Btn variant="primary" onClick={saveDify}>
                        保存
                      </Btn>
                      <Btn variant="ghost" onClick={() => cancelEditApp(i)}>
                        取消
                      </Btn>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      <Card title="调用统计">
        {usage.length === 0 ? (
          <p className="text-[12px] text-slate-400">还没有调用记录</p>
        ) : (
          <div className="flex flex-col gap-1">
            {usage.map((u: any) => (
              <div key={u.provider} className="flex justify-between text-[12px] text-slate-600">
                <span>{u.provider}</span>
                <span className="text-slate-400">
                  {u.n} 次 · 入 {u.tin || 0} / 出 {u.tout || 0} tokens
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-400">
          统计范围：本地全部历史调用（自数据库建立起），按 provider 聚合，不区分成功与失败。
        </p>
      </Card>

      <BackupCard />
      <SuspectsCard />
    </div>
  )
}
