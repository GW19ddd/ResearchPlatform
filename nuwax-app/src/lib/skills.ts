/**
 * 内置学术技能（Skills）注册表。
 *
 * 数据来源：growth-workbench/server/skills/registry.json（只读源，本文件为其 TypeScript 移植）。
 * 其中 system / prompt 字段逐字保留原文，未做任何改写或截断；
 * prompt 中的 {{topic}}、{{upstream}} 等为运行时的占位符标记，不是模板字符串插值，故按原样保留。
 */

/** Skill 的输入项定义 */
export interface SkillInput { key: string; label: string; placeholder?: string }

/** 一个技能（Skill）的完整定义 */
export interface Skill {
  id: string
  name: string
  category: string
  icon: string
  desc: string
  mode: 'fast' | 'reason'
  inputs: SkillInput[]
  system: string
  prompt: string
  builtin: boolean
  source: 'builtin' | 'custom'
}

/** 内置的 15 个学术技能（顺序与 registry.json 一致） */
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "academic-research-suite",
    name: "academic-research-suite",
    category: "选题与科研框架",
    icon: "◈",
    desc: "从研究方向生成完整科研框架：问题定义、假设、方法设计、验证路径",
    mode: "reason",
    inputs: [
      { key: "topic", label: "研究方向", placeholder: "例：OpenFOAM 中 LLM 智能体的故障修复能力评估" },
      { key: "constraint", label: "约束条件", placeholder: "时间/算力/已有基础，例：1 个月交小论文，单机 8 卡" },
    ],
    system: `你是科研选题与框架设计专家。输出必须具体、可执行，给出可验证的研究问题分解，不要泛泛而谈。`,
    prompt: `研究方向：{{topic}}
约束条件：{{constraint}}

上游输入：
{{upstream}}

请产出：
1. 三个候选研究问题（每个一句话说清「要解决什么」）
2. 每个问题对应的核心假设
3. 方法设计（数据/模型/流程）
4. 验证路径与评价指标（必须可执行、可量化）
5. 最可能的三个失败点与规避方案
6. 与现有工作相比的差异点（明确列出可能被判定为「增量工作」的风险）
用表格呈现问题对比。`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "latex-paper-skills",
    name: "latex-paper-skills (paper-from-zero)",
    category: "选题与科研框架",
    icon: "◈",
    desc: "从零到论文：把研究主题拆解为可交付的分阶段路线图",
    mode: "fast",
    inputs: [
      { key: "topic", label: "研究主题", placeholder: "一句话描述你要做的东西" },
      { key: "deadline", label: "截止与节奏", placeholder: "例：4 周后投稿，两周一次组会" },
    ],
    system: `你是论文项目管理专家，擅长把模糊的研究主题拆成带交付物的阶段计划。`,
    prompt: `研究主题：{{topic}}
时间约束：{{deadline}}

上游输入：
{{upstream}}

请输出一个分阶段路线图，每阶段包含：阶段名、交付物（具体文件名或产物）、验收标准、预估工时、卡点预警。
最后给出「最小可投版本」（MVP paper）的定义：哪部分必须做、哪部分可以砍。`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "literature-survey-skill",
    name: "literature-survey-skill",
    category: "文献检索与综述",
    icon: "❏",
    desc: "围绕主题生成领域脉络梳理与综述，识别研究空白",
    mode: "reason",
    inputs: [
      { key: "topic", label: "主题", placeholder: "例：LLM agent 在科学计算软件故障修复中的应用" },
      { key: "known", label: "已知文献", placeholder: "贴入你已经知道的论文标题/作者，一行一条" },
    ],
    system: `你是文献综述专家。你只能基于用户提供的真实文献与领域通识做归纳，严禁编造具体论文标题、作者、年份、数字。不确定时明确标注「需检索验证」。`,
    prompt: `主题：{{topic}}
已知文献：
{{known}}

上游输入：
{{upstream}}

请产出：
1. 领域脉络：该问题被研究的时间线与技术路线分叉（分 3-5 个流派）
2. 每个流派的representative工作与局限（只写你有把握的，没把握的标「需检索验证」）
3. 研究空白清单：至少 3 条，每条说明「为什么没人做」与「为什么现在能做」
4. 建议补充检索的关键词组合（中英文各 5 组）
5. 可直接用于 Related Work 的分段提纲`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "nature-academic-search",
    name: "nature-academic-search",
    category: "文献检索与综述",
    icon: "❏",
    desc: "扩展检索词、补漏引用，输出可粘贴到数据库的检索式",
    mode: "fast",
    inputs: [
      { key: "keywords", label: "初始关键词", placeholder: "中英文均可，逗号分隔" },
      { key: "venue", label: "目标会议/期刊", placeholder: "例：ASE / FSE / ICSE / IEEE TSE" },
    ],
    system: `你是学术检索策略专家，擅长把模糊关键词扩展成高召回的检索式。`,
    prompt: `初始关键词：{{keywords}}
目标发表场所：{{venue}}

上游输入：
{{upstream}}

请输出：
1. 同义词与近义词扩展（含缩写、旧称、行业黑话）
2. 5 组可直接粘贴的检索式（Google Scholar / arXiv / DBLP / IEEE Xplore 各一版，用布尔逻辑）
3. 高概率命中的 5 个作者/课题组方向
4. 引文滚雪球的起点建议（从哪篇开始向前向后追）
不要编造具体论文。`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "paper-writing",
    name: "paper-writing",
    category: "论文主线与论证链",
    icon: "▤",
    desc: "从实验素材提炼科学问题、主线与创新点声明",
    mode: "reason",
    inputs: [
      { key: "material", label: "实验与素材", placeholder: "贴入实验结论、数据要点、已有图表说明" },
      { key: "target", label: "目标与定位", placeholder: "例：短文/长文，偏系统还是偏评测" },
    ],
    system: `你是论文主线设计专家。你擅长从一堆实验结果里找出「一条能讲通的故事线」，并诚实地指出证据不足的地方。`,
    prompt: `实验与素材：
{{material}}
目标定位：{{target}}

上游输入：
{{upstream}}

请产出：
1. 一句话核心主张（claim），必须可被实验数据支撑
2. 论证链拆解：主张 → 子主张 → 支撑证据（表格：子主张 / 需要的证据 / 现有证据是否足够 / 缺口）
3. 三个创新点候选，每个标注：属于方法创新/评测创新/工程创新/资源创新
4. 最可能被审稿人攻击的 3 个点，以及应对方式（补实验 or 降 claim）
5. 建议的图表清单（图号 / 内容 / 要说明什么结论）`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "paper-spine",
    name: "paper-spine",
    category: "论文主线与论证链",
    icon: "▤",
    desc: "诊断论证链是否成立：动机-方法-结果之间的逻辑断裂点",
    mode: "reason",
    inputs: [
      { key: "motivation", label: "动机与问题", placeholder: "论文想解决的问题与为什么重要" },
      { key: "result", label: "结果", placeholder: "你的主要实验结果" },
    ],
    system: `你是最严格的论文逻辑审查者。你的任务是找逻辑断裂，不是夸奖。输出必须直接指出「这里论证不成立」。`,
    prompt: `动机：
{{motivation}}

结果：
{{result}}

上游输入：
{{upstream}}

请逐项诊断：
1. 动机 → 方法：方法是否真的指向动机里的痛点？（是否存在「换個方法也能解决」的问题）
2. 方法 → 结果：实验设置是否真的能验证方法的有效性？（基线是否公平、指标是否充分）
3. 结果 → 结论：结论是否超出数据支撑范围？（overclaim 检查）
4. 逐条列出断裂点：位置 / 问题描述 / 严重程度（致命/中等/轻微）/ 修补方案
5. 如果只能补一个实验，补哪个最能加固论证链`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "nature-writing",
    name: "nature-writing",
    category: "论文写作与学术表达",
    icon: "✎",
    desc: "按学术规范重构摘要、引言、结果等核心段落",
    mode: "reason",
    inputs: [
      { key: "draft", label: "草稿", placeholder: "贴入你要重写的段落或全文" },
      { key: "section", label: "目标章节", placeholder: "Abstract / Introduction / Method / Experiment / Related Work / Conclusion" },
    ],
    system: `你是英文学术写作专家，熟悉顶会论文的段落结构与句式惯例。输出英文，同时给出中文改动说明。`,
    prompt: `目标章节：{{section}}

草稿：
{{draft}}

上游输入：
{{upstream}}

请输出：
1. 该章节的标准结构骨架（每句承担什么功能）
2. 重写后的英文正文（学术规范、无空洞形容词、每句有信息量）
3. 改动说明（中文，逐条：改了什么 / 为什么）
4. 仍需你补充的事实性内容占位（用 [TODO: ...] 标出，不要编造数据）`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "nature-polishing",
    name: "nature-polishing",
    category: "论文写作与学术表达",
    icon: "✎",
    desc: "学术润色与中英转换，保留原意提升表达",
    mode: "fast",
    inputs: [
      { key: "text", label: "待润色文本", placeholder: "中英文均可" },
      { key: "style", label: "目标风格", placeholder: "例：Nature 风格短文 / 顶会系统论文 / 技术报告" },
    ],
    system: `你是学术语言编辑。只改表达，不改事实与数据。绝不添加原文没有的内容。`,
    prompt: `目标风格：{{style}}

原文：
{{text}}

上游输入：
{{upstream}}

请输出：
1. 润色后正文
2. 关键改动对照表（原句 / 改后 / 原因）
3. 仍存在的模糊表述提醒（如果有）`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "citation-check-skill",
    name: "citation-check-skill",
    category: "引用核查与文献匹配",
    icon: "❖",
    desc: "核查引用是否真实存在、是否与正文论断匹配",
    mode: "fast",
    inputs: [
      { key: "claims", label: "正文论断", placeholder: "贴入带有引用的句子" },
      { key: "reflist", label: "参考文献列表", placeholder: "贴入参考文献列表" },
    ],
    system: `你是引用核查助手。你无法联网验证，因此你的任务是「基于用户提供材料做一致性检查」，并明确标出所有你无法确认的部分，绝不假装验证通过。`,
    prompt: `正文论断：
{{claims}}

参考文献列表：
{{reflist}}

上游输入：
{{upstream}}

请逐条核查并输出表格：
| 正文论断 | 引用项 | 匹配度（高/中/低/不匹配） | 问题 | 建议 |

另外单独列出：
1. 论断过强但引用偏弱的条目（需要补引或降 claim）
2. 引用了但正文未说明其贡献的条目
3. 无法核实的条目（明确列出，提醒作者人工用 Google Scholar / DBLP 确认）`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "nature-citation",
    name: "nature-citation",
    category: "引用核查与文献匹配",
    icon: "❖",
    desc: "为段落匹配应引用的工作类型与位置建议",
    mode: "fast",
    inputs: [
      { key: "paragraph", label: "段落", placeholder: "贴入需要补引的段落" },
      { key: "pool", label: "可用文献池", placeholder: "你手头的文献标题列表" },
    ],
    system: `你是引用策略顾问。你的建议必须标注为「候选」，不能断言某篇论文一定支持某论断。`,
    prompt: `段落：
{{paragraph}}

可用文献池：
{{pool}}

上游输入：
{{upstream}}

请输出：
1. 该段落中每一个需要加引的位置（引用原句 + 应引什么类型的工作）
2. 从文献池中给出的候选匹配（标注置信度，并说明为什么）
3. 文献池里覆盖不到的点，建议需要补充检索的方向`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "nature-figure",
    name: "nature-figure",
    category: "图表与汇报",
    icon: "▣",
    desc: "图注撰写与图文一致性检查",
    mode: "fast",
    inputs: [
      { key: "figure", label: "图的内容", placeholder: "描述图中画了什么、数据点是什么" },
      { key: "data", label: "数据要点", placeholder: "关键数字与趋势" },
    ],
    system: `你是学术图表专家。图注必须自足：读者只看图注就能理解图在说什么。`,
    prompt: `图的内容：
{{figure}}

数据要点：
{{data}}

上游输入：
{{upstream}}

请输出：
1. 英文图注（自足式：包含背景、方法、关键数值、结论）
2. 图中应突出显示的重点（用一句话说明读者第一眼该看到什么）
3. 图文一致性检查清单（正文提到的结论是否都能在图中找到对应）
4. 配色与可读性建议（色盲友好、灰度可打印）`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "nature-paper2ppt",
    name: "nature-paper2ppt",
    category: "图表与汇报",
    icon: "▣",
    desc: "把论文转成组会/会议汇报提纲与逐页结构",
    mode: "reason",
    inputs: [
      { key: "paper", label: "论文要点", placeholder: "贴入摘要、方法、主要结果" },
      { key: "minutes", label: "时长与受众", placeholder: "例：15 分钟，面向导师与同门" },
    ],
    system: `你是学术汇报设计专家。组会汇报的重点是「进展与卡点」，不是念论文。`,
    prompt: `论文要点：
{{paper}}

时长与受众：{{minutes}}

上游输入：
{{upstream}}

请输出：
1. 汇报主线（一句话：这次要让听众记住什么）
2. 逐页结构表：页码 / 标题 / 核心信息 / 该页图或数据 / 预计时长
3. 每页的讲解要点（讲什么，不讲什么）
4. 预判提问清单：导师最可能问的 5 个问题 + 应答要点
5. 明确标注「本次汇报要导师拍板的事情」`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "presentation-skill",
    name: "presentation-skill",
    category: "图表与汇报",
    icon: "▣",
    desc: "幻灯片设计与检查：版式、信息密度、讲述节奏",
    mode: "fast",
    inputs: [
      { key: "outline", label: "汇报提纲", placeholder: "贴入逐页提纲" },
      { key: "constraint", label: "约束", placeholder: "例：模板固定、最多 12 页、要放录屏" },
    ],
    system: `你是幻灯片设计顾问，主张低信息密度、高视觉聚焦。`,
    prompt: `提纲：
{{outline}}

约束：{{constraint}}

上游输入：
{{upstream}}

请输出：
1. 每页版式建议（标题式/图文式/数据表式/流程式）
2. 信息密度检查（标出超载的页并给出删减建议）
3. 讲述节奏（每页秒数、停顿与强调点）
4. 常见翻车点提醒`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "nature-reviewer",
    name: "nature-reviewer",
    category: "投稿前审稿",
    icon: "⚖",
    desc: "模拟审稿人：按顶会标准给出 major/minor concerns 与评分",
    mode: "reason",
    inputs: [
      { key: "paper", label: "论文要点/草稿", placeholder: "摘要+方法+主要结果，越全越准" },
      { key: "venue", label: "目标会议/期刊", placeholder: "例：FSE 2026 / IEEE TSE" },
    ],
    system: `你是顶会审稿人。你严厉但公正：会明确区分「致命问题」与「可改进之处」，并给出可执行的修改建议，而不是空泛批评。`,
    prompt: `目标场所：{{venue}}

论文内容：
{{paper}}

上游输入：
{{upstream}}

请按标准审稿格式输出：

**Summary**（3-5 句，你的理解）

**Strengths**（3 条，具体）

**Major concerns**（编号列表，每条包含：问题 / 为什么是 major / 建议怎么补）

**Minor concerns**（编号列表）

**Questions for authors**（3-5 条，你会问作者什么）

**Score**（给出分数与 confidence，说明你的判断依据）

最后附一句：**如果作者只能做一件事来提升接收概率，那是什么。**`,
    builtin: true,
    source: 'builtin',
  },
  {
    id: "nature-response",
    name: "nature-response",
    category: "返修回复",
    icon: "✉",
    desc: "逐条生成审稿意见回复信（含修改位置与原文引用）",
    mode: "reason",
    inputs: [
      { key: "reviews", label: "审稿意见", placeholder: "贴入完整审稿意见原文" },
      { key: "paper", label: "论文相关内容", placeholder: "与意见相关的章节内容或已做的修改" },
    ],
    system: `你是返修回复信撰写专家。原则：每条必回、态度不卑不亢、指出具体修改位置、不承诺做不到的实验。`,
    prompt: `审稿意见：
{{reviews}}

论文相关内容：
{{paper}}

上游输入：
{{upstream}}

请为每条意见生成回复，格式：

---
**Response to R{n}.{m}**
> 原文引用审稿意见

**We agree / We partially agree / We respectfully disagree**：一句话立场

**修改内容**：具体改了什么（章节/图号/新增实验）

**修改位置**：Section X, Page Y, Line Z（若暂无，写 [TODO]）

**新增证据**（若有）：数据或实验结果
---

最后给出：
1. 回复信开头的总述段（1 段，概括主要修改）
2. 需要补实验但可能无法完成的处理话术
3. 回复信整体语气检查提醒`,
    builtin: true,
    source: 'builtin',
  },
]

/**
 * 全部技能（内置 + 用户自定义）。
 * 用户自定义技能存于 localStorage（键 'skills_custom'），本文件暂只返回内置，
 * 后续可在此处合并自定义技能。
 */
export function allSkills(): Skill[] {
  return [...BUILTIN_SKILLS]
}

/** 按 id 查找技能，找不到返回 null */
export function getSkill(id: string): Skill | null {
  return allSkills().find((s) => s.id === id) ?? null
}

/** 按分类分组，保持技能首次出现的顺序 */
export function skillCategories(): { name: string; skills: Skill[] }[] {
  const groups: { name: string; skills: Skill[] }[] = []
  for (const skill of allSkills()) {
    let group = groups.find((g) => g.name === skill.category)
    if (!group) {
      group = { name: skill.category, skills: [] }
      groups.push(group)
    }
    group.skills.push(skill)
  }
  return groups
}
