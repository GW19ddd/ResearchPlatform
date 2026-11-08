/**
 * 检索结果里的引文网络 —— 对应 Litmaps 右侧那张「语义坐标图」。
 *
 * 与文献页「关联图」是两套视图，互不复用布局：
 *   - 关联图：力导向、白底描边圆、无坐标轴（馆藏关系的长期视图）
 *   - 这里：横轴发表年份 / 纵轴被引次数（对数缩放），空心蓝圆 + 细灰引用线，
 *     是「一次检索结果」的即时快照，节点不落库。
 *
 * 坐标只由真实元数据决定，同数据每次渲染一致（id 哈希只用于去重叠抖动）。
 * 所有 hover/选中详情都是 absolute 浮层，不进文档流，画布高度恒定不抖动。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Btn, IconBtn } from '../../components/ui'
import { compactCount, shortLabel, type DiscoverEdge, type DiscoverPaper } from './discoverApi'

const C_SEED = '#5b6472'
const C_SEED_HALO = '#e6e9fb'
const C_NODE = '#7c8cf2'
const C_ACCENT = '#5145e0'
const C_EDGE = '#dfe5ee'
const C_AXIS = '#c9cfda'
const C_MUTED = '#8a94a6'
const C_TEXT = '#4b5160'

const PAD_L = 52
const PAD_R = 62
const PAD_T = 30
const PAD_B = 56

/** 由 id 决定的确定性抖动，避免同年份 / 同被引的点完全重叠 */
function hash01(id: string, salt: string): number {
  let h = 2166136261
  const s = id + salt
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

type Pos = { x: number; y: number; r: number }

function useSize() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 900, h: 540 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ w: Math.max(360, r.width), h: Math.max(320, r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

export default function DiscoverMap({
  papers,
  edges,
  seedId,
  selectedId,
  onSelect,
  onRefine,
  onImport,
  imported,
  busyImport = '',
  pending = false,
}: {
  papers: DiscoverPaper[]
  edges: DiscoverEdge[]
  seedId: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  onRefine: (p: DiscoverPaper) => void
  onImport: (p: DiscoverPaper) => void
  imported: Set<string>
  busyImport?: string
  pending?: boolean
}) {
  const [ref, { w, h }] = useSize()
  const [zoom, setZoom] = useState(1)
  const [hoverId, setHoverId] = useState<string | null>(null)

  const paperMap = useMemo(() => new Map(papers.map((p) => [p.oa_id, p])), [papers])

  const posMap = useMemo(() => {
    const out = new Map<string, Pos>()
    if (!papers.length) return out
    const innerW = Math.max(80, w - PAD_L - PAD_R)
    const innerH = Math.max(80, h - PAD_T - PAD_B)

    // 坐标按「结果集内相对位置」铺满画布：
    // 绝对量纲（年份 1998–2023、被引 0–135062）会被个别离群论文压成一团，
    // 所以 x 取年份的 5–95 分位做值域（超出夹到边界），y 取 log1p(被引) 的 min–max。
    // 两者都保持单调：越右越晚、越上越高被引，只是刻度非线性。
    const years = papers
      .map((p) => (typeof p.year === 'number' ? p.year : null))
      .filter((y): y is number => y !== null)
      .sort((a, b) => a - b)
    const quantile = (arr: number[], t: number): number =>
      arr[Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * t)))] ?? 2000
    const loY = years.length ? quantile(years, 0.05) - 0.5 : 1999.5
    const hiY = years.length ? quantile(years, 0.95) + 0.5 : 2025.5
    const spanY = Math.max(1, hiY - loY)
    const logs = papers.map((p) => Math.log1p(p.citations || 0))
    const minLog = Math.min(...logs)
    const maxLog = Math.max(...logs)
    const rawSpan = maxLog - minLog
    const spanLog = Math.max(0.001, rawSpan)

    // 先按真实元数据算语义锚点，再做确定性的去重叠松弛：
    // 同一年 / 相近被引的论文会挤在一个点上，松弛只把它们轻微推开，
    // 每一步都拉回锚点（k=0.05），坐标语义仍然成立、且同数据每次渲染一致。
    type Raw = { id: string; x: number; y: number; r: number; ax: number; ay: number }
    const raws: Raw[] = papers.map((p) => {
      const yr = typeof p.year === 'number' ? p.year : loY
      const tY = Math.max(0, Math.min(1, (yr - loY) / spanY))
      // 只有一篇（过程态的种子点）时 min==max，放画布中央而不是掉到底部
      const tC = rawSpan > 0.001 ? (Math.log1p(p.citations || 0) - minLog) / spanLog : 0.5
      const jx = (hash01(p.oa_id, 'x') - 0.5) * innerW * 0.05
      const jy = (hash01(p.oa_id, 'y') - 0.5) * 18
      const bx = PAD_L + tY * innerW + jx
      const by = PAD_T + innerH - tC * innerH + jy
      // 半径按相对被引铺开 6..16；原来 sqrt(被引)*0.9 对 2000+ 被引全部撞上限，
      // 结果所有圆点等大，看不出高被引差异。
      const br = p.oa_id === seedId ? 22 : 6 + 10 * tC
      return { id: p.oa_id, x: bx, y: by, r: br, ax: bx, ay: by }
    })

    for (let iter = 0; iter < 180; iter++) {
      for (let i = 0; i < raws.length; i++) {
        for (let j = i + 1; j < raws.length; j++) {
          const a = raws[i]
          const b = raws[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.hypot(dx, dy) || 1
          const min = a.r + b.r + 10
          if (dist < min) {
            const push = (min - dist) / 2
            const ux = dx / dist
            const uy = dy / dist
            a.x -= ux * push
            a.y -= uy * push
            b.x += ux * push
            b.y += uy * push
          }
        }
      }
      for (const a of raws) {
        a.x += (a.ax - a.x) * 0.05
        a.y += (a.ay - a.y) * 0.05
        a.x = Math.max(PAD_L, Math.min(w - PAD_R, a.x))
        a.y = Math.max(PAD_T, Math.min(h - PAD_B, a.y))
      }
    }

    const cx = w / 2
    const cy = h / 2
    for (const a of raws) {
      // 缩放绕画布中心，HTML 浮层用同一份坐标，缩放后依然对齐
      out.set(a.id, {
        x: cx + (a.x - cx) * zoom,
        y: cy + (a.y - cy) * zoom,
        r: a.r * Math.min(zoom, 1.5),
      })
    }
    return out
  }, [papers, w, h, seedId, zoom])

  // 选中时由左上详情卡承载信息，图上只保留 hover 标签，避免两处重复
  const labelId = hoverId
  const labelPaper = labelId ? paperMap.get(labelId) : null
  const labelPos = labelId ? posMap.get(labelId) : null
  const seed = paperMap.get(seedId)
  const seedPos = posMap.get(seedId)
  const selected = selectedId ? paperMap.get(selectedId) : null

  return (
    <div
      ref={ref}
      className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-[12px] border border-[color:var(--wb-border)] bg-white"
    >
      <svg width={w} height={h} className="absolute inset-0" role="img" aria-label="引文网络图">
        <defs>
          <marker id="disc-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,1 L7,4 L0,7 z" fill={C_EDGE} />
          </marker>
          <marker id="disc-arrow-active" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,1 L7,4 L0,7 z" fill={C_ACCENT} />
          </marker>
        </defs>

        {/* 坐标轴：横轴发表年份，纵轴被引次数（对数）。方向说明交给左下角图例，避免文字叠在一起 */}
        <line x1={PAD_L} y1={h - 30} x2={w - PAD_R + 8} y2={h - 30} stroke={C_AXIS} strokeWidth="1" />
        <polygon points={`${w - PAD_R + 8},${h - 33} ${w - PAD_R + 15},${h - 30} ${w - PAD_R + 8},${h - 27}`} fill={C_AXIS} />
        <line x1={w - 38} y1={h - PAD_B} x2={w - 38} y2={PAD_T - 6} stroke={C_AXIS} strokeWidth="1" />
        <polygon points={`${w - 41},${PAD_T - 6} ${w - 38},${PAD_T - 13} ${w - 35},${PAD_T - 6}`} fill={C_AXIS} />

        {/* 引用边：A → B 表示 A 引用了 B，只画真实 referenced_works 关系 */}
        {edges.map((e, i) => {
          const s = posMap.get(e.source)
          const t = posMap.get(e.target)
          if (!s || !t) return null
          const dx = t.x - s.x
          const dy = t.y - s.y
          const len = Math.hypot(dx, dy) || 1
          const ux = dx / len
          const uy = dy / len
          const active = !!selectedId && (e.source === selectedId || e.target === selectedId)
          const x1 = s.x + ux * (s.r + 2)
          const y1 = s.y + uy * (s.r + 2)
          const x2 = t.x - ux * (t.r + 7)
          const y2 = t.y - uy * (t.r + 7)
          return (
            <line
              key={`${e.source}-${e.target}-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={active ? C_ACCENT : C_EDGE}
              strokeWidth={active ? 1.8 : 1}
              opacity={selectedId ? (active ? 1 : 0.12) : 0.5}
              markerEnd={active ? 'url(#disc-arrow-active)' : 'url(#disc-arrow)'}
            />
          )
        })}

        {/* 节点：种子为实心深色大圆，关联文献为空心蓝圆 */}
        {papers.map((p) => {
          const pos = posMap.get(p.oa_id)
          if (!pos) return null
          const isSeed = p.oa_id === seedId
          const isSel = p.oa_id === selectedId
          const isHover = p.oa_id === hoverId
          const dim = !!selectedId && !isSel && !edges.some(
            (e) => (e.source === selectedId && e.target === p.oa_id) || (e.target === selectedId && e.source === p.oa_id),
          )
          return (
            <g key={p.oa_id} opacity={dim ? 0.32 : 1}>
              {isSeed && (
                <circle cx={pos.x} cy={pos.y} r={pos.r + 10} fill={C_SEED_HALO} opacity="0.85" />
              )}
              {pending && isSeed && (
                <circle cx={pos.x} cy={pos.y} r={pos.r + 10} fill="none" stroke={C_NODE} strokeWidth="1.2">
                  <animate attributeName="r" values={`${pos.r + 8};${pos.r + 30}`} dur="1.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.65;0" dur="1.8s" repeatCount="indefinite" />
                </circle>
              )}
              {(isSel || isHover) && !isSeed && (
                <>
                  <circle cx={pos.x} cy={pos.y} r={pos.r + 6} fill={C_ACCENT} opacity={isSel ? 0.14 : 0.1} />
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={pos.r + 6}
                    fill="none"
                    stroke={C_ACCENT}
                    strokeWidth={isSel ? 1.6 : 1}
                    opacity={isSel ? 0.9 : 0.5}
                  />
                </>
              )}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={pos.r}
                fill={isSeed ? C_SEED : '#ffffff'}
                stroke={isSel || isHover ? C_ACCENT : isSeed ? C_SEED : C_NODE}
                strokeWidth={isSel || isHover ? 2.4 : 1.5}
                className="cursor-pointer"
                onClick={() => onSelect(isSel ? null : p.oa_id)}
                onMouseEnter={() => setHoverId(p.oa_id)}
                onMouseLeave={() => setHoverId(null)}
              />
            </g>
          )
        })}
      </svg>

      {/* 过程态：种子点还在长网络，给一句话说明，避免右栏看起来是空的 */}
      {pending && (
        <div className="pointer-events-none absolute left-1/2 top-[62%] z-10 -translate-x-1/2 text-center text-[11px] leading-relaxed text-[color:var(--wb-muted)]">
          正在等待关联节点…
          <div className="mt-0.5 whitespace-nowrap text-[10px] opacity-70">
            参考文献与施引文献会在检索完成后落到这张图上
          </div>
        </div>
      )}

      {/* 种子常驻短标：Litmaps 的「Pinheiro, 2001」 */}
      {seed && seedPos && seedId !== labelId && (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap text-[10.5px] font-medium"
          style={{ left: seedPos.x, top: seedPos.y + seedPos.r + 12, transform: 'translateX(-50%)', color: C_TEXT }}
        >
          {shortLabel(seed)}
        </div>
      )}

      {/* 悬停标题标签：absolute 浮层，不影响布局高度；选中态交给左上详情卡 */}
      {labelPaper && labelPos && (
        <div
          className="pointer-events-none absolute z-10 max-w-[300px] -translate-x-1/2 rounded-[7px] border border-[color:var(--wb-border)] bg-white/95 px-2 py-1 text-center text-[10.5px] leading-snug shadow-[var(--wb-shadow-sm)]"
          style={{ left: labelPos.x, top: labelPos.y + labelPos.r + 12 }}
        >
          <span className="font-semibold" style={{ color: C_TEXT }}>{shortLabel(labelPaper)}</span>
          <span style={{ color: C_MUTED }}> — {labelPaper.title.slice(0, 70)}{labelPaper.title.length > 70 ? '…' : ''}</span>
        </div>
      )}

      {/* 选中详情卡：absolute 浮层 + 写死宽度，内容变化不撑动画布 */}
      {selected && (
        <div className="absolute left-3 top-3 z-20 w-[252px] rounded-[10px] border border-[color:var(--wb-border)] bg-white p-3 shadow-[var(--wb-shadow-md)]">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
              选中文献
            </span>
            <IconBtn icon="close" size="sm" title="取消选中" ariaLabel="取消选中" onClick={() => onSelect(null)} />
          </div>
          <div className="mt-1.5 text-[12.5px] font-medium leading-snug text-[color:var(--wb-text)]">
            {selected.title}
          </div>
          {selected.authors && (
            <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[color:var(--wb-text-soft)]">
              {selected.authors}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-[color:var(--wb-muted)]">
            {selected.year && <span>{selected.year}</span>}
            {selected.venue && <span className="max-w-[210px] truncate">{selected.venue}</span>}
            {selected.oa && <span className="text-[color:var(--wb-ok)]">开放获取</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-[color:var(--wb-text-soft)]">
            <span>参考文献 <b>{compactCount(selected.references)}</b></span>
            <span>被引 <b>{compactCount(selected.citations)}</b></span>
            <span>
              {selected.relation === 'seed' ? '种子' : selected.relation === 'reference' ? '参考文献' : '施引文献'}
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Btn size="xs" variant="primary" onClick={() => onRefine(selected)}>
              以此为种子
            </Btn>
            <Btn
              size="xs"
              onClick={() => onImport(selected)}
              loading={busyImport === selected.oa_id}
              disabled={imported.has(selected.oa_id)}
            >
              {imported.has(selected.oa_id) ? '已入库' : '加入文献库'}
            </Btn>
            {selected.url && (
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-[color:var(--wb-accent)] underline underline-offset-2"
              >
                原文
              </a>
            )}
          </div>
        </div>
      )}

      {/* 图例：把坐标与边的口径写清楚（方向说明合并到这里，不再单独画轴标签） */}
      <div className="pointer-events-none absolute bottom-9 left-3 z-10 max-w-[460px] text-[10px] leading-[1.6] text-[color:var(--wb-muted)]">
        连线 = 真实引用关系（高亮箭头指向被引文献）· 圆点大小 = 被引次数
        <br />
        横轴发表年份（越右越晚）· 纵轴被引（对数）· 实心圆 = 种子 · 坐标按结果集相对位置铺开
      </div>

      {/* 缩放控件 */}
      <div className="absolute bottom-3 right-3 z-20 flex flex-col items-center gap-0.5 rounded-[9px] border border-[color:var(--wb-border)] bg-white p-1 shadow-[var(--wb-shadow-sm)]">
        <IconBtn icon="plus" size="sm" title="放大" ariaLabel="放大" onClick={() => setZoom((z) => Math.min(1.8, +(z + 0.15).toFixed(2)))} />
        <IconBtn icon="minus" size="sm" title="缩小" ariaLabel="缩小" onClick={() => setZoom((z) => Math.max(0.7, +(z - 0.15).toFixed(2)))} />
        <IconBtn icon="target" size="sm" title="恢复 100%" ariaLabel="恢复 100%" onClick={() => setZoom(1)} />
      </div>
    </div>
  )
}
