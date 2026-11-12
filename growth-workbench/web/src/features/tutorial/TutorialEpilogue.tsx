import { Icon } from '../../components/Icon'

/**
 * 教程收尾：成品展示
 * 让读者看到「走完全程之后，手上到底是什么」——一篇八页英文论文 + 能点回去的证据链
 */

export type DeliverItem = {
  chapter: string
  title: string   // 论文小节名
  from: string    // 出自工作台哪个模块
  state: string   // 完成状态
}

const DELIVER: DeliverItem[] = [
  { chapter: '§1', title: 'Introduction', from: '创新点 · 三条可证伪主张', state: '4 条贡献 + 章节导览' },
  { chapter: '§2', title: 'Related Work', from: '文献库 · 6 篇结构化记录', state: '两条支线（agent / 成本感知）' },
  { chapter: '§3', title: 'Motivation & RQs', from: '文献矩阵缺口', state: 'RQ1–RQ3' },
  { chapter: '§4', title: 'Method: DMF-Jev', from: '编排画布 · 六源反馈图', state: '4 式 + 算法框' },
  { chapter: '§5', title: 'Experimental Design', from: '实验记录 · 冻结配置', state: '3 项消融' },
  { chapter: '§6', title: 'Post-processing', from: '数据分析 · 脚本', state: 'Wilcoxon + Cliff δ' },
  { chapter: '§7', title: 'Results', from: '脚本自动生成（幂等）', state: '3 表 2 图' },
  { chapter: '§8', title: 'Discussion', from: '周复盘 · 4 个专题', state: '含失效分析' },
  { chapter: '§9', title: 'Threats to Validity', from: '实验记录反查', state: '4 类威胁' },
  { chapter: '§10', title: 'Conclusion', from: '全链回看', state: '含 future work' },
]

const LOOP = [
  { t: '数据从哪来', d: 'Results 表里每个数字，都能在 结果 CSV → 后处理脚本 → 实验记录 里逐级回查，没有一处是手填的。' },
  { t: '论断靠什么撑', d: '摘要里「调用量降 34%」对应表 2 的 Δcalls 列，标注了 n、均值、置信区间与检验方法。' },
  { t: '改一处同步到哪', d: '文献库改一条笔记，创新点的引用、画布上下文、论文的 \\cite 全部跟着变——因为只存一份。' },
]

export default function TutorialEpilogue({
  onRestart,
  onReview,
  pdfHref,
  texHref,
}: {
  onRestart: () => void
  onReview: () => void
  pdfHref: string
  texHref: string
}) {
  return (
    <div className="mx-auto max-w-[900px] px-5 py-6 md:px-8">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--wb-muted)]">
        开发案例 · 终点
      </div>
      <h1 className="mt-2 text-[26px] font-semibold leading-[1.24] tracking-[-0.01em] text-[color:var(--wb-text)] md:text-[30px]">
        八页之后，你手上多了一样东西
      </h1>
      <p className="mt-3 max-w-[660px] text-[13.5px] leading-[1.85] text-[color:var(--wb-text-soft)]">
        不是「写完了一篇论文」，而是<b className="text-[color:var(--wb-text)]">第一次知道这篇论文是怎么长出来的</b>——
        第几行数字来自哪个脚本、哪句话对应哪条实验记录、哪条主张曾被否证过。下一次换题目，这套流程可以直接搬。
      </p>

      {/* 论文成品卡 */}
      <div className="mt-6 overflow-hidden rounded-[14px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--wb-border)] px-4 py-3">
          <span className="rounded-md bg-[color:var(--wb-accent)] px-1.5 py-0.5 text-[10.5px] font-semibold text-white">
            成品
          </span>
          <span className="text-[13px] font-semibold text-[color:var(--wb-text)]">
            LLM-Based Unit Test Generation with Dynamic Multi-Source Feedback
          </span>
          <span className="ml-auto flex items-center gap-2 text-[11.5px]">
            <a href={pdfHref} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[color:var(--wb-accent)] hover:underline">
              <Icon name="file" size={12} /> PDF · 8 页
            </a>
            <a href={texHref} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[color:var(--wb-muted)] hover:underline">
              <Icon name="code" size={12} /> LaTeX 源
            </a>
          </span>
        </div>

        <div className="grid grid-cols-1 divide-y divide-[color:var(--wb-border)] sm:grid-cols-2 sm:divide-y-0">
          {DELIVER.map((d) => (
            <div
              key={d.chapter}
              className="flex items-start gap-2.5 px-4 py-2.5 sm:border-b sm:border-[color:var(--wb-border)] sm:[&:nth-last-child(-n+2)]:border-b-0"
            >
              <span className="mt-[1px] w-[26px] shrink-0 font-mono text-[11px] font-semibold text-[color:var(--wb-accent)]">
                {d.chapter}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium text-[color:var(--wb-text)]">{d.title}</span>
                <span className="mt-0.5 block truncate text-[11px] text-[color:var(--wb-muted)]">
                  ← {d.from} · {d.state}
                </span>
              </span>
              <Icon name="check" size={13} className="ml-auto mt-[3px] shrink-0 text-[#2F5D50]" />
            </div>
          ))}
        </div>
      </div>

      {/* 证据链 */}
      <h2 className="mt-7 text-[15px] font-semibold text-[color:var(--wb-text)]">真正值钱的是这条证据链</h2>
      <div className="mt-3 space-y-2">
        {LOOP.map((l, i) => (
          <div key={l.t} className="rounded-[12px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] px-3.5 py-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] text-[color:var(--wb-muted)]">0{i + 1}</span>
              <span className="text-[13px] font-semibold text-[color:var(--wb-text)]">{l.t}</span>
            </div>
            <p className="mt-1 pl-[22px] text-[12.5px] leading-[1.8] text-[color:var(--wb-text-soft)]">{l.d}</p>
          </div>
        ))}
      </div>

      {/* 接下来 */}
      <div className="mt-6 rounded-[12px] border border-[color:var(--wb-accent-soft)] bg-[color:var(--wb-accent-soft)] px-3.5 py-3">
        <div className="text-[12.5px] font-semibold text-[color:var(--wb-accent)]">换成你自己的题目时，只需要换三件事</div>
        <ol className="mt-1.5 space-y-1 pl-1 text-[12.5px] leading-[1.8] text-[color:var(--wb-text-soft)]">
          <li>1. 文献库换成你方向的 20 篇核心文献，集合标签按你关心的维度重打。</li>
          <li>2. 创新点的三条主张与否证阈值，按你的基线重写——阈值要能预先定死。</li>
          <li>3. 后处理脚本换成你的指标口径，其余（倒排写作、证据回查、周复盘）原样复用。</li>
        </ol>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          onClick={onReview}
          className="flex items-center gap-1.5 rounded-[9px] bg-[color:var(--wb-bg-subtle)] px-3.5 py-2 text-[12.5px] font-medium text-[color:var(--wb-text)]"
        >
          <Icon name="reply" size={13} /> 回看各阶段
        </button>
        <button
          onClick={onRestart}
          className="flex items-center gap-1.5 rounded-[9px] border border-[color:var(--wb-border)] px-3.5 py-2 text-[12.5px] font-medium text-[color:var(--wb-text-soft)]"
        >
          <Icon name="refresh" size={13} /> 从序章重来
        </button>
        <a
          href={pdfHref}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-[9px] bg-[color:var(--wb-accent)] px-3.5 py-2 text-[12.5px] font-medium text-white"
        >
          <Icon name="maximize" size={13} /> 打开论文全文
        </a>
      </div>
    </div>
  )
}

export { DELIVER, LOOP }
