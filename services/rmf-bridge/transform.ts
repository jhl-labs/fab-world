import type { HumanoidTaskKind, HumanoidTaskStatus, RmfBridgeEvent } from '../../src/core/schema'
import type { BridgeConfig } from './config'
import type { DispatchBrowserCommand, RmfRobotState, RmfTaskState } from './contracts'

interface TrackedTask {
  fabworldId: string
  rmfId: string
  category: HumanoidTaskKind
  targetId?: string
}

interface PreviousPose {
  x: number
  y: number
  timestamp: number
}

const terminalStatuses = new Set(['completed', 'failed', 'canceled', 'killed'])
const fabworldStages = new Set<HumanoidTaskStatus>([
  'queued', 'assigned', 'navigating', 'observing', 'interacting', 'reporting',
  'returning', 'completed', 'failed', 'cancelled'
])

export class TargetMapResolutionError extends Error {
  constructor(readonly fabMap: string, readonly matches: number) {
    super(matches === 0
      ? `FabWorld map ${fabMap} has no RMF transform`
      : `FabWorld map ${fabMap} has ${matches} RMF transforms and is ambiguous`)
    this.name = 'TargetMapResolutionError'
  }
}

export class TargetWaypointResolutionError extends Error {
  constructor(
    readonly rmfMap: string,
    readonly x: number,
    readonly y: number,
    readonly reason: 'unmapped' | 'ambiguous',
    readonly nearestDistance?: number
  ) {
    super(reason === 'ambiguous'
      ? `RMF target (${rmfMap}, ${x}, ${y}) is equally close to multiple navigation waypoints`
      : nearestDistance === undefined
        ? `RMF map ${rmfMap} has no configured navigation waypoint`
        : `Nearest navigation waypoint is ${nearestDistance.toFixed(2)}m from RMF target (${rmfMap}, ${x}, ${y}), outside its allowed radius`)
    this.name = 'TargetWaypointResolutionError'
  }
}

export function buildRmfDispatchRequest(
  command: DispatchBrowserCommand,
  fleet: string,
  maps: BridgeConfig['maps'] = {},
  navigationWaypoints: BridgeConfig['navigationWaypoints'] = [],
  now = Date.now()
): Record<string, unknown> {
  const { description, priority } = command.request
  const duration = description.category === 'gas_isolation' ? 25_000 : description.category === 'medical_support' ? 20_000 : 18_000
  const targetPose = description.target_pose ? toRmfTargetPose(description.target_pose, maps) : undefined
  const targetWaypoint = targetPose ? resolveNavigationWaypoint(targetPose, navigationWaypoints) : undefined
  return {
    type: 'dispatch_task_request',
    request: {
      unix_millis_request_time: now,
      priority: { type: 'binary', value: priority >= 90 ? 1 : 0 },
      category: 'compose',
      description: {
        category: description.category,
        detail: `FabWorld ${description.category}`,
        phases: [
          ...(targetWaypoint ? [{
            activity: {
              category: 'go_to_place',
              description: {
                waypoint: targetWaypoint.waypoint,
                ...(targetPose?.yaw !== undefined ? { orientation: targetPose.yaw } : {})
              }
            }
          }] : []),
          {
            activity: {
              category: 'perform_action',
              description: {
                category: description.category,
                description: {
                  fabworld_task_id: description.fabworld_task_id,
                  ...(description.target_id ? { target_id: description.target_id } : {}),
                  ...(targetPose ? { target_pose: targetPose } : {}),
                  ...(targetWaypoint ? { navigation_waypoint: targetWaypoint.waypoint } : {})
                },
                unix_millis_action_duration_estimate: duration,
                use_tool_sink: description.category !== 'inspection_round'
              }
            }
          }
        ]
      },
      labels: ['source=fabworld', `fabworld_task_id=${description.fabworld_task_id}`],
      requester: 'fabworld',
      fleet_name: fleet
    }
  }
}

function resolveNavigationWaypoint(
  pose: { map: string; x: number; y: number; yaw?: number },
  navigationWaypoints: BridgeConfig['navigationWaypoints']
): BridgeConfig['navigationWaypoints'][number] {
  const mapAnchors = navigationWaypoints
    .filter((anchor) => anchor.map === pose.map)
    .map((anchor) => ({ anchor, distance: Math.hypot(anchor.x - pose.x, anchor.y - pose.y) }))
    .sort((left, right) => left.distance - right.distance || String(left.anchor.waypoint).localeCompare(String(right.anchor.waypoint)))
  const nearestOnMap = mapAnchors[0]
  if (!nearestOnMap) throw new TargetWaypointResolutionError(pose.map, pose.x, pose.y, 'unmapped')
  const candidates = mapAnchors.filter(({ anchor, distance }) => distance <= anchor.maxDistance)
  const nearest = candidates[0]
  if (!nearest) {
    throw new TargetWaypointResolutionError(pose.map, pose.x, pose.y, 'unmapped', nearestOnMap.distance)
  }
  const second = candidates[1]
  if (second && Math.abs(second.distance - nearest.distance) < 1e-6) {
    throw new TargetWaypointResolutionError(pose.map, pose.x, pose.y, 'ambiguous', nearest.distance)
  }
  return nearest.anchor
}

function toRmfTargetPose(
  pose: NonNullable<DispatchBrowserCommand['request']['description']['target_pose']>,
  maps: BridgeConfig['maps']
): { map: string; x: number; y: number; yaw?: number } {
  const candidates = Object.entries(maps).filter(([, transform]) => transform.fabMap === pose.map)
  if (candidates.length !== 1) throw new TargetMapResolutionError(pose.map, candidates.length)
  const [map, transform] = candidates[0]!
  const cosine = Math.cos(transform.yaw)
  const sine = Math.sin(transform.yaw)
  const fabX = (pose.x - transform.offsetX) / transform.scale
  const fabZ = (pose.y - transform.offsetZ) / transform.scale
  return {
    map,
    x: roundCoordinate(cosine * fabX + sine * fabZ),
    y: roundCoordinate(-sine * fabX + cosine * fabZ),
    ...(pose.yaw !== undefined ? { yaw: roundCoordinate(normalizeAngle(pose.yaw - transform.yaw)) } : {})
  }
}

const roundCoordinate = (value: number): number => Math.round(value * 1_000_000) / 1_000_000

export function buildRmfCancelRequest(rmfTaskId: string, now = Date.now()): Record<string, unknown> {
  return {
    type: 'cancel_task_request',
    task_id: rmfTaskId,
    labels: ['source=fabworld', `unix_millis_request_time=${now}`]
  }
}

export class RmfEventNormalizer {
  private readonly previousPoses = new Map<string, PreviousPose>()

  constructor(private readonly config: BridgeConfig) {}

  robot(fleet: string, robotName: string, state: RmfRobotState, taskIds: ReadonlyMap<string, string>, now = Date.now()): RmfBridgeEvent | undefined {
    if (!state.location) return undefined
    const transform = this.config.maps[state.location.map]
    if (!transform) return undefined
    const cosine = Math.cos(transform.yaw)
    const sine = Math.sin(transform.yaw)
    const x = transform.offsetX + transform.scale * (cosine * state.location.x - sine * state.location.y)
    const y = transform.offsetZ + transform.scale * (sine * state.location.x + cosine * state.location.y)
    const timestamp = state.unix_millis_time ?? now
    const key = `${fleet}/${robotName}`
    const previous = this.previousPoses.get(key)
    const elapsedSeconds = previous ? Math.max(0.001, (timestamp - previous.timestamp) / 1_000) : 0
    const velocity = previous ? Math.hypot(state.location.x - previous.x, state.location.y - previous.y) / elapsedSeconds : Infinity
    this.previousPoses.set(key, { x: state.location.x, y: state.location.y, timestamp })
    const mode = state.status === 'offline' || state.status === 'shutdown' || state.status === 'uninitialized' || state.status === 'error'
      ? 'offline'
      : state.status === 'charging'
        ? 'charging'
        : state.status === 'working'
          ? velocity > 0.03 ? 'moving' : 'waiting'
          : 'idle'
    const mappedTaskId = state.task_id ? taskIds.get(state.task_id) : undefined
    return {
      type: 'robot_state',
      fleet,
      robot: robotName,
      map: transform.fabMap,
      x,
      y,
      yaw: normalizeAngle(state.location.yaw + transform.yaw),
      battery: Math.round((state.battery ?? 0) * 1_000) / 10,
      mode,
      ...(mappedTaskId ? { taskId: mappedTaskId } : {}),
      timestamp
    }
  }

  task(
    state: RmfTaskState,
    tracked: TrackedTask,
    now = Date.now()
  ): Extract<RmfBridgeEvent, { type: 'task_state' }> {
    const explicitStage = findFabworldStage(activePhase(state) ?? state.detail)
    const status = explicitStage ?? mapTaskStatus(state.status)
    return {
      type: 'task_state',
      taskId: tracked.fabworldId,
      category: tracked.category,
      status,
      ...(state.assigned_to?.name ? { assignedRobot: state.assigned_to.name } : {}),
      ...(tracked.targetId ? { targetId: tracked.targetId } : {}),
      timestamp: state.unix_millis_finish_time ?? state.unix_millis_start_time ?? state.booking.unix_millis_request_time ?? now
    }
  }
}

export function isTerminalRmfTask(state: RmfTaskState): boolean {
  return state.status !== undefined && terminalStatuses.has(state.status)
}

function mapTaskStatus(status: RmfTaskState['status']): HumanoidTaskStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'error' || status === 'killed') return 'failed'
  if (status === 'canceled') return 'cancelled'
  if (status === 'standby') return 'assigned'
  if (status === 'underway') return 'navigating'
  if (status === 'blocked' || status === 'delayed') return 'assigned'
  return 'queued'
}

function activePhase(state: RmfTaskState): unknown {
  if (state.active === undefined || !state.phases) return undefined
  return state.phases[String(state.active)]
}

function findFabworldStage(value: unknown, depth = 0): HumanoidTaskStatus | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'fabworld_stage' || key === 'action_stage') && typeof child === 'string' && fabworldStages.has(child as HumanoidTaskStatus)) return child as HumanoidTaskStatus
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = findFabworldStage(child, depth + 1)
      if (found) return found
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findFabworldStage(child, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

function normalizeAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value))
}

export type { TrackedTask }
