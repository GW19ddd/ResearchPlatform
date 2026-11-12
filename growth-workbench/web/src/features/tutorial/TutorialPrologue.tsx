import { Icon } from '../../components/Icon'

/**
 * 教程序章：故事化开场
 * 1) 场景：被论文堆 / 实验堆 / 药瓶围住的科研人
 * 2) 相遇：一台「研流」工作台把乱麻收成一条流水线
 * 3) 旅程：五站路线图，对应后面七个阶段
 * 全部为 SVG 手绘，不依赖外部图片；配色走 --wb-* 令牌 + 少量纸墨色
 */

const INK = '#1A1A1A'
const LINEN = '#FBFAF7'
const RED = '#A4262C'
const GREEN = '#2F5D50'
const ACCENT = '#5145E0'

/** 场景一：三座山压着一个科研人 */
function SceneChaos() {
  return (
    <svg viewBox="0 0 680 260" className="w-full">
      <defs>
        <linearGradient id="pgA" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#E8E6DF" />
        </linearGradient>
      </defs>
      {/* 地面 */}
      <line x1="20" y1="218" x2="660" y2="218" stroke="#D8D5CC" strokeWidth="1.5" />

      {/* 左：论文堆（散乱、东倒西歪） */}
      <g>
        {Array.from({ length: 14 }).map((_, i) => {
          const y = 216 - (i + 1) * 12
          const w = 118 - Math.floor(i / 3) * 9
          const dx = 30 + (i % 4) * 5 + (i % 2 ? 4 : 0)
          const rot = (i % 3 === 0 ? -1.4 : i % 3 === 1 ? 1.2 : 0)
          return (
            <g key={i} transform={`rotate(${rot} ${dx + w / 2} ${y + 5})`}>
              <rect x={dx} y={y} width={w} height={10} rx="1" fill={i % 5 === 2 ? '#EFEBE1' : '#FFFFFF'} stroke="#B9B5A9" strokeWidth="0.9" />
              <line x1={dx + 8} y1={y + 5} x2={dx + w - 16} y2={y + 5} stroke="#CFCBBF" strokeWidth="1.2" />
            </g>
          )
        })}
        {/* 顶上滑出来的一张：压在最上层，斜着探出 */}
        <g transform="rotate(-13 118 46)">
          <rect x="86" y="42" width="74" height="9" rx="1" fill="#fff" stroke="#B9B5A9" strokeWidth="0.9" />
          <line x1="94" y1="46.5" x2="150" y2="46.5" stroke="#CFCBBF" strokeWidth="1.2" />
        </g>
        <text x={30} y={240} fontSize="11" fill="#8A8678" fontFamily="ui-sans-serif">
          Related Work 永远读不完
        </text>
      </g>

      {/* 中：实验散点堆（玻璃珠/数据点） */}
      <g>
        {[
          [232, 210], [252, 206], [272, 212], [292, 205], [252, 192], [274, 190], [296, 194], [266, 176], [288, 172],
          [310, 208], [240, 176], [308, 180],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="9" fill={i % 3 === 0 ? '#C9D8D2' : '#DCD9CF'} stroke="#ABA79A" strokeWidth="1" />
        ))}
        <text x={224} y={240} fontSize="11" fill="#8A8678" fontFamily="ui-sans-serif">
          跑不完的 ablation
        </text>
      </g>

      {/* 右：药瓶堆 */}
      <g>
        {[
          [470, 190, 34, 52],
          [512, 176, 30, 46],
          [548, 196, 28, 42],
          [496, 148, 26, 36],
        ].map(([x, y, w, h], i) => (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} rx="4" fill="#F2EDE6" stroke="#B4AFA2" strokeWidth="1.2" />
            <rect x={x - 3} y={y - 7} width={w + 6} height={8} rx="2" fill="#D9D3C7" stroke="#B4AFA2" strokeWidth="1" />
            <rect x={x + 5} y={y + 14} width={w - 10} height={Math.max(6, h * 0.32)} rx="1.5" fill="#E5DED2" />
            <line x1={x + 9} y1={y + h * 0.3} x2={x + w - 9} y2={y + h * 0.3} stroke="#C6BFB0" strokeWidth="1.2" />
          </g>
        ))}
        <text x={452} y={240} fontSize="11" fill="#8A8678" fontFamily="ui-sans-serif">
          白天写论文 · 晚上改代码
        </text>
      </g>

      {/* 中间：被压住的人 */}
      <g transform="translate(378,120)">
        {/* 桌子 */}
        <rect x="-56" y="58" width="112" height="7" rx="2" fill="#CFC9BB" />
        <rect x="-48" y="65" width="6" height="33" fill="#CFC9BB" />
        <rect x="42" y="65" width="6" height="33" fill="#CFC9BB" />
        {/* 人：低头伏案 */}
        <circle cx="0" cy="16" r="15" fill={LINEN} stroke={INK} strokeWidth="2" />
        <path d="M-15 10 q15 -14 30 0" fill={INK} opacity="0.85" />
        <path d="M-24 58 q0 -30 24 -30 q24 0 24 30" fill={GREEN} stroke={GREEN} strokeWidth="2" />
        {/* 摊开的纸（画在人之后，压在桌面上） */}
        <rect x="-34" y="47" width="34" height="11" rx="1" fill="#fff" stroke="#B9B5A9" />
        <rect x="2" y="47" width="30" height="11" rx="1" fill="#fff" stroke="#B9B5A9" />
        {/* 汗滴 / 困意 */}
        <path d="M19 2 q4 6 0 9 q-4 -3 0 -9" fill="#BBD0E8" />
        {/* 头上气泡：乱 */}
        <path d="M-6 -6 l0 0" stroke={INK} />
      </g>

      {/* 头上乱麻气泡 */}
      <g transform="translate(392,58)">
        <path d="M-26 -22 h64 a8 8 0 0 1 8 8 v20 a8 8 0 0 1 -8 8 h-30 l-10 9 v-9 h-24 a8 8 0 0 1 -8 -8 v-20 a8 8 0 0 1 8 -8 z" fill="#fff" stroke="#C4BFB2" />
        <path d="M-16 -8 q10 -10 18 0 q8 10 18 0" fill="none" stroke={RED} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M-16 0 q10 10 18 0 q8 -10 18 0" fill="none" stroke={RED} strokeWidth="1.8" strokeLinecap="round" opacity="0.6" />
      </g>
    </svg>
  )
}

/** 场景二：一台工作台把乱麻收成一条流水线 */
function ScenePipeline() {
  const nodes = [
    { x: 96, label: '文献库', sub: '调研 · 关联图' },
    { x: 216, label: '创新点', sub: '选题 · 可证伪' },
    { x: 336, label: '编排画布', sub: '实验 · 有记录' },
    { x: 456, label: '后处理', sub: '统计 · 出图' },
    { x: 576, label: '论文', sub: '倒排成稿' },
  ]
  return (
    <svg viewBox="0 0 680 150" className="w-full">
      <line x1="60" y1="76" x2="620" y2="76" stroke="#D8D5CC" strokeWidth="2" strokeDasharray="5 5" />
      {nodes.map((n, i) => (
        <g key={n.label}>
          <circle cx={n.x} cy={76} r="23" fill="#fff" stroke={i === 2 ? ACCENT : '#C4BFB2'} strokeWidth={i === 2 ? 2.4 : 1.6} />
          <text x={n.x} y={81} fontSize="13" fontWeight="700" fill={i === 2 ? ACCENT : '#57534A'} textAnchor="middle" fontFamily="ui-sans-serif">
            {i + 1}
          </text>
          <text x={n.x} y={26} fontSize="12" fontWeight="600" fill={INK} textAnchor="middle" fontFamily="ui-sans-serif">
            {n.label}
          </text>
          <text x={n.x} y={126} fontSize="10.5" fill="#8A8678" textAnchor="middle" fontFamily="ui-sans-serif">
            {n.sub}
          </text>
        </g>
      ))}
      <text x="640" y="80" fontSize="16" fill={GREEN} fontFamily="ui-sans-serif">
        ✓
      </text>
    </svg>
  )
}

/** 旅程路线图：五站 */
const JOURNEY = [
  { k: '占位', t: '一堆乱麻', d: '论文读了记不住、实验跑完没结论、投稿前一晚才发现缺一组对照。', tone: RED },
  { k: '第 1 站', t: '把混乱收进一个库', d: '文献、想法、实验、结果各归其位；每一条都带结构化字段，能查、能引用、能复现。', tone: GREEN },
  { k: '第 2 站', t: '让缺口自己浮出来', d: '文献矩阵摆开，空格就是选题；创新点写下否证条件，先想清楚「什么结果算输」。', tone: GREEN },
  { k: '第 3 站', t: '把实验跑成一条流水线', d: '画布上编排多源反馈与决策，每次运行留痕；结果自动后处理成表和图。', tone: ACCENT },
  { k: '第 4 站', t: '把过程折成一篇论文', d: '倒排写作：结果先写，方法次之，引言最后。每个论断都能点回一条真实记录。', tone: ACCENT },
  { k: '第 5 站', t: '明天还能接着干', d: '周计划、周复盘、导师承诺与积分，把「持续」这件事也设计进去。', tone: GREEN },
]

export default function TutorialPrologue({ onStart }: { onStart: () => void }) {
  return (
    <div className="mx-auto max-w-[900px] px-5 py-6 md:px-8">
      {/* 标题 */}
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--wb-muted)]">
        开发案例 · 序章
      </div>
      <h1 className="mt-2 text-[26px] font-semibold leading-[1.24] tracking-[-0.01em] text-[color:var(--wb-text)] md:text-[31px]">
        一个科研人的一天，<br className="md:hidden" />
        是怎么被工作台接住的
      </h1>
      <p className="mt-3 max-w-[640px] text-[13.5px] leading-[1.85] text-[color:var(--wb-text-soft)]">
        这个案例不抽象地讲功能。它跟着一个人走一遍：从「桌上三堆东西、脑子里一团乱」，
        到「手上有八页英文论文、每句话都能点回一条真实记录」。你要做的论文是
        <b className="text-[color:var(--wb-text)]">《基于大语言模型的 AI 单元测试生成》</b>（DMF-Jev），
        目标会议 CCF-A / TOSEM。
      </p>

      {/* 场景一 */}
      <div className="mt-7 rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-4 md:p-5">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded-md bg-[color:var(--wb-bg-subtle)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[color:var(--wb-muted)]">
            开工前一晚
          </span>
          <span className="text-[12px] text-[color:var(--wb-muted)]">23:47 · 宿舍</span>
        </div>
        <SceneChaos />
        <p className="mt-1 text-[13px] leading-[1.85] text-[color:var(--wb-text-soft)]">
          左手边九摞论文，只记得标题记不住结论；右手边十二个实验目录，<span className="font-mono text-[12px] text-[color:var(--wb-muted)]">result_v3_final_fix2</span> 到底改了什么没人知道；
          屏幕上是投稿倒数的第八天。这不是能力问题，是<b className="text-[color:var(--wb-text)]">过程没有地方落脚</b>——
          读过的、跑过的、想过的都只活在工作记忆里，一觉醒来就漏掉一半。
        </p>
      </div>

      {/* 过渡 */}
      <div className="my-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-[color:var(--wb-border)]" />
        <span className="text-[11px] font-medium text-[color:var(--wb-muted)]">于是它换了个做法</span>
        <div className="h-px flex-1 bg-[color:var(--wb-border)]" />
      </div>

      {/* 场景二 */}
      <div className="rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] p-4 md:p-5">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded-md bg-[color:var(--wb-accent-soft)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[color:var(--wb-accent)]">
            引入研流
          </span>
          <span className="text-[12px] text-[color:var(--wb-muted)]">不是又一个待办清单</span>
        </div>
        <ScenePipeline />
        <p className="mt-1 text-[13px] leading-[1.85] text-[color:var(--wb-text-soft)]">
          研流不催你打卡。它只做一件事：<b className="text-[color:var(--wb-text)]">给科研过程的每一步找个落脚点，并让后一步能直接吃到前一步的产物</b>。
          文献库里的一条记录，会在创新点页被引用、在画布上被当作上下文、在论文里被写成 <span className="font-mono text-[12px]">\cite</span>；
          后处理脚本吐出的 CSV，会变成 Results 的表，再变成摘要里的一个数字。<b className="text-[color:var(--wb-text)]">同一条数据只录一次，但会被用五次。</b>
        </p>
      </div>

      {/* 旅程 */}
      <h2 className="mt-8 text-[15px] font-semibold text-[color:var(--wb-text)]">这趟路分五站走</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-[color:var(--wb-muted)]">
        每一站都对应教程里的具体阶段，也对应论文里的具体章节。可以按顺序走，也可以只挑你卡住的那一站。
      </p>
      <div className="mt-3 space-y-2">
        {JOURNEY.map((j, i) => (
          <div
            key={j.t}
            className="flex gap-3 rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3.5 py-3"
          >
            <div className="flex flex-col items-center pt-0.5">
              <span
                className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[10.5px] font-bold text-white"
                style={{ background: j.tone }}
              >
                {i === 0 ? '·' : i}
              </span>
              {i < JOURNEY.length - 1 && <span className="mt-1 w-px flex-1 bg-[color:var(--wb-border)]" />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--wb-muted)]">{j.k}</span>
                <span className="text-[13.5px] font-semibold text-[color:var(--wb-text)]">{j.t}</span>
              </div>
              <p className="mt-0.5 text-[12.5px] leading-[1.75] text-[color:var(--wb-text-soft)]">{j.d}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 提示 */}
      <div className="mt-6 rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-bg-subtle)] px-3.5 py-3">
        <div className="flex items-start gap-2 text-[12.5px] leading-[1.8] text-[color:var(--wb-text-soft)]">
          <Icon name="info" size={14} className="mt-[3px] shrink-0 text-[color:var(--wb-muted)]" />
          <span>
            案例里的实验数据是<b className="text-[color:var(--wb-text)]">合成的演示数据</b>，用于演示「数据怎么从工具流到论文」，
            不是任何真实测量的结果；文中所有数字都标了「演示占位」。真实研究请替换为你的实验记录。
          </span>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2">
        <button
          onClick={onStart}
          className="flex items-center gap-1.5 rounded-[9px] bg-[color:var(--wb-accent)] px-3.5 py-2 text-[12.5px] font-medium text-white"
        >
          从第 1 站开始 <Icon name="arrowRight" size={13} />
        </button>
        <span className="text-[11.5px] text-[color:var(--wb-muted)]">共 7 个阶段 · 约 25 分钟走完</span>
      </div>
    </div>
  )
}

export { SceneChaos, ScenePipeline, JOURNEY, INK, LINEN, RED, GREEN, ACCENT }
