import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  RmfTraceSchema,
  type HumanoidTaskKind,
  type HumanoidTaskStatus,
  type RmfBridgeEvent,
  type RmfTaskTrace
} from '../src/core/schema'
import { gasValveGripTarget } from '../src/core/interactionGeometry'

type Point = readonly [number, number]
interface TraceEvent { atMs: number; event: RmfBridgeEvent }

const output = resolve('data/rmf-traces/humanoid-showcase.json')
const fleet = 'fab_humanoid_fleet'
const map = 'fab-L1'
const sampleMs = 750
const speed = 1.15

const measuredHandPose = (manipulation?: number): NonNullable<
  Extract<RmfBridgeEvent, { type: 'action_telemetry' }>['handPose']
> => ({
  frame: 'base_link',
  leftPositionM: manipulation === undefined
    ? [0.05, 0.92, -0.34]
    : [...gasValveGripTarget(-1, manipulation)] as [number, number, number],
  rightPositionM: manipulation === undefined
    ? [0.05, 0.92, 0.34]
    : [...gasValveGripTarget(1, manipulation)] as [number, number, number]
})

const trace = RmfTraceSchema.parse({
  version: '1.0',
  name: 'FabWorld purpose showcase reference',
  source: 'reference',
  recordedAt: '2026-07-30T00:00:00.000Z',
  fleet,
  map,
  tasks: [
    createTaskTrace({
      category: 'inspection_round',
      sourceTaskId: 'reference-inspection',
      robot: 'humanoid-001',
      battery: 94,
      path: [[-86, -97.5], [-81, -97.5], [-82.7, -87.5], [-82.7, -85.1]],
      workYaw: -Math.PI / 2,
      interactionMs: 4_000
    }),
    createTaskTrace({
      category: 'gas_isolation',
      sourceTaskId: 'reference-gas-isolation',
      robot: 'humanoid-002',
      battery: 91,
      path: [[-86, -70.5], [-86, -69], [-81.75, -69]],
      workYaw: 0,
      interactionMs: 7_000
    })
  ]
})

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(trace, null, 2)}\n`)
console.log(`Created ${output} with ${trace.tasks.reduce((sum, task) => sum + task.events.length, 0)} normalized RMF events.`)

function createTaskTrace(input: {
  category: HumanoidTaskKind
  sourceTaskId: string
  robot: string
  battery: number
  path: Point[]
  workYaw: number
  interactionMs: number
}): RmfTaskTrace {
  const entries: TraceEvent[] = []
  const taskState = (
    atMs: number,
    status: HumanoidTaskStatus,
    interactionKind?: 'inspection_anomaly_reported' | 'gas_isolation_verified'
  ): void => {
    entries.push({
      atMs,
      event: {
        type: 'task_state',
        taskId: input.sourceTaskId,
        category: input.category,
        status,
        assignedRobot: input.robot,
        ...(interactionKind ? { interactionKind } : {}),
        timestamp: atMs
      }
    })
  }
  const robotState = (atMs: number, point: Point, yaw: number, mode: 'moving' | 'waiting', withTask = true): void => {
    entries.push({
      atMs,
      event: {
        type: 'robot_state',
        fleet,
        robot: input.robot,
        map,
        x: round(point[0]),
        y: round(point[1]),
        yaw: round(yaw),
        battery: input.battery,
        mode,
        ...(withTask ? { taskId: input.sourceTaskId } : {}),
        timestamp: atMs
      }
    })
  }
  const workPermit = (atMs: number): void => {
    entries.push({
      atMs,
      event: {
        type: 'work_permit',
        taskId: input.sourceTaskId,
        authorized: true,
        authorizedBy: 'reference-ehs-controller',
        clearance: 2.25,
        timestamp: atMs
      }
    })
  }
  const actionTelemetry = (
    atMs: number,
    sample: Omit<Extract<RmfBridgeEvent, { type: 'action_telemetry' }>, 'type' | 'taskId' | 'category' | 'robot' | 'timestamp'>
  ): void => {
    entries.push({
      atMs,
      event: {
        type: 'action_telemetry',
        taskId: input.sourceTaskId,
        category: 'gas_isolation',
        robot: input.robot,
        ...sample,
        timestamp: atMs
      }
    })
  }

  taskState(0, 'assigned')
  robotState(0, input.path[0]!, segmentYaw(input.path[0]!, input.path[1]!), 'waiting')
  taskState(250, 'navigating')
  let cursor = addMotion(entries, input, input.path, 250)
  const workYaw = input.workYaw
  cursor += 100
  robotState(cursor, input.path.at(-1)!, workYaw, 'waiting')
  taskState(cursor + 250, 'observing')
  addStationaryHeartbeats(entries, input, input.path.at(-1)!, workYaw, cursor + sampleMs, cursor + 2_750)
  if (input.category === 'gas_isolation') workPermit(cursor + 2_800)
  taskState(cursor + 3_000, 'interacting')
  addStationaryHeartbeats(entries, input, input.path.at(-1)!, workYaw, cursor + 3_000, cursor + 3_000 + input.interactionMs)
  if (input.category === 'gas_isolation') {
    actionTelemetry(cursor + 3_100, {
      phase: 'approach',
      progress: 0,
      leftHandContact: false,
      rightHandContact: false,
      valvePosition: 0,
      sensorStable: false,
      handPose: measuredHandPose()
    })
    actionTelemetry(cursor + 4_200, {
      phase: 'contact',
      progress: 0.2,
      leftHandContact: true,
      rightHandContact: true,
      valvePosition: 0,
      sensorStable: false,
      handPose: measuredHandPose(0)
    })
    actionTelemetry(cursor + 5_300, {
      phase: 'turning',
      progress: 0.4,
      leftHandContact: true,
      rightHandContact: true,
      valvePosition: 0.2,
      sensorStable: false,
      handPose: measuredHandPose(0.2)
    })
    actionTelemetry(cursor + 6_200, {
      phase: 'turning',
      progress: 0.65,
      leftHandContact: true,
      rightHandContact: true,
      valvePosition: 0.55,
      sensorStable: false,
      handPose: measuredHandPose(0.55)
    })
    actionTelemetry(cursor + 7_300, {
      phase: 'turning',
      progress: 0.82,
      leftHandContact: true,
      rightHandContact: true,
      valvePosition: 0.82,
      sensorStable: false,
      handPose: measuredHandPose(0.82)
    })
    actionTelemetry(cursor + 8_200, {
      phase: 'monitoring',
      progress: 0.9,
      leftHandContact: false,
      rightHandContact: false,
      valvePosition: 1,
      gasPpm: 2.4,
      sensorStable: false,
      handPose: measuredHandPose()
    })
    actionTelemetry(cursor + 9_100, {
      phase: 'verified',
      progress: 1,
      leftHandContact: false,
      rightHandContact: false,
      valvePosition: 1,
      gasPpm: 0.8,
      sensorStable: true,
      handPose: measuredHandPose()
    })
    taskState(cursor + 3_000 + 6_200, 'interacting', 'gas_isolation_verified')
  }
  cursor += 3_000 + input.interactionMs
  taskState(
    cursor,
    'reporting',
    input.category === 'inspection_round' ? 'inspection_anomaly_reported' : undefined
  )
  addStationaryHeartbeats(entries, input, input.path.at(-1)!, workYaw, cursor, cursor + 2_250)
  cursor += 2_500
  taskState(cursor, 'returning')
  cursor = addMotion(entries, input, [...input.path].reverse(), cursor)
  robotState(cursor, input.path[0]!, segmentYaw(input.path[1]!, input.path[0]!), 'waiting')
  taskState(cursor + 250, 'completed')
  robotState(cursor + 250, input.path[0]!, segmentYaw(input.path[1]!, input.path[0]!), 'waiting', false)

  entries.sort((left, right) => left.atMs - right.atMs || eventOrder(left.event) - eventOrder(right.event))
  return { category: input.category, sourceTaskId: input.sourceTaskId, events: entries }
}

function addMotion(
  entries: TraceEvent[],
  input: { sourceTaskId: string; robot: string; battery: number },
  path: Point[],
  startAt: number
): number {
  let cursor = startAt
  for (let segment = 1; segment < path.length; segment++) {
    const from = path[segment - 1]!
    const to = path[segment]!
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1])
    const duration = distance / speed * 1_000
    const yaw = segmentYaw(from, to)
    for (let elapsed = 0; elapsed < duration; elapsed += sampleMs) {
      const sampleElapsed = Math.min(duration, elapsed + sampleMs)
      const alpha = sampleElapsed / duration
      entries.push({
        atMs: Math.round(cursor + sampleElapsed),
        event: {
          type: 'robot_state',
          fleet,
          robot: input.robot,
          map,
          x: round(from[0] + (to[0] - from[0]) * alpha),
          y: round(from[1] + (to[1] - from[1]) * alpha),
          yaw: round(yaw),
          battery: input.battery,
          mode: 'moving',
          taskId: input.sourceTaskId,
          timestamp: Math.round(cursor + sampleElapsed)
        }
      })
    }
    cursor += duration
  }
  return Math.round(cursor)
}

function addStationaryHeartbeats(
  entries: TraceEvent[],
  input: { sourceTaskId: string; robot: string; battery: number },
  point: Point,
  yaw: number,
  startAt: number,
  endAt: number
): void {
  for (let atMs = startAt; atMs <= endAt; atMs += sampleMs) {
    entries.push({
      atMs,
      event: {
        type: 'robot_state',
        fleet,
        robot: input.robot,
        map,
        x: point[0],
        y: point[1],
        yaw: round(yaw),
        battery: input.battery,
        mode: 'waiting',
        taskId: input.sourceTaskId,
        timestamp: atMs
      }
    })
  }
}

function segmentYaw(from: Point, to: Point): number {
  return Math.atan2(to[1] - from[1], to[0] - from[0])
}

function eventOrder(event: RmfBridgeEvent): number {
  return event.type === 'task_state'
    ? 0
    : event.type === 'action_telemetry'
      ? 1
      : event.type === 'robot_state'
        ? 2
        : 3
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000
}
