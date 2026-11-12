// 精确版：用 playwright 读取真实元素 bbox，截无标注图 + 记录框坐标
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:8000'
const TOK = process.argv[2]
const OUT = path.resolve('web/public/tutorial/llmutg/shots')
fs.mkdirSync(OUT, { recursive: true })

/**
 * targets: 用 CSS 选择器 + 文本匹配定位真实元素。
 * { text?, sel?, label, tone, pad?, waitMore? }
 */
const PAGES = [
  {
    name: '01-literature', url: '/literature?tab=library',
    targets: [
      { sel: 'nav a[href="/literature?tab=library"]', label: '侧栏 · 文献库', tone: 'g', pad: 4 },
      { text: '智能视图', label: '智能视图：全部 / 待读 / 已读', tone: 'r', pad: 6 },
      { text: '个分类', label: '文献总量与分类数（演示）', tone: 'r', pad: 8 },
      { text: '新增文献', label: '单篇新建 / Zotero / BibTeX 导入', tone: 'r', pad: 8 },
    ],
  },
  {
    name: '02-ideas', url: '/ideas',
    targets: [
      { sel: 'nav a[href="/ideas"]', label: '侧栏 · 创新点', tone: 'g', pad: 4 },
      { text: '捕获新想法', label: '标题 + 一句话主张', tone: 'r', pad: 6 },
      { text: 'AI 头脑风暴', label: 'AI 生成候选创新点', tone: 'g', pad: 6 },
      { text: '加入想法池', label: '四维评分后入库', tone: 'r', pad: 8 },
    ],
  },
  {
    name: '03-canvas', url: '/canvas',
    targets: [
      { text: '编排画布 Canvas', label: '侧栏 · 编排画布', tone: 'g', pad: 4 },
      { text: '新建画布', label: '＋ 新建画布', tone: 'r', pad: 8 },
      { text: '单元测试', label: '本案例的实验流水线画布', tone: 'g', pad: 8, waitMore: 2500 },
    ],
  },
  {
    name: '04-agent', url: '/experiments', extraWait: 4500,
    targets: [
      { sel: 'nav a[href="/experiments"]', label: '侧栏 · 实验', tone: 'g', pad: 4 },
      { text: '__bulktest E2', label: '实验会话', tone: 'r', pad: 6 },
      { text: '自动挂载技能', label: '可复现 / 统计 / 图表技能', tone: 'r', pad: 8 },
    ],
  },
  {
    name: '05-postprocess', url: '/studio/figure', extraWait: 4200,
    targets: [
      { sel: 'nav a[href="/studio/figure"]', label: '侧栏 · 绘图工作室', tone: 'g', pad: 4 },
      { text: '用作样板', label: '挑一张参考点「用作样板」', tone: 'r', pad: 6 },
    ],
  },
  {
    name: '06-paper-pipeline', url: '/paper', extraWait: 4200,
    targets: [
      { sel: 'nav a[href="/paper"]', label: '侧栏 · 论文', tone: 'g', pad: 4 },
      { text: '阶段流水线', label: '七阶段流水线（选题 → 投稿）', tone: 'r', pad: 6 },
      { text: '写作体检', label: '阻塞自检：红项就是待办', tone: 'r', pad: 6 },
      { text: '章节进度', label: '逐章字数与状态', tone: 'r', pad: 6 },
    ],
  },
  {
    name: '07-studio-paper', url: '/studio/paper',
    targets: [
      { sel: 'nav a[href="/studio/paper"]', label: '侧栏 · 论文工作室', tone: 'g', pad: 4 },
      { sel: 'select', label: '引擎选 xelatex', tone: 'r', pad: 8 },
      { text: 'llmutg_paper.tex', label: '工作区 .tex（点开即编辑）', tone: 'r', pad: 4 },
      { text: '还没有 PDF', label: '编译后 PDF 在此预览', tone: 'r', pad: 6 },
    ],
  },
  {
    name: '08-research', url: '/research', extraWait: 4200,
    targets: [
      { text: '对话 · 调研', label: '侧栏 · 对话·调研', tone: 'g', pad: 4 },
      { text: '调研', label: '调研胶囊：检索文献再回答', tone: 'r', pad: 6 },
      { text: '研究', label: '研究胶囊：多轮推进一个课题', tone: 'r', pad: 6 },
      { text: '发送', label: '输入框：问题 / 指令直接发', tone: 'g', pad: 6 },
    ],
  },
  {
    name: '09-analysis', url: '/studio/analysis', extraWait: 4200,
    targets: [
      { sel: 'nav a[href="/studio/analysis"]', label: '侧栏 · 数据分析', tone: 'g', pad: 4 },
      { text: '上传', label: '上传数据集（CSV / XLSX）', tone: 'r', pad: 6 },
      { text: '运行', label: '用 venv Python 跑分析脚本', tone: 'r', pad: 6 },
    ],
  },
  {
    name: '10-code', url: '/studio/code', extraWait: 4200,
    targets: [
      { sel: 'nav a[href="/studio/code"]', label: '侧栏 · 代码工作室', tone: 'g', pad: 4 },
      { text: '运行', label: '白名单命令执行', tone: 'r', pad: 6 },
    ],
  },
  {
    name: '11-today', url: '/today', extraWait: 4200,
    targets: [
      { text: '今日打卡', label: '状态打卡条', tone: 'r', pad: 6 },
      { text: '对导师的承诺', label: '待办：承诺 / 当前阶段 / 红警', tone: 'r', pad: 6 },
    ],
  },
  {
    name: '12-consensus', url: '/consensus', extraWait: 4200,
    targets: [
      { text: '还没有检索', label: '共识检索：搜学术问题、收敛组内分歧', tone: 'r', pad: 8 },
    ],
  },
]

async function findBox(page, t) {
  if (t.text) {
    const box = await page.evaluate((txt) => {
      const all = Array.from(
        document.querySelectorAll('button, a, div, span, h1, h2, h3, input, textarea, header, select')
      )
      const hits = []
      for (const el of all) {
        const own = (el.innerText || el.textContent || '').trim()
        if (!own || own.length > 60) continue
        if (!own.includes(txt)) continue
        const r = el.getBoundingClientRect()
        if (r.width < 12 || r.height < 10) continue
        hits.push({ x: r.x, y: r.y, w: r.width, h: r.height, area: r.width * r.height })
      }
      hits.sort((a, b) => a.area - b.area)
      return hits[0] || null
    }, t.text)
    if (box) return box
  }
  if (t.sel) {
    const el = await page.$(t.sel)
    if (el) {
      const b = await el.boundingBox()
      if (b) return { x: b.x, y: b.y, w: b.width, h: b.height }
    }
  }
  return null
}

;(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const VW = 1440,
    VH = 900
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 })
  await ctx.addCookies([{ name: 'wb_session', value: TOK, domain: '127.0.0.1', path: '/' }])
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('wb:app.tourSeen', 'true')
    } catch (e) {}
  })
  const page = await ctx.newPage()
  page.setDefaultTimeout(45000)
  const meta = {}

  for (const p of PAGES) {
    await page.goto(BASE + p.url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(p.extraWait || 3200)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(400)

    const boxes = []
    for (const t of p.targets) {
      let b = await findBox(page, t)
      if (!b && t.waitMore) {
        await page.waitForTimeout(t.waitMore)
        b = await findBox(page, t)
      }
      if (b) {
        const pad = t.pad || 4
        boxes.push({
          x: Math.max(0, b.x - pad),
          y: Math.max(0, b.y - pad),
          w: Math.min(VW - Math.max(0, b.x - pad), b.w + pad * 2),
          h: b.h + pad * 2,
          label: t.label,
          tone: t.tone,
        })
      } else {
        console.log('  miss:', p.name, t.label)
      }
    }
    const file = path.join(OUT, p.name + '.png')
    await page.screenshot({ path: file })
    meta[p.name] = { w: VW, h: VH, boxes }
    console.log('OK', p.name, boxes.length + '/' + p.targets.length)
  }
  fs.writeFileSync(path.join(OUT, 'boxes.json'), JSON.stringify(meta, null, 2))
  await browser.close()
})()
