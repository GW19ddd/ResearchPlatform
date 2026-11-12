/**
 * 数据源 · Consensus：共识检索（同行评审文献 + AI 结论 takeaway）的 API key。
 *
 * Consensus.app 的 REST 检索：GET api.consensus.app/v1/search，头 x-api-key。
 * ⚠️ 2026-11-12 实测：无 key 一律 401，官方已收回匿名 3 篇模式，key 是硬门槛。
 * 额度：Free 每次 10 篇 / 月 30 次；Pro 及以上才返回论文结论 takeaway、study_type 等字段。
 * 免费申请：consensus.app → 头像 → API & MCP Dashboard → Keys and Clients。
 */
import { useEffect, useState } from 'react'
import { Btn, Card, Input, Pill } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { del, get, post, put } from '../../lib/api'

type State = {
  has_key: boolean
  key_masked: string
  from_env: boolean
  signup_url?: string
  last_err?: string
}

export default function ConsensusCard() {
  const [s, setS] = useState<State | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      setS(await get<State>('/consensus'))
    } catch (e: any) {
      setErr(e?.message || '读取失败')
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    const k = draft.trim()
    if (!k) return
    if (/^(https?:\/\/|ftp:\/\/|localhost)/i.test(k)) {
      setErr('这看起来是一个网址，不是 API key（key 形如 2a3b… 的随机串）。请到 consensus.app 的 API Dashboard 生成后粘贴。')
      return
    }
    setBusy('save')
    setErr('')
    try {
      setS(await put<State>('/consensus', { api_key: k }, { ok: 'API key 已保存' }))
      setDraft('')
      setNote('已保存，下一次共识检索自动生效')
    } catch (e: any) {
      setErr(e?.message || '保存失败')
    } finally {
      setBusy('')
    }
  }

  const clear = async () => {
    if (!window.confirm('清除已保存的 Consensus API key？清除后无 key 状态下将无法检索（Consensus 强制鉴权）。')) return
    setBusy('clear')
    try {
      setS(await del<State>('/consensus', { ok: '已清除' }))
      setNote('已退回无 key 模式')
    } catch (e: any) {
      setErr(e?.message || '清除失败')
    } finally {
      setBusy('')
    }
  }

  const test = async () => {
    setBusy('test')
    setErr('')
    try {
      const r: any = await post('/consensus/test', {}, { silent: true })
      setNote(r?.ok ? r.message : `${r?.message || '探测失败'}${r?.hint ? ' · ' + r.hint : ''}`)
      if (r) setS((prev) => (prev ? { ...prev, ...r } : prev))
      await load()
    } catch (e: any) {
      setErr(e?.message || '探测失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <Card
      title="数据源 · Consensus"
      extra={
        <Btn size="xs" onClick={test} disabled={!!busy}>
          <Icon name="refresh" size={12} />
          {busy === 'test' ? '探测中…' : '测试连接'}
        </Btn>
      }
    >
      <p className="text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
        共识检索（Consensus.app）直接检索 2 亿+ 同行评审文献，并给出每篇论文的结论
        <b className="text-[color:var(--wb-text)]"> takeaway</b>。
        <b className="text-[color:var(--wb-text)]">Consensus 现在强制鉴权：不配置 key 无法检索</b>
        （2026-11 起官方已收回匿名模式）；免费档每次 10 篇、每月 30 次；Pro 档起才有 takeaway 等字段。
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px]">
        {s?.has_key ? (
          <Pill tone="green">已配置 {s.key_masked}</Pill>
        ) : (
          <Pill tone="gray">未配置 key · 无法检索</Pill>
        )}
        {s?.from_env && <Pill tone="gray">环境变量优先</Pill>}
        {s?.last_err && <span className="text-[color:var(--wb-danger)]">{s.last_err}</span>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="min-w-[240px] flex-1">
          <Input
            value={draft}
            onChange={setDraft}
            placeholder={s?.has_key ? '粘贴新 key 可替换现有的' : '粘贴 Consensus API key（形如 2a3b…）'}
          />
        </div>
        <Btn variant="primary" size="sm" onClick={save} disabled={!draft.trim() || !!busy}>
          保存
        </Btn>
        {s?.has_key && !s?.from_env && (
          <Btn size="sm" onClick={clear} disabled={!!busy}>
            清除
          </Btn>
        )}
        <a
          href={s?.signup_url || 'https://consensus.app/app/dashboard/api'}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11.5px] text-[color:var(--wb-accent)] hover:underline"
        >
          <Icon name="link" size={12} />
          免费申请 key
        </a>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
        也可以不填：设环境变量 <code className="rounded bg-[color:var(--wb-bg-subtle)] px-1">CONSENSUS_API_KEY</code>{' '}
        后重启后端，效果相同（环境变量优先于这里保存的值）。
      </p>

      {note && <p className="mt-2 text-[11.5px] text-[color:var(--wb-ok)]">{note}</p>}
      {err && <p className="mt-2 text-[11.5px] text-[color:var(--wb-danger)]">{err}</p>}
    </Card>
  )
}
