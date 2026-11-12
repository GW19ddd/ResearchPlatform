/**
 * 概览汇总区块（原「概览指标」页内容，2026-11-12 并入「今日」页）。
 *
 * 输入只有一份：GET /dashboard 的实时汇总（由宿主页面传入，不自己再拉）。
 * 版式：① 研究漏斗（四环 + 文字提要）→ ② 文献/创意/实验三条构成 → ③ 论文进度 + 节奏激励。
 * 热力图与打卡表单留在宿主（今日页）里，这里不重复。
 */
import { Icon } from '../../components/Icon'
import { BarSet, Block, Chip, Donut, MiniStat, Piece, Swatch, toneText } from './MetricKit'

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

/** 环形图里的一张：标签 + 进度 + 副标 */
function RingCard({
  label,
  done,
  total,
  unit,
  tone,
  caption,
}: {
  label: string
  done: number
  total: number
  unit: string
  tone: 'accent' | 'ok' | 'warn' | 'danger'
  caption: string
}) {
  return (
    <div className="flex flex-col items-center rounded-[12px] bg-[color:var(--wb-surface-alt)] px-2 py-3">
      <Donut value={done} max={total} tone={tone} unit={unit} />
      <div className="mt-2 text-[11.5px] font-medium text-[color:var(--wb-text)]">{label}</div>
      <div className="mt-[1px] text-[10.5px] tabular-nums text-[color:var(--wb-muted)]">
        {done} / {total}
      </div>
      <div className="mt-0.5 text-center text-[10px] leading-tight text-[color:var(--wb-muted)]">{caption}</div>
    </div>
  )
}

export default function OverviewSummary({ data }: { data: any }) {
  const lit = data.literature || {}
  const litTotal = (lit.todo || 0) + (lit.reading || 0) + (lit.done || 0)
  const ideas = data.ideas || {}
  const ideaTotal = Object.keys(ideas).reduce((s, k) => s + (ideas[k] || 0), 0)
  const ideaPassed = (ideas.validated || 0) + (ideas.selected || 0)
  const exp = data.experiments || {}
  const expTotal = Object.keys(exp).reduce((s, k) => s + (exp[k] || 0), 0)
  const expDone = exp.done || 0
  const paper = data.paper || {}
  const points = data.points || {}
  const commitments = data.commitments || {}
  const blockedN = paper.blocked?.length || 0
  const weekNet = points.week_net ?? 0
  const focus14 = (data.checkins || [])
    .map((c: any) => Number(c.focus_min || 0))
    .filter((n: number) => n > 0)
  const focusAvg = focus14.length ? Math.round(focus14.reduce((a: number, b: number) => a + b, 0) / focus14.length) : 0

  return (
    <div className="flex flex-col gap-3.5">
      {/* ① 研究漏斗：四个环 + 文字提要 */}
      <Block
        title="研究漏斗"
        meta="每一环 = 当前推进到位的比例"
        extra={
          <div className="hidden items-center gap-3 sm:flex">
            <Swatch tone="accent" label="文献" />
            <Swatch tone="warn" label="创新点" />
            <Swatch tone="ok" label="实验" />
            <Swatch tone="danger" label="论文" />
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(4,minmax(0,1fr))_1.35fr]">
          <RingCard
            label="文献"
            done={lit.done || 0}
            total={litTotal}
            unit="篇"
            tone="accent"
            caption={`待读 ${lit.todo || 0} · 在读 ${lit.reading || 0}`}
          />
          <RingCard
            label="创新点"
            done={ideaPassed}
            total={ideaTotal}
            unit="条"
            tone="warn"
            caption={`筛选中 ${ideas.screening || 0} · 已弃 ${ideas.dropped || 0}`}
          />
          <RingCard
            label="实验"
            done={expDone}
            total={expTotal}
            unit="个"
            tone="ok"
            caption={`待跑 ${exp.planned || 0} · 进行 ${(exp.running || 0) + (exp.analyzing || 0)}`}
          />
          <RingCard
            label="论文"
            done={paper.progress || 0}
            total={100}
            unit="%"
            tone="danger"
            caption={`字数 ${pct(paper.words || 0, paper.target_words || 0)}%`}
          />

          {/* 提要区：文字小块，与左边四环之间有明确留白，不压到图上 */}
          <div className="col-span-2 flex flex-col justify-center gap-2.5 rounded-[12px] bg-[color:var(--wb-surface-alt)] px-3 py-2.5 sm:col-span-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10.5px] text-[color:var(--wb-muted)]">当前论文阶段</span>
              <Chip tone={blockedN ? 'danger' : 'accent'}>{paper.current?.name || '未设阶段'}</Chip>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10.5px] text-[color:var(--wb-muted)]">阻塞阶段</span>
              <span className={`text-[13px] font-semibold tabular-nums ${toneText(blockedN ? 'danger' : 'ok')}`}>
                {blockedN}
                <span className="ml-0.5 text-[10px] font-normal text-[color:var(--wb-muted)]">个</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10.5px] text-[color:var(--wb-muted)]">本周积分净额</span>
              <span className={`text-[13px] font-semibold tabular-nums ${toneText(weekNet >= 0 ? 'ok' : 'danger')}`}>
                {weekNet >= 0 ? '+' : ''}
                {weekNet}
                <span className="ml-0.5 text-[10px] font-normal text-[color:var(--wb-muted)]">分</span>
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 border-t border-[color:var(--wb-border)] pt-2 text-[10.5px] text-[color:var(--wb-muted)]">
              <Icon name={data.checkin_today ? 'check' : 'clock'} size={11} />
              {data.checkin_today ? '今天已打卡' : '今天还没打卡'}
            </div>
          </div>
        </div>
      </Block>

      {/* ② 三条横向构成图 */}
      <div className="grid grid-cols-1 items-stretch gap-3.5 lg:grid-cols-3">
        <Block title="文献阅读进度" meta={`共 ${litTotal} 篇 · 完成度 ${pct(lit.done || 0, litTotal)}%`} className="justify-between">
          <div className="flex flex-1 items-center gap-4">
            <Donut value={lit.done || 0} max={litTotal} tone="accent" unit="篇" size={72} />
            <div className="min-w-0 flex-1">
              <BarSet
                unit="篇"
                rows={[
                  { label: '已读', value: lit.done || 0, tone: 'ok' },
                  { label: '在读', value: lit.reading || 0, tone: 'warn' },
                  { label: '待读', value: lit.todo || 0, tone: 'default' },
                ]}
              />
            </div>
          </div>
        </Block>

        <Block title="创意管线" meta={`共 ${ideaTotal} 条 · 通过 ${pct(ideaPassed, ideaTotal)}%`} className="justify-between">
          <div className="flex flex-1 items-center gap-4">
            <Donut value={ideaPassed} max={ideaTotal} tone="warn" unit="条" size={72} />
            <div className="min-w-0 flex-1">
              <BarSet
                unit="条"
                rows={[
                  { label: '通过', value: ideaPassed, tone: 'ok' },
                  { label: '筛选中', value: ideas.screening || 0, tone: 'warn' },
                  { label: '已捕获', value: ideas.captured || 0, tone: 'default' },
                  { label: '已放弃', value: ideas.dropped || 0, tone: 'danger' },
                ]}
              />
            </div>
          </div>
        </Block>

        <Block title="实验构成" meta={`共 ${expTotal} 个 · 完成 ${pct(expDone, expTotal)}%`} className="justify-between">
          <div className="flex flex-1 items-center gap-4">
            <Donut value={expDone} max={expTotal} tone="ok" unit="个" size={72} />
            <div className="min-w-0 flex-1">
              <BarSet
                unit="个"
                rows={[
                  { label: '已完成', value: expDone, tone: 'ok' },
                  { label: '进行中', value: exp.running || 0, tone: 'accent' },
                  { label: '分析中', value: exp.analyzing || 0, tone: 'warn' },
                  { label: '待跑', value: exp.planned || 0, tone: 'default' },
                ]}
              />
            </div>
          </div>
        </Block>
      </div>

      {/* ③ 论文进度 + 节奏激励 */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <Block
          title="论文进度"
          meta={paper.current?.name ? `当前：${paper.current.name}` : '还没设当前阶段'}
          extra={blockedN > 0 ? <Chip tone="danger">阻塞 {blockedN}</Chip> : <Chip tone="ok">顺畅</Chip>}
        >
          <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            <Piece label="阶段完成" value={paper.progress || 0} unit="%" tone="accent" />
            <Piece
              label="字数"
              value={paper.words || 0}
              unit="字"
              hint={paper.target_words ? `目标 ${paper.target_words} 字` : '未设目标字数'}
            />
            <Piece
              label="字数进度"
              value={pct(paper.words || 0, paper.target_words || 0)}
              unit="%"
              tone={pct(paper.words || 0, paper.target_words || 0) >= 100 ? 'ok' : 'default'}
            />
            <Piece
              label="阻塞阶段"
              value={blockedN}
              unit="个"
              tone={blockedN ? 'danger' : 'ok'}
              hint={blockedN ? '超 3 天亮红牌' : '一切顺畅'}
            />
          </div>
          <div className="mt-3 border-t border-[color:var(--wb-border)] pt-2.5">
            <BarSet
              rows={[
                { label: '字数完成', value: pct(paper.words || 0, paper.target_words || 0), tone: 'accent' },
                { label: '阶段完成', value: paper.progress || 0, tone: 'ok' },
              ]}
              unit="%"
            />
          </div>
        </Block>

        <Block
          title="节奏与激励"
          meta={`保护下限 ${points.floor ?? 0} 分`}
          extra={<Chip tone={weekNet >= 0 ? 'ok' : 'danger'}>{weekNet >= 0 ? '本周为正' : '本周为负'}</Chip>}
        >
          <div className="flex items-center gap-4">
            {/* 积分没有天然上限：环按本周净额围绕「0 分」画半环，
                正值向右半圈、负值向左半圈，中心直接显示余额原值 */}
            <MiniStat
              value={points.balance ?? 0}
              tone={(points.balance ?? 0) >= 0 ? 'ok' : 'danger'}
              caption="积分余额"
              sub={`本周 ${weekNet >= 0 ? '+' : ''}${weekNet}`}
              fraction={0.5 + Math.max(-100, Math.min(100, weekNet)) / 200}
            />
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-2.5">
              <Piece label="承诺未闭合" value={commitments.open || 0} unit="项" tone={commitments.overdue > 0 ? 'danger' : 'default'} hint={commitments.overdue > 0 ? `逾期 ${commitments.overdue} 项` : '暂无逾期'} />
              <Piece label="待办任务" value={data.open_tasks || 0} unit="项" hint={`赌约 ${data.open_bets || 0} 个未结算`} />
              <Piece label="今日打卡" value={data.checkin_today ? '已打' : '未打'} tone={data.checkin_today ? 'ok' : 'warn'} />
              <Piece label="均专注/日" value={focusAvg} unit="分钟" hint={focus14.length ? `${focus14.length} 天有记录` : '暂无打卡记录'} />
            </div>
          </div>
        </Block>
      </div>
    </div>
  )
}
