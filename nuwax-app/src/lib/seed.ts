/**
 * 建库种子 + 演示数据 —— 原 Python 后端 seed.py / 演示快照脚本的浏览器端等价物。
 *
 * 为什么要有这个文件：原来「首次启动后端会建好空表、再灌一份演示数据」这件事，
 * 搬到纯前端后必须有人做同样的初始化，否则新用户进来看不到任何东西，
 * 而演示数据本身承担了「告诉用户这个工具该怎么用」的说明作用。
 *
 * 两条铁律：
 * 1. seedBase() 只负责「骨架」（论文七阶段 / 七章节 / 四条奖励），且逐表判空，
 *    用户改过就不会被覆盖。
 * 2. seedDemo() 是一个**具体课题**的完整快照（OpenFOAM 智能体 + OF-FaultBench），
 *    不是随机垃圾数据。只有贴合真实科研场景，首页的红条、卡点、积分曲线
 *    才演示得出产品想表达的「把努力落到可交付成果上」。
 */
import db, { daysAgo, weekStart } from './db'
import { BUILTIN_TEMPLATES } from './canvas-templates'

// ---------------------------------------------------------------------------
// 时间辅助
// ---------------------------------------------------------------------------

/** 两位补零，日期 / 时间片段的统一格式 */
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 把 Date 格式化成后端同款「本地 ISO 秒级」时间戳，例如 2026-09-29T14:03:07 */
function fmtIso(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** 相对今天的 n 天前的 ISO 秒级时间戳，用于演示数据 */
function agoIso(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return fmtIso(d)
}

/**
 * 今天之后 n 天的日期（YYYY-MM-DD）。
 * 刻意只给日期、不带时间：due_date 在全库都是纯日期口径
 * （advisor.ts 的逾期判断就是 `due_date < today()` 的字符串比较），
 * 掺进时间后缀虽然仍能比较，但会让「当天到期不算逾期」这条规则变得含糊。
 */
function daysAhead(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------------------------------------------------------------------------
// 建库种子
// ---------------------------------------------------------------------------

/** 论文七阶段：第 1 个默认在进行，其余待办 —— 让首页一进去就有「当前阶段」 */
const STAGE_NAMES = [
  '选题与定位',
  '实验设计与跑批',
  '数据整理与图表',
  '正文写作',
  '内部修改',
  '投稿',
  '返修',
]

/** 论文七章节及其目标字数：目标字数是写作进度的分母，必须建库时就有 */
const SECTION_SEED: [string, number][] = [
  ['Introduction', 800],
  ['Related Work', 1200],
  ['Method', 1500],
  ['Experiments', 1500],
  ['Results', 1000],
  ['Discussion', 600],
  ['Conclusion', 400],
]

/** 四条奖励：cost 递增，覆盖「小额即时满足 → 大额长线激励」 */
const REWARD_SEED: [string, number][] = [
  ['一杯奶茶', 200],
  ['游戏 1 小时', 300],
  ['看一场电影', 500],
  ['一次购物额度', 1000],
]

/** 建库种子：论文七阶段、七个章节、四条奖励。表为空时才灌。 */
export function seedBase(): void {
  // 逐表判空而不是整体判空：用户可能只删掉了奖励表，不该因此把阶段也重灌一遍
  if (db.all('paper_stages').length === 0) {
    STAGE_NAMES.forEach((name, i) => {
      db.insert('paper_stages', {
        name,
        sort_order: i,
        status: i === 0 ? 'doing' : 'todo',
        // blocker / next_action 显式置空，避免列表页拿到 undefined 渲染成 "undefined"
        blocker: '',
        next_action: '',
      })
    })
  }

  if (db.all('paper_sections').length === 0) {
    SECTION_SEED.forEach(([name, target_words], i) => {
      db.insert('paper_sections', {
        name,
        sort_order: i,
        word_count: 0,
        target_words,
        status: 'todo',
      })
    })
  }

  if (db.all('rewards').length === 0) {
    for (const [name, cost] of REWARD_SEED) {
      db.insert('rewards', { name, cost, redeemed_count: 0 })
    }
  }
}

// ---------------------------------------------------------------------------
// 演示数据
// ---------------------------------------------------------------------------

/**
 * 内置画布模板的读取适配。
 * canvas-templates.ts 由并行任务维护，这里不假设它是数组还是 key→模板 的字典，
 * 两种形态都归一成数组再按 key 查找，避免因为对方数据结构细节而炸掉首次灌库。
 */
type SeedTemplateNode = {
  node_key: string
  type: string
  skill_id?: string
  title?: string
  x?: number
  y?: number
  config?: Record<string, unknown>
}
type SeedTemplateEdge = { source_key: string; target_key: string }
type SeedTemplate = {
  key: string
  name: string
  nodes: SeedTemplateNode[]
  edges: SeedTemplateEdge[]
}

function findTemplate(key: string): SeedTemplate | null {
  const raw = BUILTIN_TEMPLATES as unknown
  const list: SeedTemplate[] = Array.isArray(raw)
    ? (raw as SeedTemplate[])
    : Object.entries(raw as Record<string, SeedTemplate>).map(([k, t]) => ({
        ...(t as SeedTemplate),
        key: (t as SeedTemplate).key ?? k,
      }))
  return list.find((t) => t.key === key) ?? null
}

/**
 * 灌一张内置模板画布。
 *
 * 为什么不在本文件手写画布节点：节点里的 skill_id 必须和 SkillPalette /
 * 执行引擎认识的技能 id 完全一致，手写一份就是第二个「真相来源」，
 * 迟早漂移。直接复用模板定义，等于让种子数据和运行时共用同一份契约。
 */
function seedCanvas(key: string): void {
  const tpl = findTemplate(key)
  if (!tpl) return

  const canvas = db.insert('canvases', {
    name: tpl.name,
    template: key,
    created_at: agoIso(4),
    updated_at: agoIso(4),
  })

  for (const n of tpl.nodes) {
    db.insert('canvas_nodes', {
      canvas_id: canvas.id,
      node_key: n.node_key,
      type: n.type,
      skill_id: n.skill_id ?? '',
      title: n.title ?? '',
      x: n.x ?? 0,
      y: n.y ?? 0,
      // 存储层只认字符串：config_json 与运行时解析口径保持一致
      config_json: JSON.stringify(n.config ?? {}),
    })
  }

  for (const e of tpl.edges) {
    db.insert('canvas_edges', {
      canvas_id: canvas.id,
      source_key: e.source_key,
      target_key: e.target_key,
    })
  }
}

/** 演示数据：一份完整可信的科研工作台快照。 */
export function seedDemo(): void {
  // 以 ideas 是否已有数据当「已灌过」的哨兵：演示数据里 daily_checkins.date 唯一、
  // 各表还存在 id 交叉引用，重复灌会造出两份同名记录并打破唯一约束。
  // 判空即可让本函数幂等，重复调用不会污染库。
  if (db.all('ideas').length > 0) return

  // ---------------------------------------------------------------- 创新点
  // 三条 idea 覆盖 captured / screening / selected 三种状态，让筛选器一进去就有内容；
  // 方向统一是 "LLM agent for OpenFOAM"，对应课题主题。
  const ideaIds: number[] = []
  ideaIds.push(
    db.insert('ideas', {
      title: '分层评价体系驱动的错误归因',
      one_liner: '把 OpenFOAM 故障分成执行/数值/物理三层，让智能体先定位层再修，而不是直接改字典',
      direction: 'LLM agent for OpenFOAM',
      novelty: 4,
      feasibility: 4,
      impact: 4,
      effort: 3,
      status: 'selected',
      notes: '对应 OF-FaultBench 的评价分层，也是目前 method 部分的主线',
      created_at: agoIso(20),
      updated_at: agoIso(3),
    }).id,
  )
  ideaIds.push(
    db.insert('ideas', {
      title: '反馈驱动迭代修复 Feedback-driven Refinement',
      one_liner: '把求解器报错与残差曲线当作反馈信号，让 agent 多轮自我修正而非一次性生成',
      direction: 'LLM agent for OpenFOAM',
      novelty: 4,
      feasibility: 3,
      impact: 5,
      effort: 4,
      status: 'screening',
      notes: '导师周会提过，可考虑作为第二篇的切入点',
      created_at: agoIso(12),
      updated_at: agoIso(2),
    }).id,
  )
  ideaIds.push(
    db.insert('ideas', {
      title: '基于 454 个 tutorial 的案例检索增强',
      one_liner: '用内置 tutorial 库做 few-shot 检索源，替代纯参数记忆',
      direction: 'LLM agent for OpenFOAM',
      novelty: 2,
      feasibility: 5,
      impact: 2,
      effort: 2,
      status: 'captured',
      notes: 'TerminalCFD 已有案例库，实现成本低但新颖性不足',
      created_at: agoIso(8),
      updated_at: agoIso(8),
    }).id,
  )

  // ---------------------------------------------------------------- 文献
  // 两篇读完（真实存在的名字）、两篇待补：让「已读/待读」的进度对照成立，
  // 「待补」也顺手演示了 Related Work 的核心缺口。
  const litIds: number[] = []
  litIds.push(
    db.insert('literature', {
      title: 'OpenFOAM 2406 官方文档与 tutorial 库',
      authors: 'OpenFOAM Foundation',
      year: 2024,
      venue: 'openfoam.org',
      url: 'https://www.openfoam.org/documentation/',
      status: 'done',
      rating: 4,
      relevance: '工具基础',
      notes: '454 个 tutorial 是案例检索的来源，也是 foamCheck 语法校验的对照基准',
      tags: '基础,工具',
      created_at: agoIso(25),
      updated_at: agoIso(10),
    }).id,
  )
  litIds.push(
    db.insert('literature', {
      title: 'ChatCFD（TerminalCFD 的上游 fork）',
      authors: '—',
      year: 2024,
      venue: 'GitHub',
      url: '',
      status: 'done',
      rating: 4,
      relevance: '直接相关',
      notes: 'TerminalCFD 由其 fork 而来，重点对比它在错误定位上的策略差异',
      tags: '基线,对比',
      created_at: agoIso(25),
      updated_at: agoIso(10),
    }).id,
  )
  litIds.push(
    db.insert('literature', {
      title: '【待补】LLM agent 自动修复 CFD 案例相关工作',
      authors: '待检索',
      year: null,
      venue: '待定',
      url: '',
      status: 'todo',
      rating: 3,
      relevance: 'Related Work 核心',
      notes: '',
      tags: 'Related Work',
      created_at: agoIso(5),
      updated_at: agoIso(5),
    }).id,
  )
  litIds.push(
    db.insert('literature', {
      title: '【待补】Feedback-driven Refinement 方法论文',
      authors: '待检索',
      year: null,
      venue: '待定',
      url: '',
      status: 'todo',
      rating: 3,
      relevance: '第二篇的可能锚点',
      notes: '',
      tags: 'Refinement',
      created_at: agoIso(5),
      updated_at: agoIso(5),
    }).id,
  )

  // ---------------------------------------------------------------- 文献矩阵
  // 5 维度 × 4 文献 = 20 格。值矩阵按列对应上面按序插入的 4 篇文献；
  // 第 3、4 篇是「待补」，除占位符 — 外不作任何臆断，保证演示数据不自相矛盾。
  const MATRIX_DIMS = ['是否开源', '评测集', '错误分层归因', '是否需要人工', '支持 OpenFOAM 2406']
  const MATRIX_VALUES: string[][] = [
    ['是', '是', '—', '—'],
    ['454 tutorial', '自研小规模', '—', '—'],
    ['无', '单层', '—', '—'],
    ['需要', '需要', '—', '—'],
    ['是', '部分', '—', '—'],
  ]
  // 外层遍历维度：GET /literature/matrix 按单元格「首次出现顺序」还原列顺序，
  // 这样插入完列序就是上面定义的顺序，不依赖 sort_order（它只作辅助）。
  MATRIX_DIMS.forEach((dim, di) => {
    litIds.forEach((litId, li) => {
      db.insert('lit_matrix', {
        literature_id: litId,
        dim_name: dim,
        dim_value: MATRIX_VALUES[di][li],
        sort_order: di,
      })
    })
  })

  // ---------------------------------------------------------------- 实验
  const exp = db.insert('experiments', {
    name: 'OF-FaultBench Phase 1：5 方法 × 15 故障样本',
    hypothesis: '引入错误分层归因后，diagnosis_correct 应显著高于纯 LLM 方法',
    design:
      '方法：Rule-based / LLM-only / RAG-LLM / Log-guided / PhyLog-Repair；样本：F1 边界语法、F2 数值设置、F3 物理模型；指标：修复成功率、diagnosis_correct、耗时',
    status: 'analyzing',
    config_json: JSON.stringify({ faults: ['F1', 'F2', 'F3'], methods: 5, samples: 15 }),
    created_at: agoIso(15),
    updated_at: agoIso(1),
  })

  // 结果故意包含成功与失败两类，且失败样本正是「F1 全方法 0/24」这条卡点的证据，
  // 让实验页 → 论文卡点 → 首页告警三层叙事能自洽。
  const expResults: [string, string, number, number, string, string][] = [
    ['F1 边界语法', 'Rule-based', 0, 0.3, '全方法 0/24，语法错误之外的盲区', agoIso(10)],
    ['F1 边界语法', 'Log-guided', 0, 12.4, '日志信息不足以定位边界条件', agoIso(10)],
    ['F2 数值设置', 'Rule-based', 1, 0.4, '规则覆盖充分', agoIso(9)],
    ['F3 物理模型', 'PhyLog-Repair', 1, 31.2, '物理层归因有效，样本偏少', agoIso(8)],
    ['F2 数值设置', 'LLM-only', 1, 18.7, '偶发过度修改', agoIso(8)],
  ]
  for (const [case_name, method, success, time_s, notes, created_at] of expResults) {
    db.insert('exp_results', {
      experiment_id: exp.id,
      case_name,
      method,
      success,
      metrics_json: JSON.stringify({ success_rate: success, time_s }),
      notes,
      created_at,
    })
  }

  // ---------------------------------------------------------------- 论文阶段覆盖
  // 先建 name → 行 的索引，再按阶段名打补丁：种子里的阶段名是唯一稳定标识，
  // 不依赖自增 id 的具体数值。
  const stageByName = new Map<string, any>()
  for (const s of db.all('paper_stages')) stageByName.set(String(s.name), s)
  const patchStage = (name: string, patch: Record<string, unknown>) => {
    const s = stageByName.get(name)
    if (s) db.update('paper_stages', s.id, patch)
  }

  patchStage('选题与定位', { status: 'done', updated_at: agoIso(30) })
  patchStage('实验设计与跑批', { status: 'done', updated_at: agoIso(6) })
  // 把「数据整理与图表」设为 blocked 并写清 blocker / next_action：
  // 首页的卡点告警、paper/overview 的 current 都靠这条才有东西可展示。
  patchStage('数据整理与图表', {
    status: 'blocked',
    blocker: 'F1 边界语法全方法 0/24，diagnosis_correct 全部方法为 0，缺一个能站住的解释',
    next_action: '补一组消融实验，把失败归因写成一张对比表',
    updated_at: agoIso(5),
  })
  patchStage('正文写作', {
    status: 'doing',
    next_action: '先写 Method 与 Experiments 两节',
    updated_at: agoIso(1),
  })

  // ---------------------------------------------------------------- 论文章节覆盖
  const sectionByName = new Map<string, any>()
  for (const s of db.all('paper_sections')) sectionByName.set(String(s.name), s)
  const patchSection = (name: string, patch: Record<string, unknown>) => {
    const s = sectionByName.get(name)
    if (s) db.update('paper_sections', s.id, patch)
  }

  // 所有章节 updated_at 都贴近「今天」，营造「刚刚在写」的真实感；
  // 只有 Method / Experiments / Introduction 有实质字数，对应上面「先写这两节」。
  patchSection('Introduction', { word_count: 320, status: 'doing', updated_at: agoIso(1) })
  patchSection('Related Work', { word_count: 0, status: 'todo', updated_at: agoIso(1) })
  patchSection('Method', { word_count: 860, status: 'doing', updated_at: agoIso(1) })
  patchSection('Experiments', { word_count: 640, status: 'doing', updated_at: agoIso(1) })
  patchSection('Results', { word_count: 0, status: 'todo', updated_at: agoIso(1) })
  patchSection('Discussion', { word_count: 0, status: 'todo', updated_at: agoIso(1) })
  patchSection('Conclusion', { word_count: 0, status: 'todo', updated_at: agoIso(1) })

  // ---------------------------------------------------------------- 周计划与任务
  // week_start 用 weekStart()：GET /plan/current 正是按「本周一」查当前计划，
  // 用实时算出的本周一才能被那条惰性创建逻辑命中，而不是又建一份空周计划。
  const plan = db.insert('weekly_plans', {
    week_start: weekStart(),
    outcomes_json: JSON.stringify([
      '补齐 F1 失败归因的消融实验',
      '写完 Experiments 章节初稿',
      '整理 Related Work 矩阵',
    ]),
    status: 'active',
    review_json: null,
    created_at: agoIso(2),
  })

  // 任务截止日刻意排布成「近期 / 本周内 / 稍远」，其中一条今天+1 天，
  // 方便演示列表的紧迫感与排序。
  const taskSeed: [string, string, number, string][] = [
    ['跑 F1 消融实验：固定 prompt，只改是否给错误分层提示', 'doing', 20, daysAhead(2)],
    ['把 5 方法 × 3 故障画成一张对比表', 'todo', 15, daysAhead(3)],
    ['Experiments 章节补到 1200 字', 'todo', 20, daysAhead(5)],
    ['给导师发本周进度', 'todo', 10, daysAhead(1)],
  ]
  const taskIds: number[] = []
  for (const [title, status, points, due_date] of taskSeed) {
    taskIds.push(
      db.insert('tasks', {
        plan_id: plan.id,
        title,
        status,
        points,
        due_date,
        created_at: agoIso(2),
      }).id,
    )
  }

  // ---------------------------------------------------------------- 日打卡
  // 用 d % N 的取模造出有周期性的数值波动，热力图 / 曲线不会是一条直线，
  // 也避免每行都一样显得是假数据。9 天覆盖大半个 14 天汇报窗口。
  const checkinNotePool = ['实验跑批', '写 Method', '读文献', '改 agent 提示词', '组会']
  const checkinIds = new Map<number, number>()
  for (let d = 9; d >= 1; d--) {
    const id = db.insert('daily_checkins', {
      date: daysAgo(d),
      // sleep_h 保留 1 位小数（与后端 round(...,1) 口径一致）
      sleep_h: Math.round((6.5 + (d % 3) * 0.4) * 10) / 10,
      exercise_min: 20 + (d % 4) * 15,
      focus_min: 120 + (d % 5) * 60,
      mood: 3 + (d % 3),
      note: checkinNotePool[d % 5],
    }).id
    checkinIds.set(d, id)
  }

  // ---------------------------------------------------------------- 导师沟通
  db.insert('advisor_notes', {
    date: daysAgo(13),
    scene: '组会',
    advisor_said: 'F1 全军覆没要给出解释，不能只报成功率',
    my_commitment: '补一组消融实验说明 F1 失败归因',
    due_date: daysAhead(2),
    status: 'open',
  })
  // 第 2 条承诺的 due_date 故意设成「昨天」且保持 open：
  // advisor/pending 会把它标成 overdue、置顶并弹红条，首页因此有一个
  // 真实可信的「逾期提醒」演示点 —— 这是产品刻意保留的效果，不要顺手改成未来日期。
  db.insert('advisor_notes', {
    date: daysAgo(13),
    scene: '组会',
    advisor_said: '可以考虑 Feedback-driven Refinement 这条线',
    my_commitment: '调研 Feedback-driven Refinement 并给一页总结',
    due_date: daysAhead(-1),
    status: 'open',
  })
  db.insert('advisor_notes', {
    date: daysAgo(27),
    scene: '微信',
    advisor_said: '先把 Phase 1 数据整理好再谈第二篇',
    my_commitment: '整理 Phase 1 完整结果表',
    due_date: daysAhead(6),
    status: 'closed',
  })

  // ---------------------------------------------------------------- 积分流水
  // 直接写 points_ledger 而不是走 award()：演示账本要的是一段有起伏的历史
  // （含一笔 -60 的扣分），而 award() 受「周净分下限」夹逼，历史的负分会被裁掉。
  // 合计 100+10+5+50+20+30-60+40 = +195，与首页余额演示值一致。
  //
  // ref_id 尽量指回真实行：账本点开能看到「这笔分是为什么加的」，
  // 没有对应实体的（如周成果）才留 null。
  const ledger: [number, string, string, number | null, string][] = [
    [100, '周成果完成：补齐实验数据', 'plan', plan.id, agoIso(9)],
    [10, '完成任务：跑 F1 消融实验', 'task', taskIds[0] ?? null, agoIso(7)],
    [5, '日打卡', 'checkin', checkinIds.get(6) ?? null, agoIso(6)],
    [50, '论文阶段推进：实验设计与跑批', 'paper_stage', stageByName.get('实验设计与跑批')?.id ?? null, agoIso(6)],
    [20, '读完文献：OpenFOAM 2406 官方文档与 tutorial 库', 'literature', litIds[0] ?? null, agoIso(5)],
    [30, '完成周复盘', 'plan', plan.id, agoIso(4)],
    [-60, '周成果未完成 1 项', 'plan', plan.id, agoIso(2)],
    [40, '创新点验证通过：分层评价体系驱动的错误归因', 'idea', ideaIds[0] ?? null, agoIso(3)],
  ]
  for (const [delta, reason, ref_type, ref_id, created_at] of ledger) {
    db.insert('points_ledger', { delta, reason, ref_type, ref_id, created_at })
  }

  // ---------------------------------------------------------------- 画布
  // 只灌 topic 与 write 两张：覆盖「选题」与「写作」两条最高频的工作流，
  // slides 留空由用户在模板库里自行取用，避免一上来就塞三张重复结构的画布。
  seedCanvas('topic')
  seedCanvas('write')
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 首次进入应用时调用：库是空的就灌种子（含演示数据）。 */
export function ensureSeeded(): void {
  // 用 paper_stages 当空库哨兵：它是 seedBase 必灌的骨架表，
  // 只要它有数据，就说明用户已经初始化过，绝不再动（否则会踩掉用户改动）。
  if (db.all('paper_stages').length === 0) {
    seedBase()
    seedDemo()
  }
}
