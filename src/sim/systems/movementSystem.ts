import type { SimWorld } from '../world'
import type { SimEntity } from '../types'

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

function chooseTarget(world: SimWorld, entity: SimEntity): void {
  const graph = entity.kind === 'oht' ? world.layout.railGraph : entity.kind === 'person' || entity.kind === 'humanoid' ? world.layout.walkGraph : world.layout.roadGraph
  let [x, z] = destination(world, entity)
  const from = graph.nearest(entity.x, entity.z)
  const to = graph.nearest(x, z)
  const authorizedResponse = entity.behavior === 'respond' || (entity.kind === 'humanoid' && entity.emergency)
  entity.route = graph.findPath(from, to, authorizedResponse ? new Map() : world.hazardLevels)
  if (entity.route.length === 0 && entity.kind === 'person' && entity.behavior === 'evacuate') {
    entity.route = world.assignEvacuationMuster(entity, true)
    ;[x, z] = destination(world, entity)
  }
  if (entity.route.length === 0) {
    entity.speed = 0
    entity.status = 'waiting'
    entity.targetX = entity.x
    entity.targetZ = entity.z
    return
  }
  entity.routeCursor = Math.min(1, entity.route.length - 1)
  const target = graph.nodes[entity.route[entity.routeCursor]!] ?? { x, z }
  entity.targetX = target.x; entity.targetZ = target.z; entity.targetIndex = (entity.targetIndex + 1 + world.rng.int(0, 4)) % Math.max(1, graph.nodes.length)
  entity.targetDelay = entity.kind === 'person' && entity.behavior === 'normal' && entity.personActivity === 'patrol' && world.rng.next() < 0.14
    ? world.rng.range(0.5, 2.5)
    : 0
}

export function updateMovement(world: SimWorld, dt: number): void {
  const stationaryHumanoids = world.entities.filter((entity) =>
    entity.kind === 'humanoid' &&
    (
      entity.rmfControlled ||
      entity.activity === 'safeStop' ||
      (entity.speed < 0.05 && entity.status !== 'moving')
    )
  )
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
        : 0.5
    if (distance < arrivalThreshold || !Number.isFinite(entity.targetX)) {
      const graph = entity.kind === 'oht' ? world.layout.railGraph : entity.kind === 'person' || entity.kind === 'humanoid' ? world.layout.walkGraph : world.layout.roadGraph
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
      if (entity.routeCursor < entity.route.length - 1) { entity.routeCursor++; const node = graph.nodes[entity.route[entity.routeCursor]!]!; entity.targetX = node.x; entity.targetZ = node.z }
      else if (entity.kind === 'humanoid' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.kind === 'person' && entity.behavior === 'evacuate' && entity.route.length > 0 && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.03) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ }
      else if (entity.kind === 'person' && entity.personActivity === 'walkingToWork' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.kind === 'person' && entity.personActivity === 'returningToStation' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.2) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.kind === 'person' && entity.personActivity === 'yieldingToRobot' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (!rendezvous && entity.kind === 'person' && ['fireApproach', 'fireSuppressing', 'medicalApproach', 'gasPerimeter'].includes(entity.personActivity ?? '') && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.kind === 'person' && entity.manualGasRole && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.03) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.kind === 'person' && entity.gasSpotterTaskId && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.03) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.behavior === 'yield' && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.mission === 'medical-transport' && world.medicalResponse?.stage === 'transporting') { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
      else if (rendezvous) { entity.targetX = rendezvous[0]; entity.targetZ = rendezvous[1]; entity.route = []; entity.routeCursor = 0 }
      else if (entity.behavior === 'respond' && world.emergency.hazard) { entity.targetX = world.emergency.hazard.sourceX; entity.targetZ = world.emergency.hazard.sourceZ; entity.route = []; entity.routeCursor = 0 }
      else if (entity.mission && Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ) > 0.3) { entity.targetX = entity.goalX; entity.targetZ = entity.goalZ; entity.route = []; entity.routeCursor = 0 }
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
    const steering = humanStationaryRobotSteering(stationaryHumanoids, entity, toX, toZ)
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
    if (formationApproach) {
      entity.x += toX / remaining * travel
      entity.z += toZ / remaining * travel
    } else {
      entity.x += Math.cos(entity.yaw) * travel
      entity.z += Math.sin(entity.yaw) * travel
    }
    entity.status = 'moving'; entity.animation = entity.kind === 'person' ? (entity.behavior === 'evacuate' || entity.behavior === 'respond' ? 2 : 1) : 1
  }
  resolvePersonalSpace(world)
  resolveHumanRobotSpace(world)
}

function orientMusteredPerson(world: SimWorld, person: SimEntity, dt: number): void {
  // Mustered workers face the facility-side exit/check-in point instead of
  // freezing at whichever heading happened to reach their slot.
  const targetYaw = world.musterCheckInYaw(person)
  if (targetYaw === undefined) return
  const yawDelta = Math.atan2(Math.sin(targetYaw - person.yaw), Math.cos(targetYaw - person.yaw))
  person.yaw += Math.sign(yawDelta) * Math.min(Math.abs(yawDelta), 1.8 * dt)
}

function humanStationaryRobotSteering(
  stationaryHumanoids: readonly SimEntity[],
  entity: SimEntity,
  targetX: number,
  targetZ: number
): readonly [number, number] {
  if (entity.kind !== 'person') return [targetX, targetZ]
  const targetLength = Math.hypot(targetX, targetZ)
  if (!Number.isFinite(targetLength) || targetLength < 0.05) return [targetX, targetZ]
  const forwardX = targetX / targetLength
  const forwardZ = targetZ / targetLength
  const sideX = -forwardZ
  const sideZ = forwardX
  const obstacle = stationaryHumanoids
    .map((robot) => {
      const dx = robot.x - entity.x
      const dz = robot.z - entity.z
      return {
        robot,
        longitudinal: dx * forwardX + dz * forwardZ,
        lateral: dx * sideX + dz * sideZ
      }
    })
    .filter(({ longitudinal, lateral }) =>
      longitudinal > -0.05 &&
      longitudinal < 1.8 &&
      Math.abs(lateral) < 0.9
    )
    .sort((left, right) => left.longitudinal - right.longitudinal)[0]
  if (!obstacle) return [targetX, targetZ]
  const sideSign = Math.abs(obstacle.lateral) > 0.04
    ? -Math.sign(obstacle.lateral)
    : ((entity.index + obstacle.robot.index) & 1) === 0 ? -1 : 1
  const strength =
    (1 - Math.max(0, obstacle.longitudinal) / 1.8) *
    (1 - Math.abs(obstacle.lateral) / 0.9) *
    1.45
  return [
    forwardX + sideX * sideSign * strength,
    forwardZ + sideZ * sideSign * strength
  ]
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
        person.personActivity === 'collapsed' ||
        person.personActivity === 'receivingKit' ||
        person.personActivity === 'treating' ||
        person.personActivity === 'gasSpotting'
      if (robotFixed && !personFixed) {
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
