/**
 * 由参考画廊的候选（AgentFigureGallery）生成「可编辑的图表 spec」。
 *
 * 背景：画廊只随库分发参考图 + 元数据，不随附源数据（script_path 指向未拉取的 repos/）。
 * 所以这里生成的是**版式复刻 + 示意数字**：
 *   - 面板构成、坐标轴含义、参考线（阈值/区域线）、配色 → 照参考图；
 *   - 点位 → 用参考 id 做种子的确定性示意数据（同一张参考每次生成的图一致，可编辑替换）。
 * note 里必须写明「示意数据」，不得当作实测结论。
 *
 * 默认示例（编辑器打开时的内容）与画廊「用作样板」共用本模块，保证两处口径一致。
 */
import type { ChartGuide, ChartSpec } from './ChartCanvas'
import type { GalleryCandidate } from './FigureGallery'

/* ---------- 确定性随机：同一候选 → 同一套示意点 ---------- */

function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 近高斯抖动（三次均匀分布求和），用于把点散在簇中心周围。 */
function jitter(rnd: () => number, amp: number): number {
  return (rnd() + rnd() + rnd() - 1.5) * amp
}

/* ---------- 逐候选复刻模板（精选榜里的高质量参考，手工对照参考图登记） ---------- */

type ReproTemplate = {
  /** 面板标题（照参考图） */
  panels: string[]
  x_label: string
  y_label: string
  /** 簇中心（如 χ1 的 rotamer 井），点位围绕这些值散开 */
  wells: number[]
  /** 取值域，用于散点范围 */
  domain: [number, number]
  /** 每个面板的点数 */
  n: number
  guides: ChartGuide[]
  /** 点色（照参考图，通常近黑） */
  point_color: string
}

const REPRO: Record<string, ReproTemplate> = {
  // KULL-Centre/AF2chi · ubq_chi1_js_fixed_boxplots_points.pdf
  // 三联散点：χ1(i) vs χ1(i+1) 的二面角分布，虚线为 gauche− / gauche+ / trans 三个 rotamer 井
  'MULTI-1DBA7BB547': {
    panels: ['X1 AF2 structure', 'X1 PDB ensemble', 'X1 1XQQ ensemble'],
    x_label: 'χ1(i) (°)',
    y_label: 'χ1(i+1) (°)',
    wells: [60, 180, 300],
    domain: [0, 360],
    n: 40,
    guides: [
      { axis: 'y', value: 60, label: 'gauche−', color: '#2a9d8f' },
      { axis: 'y', value: 180, label: 'gauche+', color: '#e9c46a' },
      { axis: 'y', value: 300, label: 'trans', color: '#c1440e' },
    ],
    point_color: '#1f2430',
  },
}

/* ---------- 通用模板：非登记候选按 plot_type 生成「同型版式」 ---------- */

const TYPE_LABEL: Record<string, string> = {
  bar_chart: '柱状图',
  line_chart: '折线图',
  scatter_plot: '散点图',
  heatmap_matrix: '热力矩阵',
  box_violin_distribution: '箱线 / 分布',
  embedding_plot: '嵌入投影',
  benchmark_performance: '基准对比',
  multi_panel_figure: '多面板组合图',
  spatial_map: '空间地图',
  microscopy_panel: '显微面板',
}

const PLOT_LABEL = (pt?: string) => TYPE_LABEL[pt || ''] || pt || 'figure'

function scatterPanels(seed: string, count: number, n: number): { title: string; points: { x: number; y: number }[] }[] {
  const rnd = mulberry32(hashSeed(seed))
  return Array.from({ length: count }, (_, i) => ({
    title: `Panel ${String.fromCharCode(65 + i)}`,
    points: Array.from({ length: n }, () => ({
      x: Math.round(rnd() * 1000) / 10,
      y: Math.round(rnd() * 1000) / 10,
    })),
  }))
}

/** 参考图复刻：把 wells 网格 + 抖动铺成散点（χ1 这类二维二面角图的真实形状）。
 *  真实 AF2 图是「几团密集簇 + 少量离群点」，不是均匀铺设，故簇内抖动幅度很小、离群点 15%。 */
function wellPoints(rnd: () => number, tpl: ReproTemplate): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  const [lo, hi] = tpl.domain
  const amp = (hi - lo) / 45
  const pick = () => tpl.wells[Math.floor(rnd() * tpl.wells.length)]
  while (pts.length < tpl.n) {
    const outlier = rnd() < 0.15
    const wx = outlier ? wellValues(rnd, tpl) : pick()
    const wy = outlier ? wellValues(rnd, tpl) : pick()
    const x = Math.round(Math.min(hi, Math.max(lo, wx + jitter(rnd, amp))))
    const y = Math.round(Math.min(hi, Math.max(lo, wy + jitter(rnd, amp))))
    pts.push({ x, y })
  }
  return pts
}

/** 离群点在某个井附近偏出一段（参考图里那些孤立的点）。 */
function wellValues(rnd: () => number, tpl: ReproTemplate): number {
  const [lo, hi] = tpl.domain
  const base = tpl.wells[Math.floor(rnd() * tpl.wells.length)]
  const off = (rnd() < 0.5 ? -1 : 1) * (40 + rnd() * 90)
  return Math.min(hi, Math.max(lo, base + off))
}

/** 元数据里的口径说明（工具名 / 借用点），拼进 note 供人核对。 */
function borrowNote(c: GalleryCandidate): string {
  const tags = Array.isArray(c.tags) ? c.tags : []
  const borrow = Array.isArray(c.what_to_borrow) ? c.what_to_borrow : []
  const bits = [...borrow, ...tags].filter(Boolean).slice(0, 3)
  return bits.length ? `参考要点：${Array.from(new Set(bits)).join(' / ')}。` : ''
}

/**
 * 由画廊候选生成图表 spec（默认示例 / 用作样板共用）。
 * 返回的 spec 一定带 note 说明「来自哪张参考图 + 数字是示意」。
 */
export function specFromCandidate(c: GalleryCandidate): ChartSpec {
  const id = c.display_id || c.stable_candidate_id || c.candidate_id
  const repo = c.source_repo || 'unknown'
  const pt = c.plot_type || c.primary_plot_type || ''
  const palette = Array.isArray(c.palette) && c.palette.length ? c.palette : undefined
  const rnd = mulberry32(hashSeed(id))
  const source = `参考 ${id}（${repo} · ${PLOT_LABEL(pt)}）`
  const reference = {
    id,
    repo,
    plot_type: pt,
    ...(c.preview_path ? { preview_path: c.preview_path } : {}),
  }
  const honesty = '点位为示意数据（illustrative），可编辑替换为真实数字；手写 spec 不得作为实测结论。'

  const tpl = REPRO[id]
  if (tpl) {
    return {
      type: 'scatter',
      title: `复刻 ${id} · ${repo}`,
      x_label: tpl.x_label,
      y_label: tpl.y_label,
      colors: [tpl.point_color],
      point_radius: 2.6,
      x_domain: tpl.domain,
      y_domain: tpl.domain,
      panels: tpl.panels.map((title) => ({
        type: 'scatter' as const,
        title,
        x_label: tpl.x_label,
        y_label: tpl.y_label,
        points: wellPoints(rnd, tpl),
      })),
      guides: tpl.guides,
      note: `版式照 ${source} 复刻：三联散点 + 三条参考线（${tpl.guides
        .map((g) => `${g.label}=${g.value}°`)
        .join('、')}）。${honesty}`,
      reference,
    }
  }

  if (pt === 'multi_panel_figure') {
    const panels = scatterPanels(`${id}-mp`, 3, 22)
    return {
      type: 'scatter',
      title: `复刻 ${id} · ${repo}`,
      x_label: 'x',
      y_label: 'y',
      ...(palette ? { colors: palette } : {}),
      panels: panels.map((p) => ({ type: 'scatter', title: p.title, points: p.points })),
      note: `版式照 ${source} 复刻为三联面板。${borrowNote(c)}${honesty}`,
      reference,
    }
  }

  if (pt === 'line_chart') {
    const cats = ['1', '2', '3', '4', '5', '6', '7', '8']
    const mk = () => cats.map(() => Math.round((20 + rnd() * 70) * 10) / 10)
    return {
      type: 'line',
      title: `复刻 ${id} · ${repo}`,
      x_label: '时间 / 步骤',
      y_label: '数值',
      ...(palette ? { colors: palette } : {}),
      categories: cats,
      series: [
        { name: '系列 1', values: mk() },
        { name: '系列 2', values: mk() },
      ],
      note: `版式照 ${source} 复刻（折线 + 图例）。${borrowNote(c)}${honesty}`,
      reference,
    }
  }

  if (pt === 'heatmap_matrix') {
    const cats = ['A', 'B', 'C', 'D']
    return {
      type: 'bar',
      title: `复刻 ${id} · ${repo}`,
      x_label: '类别',
      y_label: '数值',
      ...(palette ? { colors: palette } : {}),
      categories: cats,
      series: [{ name: '数值', values: cats.map(() => Math.round((10 + rnd() * 90) * 10) / 10) }],
      note: `参考图是热力矩阵（${source}）；实时预览暂只支持柱 / 线 / 散点，先按矩阵行汇总成柱状占位。${honesty}`,
      reference,
    }
  }

  if (pt === 'scatter_plot' || pt === 'embedding_plot' || pt === 'spatial_map' || pt === 'microscopy_panel') {
    const pts = scatterPanels(`${id}-sc`, 1, 28)[0].points
    return {
      type: 'scatter',
      title: `复刻 ${id} · ${repo}`,
      x_label: 'x',
      y_label: 'y',
      ...(palette ? { colors: palette } : {}),
      points: pts,
      note: `版式照 ${source} 复刻（散点分布）。${borrowNote(c)}${honesty}`,
      reference,
    }
  }

  // bar_chart / benchmark_performance / box_violin_distribution / 未知类型
  const cats = ['组 1', '组 2', '组 3', '组 4']
  return {
    type: 'bar',
    title: `复刻 ${id} · ${repo}`,
    x_label: '分组',
    y_label: '数值',
    ...(palette ? { colors: palette } : {}),
    categories: cats,
    series: [{ name: '数值', values: cats.map(() => Math.round((15 + rnd() * 80) * 10) / 10) }],
    note: `版式照 ${source} 复刻（分组柱）。${borrowNote(c)}${honesty}`,
    reference,
  }
}

/** 画廊不可用时的兜底示例（保持原有「方法对比」示意，功能不受影响）。 */
export function fallbackSpec(): ChartSpec {
  return {
    type: 'bar',
    title: '示例：方法对比（示意数据，非实测）',
    x_label: '方法',
    y_label: '准确率',
    categories: ['Baseline', 'Ours'],
    series: [{ name: '准确率', values: [0.72, 0.86] }],
    points: [],
    note: '画廊暂时不可用，展示内置示意数据（illustrative）：手动填写的 spec 不得作为实测结果进论文结论。',
  }
}
