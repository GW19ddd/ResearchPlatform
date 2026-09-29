/**
 * Zotero 同步卡片：本地桌面端 / Web API 两种源，外加离线粘贴导入。
 *
 * 自持全部同步状态，只在「同步成功改变了文献库」时通知外层刷新一次。
 */
import { useEffect, useState } from 'react'
import { Btn, Card, Input, Select, TextArea } from '../../components/ui'
import { get, post } from '../../lib/api'
import { usePersist } from '../../lib/state'

export default function ZoteroSyncCard({
  onImported,
  collapsible = false,
}: {
  onImported?: () => void
  /** 库里已经有文献时默认折起来 —— 同步是低频动作，不该常驻占半屏 */
  collapsible?: boolean
}) {
  const [open, setOpen] = useState(!collapsible)
  const [zcfg, setZcfg] = usePersist<any>('lit.zotero.cfg', {
    source: 'local',
    user_id: '',
    api_key: '',
    library_type: 'user',
    collection: '',
    tag: '',
    limit: 100,
  })
  const [zres, setZres] = usePersist<any>('lit.zotero.result', null)
  const [ztext, setZtext] = usePersist('lit.zotero.text', '')
  const [collections, setCollections] = useState<{ key: string; name: string }[]>([])
  const [zbusy, setZbusy] = useState('')

  const zLoadCollections = async () => {
    setZbusy('coll')
    const r = await post('/zotero/collections', zcfg)
    setCollections(r.collections || [])
    if (!r.ok) setZres(r)
    setZbusy('')
  }

  const zProbe = async () => {
    setZbusy('probe')
    setZres(await post('/zotero/probe', zcfg))
    setZbusy('')
  }

  const zSync = async () => {
    setZbusy('sync')
    setZres(await post('/zotero/sync', zcfg))
    setZbusy('')
    onImported?.()
  }

  const zImport = async () => {
    if (!ztext.trim()) return
    setZbusy('import')
    setZres(await post('/zotero/import', { text: ztext, fmt: 'auto' }))
    setZbusy('')
    onImported?.()
  }

  useEffect(() => {
    get('/zotero/config').then((c: any) => setZcfg((p: any) => ({ ...p, ...c })))
    zLoadCollections()
     
  }, [])

  return (
    <Card
      title="从 Zotero 同步"
      extra={
        <div className="flex items-center gap-2">
          <span className="hidden text-[11.5px] text-[color:var(--wb-muted)] sm:inline">
            按 DOI / 标题去重，已存在的条目自动跳过
          </span>
          <Btn size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? '收起' : '展开'}
          </Btn>
        </div>
      }
      className="md:col-span-3"
    >
      {!open ? (
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-[color:var(--wb-text-soft)]">
          <span>
            {collections.length > 0 ? `已载入 ${collections.length} 个分类` : '本地 Zotero 桌面端 / Web API / 离线粘贴'}
          </span>
          <span className="text-[color:var(--wb-muted)]">
            {zres?.ok ? `上次同步：导入 ${zres.imported} 条，跳过 ${zres.skipped} 条` : '点「展开」配置并同步'}
          </span>
        </div>
      ) : (
      <div className="flex flex-col gap-3">
        <div className="grid gap-2 md:grid-cols-4">
          <Select
            value={zcfg.source}
            onChange={(v) => setZcfg({ ...zcfg, source: v })}
            options={[
              { value: 'local', label: '本地 Zotero（桌面端）' },
              { value: 'web', label: 'Zotero Web API' },
            ]}
          />
          {zcfg.source === 'web' && (
            <>
              <Select
                value={zcfg.library_type}
                onChange={(v) => setZcfg({ ...zcfg, library_type: v })}
                options={[
                  { value: 'user', label: '个人库' },
                  { value: 'group', label: '群组库' },
                ]}
              />
              <Input
                placeholder="User ID"
                value={zcfg.user_id}
                onChange={(v) => setZcfg({ ...zcfg, user_id: v })}
              />
              <Input
                placeholder="API Key"
                value={zcfg.api_key}
                onChange={(v) => setZcfg({ ...zcfg, api_key: v })}
              />
            </>
          )}
          <Input
            placeholder="标签过滤（可留空）"
            value={zcfg.tag}
            onChange={(v) => setZcfg({ ...zcfg, tag: v })}
          />
          <Input
            placeholder="最多条数"
            value={String(zcfg.limit)}
            onChange={(v) => setZcfg({ ...zcfg, limit: Number(v) || 100 })}
          />
          <Select
            value={zcfg.collection}
            onChange={(v) => setZcfg({ ...zcfg, collection: v })}
            options={[
              { value: '', label: '全部条目' },
              ...collections.map((c) => ({ value: c.key, label: c.name })),
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Btn variant="primary" onClick={zSync} disabled={zbusy === 'sync'}>
            {zbusy === 'sync' ? '同步中…' : '同步条目'}
          </Btn>
          <Btn onClick={zProbe} disabled={zbusy === 'probe'}>
            {zbusy === 'probe' ? '测试中…' : '测试连接'}
          </Btn>
          <Btn onClick={zLoadCollections} disabled={zbusy === 'coll'}>
            {zbusy === 'coll' ? '载入中…' : '载入分类'}
          </Btn>
          <span className="text-[11.5px] text-[color:var(--wb-muted)]">
            {collections.length > 0
              ? `已载入 ${collections.length} 个分类，可在上面「同步范围」里挑一个只同步它`
              : '本地模式需 Zotero 桌面端已启动，且开启「设置 → 高级 → 允许本机其他程序访问」'}
          </span>
        </div>

        <details className="rounded-[10px] border border-[color:var(--wb-border)] px-3 py-2">
          <summary className="cursor-pointer text-[12px] text-[color:var(--wb-text-soft)]">
            离线导入：粘贴 CSL JSON / BibTeX / RIS
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <TextArea
              placeholder="Zotero 里右键条目 → 导出 → 选 CSL JSON / BibTeX / RIS，把内容粘到这里"
              value={ztext}
              onChange={setZtext}
            />
            <div className="flex justify-end">
              <Btn onClick={zImport} disabled={zbusy === 'import'}>
                {zbusy === 'import' ? '导入中…' : '解析导入'}
              </Btn>
            </div>
          </div>
        </details>

        {zres && (
          <div
            className={`rounded-[10px] px-3 py-2 text-[12px] ${
              zres.ok
                ? 'bg-[color:var(--wb-ok-soft)] text-[color:var(--wb-ok)]'
                : 'bg-[color:var(--wb-danger-soft)] text-[color:var(--wb-danger)]'
            }`}
          >
            {zres.ok ? (
              <div>
                <div>
                  导入 <b>{zres.imported}</b> 条
                  {zres.updated ? (
                    <>
                      ，补全分类/标签 <b>{zres.updated}</b> 条
                    </>
                  ) : null}
                  ，跳过 <b>{zres.skipped}</b> 条（已存在）
                  {zres.total ? `，本次拉取 ${zres.total} 条` : ''}
                </div>
                {zres.samples?.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[11.5px] opacity-80">
                    {zres.samples.map((s: string, i: number) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              zres.message || '同步失败'
            )}
          </div>
        )}
      </div>
      )}
    </Card>
  )
}
