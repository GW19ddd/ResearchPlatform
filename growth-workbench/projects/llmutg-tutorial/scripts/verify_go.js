// E2E：教程页 → 试一试卡片 → 前往实操 → 目标页出现引导卡 → 开始指引 → 回到教程
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

  // 1) 打开第一张试一试卡片 → 前往实操
  await page.locator('button', { hasText: '侧栏 · 文献库' }).last().click().catch((e) => console.log('card err', e.message))
  await page.waitForTimeout(900)
  await page.locator('button', { hasText: '前往实操' }).first().click().catch((e) => console.log('go err', e.message))
  await page.waitForTimeout(2500)
  console.log('url after go:', page.url())
  await page.screenshot({ path: path.join(OUT, '_verify-go1.png') })

  // 2) 目标页应出现引导卡 → 开始指引
  await page.locator('button', { hasText: '开始指引' }).first().click().catch((e) => console.log('start err', e.message))
  await page.waitForTimeout(900)
  await page.screenshot({ path: path.join(OUT, '_verify-go2.png') })

  // 3) 下一个要点
  await page.locator('button', { hasText: '下一个' }).first().click().catch((e) => console.log('next err', e.message))
  await page.waitForTimeout(900)
  await page.screenshot({ path: path.join(OUT, '_verify-go3.png') })

  // 4) 回到教程
  await page.locator('button', { hasText: '回教程' }).first().click().catch((e) => console.log('back err', e.message))
  await page.waitForTimeout(2000)
  console.log('url after back:', page.url())
  await page.screenshot({ path: path.join(OUT, '_verify-go4.png') })

  await browser.close()
  console.log('done')
})()
