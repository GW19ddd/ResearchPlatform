import { describe, it, expect } from 'vitest'
import { composeKickoff, EMPTY_QUEST } from './chatKickoff'

describe('composeKickoff · Quest 契约', () => {
  it('EMPTY_QUEST 全字段为空串', () => {
    expect(EMPTY_QUEST).toEqual({
      title: '',
      request: '',
      baseline: '',
      papers: '',
      goals: '',
      constraints: '',
    })
  })

  it('request 必填进【研究目标】，空时其余块走 fallback', () => {
    const out = composeKickoff(EMPTY_QUEST)
    expect(out).toContain('【研究目标】\n')
    expect(out).toContain('（无，请先自行调研并给出可复现的起点）') // baseline fallback
    expect(out).toContain('（无）') // papers fallback
    expect(out).toContain('（未定，请在研究计划里先给出可验证的判据）') // goals fallback
    expect(out).toContain('（无）') // constraints fallback
  })

  it('填了值就优先用值，不出现 fallback', () => {
    const out = composeKickoff({
      ...EMPTY_QUEST,
      request: '做 X',
      baseline: '已有 B',
      papers: 'P1',
      goals: 'G1',
      constraints: 'C1',
    })
    expect(out).toContain('【研究目标】\n做 X')
    expect(out).toContain('【已有基础与 Baseline】\n已有 B')
    expect(out).toContain('【参考文献】\nP1')
    expect(out).toContain('【成功标准】\nG1')
    expect(out).toContain('【硬约束】\nC1')
    expect(out).not.toContain('（无，请先自行调研')
  })

  it('始终带 DeepScientist 方法纪律段', () => {
    expect(composeKickoff(EMPTY_QUEST)).toContain('【研究方法纪律 · DeepScientist】')
  })
})
