import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'

const baseUrl = 'http://127.0.0.1:4189'
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4189', '--strictPort'], { stdio: 'pipe' })
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString() })
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString() })

async function waitForServer() {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    try { if ((await fetch(baseUrl)).ok) return } catch { /* Vite is still booting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Vite did not start:\n${serverOutput}`)
}

let browser
try {
  await waitForServer()
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
    headless: true,
    args: ['--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${baseUrl}?rmfTrace=reference`, { waitUntil: 'domcontentloaded' })
  await page.getByText('시뮬레이션 준비 완료 — 448개체').waitFor({ timeout: 25_000 })
  await page.locator('.rmf-replay').waitFor({ timeout: 5_000 })
  assert.match(await page.locator('.rmf-detail').textContent() ?? '', /REFERENCE TRACE.*준비/, 'HUD must identify a reference replay, not live RMF')
  assert.equal(
    await page.locator('.fleet-board [data-authority="trace"]').count(),
    2,
    'Reference replay robots must be labeled TRACE rather than live RMF'
  )

  await page.locator('.scale-row').getByRole('button', { name: '16×' }).click()
  await page.getByRole('button', { name: /통합 시연 시작/ }).click()
  await page.locator('.scale-row button.active').filter({ hasText: '1×' }).waitFor()
  await page.waitForFunction(() =>
    Number(globalThis.document.querySelector('.scoreboard')?.getAttribute('data-human-robot-clearances')) >= 1
  , undefined, { timeout: 30_000 })
  await page.waitForTimeout(350)
  if (process.env.E2E_INTERACTION_SCREENSHOT) await page.screenshot({ path: process.env.E2E_INTERACTION_SCREENSHOT, fullPage: true })
  await page.locator('.purpose-callout[data-task-kind="inspection_round"][data-task-status="interacting"]').waitFor({ timeout: 30_000 })
  assert.match(await page.locator('.purpose-callout').textContent() ?? '', /사람용|설비/, 'Inspection interaction must explain the humanoid purpose')
  await page.locator('.phase-detected, .phase-alarm, .phase-response, .phase-evacuation').waitFor({ timeout: 12_000 })
  await page.locator('.purpose-callout[data-task-kind="gas_isolation"][data-task-status="interacting"]').waitFor({ timeout: 20_000 })
  assert.match(await page.locator('.purpose-callout').textContent() ?? '', /수동 격리 밸브/, 'Gas isolation must explain the human-tool advantage')
  await page.locator(
    '.mission-proof[data-action-telemetry-fresh="true"][data-action-telemetry-phase="verified"]' +
    '[data-valve-position="1"][data-hand-pose-measured="true"]'
  ).waitFor({ timeout: 12_000 })
  await page.locator('.mission-impact[data-work-zone-human-entries="0"][data-work-zone-robot-entries="1"]').waitFor({ timeout: 5_000 })
  if (process.env.E2E_TRACE_SCREENSHOT) {
    await page.waitForTimeout(1_500)
    await page.screenshot({ path: process.env.E2E_TRACE_SCREENSHOT, fullPage: true })
  }
  await page.getByText(/휴머노이드의 밸브 폐쇄·내장 센서 검증으로 위험원이 통제되었습니다/).waitFor({ timeout: 12_000 })
  await page.waitForTimeout(350)
  await page.waitForFunction(() => {
    const completed = [...globalThis.document.querySelectorAll('.task-list b')].filter((element) => element.textContent === '완료')
    return completed.length >= 2
  }, undefined, { timeout: 25_000 })
  await page.waitForTimeout(1_750)
  assert.equal(await page.locator('.rmf-error').count(), 0, 'Reference trace must not trigger RMF errors or pose watchdog safe-stop')
  assert.ok(Number(await page.locator('.scoreboard').getAttribute('data-human-robot-clearances')) >= 1, 'At least one worker must physically clear a humanoid work zone')
  assert.deepEqual(pageErrors, [], `Browser page errors:\n${pageErrors.join('\n')}`)
  console.log('RMF trace E2E passed: pose heartbeat, executor telemetry, gas isolation, worker clearance, and two task completions.')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await new Promise((resolveExit) => server.once('exit', resolveExit))
}
