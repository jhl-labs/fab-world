import { circleIntersectsObstacle, sweptCircleIntersectsObstacle, type GroundObstacleIndex } from '../../core/layout'
import type { SimWorld } from '../world'
import type { SimEntity } from '../types'

type GroundGraph = SimWorld['layout']['walkGraph']
interface TrafficPenaltyCache {
  signature: string
  byGraphAndRadius: Map<string, ReadonlyMap<number, number>>
}
const trafficPenaltyCache = new WeakMap<SimWorld, TrafficPenaltyCache>()

function medicalKitRendezvous(world: SimWorld, entity: SimEntity): readonly [number, number] | undefined {
  const response = world.medicalResponse
  if (
    entity.id !== response?.kitResponderId ||
    response.kitHandoffComplete ||
    response.kitRendezvousX === undefined ||
    response.kitRendezvousZ === undefined
  ) return undefined
  return [response.kitRendezvousX, response.kitRendezvousZ]
}

function destination(world: SimWorld, entity: SimEntity): readonly [number, number] {
  if (entity.kind === 'humanoid') return [entity.goalX, entity.goalZ]
  if (entity.kind === 'person' && entity.manualGasRole) return [entity.goalX, entity.goalZ]
  if (entity.kind === 'person' && entity.gasSpotterTaskId) return [entity.goalX, entity.goalZ]
  if (entity.kind === 'person' && entity.personActivity === 'walkingToWork') return [entity.goalX, entity.goalZ]
  if (entity.kind === 'person' && entity.personActivity === 'returningToStation') return [entity.goalX, entity.goalZ]
  if (entity.kind === 'person' && entity.personActivity === 'yieldingToRobot') return [entity.goalX, entity.goalZ]
  if (entity.kind === 'person' && ['fireApproach', 'fireSuppressing', 'medicalApproach', 'gasPerimeter'].includes(entity.personActivity ?? '')) return [entity.goalX, entity.goalZ]
  if (entity.kind === 'person' && entity.behavior === 'evacuate') return [entity.goalX, entity.goalZ]
  if (entity.kind === 'person' && entity.behavior === 'yield') return [entity.goalX, entity.goalZ]
  const hazard = world.emergency.hazard
  if (entity.mission === 'medical-transport' && world.medicalResponse?.stage === 'transporting') return [entity.goalX, entity.goalZ]
  if (entity.mission === 'hazmat-equipment' || entity.mission === 'remote-equipment-inspection') return [entity.goalX, entity.goalZ]
  const rendezvous = medicalKitRendezvous(world, entity)
  if (rendezvous) return rendezvous
  if (entity.behavior === 'respond' && hazard) return [hazard.sourceX, hazard.sourceZ]
  if (entity.behavior === 'yield' && entity.kind !== 'person') return [entity.goalX, entity.goalZ]
  if (entity.mission) return [entity.goalX, entity.goalZ]
  if (entity.kind === 'igv' && world.emergency.kind === 'medical' && entity.emergency) return [world.layout.layout.emergency.medicalStation.position[0], world.layout.layout.emergency.medicalStation.position[2]]
  const graph = entity.kind === 'oht' ? world.layout.railGraph : entity.kind === 'person' ? world.layout.walkGraph : world.layout.roadGraph
  const node = graph.nodes[(entity.targetIndex + entity.index * 17) % graph.nodes.length]!
  return [node.x, node.z]
}

function chooseTarget(world: SimWorld, entity: SimEntity, blockedRobot?: SimEntity): boolean {
  const graph = entity.kind === 'oht' ? world.layout.railGraph : entity.kind === 'person' || entity.kind === 'humanoid' ? world.layout.walkGraph : world.layout.roadGraph
  let [x, z] = destination(world, entity)
  let from = graph.nearest(entity.x, entity.z)
  const bodyRadius = groundBodyRadius(entity)
  const blockingRobots = blockedRobot
    ? entity.kind === 'humanoid'
      ? world.entities.filter((robot) =>
          robot !== entity && isStationaryGroundRobot(robot) && Math.hypot(robot.x - entity.x, robot.z - entity.z) < 8
        )
      : [blockedRobot]
    : []
  const blockedNodes = blockingRobots.length > 0 && bodyRadius > 0 && (entity.kind === 'person' || entity.kind === 'humanoid')
    ? navigationBlocksForRobots(graph, bodyRadius, blockingRobots)
    : new Set<number>()
  if (bodyRadius > 0 && !entity.rmfControlled) {
    // A Euclidean-nearest lane node can sit on the far side of a cabinet.
    // Enter the navigation graph through the closest node that is actually
    // visible to this body's swept envelope.
    let bestDistance = Infinity
    for (let index = 0; index < graph.nodes.length; index++) {
      const node = graph.nodes[index]!
      const distance = (node.x - entity.x) ** 2 + (node.z - entity.z) ** 2
      if (distance >= bestDistance) continue
      if (blockedNodes.has(index)) continue
      if (!pathIsClear(world.layout.groundObstacleIndex, entity.x, entity.z, node.x, node.z, bodyRadius)) continue
      if (blockingRobots.length > 0 && !pathIsClearOfStationaryRobots(entity, node.x, node.z, blockingRobots)) continue
      from = index
      bestDistance = distance
    }
  }
  const to = nearestAvailableNode(graph, x, z, blockedNodes)
  const authorizedResponse = entity.behavior === 'respond' || (entity.kind === 'humanoid' && entity.emergency)
  const trafficPenalties = bodyRadius > 0
    ? dynamicTrafficPenalties(world, graph, bodyRadius)
    : new Map<number, number>()
  const hazards = authorizedResponse ? new Map<string, 'safe' | 'warning' | 'danger'>() : world.hazardLevels
  let avoidedStationaryBodies = true
  entity.route = graph.findPath(from, to, hazards, blockedNodes, trafficPenalties)
  if (entity.route.length === 0 && blockedNodes.size > 0) {
    // A parked vehicle can occupy an articulation node in this deliberately
    // compact graph. If removing that node disconnects the whole facility,
    // retain the connected route and let the body-aware lateral solver pass
    // the vehicle locally instead of stranding the person many metres away.
    avoidedStationaryBodies = false
    entity.route = graph.findPath(from, graph.nearest(x, z), hazards, new Set(), trafficPenalties)
  }
  if (entity.route.length === 0 && entity.kind === 'person' && entity.behavior === 'evacuate') {
    world.assignEvacuationMuster(entity, true)
    ;[x, z] = destination(world, entity)
    const fallbackTo = nearestAvailableNode(graph, x, z, blockedNodes)
    entity.route = graph.findPath(from, fallbackTo, world.hazardLevels, blockedNodes, trafficPenalties)
    if (entity.route.length === 0 && blockedNodes.size > 0) {
      avoidedStationaryBodies = false
      entity.route = graph.findPath(from, graph.nearest(x, z), world.hazardLevels, new Set(), trafficPenalties)
    }
  }
  if (entity.route.length === 0) {
    entity.speed = 0
    entity.status = 'waiting'
    entity.targetX = entity.x
    entity.targetZ = entity.z
    return false
  }
  // Skip the entry node only when the body's complete swept envelope can see
  // the following node. This preserves the old efficient lane entry without
  // allowing a diagonal shortcut through a cabinet.
  const nextCursor = Math.min(1, entity.route.length - 1)
  const nextNode = graph.nodes[entity.route[nextCursor]!]!
  entity.routeCursor =
    nextCursor > 0 &&
    pathIsClear(world.layout.groundObstacleIndex, entity.x, entity.z, nextNode.x, nextNode.z, bodyRadius)
      ? nextCursor
      : 0
  const target = graph.nodes[entity.route[entity.routeCursor]!] ?? { x, z }
  entity.targetX = target.x; entity.targetZ = target.z; entity.targetIndex = (entity.targetIndex + 1 + world.rng.int(0, 4)) % Math.max(1, graph.nodes.length)
  entity.navigationBestDistance = Math.hypot(entity.x - target.x, entity.z - target.z)
  entity.navigationLastProgressAt = world.simTime
  entity.targetDelay = entity.kind === 'person' && entity.behavior === 'normal' && entity.personActivity === 'patrol' && world.rng.next() < 0.14
    ? world.rng.range(0.5, 2.5)
    : 0
  return avoidedStationaryBodies
}

function nearestAvailableNode(
  graph: GroundGraph,
  x: number,
  z: number,
  blockedNodes: ReadonlySet<number>
): number {
  let nearest = graph.nearest(x, z)
  let bestDistance = blockedNodes.has(nearest) ? Infinity : (graph.nodes[nearest]!.x - x) ** 2 + (graph.nodes[nearest]!.z - z) ** 2
  for (let index = 0; index < graph.nodes.length; index++) {
    if (blockedNodes.has(index)) continue
    const node = graph.nodes[index]!
    const distance = (node.x - x) ** 2 + (node.z - z) ** 2
    if (distance < bestDistance) { nearest = index; bestDistance = distance }
  }
  return nearest
}

function navigationBlocksForRobots(
  graph: GroundGraph,
  bodyRadius: number,
  robots: readonly SimEntity[]
): ReadonlySet<number> {
  const blocked = new Set<number>()
  for (let index = 0; index < graph.nodes.length; index++) {
    const node = graph.nodes[index]!
    if (robots.some((robot) =>
      Math.hypot(robot.x - node.x, robot.z - node.z) < groundBodyRadius(robot) + bodyRadius + 0.18
    )) blocked.add(index)
  }
  return blocked
}

function dynamicTrafficPenalties(
  world: SimWorld,
  graph: GroundGraph,
  bodyRadius: number
): ReadonlyMap<number, number> {
  const stationaryRobots = world.entities.filter(isStationaryGroundRobot)
  const signature = stationaryRobots
    .map((robot) => `${robot.id}:${robot.x.toFixed(2)}:${robot.z.toFixed(2)}`)
    .join('|')
  let cache = trafficPenaltyCache.get(world)
  if (!cache || cache.signature !== signature) {
    cache = { signature, byGraphAndRadius: new Map() }
    trafficPenaltyCache.set(world, cache)
  }
  const graphName = graph === world.layout.walkGraph ? 'walk' : graph === world.layout.roadGraph ? 'road' : 'rail'
  const key = `${graphName}:${bodyRadius.toFixed(2)}`
  const existing = cache.byGraphAndRadius.get(key)
  if (existing) return existing
  const penalties = new Map<number, number>()
  for (const robot of stationaryRobots) {
    const influence = groundBodyRadius(robot) + bodyRadius + 2.1
    const influenceSquared = influence ** 2
    let nearest = 0
    let nearestDistance = Infinity
    for (let index = 0; index < graph.nodes.length; index++) {
      const node = graph.nodes[index]!
      const distance = (robot.x - node.x) ** 2 + (robot.z - node.z) ** 2
      if (distance < nearestDistance) { nearest = index; nearestDistance = distance }
      if (distance < influenceSquared) penalties.set(index, Math.max(penalties.get(index) ?? 1, 24))
    }
    // Long graph edges can leave a robot farther than the influence radius
    // from both end nodes. Penalize its nearest junction as a routing hint.
    penalties.set(nearest, Math.max(penalties.get(nearest) ?? 1, 12))
  }
  cache.byGraphAndRadius.set(key, penalties)
  return penalties
}

export function updateMovement(world: SimWorld, dt: number): void {
  const stationaryGroundRobots = world.entities.filter(isStationaryGroundRobot)
  for (const entity of world.entities) {
    if (!entity.rmfControlled) entity.animationPhase = (entity.animationPhase + dt * Math.max(entity.speed, 0.2)) % 1
    if (entity.kind === 'arm') { entity.animation = 2; continue }
    if (entity.missionActivity === 'inspecting' || entity.missionActivity === 'reporting') {
      entity.speed = 0
      entity.status = 'working'
      entity.animation = 4
      continue
    }
    if (entity.kind === 'humanoid' && entity.rmfControlled) {
      entity.animation = entity.status === 'moving' ? 1 : entity.activity === 'manipulating' ? 5 : entity.activity === 'reporting' ? 6 : 0
      continue
    }
    if (entity.kind === 'humanoid' && entity.activity && !['walking', 'yielding'].includes(entity.activity)) {
      entity.speed = 0
      if (entity.status !== 'error') {
        entity.status = ['observing', 'manipulating', 'reporting'].includes(entity.activity)
          ? 'working'
          : 'waiting'
      }
      entity.animation = entity.activity === 'observing' ? 4 : entity.activity === 'manipulating' ? 5 : entity.activity === 'reporting' ? 6 : 0
      continue
    }
    if (entity.kind === 'person' && entity.personActivity === 'collapsed') { entity.speed = 0; entity.animation = 3; entity.status = 'waiting'; continue }
    if (
      entity.kind === 'person' &&
      entity.role === 'responder' &&
      entity.behavior === 'normal' &&
      entity.personActivity === 'idle'
    ) {
      entity.speed = 0
      entity.animation = 0
      entity.status = 'waiting'
      entity.targetX = Number.NaN
      entity.targetZ = Number.NaN
      continue
    }
    if (entity.kind === 'person' && entity.personActivity === 'reacting' && world.simTime < (entity.reactionUntil ?? world.simTime)) {
      entity.speed = 0
      if (entity.animation !== 7) entity.animation = 4
      entity.status = 'waiting'
      continue
    }
    if (entity.kind === 'person' && entity.personActivity === 'inspecting') { entity.speed = 0; entity.animation = 4; entity.status = 'working'; continue }
    if (entity.kind === 'person' && entity.personActivity === 'acknowledgingRobot') { entity.speed = 0; entity.animation = 4; entity.status = 'working'; continue }
    if (entity.kind === 'person' && entity.personActivity === 'receivingKit') { entity.speed = 0; entity.animation = 5; entity.status = 'working'; continue }
    if (entity.kind === 'person' && entity.personActivity === 'treating') { entity.speed = 0; entity.animation = 6; entity.status = 'working'; continue }
    if (entity.kind === 'person' && entity.personActivity === 'fireSuppressing') { entity.speed = 0; entity.animation = 10; entity.status = 'working'; continue }
    if (entity.targetDelay > 0) { entity.targetDelay -= dt; entity.speed = 0; entity.status = 'working'; if (entity.animation !== 4) entity.animation = 0; continue }
    if (entity.kind === 'person' && entity.behavior === 'evacuate' && entity.evacuationMusterId && entity.evacuationSlotIndex === undefined) {
      const muster = world.layout.layout.emergency.musterPoints.find((point) => point.id === entity.evacuationMusterId)
      if (muster && Math.hypot(entity.x - muster.position[0], entity.z - muster.position[2]) < 6) world.assignEvacuationSlot(entity)
    }
    if (
      entity.kind === 'person' &&
      entity.behavior === 'evacuate' &&
      entity.route.length > 0 &&
      entity.routeCursor === entity.route.length - 1 &&
      Number.isFinite(entity.targetX) &&
      Math.hypot(entity.targetX - entity.x, entity.targetZ - entity.z) < 5
    ) {
      world.assignEvacuationSlot(entity)
      entity.targetX = entity.goalX
      entity.targetZ = entity.goalZ
    }
    if (
      entity.kind === 'person' &&
      entity.behavior === 'evacuate' &&
      entity.evacuationSlotIndex !== undefined &&
      Math.hypot(entity.targetX - entity.goalX, entity.targetZ - entity.goalZ) < 0.05
    ) {
      const goalDistance = Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ)
      if (entity.formationBestDistance === undefined || goalDistance < entity.formationBestDistance - 0.05) {
        entity.formationBestDistance = goalDistance
        entity.formationLastProgressAt = world.simTime
      } else if (
        goalDistance > 0.35 &&
        world.simTime - (entity.formationLastProgressAt ?? world.simTime) >= 4 &&
        (entity.formationReassignments ?? 0) < 3
      ) {
        world.reassignBlockedEvacuationSlot(entity)
      }
    }
    const rendezvous = medicalKitRendezvous(world, entity)
    const dx = entity.targetX - entity.x; const dz = entity.targetZ - entity.z; const distance = Math.hypot(dx, dz)
    const precisePersonGoal =
      entity.kind === 'person' &&
      (
        (entity.behavior === 'evacuate' && Math.hypot(entity.targetX - entity.goalX, entity.targetZ - entity.goalZ) < 0.05) ||
        entity.personActivity === 'walkingToWork' ||
        entity.personActivity === 'returningToStation' ||
        entity.personActivity === 'yieldingToRobot' ||
        entity.manualGasRole !== undefined ||
        entity.gasSpotterTaskId !== undefined
      )
    const humanoidTask = entity.kind === 'humanoid' && entity.taskId
      ? world.humanoidTasks.find((task) => task.id === entity.taskId)
      : undefined
    const preciseHumanoidGoal =
      humanoidTask?.status === 'navigating' &&
      humanoidTask.kind !== 'medical_support' &&
      Math.hypot(entity.targetX - entity.goalX, entity.targetZ - entity.goalZ) < 0.05
    // Several people legitimately share graph waypoints. Requiring every body
    // centre to enter a 0.18m circle creates a permanent orbit once the 0.42m
    // personal-space solver separates them. Keep 0.18m only for private goals.
    const arrivalThreshold = entity.kind === 'person'
      ? (precisePersonGoal ? 0.18 : 0.48)
      : preciseHumanoidGoal
        ? 0.02
        : entity.kind === 'igv'
          ? 0.72
          : 0.5
    const stationaryWaypointBlocker =
      entity.route.length > 0 &&
      entity.routeCursor < entity.route.length - 1
        ? world.entities.find((robot) =>
            robot !== entity &&
            isStationaryGroundRobot(robot) &&
            Math.hypot(robot.x - entity.targetX, robot.z - entity.targetZ) < groundBodyRadius(robot) + 2
          )
        : undefined
    const graph = entity.kind === 'oht' ? world.layout.railGraph : entity.kind === 'person' || entity.kind === 'humanoid' ? world.layout.walkGraph : world.layout.roadGraph
    const nextRouteNode = entity.routeCursor < entity.route.length - 1
      ? graph.nodes[entity.route[entity.routeCursor + 1]!]
      : undefined
    const occupiedWaypointCanBeSkipped =
      stationaryWaypointBlocker !== undefined &&
      nextRouteNode !== undefined &&
      pathIsClear(world.layout.groundObstacleIndex, entity.x, entity.z, nextRouteNode.x, nextRouteNode.z, groundBodyRadius(entity)) &&
      pathIsClearOfStationaryRobots(entity, nextRouteNode.x, nextRouteNode.z, stationaryGroundRobots)
    const stationaryPathBlocker = stationaryRobotOnPath(entity, entity.targetX, entity.targetZ, stationaryGroundRobots)
    const waypointArrivalThreshold = occupiedWaypointCanBeSkipped
      ? Math.max(arrivalThreshold, groundBodyRadius(entity) + groundBodyRadius(stationaryWaypointBlocker) + 1.1)
      : arrivalThreshold
    let stalledAtWaypoint = false
    if (entity.route.length > 0 && entity.routeCursor < entity.route.length - 1) {
      if (entity.navigationBestDistance === undefined || distance < entity.navigationBestDistance - 0.12) {
        entity.navigationBestDistance = distance
        entity.navigationLastProgressAt = world.simTime
      } else if (world.simTime - (entity.navigationLastProgressAt ?? world.simTime) >= 4) {
        stalledAtWaypoint = true
      }
    }
    if (stalledAtWaypoint) {
      // Re-enter through a currently visible graph node. Blindly skipping the
      // next node can turn a lane route into a long diagonal through several
      // tools when a parked vehicle temporarily blocks one corridor corner.
      chooseTarget(
        world,
        entity,
        stationaryWaypointBlocker && isStationaryGroundRobot(stationaryWaypointBlocker)
          ? stationaryWaypointBlocker
          : stationaryPathBlocker
      )
      continue
    }
    if (distance < waypointArrivalThreshold || !Number.isFinite(entity.targetX)) {
      const routeFinished = entity.route.length > 0 && entity.routeCursor >= entity.route.length - 1
      if (entity.kind === 'person' && entity.behavior === 'evacuate' && entity.evacuationMusterId && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) < 0.08) {
        entity.speed = Math.max(0, entity.speed - 2.8 * dt)
        entity.status = 'waiting'
        entity.personActivity = 'mustered'
        entity.animation = entity.speed > 0.08 ? 2 : 0
        if (entity.speed <= 0.08) {
          // Finish on the reserved slot rather than preserving a small
          // braking offset that can erode the intended 0.75m formation gap.
          entity.x = entity.goalX
          entity.z = entity.goalZ
          orientMusteredPerson(world, entity, dt)
        }
        continue
      }
      if (entity.kind === 'person' && entity.personActivity === 'yieldingToRobot' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) < 0.08) {
        entity.speed = Math.max(0, entity.speed - 2.2 * dt)
        entity.status = 'waiting'
        entity.animation = entity.speed > 0.08 ? 1 : 4
        continue
      }
      if (rendezvous && Math.hypot(entity.x - rendezvous[0], entity.z - rendezvous[1]) < 0.35) {
        entity.speed = 0
        entity.status = 'working'
        entity.animation = 4
        continue
      }
      if (entity.kind === 'person' && entity.manualGasRole && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) < 0.08) {
        entity.speed = Math.max(0, entity.speed - 2.2 * dt)
        entity.status = 'working'
        entity.animation = entity.speed > 0.08
          ? 2
          : entity.manualGasRole === 'spotter'
            ? 8
            : entity.animation === 9
              ? 9
              : 4
        continue
      }
      if (entity.kind === 'person' && entity.gasSpotterTaskId && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) < 0.08) {
        entity.speed = Math.max(0, entity.speed - 2.2 * dt)
        entity.status = 'working'
        entity.animation = entity.speed > 0.08 ? 2 : 8
        continue
      }
      if (
        entity.behavior === 'respond' &&
        entity.manualGasRole === undefined &&
        entity.mission === undefined &&
        world.emergency.hazard &&
        Math.hypot(entity.x - world.emergency.hazard.sourceX, entity.z - world.emergency.hazard.sourceZ) < (entity.kind === 'person' ? 1.8 : 2.5)
      ) {
        entity.speed = 0; entity.status = 'working'; entity.animation = entity.kind === 'person' ? 4 : 0; continue
      }
      if (entity.behavior === 'yield' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) < 1.2) {
        entity.speed = 0; entity.status = 'waiting'; entity.animation = 0; continue
      }
      if (entity.routeCursor < entity.route.length - 1) {
        entity.routeCursor++
        const node = graph.nodes[entity.route[entity.routeCursor]!]!
        entity.targetX = node.x
        entity.targetZ = node.z
        entity.navigationBestDistance = Math.hypot(entity.x - node.x, entity.z - node.z)
        entity.navigationLastProgressAt = world.simTime
      }
      else if (routeFinished && entity.kind === 'humanoid' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.kind === 'person' && entity.behavior === 'evacuate' && entity.route.length > 0 && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.03) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ }
      else if (routeFinished && entity.kind === 'person' && entity.personActivity === 'walkingToWork' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && entity.kind === 'person' && entity.personActivity === 'returningToStation' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.2) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && entity.kind === 'person' && entity.personActivity === 'yieldingToRobot' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && !rendezvous && entity.kind === 'person' && ['fireApproach', 'fireSuppressing', 'medicalApproach', 'gasPerimeter'].includes(entity.personActivity ?? '') && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && entity.kind === 'person' && entity.manualGasRole && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.03) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && entity.kind === 'person' && entity.gasSpotterTaskId && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.03) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && entity.behavior === 'yield' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && entity.mission === 'medical-transport' && world.medicalResponse?.stage === 'transporting') { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && rendezvous) { entity.targetX = rendezvous[0]; entity.targetZ = rendezvous[1]; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && entity.behavior === 'respond' && world.emergency.hazard) { entity.targetX = world.emergency.hazard.sourceX; entity.targetZ = world.emergency.hazard.sourceZ; entity.route = []; entity.routeCursor = 0 }
      else if (routeFinished && entity.mission && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (
        entity.route.length === 0 &&
        Math.hypot(entity.targetX - entity.goalX, entity.targetZ - entity.goalZ) < 0.05 &&
        (precisePersonGoal || preciseHumanoidGoal)
      ) {
        // Keep converging on a private final pose inside the broad slowdown
        // envelope. Replanning here would send the body back to the nearest
        // shared graph node and create a visible waypoint/goal oscillation.
        entity.targetX = entity.goalX
        entity.targetZ = entity.goalZ
      }
      else chooseTarget(world, entity)
    }
    const toX = entity.targetX - entity.x; const toZ = entity.targetZ - entity.z; const remaining = Math.hypot(toX, toZ)
    const behaviorLimit = entity.behavior === 'yield' ? entity.maxSpeed * 0.35 : entity.maxSpeed
    let desired = Math.min(behaviorLimit, entity.trafficSpeedLimit)
    const accel = entity.kind === 'oht' ? 1 : entity.kind === 'person' ? 1.5 : 1.8
    const decel = entity.kind === 'person' ? (entity.behavior === 'evacuate' ? 2.8 : 2.2) : accel
    const formationApproach =
      entity.kind === 'person' &&
      entity.behavior === 'evacuate' &&
      entity.evacuationSlotIndex !== undefined &&
      remaining < 7
    const sharedSpaceSteering = stationaryGroundRobotSteering(
      world.layout.groundObstacleIndex,
      stationaryGroundRobots,
      entity,
      toX,
      toZ
    )
    const steering = staticObstacleSteering(world.layout.groundObstacleIndex, entity, sharedSpaceSteering[0], sharedSpaceSteering[1])
    const yaw = Math.atan2(steering[1], steering[0])
    const yawDelta = Math.atan2(Math.sin(yaw - entity.yaw), Math.cos(yaw - entity.yaw))
    if (entity.kind === 'person') desired *= Math.max(0, Math.cos(yawDelta))
    // A humanoid cannot instantaneously redirect its centre of mass at a graph
    // corner. Decelerate into the turn, then commit to the next stride once the
    // pelvis has turned. This removes the visual side-slip that made routes
    // look like an icon sliding across the floor.
    if (entity.kind === 'humanoid') desired *= Math.max(0.18, Math.cos(yawDelta * 0.68))
    const finalPersonApproach =
      entity.kind === 'person' &&
      (
        (entity.behavior === 'evacuate' && Math.hypot(entity.targetX - entity.goalX, entity.targetZ - entity.goalZ) < 0.05) ||
        entity.personActivity === 'walkingToWork' ||
        entity.personActivity === 'returningToStation' ||
        entity.personActivity === 'yieldingToRobot' ||
        entity.manualGasRole !== undefined ||
        entity.gasSpotterTaskId !== undefined
      )
    if (finalPersonApproach || preciseHumanoidGoal) {
      desired = Math.min(desired, Math.sqrt(2 * decel * Math.max(0, remaining - 0.02)))
    }
    if (formationApproach && remaining < 2) {
      // Dense hex-grid assembly needs a walking-speed terminal approach.
      // The generic braking curve otherwise keeps almost full evacuation
      // speed until the final half metre, causing people to orbit or swap
      // sides around their reserved slots after personal-space projection.
      desired = Math.min(desired, Math.max(0.12, remaining * 0.9))
    }
    const speedBeforeIntegration = entity.speed
    entity.speed = entity.speed < desired
      ? Math.min(desired, entity.speed + accel * dt)
      : Math.max(desired, entity.speed - decel * dt)
    if (entity.kind === 'person') {
      const turnRate = entity.behavior === 'evacuate' || entity.behavior === 'respond' ? 2.8 : 2.4
      entity.yaw += Math.sign(yawDelta) * Math.min(Math.abs(yawDelta), turnRate * dt)
    } else {
      const turnRate = entity.kind === 'humanoid' ? 2.65 : entity.kind === 'oht' ? 1.55 : 2.15
      entity.yaw += Math.sign(yawDelta) * Math.min(Math.abs(yawDelta), turnRate * dt)
    }
    if (entity.speed === 0 || remaining < 0.01) { entity.status = 'waiting'; entity.animation = 0; continue }
    const travel = Math.min(remaining, entity.speed * dt)
    const movementDirection = formationApproach
      ? steering
      : [Math.cos(entity.yaw), Math.sin(entity.yaw)] as const
    if (!advanceAvoidingStaticObstacles(world.layout.groundObstacleIndex, entity, movementDirection[0], movementDirection[1], travel)) {
      entity.speed = Math.max(0, Math.min(entity.speed, speedBeforeIntegration - decel * dt))
      entity.status = 'waiting'
      entity.animation = 0
      continue
    }
    entity.status = 'moving'; entity.animation = entity.kind === 'person' ? (entity.behavior === 'evacuate' || entity.behavior === 'respond' ? 2 : 1) : 1
  }
  resolvePersonalSpace(world)
  resolveHumanRobotSpace(world)
  resolveGroundBodySpace(world, 1)
  if (resolveStaticObstacleSpace(world)) {
    // A body projected out of a cabinet may land near another body. Run one
    // bounded reconciliation only when a static correction actually occurred.
    resolveGroundBodySpace(world, 1)
    resolveStaticObstacleSpace(world)
  }
  // A cabinet projection can place a person back against a humanoid. Finish
  // with the semantic people/robot solver so the published pose never keeps
  // an overlap introduced by the static-boundary pass.
  resolveHumanRobotSpace(world)
}

export function groundBodyRadius(entity: SimEntity): number {
  if (entity.kind === 'person') return 0.22
  if (entity.kind === 'humanoid') return 0.28
  if (entity.kind === 'agv') return 0.64
  if (entity.kind === 'igv') return 0.96
  return 0
}

export function isStationaryGroundRobot(entity: SimEntity): boolean {
  return ['agv', 'igv', 'humanoid'].includes(entity.kind) &&
    (
      entity.rmfControlled ||
      entity.activity === 'safeStop' ||
      entity.behavior === 'halt' ||
      (entity.behavior !== 'normal' && entity.speed < 0.05 && entity.status === 'waiting') ||
      (
        entity.behavior === 'yield' &&
        entity.speed < 0.05 &&
        entity.status === 'waiting' &&
        Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) < 1.2
      ) ||
      (
        entity.kind === 'humanoid' &&
        entity.speed < 0.05 &&
        (
          entity.status !== 'moving' ||
          !['walking', 'yielding'].includes(entity.activity ?? '')
        )
      )
    )
}

function staticObstacleSteering(
  obstacles: GroundObstacleIndex,
  entity: SimEntity,
  targetX: number,
  targetZ: number
): readonly [number, number] {
  const radius = groundBodyRadius(entity)
  const length = Math.hypot(targetX, targetZ)
  if (radius === 0 || entity.rmfControlled || !Number.isFinite(length) || length < 0.05) return [targetX, targetZ]
  const forwardX = targetX / length
  const forwardZ = targetZ / length
  const lookAhead = Math.min(length, Math.max(0.75, Math.min(1.8, entity.speed * 1.4 + 0.8)))
  const lookX = entity.x + forwardX * lookAhead
  const lookZ = entity.z + forwardZ * lookAhead
  const nearby = obstacles.alongSegment(entity.x, entity.z, lookX, lookZ, radius)
  if (pathIsClearAmong(nearby, entity.x, entity.z, lookX, lookZ, radius)) {
    return [targetX, targetZ]
  }
  // Deterministic handedness prevents two equal agents from oscillating
  // between left and right at every fixed simulation tick.
  const preferredSide = (entity.index & 1) === 0 ? 1 : -1
  const blocker = nearby.find((obstacle) =>
    circleIntersectsObstacle(lookX, lookZ, radius, obstacle) ||
    sweptCircleIntersectsObstacle(entity.x, entity.z, lookX, lookZ, radius, obstacle)
  )
  if (blocker) {
    const minimumX = blocker.centerX - blocker.halfWidth - radius - 0.12
    const maximumX = blocker.centerX + blocker.halfWidth + radius + 0.12
    const minimumZ = blocker.centerZ - blocker.halfDepth - radius - 0.12
    const maximumZ = blocker.centerZ + blocker.halfDepth + radius + 0.12
    if (Math.abs(forwardZ) >= Math.abs(forwardX)) {
      const outside = entity.x < minimumX || entity.x > maximumX
      let sideX = entity.x
      if (!outside) {
        const candidates = preferredSide > 0 ? [maximumX, minimumX] : [minimumX, maximumX]
        sideX = candidates.find((candidateX) =>
          pathIsClear(obstacles, entity.x, entity.z, candidateX, entity.z + forwardZ * 0.28, radius) &&
          pathIsClear(
            obstacles,
            candidateX,
            entity.z + forwardZ * 0.28,
            candidateX,
            forwardZ > 0 ? maximumZ : minimumZ,
            radius
          )
        ) ?? candidates[0]!
      }
      const sideZ = outside
        ? (forwardZ > 0 ? maximumZ : minimumZ)
        : entity.z + forwardZ * 0.28
      return [sideX - entity.x, sideZ - entity.z]
    }
    const outside = entity.z < minimumZ || entity.z > maximumZ
    let sideZ = entity.z
    if (!outside) {
      const candidates = preferredSide > 0 ? [maximumZ, minimumZ] : [minimumZ, maximumZ]
      sideZ = candidates.find((candidateZ) =>
        pathIsClear(obstacles, entity.x, entity.z, entity.x + forwardX * 0.28, candidateZ, radius) &&
        pathIsClear(
          obstacles,
          entity.x + forwardX * 0.28,
          candidateZ,
          forwardX > 0 ? maximumX : minimumX,
          candidateZ,
          radius
        )
      ) ?? candidates[0]!
    }
    const sideX = outside
      ? (forwardX > 0 ? maximumX : minimumX)
      : entity.x + forwardX * 0.28
    return [sideX - entity.x, sideZ - entity.z]
  }
  for (const angle of [0.48, -0.48, 0.82, -0.82, 1.12, -1.12].map((value) => value * preferredSide)) {
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const candidateX = forwardX * cosine - forwardZ * sine
    const candidateZ = forwardX * sine + forwardZ * cosine
    if (pathIsClear(obstacles, entity.x, entity.z, entity.x + candidateX * lookAhead, entity.z + candidateZ * lookAhead, radius)) {
      return [candidateX * length, candidateZ * length]
    }
  }
  return [targetX, targetZ]
}

function advanceAvoidingStaticObstacles(
  obstacles: GroundObstacleIndex,
  entity: SimEntity,
  directionX: number,
  directionZ: number,
  travel: number
): boolean {
  const radius = groundBodyRadius(entity)
  const length = Math.hypot(directionX, directionZ)
  if (radius === 0 || entity.rmfControlled || length < 0.000_1) {
    entity.x += directionX / Math.max(length, 1) * travel
    entity.z += directionZ / Math.max(length, 1) * travel
    return true
  }
  const forwardX = directionX / length
  const forwardZ = directionZ / length
  const preferredSide = (entity.index & 1) === 0 ? 1 : -1
  for (const angle of [0, 0.58 * preferredSide, -0.58 * preferredSide, 1.02 * preferredSide, -1.02 * preferredSide]) {
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const stepX = (forwardX * cosine - forwardZ * sine) * travel
    const stepZ = (forwardX * sine + forwardZ * cosine) * travel
    const nextX = entity.x + stepX
    const nextZ = entity.z + stepZ
    if (!pathIsClear(obstacles, entity.x, entity.z, nextX, nextZ, radius)) continue
    entity.x = nextX
    entity.z = nextZ
    return true
  }
  return false
}

function pathIsClear(
  obstacles: GroundObstacleIndex,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  radius: number
): boolean {
  return pathIsClearAmong(obstacles.alongSegment(fromX, fromZ, toX, toZ, radius), fromX, fromZ, toX, toZ, radius)
}

function pathIsClearAmong(
  obstacles: ReturnType<GroundObstacleIndex['alongSegment']>,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  radius: number
): boolean {
  return obstacles.every((obstacle) =>
    !circleIntersectsObstacle(toX, toZ, radius, obstacle) &&
    !sweptCircleIntersectsObstacle(fromX, fromZ, toX, toZ, radius, obstacle)
  )
}

function resolveStaticObstacleSpace(world: SimWorld): boolean {
  let anyCorrection = false
  for (const entity of world.entities) {
    const radius = groundBodyRadius(entity)
    if (radius === 0 || entity.rmfControlled) continue
    for (let pass = 0; pass < 3; pass++) {
      let corrected = false
      for (const obstacle of world.layout.groundObstacleIndex.aroundPoint(entity.x, entity.z, radius)) {
        if (!circleIntersectsObstacle(entity.x, entity.z, radius, obstacle)) continue
        const nearestX = Math.max(obstacle.centerX - obstacle.halfWidth, Math.min(entity.x, obstacle.centerX + obstacle.halfWidth))
        const nearestZ = Math.max(obstacle.centerZ - obstacle.halfDepth, Math.min(entity.z, obstacle.centerZ + obstacle.halfDepth))
        const deltaX = entity.x - nearestX
        const deltaZ = entity.z - nearestZ
        const distance = Math.hypot(deltaX, deltaZ)
        if (distance > 0.000_001) {
          const correction = radius - distance + 0.001
          entity.x += deltaX / distance * correction
          entity.z += deltaZ / distance * correction
        } else {
          const minX = obstacle.centerX - obstacle.halfWidth - radius
          const maxX = obstacle.centerX + obstacle.halfWidth + radius
          const minZ = obstacle.centerZ - obstacle.halfDepth - radius
          const maxZ = obstacle.centerZ + obstacle.halfDepth + radius
          const exits = [
            { distance: Math.abs(entity.x - minX), x: minX - 0.001, z: entity.z },
            { distance: Math.abs(maxX - entity.x), x: maxX + 0.001, z: entity.z },
            { distance: Math.abs(entity.z - minZ), x: entity.x, z: minZ - 0.001 },
            { distance: Math.abs(maxZ - entity.z), x: entity.x, z: maxZ + 0.001 }
          ].sort((left, right) => left.distance - right.distance)
          entity.x = exits[0]!.x
          entity.z = exits[0]!.z
        }
        corrected = true
        anyCorrection = true
      }
      if (!corrected) break
    }
  }
  return anyCorrection
}

function resolveGroundBodySpace(world: SimWorld, passes: number): boolean {
  let anyCorrection = false
  const bodies = world.entities.filter((entity) => groundBodyRadius(entity) > 0 && !entity.carriedById)
  const cellSize = 3
  for (let pass = 0; pass < passes; pass++) {
    const buckets = new Map<string, SimEntity[]>()
    for (const body of bodies) {
      const key = `${Math.floor(body.x / cellSize)},${Math.floor(body.z / cellSize)}`
      const bucket = buckets.get(key) ?? []
      bucket.push(body)
      buckets.set(key, bucket)
    }
    for (const left of bodies) {
      const cellX = Math.floor(left.x / cellSize)
      const cellZ = Math.floor(left.z / cellSize)
      for (let offsetX = -1; offsetX <= 1; offsetX++) for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
        for (const right of buckets.get(`${cellX + offsetX},${cellZ + offsetZ}`) ?? []) {
          if (right.index <= left.index || handledByDedicatedHumanSolver(left, right)) continue
          const minimum = groundBodyRadius(left) + groundBodyRadius(right) + 0.02
          const deltaX = right.x - left.x
          const deltaZ = right.z - left.z
          const distance = Math.hypot(deltaX, deltaZ)
          if (distance >= minimum) continue
          const angle = distance < 0.000_001
            ? ((left.index * 31 + right.index * 17) % 360) * Math.PI / 180
            : Math.atan2(deltaZ, deltaX)
          const normalX = Math.cos(angle)
          const normalZ = Math.sin(angle)
          const correction = minimum - distance + 0.001
          anyCorrection = true
          const leftFixed = fixedGroundBody(left)
          const rightFixed = fixedGroundBody(right)
          const leftPriority = groundBodyPriority(left)
          const rightPriority = groundBodyPriority(right)
          if (leftFixed && rightFixed) {
            // Local emergency stops may be issued in the same tick while two
            // simulated vehicles share a waypoint. Separate those local
            // bodies once; an external RMF pose remains authoritative.
            if (left.rmfControlled && right.rmfControlled) continue
            if (left.rmfControlled) {
              right.x += normalX * correction
              right.z += normalZ * correction
            } else if (right.rmfControlled) {
              left.x -= normalX * correction
              left.z -= normalZ * correction
            } else {
              left.x -= normalX * correction / 2
              left.z -= normalZ * correction / 2
              right.x += normalX * correction / 2
              right.z += normalZ * correction / 2
            }
            continue
          }
          if (leftFixed || (!rightFixed && leftPriority > rightPriority)) {
            right.x += normalX * correction
            right.z += normalZ * correction
          } else if (rightFixed || leftPriority < rightPriority) {
            left.x -= normalX * correction
            left.z -= normalZ * correction
          } else {
            left.x -= normalX * correction / 2
            left.z -= normalZ * correction / 2
            right.x += normalX * correction / 2
            right.z += normalZ * correction / 2
          }
        }
      }
    }
  }
  return anyCorrection
}

function handledByDedicatedHumanSolver(left: SimEntity, right: SimEntity): boolean {
  return (left.kind === 'person' && right.kind === 'person') ||
    ((left.kind === 'person' && right.kind === 'humanoid') || (left.kind === 'humanoid' && right.kind === 'person'))
}

function groundBodyPriority(entity: SimEntity): number {
  if (entity.kind === 'igv' && entity.mission === 'medical-transport' && entity.auxA > 0.5) return 4
  if (entity.kind === 'person') return 3
  if (entity.kind === 'humanoid') return 2
  return 1
}

function fixedGroundBody(entity: SimEntity): boolean {
  if (entity.rmfControlled || entity.behavior === 'halt' || entity.status === 'error' || (entity.trafficSpeedLimit === 0 && entity.speed === 0)) return true
  if (entity.kind === 'humanoid') return entity.activity === 'safeStop' || ['observing', 'manipulating', 'reporting'].includes(entity.activity ?? '')
  if (entity.kind === 'person') return fixedPerson(entity) || ['receivingKit', 'treating', 'gasSpotting'].includes(entity.personActivity ?? '')
  return false
}

function orientMusteredPerson(world: SimWorld, person: SimEntity, dt: number): void {
  // Mustered workers face the facility-side exit/check-in point instead of
  // freezing at whichever heading happened to reach their slot.
  const targetYaw = world.musterCheckInYaw(person)
  if (targetYaw === undefined) return
  const yawDelta = Math.atan2(Math.sin(targetYaw - person.yaw), Math.cos(targetYaw - person.yaw))
  person.yaw += Math.sign(yawDelta) * Math.min(Math.abs(yawDelta), 1.8 * dt)
}

function stationaryGroundRobotSteering(
  facilityObstacles: GroundObstacleIndex,
  stationaryRobots: readonly SimEntity[],
  entity: SimEntity,
  targetX: number,
  targetZ: number
): readonly [number, number] {
  if (entity.kind !== 'person' && entity.kind !== 'humanoid') return [targetX, targetZ]
  const targetLength = Math.hypot(targetX, targetZ)
  if (!Number.isFinite(targetLength) || targetLength < 0.05) return [targetX, targetZ]
  if (
    entity.avoidanceObstacleId !== undefined &&
    entity.avoidanceX !== undefined &&
    entity.avoidanceZ !== undefined
  ) {
    const obstacleStillPresent = stationaryRobots.some((robot) => robot.id === entity.avoidanceObstacleId)
    const remaining = Math.hypot(entity.avoidanceX - entity.x, entity.avoidanceZ - entity.z)
    if (obstacleStillPresent && remaining > 0.28) {
      return [entity.avoidanceX - entity.x, entity.avoidanceZ - entity.z]
    }
    entity.avoidanceObstacleId = undefined
    entity.avoidanceX = undefined
    entity.avoidanceZ = undefined
  }
  const forwardX = targetX / targetLength
  const forwardZ = targetZ / targetLength
  const sideX = -forwardZ
  const sideZ = forwardX
  const nearbyStationaryRobots = stationaryRobots.filter((robot) =>
    robot !== entity && Math.hypot(robot.x - entity.x, robot.z - entity.z) < 6
  )
  const obstacles = nearbyStationaryRobots
    .map((robot) => {
      const dx = robot.x - entity.x
      const dz = robot.z - entity.z
      return {
        robot,
        longitudinal: dx * forwardX + dz * forwardZ,
        lateral: dx * sideX + dz * sideZ
      }
    })
    .filter(({ robot, longitudinal, lateral }) =>
      longitudinal > 0.08 &&
      longitudinal < 3.2 &&
      Math.abs(lateral) < groundBodyRadius(entity) + groundBodyRadius(robot) + 0.72
    )
    .sort((left, right) => left.longitudinal - right.longitudinal)
  const obstacle = obstacles[0]
  if (!obstacle) return [targetX, targetZ]
  const sideSign = Math.abs(obstacle.lateral) > 0.04
    ? -Math.sign(obstacle.lateral)
    : ((entity.index + obstacle.robot.index) & 1) === 0 ? -1 : 1
  const clearance = groundBodyRadius(entity) + groundBodyRadius(obstacle.robot) + 0.42
  const sideOrder = [sideSign, -sideSign]
  if (obstacle.longitudinal < 1.35) for (const offset of [clearance, clearance + 0.65, clearance + 1.3]) {
    for (const direction of sideOrder) {
      // First commit to a clear lateral lane beside the body. Once this
      // waypoint is reached the parked robot falls outside the forward
      // corridor and the original route naturally carries the agent past it.
      const lateralTravel = direction * offset + obstacle.lateral
      const candidateX = entity.x + sideX * lateralTravel + forwardX * 0.1
      const candidateZ = entity.z + sideZ * lateralTravel + forwardZ * 0.1
      const hasBodyClearance = nearbyStationaryRobots.every((robot) =>
        Math.hypot(candidateX - robot.x, candidateZ - robot.z) >=
          groundBodyRadius(entity) + groundBodyRadius(robot) + 0.18
      )
      if (
        hasBodyClearance &&
        pathIsClearOfStationaryRobots(entity, candidateX, candidateZ, nearbyStationaryRobots) &&
        pathIsClear(facilityObstacles, entity.x, entity.z, candidateX, candidateZ, groundBodyRadius(entity))
      ) {
        entity.avoidanceObstacleId = obstacle.robot.id
        entity.avoidanceX = candidateX
        entity.avoidanceZ = candidateZ
        return [candidateX - entity.x, candidateZ - entity.z]
      }
    }
  }
  const strength =
    (1 - Math.max(0, obstacle.longitudinal) / 3.2) *
    (1 - Math.abs(obstacle.lateral) / (groundBodyRadius(entity) + groundBodyRadius(obstacle.robot) + 0.72)) *
    1.7
  return [
    forwardX + sideX * sideSign * strength,
    forwardZ + sideZ * sideSign * strength
  ]
}

function pathIsClearOfStationaryRobots(
  entity: SimEntity,
  toX: number,
  toZ: number,
  robots: readonly SimEntity[]
): boolean {
  const segmentX = toX - entity.x
  const segmentZ = toZ - entity.z
  const lengthSquared = segmentX ** 2 + segmentZ ** 2
  return robots.every((robot) => {
    const projection = lengthSquared < 0.000_001
      ? 0
      : Math.max(0, Math.min(1, ((robot.x - entity.x) * segmentX + (robot.z - entity.z) * segmentZ) / lengthSquared))
    const closestX = entity.x + segmentX * projection
    const closestZ = entity.z + segmentZ * projection
    const clearance = groundBodyRadius(entity) + groundBodyRadius(robot) + 0.01
    return Math.hypot(robot.x - closestX, robot.z - closestZ) >= clearance
  })
}

function stationaryRobotOnPath(
  entity: SimEntity,
  toX: number,
  toZ: number,
  robots: readonly SimEntity[]
): SimEntity | undefined {
  const segmentX = toX - entity.x
  const segmentZ = toZ - entity.z
  const lengthSquared = segmentX ** 2 + segmentZ ** 2
  if (!Number.isFinite(lengthSquared) || lengthSquared < 0.000_001) return undefined
  return robots
    .filter((robot) => robot !== entity)
    .map((robot) => {
      const projection = Math.max(0, Math.min(1,
        ((robot.x - entity.x) * segmentX + (robot.z - entity.z) * segmentZ) / lengthSquared
      ))
      const closestX = entity.x + segmentX * projection
      const closestZ = entity.z + segmentZ * projection
      return {
        robot,
        projection,
        clearance: Math.hypot(robot.x - closestX, robot.z - closestZ) -
          groundBodyRadius(entity) - groundBodyRadius(robot)
      }
    })
    .filter(({ projection, clearance }) => projection < 0.75 && clearance < 0.18)
    .sort((left, right) => left.projection - right.projection || left.clearance - right.clearance)[0]?.robot
}

function resolvePersonalSpace(world: SimWorld): void {
  const people = world.entities.filter((entity) => entity.kind === 'person' && !entity.carriedById)
  const minimum = 0.42
  for (let pass = 0; pass < 3; pass++) {
    for (let leftIndex = 0; leftIndex < people.length; leftIndex++) {
      const left = people[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < people.length; rightIndex++) {
        const right = people[rightIndex]!
        const dx = right.x - left.x
        const dz = right.z - left.z
        const distance = Math.hypot(dx, dz)
        if (distance >= minimum) continue
        let nx: number
        let nz: number
        if (distance < 0.0001) {
          const angle = ((left.index * 31 + right.index * 17) % 360) * Math.PI / 180
          nx = Math.cos(angle)
          nz = Math.sin(angle)
        } else {
          nx = dx / distance
          nz = dz / distance
        }
        const correction = minimum - distance
        const leftFixed = fixedPerson(left)
        const rightFixed = fixedPerson(right)
        if (!leftFixed && !rightFixed) {
          const leftSide = lateralAway(left, right, -nx, -nz)
          const rightSide = lateralAway(right, left, nx, nz)
          left.x += leftSide[0] * correction / 2; left.z += leftSide[1] * correction / 2
          right.x += rightSide[0] * correction / 2; right.z += rightSide[1] * correction / 2
        } else if (!leftFixed) {
          const side = lateralAway(left, right, -nx, -nz)
          left.x += side[0] * correction; left.z += side[1] * correction
        } else if (!rightFixed) {
          const side = lateralAway(right, left, nx, nz)
          right.x += side[0] * correction; right.z += side[1] * correction
        }
      }
    }
  }
  const hardMinimum = 0.3
  // A later pair correction can compress an earlier pair in a dense queue.
  // Iterate the hard projection so the final pose, not only the first pass,
  // respects the physical body envelope.
  for (let pass = 0; pass < 4; pass++) {
    for (let leftIndex = 0; leftIndex < people.length; leftIndex++) {
      const left = people[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < people.length; rightIndex++) {
        const right = people[rightIndex]!
        const dx = right.x - left.x
        const dz = right.z - left.z
        const distance = Math.hypot(dx, dz)
        if (distance >= hardMinimum) continue
        let nx: number
        let nz: number
        if (distance < 0.0001) {
          const angle = ((left.index * 31 + right.index * 17) % 360) * Math.PI / 180
          nx = Math.cos(angle); nz = Math.sin(angle)
        } else {
          nx = dx / distance
          nz = dz / distance
        }
        const correction = hardMinimum - distance
        const leftFixed = fixedPerson(left)
        const rightFixed = fixedPerson(right)
        if (!leftFixed && !rightFixed) {
          left.x -= nx * correction / 2; left.z -= nz * correction / 2
          right.x += nx * correction / 2; right.z += nz * correction / 2
        } else if (!leftFixed) {
          left.x -= nx * correction; left.z -= nz * correction
        } else if (!rightFixed) {
          right.x += nx * correction; right.z += nz * correction
        }
      }
    }
  }
}

function resolveHumanRobotSpace(world: SimWorld): void {
  const people = world.entities.filter((entity) => entity.kind === 'person' && !entity.carriedById)
  const robots = world.entities.filter((entity) => entity.kind === 'humanoid')
  const minimum = 0.68
  for (let pass = 0; pass < 3; pass++) {
    for (const person of people) for (const robot of robots) {
      const dx = person.x - robot.x
      const dz = person.z - robot.z
      const distance = Math.hypot(dx, dz)
      if (distance >= minimum) continue
      const angle = distance < 0.0001
        ? ((person.index * 31 + robot.index * 17) % 360) * Math.PI / 180
        : Math.atan2(dz, dx)
      const nx = Math.cos(angle)
      const nz = Math.sin(angle)
      const correction = minimum - distance
      const robotFixed =
        robot.rmfControlled ||
        robot.activity === 'safeStop' ||
        ['observing', 'manipulating', 'reporting'].includes(robot.activity ?? '')
      const personFixed =
        fixedPerson(person) ||
        person.personActivity === 'receivingKit' ||
        person.personActivity === 'treating' ||
        person.personActivity === 'gasSpotting'
      if (robotFixed && personFixed) {
        const anchoredRobot =
          robot.rmfControlled ||
          ['observing', 'manipulating', 'reporting'].includes(robot.activity ?? '')
        if (anchoredRobot && person.personActivity !== 'collapsed') {
          person.x += nx * correction
          person.z += nz * correction
        } else if (!robot.rmfControlled) {
          robot.x -= nx * correction
          robot.z -= nz * correction
        }
      } else if (robotFixed && !personFixed) {
        person.x += nx * correction
        person.z += nz * correction
      } else if (personFixed && !robotFixed) {
        robot.x -= nx * correction
        robot.z -= nz * correction
      } else if (!robotFixed) {
        // People retain right of way during normal shared-corridor movement.
        robot.x -= nx * correction
        robot.z -= nz * correction
      } else if (!personFixed) {
        person.x += nx * correction
        person.z += nz * correction
      }
    }
  }
}

function fixedPerson(person: SimEntity): boolean {
  return person.personActivity === 'collapsed' ||
    (person.role === 'responder' && person.behavior === 'respond') ||
    (person.behavior === 'evacuate' && person.status === 'waiting' && person.route.length === 0 && person.targetX === person.x && person.targetZ === person.z)
}

function lateralAway(entity: SimEntity, other: SimEntity, fallbackX: number, fallbackZ: number): readonly [number, number] {
  const forwardX = entity.targetX - entity.x
  const forwardZ = entity.targetZ - entity.z
  const length = Math.hypot(forwardX, forwardZ)
  if (!Number.isFinite(length) || length < 0.05) return [fallbackX, fallbackZ]
  let sideX = -forwardZ / length
  let sideZ = forwardX / length
  const awayX = entity.x - other.x
  const awayZ = entity.z - other.z
  if (sideX * awayX + sideZ * awayZ < 0) { sideX = -sideX; sideZ = -sideZ }
  return [sideX, sideZ]
}
