import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { RmfBridgeEventSchema, type RmfBridgeEvent } from '../src/core/schema'
import { BridgeConfigSchema, type BridgeConfig } from '../services/rmf-bridge/config'
import { startBridge, type RunningBridge } from '../services/rmf-bridge/server'
import type { RmfApi } from '../services/rmf-bridge/rmfWebClient'
import {
  buildRmfDispatchRequest,
  RmfEventNormalizer,
  TargetMapResolutionError,
  TargetWaypointResolutionError
} from '../services/rmf-bridge/transform'
import type { DispatchBrowserCommand } from '../services/rmf-bridge/contracts'
import { gasValveGripTarget } from '../src/core/interactionGeometry'

const browserToken = 'fabworld-test-token-0001'
const ingestToken = 'fabworld-ingest-token-0001'
const command: DispatchBrowserCommand = {
  type: 'dispatch_task',
  request: {
    category: 'perform_action',
    description: {
      category: 'medical_support',
      target_id: 'person-023',
      target_pose: { map: 'fab-L1', x: 80, y: 210, yaw: Math.PI / 2 + 0.2 },
      fabworld_task_id: 'fab-task-1'
    },
    priority: 100
  }
}
const gasCommand: DispatchBrowserCommand = {
  type: 'dispatch_task',
  request: {
    category: 'perform_action',
    description: {
      category: 'gas_isolation',
      target_id: 'gas-valve-west',
      target_pose: { map: 'fab-L1', x: 80, y: 210, yaw: Math.PI / 2 + 0.2 },
      fabworld_task_id: 'fab-gas-1'
    },
    priority: 100
  }
}
const inspectionCommand: DispatchBrowserCommand = {
  type: 'dispatch_task',
  request: {
    category: 'perform_action',
    description: {
      category: 'inspection_round',
      target_id: 'lithography-001',
      target_pose: { map: 'fab-L1', x: 80, y: 210, yaw: Math.PI / 2 + 0.2 },
      fabworld_task_id: 'fab-inspection-1'
    },
    priority: 70
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})

describe('RMF bridge exposure guards', () => {
  const exposedConfig = {
    listen: { host: '0.0.0.0', port: 4190, path: '/fabworld' },
    rmfWeb: { baseUrl: 'http://127.0.0.1:8000', fleet: 'fab_humanoid_fleet' },
    maps: { L1: { fabMap: 'fab-L1' } }
  }

  it('requires authentication and an origin allowlist on non-loopback interfaces', () => {
    expect(BridgeConfigSchema.safeParse(exposedConfig).success).toBe(false)
    expect(BridgeConfigSchema.safeParse({ ...exposedConfig, browserToken }).success).toBe(false)
    expect(BridgeConfigSchema.safeParse({
      ...exposedConfig,
      browserToken,
      allowedOrigins: ['https://fabworld.example.com']
    }).success).toBe(true)
  })

  it('keeps authentication optional for an explicitly loopback-only demo', () => {
    expect(BridgeConfigSchema.safeParse({
      ...exposedConfig,
      listen: { ...exposedConfig.listen, host: '127.0.0.1' }
    }).success).toBe(true)
  })
})

describe('RMF bridge transforms', () => {
  it('wraps a FabWorld action in the official RMF compose/go_to_place/perform_action task shape', () => {
    const config = testConfig('http://127.0.0.1:1')
    const payload = buildRmfDispatchRequest(
      command,
      'fab_humanoid_fleet',
      config.maps,
      config.navigationWaypoints,
      1_000
    )
    expect(payload).toMatchObject({
      type: 'dispatch_task_request',
      request: {
        unix_millis_request_time: 1_000,
        priority: { type: 'binary', value: 1 },
        category: 'compose',
        fleet_name: 'fab_humanoid_fleet',
        requester: 'fabworld',
        description: {
          category: 'medical_support',
          phases: [
            {
              activity: {
                category: 'go_to_place',
                description: {
                  waypoint: 'medical-rendezvous-01',
                  orientation: 0.2
                }
              }
            },
            {
              activity: {
                category: 'perform_action',
                description: {
                  category: 'medical_support',
                  description: {
                    fabworld_task_id: 'fab-task-1',
                    target_id: 'person-023',
                    target_pose: { map: 'L1', x: 10, y: 20, yaw: 0.2 },
                    navigation_waypoint: 'medical-rendezvous-01'
                  },
                  use_tool_sink: true
                }
              }
            }
          ]
        }
      }
    })
  })

  it('applies the configured map transform and infers moving versus waiting from pose deltas', () => {
    const config = testConfig('http://127.0.0.1:1')
    const normalizer = new RmfEventNormalizer(config)
    const first = normalizer.robot('fab_humanoid_fleet', 'humanoid-001', {
      status: 'working',
      unix_millis_time: 1_000,
      location: { map: 'L1', x: 10, y: 20, yaw: 0.2 },
      battery: 0.73
    }, new Map(), 1_000)
    const second = normalizer.robot('fab_humanoid_fleet', 'humanoid-001', {
      status: 'working',
      unix_millis_time: 2_000,
      location: { map: 'L1', x: 10, y: 20, yaw: 0.2 },
      battery: 0.73
    }, new Map(), 2_000)
    expect(first).toMatchObject({ type: 'robot_state', map: 'fab-L1', x: 80, y: 210, battery: 73, mode: 'moving' })
    expect(second).toMatchObject({ type: 'robot_state', mode: 'waiting' })
  })

  it('rejects a target pose when its FabWorld map has no unambiguous RMF transform', () => {
    expect(() => buildRmfDispatchRequest(command, 'fab_humanoid_fleet', {}, [], 1_000))
      .toThrow(TargetMapResolutionError)
    expect(() => buildRmfDispatchRequest(command, 'fab_humanoid_fleet', {
      L1: { fabMap: 'fab-L1', offsetX: 0, offsetZ: 0, yaw: 0, scale: 1 },
      L1_alt: { fabMap: 'fab-L1', offsetX: 1, offsetZ: 1, yaw: 0, scale: 1 }
    }, [], 1_000)).toThrow(TargetMapResolutionError)
  })

  it('rejects a target without one unambiguous nearby RMF navigation waypoint', () => {
    const config = testConfig('http://127.0.0.1:1')
    expect(() => buildRmfDispatchRequest(command, 'fab_humanoid_fleet', config.maps, [], 1_000))
      .toThrow(TargetWaypointResolutionError)
    expect(() => buildRmfDispatchRequest(command, 'fab_humanoid_fleet', config.maps, [{
      map: 'L1', waypoint: 'far-away', x: 30, y: 40, maxDistance: 2
    }], 1_000)).toThrow(TargetWaypointResolutionError)
    expect(() => buildRmfDispatchRequest(command, 'fab_humanoid_fleet', config.maps, [
      { map: 'L1', waypoint: 'left', x: 9, y: 20, maxDistance: 2 },
      { map: 'L1', waypoint: 'right', x: 11, y: 20, maxDistance: 2 }
    ], 1_000)).toThrow(TargetWaypointResolutionError)
  })
})

describe('RMF-Web to FabWorld bridge', () => {
  it('runs authenticated dispatch, state normalization, idempotency, cancellation, and readiness end to end', async () => {
    const fake = await startFakeRmfWeb()
    cleanup.push(fake.close)
    const config = testConfig(fake.baseUrl)
    const bridge = await startBridge(config)
    cleanup.push(() => bridge.close())
    const ready = await fetch(`http://127.0.0.1:${bridge.port}/readyz`)
    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toMatchObject({
      status: 'ready',
      diagnostics: { status: 'ready', robotsSeen: 1, robotsPublished: 1, unknownMaps: [] }
    })
    expect(await rejectedUpgradeStatus(bridge)).toBe(401)

    const socket = new WebSocket(`${bridge.url}?token=${browserToken}`)
    cleanup.push(async () => { if (socket.readyState < WebSocket.CLOSING) socket.close(); await waitForClose(socket) })
    await waitForOpen(socket)
    const events = collectEvents(socket)
    const invalidCommand = waitForRawMessage(socket, (value) => value.type === 'bridge_error' && value.code === 'invalid_command')
    socket.send(JSON.stringify({ type: 'dispatch_task', request: {} }))
    await expect(invalidCommand).resolves.toMatchObject({ type: 'bridge_error', code: 'invalid_command' })
    socket.send(JSON.stringify({
      type: 'subscribe',
      channels: ['robot_states', 'task_states', 'work_permits', 'action_telemetry', 'emergency']
    }))
    socket.send(JSON.stringify(command))

    const queued = await events.next((event) => event.type === 'task_state' && event.taskId === 'fab-task-1')
    expect(queued).toMatchObject({ type: 'task_state', taskId: 'fab-task-1', category: 'medical_support', status: 'queued' })
    const observing = await events.next((event) => event.type === 'task_state' && event.taskId === 'fab-task-1' && event.status === 'observing')
    expect(observing).toMatchObject({ assignedRobot: 'humanoid-001', targetId: 'person-023' })
    const robot = await events.next((event) => event.type === 'robot_state' && event.robot === 'humanoid-001' && event.taskId === 'fab-task-1')
    expect(robot).toMatchObject({ map: 'fab-L1', x: 80, y: 211, battery: 73, mode: 'moving' })

    const unauthorizedIngest = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rmf_task_id: 'rmf-booking-1', stage: 'reporting' })
    })
    expect(unauthorizedIngest.status).toBe(401)
    const handoffResponse = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        rmf_task_id: 'rmf-booking-1',
        stage: 'interacting',
        interaction_kind: 'medical_handoff',
        robot: 'humanoid-001',
        timestamp: 2_345
      })
    })
    expect(handoffResponse.status).toBe(202)
    await expect(events.next((event) => event.type === 'task_state' && event.status === 'interacting')).resolves.toMatchObject({
      taskId: 'fab-task-1',
      assignedRobot: 'humanoid-001',
      interactionKind: 'medical_handoff',
      timestamp: 2_345
    })
    const emergencyResponse = await fetch(`http://127.0.0.1:${bridge.port}/ingest/emergency`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ active: true, kind: 'gasLeak', timestamp: 3_456 })
    })
    expect(emergencyResponse.status).toBe(202)
    await expect(events.next((event) => event.type === 'emergency' && event.kind === 'gasLeak')).resolves.toMatchObject({
      active: true,
      timestamp: 3_456
    })

    socket.send(JSON.stringify(command))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(fake.dispatchCount()).toBe(1)
    socket.send(JSON.stringify({ type: 'cancel_task', task_id: 'fab-task-1' }))
    await eventually(() => fake.cancelCount() === 1)
    expect(fake.lastDispatch()).toMatchObject({
      type: 'dispatch_task_request',
      request: {
        category: 'compose',
        description: {
          phases: [
            {
              activity: {
                category: 'go_to_place',
                description: { waypoint: 'medical-rendezvous-01', orientation: 0.2 }
              }
            },
            {
              activity: {
                category: 'perform_action',
                description: {
                  description: {
                    target_pose: { map: 'L1', x: 10, y: 20, yaw: 0.2 },
                    navigation_waypoint: 'medical-rendezvous-01'
                  }
                }
              }
            }
          ]
        }
      }
    })
    expect(fake.lastCancel()).toMatchObject({ type: 'cancel_task_request', task_id: 'rmf-booking-1' })

    const mismatchedVerification = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-task-1',
        stage: 'interacting',
        interaction_kind: 'gas_isolation_verified'
      })
    })
    expect(mismatchedVerification.status).toBe(409)
    await expect(mismatchedVerification.json()).resolves.toEqual({ error: 'interaction_category_mismatch' })

    socket.send(JSON.stringify(gasCommand))
    await expect(events.next((event) => event.type === 'task_state' && event.taskId === 'fab-gas-1')).resolves.toMatchObject({
      category: 'gas_isolation',
      status: 'queued'
    })
    const permitUrl = `http://127.0.0.1:${bridge.port}/action-permits/fab-gas-1`
    expect((await fetch(permitUrl)).status).toBe(401)
    const pendingPermit = await fetch(permitUrl, {
      headers: { authorization: `Bearer ${ingestToken}` }
    })
    expect(pendingPermit.status).toBe(200)
    await expect(pendingPermit.json()).resolves.toMatchObject({
      taskId: 'fab-gas-1',
      category: 'gas_isolation',
      state: 'pending',
      authorized: false
    })
    const verificationBeforePermit = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        stage: 'interacting',
        interaction_kind: 'gas_isolation_verified',
        robot: 'humanoid-002',
        timestamp: 4_567
      })
    })
    expect(verificationBeforePermit.status).toBe(409)
    await expect(verificationBeforePermit.json()).resolves.toEqual({ error: 'work_permit_required' })
    const invalidPermit = await fetch(`http://127.0.0.1:${bridge.port}/ingest/work-permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        authorized: true,
        authorized_by: 'ehs-controller'
      })
    })
    expect(invalidPermit.status).toBe(400)
    const wrongCategoryPermit = await fetch(`http://127.0.0.1:${bridge.port}/ingest/work-permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-task-1',
        authorized: true,
        authorized_by: 'ehs-controller',
        clearance_m: 2.4
      })
    })
    expect(wrongCategoryPermit.status).toBe(409)
    await expect(wrongCategoryPermit.json()).resolves.toEqual({ error: 'work_permit_category_mismatch' })
    const earlyPermit = await fetch(`http://127.0.0.1:${bridge.port}/ingest/work-permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        authorized: true,
        authorized_by: 'ehs-controller',
        clearance_m: 2.4
      })
    })
    expect(earlyPermit.status).toBe(409)
    await expect(earlyPermit.json()).resolves.toMatchObject({
      error: 'work_permit_stage_invalid',
      requiredStage: 'observing'
    })
    const gasObserving = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        stage: 'observing',
        robot: 'humanoid-002',
        timestamp: 4_800
      })
    })
    expect(gasObserving.status).toBe(202)
    await expect(events.next((event) =>
      event.type === 'task_state' && event.taskId === 'fab-gas-1' && event.status === 'observing'
    )).resolves.toMatchObject({ assignedRobot: 'humanoid-002' })
    const authorizePermit = await fetch(`http://127.0.0.1:${bridge.port}/ingest/work-permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        rmf_task_id: 'rmf-booking-2',
        fabworld_task_id: 'fab-gas-1',
        authorized: true,
        authorized_by: 'ehs-controller',
        clearance_m: 2.4,
        person_id: 'responder-001',
        timestamp: 5_000
      })
    })
    expect(authorizePermit.status).toBe(202)
    await expect(events.next((event) =>
      event.type === 'work_permit' && event.taskId === 'fab-gas-1'
    )).resolves.toMatchObject({
      authorized: true,
      authorizedBy: 'ehs-controller',
      clearance: 2.4,
      personId: 'responder-001',
      timestamp: 5_000
    })
    const authorizedPermit = await fetch(permitUrl, {
      headers: { authorization: `Bearer ${ingestToken}` }
    })
    await expect(authorizedPermit.json()).resolves.toMatchObject({
      state: 'authorized',
      authorized: true,
      clearance: 2.4,
      authorizedBy: 'ehs-controller'
    })
    const reloadedSocket = new WebSocket(`${bridge.url}?token=${browserToken}`)
    cleanup.push(async () => {
      if (reloadedSocket.readyState < WebSocket.CLOSING) reloadedSocket.close()
      await waitForClose(reloadedSocket)
    })
    await waitForOpen(reloadedSocket)
    const reloadedEvents = collectEvents(reloadedSocket)
    reloadedSocket.send(JSON.stringify({
      type: 'subscribe',
      channels: ['task_states', 'work_permits', 'action_telemetry', 'emergency']
    }))
    await expect(reloadedEvents.next((event) =>
      event.type === 'task_state' && event.taskId === 'fab-gas-1' && event.status === 'observing'
    )).resolves.toMatchObject({
      category: 'gas_isolation',
      status: 'observing',
      assignedRobot: 'humanoid-002'
    })
    await expect(reloadedEvents.next((event) =>
      event.type === 'work_permit' && event.taskId === 'fab-gas-1'
    )).resolves.toMatchObject({
      authorized: true,
      authorizedBy: 'ehs-controller',
      clearance: 2.4,
      personId: 'responder-001',
      timestamp: 5_000
    })
    await expect(reloadedEvents.next((event) =>
      event.type === 'emergency' && event.active && event.kind === 'gasLeak'
    )).resolves.toMatchObject({ timestamp: 3_456 })
    const gasInteracting = await postIngest(bridge, 'action-stage', {
      fabworld_task_id: 'fab-gas-1',
      stage: 'interacting',
      robot: 'humanoid-002',
      timestamp: 5_100
    })
    expect(gasInteracting.status).toBe(202)
    await expect(events.next((event) =>
      event.type === 'task_state' && event.taskId === 'fab-gas-1' && event.status === 'interacting'
    )).resolves.toMatchObject({ assignedRobot: 'humanoid-002' })
    const verificationWithoutTelemetry = await postIngest(bridge, 'action-stage', {
      fabworld_task_id: 'fab-gas-1',
      stage: 'interacting',
      interaction_kind: 'gas_isolation_verified',
      robot: 'humanoid-002'
    })
    expect(verificationWithoutTelemetry.status).toBe(409)
    await expect(verificationWithoutTelemetry.json()).resolves.toEqual({
      error: 'verified_action_telemetry_required'
    })
    const invalidContact = await postIngest(bridge, 'action-telemetry', {
      fabworld_task_id: 'fab-gas-1',
      robot: 'humanoid-002',
      phase: 'turning',
      progress: 0.4,
      left_hand_contact: true,
      right_hand_contact: false,
      valve_position: 0.2,
      sensor_stable: false,
      timestamp: Date.now()
    })
    expect(invalidContact.status).toBe(400)
    const telemetryBase = Date.now() + 10
    const telemetrySamples = [
      {
        phase: 'approach',
        progress: 0,
        left_hand_contact: false,
        right_hand_contact: false,
        valve_position: 0,
        sensor_stable: false
      },
      {
        phase: 'contact',
        progress: 0.2,
        left_hand_contact: true,
        right_hand_contact: true,
        valve_position: 0,
        sensor_stable: false
      },
      {
        phase: 'turning',
        progress: 0.65,
        left_hand_contact: true,
        right_hand_contact: true,
        valve_position: 0.55,
        sensor_stable: false,
        hand_pose: {
          frame_id: 'base_link',
          left_position_m: gasValveGripTarget(-1, 0.55),
          right_position_m: gasValveGripTarget(1, 0.55)
        }
      },
      {
        phase: 'monitoring',
        progress: 0.9,
        left_hand_contact: false,
        right_hand_contact: false,
        valve_position: 1,
        gas_ppm: 2.4,
        sensor_stable: false
      },
      {
        phase: 'verified',
        progress: 1,
        left_hand_contact: false,
        right_hand_contact: false,
        valve_position: 1,
        gas_ppm: 0.8,
        sensor_stable: true
      }
    ] as const
    for (const [index, sample] of telemetrySamples.entries()) {
      const response = await postIngest(bridge, 'action-telemetry', {
        fabworld_task_id: 'fab-gas-1',
        robot: 'humanoid-002',
        ...sample,
        timestamp: telemetryBase + index
      })
      expect(response.status).toBe(202)
      if (sample.phase === 'turning') {
        await expect(events.next((event) =>
          event.type === 'action_telemetry' &&
          event.taskId === 'fab-gas-1' &&
          event.phase === 'turning'
        )).resolves.toMatchObject({
          handPose: {
            frame: 'base_link',
            leftPositionM: gasValveGripTarget(-1, 0.55),
            rightPositionM: gasValveGripTarget(1, 0.55)
          }
        })
      }
    }
    await expect(events.next((event) =>
      event.type === 'action_telemetry' && event.taskId === 'fab-gas-1' && event.phase === 'verified'
    )).resolves.toMatchObject({
      progress: 1,
      valvePosition: 1,
      gasPpm: 0.8,
      sensorStable: true
    })
    const regressiveTelemetry = await postIngest(bridge, 'action-telemetry', {
      fabworld_task_id: 'fab-gas-1',
      robot: 'humanoid-002',
      phase: 'turning',
      progress: 0.5,
      left_hand_contact: true,
      right_hand_contact: true,
      valve_position: 0.5,
      sensor_stable: false,
      timestamp: telemetryBase + 10
    })
    expect(regressiveTelemetry.status).toBe(409)
    await expect(regressiveTelemetry.json()).resolves.toEqual({
      error: 'non_monotonic_action_telemetry'
    })
    const gasVerificationTimestamp = telemetryBase + 11
    const gasVerification = await postIngest(bridge, 'action-stage', {
      fabworld_task_id: 'fab-gas-1',
      stage: 'interacting',
      interaction_kind: 'gas_isolation_verified',
      robot: 'humanoid-002',
      timestamp: gasVerificationTimestamp
    })
    expect(gasVerification.status).toBe(202)
    await expect(events.next((event) =>
      event.type === 'task_state' &&
      event.taskId === 'fab-gas-1' &&
      event.interactionKind === 'gas_isolation_verified'
    )).resolves.toMatchObject({
      category: 'gas_isolation',
      status: 'interacting',
      assignedRobot: 'humanoid-002',
      timestamp: gasVerificationTimestamp
    })
    const gasReporting = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        stage: 'reporting',
        robot: 'humanoid-002',
        timestamp: 5_250
      })
    })
    expect(gasReporting.status).toBe(202)
    await expect(events.next((event) =>
      event.type === 'task_state' && event.taskId === 'fab-gas-1' && event.status === 'reporting'
    )).resolves.toMatchObject({ timestamp: 5_250 })
    const expiredPermit = await fetch(permitUrl, {
      headers: { authorization: `Bearer ${ingestToken}` }
    })
    await expect(expiredPermit.json()).resolves.toMatchObject({ state: 'expired', authorized: false })
    const revokePermit = await fetch(`http://127.0.0.1:${bridge.port}/ingest/work-permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        authorized: false,
        authorized_by: 'ehs-controller',
        reason: 'residual gas rise',
        timestamp: 5_300
      })
    })
    expect(revokePermit.status).toBe(202)
    await expect(events.next((event) =>
      event.type === 'work_permit' && event.taskId === 'fab-gas-1' && !event.authorized
    )).resolves.toMatchObject({ reason: 'residual gas rise', timestamp: 5_300 })
    const revokedPermit = await fetch(permitUrl, {
      headers: { authorization: `Bearer ${ingestToken}` }
    })
    await expect(revokedPermit.json()).resolves.toMatchObject({ state: 'revoked', authorized: false })
    const staleRevocation = await fetch(`http://127.0.0.1:${bridge.port}/ingest/work-permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        authorized: false,
        authorized_by: 'ehs-controller',
        reason: 'duplicate stale signal',
        timestamp: 5_300
      })
    })
    expect(staleRevocation.status).toBe(409)
    await expect(staleRevocation.json()).resolves.toEqual({ error: 'stale_work_permit' })
    const mismatchedPermitIds = await fetch(`http://127.0.0.1:${bridge.port}/ingest/work-permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        rmf_task_id: 'unknown-rmf-booking',
        authorized: false,
        authorized_by: 'ehs-controller',
        timestamp: 5_400
      })
    })
    expect(mismatchedPermitIds.status).toBe(409)
    await expect(mismatchedPermitIds.json()).resolves.toEqual({ error: 'task_id_mismatch' })
    const outOfRangePermit = await fetch(`http://127.0.0.1:${bridge.port}/ingest/work-permit`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-gas-1',
        authorized: true,
        authorized_by: 'ehs-controller',
        clearance_m: 3.5,
        timestamp: 5_500
      })
    })
    expect(outOfRangePermit.status).toBe(400)
    const interactionAfterRevocation = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ fabworld_task_id: 'fab-gas-1', stage: 'interacting' })
    })
    expect(interactionAfterRevocation.status).toBe(409)
    await expect(interactionAfterRevocation.json()).resolves.toEqual({ error: 'work_permit_required' })
    expect(fake.dispatchCount()).toBe(2)
  }, 10_000)

  it('rejects an unmapped navigation target before sending anything to RMF-Web', async () => {
    const fake = await startFakeRmfWeb()
    cleanup.push(fake.close)
    const config = { ...testConfig(fake.baseUrl), navigationWaypoints: [] }
    const bridge = await startBridge(config)
    cleanup.push(() => bridge.close())
    const socket = new WebSocket(`${bridge.url}?token=${browserToken}`)
    cleanup.push(async () => { if (socket.readyState < WebSocket.CLOSING) socket.close(); await waitForClose(socket) })
    await waitForOpen(socket)
    const rejected = waitForRawMessage(socket, (value) =>
      value.type === 'bridge_error' && value.code === 'target_waypoint_unmapped'
    )
    socket.send(JSON.stringify(command))
    await expect(rejected).resolves.toMatchObject({
      type: 'bridge_error',
      code: 'target_waypoint_unmapped',
      task_id: 'fab-task-1'
    })
    expect(fake.dispatchCount()).toBe(0)
  })

  it('distinguishes a normal inspection report from explicit anomaly evidence', async () => {
    const fake = await startFakeRmfWeb()
    cleanup.push(fake.close)
    const bridge = await startBridge(testConfig(fake.baseUrl))
    cleanup.push(() => bridge.close())
    const socket = new WebSocket(`${bridge.url}?token=${browserToken}`)
    cleanup.push(async () => {
      if (socket.readyState < WebSocket.CLOSING) socket.close()
      await waitForClose(socket)
    })
    await waitForOpen(socket)
    const events = collectEvents(socket)
    socket.send(JSON.stringify({ type: 'subscribe', channels: ['task_states'] }))
    socket.send(JSON.stringify(inspectionCommand))
    await expect(events.next((event) =>
      event.type === 'task_state' && event.taskId === 'fab-inspection-1'
    )).resolves.toMatchObject({ category: 'inspection_round', status: 'queued' })

    const wrongStage = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-inspection-1',
        stage: 'interacting',
        interaction_kind: 'inspection_anomaly_reported',
        robot: 'humanoid-002'
      })
    })
    expect(wrongStage.status).toBe(400)

    const normalReport = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-inspection-1',
        stage: 'reporting',
        robot: 'humanoid-002',
        timestamp: 6_000
      })
    })
    expect(normalReport.status).toBe(202)
    await expect(events.next((event) =>
      event.type === 'task_state' &&
      event.taskId === 'fab-inspection-1' &&
      event.status === 'reporting' &&
      event.interactionKind === undefined
    )).resolves.toMatchObject({ assignedRobot: 'humanoid-002', timestamp: 6_000 })

    const anomalyReport = await fetch(`http://127.0.0.1:${bridge.port}/ingest/action-stage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ingestToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        fabworld_task_id: 'fab-inspection-1',
        stage: 'reporting',
        interaction_kind: 'inspection_anomaly_reported',
        robot: 'humanoid-002',
        timestamp: 6_100
      })
    })
    expect(anomalyReport.status).toBe(202)
    await expect(events.next((event) =>
      event.type === 'task_state' &&
      event.taskId === 'fab-inspection-1' &&
      event.interactionKind === 'inspection_anomaly_reported'
    )).resolves.toMatchObject({
      category: 'inspection_round',
      status: 'reporting',
      assignedRobot: 'humanoid-002',
      timestamp: 6_100
    })
  })

  it('rejects a reused RMF booking id instead of corrupting task correlation', async () => {
    let dispatches = 0
    const api: RmfApi = {
      getFleetState: () => Promise.resolve({ name: 'fab_humanoid_fleet', robots: {} }),
      getTaskStates: () => Promise.resolve([]),
      dispatchTask: () => {
        dispatches++
        return Promise.resolve({
          success: true as const,
          state: {
            booking: { id: 'reused-booking-id', unix_millis_request_time: Date.now() },
            category: 'compose',
            status: 'queued' as const
          }
        })
      },
      cancelTask: () => Promise.resolve(),
      getFireAlarm: () => Promise.resolve(undefined)
    }
    const bridge = await startBridge(testConfig('http://unused.local'), api)
    cleanup.push(() => bridge.close())
    const socket = new WebSocket(`${bridge.url}?token=${browserToken}`)
    cleanup.push(async () => {
      if (socket.readyState < WebSocket.CLOSING) socket.close()
      await waitForClose(socket)
    })
    await waitForOpen(socket)
    const events = collectEvents(socket)
    socket.send(JSON.stringify({ type: 'subscribe', channels: ['task_states'] }))
    socket.send(JSON.stringify(command))
    await events.next((event) => event.type === 'task_state' && event.taskId === 'fab-task-1')

    const collision = waitForRawMessage(socket, (value) =>
      value.type === 'bridge_error' && value.code === 'rmf_booking_collision'
    )
    socket.send(JSON.stringify(gasCommand))
    await expect(collision).resolves.toMatchObject({
      code: 'rmf_booking_collision',
      task_id: 'fab-gas-1'
    })
    expect(dispatches).toBe(2)
    const ready = await fetch(`http://127.0.0.1:${bridge.port}/readyz`)
    expect(ready.status).toBe(503)
    await expect(ready.json()).resolves.toMatchObject({
      diagnostics: { status: 'degraded', detail: expect.stringContaining('reused-booking-id') }
    })
  })

  it('reports not-ready while RMF-Web is unavailable without dropping liveness', async () => {
    const unavailable: RmfApi = {
      getFleetState: () => Promise.reject(new Error('offline')),
      getTaskStates: () => Promise.resolve([]),
      dispatchTask: () => Promise.reject(new Error('offline')),
      cancelTask: () => Promise.reject(new Error('offline')),
      getFireAlarm: () => Promise.resolve(undefined)
    }
    const bridge = await startBridge(testConfig('http://127.0.0.1:1'), unavailable)
    cleanup.push(() => bridge.close())
    expect((await fetch(`http://127.0.0.1:${bridge.port}/healthz`)).status).toBe(200)
    const ready = await fetch(`http://127.0.0.1:${bridge.port}/readyz`)
    expect(ready.status).toBe(503)
    await expect(ready.json()).resolves.toMatchObject({ status: 'not_ready', error: 'offline' })
  })

  it('reports an unmapped RMF level as degraded and recovers after a valid mapped pose arrives', async () => {
    let map = 'UNMAPPED'
    let dispatchCalls = 0
    const api: RmfApi = {
      getFleetState: () => Promise.resolve({
        name: 'fab_humanoid_fleet',
        robots: {
          'humanoid-001': {
            status: 'working',
            unix_millis_time: Date.now(),
            location: { map, x: 1, y: 2, yaw: 0 },
            battery: 0.8
          }
        }
      }),
      getTaskStates: () => Promise.resolve([]),
      dispatchTask: () => {
        dispatchCalls++
        return Promise.reject(new Error('readiness gate failed to block dispatch'))
      },
      cancelTask: () => Promise.resolve(),
      getFireAlarm: () => Promise.resolve(undefined)
    }
    const bridge = await startBridge(testConfig('http://unused.local'), api)
    cleanup.push(() => bridge.close())
    const degradedReady = await fetch(`http://127.0.0.1:${bridge.port}/readyz`)
    expect(degradedReady.status).toBe(503)
    await expect(degradedReady.json()).resolves.toMatchObject({
      status: 'not_ready',
      diagnostics: {
        status: 'degraded',
        robotsSeen: 1,
        robotsPublished: 0,
        unknownMaps: ['UNMAPPED']
      }
    })

    const socket = new WebSocket(`${bridge.url}?token=${browserToken}`)
    cleanup.push(async () => { if (socket.readyState < WebSocket.CLOSING) socket.close(); await waitForClose(socket) })
    await waitForOpen(socket)
    const degraded = waitForRawMessage(socket, (value) => value.type === 'bridge_status' && value.status === 'degraded')
    socket.send(JSON.stringify({ type: 'subscribe', channels: ['robot_states'] }))
    await expect(degraded).resolves.toMatchObject({ robotsPublished: 0, unknownMaps: ['UNMAPPED'] })
    const rejected = waitForRawMessage(socket, (value) =>
      value.type === 'bridge_error' && value.code === 'bridge_not_ready'
    )
    socket.send(JSON.stringify(command))
    await expect(rejected).resolves.toMatchObject({
      type: 'bridge_error',
      code: 'bridge_not_ready',
      task_id: 'fab-task-1'
    })
    expect(dispatchCalls).toBe(0)

    const recovered = waitForRawMessage(socket, (value) => value.type === 'bridge_status' && value.status === 'ready')
    map = 'L1'
    await expect(recovered).resolves.toMatchObject({ robotsSeen: 1, robotsPublished: 1, unknownMaps: [] })
    await eventuallyAsync(async () => (await fetch(`http://127.0.0.1:${bridge.port}/readyz`)).status === 200)
  })
})

function testConfig(baseUrl: string): BridgeConfig {
  return BridgeConfigSchema.parse({
    listen: { host: '127.0.0.1', port: 0, path: '/fabworld' },
    rmfWeb: { baseUrl, fleet: 'fab_humanoid_fleet', pollMs: 100, timeoutMs: 1_000 },
    browserToken,
    ingestToken,
    allowedOrigins: [],
    maps: {
      L1: { fabMap: 'fab-L1', offsetX: 100, offsetZ: 200, yaw: Math.PI / 2, scale: 1 }
    },
    navigationWaypoints: [
      { map: 'L1', waypoint: 'medical-rendezvous-01', x: 10, y: 20, maxDistance: 2 }
    ]
  })
}

async function startFakeRmfWeb(): Promise<{
  baseUrl: string
  dispatchCount(): number
  cancelCount(): number
  lastDispatch(): unknown
  lastCancel(): unknown
  close(): Promise<void>
}> {
  let dispatches = 0
  let cancels = 0
  let dispatchBody: unknown
  let cancelBody: unknown
  let robotX = 10
  const taskState = (status: 'queued' | 'underway') => ({
    booking: { id: `rmf-booking-${Math.max(1, dispatches)}`, unix_millis_request_time: 1_000 },
    category: 'compose',
    status,
    assigned_to: status === 'underway' ? { group: 'fab_humanoid_fleet', name: 'humanoid-001' } : undefined,
    active: status === 'underway' ? 1 : undefined,
    phases: status === 'underway' ? { '1': { detail: { fabworld_stage: 'observing' } } } : undefined
  })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://rmf.local')
    if (request.method === 'GET' && url.pathname === '/fleets/fab_humanoid_fleet/state') {
      return respond(response, {
        name: 'fab_humanoid_fleet',
        robots: {
          'humanoid-001': {
            name: 'humanoid-001',
            status: 'working',
            task_id: dispatches ? `rmf-booking-${dispatches}` : '',
            unix_millis_time: Date.now(),
            location: { map: 'L1', x: robotX, y: 20, yaw: 0.2 },
            battery: 0.73
          }
        }
      })
    }
    if (request.method === 'GET' && url.pathname === '/tasks') {
      // Keep the second (gas) task queued until its authenticated action-stage
      // callback so the early-permit safety assertion cannot race the poller.
      return respond(response, dispatches ? [taskState(dispatches >= 2 ? 'queued' : 'underway')] : [])
    }
    if (request.method === 'GET' && url.pathname === '/building_map/previous_fire_alarm_trigger') {
      return respond(response, { unix_millis_time: Date.now(), trigger: false })
    }
    if (request.method === 'POST' && url.pathname === '/tasks/dispatch_task') {
      dispatches++
      dispatchBody = await readJson(request)
      robotX = 11
      return respond(response, { success: true, state: taskState('queued') })
    }
    if (request.method === 'POST' && url.pathname === '/tasks/cancel_task') {
      cancels++
      cancelBody = await readJson(request)
      return respond(response, { success: true })
    }
    response.writeHead(404)
    response.end()
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake RMF-Web did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispatchCount: () => dispatches,
    cancelCount: () => cancels,
    lastDispatch: () => dispatchBody,
    lastCancel: () => cancelBody,
    close: () => closeServer(server)
  }
}

function collectEvents(socket: WebSocket): { next(predicate: (event: RmfBridgeEvent) => boolean): Promise<RmfBridgeEvent> } {
  const queue: RmfBridgeEvent[] = []
  const waiters: Array<{ predicate: (event: RmfBridgeEvent) => boolean; resolve(event: RmfBridgeEvent): void; reject(error: Error): void; timer: NodeJS.Timeout }> = []
  socket.on('message', (raw) => {
    const parsed = JSON.parse(raw.toString()) as { event?: unknown }
    if (!parsed.event) return
    const event = RmfBridgeEventSchema.parse(parsed.event)
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(event))
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      clearTimeout(waiter!.timer)
      waiter!.resolve(event)
    } else queue.push(event)
  })
  return {
    next: (predicate) => {
      const index = queue.findIndex(predicate)
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]!)
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(new Error('Timed out waiting for normalized RMF event'))
          }, 3_000)
        }
        waiters.push(waiter)
      })
    }
  }
}

function waitForRawMessage(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage)
      rejectMessage(new Error('Timed out waiting for bridge message'))
    }, 2_000)
    const onMessage = (raw: import('ws').RawData): void => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>
      if (!predicate(value)) return
      clearTimeout(timeout)
      socket.off('message', onMessage)
      resolveMessage(value)
    }
    socket.on('message', onMessage)
  })
}

async function rejectedUpgradeStatus(bridge: RunningBridge): Promise<number> {
  const socket = new WebSocket(bridge.url)
  return new Promise((resolveStatus, rejectStatus) => {
    socket.once('unexpected-response', (_request, response) => {
      resolveStatus(response.statusCode ?? 0)
      response.destroy()
      socket.terminate()
    })
    socket.once('open', () => {
      socket.close()
      rejectStatus(new Error('Unauthenticated WebSocket unexpectedly opened'))
    })
    socket.once('error', () => {
      // The status-bearing unexpected-response event is the assertion source.
    })
  })
}

function postIngest(
  bridge: RunningBridge,
  endpoint: 'action-stage' | 'action-telemetry' | 'work-permit' | 'emergency',
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`http://127.0.0.1:${bridge.port}/ingest/${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ingestToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
}

function respond(response: import('node:http').ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function readJson(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen)
    socket.once('error', rejectOpen)
  })
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolveClose) => {
    socket.once('close', resolveClose)
    setTimeout(resolveClose, 500)
  })
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Condition did not become true')
}

async function eventuallyAsync(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Async condition did not become true')
}
