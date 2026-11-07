/**
 * 新手引导（Tour）
 *
 * 交互：点「下一步」沿科研主线逐站前进；每一步用「四块遮罩挖洞」把对应的
 * 真实 UI 区域框出来。中间留空，所以被框住的区域仍然可以真实点击操作，
 * 不是一张只能看的截图。
 *
 * 跨页：步骤带 path，进入时自动 navigate；目标 DOM 可能要等接口返回/页面渲染，
 * 因此用 rAF 轮询等待（约 1.6s）。找不到就降级成全屏遮罩 + 居中卡片，
 * 绝不让引导卡死在某一步。
 *
 * 锚点约定：目标元素带 data-tour="<step.target>"。
 *   - Card 原语可直接传 tourId（渲染成 section[data-tour]）
 *   - 原生元素直接写 data-tour
 * 新增步骤时：往 TOUR_STEPS 加一项，并给对应区域打锚点即可。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Btn, IconBtn } from './ui'
import { Icon } from './Icon'

export type TourStep = {
  key: string
  title: string
  body: string
  tip?: string
  /** 进入这一步要跳到的路由；不填就留在当前页 */
  path?: string
  /** 要高亮的 data-tour 锚点名；不填则整屏遮罩 + 居中卡片 */
  target?: string
  /** 备用锚点：主锚点不存在时依次尝试（页面有空态 / 加载态 / 两种形态时用） */
  targets?: string[]
}

/** 顺序即科研主线：欢迎 → 课题 Quest → 认路 → 总览 → 输入 → 执行 → 复盘 → 激励 → 配置 → 进阶。锚点名保持不变。 */
export const TOUR_STEPS: TourStep[] = [
  {
    key: 'welcome',
    title: '欢迎来到科研工作台',
    body: '这里不是待办清单，是一条贴着科研主线走的流水线：找创新点 → 查文献 → 做实验 → 写论文 → 汇报复盘 → 积分激励。落地页的主路径是「课题 Quest」；另外两个工作台「编排画布」和「调研」各自独立，研究资产与节奏工具围着它们转。',
    tip: '花一分钟，我带你把每个环节走一遍。随时可以跳过。',
  },
  {
    key: 'workflow',
    title: '课题 Quest：从开题到成文',
    body: '这是主路径。点「新建课题」先把目标 / Baseline / 成功标准 / 硬约束写清楚，AI 按「调研 → 计划 → 实验 → 成文」逐阶段推进，每道门禁都停下来等你确认；关键结论点「沉淀为发现」，之后每轮对话自动带上。',
    path: '/chat',
    target: 'tour-chat-launch',
    tip: '顶部切换条可以在「课题 Quest / 编排画布 / 调研 Research」三个工作台之间切换；它们各自独立，URL 就是唯一真源。',
  },
  {
    key: 'sidebar',
    title: '先认路：侧边栏',
    body: '导航分三层：最上面的「工作台」三卡是做科研的地方（课题 Quest / 编排画布 / 调研 Research），中间「研究资产」放创新点、文献、实验、论文，下面「节奏」与默认折叠的「工具」是辅助入口。最上面的「今日」是每天的总览。',
    target: 'tour-sidebar',
    tip: '按 [ 可以收起侧边栏；窄屏下它会变成左下角的抽屉按钮。',
  },
  {
    key: 'today',
    title: '每天从「今日」开始',
    body: '这四张卡分别看积分余额、论文进度、待读文献、未闭合承诺。数据都从其他模块实时汇总，不用手动填第二遍；下面的曲线看的是趋势。',
    path: '/today',
    target: 'tour-dash-stats',
    tip: '看到红色数字（逾期承诺、进度落后）就优先处理那一块。',
  },
  {
    key: 'ideas',
    title: '第 1 步：捕获创新点',
    body: '左边这张卡随手记下想法：一句话说清「要解决什么」，再选分类、打分。右边可以让 AI 顺着这个方向做头脑风暴，产出的候选能直接入库。',
    path: '/ideas',
    target: 'tour-idea-form',
    tip: '想法不要求成熟，先落库；之后用「AI 质疑」从不同审稿视角逐轮打磨。',
  },
  {
    key: 'literature',
    title: '第 2 步：把文献收进来',
    body: '这张「文献库」是文献模块的主操作区：上面搜标题 / 作者、按状态与分类筛选。导入（Zotero / 粘贴 BibTeX·RIS·CSL / PDF）与在线检索各有独立入口，点开任意一篇可在抽屉里写精读笔记、读 PDF，还能看对比矩阵与关联图。',
    path: '/literature',
    target: 'tour-lit-library',
    tip: '点开任意一篇可以在抽屉里写精读笔记、读 PDF，还能做横向对比矩阵。',
  },
  {
    key: 'experiments',
    title: '第 3 步：记录实验',
    body: '先在这里写清假设与配置，跑完之后把结果逐条录进去，附上指标数值和结论。卡住的实验明确标注阻塞，别让它悄悄消失。',
    path: '/experiments',
    target: 'tour-exp-form',
    tip: '结果攒够了可以用页面里的「AI 分析」做一轮归因，写论文时直接引用。',
  },
  {
    key: 'paper',
    title: '第 4 步：推进论文',
    body: '一篇论文拆成 7 个阶段，逐个标记 doing / blocked / done。某个阶段阻塞超过 3 天会亮红色告警，字数与目标进度会自动汇总到「今日」。',
    path: '/paper',
    target: 'tour-paper-stages',
    tip: '别追求一次写完整篇，先把当前阶段推到 done。',
  },
  {
    key: 'plan',
    title: '第 5 步：周计划与复盘',
    body: '周初写本周成果和支撑任务，周末做周复盘。你的组会是两周一次，系统会在组会周自动生成双周汇报材料，不用临时拼。',
    path: '/plan',
    target: 'tour-plan-week',
    tip: '「导师」页用来记承诺、写沟通话术，MVP 先做好这两件就够。',
  },
  {
    key: 'points',
    title: '第 6 步：积分闭环',
    body: '这三张卡看余额、本周净分和保护下限。完成动作加分、拖延扣分，积分出口是你自己维护的奖励清单；还有押注对赌可以玩。',
    path: '/points',
    target: 'tour-points-stats',
    tip: '周净扣分有下限，连续几天没状态也不会把分扣穿——规则在本页可以改。',
  },
  {
    key: 'settings',
    title: '用 AI 之前：先配模型',
    body: '平时点左下角的小齿轮就能打开设置面板。在「模型供应商」里增删改 DeepSeek / OpenAI-Codex / Ollama / 本机 Qwen / 任意中转站，可以测试连接、拉取模型。当前全站统一使用快模型。',
    path: '/settings',
    target: 'tour-settings-provider',
    /** 设置页加载失败时，退回高亮左下角的设置齿轮 */
    targets: ['tour-settings-entry'],
    tip: '配好并测试连通之后，画布和对话里的 AI 功能才会真正出结果。',
  },
  {
    key: 'canvas',
    title: '进阶：编排画布 Canvas',
    body: '现在是独立页面 /canvas，不再藏在课题的第二个页签里。工具条里搭图、存模板、运行整图：把 input / prompt / skill / tool / output 连成流水线，同层节点并行跑，产出可一键存进创新点、文献或论文，也能立项成 Quest。',
    path: '/canvas',
    target: 'tour-canvas-toolbar',
    tip: '每个节点的运行记录都会记下模型、token 与耗时，方便复盘。',
  },
  {
    key: 'chat',
    title: '回到课题 Quest 工作区',
    body: '在下面的输入框里推进一个课题：按「调研 → 计划 → 实验 → 成文」切换阶段，把关键结论「沉淀为发现」，之后的每一轮对话都会自动带上这些记忆。',
    path: '/chat',
    targets: ['tour-chat-composer', 'tour-chat-launch'],
    tip: '上方的「技能」面板里有现成的科研提示词卡片，点一下就装进输入框。',
  },
  {
    key: 'done',
    title: '可以开始了',
    body: '推荐的第一条路径：先到设置里配好模型并测试连通 → 回首页点「新建课题」进入课题 Quest，把今天要做的事写成一份研究契约。之后顺着侧边栏「研究资产」往下走就行。',
    path: '/',
    tip: '想重看这份引导，点侧边栏底部的「新手引导」即可。',
  },
]

type Box = { t: number; l: number; r: number; b: number }

const PAD = 6 // 高亮框比目标元素外扩一点
const GAP = 16 // 卡片与高亮框的间距
const EDGE = 12 // 距视口边缘的最小留白
const CARD_W = 348
const EST_H = 250 // 卡片高度初值，挂载后量真实值再校正

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)))

/** 卡片优先放高亮框右侧，其次左 / 下 / 上，最后贴视口角落；始终不越界 */
function placeCard(box: Box | null, cw: number, ch: number) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!box) return { left: Math.max(EDGE, (vw - cw) / 2), top: Math.max(EDGE, (vh - ch) / 2) }

  const topAtSpot = clamp(box.t, EDGE, vh - ch - EDGE)
  if (box.r + GAP + cw <= vw - EDGE) return { left: box.r + GAP, top: topAtSpot }
  if (box.l - GAP - cw >= EDGE) return { left: box.l - GAP - cw, top: topAtSpot }

  const leftAtSpot = clamp(box.l, EDGE, vw - cw - EDGE)
  if (box.b + GAP + ch <= vh - EDGE) return { left: leftAtSpot, top: box.b + GAP }
  if (box.t - GAP - ch >= EDGE) return { left: leftAtSpot, top: box.t - GAP - ch }
  return {
    left: clamp(vw - cw - EDGE, EDGE, vw - cw - EDGE),
    top: clamp(vh - ch - EDGE, EDGE, vh - ch - EDGE),
  }
}

export default function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [i, setI] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [cardH, setCardH] = useState(EST_H)
  const cardRef = useRef<HTMLDivElement>(null)

  const step = TOUR_STEPS[i]
  const total = TOUR_STEPS.length
  const cw = Math.min(CARD_W, window.innerWidth - 24)

  // 主锚点 → 备用锚点，按声明顺序找第一个真实存在的元素
  const anchors = useMemo(
    () => (step.targets?.length ? step.targets : step.target ? [step.target] : []),
    [step.targets, step.target],
  )
  const findEl = useCallback(() => {
    for (const a of anchors) {
      const el = document.querySelector(`[data-tour="${a}"]`)
      if (el) return el
    }
    return null
  }, [anchors])

  const readBox = useCallback((): Box | null => {
    const el = findEl()
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { t: r.top - PAD, l: r.left - PAD, r: r.right + PAD, b: r.bottom + PAD }
  }, [findEl])

  // 每次打开都从第一步开始
  useEffect(() => {
    if (!open) return
    setI(0)
    setBox(null)
  }, [open])

  // 进入步骤：必要时跳页 → 等目标渲染 → 滚动到可见 → 量位置
  useEffect(() => {
    if (!open) return
    setBox(null)

    if (step.path && location.pathname !== step.path) {
      navigate(step.path)
      return // pathname 变化会再次触发本 effect
    }

    let alive = true
    let tries = 0
    let raf = 0
    const tick = () => {
      if (!alive) return
      if (anchors.length) {
        const el = findEl()
        if (!el) {
          if (tries++ < 100) {
            raf = requestAnimationFrame(tick)
            return
          }
          setBox(null) // 降级：居中卡片，不阻断流程
          return
        }
        const before = el.getBoundingClientRect()
        if (before.bottom < 0 || before.top > window.innerHeight) {
          el.scrollIntoView({ block: 'center', behavior: 'auto' })
        }
      }
      setBox(readBox())
    }
    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [open, i, step.path, location.pathname, navigate, anchors, findEl, readBox])

  // 窗口变化 / 内部容器滚动 / 高亮区内 DOM 变化时跟随，不让框漂移
  useEffect(() => {
    if (!open) return
    const sync = () => setBox(readBox())
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    const timer = window.setInterval(sync, 600)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      window.clearInterval(timer)
    }
  }, [open, readBox])

  // 卡片高度随文案变化，量真实值后才好算「放上面还是放下面」
  useLayoutEffect(() => {
    if (!open || !cardRef.current) return
    const h = cardRef.current.offsetHeight
    if (h && h !== cardH) setCardH(h)
  }, [open, i, cardH])

  const next = useCallback(() => {
    if (i >= total - 1) onClose()
    else {
      setBox(null)
      setI((v) => v + 1)
    }
  }, [i, total, onClose])

  const prev = useCallback(() => {
    if (i > 0) {
      setBox(null)
      setI((v) => v - 1)
    }
  }, [i])

  // 键盘：← → 切换，Esc 退出；在输入框里打字时不抢键
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        prev()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, next, prev, onClose])

  const pos = useMemo(() => placeCard(box, cw, cardH), [box, cw, cardH])

  if (!open) return null

  const maskCls = 'fixed z-[80] bg-[rgba(16,17,20,0.52)]'
  const vw = window.innerWidth
  const vh = window.innerHeight
  const spotW = box ? Math.max(0, box.r - box.l) : 0
  const spotH = box ? Math.max(0, box.b - box.t) : 0

  return (
    <>
      {/* 四块遮罩围出高亮区；中间留空 → 被框选的区域仍可真实操作 */}
      {box ? (
        <>
          <div className={maskCls} style={{ left: 0, top: 0, width: vw, height: Math.max(0, box.t) }} />
          <div className={maskCls} style={{ left: 0, top: box.b, width: vw, height: Math.max(0, vh - box.b) }} />
          <div className={maskCls} style={{ left: 0, top: box.t, width: Math.max(0, box.l), height: spotH }} />
          <div className={maskCls} style={{ left: box.r, top: box.t, width: Math.max(0, vw - box.r), height: spotH }} />
        </>
      ) : (
        <div className={`${maskCls} inset-0`} />
      )}

      {box && (
        <div
          aria-hidden
          className="wb-tour-spot pointer-events-none fixed z-[81] rounded-[14px] border-2 border-[color:var(--wb-accent)] transition-all duration-200"
          style={{ left: box.l, top: box.t, width: spotW, height: spotH }}
        />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="新手引导"
        className="wb-anim-pop fixed z-[82] overflow-hidden rounded-[16px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface)] shadow-[var(--wb-shadow-lg)] transition-[left,top] duration-200"
        style={{ left: pos.left, top: pos.top, width: cw }}
      >
        <div className="flex items-start gap-2.5 px-4 pb-2.5 pt-3.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--wb-accent-soft)] text-[color:var(--wb-accent)]">
            <Icon name="sparkle" size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-medium tracking-[0.08em] text-[color:var(--wb-muted)]">
              新手引导 · {i + 1} / {total}
            </div>
            <h2 className="mt-0.5 text-[14px] font-semibold leading-snug text-[color:var(--wb-text)]">
              {step.title}
            </h2>
          </div>
          <IconBtn icon="close" size="sm" ariaLabel="退出引导" onClick={onClose} />
        </div>

        <div className="h-1 w-full bg-[color:var(--wb-bg-subtle)]">
          <div
            className="h-full rounded-r-full bg-[color:var(--wb-accent)] transition-all duration-200"
            style={{ width: `${((i + 1) / total) * 100}%` }}
          />
        </div>

        <div className="px-4 py-3.5">
          <p className="text-[12.5px] leading-[1.75] text-[color:var(--wb-text-soft)]">{step.body}</p>
          {step.tip && (
            <div className="mt-3 flex gap-2 rounded-[10px] border border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-2.5 py-2">
              <Icon name="info" size={13} className="mt-[2px] shrink-0 text-[color:var(--wb-accent)]" />
              <span className="text-[11.5px] leading-relaxed text-[color:var(--wb-muted)]">{step.tip}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[color:var(--wb-border)] bg-[color:var(--wb-surface-alt)] px-3 py-2.5">
          <Btn size="xs" variant="ghost" onClick={onClose}>
            跳过引导
          </Btn>
          <div className="ml-auto flex items-center gap-2">
            {i > 0 && (
              <Btn size="sm" onClick={prev}>
                上一步
              </Btn>
            )}
            <Btn size="sm" variant="primary" onClick={next}>
              {i === total - 1 ? '开始使用' : '下一步'}
            </Btn>
          </div>
        </div>

        <div className="border-t border-[color:var(--wb-border)] px-3 py-1.5 text-center text-[10.5px] text-[color:var(--wb-muted)]">
          ← → 切换 · Esc 退出 · 高亮区域内可以直接操作
        </div>
      </div>
    </>
  )
}
