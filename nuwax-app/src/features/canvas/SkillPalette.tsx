/**
 * 左侧技能库面板：内置技能 / GitHub 原版技能的分类浏览、拖拽源、其他节点、仓库克隆。
 *
 * 只吃 props、不持有画布状态：拖出去的节点由 onAddNode 交给页面决定怎么插。
 */
import { useState } from 'react'
import { Btn, Input } from '../../components/ui'
import type { Skill } from './canvas-shared'

export default function SkillPalette({
  cats,
  srcTab,
  setSrcTab,
  ghInfo,
  onOpenSource,
  onAddNode,
  onClone,
}: {
  cats: { name: string; skills: Skill[] }[]
  srcTab: 'all' | 'github' | 'builtin'
  setSrcTab: (v: 'all' | 'github' | 'builtin') => void
  ghInfo: { count: number; repos: any[] }
  onOpenSource: (sid: string, sname: string) => void
  onAddNode: (ntype: string, skillId: string, x: number, y: number) => void
  onClone: (url: string) => Promise<void>
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
        <div className="mt-0.5 text-[11.5px] text-[color:var(--wb-muted)]">拖到画布上</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {cats.map((c) => (
          <div key={c.name} className="mb-2">
            <div className="px-1 py-1 text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">
              {c.name}
            </div>
            {c.skills.map((s) => (
              <div
                key={s.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/skill', s.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                title={s.desc}
                className="group mb-1 cursor-grab rounded-[9px] border border-[color:var(--wb-border)] px-2 py-1.5 text-[11.5px] leading-snug text-[color:var(--wb-text)] transition hover:border-[color:var(--wb-border-strong)] hover:bg-[color:var(--wb-surface-alt)] active:cursor-grabbing"
              >
                <div className="flex items-center gap-1">
                  <span className="truncate font-medium">{s.name}</span>
                  {(s as any).source === 'github' && (
                    <span className="shrink-0 rounded bg-[color:var(--wb-ok-soft)] px-1 text-[9px] text-[color:var(--wb-ok)]">
                      GH
                    </span>
                  )}
                </div>
                <div className="truncate text-[11.5px] text-[color:var(--wb-muted)]">{s.desc}</div>
                {(s as any).source === 'github' && (
                  <div className="mt-1 hidden group-hover:block">
                    <button
                      onClick={() => onOpenSource(s.id, s.name)}
                      className="rounded border border-[color:var(--wb-border-strong)] px-1 text-[11.5px] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-surface)]"
                    >
                      看 SKILL.md 原文
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="border-t border-[color:var(--wb-border)] p-2">
        <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">其他节点</div>
        <div className="grid grid-cols-2 gap-1">
          {[
            { t: 'input', l: '输入' },
            { t: 'prompt', l: '自定义' },
            { t: 'output', l: '输出' },
            { t: 'tool', l: 'Dify' },
          ].map((b) => (
            <Btn
              key={b.t}
              size="sm"
              className={b.t === 'prompt' ? '!border-violet-300 !bg-violet-50 !text-violet-700' : ''}
              onClick={() => onAddNode(b.t, '', 120 + Math.random() * 120, 120 + Math.random() * 120)}
            >
              + {b.l}
            </Btn>
          ))}
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
          「自定义」= 自己写 system 与指令，不依赖技能库，想怎么串就怎么串。
        </p>
        <div className="mt-2">
          <div className="mb-1 text-[11.5px] text-[color:var(--wb-muted)]">
            导入 GitHub 技能仓库（原样克隆，不改写）
          </div>
          <Input
            value={cloneUrl}
            onChange={setCloneUrl}
            placeholder="https://github.com/user/repo"
            className="!text-[11.5px]"
          />
          <Btn
            className="mt-1 w-full"
            disabled={cloning || !cloneUrl.trim()}
            onClick={async () => {
              setCloning(true)
              try {
                await onClone(cloneUrl.trim())
                setCloneUrl('')
              } catch {
                /* 失败提示由页面统一给出，这里只负责收状态 */
              } finally {
                setCloning(false)
              }
            }}
          >
            {cloning ? '克隆中…' : '↓ 克隆仓库'}
          </Btn>
        </div>
      </div>
    </div>
  )
}
