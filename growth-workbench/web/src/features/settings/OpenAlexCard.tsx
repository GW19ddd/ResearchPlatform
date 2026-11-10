/**
 * 数据源 · OpenAlex：文献检索引擎的额度与 API key。
 *
 * 为什么需要这张卡：OpenAlex 从 2025 年底起改成按额度计费，不带 key 时
 * 所有请求共享「出口 IP 那一份」每日 $0.10 免费池（约 100 次关键词检索），
 * `mailto` 已不提额。额度打空后检索页会一直停在 429。
 * 免费申请一支 key 就有独立的 $1/天（约 1000 次检索），本卡负责填/换/清。
 */
import { useEffect, useState } from 'react'
import { Btn, Card, Input, Pill } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { del, get, post, put } from '../../lib/api'

type Quota = {
  has_key: boolean
  key_masked: string
  from_env: boolean
  remaining: string | number | null
  limit: string | number | null
  remaining_usd: string | null
  reset_in: number
  signup_url?: string
}

function humanWait(sec: number): string {
  if (!sec || sec <= 0) return '——'
  if (sec < 120) return `${sec} 秒`
  if (sec < 7200) return `${Math.max(1, Math.round(sec / 60))} 分钟`
  return `${Math.max(1, Math.round(sec / 3600))} 小时`
}

export default function OpenAlexCard() {
  const [q, setQ] = useState<Quota | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  const load = async () => {
    try {
      setQ(await get<Quota>('/settings/openalex'))
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
    setBusy('save')
    setErr('')
    try {
      setQ(await put<Quota>('/settings/openalex', { api_key: k }, { ok: 'API key 已保存' }))
      setDraft('')
      setNote('已保存，下一次检索自动生效')
    } catch (e: any) {
      setErr(e?.message || '保存失败')
    } finally {
      setBusy('')
    }
  }

  const clear = async () => {
    if (!window.confirm('清除已保存的 OpenAlex API key？清除后会退回共享的每日 $0.10 额度。')) return
    setBusy('clear')
    try {
      setQ(await del<Quota>('/settings/openalex', { ok: '已清除' }))
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
      const r: any = await post('/settings/openalex/test', {}, { silent: true })
      setNote(r?.ok ? r.message : `${r?.message || '探测失败'}`)
      if (r) setQ((prev) => (prev ? { ...prev, ...r } : prev))
      await load()
    } catch (e: any) {
      setErr(e?.message || '探测失败')
    } finally {
      setBusy('')
    }
  }

  const used = q && q.limit && q.remaining !== null ? `${q.remaining} / ${q.limit} credits` : '——'

  return (
    <Card
      title="数据源 · OpenAlex"
      extra={
        <Btn size="xs" onClick={test} disabled={!!busy}>
          <Icon name="refresh" size={12} />
          {busy === 'test' ? '探测中…' : '测试连接'}
        </Btn>
      }
    >
      <p className="text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
        文献检索、关联图、创新点溯源的关键词检索都走 OpenAlex。它现在按额度计费：
        <b className="text-[color:var(--wb-text)]">不带 API key 时按出口 IP 共享每天 $0.10</b>
        （约 100 次检索，同网络其他人也在花这笔），额度打空后检索会返回 429。
        免费申请一支 key 就有独立的 $1/天（约 1000 次），还能避免和同 IP 的人抢额度。
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px]">
        {q?.has_key ? (
          <Pill tone="green">已配置 {q.key_masked}</Pill>
        ) : (
          <Pill tone="gray">未配置 key · 共享额度</Pill>
        )}
        {q?.from_env && <Pill tone="gray">环境变量优先</Pill>}
        <span className="text-[color:var(--wb-muted)]">今日剩余额度：{used}</span>
        {q?.remaining_usd && (
          <span className="text-[color:var(--wb-muted)]">（${q.remaining_usd}）</span>
        )}
        {!!q?.reset_in && (
          <span className="text-[color:var(--wb-muted)]">· {humanWait(q.reset_in)}后重置</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="min-w-[240px] flex-1">
          <Input
            value={draft}
            onChange={setDraft}
            placeholder={q?.has_key ? '粘贴新 key 可替换现有的' : '粘贴 OpenAlex API key（形如 2a3b…）'}
          />
        </div>
        <Btn variant="primary" size="sm" onClick={save} disabled={!draft.trim() || !!busy}>
          保存
        </Btn>
        {q?.has_key && !q?.from_env && (
          <Btn size="sm" onClick={clear} disabled={!!busy}>
            清除
          </Btn>
        )}
        <a
          href={q?.signup_url || 'https://openalex.org/settings/api'}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11.5px] text-[color:var(--wb-accent)] hover:underline"
        >
          <Icon name="link" size={12} />
          免费申请 key
        </a>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
        也可以不填：设环境变量 <code className="rounded bg-[color:var(--wb-bg-subtle)] px-1">OPENALEX_API_KEY</code>{' '}
        后重启后端，效果相同（环境变量优先于这里保存的值）。同一查询后端会缓存 15 分钟，重复检索不重复计费。
      </p>

      {note && <p className="mt-2 text-[11.5px] text-[color:var(--wb-ok)]">{note}</p>}
      {err && <p className="mt-2 text-[11.5px] text-[color:var(--wb-danger)]">{err}</p>}
    </Card>
  )
}
