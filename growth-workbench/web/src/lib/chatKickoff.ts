/**
 * Quest 课题契约 → kickoff prompt 的纯函数（从 Chat.tsx 抽出，便于单测）。
 * 对齐 DeepScientist 的 Start Research：目标 / Baseline / 参考 / 成功标准 / 硬约束 + 方法纪律。
 */
export type Quest = {
  title: string
  request: string
  baseline: string
  papers: string
  goals: string
  constraints: string
}

export const EMPTY_QUEST: Quest = {
  title: '',
  request: '',
  baseline: '',
  papers: '',
  goals: '',
  constraints: '',
}

export const composeKickoff = (q: Quest): string => {
  const block = (label: string, v: string, fallback: string) =>
    `【${label}】\n${v.trim() || fallback}`
  return [
    `【研究目标】\n${q.request.trim()}`,
    block('已有基础与 Baseline', q.baseline, '（无，请先自行调研并给出可复现的起点）'),
    block('参考文献', q.papers, '（无）'),
    block('成功标准', q.goals, '（未定，请在研究计划里先给出可验证的判据）'),
    block('硬约束', q.constraints, '（无）'),
    [
      '【研究方法纪律 · DeepScientist】',
      '1. 三层契约：课题根计划（全局研究地图）→ 阶段契约（本阶段目标/交付物/判据）→ 执行清单（一次只推进一项）。每轮先对齐再动手。',
      '2. 阶段门禁：调研→计划、计划→实验 之间需我（用户）明确确认方向后才可越过；门禁前只做当前阶段准备，不得擅自跳阶段执行。',
      '3. 证据优先：成文阶段每个主张必须能追溯到一条调研/实验产物；无证据的断言标注「待验证」。',
      '4. 发现记忆：对话中沉淀为「发现」的结论，之后每轮自动带上，不得遗忘或重复质疑。',
      '5. 受控自治：阶段内可连续推进，但遇门禁、证据不足或需我提供数据时主动停下并列出所需输入，不编造。',
      '',
      '推进节奏：先输出分阶段研究计划（每阶段有可验证产出），等我确认后再逐步执行；每个阶段结束给「阶段小结：做了什么 / 结论 / 下一步」；执行中要改动上述任何边界，先说明再动手。',
    ].join('\n'),
  ].join('\n\n')
}
