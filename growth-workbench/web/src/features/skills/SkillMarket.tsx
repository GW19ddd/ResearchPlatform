/**
 * 技能市场：搜 GitHub 上现成的 SKILL.md 技能包，一键装进本地技能库。
 *
 * 和「粘贴仓库 URL 克隆」的区别：
 *   老路径 = git clone 整仓（几百 MB、含 evals/ 与图片）
 *   这里 = 只探测仓库里有没有 SKILL.md，装的时候按目录稀疏下载，只落盘技能本体
 *
 * 三件事必须说实话，否则用户会误判：
 *   1. 额度用尽 ≠ 没有结果 —— rate 错误单独展示，并直接给「填 Token」的入口
 *   2. 「已装」要能一眼看出来，且能直接卸载
 *   3. 装完要告诉用户这个技能能不能在对话页看到（白名单是显式的）
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Btn, IconBtn, Input, Modal, Select, Spinner } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { get, post, put } from '../../lib/api'
import { toast } from '../../components/toast'

type MarketSkill = { path: string; dir: string; name: string; desc: string }
type MarketRepo = {
  full_name: string
  owner: string
  repo: string
  stars: number
  desc: string
  updated: string
  html_url: string
  skills: MarketSkill[]
  skill_count: number
  installed?: boolean
  topics?: string[]
}
type Preset = { key: string; label: string; q: string }

type PresetRow = { presets: Preset[]; token_set: boolean; token_masked: string }

const TONE_RATE = 'border-[color:var(--wb-warn)]/30 bg-[color:var(--wb-warn-soft)] text-[color:var(--wb-warn)]'

export default function SkillMarket({
  open,
  onClose,
  onInstalled,
  compact = false,
}: {
  open: boolean
  onClose: () => void
  /** 装完通知外层刷新技能列表（画布左侧 / 对话页） */
  onInstalled?: () => void
  compact?: boolean
}) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [preset, setPreset] = useState('all')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [repos, setRepos] = useState<MarketRepo[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<{ kind: string; message: string } | null>(null)
  const [note, setNote] = useState('')
  const [tokenSet, setTokenSet] = useState(false)
  const [tokenMasked, setTokenMasked] = useState('')
  const [tokenOpen, setTokenOpen] = useState(false)
  const [token, setToken] = useState('')
  const [picking, setPicking] = useState<MarketRepo | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [use, setUse] = useState<'canvas' | 'chat' | 'both'>('both')
  const [installing, setInstalling] = useState('')
  const [dir, setDir] = useState('')

  const loadPresets = useCallback(async () => {
    try {
      const r = await get<PresetRow>('/skills/market/presets')
      setPresets(r.presets || [])
      setTokenSet(!!r.token_set)
      setTokenMasked(r.token_masked || '')
    } catch {
      /* 预设拉不到不影响手输关键词 */
    }
  }, [])

  const run = useCallback(
    async (opts?: { preset?: string; q?: string; page?: number; force?: boolean }) => {
      const p = opts?.preset ?? preset
      const kw = opts?.q ?? q
      const pg = opts?.page ?? page
      setBusy(true)
      setErr(null)
      setNote('')
      try {
        const r = await post<any>(
          '/skills/market/search',
          { q: kw, preset: p, page: pg, force: !!opts?.force },
          { silent: true },
        )
        if (r.ok === false) {
          setErr({ kind: r.kind || 'http', message: r.message || '搜索失败' })
          setRepos([])
        } else {
          setRepos(r.repos || [])
          setNote(r.note || '')
          setPage(pg)
          if (!(r.repos || []).length && !r.note) setNote('这个关键词下没找到带 SKILL.md 的仓库，换个词或翻页试试')
        }
      } catch (e: any) {
        setErr({ kind: 'http', message: e?.message || String(e) })
        setRepos([])
      }
      setBusy(false)
    },
    [preset, q, page],
  )

  useEffect(() => {
    if (!open) return
    loadPresets()
    run({ preset: 'all', q: '', page: 1 })
    // 只在打开时拉一次；换分类/翻页由用户操作触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const doInstall = async (repo: MarketRepo, paths: string[], target: string) => {
    setInstalling(repo.full_name)
    try {
      const r = await post<any>(
        '/skills/market/install',
        { repo: repo.full_name, paths, use },
        { silent: true },
      )
      if (r.ok === false) throw new Error(r.message || '安装失败')
      toast(r.message || `已安装 ${repo.repo}`, 'ok')
      setDir(r.dir || repo.repo)
      setRepos((prev) => prev.map((x) => (x.repo === repo.repo ? { ...x, installed: true } : x)))
      setPicking(null)
      onInstalled?.()
      if (compact) onClose()
    } catch (e: any) {
      toast(`安装失败：${e?.message || e}`, 'error')
    }
    setInstalling('')
  }

  const doUninstall = async (repo: MarketRepo) => {
    setInstalling(repo.full_name)
    try {
      const r = await post<any>(
        '/skills/market/uninstall',
        { name: repo.repo },
        { ok: `已卸载 ${repo.repo}`, silent: false },
      )
      if (r.ok === false) throw new Error(r.message)
      setRepos((prev) => prev.map((x) => (x.repo === repo.repo ? { ...x, installed: false } : x)))
      onInstalled?.()
    } catch (e: any) {
      toast(`卸载失败：${e?.message || e}`, 'error')
    }
    setInstalling('')
  }

  const saveToken = async () => {
    try {
      const r = await post<any>('/skills/market/token', { token }, { ok: 'Token 已保存', silent: false })
      setTokenSet(!!r.token_set)
      setTokenMasked(r.masked || '')
      setToken('')
      setTokenOpen(false)
      toast('额度已刷新，重新搜索即可', 'ok')
    } catch (e: any) {
      toast(`保存失败：${e?.message || e}`, 'error')
    }
  }

  const body = useMemo(
    () => (
      <div className={compact ? 'flex h-full flex-col' : ''}>
        {/* 搜索条 */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={preset}
            onChange={(v) => {
              setPreset(v)
              run({ preset: v, q: '', page: 1 })
            }}
            options={presets.map((p) => ({ value: p.key, label: p.label }))}
            className="w-[130px]"
          />
          <div
            className="flex min-w-[180px] flex-1 items-center gap-2"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                run({ q, page: 1 })
              }
            }}
          >
            <Input value={q} onChange={setQ} placeholder="搜技能关键词，如 paper polish / unit test" />
            <Btn variant="primary" size="sm" loading={busy} onClick={() => run({ q, page: 1 })}>
              搜索
            </Btn>
          </div>
          <IconBtn
            icon="refresh"
            size="md"
            title="强制刷新（跳过 6 小时缓存）"
            onClick={() => run({ force: true })}
          />
          <Btn size="sm" variant={tokenSet ? 'subtle' : 'default'} onClick={() => setTokenOpen(true)}>
            <Icon name="gear" size={12} />
            {tokenSet ? `Token ${tokenMasked}` : '填 Token'}
          </Btn>
        </div>

        {/* 额度/错误：必须原文展示，否则用户以为「GitHub 上没有」 */}
        {err && (
          <div className={`mt-3 rounded-[10px] border px-3 py-2 text-[12px] leading-relaxed ${TONE_RATE}`}>
            <div className="font-medium">
              {err.kind === 'rate' ? 'GitHub 额度用尽' : err.kind === 'auth' ? 'Token 无效' : '搜索失败'}
            </div>
            <div className="mt-0.5">{err.message}</div>
            {err.kind !== 'http' && (
              <div className="mt-1.5 flex gap-2">
                <Btn size="xs" onClick={() => setTokenOpen(true)}>
                  去填 Token
                </Btn>
                <Btn size="xs" variant="ghost" onClick={() => run({ force: true })}>
                  重试
                </Btn>
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between text-[11.5px] text-[color:var(--wb-muted)]">
          <span>
            {busy ? '正在探测仓库…' : `第 ${page} 页 · ${repos.length} 个仓库带技能`}
            {note ? ` · ${note}` : ''}
          </span>
          <span className="flex items-center gap-1">
            <Btn size="xs" variant="ghost" disabled={page <= 1 || busy} onClick={() => run({ page: page - 1 })}>
              上一页
            </Btn>
            <Btn size="xs" variant="ghost" disabled={busy || repos.length === 0} onClick={() => run({ page: page + 1 })}>
              下一页
            </Btn>
          </span>
        </div>

        {/* 结果列表 */}
        <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
          {busy && repos.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-[color:var(--wb-muted)]">
              <Spinner /> 正在读 GitHub 仓库树…
            </div>
          )}
          {!busy && repos.length === 0 && !err && (
            <div className="py-12 text-center text-[12px] text-[color:var(--wb-muted)]">
              没搜到含 SKILL.md 的仓库。换关键词，或直接粘 owner/repo 安装。
            </div>
          )}
          {repos.map((r) => (
            <div
              key={r.full_name}
              className="rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-3 transition hover:border-[color:var(--wb-border-strong)]"
            >
              <div className="flex items-start gap-2">
                <span className="mt-[1px] flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
                  <Icon name="gitBranch" size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <a
                      href={r.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-[12.5px] font-semibold text-[color:var(--wb-text)] hover:text-[color:var(--wb-accent)]"
                    >
                      {r.full_name}
                    </a>
                    <span className="shrink-0 text-[11px] text-[color:var(--wb-muted)]">★ {r.stars}</span>
                    {r.installed && (
                      <span className="shrink-0 rounded bg-[color:var(--wb-ok-soft)] px-1 text-[9.5px] text-[color:var(--wb-ok)]">
                        已装
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                    {r.desc || '（仓库无描述）'}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="rounded bg-[color:var(--wb-bg-subtle)] px-1.5 py-[1px] text-[10.5px] text-[color:var(--wb-text-soft)]">
                      {r.skill_count} 个技能
                    </span>
                    {r.skills.slice(0, 4).map((s) => (
                      <span
                        key={s.path}
                        title={s.path}
                        className="max-w-[130px] truncate rounded bg-[color:var(--wb-bg-subtle)] px-1.5 py-[1px] text-[10.5px] text-[color:var(--wb-text-soft)]"
                      >
                        {s.name}
                      </span>
                    ))}
                    {r.skill_count > 4 && (
                      <span className="text-[10.5px] text-[color:var(--wb-muted)]">+{r.skill_count - 4}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {r.skill_count === 1 ? (
                    <Btn
                      size="sm"
                      variant="primary"
                      loading={installing === r.full_name}
                      disabled={!!installing || r.installed}
                      onClick={() => doInstall(r, [], r.repo)}
                    >
                      {r.installed ? '已安装' : '安装'}
                    </Btn>
                  ) : (
                    <Btn
                      size="sm"
                      variant={r.installed ? 'subtle' : 'primary'}
                      disabled={!!installing || r.installed}
                      onClick={() => {
                        setPicking(r)
                        setPicked(new Set(r.skills.map((s) => s.path)))
                      }}
                    >
                      {r.installed ? '已安装' : `挑技能装 (${r.skill_count})`}
                    </Btn>
                  )}
                  {r.installed && (
                    <Btn size="xs" variant="ghost" disabled={!!installing} onClick={() => doUninstall(r)}>
                      卸载
                    </Btn>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {dir && (
          <div className="mt-2 rounded-[10px] border border-[color:var(--wb-ok)]/25 bg-[color:var(--wb-ok-soft)] px-3 py-2 text-[11.5px] text-[color:var(--wb-ok)]">
            已装到 skills/github/{dir}。画布左侧技能库「GitHub」页可直接拖到画布上
            {use !== 'canvas' && '，对话页技能面板里也能点开用'}。
          </div>
        )}
      </div>
    ),
    [busy, dir, err, installing, note, page, presets, preset, q, repos, tokenMasked, tokenSet, use, compact],
  )

  const picker = (
    <Modal
      open={!!picking}
      onClose={() => setPicking(null)}
      title={picking ? `从 ${picking.repo} 里挑要装的技能` : ''}
      width="max-w-xl"
      footer={
        <>
          <Btn variant="ghost" onClick={() => setPicking(null)}>
            取消
          </Btn>
          <Btn
            variant="primary"
            loading={!!installing}
            disabled={!picking || picked.size === 0}
            onClick={() => {
              if (!picking) return
              const preset_name = picking.repo
              const paths = [...picked]
              // 全选时按整仓装（保留目录结构），否则只取选中目录并拍平
              doInstall(picking, picked.size === picking.skills.length ? [] : paths, preset_name)
            }}
          >
            装这 {picked.size} 个
          </Btn>
        </>
      }
    >
      <div className="space-y-1.5">
        <div className="mb-2 flex items-center justify-between text-[11.5px] text-[color:var(--wb-muted)]">
          <span>只下载选中的目录，其余文件不进本地（不占磁盘）</span>
          <Btn
            size="xs"
            variant="ghost"
            onClick={() => {
              if (!picking) return
              setPicked(
                picked.size === picking.skills.length
                  ? new Set()
                  : new Set(picking.skills.map((s) => s.path)),
              )
            }}
          >
            {picked.size === (picking?.skills.length || 0) ? '全不选' : '全选'}
          </Btn>
        </div>
        {picking?.skills.map((s) => {
          const on = picked.has(s.path)
          return (
            <button
              key={s.path}
              type="button"
              onClick={() => {
                const next = new Set(picked)
                if (on) next.delete(s.path)
                else next.add(s.path)
                setPicked(next)
              }}
              className={`flex w-full items-center gap-2 rounded-[9px] border px-2.5 py-2 text-left transition ${
                on
                  ? 'border-[color:var(--wb-accent)]/40 bg-[color:var(--wb-accent-soft)]'
                  : 'border-[color:var(--wb-border)] hover:bg-[color:var(--wb-bg-subtle)]'
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border ${
                  on
                    ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent)] text-white'
                    : 'border-[color:var(--wb-border-strong)]'
                }`}
              >
                {on && <Icon name="check" size={10} strokeWidth={2.6} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-[color:var(--wb-text)]">{s.name}</span>
                <span className="block truncate text-[11px] text-[color:var(--wb-muted)]">{s.path}</span>
              </span>
            </button>
          )
        })}
        <div className="mt-3 flex items-center gap-2 text-[11.5px] text-[color:var(--wb-text-soft)]">
          <span className="whitespace-nowrap">装到</span>
          <Select
            value={use}
            onChange={(v) => setUse(v as any)}
            options={[
              { value: 'both', label: '画布 + 对话页' },
              { value: 'canvas', label: '只给画布用' },
              { value: 'chat', label: '只给对话用' },
            ]}
            className="w-[160px]"
          />
        </div>
      </div>
    </Modal>
  )

  const tokenModal = (
    <Modal
      open={tokenOpen}
      onClose={() => setTokenOpen(false)}
      title="GitHub Token（可选）"
      footer={
        <>
          <Btn variant="ghost" onClick={() => setTokenOpen(false)}>
            取消
          </Btn>
          <Btn variant="primary" onClick={saveToken}>
            保存
          </Btn>
        </>
      }
    >
      <div className="space-y-2 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
        <p>
          不填也能用，但匿名额度只有 <b>60 次/小时</b>，搜两三次就没了。填一个 Token 后提到{' '}
          <b>5000 次/小时</b>。
        </p>
        <p className="text-[color:var(--wb-muted)]">
          建法：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) →
          Generate new token，<b>不勾任何权限</b>即可（只读公开仓库）。Token 存在本地数据库，只发给
          api.github.com。
        </p>
        <Input value={token} onChange={setToken} placeholder="ghp_… 或 github_pat_…" type="password" />
        {tokenSet && <p className="text-[color:var(--wb-ok)]">当前已保存：{tokenMasked}（留空保存 = 清除）</p>}
      </div>
    </Modal>
  )

  if (compact) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        {picker}
        {tokenModal}
      </>
    )
  }
  return (
    <>
      <Modal open={open} onClose={onClose} title="技能市场 · 从 GitHub 装技能" width="max-w-4xl">
        <div className="flex h-[64vh] flex-col">{body}</div>
      </Modal>
      {picker}
      {tokenModal}
    </>
  )
}
