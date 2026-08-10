import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { WebSocket as NodeWebSocket } from 'ws'
import { BridgeConfigSchema } from '../services/rmf-bridge/config'
import type { RmfApi } from '../services/rmf-bridge/rmfWebClient'
import { startBridge } from '../services/rmf-bridge/server'
import type { RmfDispatchResponse, RmfFleetState, RmfTaskState } from '../services/rmf-bridge/contracts'
import { gasValveGripTarget } from '../src/core/interactionGeometry'

const baseUrl = 'http://127.0.0.1:4192'
const token = 'fabworld-browser-e2e-token'
const ingestToken = 'fabworld-ehs-e2e-token'
const measuredHandPose = (manipulation?: number) => ({
  hand_pose: {
    frame_id: 'base_link' as const,
    left_position_m: manipulation === undefined
      ? [0.05, 0.92, -0.34] as [number, number, number]
      : [...gasValveGripTarget(-1, manipulation)] as [number, number, number],
    right_position_m: manipulation === undefined
      ? [0.05, 0.92, 0.34] as [number, number, number]
      : [...gasValveGripTarget(1, manipulation)] as [number, number, number]
  }
})
const fakeRmf = createBrowserE2eRmfApi()
const bridge = await startBridge(BridgeConfigSchema.parse({
  listen: { host: '127.0.0.1', port: 0, path: '/fabworld' },
  rmfWeb: { baseUrl: 'http://unused.local', fleet: 'fab_humanoid_fleet', pollMs: 100, timeoutMs: 1_000 },
  browserToken: token,
  ingestToken,
  allowedOrigins: [],
  maps: { 'fab-L1': { fabMap: 'fab-L1', offsetX: 0, offsetZ: 0, yaw: 0, scale: 1 } },
  navigationWaypoints: [
    { map: 'fab-L1', waypoint: 'demo-fab-wide-access', x: 0, y: 0, maxDistance: 300 }
  ]
}), fakeRmf)
let bridgeOpen = true
const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4192', '--strictPort'], { stdio: 'pipe' })
let viteOutput = ''
vite.stdout.on('data', (chunk) => { viteOutput += chunk.toString() })
vite.stderr.on('data', (chunk) => { viteOutput += chunk.toString() })
let browser

try {
  await waitForServer()
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
    headless: true,
    args: ['--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const appUrl = new URL(baseUrl)
  appUrl.searchParams.set('rmf', `${bridge.url}?token=${token}`)
  await page.goto(appUrl.toString(), { waitUntil: 'domcontentloaded' })
  await page.getByText('시뮬레이션 준비 완료 — 448개체').waitFor({ timeout: 25_000 })
  await page.locator('.rmf-connected').waitFor({ timeout: 5_000 })
  const preflight = page.locator('.rmf-preflight[data-preflight="ready"]')
  await preflight.waitFor({ timeout: 5_000 })
  assert.match(await preflight.textContent() ?? '', /LIVE READY.*1\/1 robot.*map 정상.*pose.*poll/s)

  await page.getByRole('button', { name: '단일 설비 점검 태스크 요청' }).click()
  await page.locator('.task-list span').filter({ hasText: '설비 점검' }).waitFor({ timeout: 5_000 })
  await page.locator('.task-list b').filter({ hasText: /관찰|작업|보고|완료/ }).waitFor({ timeout: 5_000 })
  assert.deepEqual(fakeRmf.lastDispatch?.request.category, 'compose')
  assert.deepEqual(
    fakeRmf.lastDispatch?.request.description.phases[0].activity.category,
    'go_to_place'
  )
  assert.deepEqual(
    fakeRmf.lastDispatch?.request.description.phases[0].activity.description.waypoint,
    'demo-fab-wide-access'
  )
  const actionPhase = fakeRmf.lastDispatch?.request.description.phases.find((phase) => phase.activity.category === 'perform_action')
  assert.deepEqual(
    actionPhase?.activity.description.category,
    'inspection_round'
  )
  const actionTarget = actionPhase?.activity.description.description
  assert.ok(actionTarget?.target_id, 'Resolved inspection target id was not sent to RMF')
  assert.equal(actionTarget?.target_pose?.map, 'fab-L1')
  assert.ok(Number.isFinite(actionTarget?.target_pose?.x) && Number.isFinite(actionTarget?.target_pose?.y))

  await page.locator('.scale-row').getByRole('button', { name: '16×' }).click()
  await page.waitForTimeout(1_200)
  const emergencyResponse = await fetch(`http://127.0.0.1:${bridge.port}/ingest/emergency`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ingestToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ active: true, kind: 'gasLeak' })
  })
  assert.equal(emergencyResponse.status, 202)
  await page.getByText(/가스 유출 · 감지|가스 유출 · 경보|가스 유출 · 대응|가스 유출 · 대피/).waitFor({ timeout: 5_000 })
  await page.locator('.task-list span').filter({ hasText: '가스 격리' }).waitFor({ timeout: 5_000 })
  await page.locator('.task-list b').filter({ hasText: '관찰' }).waitFor({ timeout: 5_000 })
  await page.locator('.mission-proof[data-rmf-assigned="true"][data-permit-authorized="false"]').waitFor({ timeout: 5_000 })
  const gasTaskId = fakeRmf.lastFabworldTaskId()
  assert.ok(gasTaskId, 'Gas dispatch did not preserve fabworld_task_id')
  const permitUrl = `http://127.0.0.1:${bridge.port}/ingest/work-permit`
  const unauthorizedPermit = await fetch(permitUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fabworld_task_id: gasTaskId,
      authorized: true,
      authorized_by: 'site-ehs',
      clearance_m: 2.4
    })
  })
  assert.equal(unauthorizedPermit.status, 401)
  const permit = await fetch(permitUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ingestToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      fabworld_task_id: gasTaskId,
      authorized: true,
      authorized_by: 'site-ehs',
      clearance_m: 2.4
    })
  })
  assert.equal(permit.status, 202)
  try {
    await page.locator('.mission-proof[data-permit-authorized="true"]').waitFor({ timeout: 12_000 })
  } catch (error) {
    const proof = page.locator('.mission-proof')
    const diagnostic = {
      phase: await page.locator('.phase').textContent(),
      proof: {
        rmfAssigned: await proof.getAttribute('data-rmf-assigned'),
        permitAuthorized: await proof.getAttribute('data-permit-authorized'),
        workZoneClear: await proof.getAttribute('data-work-zone-clear'),
        workZonePeople: await proof.getAttribute('data-work-zone-people')
      },
      tasks: await page.locator('.task-list > div').allTextContents(),
      logs: await page.locator('.log-feed > div').allTextContents()
    }
    await page.screenshot({ path: '/tmp/fabworld-bridge-workzone-timeout.png', fullPage: true })
    throw new Error(`Bridge work-zone timeout: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  await page.locator('.proof-step[data-proof="permit"].complete').waitFor({ timeout: 5_000 })
  const executorPermit = await fetch(`http://127.0.0.1:${bridge.port}/action-permits/${gasTaskId}`, {
    headers: { authorization: `Bearer ${ingestToken}` }
  })
  const executorPermitBody = await executorPermit.json() as Record<string, unknown>
  assert.deepEqual(
    {
      taskId: executorPermitBody.taskId,
      rmfTaskId: executorPermitBody.rmfTaskId,
      category: executorPermitBody.category,
      state: executorPermitBody.state,
      authorized: executorPermitBody.authorized,
      authorizedBy: executorPermitBody.authorizedBy,
      clearance: executorPermitBody.clearance
    },
    {
      taskId: gasTaskId,
      rmfTaskId: 'rmf-e2e-booking-2',
      category: 'gas_isolation',
      state: 'authorized',
      authorized: true,
      authorizedBy: 'site-ehs',
      clearance: 2.4
    }
  )
  assert.equal(typeof executorPermitBody.timestamp, 'number')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.hud').waitFor({ timeout: 25_000 })
  await page.locator('.rmf-connected').waitFor({ timeout: 5_000 })
  await page.locator('.scale-row').getByRole('button', { name: '16×' }).click()
  await page.locator('.task-list span').filter({ hasText: '가스 격리' }).waitFor({ timeout: 5_000 })
  await page.locator('.task-list b').filter({ hasText: '관찰' }).waitFor({ timeout: 5_000 })
  await page.getByText(/가스 유출 · 감지|가스 유출 · 경보|가스 유출 · 대응|가스 유출 · 대피/).waitFor({ timeout: 5_000 })
  await page.locator('.mission-proof[data-rmf-assigned="true"][data-permit-authorized="true"]').waitFor({ timeout: 12_000 })
  assert.equal(await page.locator('.proof-step.complete').count(), 2, 'Reload must restore emergency, RMF assignment, and EHS permit evidence')
  fakeRmf.releaseGasInteraction()
  await page.locator('.task-list b').filter({ hasText: '작업' }).waitFor({ timeout: 5_000 })
  const telemetryBase = Date.now()
  const telemetrySamples = [
    {
      phase: 'approach',
      progress: 0,
      left_hand_contact: false,
      right_hand_contact: false,
      valve_position: 0,
      sensor_stable: false,
      ...measuredHandPose()
    },
    {
      phase: 'contact',
      progress: 0.2,
      left_hand_contact: true,
      right_hand_contact: true,
      valve_position: 0,
      sensor_stable: false,
      ...measuredHandPose(0)
    },
    {
      phase: 'turning',
      progress: 0.65,
      left_hand_contact: true,
      right_hand_contact: true,
      valve_position: 0.55,
      sensor_stable: false,
      ...measuredHandPose(0.55)
    },
    {
      phase: 'monitoring',
      progress: 0.9,
      left_hand_contact: false,
      right_hand_contact: false,
      valve_position: 1,
      gas_ppm: 2.4,
      sensor_stable: false,
      ...measuredHandPose()
    },
    {
      phase: 'verified',
      progress: 1,
      left_hand_contact: false,
      right_hand_contact: false,
      valve_position: 1,
      gas_ppm: 0.8,
      sensor_stable: true,
      ...measuredHandPose()
    }
  ] as const
  for (const [index, sample] of telemetrySamples.entries()) {
    const telemetry = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-telemetry`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: gasTaskId,
        robot: 'humanoid-001',
        ...sample,
        timestamp: telemetryBase + index
      })
    })
    const telemetryBody = await telemetry.json() as Record<string, unknown>
    assert.equal(
      telemetry.status,
      202,
      `Action telemetry ${sample.phase} was rejected: ${JSON.stringify(telemetryBody)}`
    )
    await page.waitForTimeout(120)
    if (index === 2 && process.env.E2E_ACTION_TELEMETRY_SCREENSHOT) {
      await page.locator(
        '.mission-proof[data-action-telemetry-fresh="true"][data-action-telemetry-phase="turning"]' +
        '[data-hand-pose-measured="true"]' +
        '[data-valve-position="0.55"]'
      ).waitFor({ timeout: 5_000 })
      await page.screenshot({ path: process.env.E2E_ACTION_TELEMETRY_SCREENSHOT, fullPage: true })
    }
    if (index === 2) {
      await page.waitForTimeout(1_650)
      await page.locator(
        '.mission-proof[data-action-telemetry-available="true"][data-action-telemetry-fresh="false"]'
      ).waitFor({ timeout: 3_000 })
      await page.locator(
        '.fleet-board [data-robot-id="humanoid-001"][data-activity="safeStop"]'
      ).waitFor({ timeout: 3_000 })
    }
  }
  await page.locator(
    '.mission-proof[data-action-telemetry-fresh="true"][data-action-telemetry-phase="verified"]' +
    '[data-valve-position="1"][data-hand-pose-measured="true"]'
  ).waitFor({ timeout: 5_000 })
  const verified = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ingestToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      fabworld_task_id: gasTaskId,
      stage: 'interacting',
      interaction_kind: 'gas_isolation_verified',
      robot: 'humanoid-001',
      timestamp: telemetryBase + telemetrySamples.length
    })
  })
  assert.equal(verified.status, 202)
  await page.locator('.mission-impact[data-verified-gates="1"]').waitFor({ timeout: 5_000 })
  await page.locator('.mission-proof[data-valve-contact="true"][data-valve-closed="true"][data-sensor-verified="true"]').waitFor({ timeout: 5_000 })
  assert.equal(await page.locator('.proof-step.complete').count(), 4, 'All four mission evidence gates must be complete')
  await page.locator('.task-list > div').filter({ hasText: '가스 격리' }).locator('b').filter({ hasText: '완료' }).waitFor({ timeout: 5_000 })
  const authoritySnapshot = await readAuthoritySnapshot(`${bridge.url}?token=${token}`)
  const gasTaskSnapshot = authoritySnapshot.filter((event) =>
    event.type === 'task_state' && event.taskId === gasTaskId
  )
  assert.ok(gasTaskSnapshot.length >= 3, 'Authority snapshot must retain the gas task lifecycle')
  assert.ok(
    gasTaskSnapshot.every((event) => event.snapshot === true),
    `Every restored task event must be marked as a snapshot: ${JSON.stringify(gasTaskSnapshot)}`
  )
  assert.equal(gasTaskSnapshot.at(-1)?.status, 'completed', 'Authority snapshot must end in the terminal task state')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.hud').waitFor({ timeout: 25_000 })
  await page.locator('.rmf-connected').waitFor({ timeout: 5_000 })
  await page.locator('.task-list span').filter({ hasText: '가스 격리' }).waitFor({ timeout: 5_000 })
  await page.locator('.task-list > div').filter({ hasText: '가스 격리' }).locator('b').filter({ hasText: '완료' }).waitFor({ timeout: 5_000 })
  await page.getByText(/가스 유출 · 감지|가스 유출 · 경보|가스 유출 · 대응|가스 유출 · 대피/).waitFor({ timeout: 5_000 })
  await page.locator('.mission-proof[data-valve-contact="true"][data-valve-closed="true"][data-sensor-verified="true"]').waitFor({ timeout: 5_000 })
  assert.equal(await page.locator('.proof-step.complete').count(), 4, 'Terminal reload must preserve all four evidence gates')
  const restoredTaskLogs = await page.locator('.log-feed > div').filter({ hasText: gasTaskId }).allTextContents()
  assert.equal(
    restoredTaskLogs.length,
    0,
    `Snapshot restoration must not replay historical task logs as new activity: ${JSON.stringify(restoredTaskLogs)}`
  )
  if (process.env.E2E_RMF_PERMIT_SCREENSHOT) {
    await page.screenshot({ path: process.env.E2E_RMF_PERMIT_SCREENSHOT, fullPage: true })
  }

  await bridge.close()
  bridgeOpen = false
  await page.locator('.rmf-disconnected, .rmf-error').waitFor({ timeout: 5_000 })
  await page.getByText(/외부 제어 휴머노이드를 안전 정지했습니다/).waitFor({ timeout: 5_000 })
  assert.deepEqual(pageErrors, [])
  console.log('RMF Bridge browser E2E passed: compose dispatch, EHS permit, executor telemetry, reload recovery, verified gas isolation, and disconnect safe-stop.')
} finally {
  await browser?.close()
  if (bridgeOpen) await bridge.close()
  vite.kill('SIGTERM')
  await new Promise<void>((resolveExit) => vite.once('exit', () => resolveExit()))
}

function createBrowserE2eRmfApi(): RmfApi & {
  lastFabworldTaskId(): string | undefined
  releaseGasInteraction(): void
  lastDispatch?: {
    request: {
      category: string
      description: {
        phases: Array<{
          activity: {
            category: string
            description: {
              waypoint?: string | number
              category: string
              description: {
                target_id?: string
                target_pose?: { map: string; x: number; y: number }
                navigation_waypoint?: string | number
                fabworld_task_id?: string
              }
            }
          }
        }>
      }
    }
  }
} {
  let dispatchedAt: number | undefined
  let dispatchedCategory: string | undefined
  let fabworldTaskId: string | undefined
  let dispatchSequence = 0
  let bookingId: string | undefined
  let targetPose: { x: number; y: number } | undefined
  let gasInteractionReleased = false
  let gasInteractionReleasedAt: number | undefined
  const taskState = (forcedStatus?: 'queued'): RmfTaskState => {
    const elapsed = dispatchedAt ? Date.now() - dispatchedAt : 0
    const gasElapsed = gasInteractionReleasedAt ? Date.now() - gasInteractionReleasedAt : 0
    const stage = dispatchedCategory === 'gas_isolation'
      ? !gasInteractionReleased
        ? 'observing'
        : gasElapsed < 5_500 ? 'interacting' : gasElapsed < 6_000 ? 'reporting' : 'completed'
      : elapsed < 350 ? 'observing' : elapsed < 700 ? 'interacting' : elapsed < 1_050 ? 'reporting' : 'completed'
    const completed = stage === 'completed'
    return {
      booking: { id: bookingId ?? 'rmf-e2e-booking-0', unix_millis_request_time: dispatchedAt ?? Date.now() },
      category: 'compose',
      status: forcedStatus ?? (completed ? 'completed' : 'underway'),
      assigned_to: forcedStatus ? undefined : { group: 'fab_humanoid_fleet', name: 'humanoid-001' },
      active: forcedStatus ? undefined : 1,
      phases: forcedStatus ? undefined : { '1': { detail: { fabworld_stage: stage } } },
      ...(completed ? { unix_millis_finish_time: Date.now() } : { unix_millis_start_time: dispatchedAt })
    }
  }
  const api: RmfApi & {
    lastDispatch?: ReturnType<typeof dispatchShape>
    lastFabworldTaskId(): string | undefined
    releaseGasInteraction(): void
  } = {
    getFleetState: (): Promise<RmfFleetState> => {
      const elapsed = dispatchedAt ? Date.now() - dispatchedAt : 0
      const travel = dispatchedAt ? Math.min(1, elapsed / 800) : 0
      const targetX = targetPose?.x ?? -96
      const targetY = targetPose?.y ?? -106
      return Promise.resolve({
        name: 'fab_humanoid_fleet',
        robots: {
          'humanoid-001': {
            name: 'humanoid-001',
            status: dispatchedAt ? 'working' : 'idle',
            task_id: dispatchedAt ? bookingId ?? '' : '',
            unix_millis_time: Date.now(),
            location: {
              map: 'fab-L1',
              x: -96 + (targetX + 96) * travel,
              y: -106 + (targetY + 106) * travel,
              yaw: 0.2
            },
            battery: 0.88
          }
        }
      })
    },
    getTaskStates: (): Promise<RmfTaskState[]> => Promise.resolve(dispatchedAt ? [taskState()] : []),
    dispatchTask: (payload: Record<string, unknown>): Promise<RmfDispatchResponse> => {
      api.lastDispatch = dispatchShape(payload)
      const action = api.lastDispatch.request.description.phases.find((phase) => phase.activity.category === 'perform_action')
      const nextCategory = action?.activity.description.category
      const nextFabworldTaskId = action?.activity.description.description.fabworld_task_id
      dispatchSequence++
      const nextBookingId = `rmf-e2e-booking-${dispatchSequence}`
      // The product deliberately starts a lower-priority continuity inspection
      // alongside gas isolation. This single-robot fake keeps that request queued
      // so it cannot overwrite the hazardous task whose permit gates are under test.
      if (nextFabworldTaskId?.startsWith('gas-continuity-')) {
        return Promise.resolve({
          success: true,
          state: {
            booking: { id: nextBookingId, unix_millis_request_time: Date.now() },
            category: 'compose',
            status: 'queued'
          }
        })
      }
      dispatchedCategory = nextCategory
      fabworldTaskId = nextFabworldTaskId
      targetPose = action?.activity.description.description.target_pose
      bookingId = nextBookingId
      gasInteractionReleased = false
      gasInteractionReleasedAt = undefined
      dispatchedAt = Date.now()
      return Promise.resolve({ success: true, state: taskState('queued') })
    },
    cancelTask: (): Promise<void> => Promise.resolve(),
    getFireAlarm: (): Promise<{ unix_millis_time: number; trigger: boolean }> => Promise.resolve({ unix_millis_time: Date.now(), trigger: false }),
    lastFabworldTaskId: (): string | undefined => fabworldTaskId,
    releaseGasInteraction: (): void => {
      gasInteractionReleased = true
      gasInteractionReleasedAt = Date.now()
    }
  }
  return api
}

function dispatchShape(payload: Record<string, unknown>): {
  request: {
    category: string
    description: {
      phases: Array<{
          activity: {
            category: string
            description: {
              waypoint?: string | number
              category: string
              description: {
                target_id?: string
                target_pose?: { map: string; x: number; y: number }
                navigation_waypoint?: string | number
                fabworld_task_id?: string
              }
            }
        }
      }>
    }
  }
} {
  return payload as ReturnType<typeof dispatchShape>
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(baseUrl)).ok) return
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Vite did not start:\n${viteOutput}`)
}

async function readAuthoritySnapshot(url: string): Promise<Array<Record<string, unknown>>> {
  const socket = new NodeWebSocket(url)
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen)
    socket.once('error', rejectOpen)
  })
  const events: Array<Record<string, unknown>> = []
  socket.on('message', (raw) => {
    const value = JSON.parse(raw.toString()) as { event?: Record<string, unknown> }
    if (value.event) events.push(value.event)
  })
  socket.send(JSON.stringify({
    type: 'subscribe',
    channels: ['task_states', 'work_permits', 'action_telemetry', 'emergency']
  }))
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  socket.close()
  await new Promise<void>((resolveClose) => socket.once('close', () => resolveClose()))
  return events
}
