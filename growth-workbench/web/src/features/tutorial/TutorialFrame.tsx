import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PdfViewer from '../../components/PdfViewer'
import { Icon } from '../../components/Icon'
import { Btn } from '../../components/ui'
import { launchTutorialGuide, findTargetInView } from './TutorialGuide'
import TutorialPrologue from './TutorialPrologue'
import TutorialEpilogue from './TutorialEpilogue'

const BASE = '/tutorial/llmutg'

/** 演示资产 ID（与工作台库内真实记录一致） */
const LIT = [
  { id: '4', name: 'REFLEX (Wu & Lim, 2026)', role: 'Jev 机制源（填实原「待补」占位）' },
  { id: '455', name: 'TestPilot (2023)', role: '开发者测试工具范式' },
  { id: '456', name: 'ChatUniTest (2024)', role: '生成-校验流水线' },
  { id: '457', name: 'Pynguin (2022)', role: '搜索式 Python 测试基线' },
  { id: '458', name: 'EvoSuite (2017)', role: '全测试套件搜索基线' },
  { id: '459', name: 'AthenaTest (2022)', role: '纯 LLM 基线' },
]
const IDEAS = [
  { id: '31', tag: 'A', claim: '动态多源反馈图替代静态覆盖排序', neg: '覆盖增益 < 2pp 且 LLM 调用不降反升' },
  { id: '32', tag: 'B', claim: 'Jev 类型化决策 + τ=0.5 置信带', neg: '质量下降超阈值或调用量未降' },
  { id: '33', tag: 'C', claim: 'training-free + 节点级定位', neg: '定位精度不优于随机/行号启发式' },
]

type Shot = { src: string; caption: string }

/** 「试一试」新手引导项：点卡片后用高亮遮罩指到真实界面元素 */
type Try = {
  at: string          // 卡片标题，如「侧栏 · 文献库」
  note: string        // 让读者试什么
  sel?: string        // CSS 选择器定位
  text?: string       // 文本匹配定位（最小面积元素）
  scope?: string      // 只在某个容器内找（如 'main'），避免命中侧栏同名文字
  href?: string       // 可选：新窗口直达
}

type Step = {
  no: string
  id: string
  title: string
  goal: string
  where: string
  paper: string       // 该阶段产出对应论文哪一节 + 倒排写作顺位
  how: string[]
  tips?: string[]
  deliver?: string[]
  trys?: Try[]
  shots?: Shot[]
  asset?: 'ideas' | 'results'
  chapter: string
}

const STEPS: Step[] = [
  {
    no: '01',
    id: 's1',
    title: '论文调研',
    goal: '把「LLM 单元测试生成」领域的文献收进工作台的文献库，并标注与本研究的关联——这就是论文第 2 章 Related Work 的素材。调研的关键不是「多读」，而是每篇都留下结构化记录：它解决什么问题、用什么方法、和我们路线的差异在哪，这样后面写 Related Work 时能直接抽矩阵，不用回头重读。',
    where: '左侧导航「文献库」（/literature）。批量检索可用 litsearch / OpenAlex / Zotero；论文喂送用 paperfeed；想快速弄清领域全景，先在「对话·调研」（/research）里带「调研」胶囊提问，再按它给的线索进文献库补录。',
    paper: '对应论文 §2 Related Work（倒排写作顺位 ②）——这一阶段的笔记直接拼装成 Related Work 各段。',
    how: [
      '打开「文献库」，左侧「智能视图」按「全部 / 最近添加 / 待读 / 在读 / 已读」分层，新导入的默认落「待读」。',
      '右侧「集合」按主题打标签（Agent / benchmark / code / domain-specific…），后续对比矩阵就按集合抽样。',
      '点右上「＋ 新建文献」单篇录入，或通过 Zotero / BibTeX 批量导入——本案例一次导入了 6 篇核心文献。',
      '每读完一篇，在笔记里写三行：问题 / 方法 / 与我们路线的差异。这三行以后就是 Related Work 的一段。',
      '用「关联图」看文献间的引用关系，确认没有漏掉枢纽论文（被引异常高的那几篇）。',
    ],
    trys: [
      {
        at: '侧栏 · 文献库',
        note: '点开「智能视图」的「待读」，看看本案例导入的 6 篇核心文献都躺在哪。',
        text: '文献库',
        href: '/literature?tab=library',
        scope: 'main',
      },
      {
        at: '右上 · 新增文献',
        note: '点「新增文献」感受一下录入表单：标题、作者、集合标签，一两分钟能录完一篇。',
        text: '新增文献',
        scope: 'main',
        href: '/literature?tab=library',
      },
      {
        at: '侧栏 · 对话·调研',
        note: '切到「调研」胶囊，问一句「LLM 单元测试生成有哪些代表方法」，体会先检索再回答和普通聊天有何不同。',
        text: '对话 · 调研',
        href: '/research',
        scope: 'main',
      },
    ],
    tips: [
      '不要一上来就精读：先用「对话·调研」问「LLM 单元测试生成有哪些代表方法和基准」，拿到骨架再按图索骥。',
      '「待核实」字段照实写——作者名、arXiv 编号不确定就标注，绝不猜。审稿人查得出编造的引用。',
      '文献 ID 在教程后面会反复出现（如「REFLEX = 库 ID 4」），是因为笔记、创新点、画布全都引用同一份库记录，改一处全链同步。',
    ],
    deliver: [
      '文献库 6+ 条结构化记录（含集合标签与三行笔记）',
      '一张对比矩阵草稿（方法 × 维度），第 2 阶段选题直接用它找缺口',
    ],
    shots: [
      {
        src: '/tutorial/llmutg/shots/01-literature-annotated.png',
        caption: '文献库实拍：①侧栏入口 ②智能视图分层 ③文献总量与分类 ④新建 / Zotero / BibTeX 导入',
      },
      {
        src: '/tutorial/llmutg/shots/08-research-annotated.png',
        caption: '对话·调研实拍：①侧栏入口 ②调研胶囊（先检索文献再回答） ③研究胶囊（多轮推进） ④输入框直接提问',
      },
    ],
    chapter: 'Related Work',
  },
  {
    no: '02',
    id: 's2',
    title: '选题确定',
    goal: '从文献缺口里定位一个值得做、且能被实验检验的研究问题，而不是泛泛地「提升覆盖率」。好选题有三个特征：有明确的对照对象（谁来做基线）、有可量化的判据（什么结果算赢）、规模可控（一个实验周期能跑完）。',
    where: '左侧导航「创新点」（/ideas）；文献侧先用「对比矩阵」把已读文献摆到方法 × 维度的格子里，空格就是缺口。',
    paper: '对应论文 §3 Motivation and Research Questions（倒排写作顺位 ③）——三条 RQ 一字不改地搬进论文。',
    how: [
      '文献矩阵暴露出：覆盖率提升已被反复研究，而「覆盖率见顶后下一步生成什么」仍靠启发式排序——这就是缺口。',
      '据此把选题收口为：用「动态多源反馈 + 类型化决策」替代静态覆盖排序。',
      '写成三个研究问题：RQ1 反馈图是否优于静态排序？RQ2 Jev 置信带能否保质量降调用？RQ3 节点级定位是否优于行号启发式？',
      '每个 RQ 在创新点页建一条记录，先占住位置，第 3 阶段再补全否证条件。',
      '预判审稿人问题：把「为什么不用 XX」写进想法的 notes，Method 章会用到。',
    ],
    trys: [
      {
        at: '侧栏 · 创新点',
        note: '打开创新点页，找到本案例的三条主张（库 ID 31/32/33），读一读它们的否证条件是怎么写的。',
        sel: 'nav a[href="/ideas"]',
        href: '/ideas',
        scope: 'main',
      },
      {
        at: '顶部 · 捕获新想法',
        note: '点「捕获新想法」，试着用「一句话主张 + 数值判据」的格式写下你自己的研究问题。',
        text: '捕获新想法',
        href: '/ideas',
        scope: 'main',
      },
      {
        at: 'AI 头脑风暴',
        note: '点「AI 头脑风暴」生成几个候选创新点——记住：生成的是候选，入库前要人工把关。',
        text: 'AI 头脑风暴',
        href: '/ideas',
        scope: 'main',
      },
    ],
    tips: [
      '选题一次只收口一个方向。三条 RQ 是同一方法的三张面孔（图 / 决策 / 定位），不是三个独立项目。',
      '对照对象先锁定：本案例的基线是 codamosa / coverup / telpa / Undermind agent 策略，全部出自本地 harness，可复现。',
    ],
    deliver: ['三条 RQ 的初始记录（创新点库 ID 31/32/33）', '基线清单与数据来源'],
    shots: [
      {
        src: '/tutorial/llmutg/shots/02-ideas-annotated.png',
        caption: '创新点页实拍：①侧栏入口 ②标题 + 一句话主张 ③AI 生成候选创新点 ④四维评分后入库',
      },
    ],
    chapter: 'Motivation / RQ',
  },
  {
    no: '03',
    id: 's3',
    title: '创新点总结',
    goal: '把选题落成三条可证伪主张（A/B/C），每条绑定一个能被实验推翻的判据——这是审稿最看重的 claim 可检验性。主张和「愿景」的区别就在于：它写得出「什么结果出现就算我错了」。',
    where: '创新点页（/ideas），每条带 novelty / feasibility / impact / effort 四维评分。',
    paper: '对应论文 §4 Method 的「主张层」（倒排写作顺位 ①——Method 最先写，材料最全）。',
    how: [
      '新建三条想法，标题写主张，一句话主写「必须具体到可验证」。',
      '在 notes 里写明否证条件（什么结果出现就算这个主张错了）——没有否证条件的主张不算主张。',
      '按 impact×novelty 排序取舍，状态置为 selected；被放弃的想法保留记录，写论文的 Discussion 时是现成素材。',
      '每条主张标注它支撑哪个 RQ，保证 RQ ↔ 主张 ↔ 实验三方对齐。',
    ],
    tips: [
      '否证条件要写成数值判据（如「覆盖增益 < 2pp」），不要写「效果不明显」这种没法判定的措辞。',
      'AI 头脑风暴生成的是候选，不是结论：所有自动生成内容都要人工过一遍再入库。',
    ],
    trys: [
      {
        at: '想法卡 · 四维评分',
        note: '找一张想法卡，给它的 novelty / feasibility / impact / effort 各打一分——评分高的排前面，这就是取舍。',
        text: '加入想法池',
        href: '/ideas',
        scope: 'main',
      },
    ],
    deliver: ['三条可证伪主张（A/B/C，库 ID 31/32/33），各带四维评分与否证条件'],
    asset: 'ideas',
    chapter: 'Method（主张）',
  },
  {
    no: '04',
    id: 's4',
    title: '实施实验',
    goal: '把三条主张变成可复现的实验：明确的基准、基线、指标定义。可复现的最低标准是「换一台机器照着命令能跑出同一批数」——所以基准、LLM、温度、种子、超时全部显式固定。',
    where: '左侧导航「实验」（/experiments）：Agent 式会话，自然语言下指令，技能自动挂载；画布（/canvas）可把多步实验编排成流水线；数据分析（/studio/analysis）与代码工作室（/studio/code）用本机 venv Python 直接跑。',
    paper: '对应论文 §5 Experimental Design（倒排写作顺位 ①）——基准 / 基线 / 指标 / 配置四段照抄实验 notes。',
    how: [
      '基准：CodaMosa 486-module 套件 + TestEval 210 项。',
      '基线：codamosa、coverup、telpa、Undermind agent 策略。',
      '指标显式定义：覆盖率 ΔCov、LLM 调用次数 Calls、单模块耗时、定位精度 Loc@k——每个指标写清「用什么工具量的、对哪个集合」。',
      '配置冻结：LLM=DeepSeek、temperature=0.2、单模块 120s 预算、固定种子，写进实验 notes。',
      '本案例用带种子的合成生成器造了 486 模块 × 3 方法的演示数据，让下游管线能真实执行——演示数据会在每个产出上显式标注。',
    ],
    tips: [
      '先跑通最小闭环（1 个模块 × 2 个方法），确认日志格式、指标计算、落盘路径都对，再放大到全集。',
      '原始日志永远不删、不就地改——后处理全部在新目录做，出问题能回溯。',
    ],
    trys: [
      {
        at: '侧栏 · 实验',
        note: '打开实验页，看看本案例的 Agent 会话长什么样：左侧会话列表，右侧指令流。',
        sel: 'nav a[href="/experiments"]',
        href: '/experiments',
        scope: 'main',
      },
      {
        at: '侧栏 · 编排画布',
        note: '点开「本案例的实验流水线画布」，看多步实验怎么被编排成一条流水线（URL 即状态）。',
        text: '编排画布 Canvas',
        href: '/canvas',
        scope: 'main',
      },
    ],
    deliver: ['实验配置说明（进论文 Experimental Design）', '原始日志 + 会话记录', '可复跑的命令清单'],
    shots: [
      {
        src: '/tutorial/llmutg/shots/03-canvas-annotated.png',
        caption: '画布实拍：①侧栏入口 ②新建画布 ③本案例的实验流水线画布',
      },
      {
        src: '/tutorial/llmutg/shots/04-agent-annotated.png',
        caption: '实验页实拍：①侧栏入口 ②实验会话（Agent 实验） ③可复现 / 统计 / 图表技能自动挂载',
      },
    ],
    asset: 'results',
    chapter: 'Experimental Design',
  },
  {
    no: '05',
    id: 's5',
    title: '数据后处理',
    goal: '把原始日志变成可放进论文的图表与统计结论，并显式声明真实/模拟边界。后处理的意义是让「结论」可审计：任何一个数字都能从原始日志一步步算回来。',
    where: '数据分析（/studio/analysis）传 CSV 跑统计；绘图工作室（/studio/figure）出论文图；或用本机 Python 直接算。结论回填论文 §6/§7。',
    paper: '对应论文 §6 Data Post-processing + §7 Results（倒排写作顺位 ①）——清洗/统计/边界声明三段进 §6，表格与图进 §7。',
    how: [
      '清洗：剔除超时/崩溃样本，统一单位；按内容哈希去重测试产物。',
      '统计：中位数 + bootstrap 95% CI（1,000 次重采样）；配对 Wilcoxon（含 ties 平均秩修正）；效应量用 Cliff\'s δ。',
      '可视化：覆盖率（带 CI 误差棒）、LLM 调用、验证率三联图；图注永远带「measured / DEMO」边界标签。',
      'p 值处理：小于 1e-10 不输出 0.00e+00，写 p < 10⁻¹⁰。',
      '结果段自动化：本案例的论文 Results 段不是手写的——脚本从数据算出统计量、生成 LaTeX 表格与正文，再注入 .tex。换数据重跑一遍即可。',
    ],
    tips: [
      'Wilcoxon 要做 ties 平均秩修正，否则 p 值会算错（本案例早期实现就栽在这里：p=0.50 vs 正确的 p<10⁻¹⁰）。',
      '每张图、每张表在生成时就带边界标签，别指望「以后补」——忘了就是事故。',
    ],
    trys: [
      {
        at: '侧栏 · 数据分析',
        note: '上传一个 CSV（哪怕只有两列），点「运行」看 venv Python 真的算出结果——这就是论文数据的来路。',
        sel: 'nav a[href="/studio/analysis"]',
        href: '/studio/analysis',
        scope: 'main',
      },
      {
        at: '侧栏 · 绘图工作室',
        note: '在参考画廊挑一张图点「用作样板」，体会「照着出图」和「从零画图」的差别。',
        sel: 'nav a[href="/studio/figure"]',
        href: '/studio/figure',
        scope: 'main',
      },
    ],
    deliver: ['fig_results.svg（三联图，带 DEMO 标注）', 'results_demo_summary.json（全部统计量）', '自动生成的 LaTeX Results 段'],
    shots: [
      {
        src: '/tutorial/llmutg/shots/05-postprocess-annotated.png',
        caption: '绘图工作室实拍：①侧栏入口 ②挑一张参考图点「用作样板」，回编辑器照着出图',
      },
      {
        src: '/tutorial/llmutg/shots/09-analysis-annotated.png',
        caption: '数据分析实拍：①侧栏入口 ②上传数据集（CSV / XLSX） ③用 venv Python 跑分析脚本',
      },
      {
        src: '/tutorial/llmutg/shots/10-code-annotated.png',
        caption: '代码工作室实拍：①侧栏入口 ②白名单命令执行（shell=False，命令拼装受控）',
      },
    ],
    asset: 'results',
    chapter: 'Data Post-processing',
  },
  {
    no: '06',
    id: 's6',
    title: '论文撰写与编译',
    goal: '把前五阶段资产组装成英文论文，并在工作台的 LaTeX 工作室里编译出 PDF——右侧就是你编译出来的成品。写作的顺序建议倒着来：先 Method 与 Experimental Design（材料最全），再 Results，最后 Intro 与 Abstract（要知道全文说了什么才写得准）。',
    where: '论文页（/paper）跟七阶段流水线，论文工作室（/studio/paper）编辑并编译。',
    paper: '对应论文全文（倒排写作顺位：Method → Exp Design → Results → Discussion → Intro → Abstract 最后写）——右侧 PDF 就是这一步的产出。',
    how: [
      '在「论文」页把七阶段流水线推到位，写作体检的红项就是当前待办；每章有字数与状态。',
      '把 .tex 放进工作区（或直接在编辑器里写）；架构图用 TikZ 内联，结果图引用后处理产出的 SVG/PDF。',
      '右上选引擎（本例 xelatex），点「编译」；命令由后端白名单拼装，不接受自定义命令。',
      '编译成功后右侧「PDF 预览」里直接看，同时可下载 .tex / .pdf。',
      '本案例的 Results 段不是手写的：脚本从数据算出统计量、自动生成 LaTeX 表格与正文，再注入 .tex 编译。',
      '编译循环：改一处 → 编译 → 看 PDF → 再改。整个闭环不出工作台。',
    ],
    tips: [
      'Related Work 直接从文献库三行笔记拼装，别凭记忆写——引用错了最难堪。',
      'Threats to Validity 认真写：基线出处待核实、单次运行无法分离种子方差，这些老实写出来反而加分。',
    ],
    trys: [
      {
        at: '侧栏 · 论文',
        note: '打开论文页看七阶段流水线：红项就是当前阻塞，逐章字数告诉你哪里还欠着。',
        sel: 'nav a[href="/paper"]',
        href: '/paper',
        scope: 'main',
      },
      {
        at: '侧栏 · 论文工作室',
        note: '选 xelatex 引擎点「编译」，亲眼看到 .tex 变成右侧的 8 页 PDF——这一刻起论文是「编译出来的」，不是「写出来的」。',
        sel: 'nav a[href="/studio/paper"]',
        href: '/studio/paper',
        scope: 'main',
      },
    ],
    deliver: ['llmutg_paper.tex（约 250 行，含 TikZ 架构图与结果图）', '8 页编译 PDF（含 DEMO 边界声明）'],
    shots: [
      {
        src: '/tutorial/llmutg/shots/06-paper-pipeline-annotated.png',
        caption: '论文页实拍：①侧栏入口 ②七阶段流水线 ③阻塞自检 ④逐章字数与状态',
      },
      {
        src: '/tutorial/llmutg/shots/07-studio-paper-annotated.png',
        caption: '论文工作室实拍：①侧栏 ②引擎选 xelatex ③工作区 .tex ④编译后 PDF 在此预览',
      },
    ],
    chapter: '全文 + 编译',
  },
  {
    no: '07',
    id: 's7',
    title: '日常推进与复盘',
    goal: '论文不是一口气写完的：研究期以「周计划 + 周复盘」为节拍推进，每天用「今日」页对齐状态，阻塞超 3 天自动红警——这保证实验和写作不会互相拖死。',
    where: '「今日」（/today）看打卡、待办、研究漏斗与活跃热力图；「计划复盘」（节奏组）做周计划与周复盘；组会按双周节奏整理汇报。',
    paper: '对应论文之外的全流程节拍——Discussion/Conclusion 里写「局限与未来工作」的素材，正是复盘里「卡住的原因」。',
    how: [
      '每天早上在「今日」页打卡并过一遍阻塞项：红警条就是今天必须解决的事。',
      '每周固定写周复盘：本周推进 / 卡住的原因 / 下周计划，三段各不超过五行。',
      '把「卡住的原因」落到具体对象上（某个基线跑不通、某段没写），不要写笼统的「进度慢」。',
      '组会前用工作台把本周产物（图、表、PDF）汇成一页，直接可投屏。',
    ],
    tips: [
      '复盘写「为什么卡住」比写「做了什么」更有用：原因是下周的计划。',
      '打卡别造假——热力图和漏斗是给自己看的，造假只会骗过自己。',
    ],
    trys: [
      {
        at: '侧栏 · 今日',
        note: '点开「今日」，完成一次打卡——专注分钟数会进 14 天曲线和 182 天热力图。',
        text: '今日打卡',
        href: '/today',
        scope: 'main',
      },
      {
        at: '侧栏 · 共识',
        note: '在共识页搜一个组内有分歧的学术问题，看看证据是怎么收敛成结论的。',
        text: '共识 Consensus',
        href: '/consensus',
        scope: 'main',
      },
    ],
    deliver: ['周计划 / 周复盘记录', '组会汇报页（图 + 表 + PDF）'],
    shots: [
      {
        src: '/tutorial/llmutg/shots/11-today-annotated.png',
        caption: '今日页实拍：①状态打卡条 ②182 天活跃热力图',
      },
      {
        src: '/tutorial/llmutg/shots/12-consensus-annotated.png',
        caption: '共识页实拍：①共识检索（搜学术问题、收敛组内分歧）',
      },
    ],
    chapter: 'Workflow（全文之外）',
  },
]

/** 新手引导遮罩：高亮真实元素 + 小卡片指引（箭头指向目标） */
function CoachMark({
  try: tr,
  index,
  total,
  onNext,
  onPrev,
  onClose,
  onGo,
}: {
  try: Try
  index: number
  total: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  onGo: (t: Try) => void
}) {
  const [spot, setSpot] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const locate = () => {
    const r = findTargetInView(tr)
    if (r) {
      setSpot({ x: r.x - 6, y: r.y - 6, w: r.width + 12, h: r.height + 12 })
    } else {
      setSpot(null)
    }
  }

  useMemo(() => {
    locate()
    const re = () => locate()
    window.addEventListener('resize', re)
    window.addEventListener('scroll', re, true)
    const t = setTimeout(locate, 300)
    return () => {
      window.removeEventListener('resize', re)
      window.removeEventListener('scroll', re, true)
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tr])

  // 卡片：目标在视口上半部就放下方，下半部就放上方，避免压住被高亮元素
  const cardW = 348
  const cardH = 166
  let cardX = spot ? spot.x + spot.w / 2 - cardW / 2 : window.innerWidth / 2 - cardW / 2
  cardX = Math.max(12, Math.min(window.innerWidth - cardW - 12, cardX))
  const vh = window.innerHeight
  const roomBelow = spot ? vh - (spot.y + spot.h) : 0
  const roomAbove = spot ? spot.y : 0
  const putAbove = spot ? roomBelow < cardH + 16 && roomAbove >= cardH + 16 : false
  const cardY = spot
    ? putAbove
      ? Math.max(12, spot.y - cardH - 14)
      : Math.min(vh - cardH - 12, spot.y + spot.h + 14)
    : vh / 2 - 70

  const spotClip = spot
    ? `polygon(0 0, 100% 0, 100% ${spot.y}px, ${spot.x}px ${spot.y}px, ${spot.x}px ${spot.y + spot.h}px, ${
        spot.x + spot.w
      }px ${spot.y + spot.h}px, ${spot.x + spot.w}px ${spot.y}px, 100% ${spot.y}px, 100% 100%, 0 100%)`
    : undefined

  return (
    <div className="fixed inset-0 z-[90]">
      <div
        className="fixed inset-0"
        style={{ background: 'rgba(12,14,12,0.62)', clipPath: spotClip, transition: 'clip-path .18s ease', pointerEvents: 'auto' }}
        onClick={onClose}
      />
      {spot && (
        <div
          className="pointer-events-none fixed rounded-[10px]"
          style={{
            left: spot.x,
            top: spot.y,
            width: spot.w,
            height: spot.h,
            border: '2px solid var(--wb-accent)',
            boxShadow: '0 0 0 3px rgba(255,255,255,0.85), 0 6px 24px rgba(0,0,0,0.28)',
            transition: 'all .18s ease',
          }}
        />
      )}
      <div
        className="absolute rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-3 shadow-xl"
        style={{ left: cardX, top: cardY, width: cardW, transition: 'all .18s ease' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-[color:var(--wb-accent)] px-1.5 py-0.5 text-[10.5px] font-semibold text-white">
            试一试 {index + 1}/{total}
          </span>
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-[color:var(--wb-text)]">{tr.at}</span>
          <button
            onClick={onClose}
            className="ml-auto flex h-[20px] w-[20px] items-center justify-center rounded-md text-[color:var(--wb-muted)] hover:bg-[color:var(--wb-bg-subtle)]"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">{tr.note}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="shrink-0 whitespace-nowrap text-[11px] text-[color:var(--wb-muted)]">
            {spot ? '↑ 蓝色框住的就在那' : '目标不在当前屏'}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Btn variant="ghost" size="sm" disabled={index <= 0} onClick={onPrev}>
              上一个
            </Btn>
            <Btn size="sm" disabled={index >= total - 1} onClick={onNext}>
              下一个
            </Btn>
          </div>
        </div>
        {tr.href && (
          <button
            onClick={() => onGo(tr)}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[8px] bg-[color:var(--wb-accent)] px-2.5 py-1.5 text-[12px] font-medium text-white"
          >
            <Icon name="arrowRight" size={12} /> 前往实操（目标页会继续带你）
          </button>
        )}
      </div>
    </div>
  )
}

function Shot({ src, caption }: { src: string; caption: string }) {
  return (
    <figure className="mt-4">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--wb-muted)]">
        界面实拍
      </div>
      <img
        src={src}
        alt="工作台界面截图"
        className="w-full rounded-[10px] border border-[color:var(--wb-border)] bg-white"
      />
      <figcaption className="mt-1.5 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{caption}</figcaption>
    </figure>
  )
}

function IdeasAsset() {
  return (
    <div className="space-y-2">
      {IDEAS.map((x) => (
        <div
          key={x.id}
          className="rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-3"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-[color:var(--wb-accent-soft)] px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--wb-accent)]">
              {x.tag} · 库ID {x.id}
            </span>
            <span className="text-[12.5px] font-medium text-[color:var(--wb-text)]">{x.claim}</span>
          </div>
          <div className="mt-1 text-[11.5px] text-[color:var(--wb-muted)]">否证条件：{x.neg}</div>
        </div>
      ))}
    </div>
  )
}

function ResultsAsset() {
  return (
    <div className="space-y-3">
      <img
        src={`${BASE}/fig_results.svg`}
        alt="结果图（演示数据）"
        className="w-full rounded-[10px] border border-[color:var(--wb-border)] bg-white"
      />
      <div className="rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] p-3 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]">
        <b className="text-[color:var(--wb-text)]">演示数据实际算出：</b>
        DMF-Jev 中位覆盖率 <b>75.3%</b> [74.1, 76.2]，对 codamosa（68.6%）<b>+6.7 pp</b>，配对 Wilcoxon{' '}
        <b>p &lt; 10⁻¹⁰</b>，Cliff's δ = <b>0.38</b>；LLM 调用 <b>9.6 → 5.7 次/模块</b>（<b>−41.1%</b>）；定位精度{' '}
        <b>0.786</b>。
        <div className="mt-1.5 text-[11px] text-[color:var(--wb-muted)]">
          合成演示数据（seed 20261112，n=486），非实测。
        </div>
      </div>
    </div>
  )
}

export default function TutorialFrame() {
  const [view, setView] = useState<string>('prologue')
  const active = view === 'prologue' || view === 'epilogue' ? 's1' : view
  const setActive = setView
  const [coach, setCoach] = useState<number | null>(null)
  const nav = useNavigate()

  // 「前往实操」：带指引上下文跳到目标页，由 TutorialGuideHost 接住并浮出引导
  const handleGo = (t: Try) => {
    if (!t.href) return
    const items = (cur.trys || []).filter((x) => x.href === t.href)
    launchTutorialGuide({
      stepTitle: `${cur.no} ${cur.title}`,
      from: '/tutorial/llmutg',
      target: t.href,
      items: (items.length ? items : [t]).map((x) => ({ at: x.at, note: x.note, sel: x.sel, text: x.text, scope: x.scope })),
    })
    nav(t.href)
  }
  const cur = useMemo(() => STEPS.find((s) => s.id === active) || STEPS[0], [active])
  const idx = STEPS.findIndex((s) => s.id === cur.id)

  const jump = (v: string) => {
    setView(v)
    document.querySelector('[data-tut-scroll]')?.scrollTo({ top: 0 })
  }

  return (
    <div className="flex h-full min-h-0 bg-[color:var(--wb-bg)]">
      {/* 左：步骤导航 */}
      <aside className="hidden w-[204px] shrink-0 overflow-y-auto border-r border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-3 md:block">
        <div className="mb-3 px-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--wb-muted)]">
            开发案例教程
          </div>
          <div className="mt-1 text-[12.5px] font-medium leading-snug text-[color:var(--wb-text)]">
            用工作台生成一篇英文论文
          </div>
        </div>
        <button
          onClick={() => jump('prologue')}
          className={`wb-press-soft mb-2 flex w-full items-center gap-1.5 rounded-[8px] border px-2 py-[7px] text-[12px] font-medium transition-colors ${
            view === 'prologue'
              ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
              : 'border-[color:var(--wb-border)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
          }`}
        >
          <Icon name="book" size={12} /> 序章 · 为什么是研流
        </button>
        <nav className="flex flex-col gap-[3px]">
          {STEPS.map((s) => {
            const on = s.id === view
            return (
              <button
                key={s.id}
                onClick={() => jump(s.id)}
                className={`wb-press-soft flex items-start gap-2 rounded-[8px] px-2 py-[7px] text-left transition-colors ${
                  on
                    ? 'bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
                    : 'text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
                }`}
              >
                <span className="mt-[1px] shrink-0 text-[10.5px] font-semibold tabular-nums opacity-70">{s.no}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium">{s.title}</span>
                  <span className="block truncate text-[10.5px] opacity-70">{s.chapter}</span>
                </span>
              </button>
            )
          })}
        </nav>
        <button
          onClick={() => jump('epilogue')}
          className={`wb-press-soft mt-3 flex w-full items-center gap-1.5 rounded-[8px] border px-2 py-[7px] text-[12px] font-medium transition-colors ${
            view === 'epilogue'
              ? 'border-[color:var(--wb-accent)] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]'
              : 'border-[color:var(--wb-border)] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]'
          }`}
        >
          <Icon name="checkSquare" size={12} /> 成品 · 八页论文
        </button>
        <div className="mt-4 border-t border-[color:var(--wb-border)] pt-3">
          <a
            href={`${BASE}/llmutg_paper.pdf`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-[12px] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]"
          >
            <Icon name="download" size={13} /> 下载论文 PDF
          </a>
          <a
            href={`${BASE}/llmutg_paper.tex`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-[12px] text-[color:var(--wb-text-soft)] hover:bg-[color:var(--wb-bg-subtle)]"
          >
            <Icon name="file" size={13} /> LaTeX 源码
          </a>
        </div>
      </aside>

      {/* 右：内容 + PDF（≥xl 时左右分栏） */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        {view === 'prologue' || view === 'epilogue' ? (
          <div data-tut-scroll className="col-span-full min-h-0 overflow-y-auto">
            {view === 'prologue' ? (
              <TutorialPrologue onStart={() => jump(STEPS[0].id)} />
            ) : (
              <TutorialEpilogue
                pdfHref={`${BASE}/llmutg_paper.pdf`}
                texHref={`${BASE}/llmutg_paper.tex`}
                onReview={() => jump(STEPS[0].id)}
                onRestart={() => jump('prologue')}
              />
            )}
          </div>
        ) : (
        <div data-tut-scroll className="min-h-0 overflow-y-auto px-5 py-5 md:px-7">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-[color:var(--wb-accent)] px-1.5 py-0.5 text-[11px] font-semibold text-white">
              阶段 {cur.no}
            </span>
            <h2 className="text-[17px] font-semibold text-[color:var(--wb-text)]">{cur.title}</h2>
            <span className="text-[11.5px] text-[color:var(--wb-muted)]">→ 论文 {cur.chapter}</span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--wb-text-soft)]">{cur.goal}</p>

          {cur.paper && (
            <p className="mt-2.5 flex items-start gap-1.5 rounded-[10px] border border-[color:var(--wb-accent-soft)] bg-[color:var(--wb-accent-soft)] px-3 py-2 text-[12px] leading-relaxed text-[color:var(--wb-accent)]">
              <Icon name="quill" size={13} className="mt-[2px] shrink-0" />
              <span>
                <b>论文对应：</b>
                {cur.paper}
              </span>
            </p>
          )}

          <section className="mt-4">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-accent)]">
              <Icon name="compass" size={13} /> 在工作台里去哪做
            </h3>
            <p className="rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3 py-2.5 text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
              {cur.where}
            </p>
          </section>

          <section className="mt-4">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-accent)]">
              <Icon name="checkSquare" size={13} /> 怎么做
            </h3>
            <ol className="space-y-1.5">
              {cur.how.map((h, i) => (
                <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-[color:var(--wb-text-soft)]">
                  <span className="mt-[2px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full bg-[color:var(--wb-bg-subtle)] text-[10px] font-semibold text-[color:var(--wb-muted)]">
                    {i + 1}
                  </span>
                  <span>{h}</span>
                </li>
              ))}
            </ol>
          </section>

          {cur.trys && cur.trys.length > 0 && (
            <section className="mt-4">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-accent)]">
                <Icon name="play" size={13} /> 试一试（点卡片，界面会指给你看）
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                {cur.trys.map((t, i) => (
                  <button
                    key={i}
                    onClick={() => setCoach(i)}
                    className="wb-press-soft group flex items-start gap-2 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-2.5 text-left transition-colors hover:border-[color:var(--wb-accent)]"
                  >
                    <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[color:var(--wb-accent-soft)] text-[10px] font-bold text-[color:var(--wb-accent)]">
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium text-[color:var(--wb-text)]">{t.at}</span>
                      <span className="mt-0.5 block line-clamp-2 text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">
                        {t.note}
                      </span>
                    </span>
                    <span className="ml-auto mt-1 shrink-0 text-[color:var(--wb-accent)] opacity-0 transition-opacity group-hover:opacity-100">
                      <Icon name="target" size={14} />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {cur.tips && cur.tips.length > 0 && (
            <section className="mt-4">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-accent)]">
                <Icon name="bolt" size={13} /> 经验与坑
              </h3>
              <ul className="space-y-1.5">
                {cur.tips.map((t, i) => (
                  <li
                    key={i}
                    className="flex gap-2 rounded-[8px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] px-2.5 py-2 text-[12px] leading-relaxed text-[color:var(--wb-text-soft)]"
                  >
                    <span className="text-[color:var(--wb-accent)]">·</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {cur.deliver && cur.deliver.length > 0 && (
            <section className="mt-4">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-accent)]">
                <Icon name="inbox" size={13} /> 本阶段产出
              </h3>
              <ul className="flex flex-wrap gap-1.5">
                {cur.deliver.map((d, i) => (
                  <li
                    key={i}
                    className="rounded-full border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-2.5 py-1 text-[11.5px] text-[color:var(--wb-text-soft)]"
                  >
                    {d}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {cur.id === 's1' && (
            <section className="mt-4">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-accent)]">
                <Icon name="book" size={13} /> 本案例录入的文献（库内 ID）
              </h3>
              <div className="overflow-hidden rounded-[10px] border border-[color:var(--wb-border)]">
                <table className="w-full text-[12px]">
                  <thead className="bg-[color:var(--wb-bg-subtle)] text-[color:var(--wb-muted)]">
                    <tr>
                      <th className="px-2.5 py-1.5 text-left font-medium">ID</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">论文</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">角色</th>
                    </tr>
                  </thead>
                  <tbody>
                    {LIT.map((r) => (
                      <tr key={r.id} className="border-t border-[color:var(--wb-border)]">
                        <td className="px-2.5 py-1.5 font-mono text-[color:var(--wb-accent)]">{r.id}</td>
                        <td className="px-2.5 py-1.5 text-[color:var(--wb-text)]">{r.name}</td>
                        <td className="px-2.5 py-1.5 text-[color:var(--wb-muted)]">{r.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {cur.asset === 'ideas' && (
            <section className="mt-4">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-accent)]">
                <Icon name="database" size={13} /> 已入库的三条可证伪主张
              </h3>
              <IdeasAsset />
            </section>
          )}

          {cur.asset === 'results' && (
            <section className="mt-4">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--wb-accent)]">
                <Icon name="chart" size={13} /> 后处理产物
              </h3>
              <ResultsAsset />
            </section>
          )}

          {(cur.shots || []).map((s, i) => (
            <Shot key={i} src={s.src} caption={s.caption} />
          ))}

          <div className="mt-5 flex items-center justify-between border-t border-[color:var(--wb-border)] pt-3">
            <Btn variant="ghost" size="sm" disabled={idx <= 0} onClick={() => idx > 0 && jump(STEPS[idx - 1].id)}>
              <Icon name="chevronLeft" size={13} /> 上一步
            </Btn>
            {idx >= STEPS.length - 1 ? (
              <Btn size="sm" onClick={() => jump('epilogue')}>
                看成片 <Icon name="arrowRight" size={13} />
              </Btn>
            ) : (
              <Btn size="sm" onClick={() => jump(STEPS[idx + 1].id)}>
                下一步 <Icon name="chevronRight" size={13} />
              </Btn>
            )}
          </div>
        </div>
        )}

        {/* 右侧：内嵌 PDF（只在步骤视图出现） */}
        <div className={`min-h-0 flex-col border-l border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] ${
          view === 'prologue' || view === 'epilogue' ? 'hidden' : 'hidden xl:flex'
        }`}>
          <div className="flex shrink-0 items-center justify-between border-b border-[color:var(--wb-border)] px-3 py-2">
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--wb-text)]">
              <Icon name="file" size={13} /> 生成的英文论文
            </span>
            <a
              href={`${BASE}/llmutg_paper.pdf`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[11.5px] text-[color:var(--wb-accent)] hover:underline"
            >
              <Icon name="maximize" size={12} /> 新窗口
            </a>
          </div>
          <div className="min-h-0 flex-1">
            <PdfViewer src={`${BASE}/llmutg_paper.pdf`} />
          </div>
        </div>
      </div>

      {coach !== null && cur.trys && (
        <CoachMark
          try={cur.trys[coach]}
          index={coach}
          total={cur.trys.length}
          onNext={() => setCoach((c) => (cur.trys && c !== null && c < cur.trys.length - 1 ? c + 1 : c))}
          onPrev={() => setCoach((c) => (c !== null && c > 0 ? c - 1 : c))}
          onClose={() => setCoach(null)}
          onGo={handleGo}
        />
      )}
    </div>
  )
}
