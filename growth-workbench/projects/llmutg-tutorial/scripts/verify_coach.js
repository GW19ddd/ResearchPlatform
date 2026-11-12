// 验证新手引导卡片：打开教程页 → 点第一张试一试卡片 → 截图
const { chromium } = require('playwright-core')
const path = require('path')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = 'http://127.0.0.1:8000'
const TOK = process.argv[2]
const OUT = path.resolve('web/public/tutorial/llmutg/shots')

;(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 })
  await ctx.addCookies([{ name: 'wb_session', value: TOK, domain: '127.0.0.1', path: '/' }])
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('wb:app.tourSeen', 'true')
    } catch (e) {}
  })
  const page = await ctx.newPage()
  page.setDefaultTimeout(60000)
  await page.goto(BASE + '/tutorial/llmutg', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)

  // 点第一张试一试卡片
  const card = await page.$('text=侧栏 · 文献库')
  if (card) {
    await card.click().catch((e) => console.log('click err', e.message))
    await page.waitForTimeout(1200)
    await page.screenshot({ path: path.join(OUT, '_verify-coach1.png') })
    console.log('coach1 ok')
    // 点第二个引导（上一个/下一个按钮）
    const next = await page.$('button:has-text("下一个")')
    if (next) {
      await next.click().catch(() => {})
      await page.waitForTimeout(900)
      await page.screenshot({ path: path.join(OUT, '_verify-coach2.png') })
      console.log('coach2 ok')
    }
  } else {
    console.log('card not found')
  }
  await browser.close()
})()
