/**
 * 历史污染排查卡片：列出「疑似把 AI 错误文本当成成果存下来」的记录。
 *
 * 铁律：**只识别，不自动删**。勾选哪条才动哪条，且必须再点一次确认。
 * 历史上一旦出现误删，用户的实验结论就真的没了 —— 宁可多留一条脏数据。
 */
import { useEffect, useState } from 'react'
import { Btn, Card, Empty } from '../../components/ui'
import { get, post } from '../../lib/api'

/** 后端 /api/ai/suspects 返回的单条结构 */
type Item = {
  kind: string
  table: string
  id: number
  field: string
  title: string
  marker: string
  snippet: string
  created_at?: string
}

export default function SuspectsCard() {
  const [items, setItems] = useState<Item[]>([])
  const [total, setTotal] = useState(0)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const load = async () => {
    setErr(null)
    try {
      const r = await get<any>('/ai/suspects')
      setItems(r.items || [])
      setTotal(r.total || 0)
    } catch (e: any) {
      setErr(e?.message || '扫描失败')
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (k: string) => {
    const n = new Set(checked)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    setChecked(n)
  }

  const cleanup = async () => {
    if (!checked.size) return
    if (!window.confirm(`将删除勾选的 ${checked.size} 条记录。此操作不可撤销，确定继续？`)) return
    setBusy(true)
    try {
      const r = await post<any>(
        '/ai/suspects/cleanup',
        {
          confirm: true,
          items: [...checked].map((k) => {
            const [table, id] = k.split(':')
            const it = items.find((x) => `${x.table}:${x.id}` === k)
            return { table, id: Number(id), field: it?.field, action: 'delete' }
          }),
        },
        { ok: false },
      )
      setDone(`已清理 ${r.deleted || 0} 条`)
      setChecked(new Set())
      await load()
    } catch (e: any) {
      setErr(e?.message || '清理失败')
    }
    setBusy(false)
  }

  return (
    <Card
      title="④ 历史污染排查"
      extra={
        <Btn onClick={load} disabled={busy}>
          重新扫描
        </Btn>
      }
    >
      <p className="text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
        早期版本可能把「调用失败 / 未配置」这类提示文本当成成果存进了笔记或结论里。
        这里只把它们列出来，<b>不会自动删除</b>——你勾选并确认后才会处理。
      </p>

      {err && (
        <div className="mt-2 rounded-[9px] bg-[color:var(--wb-danger-soft)] px-3 py-2 text-[11.5px] text-[color:var(--wb-danger)]">
          {err}
        </div>
      )}
      {done && (
        <div className="mt-2 rounded-[9px] bg-[color:var(--wb-ok-soft)] px-3 py-2 text-[11.5px] text-[color:var(--wb-ok)]">
          {done}
        </div>
      )}

      <div className="mt-3">
        {total === 0 ? (
          <Empty text="没发现疑似污染记录" hint="扫描了文献笔记、实验结论、创新点备注与论文阶段" />
        ) : (
          <>
            <div className="mb-2 text-[11.5px] text-[color:var(--wb-muted)]">
              共 {total} 条待确认 · 已勾选 {checked.size} 条
            </div>
            <div className="flex flex-col gap-1.5">
              {items.map((it) => {
                const k = `${it.table}:${it.id}`
                return (
                  <label
                    key={k}
                    className="flex items-start gap-2 rounded-[10px] border border-[color:var(--wb-border)] px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked.has(k)}
                      onChange={() => toggle(k)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[color:var(--wb-muted)]">
                        <span className="rounded bg-[color:var(--wb-bg-subtle)] px-1.5 py-[1px]">
                          {it.kind}
                        </span>
                        <span>#{it.id}</span>
                        {it.title && <span className="truncate">{it.title}</span>}
                        <span className="text-[color:var(--wb-danger)]">{it.marker}</span>
                      </div>
                      <div className="mt-0.5 break-words text-[12px] text-[color:var(--wb-text)]">
                        {it.snippet}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <Btn variant="danger" onClick={cleanup} disabled={!checked.size} loading={busy}>
                删除勾选的 {checked.size} 条
              </Btn>
              <span className="text-[11px] text-[color:var(--wb-muted)]">
                不确定就先留着 —— 删掉就找不回来了
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
