/**
 * 备份与恢复卡片。
 *
 * 设计上刻意保守：
 * - 「隔离验证」是默认动作，零风险，任何时候都能跑
 * - 「覆盖正式库」要点两次（先勾确认，再点覆盖），且覆盖前后端会自动再打一份安全快照
 * - 列表只列本地文件，不做任何自动清理
 */
import { useEffect, useState } from 'react'
import { Btn, Card, Field, Input, Pill } from '../../components/ui'
import { del, get, post } from '../../lib/api'

type Snap = { name: string; size: number; created_at: string; label: string }

const kb = (n: number) =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

export default function BackupCard() {
  const [snaps, setSnaps] = useState<Snap[]>([])
  const [dir, setDir] = useState('')
  const [live, setLive] = useState('')
  const [label, setLabel] = useState('manual')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const [confirm, setConfirm] = useState('')
  const [accept, setAccept] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const load = async () => {
    setLoadErr(null)
    try {
      const r = await get<any>('/backup')
      setSnaps(r.backups || [])
      setDir(r.dir || '')
      setLive(r.live_db || '')
    } catch (e: any) {
      setLoadErr(e?.message || '读取备份列表失败')
    }
  }

  useEffect(() => {
    load()
  }, [])

  const create = async () => {
    setBusy('create')
    try {
      const r = await post<any>('/backup/create', { label }, { ok: false })
      setNote({ tone: 'ok', text: `已生成 ${r.name}（${kb(r.size)}）` })
      await load()
    } catch (e: any) {
      setNote({ tone: 'error', text: e?.message || '备份失败' })
    }
    setBusy('')
  }

  const verify = async (name: string) => {
    setBusy('verify-' + name)
    try {
      const r = await get<any>(`/backup/${encodeURIComponent(name)}/verify`)
      const total = Object.values(r.counts || {}).reduce(
        (a: number, b: any) => a + (typeof b === 'number' && b > 0 ? b : 0),
        0,
      )
      setNote({
        tone: r.ok ? 'ok' : 'error',
        text: r.ok
          ? `${name} 自检通过 · 共 ${total} 行数据可读`
          : `${name} 自检未通过：${r.integrity}`,
      })
    } catch (e: any) {
      setNote({ tone: 'error', text: e?.message || '验证失败' })
    }
    setBusy('')
  }

  const restore = async (name: string, mode: 'isolated' | 'live') => {
    setBusy('restore-' + name)
    try {
      const r = await post<any>(
        `/backup/${encodeURIComponent(name)}/restore`,
        { mode, confirm: mode === 'live' },
        { ok: false },
      )
      setNote({
        tone: 'ok',
        text:
          mode === 'live'
            ? `已覆盖正式库（覆盖前安全快照：${r.safety_backup}）`
            : `隔离验证完成 · ${r.total_rows} 行数据可读 · ${r.target}`,
      })
      setConfirm('')
      setAccept(false)
      await load()
    } catch (e: any) {
      setNote({ tone: 'error', text: e?.message || '恢复失败' })
    }
    setBusy('')
  }

  const remove = async (name: string) => {
    if (!window.confirm(`删除备份 ${name}？删除后无法用它恢复。`)) return
    await del(`/backup/${encodeURIComponent(name)}`, { ok: false })
    await load()
  }

  return (
    <Card
      title="③ 数据备份与恢复"
      extra={
        <Btn onClick={load} disabled={busy === 'create'}>
          刷新
        </Btn>
      }
    >
      <p className="text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
        所有数据都在本地一个 SQLite 文件里。备份用 SQLite 的在线备份接口生成一致快照（不是裸拷文件），
        恢复前可以先做一次「隔离验证」确认这份备份真的读得出数据。
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="w-40">
          <Field label="备份名后缀" hint="只能包含字母、数字、-、_">
            <Input value={label} onChange={setLabel} placeholder="manual" />
          </Field>
        </div>
        <Btn variant="primary" onClick={create} loading={busy === 'create'}>
          立即备份
        </Btn>
      </div>

      <div className="mt-2 text-[11px] text-[color:var(--wb-muted)]">
        <div>备份目录：{dir || '—'}</div>
        <div className="break-all">当前数据库：{live || '—'}</div>
      </div>

      {loadErr && (
        <div className="mt-2 rounded-[9px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-3 py-2 text-[11.5px] text-[color:var(--wb-danger)]">
          {loadErr}
          <Btn size="sm" className="ml-2" onClick={load}>
            重试
          </Btn>
        </div>
      )}

      {note && (
        <div
          className={`mt-2 rounded-[9px] px-3 py-2 text-[11.5px] ${
            note.tone === 'ok'
              ? 'bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]'
              : note.tone === 'error'
                ? 'bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]'
                : 'bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-text-soft)]'
          }`}
        >
          {note.text}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {snaps.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[color:var(--wb-border-strong)] px-3 py-5 text-center text-[12px] text-[color:var(--wb-muted)]">
            还没有备份。数据库迁移前系统会自动打一份，也可以现在手动点一次。
          </div>
        ) : (
          snaps.map((s) => (
            <div
              key={s.name}
              className="rounded-[10px] border border-[color:var(--wb-border)] px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-medium text-[color:var(--wb-text)]">
                  {s.name}
                </span>
                <Pill>{kb(s.size)}</Pill>
                <span className="text-[11px] text-[color:var(--wb-muted)]">
                  {String(s.created_at || '').replace('T', ' ')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Btn size="sm" onClick={() => verify(s.name)} loading={busy === 'verify-' + s.name}>
                  隔离验证
                </Btn>
                <Btn
                  size="sm"
                  onClick={() => restore(s.name, 'isolated')}
                  loading={busy === 'restore-' + s.name}
                >
                  恢复到临时目录
                </Btn>
                <Btn
                  size="sm"
                  variant="danger"
                  onClick={() => (confirm === s.name ? restore(s.name, 'live') : setConfirm(s.name))}
                  loading={busy === 'restore-' + s.name}
                >
                  {confirm === s.name ? '确认覆盖正式库' : '覆盖正式库…'}
                </Btn>
                <Btn size="sm" variant="ghost" onClick={() => remove(s.name)}>
                  删除备份
                </Btn>
              </div>
              {confirm === s.name && (
                <div className="mt-2 rounded-[9px] border border-[color:var(--wb-danger)]/30 bg-[color:var(--wb-danger-soft)] px-3 py-2">
                  <label className="flex items-start gap-2 text-[11.5px] text-[color:var(--wb-danger)]">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={accept}
                      onChange={(e) => setAccept(e.target.checked)}
                    />
                    <span>
                      我确认要用这份备份替换当前数据库。当前库会先被另存为
                      <code className="mx-1 rounded bg-[color:var(--wb-surface)] px-1">
                        .pre-restore
                      </code>
                      文件，但覆盖本身不可逆。
                    </span>
                  </label>
                  <div className="mt-2 flex items-center gap-1.5">
                    <Btn
                      size="sm"
                      variant="danger"
                      disabled={!accept}
                      onClick={() => restore(s.name, 'live')}
                    >
                      覆盖
                    </Btn>
                    <Btn
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirm('')
                        setAccept(false)
                      }}
                    >
                      取消
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  )
}
