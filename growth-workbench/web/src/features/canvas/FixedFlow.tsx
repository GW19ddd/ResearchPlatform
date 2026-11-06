/**
 * 固定框布局：把节点按「从上到下」的顺序渲染成纵向步骤卡片。
 *
 * 与自由画布的区别：
 *   - 不铺满屏、不拖拽、不平移缩放、没有 MiniMap；固定宽度居中，一屏就是一条流水线
 *   - 卡片顺序即执行顺序（保存时由 Canvas 生成链式 edges），用上下箭头调顺序即可
 *   - 点卡片在右侧改配置，产出直接给摘要，长文本点一下展开大窗
 *
 * 只吃 props、不持有画布状态，自由画布与固定框共用同一份 nodes。
 */
import { Btn, Empty, IconBtn, StatusTag } from '../../components/ui'
import { Icon } from '../../components/Icon'
import {
  PROMPT_HINT,
  TYPE_ACCENT,
  TYPE_LABEL,
  subtitle,
  type CNode,
} from './canvas-shared'

const ADD_OPTS: { t: string; l: string }[] = [
  { t: 'input', l: '输入' },
  { t: 'prompt', l: '自定义' },
  { t: 'skill', l: '技能' },
  { t: 'tool', l: 'Dify' },
  { t: 'output', l: '输出' },
]

const STATUS: Record<string, { tone: 'gray' | 'ok' | 'warn' | 'danger' | 'busy'; text: string }> = {
  idle: { tone: 'gray', text: '未运行' },
  running: { tone: 'busy', text: '运行中' },
  done: { tone: 'ok', text: '已完成' },
  error: { tone: 'danger', text: '出错' },
}

export default function FixedFlow({
  nodes,
  sel,
  outputs,
  metas,
  runErrors,
  running,
  tipSeen,
  onDismissTip,
  onSelect,
  onAdd,
  onMove,
  onDelete,
  onRun,
  onExpandOutput,
}: {
  nodes: CNode[]
  sel: string | null
  outputs: Record<string, string>
  metas: Record<string, any>
  runErrors: Record<string, any>
  running: boolean
  tipSeen: boolean
  onDismissTip: () => void
  onSelect: (key: string | null) => void
  onAdd: (ntype: string, skillId: string) => void
  onMove: (key: string, dir: -1 | 1) => void
  onDelete: (key: string) => void
  onRun: (key: string) => void
  onExpandOutput: (key: string) => void
}) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-[color:var(--wb-bg-subtle)] px-4 py-5">
      <div className="mx-auto w-full max-w-[820px]">
        {!tipSeen && (
          <div className="mb-4 flex items-start gap-2.5 rounded-[12px] border border-[color:var(--wb-accent)]/25 bg-[color:var(--wb-accent-soft)] px-3.5 py-2.5">
            <Icon name="sparkle" size={15} className="mt-[2px] shrink-0 text-[color:var(--wb-accent)]" />
            <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
              <span className="font-medium text-[color:var(--wb-text)]">三步跑通：</span>
              1 从模板或左侧技能库加步骤 → 2 用箭头调顺序、点卡片在右侧改配置 → 3 点「运行整图」。
              顺序就是执行顺序，不用拖拽连线。
            </div>
            <IconBtn icon="close" size="sm" ariaLabel="不再提示" onClick={onDismissTip} />
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12px] font-medium text-[color:var(--wb-text)]">
            固定框 · {nodes.length} 个步骤
          </div>
          <div className="text-[11.5px] text-[color:var(--wb-muted)]">从上到下依次执行 · 无需拖拽连线</div>
        </div>

        {nodes.length === 0 ? (
          <Empty
            text="还没有步骤"
            hint="从模板新建，或点下面的按钮添加第一步。固定框会按从上到下的顺序依次执行，结果可以逐步回看。"
            action={
              <Btn onClick={() => onAdd('input', '')}>
                <Icon name="plus" size={13} />
                添加第一个步骤
              </Btn>
            }
          />
        ) : (
          <div>
            {nodes.map((n, i) => {
              const d = n.data
              const acc = TYPE_ACCENT[d.ntype] || TYPE_ACCENT.skill
              const st = STATUS[d.status || 'idle'] || STATUS.idle
              const out = (outputs[n.id] || '').trim()
              const m = metas[n.id] || null
              const failed = runErrors[n.id]
              const active = sel === n.id
              return (
                <div key={n.id} className="relative flex gap-3 pb-3 last:pb-0">
                  {/* 左：序号 + 竖向连接线，表达「顺序」而不是「自由坐标」 */}
                  <div className="flex w-8 shrink-0 flex-col items-center pt-1">
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-full text-[11.5px] font-semibold tabular-nums"
                      style={{ background: acc.soft, color: acc.text, border: `1px solid ${acc.line}` }}
                    >
                      {i + 1}
                    </span>
                    {i < nodes.length - 1 && (
                      <span
                        className="mt-1 w-px flex-1 rounded"
                        style={{ background: 'var(--wb-border-strong)' }}
                      />
                    )}
                  </div>

                  {/* 右：步骤卡片 */}
                  <div
                    onClick={() => onSelect(n.id)}
                    className={`relative min-w-0 flex-1 cursor-pointer overflow-hidden rounded-[12px] border bg-[color:var(--wb-surface)] px-3.5 py-2.5 pl-4 shadow-[var(--wb-shadow-xs)] transition hover:shadow-[var(--wb-shadow-sm)] ${
                      active ? 'ring-2 ring-[color:var(--wb-accent)] ring-offset-1' : ''
                    } ${d.status === 'running' ? 'wb-anim-pulse' : ''}`}
                    style={{ borderColor: active ? 'var(--wb-accent)' : 'var(--wb-border)' }}
                  >
                    <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: acc.line }} />

                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-[color:var(--wb-text)]">
                            {d.title || d.key}
                          </span>
                          <span
                            className="shrink-0 whitespace-nowrap rounded-full px-2 py-[1px] text-[11px] font-medium leading-[17px]"
                            style={{ background: acc.soft, color: acc.text }}
                          >
                            {TYPE_LABEL[d.ntype] || '节点'}
                          </span>
                          {d.ntype === 'tool' && (
                            <span className="shrink-0 whitespace-nowrap rounded-full bg-[color:var(--wb-ok-soft)] px-2 py-[1px] text-[11px] font-medium leading-[17px] text-[color:var(--wb-ok)]">
                              Dify · {String(d.config?.app_id || '默认应用')}
                            </span>
                          )}
                        </div>
                        <div
                          className="mt-0.5 truncate text-[11.5px] text-[color:var(--wb-text-soft)]"
                          title={subtitle(d)}
                        >
                          {subtitle(d)}
                        </div>
                      </div>
                      <div
                        className="flex shrink-0 items-center gap-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <IconBtn
                          icon="chevronUp"
                          size="sm"
                          ariaLabel="上移一步"
                          title="上移一步"
                          disabled={i === 0}
                          onClick={() => onMove(n.id, -1)}
                        />
                        <IconBtn
                          icon="chevronDown"
                          size="sm"
                          ariaLabel="下移一步"
                          title="下移一步"
                          disabled={i === nodes.length - 1}
                          onClick={() => onMove(n.id, 1)}
                        />
                        <IconBtn
                          icon="refresh"
                          size="sm"
                          ariaLabel="只跑这一步"
                          title="只跑这一步"
                          disabled={running}
                          onClick={() => onRun(n.id)}
                        />
                        <IconBtn
                          icon="trash"
                          size="sm"
                          tone="danger"
                          ariaLabel="删除这一步"
                          title="删除这一步"
                          onClick={() => onDelete(n.id)}
                        />
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StatusTag tone={st.tone}>{st.text}</StatusTag>
                      {m?.model && (
                        <span className="truncate text-[11px] text-[color:var(--wb-muted)]">{m.model}</span>
                      )}
                      {m?.elapsed_ms != null && (
                        <span className="text-[11px] tabular-nums text-[color:var(--wb-muted)]">
                          {m.elapsed_ms} ms
                        </span>
                      )}
                      <span className="ml-auto text-[11px] tabular-nums text-[color:var(--wb-muted)]">
                        {d.key}
                      </span>
                    </div>

                    {failed && (
                      <div className="mt-1.5 rounded-[8px] bg-[color:var(--wb-danger-soft)] px-2 py-1 text-[11.5px] leading-relaxed text-[color:var(--wb-danger)]">
                        {failed?.label || '运行失败'}：{failed?.message || '未知原因'}
                      </div>
                    )}

                    {out && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onExpandOutput(n.id)
                        }}
                        className="mt-2 block w-full rounded-[9px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-1.5 text-left transition hover:border-[color:var(--wb-accent)]"
                      >
                        <div className="mb-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-[color:var(--wb-muted)]">
                          产出摘要 · 点击展开全文
                        </div>
                        <div className="line-clamp-2 text-[11.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                          {out.slice(0, 300)}
                        </div>
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="mt-2 rounded-[12px] border border-dashed border-[color:var(--wb-border-strong)] bg-[color:var(--wb-surface)] px-3 py-2.5">
          <div className="mb-2 text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">
            添加步骤（追加到末尾）
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ADD_OPTS.map((o) => (
              <Btn key={o.t} size="sm" onClick={() => onAdd(o.t, '')}>
                <Icon name="plus" size={12} />
                {o.l}
              </Btn>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
            「技能」加完在右侧选具体技能；「自定义」可自己写 system 与指令，占位符：{PROMPT_HINT}
          </p>
        </div>
      </div>
    </div>
  )
}
