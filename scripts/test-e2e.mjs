import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'

const baseUrl = 'http://127.0.0.1:4187'
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4187', '--strictPort'], { stdio: 'pipe' })
const rmfServer = new WebSocketServer({ host: '127.0.0.1', port: 4188 })
let dispatchedRmfRequest
const dispatchedRmfRequests = []
const dispatchedTaskIds = []
const cancelledTaskIds = []
// Keep the mock Bridge degraded long enough for software WebGL to finish the
// first fab frame. Otherwise the test can miss the blocked state entirely on
// slower CI hosts even though the client handled both socket messages.
const readinessDelay = process.env.E2E_PREFLIGHT_BLOCKED_SCREENSHOT ? 10_000 : 6_000
const measuredHandPose = (manipulation) => {
  const position = (side) => {
    if (manipulation === undefined) return [0.05, 0.92, side * 0.34]
    const regrip = Math.sin(Math.max(0, Math.min(1, manipulation)) * Math.PI * 4) * 0.26
    const angle = side === 1 ? 0.65 + regrip : Math.PI - 0.65 + regrip
    return [0.4195, 1.05 + Math.sin(angle) * 0.22, Math.cos(angle) * 0.22]
  }
  return { frame: 'base_link', leftPositionM: position(-1), rightPositionM: position(1) }
}
rmfServer.on('connection', (socket) => {
  const cancelledTasks = new Set()
  const send = (message, delay = 0) => {
    setTimeout(() => {
      if (message.taskId && cancelledTasks.has(message.taskId)) return
      if (socket.readyState === 1) socket.send(JSON.stringify(message))
    }, delay)
  }
  const taskState = (request, status, assignedRobot, delay = 0, interactionKind) => send({
    type: 'task_state',
    taskId: request.description.fabworld_task_id,
    category: request.description.category,
    status,
    assignedRobot,
    targetId: request.description.target_id,
    ...(interactionKind ? { interactionKind } : {}),
    timestamp: Date.now() + delay
  }, delay)
  const workPermit = (request, delay = 0) => send({
    type: 'work_permit',
    taskId: request.description.fabworld_task_id,
    authorized: true,
    authorizedBy: 'e2e-ehs-controller',
    clearance: 2.25,
    timestamp: Date.now() + delay
  }, delay)
  const actionTelemetry = (request, sample, delay = 0) => send({
    type: 'action_telemetry',
    taskId: request.description.fabworld_task_id,
    category: 'gas_isolation',
    robot: 'humanoid-001',
    ...sample,
    timestamp: Date.now() + delay
  }, delay)
  const robotState = (robot, x, y, mode, taskId, delay = 0, yaw = 0.4) => send({
    type: 'robot_state',
    fleet: 'fab_humanoid_fleet',
    robot,
    map: 'fab-L1',
    x,
    y,
    yaw,
    battery: robot === 'humanoid-001' ? 88 : 91,
    mode,
    ...(taskId ? { taskId } : {}),
    timestamp: Date.now() + delay
  }, delay)
  const bridgeStatus = (status, delay, overrides = {}) => send({
    type: 'bridge_status',
    status,
    fleet: 'fab_humanoid_fleet',
    robotsSeen: 2,
    robotsPublished: status === 'ready' ? 2 : 0,
    robotsWithoutLocation: 0,
    unknownMaps: status === 'ready' ? [] : ['UNMAPPED'],
    pollLatencyMs: 18,
    maxPoseAgeMs: 42,
    detail: status === 'ready' ? '2/2대 pose 정규화' : '미등록 RMF map: UNMAPPED',
    timestamp: Date.now() + delay,
    ...overrides
  }, delay)
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.type === 'subscribe') {
      bridgeStatus('degraded', 0)
      bridgeStatus('ready', readinessDelay)
      send({
        type: 'robot_state',
        fleet: 'fab_humanoid_fleet',
        robot: 'humanoid-001',
        map: 'fab-L1',
        x: -96,
        y: -106,
        yaw: 0.2,
        battery: 88,
        mode: 'idle',
        timestamp: Date.now() + readinessDelay
      }, readinessDelay)
      send({
        type: 'robot_state',
        fleet: 'fab_humanoid_fleet',
        robot: 'humanoid-002',
        map: 'fab-L1',
        x: -86,
        y: -70.5,
        yaw: 0,
        battery: 91,
        mode: 'idle',
        timestamp: Date.now() + readinessDelay
      }, readinessDelay)
    }
    if (message.type === 'dispatch_task') {
      dispatchedRmfRequest = message
      dispatchedRmfRequests.push(message)
      const request = message.request
      const taskId = request.description.fabworld_task_id
      dispatchedTaskIds.push(taskId)
      if (taskId.startsWith('showcase-inspection-')) {
        taskState(request, 'assigned', 'humanoid-002')
        robotState('humanoid-002', -92, -101, 'moving', taskId, 50)
        taskState(request, 'navigating', 'humanoid-002', 100)
        robotState('humanoid-002', -74, -88, 'idle', taskId, 600)
        taskState(request, 'observing', 'humanoid-002', 700)
        taskState(request, 'interacting', 'humanoid-002', 1_100)
        taskState(request, 'reporting', 'humanoid-002', 1_600, 'inspection_anomaly_reported')
        taskState(request, 'completed', 'humanoid-002', 2_200)
        // A real RMF fleet adapter publishes idle state continuously. Keep the
        // finite stub alive through the following gas-isolation evidence beat
        // so this assertion tests product stale-pose handling, not fixture
        // silence after the inspection completes.
        for (let delay = 1_000; delay <= 30_000; delay += 1_000) {
          robotState('humanoid-002', -74, -88, 'idle', undefined, delay)
        }
      } else if (taskId.startsWith('gas-isolation-')) {
        taskState(request, 'assigned', 'humanoid-001')
        robotState('humanoid-001', -83, -91, 'moving', taskId, 20)
        taskState(request, 'navigating', 'humanoid-001', 30)
        robotState('humanoid-001', -81.75, -69, 'idle', taskId, 650, 0)
        taskState(request, 'observing', 'humanoid-001', 700)
        workPermit(request, 950)
        taskState(request, 'interacting', 'humanoid-001', 1_050)
        actionTelemetry(request, {
          phase: 'approach', progress: 0,
          leftHandContact: false, rightHandContact: false,
          valvePosition: 0, sensorStable: false,
          handPose: measuredHandPose()
        }, 1_150)
        actionTelemetry(request, {
          phase: 'contact', progress: 0.2,
          leftHandContact: true, rightHandContact: true,
          valvePosition: 0, sensorStable: false,
          handPose: measuredHandPose(0)
        }, 2_250)
        actionTelemetry(request, {
          phase: 'turning', progress: 0.38,
          leftHandContact: true, rightHandContact: true,
          valvePosition: 0.2, sensorStable: false,
          handPose: measuredHandPose(0.2)
        }, 3_350)
        actionTelemetry(request, {
          phase: 'turning', progress: 0.56,
          leftHandContact: true, rightHandContact: true,
          valvePosition: 0.42, sensorStable: false,
          handPose: measuredHandPose(0.42)
        }, 4_450)
        actionTelemetry(request, {
          phase: 'turning', progress: 0.72,
          leftHandContact: true, rightHandContact: true,
          valvePosition: 0.65, sensorStable: false,
          handPose: measuredHandPose(0.65)
        }, 5_550)
        actionTelemetry(request, {
          phase: 'turning', progress: 0.84,
          leftHandContact: true, rightHandContact: true,
          valvePosition: 0.84, sensorStable: false,
          handPose: measuredHandPose(0.84)
        }, 6_650)
        actionTelemetry(request, {
          phase: 'monitoring', progress: 0.9,
          leftHandContact: false, rightHandContact: false,
          valvePosition: 1, gasPpm: 2.4, sensorStable: false,
          handPose: measuredHandPose()
        }, 7_750)
        actionTelemetry(request, {
          phase: 'monitoring', progress: 0.96,
          leftHandContact: false, rightHandContact: false,
          valvePosition: 1, gasPpm: 1.2, sensorStable: false,
          handPose: measuredHandPose()
        }, 8_850)
        actionTelemetry(request, {
          phase: 'verified', progress: 1,
          leftHandContact: false, rightHandContact: false,
          valvePosition: 1, gasPpm: 0.8, sensorStable: true,
          handPose: measuredHandPose()
        }, 9_950)
        for (let delay = 1_400; delay <= 11_000; delay += 1_000) {
          robotState('humanoid-001', -81.75, -69, 'idle', taskId, delay, 0)
        }
        taskState(request, 'interacting', 'humanoid-001', 10_500, 'gas_isolation_verified')
        taskState(request, 'reporting', 'humanoid-001', 11_300)
        taskState(request, 'completed', 'humanoid-001', 11_700)
        for (const delay of [12_000, 13_000, 14_000]) {
          robotState('humanoid-001', -81.75, -69, 'idle', undefined, delay, 0)
        }
      } else {
        taskState(request, 'assigned', 'humanoid-001')
        // Keep the operator-requested task active long enough to exercise the
        // integrated-showcase restart/cancellation boundary deterministically.
        taskState(request, 'completed', 'humanoid-001', 5_000)
      }
    }
    if (message.type === 'cancel_task') {
      cancelledTasks.add(message.task_id)
      cancelledTaskIds.push(message.task_id)
    }
  })
})
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString() })
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString() })

async function waitForServer() {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    try { if ((await fetch(baseUrl)).ok) return } catch { /* Vite is still booting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Vite did not start:\n${serverOutput}`)
}

async function waitForCondition(predicate, description, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${description}`)
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
  await page.goto(`${baseUrl}?rmf=ws://127.0.0.1:4188`, { waitUntil: 'domcontentloaded' })
  await page.getByText('시뮬레이션 준비 완료 — 448개체').waitFor({ timeout: 25_000 })
  assert.match((await fetch(baseUrl)).headers.get('content-security-policy') ?? '', /object-src 'none'/, 'The server must retain a restrictive baseline CSP')
  assert.equal(await page.locator('.rmf-state').getAttribute('role'), 'status', 'RMF connection changes must be exposed as status updates')
  assert.equal(await page.locator('.phase').getAttribute('aria-live'), 'assertive', 'Emergency phase changes must be announced')
  assert.equal(await page.locator('.log-feed').getAttribute('role'), 'log', 'Operational messages must expose log semantics')
  assert.equal(
    await page.evaluate(() => globalThis.performance.getEntriesByType('resource').some((entry) => /fonts\.(?:googleapis|gstatic)\.com/.test(entry.name))),
    false,
    'The HUD must not depend on third-party font requests'
  )
  await page.locator('.rmf-error').waitFor({ timeout: 5_000 })
  await page.locator('.rmf-preflight[data-preflight="blocked"]').waitFor()
  assert.equal(
    await page.locator('.fleet-board [data-authority="unavailable"]').count(),
    2,
    'A live connection without mapped poses must show NO POSE rather than local SIM authority'
  )
  const showcaseButton = page.getByRole('button', { name: /통합 시연 시작/ })
  assert.equal(await showcaseButton.isDisabled(), true, 'Live showcase must be disabled while Bridge readiness is degraded')
  await showcaseButton.evaluate((button) => button.click())
  assert.equal(dispatchedTaskIds.length, 0, 'A degraded Bridge must not receive a browser dispatch')
  if (process.env.E2E_PREFLIGHT_BLOCKED_SCREENSHOT) {
    await page.screenshot({ path: process.env.E2E_PREFLIGHT_BLOCKED_SCREENSHOT, fullPage: true })
  }
  await page.locator('.rmf-connected').waitFor({ timeout: readinessDelay + 2_000 })
  await page.locator('.rmf-preflight[data-preflight="ready"]').waitFor()
  assert.equal(await showcaseButton.isEnabled(), true, 'Live showcase must recover automatically when Bridge readiness becomes ready')
  await page.locator('.fleet-board [data-authority="rmf"]').first().waitFor({ timeout: 5_000 })
  assert.equal(await page.locator('.fleet-board .fleet-robot').count(), 2, 'The HUD must expose both operational humanoids')
  assert.equal(await page.locator('.entity-list button').count(), 30, 'HUD must expose the initial entity list')
  assert.equal(await page.locator('.entity-list button').first().textContent().then((text) => text?.includes('점검 휴머노이드')), true, 'Humanoids must be prioritized in the entity list')
  await page.keyboard.press('Tab')
  assert.notEqual(
    await page.evaluate(() => globalThis.document.activeElement?.tagName),
    'BODY',
    'Tab must move focus to an interactive control instead of being consumed by the simulation shortcut handler'
  )

  await page.getByRole('button', { name: '단일 설비 점검 태스크 요청' }).click()
  await page.locator('.task-list b').filter({ hasText: '배정' }).waitFor({ timeout: 5_000 })
  assert.equal(dispatchedRmfRequest?.request.category, 'perform_action', 'Live RMF requests must use perform_action')
  assert.equal(dispatchedRmfRequest?.request.description.category, 'inspection_round', 'Live RMF action category must preserve the humanoid purpose')
  const operatorTaskId = dispatchedRmfRequest?.request.description.fabworld_task_id

  await page.locator('.scale-row').getByRole('button', { name: '16×' }).click()
  await showcaseButton.dblclick()
  await page.locator('.task-list span').filter({ hasText: '설비 점검' }).first().waitFor({ timeout: 5_000 })
  assert.ok(cancelledTaskIds.includes(operatorTaskId), 'Showcase restart must cancel the previously active RMF task')
  assert.equal(
    dispatchedTaskIds.filter((taskId) => taskId.startsWith('showcase-inspection-')).length,
    1,
    'A rapid double click must create only one integrated showcase task chain'
  )
  await page.locator('.mission-proof.visible[data-origin="showcase-inspection"][data-origin-state="current"]').waitFor({ timeout: 5_000 })
  await page.locator('.mission-proof[data-inspection-robot="humanoid-002"]').waitFor({ timeout: 5_000 })
  assert.match(
    await page.locator('.mission-origin').textContent() ?? '',
    /H2.*설비 현장 점검.*이상 징후 판별 중/s,
    'Integrated story must expose inspection as the incident origin before the gas alarm'
  )
  const purposeCallout = page.locator('.purpose-callout').filter({ hasText: /Open-RMF|사람용|현장/ })
  await purposeCallout.waitFor({ timeout: 5_000 })
  assert.notEqual(await purposeCallout.getAttribute('data-task-kind'), 'none', 'Purpose narrative must follow an active humanoid task')
  await page.locator('.phase-detected, .phase-alarm, .phase-response, .phase-evacuation').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.task-list > div').filter({ hasText: '가스 격리' }).locator('b').filter({ hasText: /배정|이동|관찰|작업|보고/ }).waitFor({ timeout: 10_000 })
  await page.waitForFunction(() =>
    globalThis.document.querySelector('.task-list')?.textContent?.includes('가스 격리')
  )
  try {
    await waitForCondition(
      () => dispatchedRmfRequests.some((request) => request.request.description.category === 'gas_isolation'),
      'the browser gas-isolation dispatch to reach the RMF socket'
    )
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      rmf: globalThis.document.querySelector('.rmf-state')?.textContent,
      preflight: globalThis.document.querySelector('.rmf-preflight')?.textContent,
      tasks: [...globalThis.document.querySelectorAll('.task-list > div')].map((item) => item.textContent),
      logs: [...globalThis.document.querySelectorAll('.log-feed > div')].map((item) => item.textContent)
    }))
    throw new Error(`Gas dispatch missing: ${JSON.stringify({ dispatchedTaskIds, diagnostic })}`, { cause: error })
  }
  const gasRmfRequest = dispatchedRmfRequests.findLast(
    (request) => request.request.description.category === 'gas_isolation'
  )
  assert.equal(gasRmfRequest?.request.description.category, 'gas_isolation', 'Showcase must dispatch the gas action through RMF')
  assert.equal(gasRmfRequest?.request.description.target_pose.yaw, 0, 'Gas action target pose must face the valve')
  try {
    await page.getByText(/휴머노이드의 밸브 폐쇄·내장 센서 검증으로 위험원이 통제되었습니다/).waitFor({ timeout: 16_000 })
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      phase: globalThis.document.querySelector('.phase')?.textContent,
      proof: Object.fromEntries([...(globalThis.document.querySelector('.mission-proof')?.attributes ?? [])].map((attribute) => [attribute.name, attribute.value])),
      impact: Object.fromEntries([...(globalThis.document.querySelector('.mission-impact')?.attributes ?? [])].map((attribute) => [attribute.name, attribute.value])),
      tasks: [...globalThis.document.querySelectorAll('.task-list > div')].map((item) => item.textContent),
      logs: [...globalThis.document.querySelectorAll('.log-feed > div')].map((item) => item.textContent)
    }))
    await page.screenshot({ path: '/tmp/fabworld-live-workzone-timeout.png', fullPage: true })
    throw new Error(`Live gas work-zone timeout: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  await page.locator('.mission-proof[data-origin="showcase-inspection"][data-origin-state="complete"]').waitFor({ timeout: 5_000 })
  assert.match(
    await page.locator('.mission-origin').textContent() ?? '',
    /H2.*가스 이상 보고.*RMF 재조율 요청/s,
    'Integrated story must preserve the actual assigned robot and its explicit finding as the reason for RMF replanning'
  )
  await page.locator(
    '.mission-proof[data-rmf-assigned="true"][data-permit-authorized="true"][data-valve-closed="true"]' +
    '[data-sensor-verified="true"][data-action-telemetry-available="true"]' +
    '[data-action-telemetry-phase="verified"][data-hand-pose-measured="true"]'
  ).waitFor({ timeout: 5_000 })
  assert.equal(
    await page.locator('.mission-proof').getAttribute('data-inspection-robot'),
    'humanoid-002',
    'The evidence chain must retain the robot that produced the incident finding'
  )
  assert.equal(
    await page.locator('.mission-proof').getAttribute('data-gas-robot'),
    'humanoid-001',
    'The evidence chain must expose the distinct robot assigned to hazardous isolation'
  )
  assert.match(
    await page.locator('[data-proof="rmf"]').textContent() ?? '',
    /H1.*격리 배정/s,
    'The audience must see the actual Open-RMF role split rather than a generic assignment label'
  )
  assert.equal(
    await page.locator('.mission-impact').getAttribute('data-work-zone-human-entries'),
    '0',
    'The live hazardous work gate must keep people out of the valve work point'
  )
  assert.equal(
    await page.locator('.mission-impact').getAttribute('data-work-zone-robot-entries'),
    '1',
    'The assigned live humanoid must be the observed valve work-point entrant'
  )
  const currentH1Task = await page.locator('.fleet-board [data-robot-id="humanoid-001"]').getAttribute('data-task-id')
  assert.ok(
    currentH1Task === gasRmfRequest?.request.description.fabworld_task_id || currentH1Task?.startsWith('gas-continuity-'),
    'The operational fleet board must expose the current isolation or continuity RMF task authority'
  )
  assert.ok(
    dispatchedTaskIds.includes(currentH1Task),
    'The fleet-board task authority must correspond to a task actually dispatched through RMF'
  )
  // The assertion can land between the 1.5s stale-pose threshold and the
  // mock adapter's next 1s heartbeat when Chromium is under load. Require the
  // next fresh heartbeat to restore standby instead of sampling that transient.
  await page.locator('.fleet-board [data-robot-id="humanoid-002"][data-activity="standby"]').waitFor({ timeout: 3_500 })
  assert.equal(
    await page.locator('.fleet-board [data-robot-id="humanoid-002"]').getAttribute('data-activity'),
    'standby',
    'A completed live robot with fresh idle heartbeats must not appear as a contradictory safe-stop'
  )
  await page.locator('.scoreboard').waitFor()
  const drawCalls = Number(await page.locator('.stats').getAttribute('data-draw-calls'))
  assert.ok(drawCalls > 0 && drawCalls < 150, `Documented draw-call budget exceeded: ${drawCalls}`)
  if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true })

  await page.getByRole('button', { name: /에칭 베이 화재/ }).click()
  await page.locator('.phase').filter({ hasText: /화재 · (감지|경보|대응|대피)/ }).waitFor({ timeout: 10_000 })
  await page.waitForFunction(() => Number(globalThis.document.querySelector('.scoreboard')?.getAttribute('data-held-equipment')) > 0)
  await page.locator('.camera-row button.active').filter({ hasText: 'Orbit' }).waitFor()
  const fireDrawCalls = Number(await page.locator('.stats').getAttribute('data-draw-calls'))
  assert.ok(fireDrawCalls > 0 && fireDrawCalls < 150, `Fire draw-call budget exceeded: ${fireDrawCalls}`)
  if (process.env.E2E_FIRE_SCREENSHOT) {
    // The evacuation-guide baton is enabled at alarm, one deterministic tick
    // after detection. Do not capture the transient pre-alarm frame.
    await page.locator('.phase').filter({ hasText: /화재 · (경보|대응|대피)/ }).waitFor({ timeout: 5_000 })
    await page.screenshot({ path: process.env.E2E_FIRE_SCREENSHOT, fullPage: true })
  }
  if (process.env.E2E_MUSTER_SCREENSHOT) {
    await page.locator('.scale-row').getByRole('button', { name: '16×' }).click()
    await page.waitForFunction(() => {
      const scoreboard = globalThis.document.querySelector('.scoreboard')
      return Number(scoreboard?.getAttribute('data-evacuated')) === Number(scoreboard?.getAttribute('data-total-evacuees'))
    }, undefined, { timeout: 25_000 })
    await page.locator('.scale-row').getByRole('button', { name: '1×' }).click()
    await page.locator('.phase-allClear').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(100)
    await page.screenshot({ path: process.env.E2E_MUSTER_SCREENSHOT, fullPage: true })
  }

  await page.getByRole('button', { name: /응급 환자 발생/ }).click()
  await page.locator('.phase').filter({ hasText: /응급 환자 · (감지|경보|대응)/ }).waitFor({ timeout: 5_000 })
  await page.locator('.task-list span').filter({ hasText: '의료 지원' }).waitFor({ timeout: 5_000 })
  await page.waitForFunction(() => Number(globalThis.document.querySelector('.scoreboard')?.getAttribute('data-held-equipment')) === 0)
  const medicalDrawCalls = Number(await page.locator('.stats').getAttribute('data-draw-calls'))
  assert.ok(medicalDrawCalls > 0 && medicalDrawCalls < 150, `Medical draw-call budget exceeded: ${medicalDrawCalls}`)
  if (process.env.E2E_MEDICAL_SCREENSHOT) await page.screenshot({ path: process.env.E2E_MEDICAL_SCREENSHOT, fullPage: true })

  await page.getByRole('button', { name: 'Ⅱ 정지' }).click()
  await page.getByRole('button', { name: '▶ 재생' }).waitFor()
  await page.getByText('시뮬레이션 일시정지').waitFor({ timeout: 8_000 })
  await page.waitForTimeout(1_250)
  const before = await page.locator('.sim-clock').textContent()
  await page.waitForTimeout(1_250)
  assert.equal(await page.locator('.sim-clock').textContent(), before, 'Pause must freeze simulation time after the worker acknowledges it')

  await page.locator('.camera-row').getByRole('button', { name: '1인칭' }).click()
  await page.locator('.camera-row button.active').filter({ hasText: '1인칭' }).waitFor()
  await page.locator('.entity-list button').first().click()
  await page.locator('.entity-list button.active').waitFor()
  await page.locator('.camera-row button.active').filter({ hasText: 'Follow' }).waitFor()
  const canvasBounds = await page.locator('.viewport canvas').boundingBox()
  assert.ok(canvasBounds, 'The renderer canvas must be available for camera input')
  await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(canvasBounds.x + canvasBounds.width / 2 + 45, canvasBounds.y + canvasBounds.height / 2)
  await page.mouse.up()
  await page.locator('.camera-row button.active').filter({ hasText: 'Orbit' }).waitFor()
  assert.deepEqual(pageErrors, [], `Browser page errors:\n${pageErrors.join('\n')}`)

  const localPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const localPageErrors = []
  localPage.on('pageerror', (error) => localPageErrors.push(error.message))
  await localPage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await localPage.getByText('시뮬레이션 준비 완료 — 448개체').waitFor({ timeout: 25_000 })
  await localPage.locator('.scale-row').getByRole('button', { name: '16×' }).click()
  // Deliberately disturb the ambient factory state first. Loading a curated
  // scenario must restart from its own seed at presentation-safe 1× speed.
  await localPage.waitForFunction(() => {
    const match = globalThis.document.querySelector('.sim-clock')?.textContent?.match(/SIM\s+(\d+)s/)
    return Number(match?.[1] ?? 0) >= 20
  }, undefined, { timeout: 10_000 })
  await localPage.getByRole('button', { name: /응급 환자 발생/ }).click()
  await localPage.locator('.scale-row button.active').filter({ hasText: '1×' }).waitFor({ timeout: 5_000 })
  await localPage.getByText('시뮬레이션 1× 재생').waitFor({ timeout: 5_000 })
  await localPage.locator('.task-list > div').filter({ hasText: '의료 지원' }).filter({ hasText: 'humanoid-002' }).waitFor({ timeout: 10_000 })
  try {
    await localPage.waitForFunction(() =>
      globalThis.document.querySelector('.log-feed')?.textContent?.includes('응급 키트를 인계하고 처치 공간 지원')
    , undefined, { timeout: 40_000 })
  } catch (error) {
    const diagnostic = {
      phase: await localPage.locator('.phase').textContent(),
      elapsed: await localPage.locator('.scoreboard').getAttribute('data-emergency-elapsed'),
      rmf: await localPage.locator('.rmf-state').textContent(),
      tasks: await localPage.locator('.task-list').textContent(),
      logs: await localPage.locator('.log-feed').textContent()
    }
    await localPage.screenshot({ path: '/tmp/fab-world-medical-timeout.png', fullPage: true })
    throw new Error(`Local medical handoff timeout: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  await localPage.getByRole('button', { name: 'Ⅱ 정지' }).click()
  await localPage.getByRole('button', { name: '▶ 재생' }).waitFor()
  const handoffDrawCalls = Number(await localPage.locator('.stats').getAttribute('data-draw-calls'))
  assert.ok(handoffDrawCalls > 0 && handoffDrawCalls < 150, `Medical handoff draw-call budget exceeded: ${handoffDrawCalls}`)
  if (process.env.E2E_MEDICAL_HANDOFF_SCREENSHOT) {
    await localPage.screenshot({ path: process.env.E2E_MEDICAL_HANDOFF_SCREENSHOT, fullPage: true })
  }
  await localPage.getByRole('button', { name: '▶ 재생' }).click()
  if (process.env.E2E_MEDICAL_TREATMENT_SCREENSHOT) {
    await localPage.waitForFunction(() =>
      globalThis.document.querySelector('.log-feed')?.textContent?.includes('구조 인력 2인이 환자 상태를 평가')
    , undefined, { timeout: 20_000 })
    await localPage.waitForTimeout(350)
    await localPage.getByRole('button', { name: 'Ⅱ 정지' }).click()
    await localPage.getByRole('button', { name: '▶ 재생' }).waitFor()
    await localPage.screenshot({ path: process.env.E2E_MEDICAL_TREATMENT_SCREENSHOT, fullPage: true })
    await localPage.getByRole('button', { name: '▶ 재생' }).click()
  }
  await localPage.locator('.scale-row').getByRole('button', { name: '16×' }).click()
  await localPage.locator('.task-list > div').filter({ hasText: '의료 지원' }).locator('b').filter({ hasText: '완료' }).waitFor({ timeout: 15_000 })
  await localPage.locator('.scoreboard').filter({ hasText: /0 active · 1 done/ }).waitFor({ timeout: 5_000 })
  assert.deepEqual(localPageErrors, [], `Local medical browser errors:\n${localPageErrors.join('\n')}`)
  await localPage.close()

  const gasPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const gasPageErrors = []
  gasPage.on('pageerror', (error) => gasPageErrors.push(error.message))
  await gasPage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await gasPage.getByText('시뮬레이션 준비 완료 — 448개체').waitFor({ timeout: 25_000 })
  await gasPage.getByRole('button', { name: /포토 베이 가스 유출/ }).click()
  if (process.env.E2E_HUMANOID_WALK_SCREENSHOT) {
    await gasPage.locator('.task-list > div').filter({ hasText: '가스 격리' }).locator('b').filter({ hasText: '이동' }).waitFor({ timeout: 15_000 })
    await gasPage.waitForTimeout(180)
    await gasPage.screenshot({ path: process.env.E2E_HUMANOID_WALK_SCREENSHOT, fullPage: true })
  }
  // Keep the long collision-aware approach at the scenario's 1× default,
  // then slow only the short manipulation beat so the one-sim-second
  // monitoring frame remains observable on software WebGL hosts.
  await gasPage.locator('.task-list > div').filter({ hasText: '가스 격리' }).locator('b').filter({ hasText: /^작업$/ }).waitFor({ timeout: 45_000 })
  await gasPage.locator('.scale-row').getByRole('button', { name: '0.5×' }).click()
  try {
    // Metrics are batched, so the short close→verify interval is not
    // guaranteed to appear as a distinct KPI render. The causal monitoring
    // event is durable; observe the log mutation in-page and pause without an
    // automation round trip before the following verification tick.
    await gasPage.evaluate(() => new Promise((resolve, reject) => {
      const root = globalThis.document.querySelector('.log-feed')
      if (!root) { reject(new Error('operation log is unavailable')); return }
      const finish = () => {
        if (!root.textContent?.includes('내장 가스 센서가 밸브 폐쇄 후 잔류 가스 농도 하강')) return false
        const pause = [...globalThis.document.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('Ⅱ 정지'))
        if (!pause) return false
        pause.click()
        observer.disconnect()
        globalThis.clearTimeout(timeout)
        resolve(true)
        return true
      }
      const observer = new globalThis.MutationObserver(finish)
      const timeout = setTimeout(() => {
        observer.disconnect()
        reject(new Error('gas monitoring event was not observed within 60 seconds'))
      }, 60_000)
      observer.observe(root, { childList: true, subtree: true, characterData: true })
      finish()
    }))
  } catch (error) {
    const diagnostic = {
      phase: await gasPage.locator('.phase').textContent(),
      elapsed: await gasPage.locator('.scoreboard').getAttribute('data-emergency-elapsed'),
      rmf: await gasPage.locator('.rmf-state').textContent(),
      tasks: await gasPage.locator('.task-list').textContent(),
      logs: await gasPage.locator('.log-feed').textContent()
    }
    await gasPage.screenshot({ path: '/tmp/fab-world-gas-collaboration-timeout.png', fullPage: true })
    throw new Error(`Local gas collaboration timeout: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  await gasPage.getByRole('button', { name: '▶ 재생' }).waitFor()
  await gasPage.getByText(/내장 가스 센서가 밸브 폐쇄 후 잔류 가스 농도 하강을 확인/).waitFor({ timeout: 10_000 })
  await gasPage.locator('.camera-row button.active').filter({ hasText: 'Orbit' }).waitFor()
  const missionImpact = gasPage.locator('.mission-impact')
  await gasPage.waitForFunction(() =>
    globalThis.document.querySelector('.mission-impact')?.getAttribute('data-hazardous-actions') === '1'
  )
  assert.equal(await missionImpact.getAttribute('data-hazardous-actions'), '1', 'Valve closure must record one hazardous manual action delegated to the humanoid')
  assert.equal(await missionImpact.getAttribute('data-work-zone-human-entries'), '0', 'No person may enter the authorized valve work point')
  assert.equal(await missionImpact.getAttribute('data-work-zone-robot-entries'), '1', 'The humanoid must be observed inside the authorized valve work point')
  assert.equal(await missionImpact.getAttribute('data-spotter-clearance'), '0', 'No person may remain at the gas work point as a spotter')
  assert.equal(await missionImpact.getAttribute('data-verified-gates'), '0', 'The safety gate must remain unverified during post-closure monitoring')
  const gasCollaborationDrawCalls = Number(await gasPage.locator('.stats').getAttribute('data-draw-calls'))
  assert.ok(
    gasCollaborationDrawCalls > 0 && gasCollaborationDrawCalls < 150,
    `Gas collaboration draw-call budget exceeded: ${gasCollaborationDrawCalls}`
  )
  if (process.env.E2E_GAS_COLLAB_SCREENSHOT) {
    await gasPage.screenshot({ path: process.env.E2E_GAS_COLLAB_SCREENSHOT, fullPage: true })
  }
  await gasPage.getByRole('button', { name: /밸브 조작 실패 주입/ }).click()
  await gasPage.getByText(/위험원은 미통제 상태로 유지하고.*EHS 수동 대응에 인계/).waitFor({ timeout: 5_000 })
  await gasPage.locator('.task-list > div').filter({ hasText: '가스 격리' }).locator('b').filter({ hasText: '실패' }).waitFor()
  assert.equal(await missionImpact.getAttribute('data-verified-gates'), '0', 'Failure injection must not verify the isolation safety gate')
  assert.equal(await missionImpact.getAttribute('data-isolation-elapsed'), '0', 'Failure injection must not publish a successful isolation time')
  await gasPage.locator('.mission-proof.failed[data-sensor-verified="false"]').waitFor()
  await gasPage.getByRole('button', { name: '▶ 재생' }).click()
  await gasPage.locator('.scale-row').getByRole('button', { name: '4×' }).click()
  await gasPage.waitForTimeout(2_000)
  await gasPage.getByRole('button', { name: 'Ⅱ 정지' }).click()
  await gasPage.getByRole('button', { name: '▶ 재생' }).waitFor()
  assert.equal(await missionImpact.getAttribute('data-verified-gates'), '0', 'Retreat must not convert a failed isolation into success')
  assert.equal(await gasPage.locator('.phase-allClear').count(), 0, 'Failed isolation must not advance to all-clear')
  if (process.env.E2E_GAS_FAILURE_SCREENSHOT) {
    await gasPage.screenshot({ path: process.env.E2E_GAS_FAILURE_SCREENSHOT, fullPage: true })
  }
  assert.deepEqual(gasPageErrors, [], `Local gas collaboration browser errors:\n${gasPageErrors.join('\n')}`)
  await gasPage.close()

  const comparisonPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const comparisonPageErrors = []
  comparisonPage.on('pageerror', (error) => comparisonPageErrors.push(error.message))
  await comparisonPage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await comparisonPage.getByText('시뮬레이션 준비 완료 — 448개체').waitFor({ timeout: 25_000 })
  await comparisonPage.getByRole('button', { name: /위험작업 A\/B 실측/ }).click()
  await comparisonPage.locator('.scale-row').getByRole('button', { name: '4×' }).click()
  const riskComparison = comparisonPage.locator('.risk-comparison')
  await comparisonPage.locator('.risk-comparison[data-comparison-stage="human-work"][data-human-entries="1"]').waitFor({ timeout: 35_000 })
  assert.ok(
    Number(await riskComparison.getAttribute('data-human-exposure-seconds')) > 0,
    'The human baseline must integrate observed work-zone person-seconds while the responder is at the valve'
  )
  await comparisonPage.getByText(/수동 격리 밸브 손잡이에 직접 접촉했습니다/).waitFor({ timeout: 10_000 })
  await comparisonPage.getByRole('button', { name: 'Ⅱ 정지' }).click()
  await comparisonPage.getByRole('button', { name: '▶ 재생' }).waitFor()
  if (process.env.E2E_COMPARISON_HUMAN_SCREENSHOT) {
    await comparisonPage.screenshot({ path: process.env.E2E_COMPARISON_HUMAN_SCREENSHOT, fullPage: true })
  }
  await comparisonPage.getByRole('button', { name: '▶ 재생' }).click()
  await comparisonPage.locator('.scale-row').getByRole('button', { name: '16×' }).click()
  await comparisonPage.locator('.risk-comparison[data-comparison-stage="transition"][data-human-verified="true"]').waitFor({ timeout: 20_000 })
  await comparisonPage.locator('.scale-row').getByRole('button', { name: '4×' }).click()
  assert.equal(await riskComparison.getAttribute('data-human-entries'), '1', 'The direct-work baseline must record one authorized human entrant')
  assert.ok(
    Number(await riskComparison.getAttribute('data-human-exposure-seconds')) >= 8.2,
    'The direct-work baseline must include the full measured manipulation and verification exposure'
  )
  await comparisonPage.waitForFunction(() => {
    const stage = globalThis.document.querySelector('.risk-comparison')?.getAttribute('data-comparison-stage')
    return stage === 'humanoid-work' || stage === 'complete'
  }, undefined, { timeout: 30_000 })
  await comparisonPage.waitForFunction(() =>
    Number(globalThis.document.querySelector('.risk-comparison')?.getAttribute('data-humanoid-entries')) === 1
  , undefined, { timeout: 30_000 })
  await comparisonPage.getByRole('button', { name: 'Ⅱ 정지' }).click()
  await comparisonPage.getByRole('button', { name: '▶ 재생' }).waitFor()
  if (process.env.E2E_COMPARISON_ROBOT_SCREENSHOT) {
    await comparisonPage.screenshot({ path: process.env.E2E_COMPARISON_ROBOT_SCREENSHOT, fullPage: true })
  }
  await comparisonPage.getByRole('button', { name: '▶ 재생' }).click()
  await comparisonPage.locator('.scale-row').getByRole('button', { name: '16×' }).click()
  await comparisonPage.locator(
    '.risk-comparison[data-comparison-stage="complete"][data-human-verified="true"][data-humanoid-verified="true"][data-same-target="true"]'
  ).waitFor({ timeout: 20_000 })
  assert.equal(await riskComparison.getAttribute('data-human-entries'), '1', 'A/B completion must retain the observed human baseline entry')
  assert.equal(await riskComparison.getAttribute('data-humanoid-entries'), '1', 'The comparison run must observe one humanoid at the same valve')
  assert.equal(await riskComparison.getAttribute('data-humanoid-exposure-seconds'), '0', 'The humanoid run must keep human work-zone exposure at zero')
  assert.ok(
    Number(await riskComparison.getAttribute('data-avoided-exposure-seconds')) >= 8.2,
    'The A/B verdict must be computed from the two observed runs rather than a promotional estimate'
  )
  assert.ok(
    Number(await riskComparison.getAttribute('data-human-isolation-elapsed')) > 0 &&
      Number(await riskComparison.getAttribute('data-humanoid-isolation-elapsed')) > 0,
    'Both A/B arms must publish their independently observed isolation time'
  )
  const completedComparisonButton = comparisonPage.getByRole('button', { name: /A\/B 실측 완료 · 다시 실행/ })
  await completedComparisonButton.waitFor()
  assert.equal(await completedComparisonButton.isEnabled(), true, 'A completed A/B run must remain repeatable')
  if (process.env.E2E_COMPARISON_SCREENSHOT) {
    await comparisonPage.screenshot({ path: process.env.E2E_COMPARISON_SCREENSHOT, fullPage: true })
  }
  assert.deepEqual(comparisonPageErrors, [], `Risk comparison browser errors:\n${comparisonPageErrors.join('\n')}`)
  await comparisonPage.close()

  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
  const mobilePageErrors = []
  mobilePage.on('pageerror', (error) => mobilePageErrors.push(error.message))
  await mobilePage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await mobilePage.getByText('시뮬레이션 준비 완료 — 448개체').waitFor({ timeout: 25_000 })
  const mobileTapHeights = await mobilePage.locator('.controls button:visible, .scenarios button:visible').evaluateAll(
    (buttons) => buttons.map((button) => button.getBoundingClientRect().height)
  )
  assert.ok(
    mobileTapHeights.length > 0 && mobileTapHeights.every((height) => height >= 40),
    `Mobile primary controls must retain 40px touch targets: ${JSON.stringify(mobileTapHeights)}`
  )
  const mobileMissionBounds = await mobilePage.locator('.mission-panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect()
    return { left: rect.left, right: rect.right, viewportWidth: globalThis.innerWidth }
  })
  assert.ok(
    mobileMissionBounds.left >= 0 && mobileMissionBounds.right <= mobileMissionBounds.viewportWidth,
    `Mobile mission panel must remain inside the viewport: ${JSON.stringify(mobileMissionBounds)}`
  )
  assert.ok(
    Number.parseFloat(await mobilePage.locator('.proof-step small').first().evaluate((item) => globalThis.getComputedStyle(item).fontSize)) >= 7,
    'Mobile evidence labels must remain readable instead of falling back to the desktop 5px size'
  )
  await mobilePage.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await mobilePage.locator('.pulse').evaluate((item) => globalThis.getComputedStyle(item).animationIterationCount),
    '1',
    'Reduced-motion preference must suppress repeating HUD alarm animation'
  )
  if (process.env.E2E_MOBILE_SCREENSHOT) {
    await mobilePage.screenshot({ path: process.env.E2E_MOBILE_SCREENSHOT, fullPage: true })
  }
  assert.deepEqual(mobilePageErrors, [], `Mobile browser errors:\n${mobilePageErrors.join('\n')}`)
  await mobilePage.close()

  await browser.close()
  browser = undefined
  console.log(`E2E passed: RMF showcase, purpose, emergencies, pause, camera, selection, local medical handoff, robot-only gas isolation, and measured human-vs-humanoid A/B; draw calls showcase=${drawCalls}, fire=${fireDrawCalls}, medical=${medicalDrawCalls}, handoff=${handoffDrawCalls}, gas=${gasCollaborationDrawCalls}.`)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await new Promise((resolveExit) => server.once('exit', resolveExit))
  for (const client of rmfServer.clients) client.terminate()
  await new Promise((resolveClose) => rmfServer.close(resolveClose))
}
