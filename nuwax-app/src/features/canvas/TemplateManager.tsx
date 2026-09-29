/**
 * 模板管理弹窗：看清有哪些模板（内置 + 自己存的），一键拿来新建，自存的可以删。
 *
 * 画布页只给「存为模板」按钮，模板的浏览与清理收在这里，工具栏不被撑爆。
 */
import { Btn, Modal, Pill } from '../../components/ui'

export type TemplateInfo = {
  key: string
  name: string
  node_count: number
  builtin?: boolean
  created_at?: string
}

export default function TemplateManager({
  open,
  onClose,
  templates,
  onUse,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  templates: TemplateInfo[]
  onUse: (key: string) => void
  onDelete: (key: string) => void
}) {
  const builtin = templates.filter((t) => t.builtin !== false)
  const mine = templates.filter((t) => t.builtin === false)

  const Row = ({ t }: { t: TemplateInfo }) => (
    <div className="flex items-center gap-2 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">
            {t.name}
          </span>
          {t.builtin === false ? (
            <Pill tone="indigo">我存的</Pill>
          ) : (
            <Pill tone="gray">内置</Pill>
          )}
        </div>
        <div className="text-[10.5px] text-[color:var(--wb-muted)]">
          {t.node_count} 个节点{t.created_at ? ` · ${t.created_at}` : ''}
        </div>
      </div>
      <Btn size="sm" variant="primary" onClick={() => onUse(t.key)}>
        用它新建
      </Btn>
      {t.builtin === false && (
        <Btn size="sm" variant="ghost" onClick={() => onDelete(t.key)} title="删除这个自定义模板">
          删除
        </Btn>
      )}
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title="画布模板" width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-1.5 text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">
            我存的模板
          </div>
          {mine.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-[color:var(--wb-border-strong)] px-3 py-2 text-[11.5px] text-[color:var(--wb-muted)]">
              还没有。在画布上把流水线连好，点工具栏「存为模板」就能冻结成一份，以后一句话复用。
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {mine.map((t) => (
                <Row key={t.key} t={t} />
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-1.5 text-[11.5px] font-medium text-[color:var(--wb-text-soft)]">
            内置模板
          </div>
          <div className="flex flex-col gap-1.5">
            {builtin.map((t) => (
              <Row key={t.key} t={t} />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
