import { afterEach, describe, expect, it, vi } from 'vitest'
import { RmfBridgeEventSchema, RmfTraceSchema, type RmfBridgeEvent } from '../src/core/schema'
import { RmfTracePlayer } from '../src/integrations/rmf/trace'
import { RmfTraceRecorder } from '../services/rmf-bridge/traceRecording'
import { taskNarrative } from '../src/ui/taskNarrative'
import { gasValveGripTarget } from '../src/core/interactionGeometry'
import { bridgeEndpointLabel } from '../src/integrations/rmf/client'

afterEach(() => vi.useRealTimers())

describe('FabWorld RMF bridge contract', () => {
  it('keeps Bridge credentials out of user-visible connection details', () => {
    const label = bridgeEndpointLabel('wss://operator:secret@bridge.example/fabworld?token=browser-secret#debug')
    expect(label).toBe('wss://bridge.example/fabworld')
    expect(label).not.toContain('secret')
    expect(bridgeEndpointLabel('not a URL')).toBe('RMF Bridge endpoint')
  })

  it('accepts a normalized authoritative robot state', () => {
    const parsed = RmfBridgeEventSchema.parse({
      type: 'robot_state',
      fleet: 'fab_humanoid_fleet',
      robot: 'humanoid-001',
      map: 'fab-L1',
      x: 1,
      y: 2,
      yaw: 0.3,
      battery: 87,
      mode: 'moving',
      taskId: 'task-1',
      timestamp: 1000
    })
    expect(parsed.type).toBe('robot_state')
  })

  it('rejects unsafe or malformed bridge state', () => {
    const parsed = RmfBridgeEventSchema.safeParse({
      type: 'robot_state',
      fleet: 'fab_humanoid_fleet',
      robot: 'humanoid-001',
      map: 'fab-L1',
      x: 1,
      y: 2,
      yaw: 0.3,
      battery: 130,
      mode: 'moving',
      timestamp: 1000
    })
    expect(parsed.success).toBe(false)
  })

  it('requires a bounded clearance for an authorized EHS work permit', () => {
    expect(RmfBridgeEventSchema.safeParse({
      type: 'work_permit',
      taskId: 'gas-task-1',
      authorized: true,
      authorizedBy: 'ehs-controller',
      timestamp: 1_000
    }).success).toBe(false)
    expect(RmfBridgeEventSchema.parse({
      type: 'work_permit',
      taskId: 'gas-task-1',
      authorized: true,
      authorizedBy: 'ehs-controller',
      clearance: 2.4,
      timestamp: 1_000
    })).toMatchObject({ authorized: true, clearance: 2.4 })
  })

  it('binds normalized interaction evidence to its task category and stage', () => {
    expect(RmfBridgeEventSchema.parse({
      type: 'task_state',
      taskId: 'inspection-1',
      category: 'inspection_round',
      status: 'reporting',
      interactionKind: 'inspection_anomaly_reported',
      timestamp: 1_000
    })).toMatchObject({ interactionKind: 'inspection_anomaly_reported' })
    expect(RmfBridgeEventSchema.safeParse({
      type: 'task_state',
      taskId: 'inspection-1',
      category: 'inspection_round',
      status: 'interacting',
      interactionKind: 'inspection_anomaly_reported',
      timestamp: 1_000
    }).success).toBe(false)
    expect(RmfBridgeEventSchema.safeParse({
      type: 'task_state',
      taskId: 'medical-1',
      category: 'medical_support',
      status: 'interacting',
      interactionKind: 'gas_isolation_verified',
      timestamp: 1_000
    }).success).toBe(false)
  })

  it('requires physically coherent gas action telemetry', () => {
    expect(RmfBridgeEventSchema.parse({
      type: 'action_telemetry',
      taskId: 'gas-1',
      category: 'gas_isolation',
      robot: 'humanoid-001',
      phase: 'turning',
      progress: 0.55,
      leftHandContact: true,
      rightHandContact: true,
      valvePosition: 0.4,
      sensorStable: false,
      handPose: {
        frame: 'base_link',
        leftPositionM: gasValveGripTarget(-1, 0.4),
        rightPositionM: gasValveGripTarget(1, 0.4)
      },
      timestamp: 1_000
    })).toMatchObject({
      phase: 'turning',
      valvePosition: 0.4,
      handPose: { frame: 'base_link' }
    })
    expect(RmfBridgeEventSchema.safeParse({
      type: 'action_telemetry',
      taskId: 'gas-1',
      category: 'gas_isolation',
      phase: 'turning',
      progress: 0.55,
      leftHandContact: true,
      rightHandContact: false,
      valvePosition: 0.4,
      sensorStable: false,
      timestamp: 1_000
    }).success).toBe(false)
    expect(RmfBridgeEventSchema.safeParse({
      type: 'action_telemetry',
      taskId: 'gas-1',
      category: 'gas_isolation',
      phase: 'turning',
      progress: 0.55,
      leftHandContact: true,
      rightHandContact: true,
      valvePosition: 0.4,
      sensorStable: false,
      handPose: {
        frame: 'base_link',
        leftPositionM: [0.05, 0.92, -0.34],
        rightPositionM: [0.05, 0.92, 0.34]
      },
      timestamp: 1_000
    }).success).toBe(false)
    expect(RmfBridgeEventSchema.safeParse({
      type: 'action_telemetry',
      taskId: 'gas-1',
      category: 'gas_isolation',
      phase: 'approach',
      progress: 0,
      leftHandContact: false,
      rightHandContact: false,
      valvePosition: 0,
      sensorStable: false,
      handPose: {
        frame: 'base_link',
        leftPositionM: [1.5, 1.48, -0.34],
        rightPositionM: [1.5, 1.48, 0.34]
      },
      timestamp: 1_000
    }).success).toBe(false)
    expect(RmfBridgeEventSchema.safeParse({
      type: 'action_telemetry',
      taskId: 'gas-1',
      category: 'gas_isolation',
      phase: 'verified',
      progress: 1,
      leftHandContact: false,
      rightHandContact: false,
      valvePosition: 0.9,
      gasPpm: 0.8,
      sensorStable: true,
      timestamp: 1_000
    }).success).toBe(false)
  })

  it('explains the humanoid value at the physical interaction stage', () => {
    expect(taskNarrative({ kind: 'gas_isolation', status: 'interacting' })).toEqual({
      stage: '물리 작업',
      value: '사람 손을 전제로 한 수동 격리 밸브를 개조 없이 조작합니다.'
    })
  })

  it('rejects an unordered or task-mismatched RMF trace', () => {
    expect(RmfTraceSchema.safeParse({
      version: '1.0',
      name: 'invalid',
      source: 'recorded',
      fleet: 'fab_humanoid_fleet',
      map: 'fab-L1',
      tasks: [{
        category: 'inspection_round',
        sourceTaskId: 'source-task',
        events: [
          {
            atMs: 100,
            event: { type: 'task_state', taskId: 'wrong-task', category: 'gas_isolation', status: 'assigned', timestamp: 100 }
          },
          {
            atMs: 50,
            event: { type: 'task_state', taskId: 'source-task', category: 'inspection_round', status: 'completed', timestamp: 50 }
          }
        ]
      }]
    }).success).toBe(false)
  })

  it('replays a validated trace on wall time while remapping task and target ids', async () => {
    vi.useFakeTimers()
    const events: RmfBridgeEvent[] = []
    const states: string[] = []
    const player = new RmfTracePlayer({
      loadTrace: () => ({
        version: '1.0',
        name: 'unit replay',
        source: 'recorded',
        fleet: 'fab_humanoid_fleet',
        map: 'fab-L1',
        tasks: [{
          category: 'inspection_round',
          sourceTaskId: 'recorded-task',
          events: [
            {
              atMs: 0,
              event: {
                type: 'task_state',
                taskId: 'recorded-task',
                category: 'inspection_round',
                status: 'assigned',
                assignedRobot: 'humanoid-001',
                targetId: 'recorded-target',
                timestamp: 0
              }
            },
            {
              atMs: 500,
              event: {
                type: 'robot_state',
                fleet: 'fab_humanoid_fleet',
                robot: 'humanoid-001',
                map: 'fab-L1',
                x: -80,
                y: -70,
                yaw: 0,
                battery: 90,
                mode: 'moving',
                taskId: 'recorded-task',
                timestamp: 500
              }
            },
            {
              atMs: 1_000,
              event: {
                type: 'task_state',
                taskId: 'recorded-task',
                category: 'inspection_round',
                status: 'completed',
                assignedRobot: 'humanoid-001',
                timestamp: 1_000
              }
            }
          ]
        }]
      }),
      onEvent: (event) => events.push(event),
      onState: (state) => states.push(state)
    })
    player.connect()
    await player.ready()
    expect(states).toContain('replay')
    expect(player.dispatchTask({
      id: 'runtime-task',
      kind: 'inspection_round',
      targetId: 'runtime-target',
      requestedBy: 'operator',
      priority: 60
    })).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ type: 'task_state', taskId: 'runtime-task', targetId: 'runtime-target' })
    expect(events[1]).toMatchObject({ type: 'robot_state', taskId: 'runtime-task' })
    expect(events[2]).toMatchObject({ type: 'task_state', taskId: 'runtime-task', status: 'completed' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(events[3]).toMatchObject({ type: 'robot_state', robot: 'humanoid-001', mode: 'idle' })
    expect(events[3]).not.toHaveProperty('taskId')
    player.disconnect()
  })

  it('builds one replay template per task category from normalized live observations', () => {
    const recorder = new RmfTraceRecorder()
    recorder.add({
      type: 'task_state',
      taskId: 'site-task-1',
      category: 'gas_isolation',
      status: 'assigned',
      assignedRobot: 'humanoid-002',
      targetId: 'site-valve',
      timestamp: 10_000
    }, 100)
    recorder.add({
      type: 'robot_state',
      fleet: 'site_fleet',
      robot: 'humanoid-002',
      map: 'L1',
      x: 1,
      y: 2,
      yaw: 0.2,
      battery: 82,
      mode: 'moving',
      taskId: 'site-task-1',
      timestamp: 10_200
    }, 350)
    recorder.add({
      type: 'work_permit',
      taskId: 'site-task-1',
      authorized: true,
      authorizedBy: 'site-ehs',
      clearance: 2.3,
      timestamp: 10_300
    }, 500)
    recorder.add({
      type: 'action_telemetry',
      taskId: 'site-task-1',
      category: 'gas_isolation',
      robot: 'humanoid-002',
      phase: 'turning',
      progress: 0.6,
      leftHandContact: true,
      rightHandContact: true,
      valvePosition: 0.5,
      sensorStable: false,
      timestamp: 10_500
    }, 700)
    recorder.add({
      type: 'task_state',
      taskId: 'site-task-1',
      category: 'gas_isolation',
      status: 'completed',
      assignedRobot: 'humanoid-002',
      timestamp: 11_000
    }, 1_100)
    expect(recorder.build({ name: 'site capture', recordedAt: '2026-07-30T00:00:00.000Z' })).toMatchObject({
      source: 'recorded',
      fleet: 'site_fleet',
      map: 'L1',
      tasks: [{
        category: 'gas_isolation',
        sourceTaskId: 'site-task-1',
        events: [{ atMs: 0 }, { atMs: 250 }, { atMs: 400 }, { atMs: 600 }, { atMs: 1_000 }]
      }]
    })
  })
})
