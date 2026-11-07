/**
 * 左侧技能库面板：内置技能 / GitHub 原版技能的分类浏览、拖拽源、其他节点、仓库克隆。
 *
 * 只吃 props、不持有画布状态：拖出去的节点由 onAddNode 交给页面决定怎么插。
 * 视觉与画布节点一致：彩色圆角小方块 + 手写 SVG 图标 + 中文标签（映射见 skill-meta.ts）。
 */
import { useState } from 'react'
import { Btn, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { post } from '../../lib/api'
import { NODE_ICON, TYPE_TILE, nodeChip, type Skill } from './canvas-shared'
import { categoryTile, skillIcon, skillLabel, skillTile, soft } from './skill-meta'

const NODE_OPTS: { t: string; l: string }[] = [
  { t: 'input', l: '输入' },
  { t: 'prompt', l: '自定义' },
  { t: 'output', l: '输出' },
  { t: 'tool', l: 'Dify' },
]

export default function SkillPalette({
  cats,
  srcTab,
  setSrcTab,
  ghInfo,
  onOpenSource,
  onAddNode,
  onPickSkill,
  onOpenMarket,
  onInstalled,
}: {
  cats: { name: string; skills: Skill[] }[]
  srcTab: 'all' | 'github' | 'builtin'
  setSrcTab: (v: 'all' | 'github' | 'builtin') => void
  ghInfo: { count: number; repos: any[] }
  onOpenSource: (sid: string, sname: string) => void
  onAddNode: (ntype: string, skillId: string, x: number, y: number) => void
  onPickSkill?: (sid: string) => void
  /** 打开「技能市场」（搜 GitHub 上的 SKILL.md 一键装）；不传就只显示整仓克隆入口 */
  onOpenMarket?: () => void
  /** 装完/克隆完通知外层刷新技能列表 */
  onInstalled?: () => void
}) {
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloning, setCloning] = useState(false)

  return (
    <div className="flex w-52 shrink-0 flex-col border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
      <div className="border-b border-[color:var(--wb-border)] px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-medium text-[color:var(--wb-text)]">技能库</div>
          <div className="text-[11.5px] text-[color:var(--wb-muted)]">
            {cats.reduce((n, c) => n + c.skills.length, 0)}
          </div>
        </div>
        <div className="mt-1 flex gap-1">
          {(
            [
              { v: 'all', l: '全部' },
              { v: 'github', l: `GitHub ${ghInfo.count}` },
              { v: 'builtin', l: '内置' },
            ] as const
          ).map((t) => (
            <button
              key={t.v}
              onClick={() => setSrcTab(t.v)}
              className={`flex-1 rounded-[7px] px-1 py-0.5 text-[11.5px] transition ${
                srcTab === t.v
                  ? 'bg-[color:var(--wb-accent)] font-medium text-white'
                  : 'bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-border)]'
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>
        {srcTab !== 'builtin' && ghInfo.repos.length > 0 && (
          <div className="mt-1 truncate text-[11.5px] text-[color:var(--wb-ok)]">
            原版仓库：{ghInfo.repos.map((r: any) => `${r.name}(${r.count})`).join(' · ')}
          </div>
        )}
        <div className="mt-0.5 text-[11.5px] text-[color:var(--wb-muted)]">点一下添加，或拖到画布上</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {cats.map((c) => {
          const ct = categoryTile(c.name)
          return (
            <div key={c.name} className="mb-2">
              <div className="flex items-center gap-1.5 px-1 py-1 text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">
                <Icon name={ct.icon} size={12} className="shrink-0" style={{ color: ct.bg }} />
                <span className="truncate">{c.name}</span>
              </div>
              {c.skills.map((s) => {
                const tile = skillTile(s)
                const gh = s.source === 'github'
                return (
                  <div
                    key={s.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/skill', s.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => onPickSkill?.(s.id)}
                    title={`${skillLabel(s)} · ${s.name}${s.desc ? `\n${s.desc}` : ''}（点击添加到画布）`}
                    className="group mb-1 flex cursor-pointer items-start gap-2 rounded-[9px] border border-[color:var(--wb-border)] px-2 py-1.5 text-[11.5px] leading-snug text-[color:var(--wb-text)] transition hover:border-[color:var(--wb-border-strong)] hover:bg-[color:var(--wb-surface-alt)] active:cursor-grabbing"
                  >
                    <span
                      className="mt-[1px] flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] transition"
                      style={{
                        color: tile.bg,
                        background: 'transparent',
                        boxShadow: `inset 0 0 0 1px ${soft(tile.bg, 0.22)}`,
                      }}
                    >
                      <Icon name={skillIcon(s)} size={20} strokeWidth={1.9} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="truncate font-medium">{skillLabel(s)}</span>
                        {gh && (
                          <span className="shrink-0 rounded bg-[color:var(--wb-ok-soft)] px-1 text-[9px] text-[color:var(--wb-ok)]">
                            GH
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-[color:var(--wb-muted)]" title={s.desc}>
                        {gh ? `${s.category} · ${s.name}` : s.desc}
                      </div>
                      {gh && (
                        <div className="mt-1 hidden group-hover:block" onClick={(e) => e.stopPropagation()}>
                          <Btn size="xs" variant="ghost" onClick={() => onOpenSource(s.id, skillLabel(s))}>
                            看 SKILL.md 原文
                          </Btn>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="border-t border-[color:var(--wb-border)] p-2">
        <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">其他节点</div>
        <div className="grid grid-cols-2 gap-1">
          {NODE_OPTS.map((b) => (
            <Btn
              key={b.t}
              size="sm"
              className="!justify-start !gap-1.5"
              title={`添加「${b.l}」节点`}
              onClick={() => onAddNode(b.t, '', 120 + Math.random() * 120, 120 + Math.random() * 120)}
            >
              <span
                className="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-[6px]"
                style={nodeChip(TYPE_TILE[b.t]?.bg || '#475569')}
              >
                <Icon name={NODE_ICON[b.t] || 'hexagon'} size={12} strokeWidth={2.1} />
              </span>
              {b.l}
            </Btn>
          ))}
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
          「自定义」= 自己写 system 与指令，不依赖技能库，想怎么串就怎么串。
        </p>
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11.5px] text-[color:var(--wb-muted)]">从 GitHub 装技能</span>
          </div>
          {onOpenMarket && (
            <Btn
              variant="primary"
              size="sm"
              className="w-full"
              onClick={onOpenMarket}
              title="搜索 GitHub 上带 SKILL.md 的技能包，按目录稀疏下载（不整仓 clone）"
            >
              <Icon name="grid" size={12} />
              打开技能市场
            </Btn>
          )}
          <div className="mt-1.5 text-[11px] text-[color:var(--wb-muted)]">
            或粘已知仓库地址（整仓克隆，体积可能很大）
          </div>
          <div className="mt-1 flex gap-1">
            <Input
              value={cloneUrl}
              onChange={setCloneUrl}
              placeholder="https://github.com/user/repo"
              className="!min-w-0 !flex-1 !text-[11.5px]"
            />
            <Btn
              size="sm"
              disabled={cloning || !cloneUrl.trim()}
              title="git clone 整个仓库到 skills/github"
              onClick={async () => {
                setCloning(true)
                try {
                  const r = await post<any>(
                    '/skills/market/install',
                    { repo: cloneUrl.trim(), origin: 'clone' },
                    { silent: true },
                  )
                  if (r.ok === false) throw new Error(r.message || '克隆失败')
                  toast(r.message || '已导入', 'ok')
                  setCloneUrl('')
                  onInstalled?.()
                } catch (e: any) {
                  toast(`克隆失败：${e?.message || e}`, 'error')
                } finally {
                  setCloning(false)
                }
              }}
            >
              {cloning ? '…' : '克隆'}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
