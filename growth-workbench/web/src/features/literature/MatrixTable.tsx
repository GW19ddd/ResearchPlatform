/**
 * 对比矩阵表：横向比较相关工作，填满后 Related Work 基本能照着写。
 *
 * 纯展示 + 三个回调，不碰数据获取，方便单独复用/替换。
 */
import { Btn, Empty } from '../../components/ui'

export default function MatrixTable({
  matrix,
  onAddDim,
  onDropDim,
  onSaveCell,
}: {
  matrix: any
  onAddDim: () => void
  onDropDim: (name: string) => void
  onSaveCell: (literatureId: number, dim: string, value: string) => void
}) {
  return (
    <div className="rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-sm)]">
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-[color:var(--wb-text)]">相关工作对比矩阵</h2>
        <Btn onClick={onAddDim}>加维度</Btn>
      </div>
      <div className="p-4">
        {!matrix || matrix.papers.length === 0 ? (
          <Empty text="先录入文献，再横向对比" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[12px]">
              <thead>
                <tr>
                  <th className="border-b border-[color:var(--wb-border)] px-2 py-2 text-left font-medium text-[color:var(--wb-muted)]">
                    文献
                  </th>
                  {matrix.dimensions.map((d: string) => (
                    <th
                      key={d}
                      className="border-b border-[color:var(--wb-border)] px-2 py-2 text-left font-medium text-[color:var(--wb-muted)]"
                    >
                      <span className="flex items-center gap-1">
                        {d}
                        <button
                          className="text-[color:var(--wb-muted)] transition hover:text-[color:var(--wb-danger)]"
                          onClick={() => onDropDim(d)}
                          title="删除该维度"
                        >
                          ×
                        </button>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.papers.map((p: any) => (
                  <tr key={p.id} className="hover:bg-[color:var(--wb-surface-alt)]">
                    <td className="border-b border-[color:var(--wb-border)] px-2 py-1.5 align-top text-[color:var(--wb-text)]">
                      {p.title}
                    </td>
                    {matrix.dimensions.map((d: string) => (
                      <td
                        key={d}
                        className="border-b border-[color:var(--wb-border)] px-2 py-1.5 align-top"
                      >
                        <input
                          defaultValue={p.cells[d] || ''}
                          onBlur={(e) => onSaveCell(p.id, d, e.target.value)}
                          className="w-full rounded-[6px] border border-transparent bg-transparent px-1 py-0.5 text-[12px] outline-none transition hover:border-[color:var(--wb-border-strong)] focus:border-[color:var(--wb-accent)] focus:bg-[color:var(--wb-surface)]"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-[color:var(--wb-muted)]">
          这张表填满后，Related Work 基本可以直接照着写。单元格失焦即保存。
        </p>
      </div>
    </div>
  )
}
