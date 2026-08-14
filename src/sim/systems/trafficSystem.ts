import type { SimWorld } from '../world'
import type { SimEntity } from '../types'
import { isStationaryGroundRobot } from './movementSystem'

function rightOfWay(world: SimWorld, entity: SimEntity): number {
  // Responders keep right-of-way while clearing the treatment perimeter after
  // loading; otherwise a stretcher vehicle and a yielding responder can
  // mutually block each other at sub-metre distance.
  if (
    entity.kind === 'person' &&
    entity.role === 'responder' &&
    (entity.behavior === 'respond' || entity.auxB > 0.5)
  ) return 7
  if (entity.kind === 'person' && entity.personActivity === 'yieldingToRobot') return 6
  if (
    entity.kind === 'igv' &&
    entity.mission === 'medical-transport' &&
    entity.behavior === 'respond' &&
    entity.auxA > 0.5
  ) return 8
  if (entity.kind === 'person') return 5
  if (entity.kind === 'humanoid' && entity.emergency && entity.auxB > 0.5) return 9
  // Gas isolation is urgent, but the robot must not claim a shared egress
  // lane from people who are still evacuating. Once the aisle is clear its
  // emergency travel speed remains available for the long valve approach.
  if (entity.kind === 'humanoid' && entity.emergency && entity.auxB < -0.5) {
    const task = entity.taskId
      ? world.humanoidTasks.find((candidate) => candidate.id === entity.taskId)
      : undefined
    if (task?.kind === 'gas_isolation' && task.requestedBy !== 'showcase') return 4
  }
  if (entity.kind === 'humanoid' && entity.emergency) return 6
  if (entity.kind === 'humanoid') return 4
  if (entity.behavior === 'respond') return 3
  return 1
}

/** Applies people-first and emergency right-of-way limits before integration. */
export function updateTraffic(world: SimWorld): void {
  const cellSize = 4
  const buckets = new Map<string, SimEntity[]>()
  const key = (x: number, z: number) => `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`
  for (const entity of world.entities) {
    entity.trafficSpeedLimit = entity.maxSpeed
    if (entity.kind === 'arm' || entity.carriedById) continue
    const bucketKey = key(entity.x, entity.z)
    const bucket = buckets.get(bucketKey)
    if (bucket) bucket.push(entity); else buckets.set(bucketKey, [entity])
  }
  const priorityByEntity = new Map(world.entities.map((entity) => [entity, rightOfWay(world, entity)]))
  for (const entity of world.entities) {
    entity.speed = Math.min(entity.speed, entity.maxSpeed)
    if (entity.carriedById) { entity.trafficSpeedLimit = 0; continue }
    if (entity.behavior === 'halt') { entity.speed = 0; entity.trafficSpeedLimit = 0; entity.status = 'waiting'; continue }
    if (entity.kind === 'arm') continue
    let limit = entity.maxSpeed
    const entityPriority = priorityByEntity.get(entity)!
    const cellX = Math.floor(entity.x / cellSize)
    const cellZ = Math.floor(entity.z / cellSize)
    const range = entity.kind === 'person' ? 1 : 3
    for (let x = cellX - range; x <= cellX + range; x++) for (let z = cellZ - range; z <= cellZ + range; z++) for (const other of buckets.get(`${x}:${z}`) ?? []) {
      if (other === entity) continue
      const dx = other.x - entity.x
      const dz = other.z - entity.z
      const distance = Math.hypot(dx, dz)
      if (distance > (entity.kind === 'person' ? 2.4 : entity.kind === 'humanoid' ? 4.5 : 8.4)) continue
      const facing = Math.cos(entity.yaw) * dx + Math.sin(entity.yaw) * dz
      const stationaryGroundRobot = isStationaryGroundRobot(other)
      if (entity.kind === 'person' && stationaryGroundRobot && (facing >= 0 || distance < 0.72)) {
        // A safe-stopped or externally pose-controlled robot cannot yield its
        // body even though people normally have right of way. Slow the person
        // before contact; the movement system enforces the final body envelope.
        if (other.kind === 'humanoid') {
          limit = Math.min(
            limit,
            distance <= 0.72
              ? entity.maxSpeed * 0.12
              : entity.maxSpeed * Math.min(0.65, Math.max(0.12, (distance - 0.72) / 0.7))
          )
        } else {
          // A stopped vehicle is wider but low and predictable. Keep enough
          // forward motion for the lateral solver to pass it instead of
          // creating a queue behind every fire-stopped AGV.
          const bodyClearance = other.kind === 'igv' ? 1.28 : 0.96
          limit = Math.min(
            limit,
            distance <= bodyClearance
              ? entity.maxSpeed * 0.28
              : entity.maxSpeed * Math.min(0.86, Math.max(0.45, (distance - bodyClearance) / 0.8))
          )
        }
        // The stationary-body branch above deliberately leaves a small
        // amount of forward motion so movementSystem can generate a lateral
        // pass. Do not feed the same pair into the generic priority rule
        // below: an emergency safe-stop humanoid has a higher priority there
        // and would turn that reduced speed back into a hard zero, leaving an
        // evacuation queue permanently parked behind the guide.
        continue
      }
      if (entity.kind === 'humanoid' && stationaryGroundRobot && facing >= 0) {
        // A walking humanoid can route around a parked body. Preserve a slow
        // stride for the lateral steering solver instead of entering the
        // generic robot/robot zero-speed deadlock several metres away.
        const bodyClearance = 0.28 + (other.kind === 'igv' ? 0.96 : other.kind === 'agv' ? 0.64 : 0.28)
        limit = Math.min(
          limit,
          entity.maxSpeed * (distance <= bodyClearance + 0.12 ? 0.18 : 0.48)
        )
        continue
      }
      if (facing < 0) continue
      const otherPriority = priorityByEntity.get(other)!
      if (otherPriority > entityPriority) {
        const goalDx = entity.goalX - entity.x
        const goalDz = entity.goalZ - entity.z
        const yieldingAway = entity.behavior === 'yield' && goalDx * dx + goalDz * dz < 0
        if (yieldingAway) {
          limit = Math.min(limit, entity.maxSpeed * 0.35)
          continue
        }
        const clearance = other.kind === 'person' ? 1.1 : 2.8
        limit = Math.min(limit, distance < clearance ? 0 : entity.maxSpeed * 0.25)
        continue
      }
      if (otherPriority < entityPriority) {
        continue
      }
      if (entity.kind === 'person' && other.kind === 'person') {
        const formingMuster =
          entity.behavior === 'evacuate' &&
          other.behavior === 'evacuate' &&
          entity.evacuationSlotIndex !== undefined &&
          other.evacuationSlotIndex !== undefined
        limit = Math.min(limit, entity.maxSpeed * (formingMuster ? (distance < 0.34 ? 0.25 : 0.85) : (distance < 0.42 ? 0.15 : 0.72)))
      }
      else if (entity.kind === 'person' && other.kind === 'humanoid') limit = Math.min(limit, entity.maxSpeed * (distance < 0.55 ? 0.2 : 0.7))
      else if (entity.kind === 'humanoid' && other.kind === 'person') limit = Math.min(limit, distance < 0.85 ? 0 : entity.maxSpeed * 0.45)
      else if (entity.kind !== 'person' && other.kind === 'person') {
        const remoteInspectionVehicle =
          entity.mission === 'hazmat-equipment' || entity.mission === 'remote-equipment-inspection'
        // These vehicles are assigned to an exterior bay. They still yield a
        // full personal envelope, but do not become permanently immobilized
        // behind an evacuation stream that is moving in the opposite lane.
        limit = Math.min(
          limit,
          remoteInspectionVehicle
            ? distance < 1.35 ? 0 : entity.maxSpeed * 0.62
            : distance < 3 ? 0 : entity.maxSpeed * 0.25
        )
      }
      else if (entity.kind !== 'person' && other.kind !== 'person') {
        if (entity.kind === 'humanoid') {
          // Humanoids use the body-aware lateral solver in shared ground
          // space. A blanket 5.1m vehicle headway otherwise deadlocks a
          // walking guide behind a parked robot in an adjacent lane.
          limit = Math.min(limit, entity.maxSpeed * (distance < 0.74 ? 0.18 : 0.48))
          continue
        }
        const coordinatedRemotePair =
          (entity.mission === 'hazmat-equipment' || entity.mission === 'remote-equipment-inspection') &&
          (other.mission === 'hazmat-equipment' || other.mission === 'remote-equipment-inspection')
        // The two emergency inspection vehicles use separate exterior lanes.
        // A generic 5m stop envelope made them permanently wait face-to-face
        // at a shared graph waypoint even though neither entered human space.
        if (coordinatedRemotePair) {
          const igvLeadsExteriorSweep = entity.kind === 'igv' && other.kind === 'agv'
          // One designated lead removes the equal-priority deadlock at the
          // shared waypoint; the AGV resumes after the IGV has cleared it.
          if (!igvLeadsExteriorSweep) {
            limit = Math.min(limit, distance < 2.8 ? 0 : entity.maxSpeed * Math.min(0.65, (distance - 2.8) / 2))
          }
        } else {
          limit = Math.min(limit, distance < 5.1 ? 0 : entity.maxSpeed * (distance - 5.1) / 3.3)
        }
      }
    }
    entity.trafficSpeedLimit = Math.max(0, limit)
    entity.waitTicks = entity.trafficSpeedLimit === 0 ? entity.waitTicks + 1 : 0
    if (entity.waitTicks > 60 && entity.behavior === 'normal') {
      entity.route = []
      entity.routeCursor = 0
      entity.targetX = Number.NaN
      entity.targetZ = Number.NaN
      entity.targetIndex = (entity.targetIndex + 11 + entity.index % 7) % Math.max(1, entity.kind === 'oht' ? world.layout.railGraph.nodes.length : entity.kind === 'person' || entity.kind === 'humanoid' ? world.layout.walkGraph.nodes.length : world.layout.roadGraph.nodes.length)
      entity.waitTicks = 0
    }
    if (entity.kind !== 'person') entity.speed = Math.min(entity.speed, entity.trafficSpeedLimit)
  }
}
