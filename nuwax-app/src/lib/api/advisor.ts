/**
 * 导师沟通档案 / 待办承诺 / AI 话术 —— 原 advisor.py 的浏览器端实现。
 *
 * 核心价值是「别让对导师的承诺烂尾」：pending 接口把逾期项顶到最前并打 overdue 标记，
 * 首页据此弹红条。AI 话术只负责组织语言，事实仍由用户填写的四个字段提供。
 */
import { route, pick, badRequest } from './core'
import db, { today } from '../db'
import type { Row } from '../db'
import { completeResult } from '../llm'
import { award, earn } from './points'

/**
 * 话术场景常量。前端下拉框直接复用，避免文案漂移。
 */
export const SCENES = ['周报', '求助', '要资源', '推进度', '请假或缓期']

// 与 plan.ts 共用同一套积分引擎入口：承诺管理当前不写积分流水，
// 但保留这层统一导入，方便后续在「按期履约」等场景加分时不再新增跨模块依赖。
export { award, earn }

route('GET', '/advisor/notes', () =>
  db.all('advisor_notes').sort((a, b) => Number(b.id) - Number(a.id)),
)

route('POST', '/advisor/notes', (ctx) => {
  const body: any = ctx.body
  return db.insert('advisor_notes', {
    date: pick(body, 'date', today()),
    scene: pick(body, 'scene', '组会'),
    advisor_said: pick(body, 'advisor_said', ''),
    my_commitment: pick(body, 'my_commitment', ''),
    due_date: pick(body, 'due_date', ''),
    status: pick(body, 'status', 'open'),
  })
})

route('PATCH', '/advisor/notes/:id', (ctx) => {
  const body: any = ctx.body
  // 白名单：只认这六个字段。前端「标记完成」只传 status，也走这里。
  const patch: Row = {}
  for (const k of ['date', 'scene', 'advisor_said', 'my_commitment', 'due_date', 'status']) {
    if (body && typeof body === 'object' && body[k] !== undefined) patch[k] = body[k]
  }
  if (Object.keys(patch).length === 0) badRequest('no valid field')

  // 记录不存在时保持幂等：不报错，也不产生副作用
  db.update('advisor_notes', Number(ctx.params.id), patch)
  return { ok: true }
})

route('DELETE', '/advisor/notes/:id', (ctx) => {
  db.remove('advisor_notes', Number(ctx.params.id))
  return { ok: true }
})

route('GET', '/advisor/pending', () => {
  const t = today()
  const rows: Row[] = db.find('advisor_notes', (n) => n.status === 'open').map((n): Row => ({
    ...n,
    // 只按「日期 < 今天」算逾期：当天到期不算逾期，避免用户当天就被红条催
    overdue: !!n.due_date && String(n.due_date) < t,
  }))

  // 逾期优先；同组内按截止日升序，无截止日的排最后（'9999' 兜底）
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
    const da = a.due_date || '9999'
    const dbb = b.due_date || '9999'
    return da < dbb ? -1 : da > dbb ? 1 : 0
  })
  return rows
})

route('POST', '/advisor/draft', async (ctx) => {
  const body: any = ctx.body
  const scene = String(pick(body, 'scene', '周报') ?? '周报')

  const lines: string[] = []
  lines.push('你是博士生与导师沟通的参谋。请根据以下材料，生成三段可直接使用的中文话术。')
  lines.push('')
  lines.push(`沟通场景：${scene}`)
  lines.push(`本周实际进展：${pick(body, 'progress', '') || '（未填写）'}`)
  lines.push(`遇到的卡点：${pick(body, 'blockers', '') || '（未填写）'}`)
  lines.push(`想提出的请求：${pick(body, 'ask', '') || '（未填写）'}`)
  lines.push(`我打算作出的承诺：${pick(body, 'commitments', '') || '（未填写）'}`)
  lines.push('')
  lines.push('输出要求：用 Markdown，严格包含以下三个二级标题，每个标题下给出完整可复制的话术：')
  lines.push('## 【简洁版】')
  lines.push('面谈/走廊即用，不超过 3 句，先给结论再给请求。')
  lines.push('## 【详细版】')
  lines.push('组会汇报用，结构清晰，把进展、卡点、下一步与请求都说清楚。')
  lines.push('## 【低姿态版】')
  lines.push('进展不理想或要资源/请假时用，主动担责、给出补救方案与时间点。')
  lines.push('')
  lines.push('话术要真实、口语化、不谄媚也不甩锅；没有依据的数字不要编造。')

  const env = await completeResult(lines.join('\n'), {
    mode: 'fast',
    task: 'advisor-draft',
    maxTokens: 2048,
  })

  // 失败时返回空 result 与 error 信封，前端 AiError 组件据此渲染可操作提示
  if (!env.ok) return { ok: false, result: '', scenes: SCENES, error: env.error }

  return {
    ok: true,
    result: env.content,
    scenes: SCENES,
    error: null,
    provider: env.provider,
    model: env.model,
    tokens_in: env.tokens_in,
    tokens_out: env.tokens_out,
  }
})
