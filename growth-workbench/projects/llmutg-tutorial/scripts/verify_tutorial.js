// 实拍教程页各阶段，确认新截图与 8 页 PDF 正常
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

  for (const step of ['01', '05', '07']) {
    const btn = await page.$(`text=${step}`)
    if (btn) {
      await btn.click().catch(() => {})
      await page.waitForTimeout(2500)
    }
    await page.screenshot({ path: path.join(OUT, `_verify-step${step}.png`) })
    console.log('shot step', step)
  }
  await browser.close()
})()
