import { describe, expect, it } from 'vitest'
import layoutJson from '../data/layouts/fab-default.json'
import fireJson from '../data/scenarios/fire.json'
import medicalJson from '../data/scenarios/medical.json'
import { FabLayoutSchema, ScenarioSchema } from '../src/core/schema'
import { updateTraffic } from '../src/sim/systems/trafficSystem'
import { evacuationFlowSteering, groundBodyRadius, staticObstacleSteering, updateMovement } from '../src/sim/systems/movementSystem'
import { SimWorld } from '../src/sim/world'
import { gasValveGripTarget } from '../src/core/interactionGeometry'
import { POSE_STRIDE, PoseFlags, PoseSlot } from '../src/core/protocol'
import { circleIntersectsObstacle } from '../src/core/layout'

const layout = FabLayoutSchema.parse(layoutJson)
const snapshot = (world: SimWorld) => [...new Float32Array(world.poseSnapshot().buffer)]

describe('SimWorld', () => {
  it('is bit-for-bit deterministic for the same layout, seed, and ticks', () => {
    const first = new SimWorld(layout, 1004); const second = new SimWorld(layout, 1004)
    for (let tick = 0; tick < 300; tick++) { first.tick(1 / 60); second.tick(1 / 60) }
    expect(snapshot(first)).toEqual(snapshot(second))
  })
  it('assigns a globally unique runtime id to every entity', () => {
    const world = new SimWorld(layout, 1005)
    expect(new Set(world.entities.map((entity) => entity.id)).size).toBe(world.entities.length)
  })
  it('spawns humanoids at distinct operational staging points', () => {
    const world = new SimWorld(layout, 1006)
    const humanoids = world.entities.filter((entity) => entity.kind === 'humanoid')
    expect(humanoids).toHaveLength(2)
    expect(Math.hypot(humanoids[0]!.x - humanoids[1]!.x, humanoids[0]!.z - humanoids[1]!.z)).toBeGreaterThan(20)
    expect(humanoids.map((entity) => [entity.homeX, entity.homeZ])).toEqual(layout.population.humanoidStations.map((station) => [station[0], station[2]]))
    const vehicles = world.entities.filter((entity) => entity.kind === 'agv' || entity.kind === 'igv')
    expect(humanoids.every((robot) => vehicles.every((vehicle) =>
      Math.hypot(robot.x - vehicle.x, robot.z - vehicle.z) >= groundBodyRadius(robot) + groundBodyRadius(vehicle) + 0.4
    ))).toBe(true)
  })
  it('spawns ground vehicles without overlapping body envelopes', () => {
    const world = new SimWorld(layout, 1009)
    const vehicles = world.entities.filter((entity) => entity.kind === 'agv' || entity.kind === 'igv')
    for (let left = 0; left < vehicles.length; left++) for (let right = left + 1; right < vehicles.length; right++) {
      expect(Math.hypot(
        vehicles[left]!.x - vehicles[right]!.x,
        vehicles[left]!.z - vehicles[right]!.z
      )).toBeGreaterThanOrEqual(
        groundBodyRadius(vehicles[left]!) + groundBodyRadius(vehicles[right]!) + 0.05 - 1e-9
      )
    }
  })
  it('stages two-person response coverage near every safety-device region', () => {
    const world = new SimWorld(layout, 1007)
    const responders = world.entities.filter((entity) => entity.kind === 'person' && entity.role === 'responder')
    expect(responders).toHaveLength(layout.population.responderStations.length)
    for (const station of layout.population.responderStations) {
      expect(Math.min(...responders.map((person) => Math.hypot(person.homeX - station[0], person.homeZ - station[2])))).toBeLessThan(3.1)
    }
    for (const device of layout.emergency.safetyDevices) {
      const distances = responders
        .map((person) => Math.hypot(person.homeX - device.position[0], person.homeZ - device.position[2]))
        .sort((left, right) => left - right)
      expect(distances[1]).toBeLessThan(40)
    }
  })
  it('keeps emergency responders ready at their stations instead of assigning production inspections', () => {
    const world = new SimWorld(layout, 1008)
    const responders = world.entities.filter((entity) => entity.kind === 'person' && entity.role === 'responder')
    for (let tick = 0; tick < 30 * 60; tick++) world.tick(1 / 60)
    expect(responders.every((person) =>
      person.behavior === 'normal' &&
      person.personActivity === 'idle' &&
      person.workTargetId === undefined &&
      Math.hypot(person.x - person.homeX, person.z - person.homeZ) < 0.2
    )).toBe(true)
  })
  it('stops a following vehicle inside the configured 5.1m headway', () => {
    const world = new SimWorld(layout, 99)
    const follower = world.entities.find((entity) => entity.kind === 'agv')!
    const leader = world.entities.filter((entity) => entity.kind === 'agv')[1]!
    follower.x = 0; follower.z = 0; follower.yaw = 0; follower.speed = follower.maxSpeed
    leader.x = 5; leader.z = 0; leader.speed = 0
    updateTraffic(world)
    expect(follower.speed).toBe(0)
  })
  it('carries the traffic stop directive through movement integration', () => {
    const world = new SimWorld(layout, 98)
    const follower = world.entities.find((entity) => entity.kind === 'agv')!
    const leader = world.entities.filter((entity) => entity.kind === 'agv')[1]!
    follower.x = 10; follower.z = 0; follower.yaw = 0; follower.speed = follower.maxSpeed; follower.targetX = 20; follower.targetZ = 0
    leader.x = 14; leader.z = 0; leader.behavior = 'halt'; leader.targetX = 14; leader.targetZ = 0
    world.tick(1 / 60)
    expect(follower.x).toBe(10)
    expect(follower.trafficSpeedLimit).toBe(0)
  })
  it('clears OHTs to reachable rail-side parking instead of halting them in place for a gas leak', () => {
    const world = new SimWorld(layout, 96)
    const ohts = world.entities.filter((entity) => entity.kind === 'oht')
    const origin = new Map(ohts.map((entity) => [entity.id, [entity.x, entity.z] as const]))
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    const hazard = world.emergency.hazard!
    expect(ohts.every((entity) =>
      entity.behavior === 'yield' &&
      Math.hypot(entity.goalX - hazard.sourceX, entity.goalZ - hazard.sourceZ) > hazard.maxRadius * 1.8 + 4.9
    )).toBe(true)
    for (let tick = 0; tick < 5 * 60; tick++) world.tick(1 / 60)
    expect(ohts.some((entity) => {
      const start = origin.get(entity.id)!
      return Math.hypot(entity.x - start[0], entity.z - start[1]) > 0.2
    })).toBe(true)
    expect(ohts.some((entity) => entity.behavior === 'halt')).toBe(false)
  })
  it('reserves separated ground-robot parking nodes during a gas evacuation', () => {
    const world = new SimWorld(layout, 961)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    const parked = world.entities.filter((entity) =>
      ['agv', 'igv'].includes(entity.kind) && entity.behavior === 'yield'
    )
    const humanoids = world.entities.filter((entity) => entity.kind === 'humanoid')
    expect(parked.every((vehicle) => humanoids.every((robot) =>
      Math.hypot(vehicle.goalX - robot.x, vehicle.goalZ - robot.z) >= 3 - 1e-9
    ))).toBe(true)
    for (let left = 0; left < parked.length; left++) for (let right = left + 1; right < parked.length; right++) {
      expect(Math.hypot(
        parked[left]!.goalX - parked[right]!.goalX,
        parked[left]!.goalZ - parked[right]!.goalZ
      )).toBeGreaterThanOrEqual(2.2 - 1e-9)
    }
  })
  it('lets a yielding responder step away from an emergency vehicle to break a safe-stop deadlock', () => {
    const world = new SimWorld(layout, 97)
    const vehicle = world.entities.find((entity) => entity.kind === 'igv')!
    const responder = world.entities.find((entity) => entity.kind === 'person' && entity.role === 'responder')!
    vehicle.x = 0; vehicle.z = 0; vehicle.yaw = 0; vehicle.behavior = 'respond'; vehicle.mission = 'medical-transport'
    responder.x = 0.6; responder.z = 0; responder.yaw = Math.PI; responder.behavior = 'yield'; responder.goalX = 5; responder.goalZ = 0; responder.auxB = 1
    updateTraffic(world)
    expect(responder.trafficSpeedLimit).toBeGreaterThan(0)
    expect(vehicle.trafficSpeedLimit).toBe(0)
  })
  it('keeps operator-dispatched gas robots behind evacuees in a shared egress lane', () => {
    const world = new SimWorld(layout, 971)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    world.tick(1 / 60)
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'gas_isolation')!
    const robot = world.entities.find((entity) => entity.id === task.robotId)!
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')!
    for (const entity of world.entities) {
      if (entity === person || entity === robot || entity.kind === 'arm') continue
      entity.x = 500 + entity.index * 4
      entity.z = 500
    }
    robot.x = 0
    robot.z = 0
    robot.yaw = 0
    person.x = 0.8
    person.z = 0
    updateTraffic(world)
    expect(robot.trafficSpeedLimit).toBe(0)

    task.requestedBy = 'showcase'
    updateTraffic(world)
    expect(robot.trafficSpeedLimit).toBeGreaterThan(0)
  })
  it('keeps an evacuee outside a safe-stopped humanoid body without moving the robot authority pose', () => {
    const world = new SimWorld(layout, 972)
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')!
    const robot = world.entities.find((entity) => entity.kind === 'humanoid')!
    person.x = 200
    person.z = 200
    person.yaw = 0
    person.speed = 1
    person.behavior = 'evacuate'
    person.personActivity = 'evacuating'
    person.reactionUntil = 0
    person.targetX = 210
    person.targetZ = 200
    person.goalX = 210
    person.goalZ = 200
    robot.x = 200.4
    robot.z = 200
    robot.speed = 0
    robot.status = 'waiting'
    robot.activity = 'safeStop'
    const robotPose = [robot.x, robot.z]
    world.tick(1 / 60)
    expect(Math.hypot(person.x - robot.x, person.z - robot.z)).toBeGreaterThanOrEqual(0.68 - 1e-9)
    expect([robot.x, robot.z]).toEqual(robotPose)
    expect(person.trafficSpeedLimit).toBeLessThanOrEqual(person.maxSpeed * 0.12 + 1e-9)
  })
  it('treats a standby humanoid as stationary even when its prior moving status is stale', () => {
    const world = new SimWorld(layout, 973)
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')!
    const robot = world.entities.find((entity) => entity.kind === 'humanoid')!
    for (const entity of world.entities) {
      if (entity === person || entity === robot || entity.kind === 'arm') continue
      entity.x = 500 + entity.index * 4
      entity.z = 500
    }
    person.x = 0
    person.z = 0
    person.yaw = 0
    person.behavior = 'evacuate'
    robot.x = 1.8
    robot.z = 0
    robot.speed = 0
    robot.status = 'moving'
    robot.activity = 'standby'
    robot.emergency = true
    updateTraffic(world)
    expect(person.trafficSpeedLimit).toBeGreaterThan(0)
    expect(person.trafficSpeedLimit).toBeLessThan(person.maxSpeed)
  })
  it('re-plans around a graph waypoint occupied by a stationary ground robot', () => {
    const world = new SimWorld(layout, 976)
    const graph = world.layout.walkGraph
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator')!
    const robot = world.entities.find((entity) => entity.kind === 'agv')!
    for (const entity of world.entities.filter((candidate) =>
      candidate !== robot && ['agv', 'igv', 'humanoid'].includes(candidate.kind)
    )) {
      entity.x = 500 + entity.index * 3
      entity.z = 500
    }
    const detour = graph.nodes
      .map((_, index) => ({ index, neighbors: graph.edges[index]!.map((edge) => edge.to) }))
      .find(({ index, neighbors }) =>
        neighbors.length >= 3 &&
        neighbors.some((from) => neighbors.some((to) =>
          from !== to && graph.findPath(from, to, new Map(), new Set([index])).length > 0
        ))
      )!
    const from = detour.neighbors[0]!
    const to = detour.neighbors.find((candidate) =>
      candidate !== from && graph.findPath(from, candidate, new Map(), new Set([detour.index])).length > 0
    )!
    const start = graph.nodes[from]!
    const occupied = graph.nodes[detour.index]!
    const goal = graph.nodes[to]!
    const approachX = occupied.x - start.x
    const approachZ = occupied.z - start.z
    const approachLength = Math.max(0.001, Math.hypot(approachX, approachZ))
    person.x = occupied.x - approachX / approachLength * 2
    person.z = occupied.z - approachZ / approachLength * 2
    person.behavior = 'normal'
    person.personActivity = 'walkingToWork'
    person.goalX = goal.x
    person.goalZ = goal.z
    person.route = [from, detour.index, to]
    person.routeCursor = 1
    person.targetX = occupied.x
    person.targetZ = occupied.z
    person.navigationBestDistance = 0
    person.navigationLastProgressAt = world.simTime - 5
    robot.x = occupied.x
    robot.z = occupied.z
    robot.speed = 0
    robot.behavior = 'halt'
    robot.status = 'waiting'

    world.tick(1 / 60)

    expect(person.route.length).toBeGreaterThan(0)
    expect(person.route).not.toContain(detour.index)
    expect(Number.isFinite(person.targetX)).toBe(true)
  })
  it('steers laterally around a facility column without crossing its physical boundary', () => {
    const world = new SimWorld(layout, 973)
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator')!
    for (const entity of world.entities.filter((candidate) => groundBodyRadius(candidate) > 0 && candidate !== person)) {
      entity.x = 500 + entity.index * 3
      entity.z = 500
    }
    const column = world.layout.groundObstacles.find((obstacle) => obstacle.id === 'column:-96:-96')!
    person.x = -96
    person.z = -93
    person.yaw = -Math.PI / 2
    person.speed = person.maxSpeed
    person.personActivity = 'walkingToWork'
    person.goalX = -96
    person.goalZ = -101
    person.targetX = person.goalX
    person.targetZ = person.goalZ
    person.route = []
    let maximumLateralOffset = 0
    for (let tick = 0; tick < 360 && person.z > -97; tick++) {
      person.trafficSpeedLimit = person.maxSpeed
      updateMovement(world, 1 / 60)
      maximumLateralOffset = Math.max(maximumLateralOffset, Math.abs(person.x + 96))
      expect(circleIntersectsObstacle(person.x, person.z, groundBodyRadius(person), column)).toBe(false)
    }
    expect(person.z).toBeLessThanOrEqual(-97)
    expect(maximumLateralOffset).toBeGreaterThan(0.25)
  })
  it('projects overlapping ground robots apart using their body envelopes', () => {
    const world = new SimWorld(layout, 974)
    const robots = world.entities.filter((entity) => entity.kind === 'agv').slice(0, 2)
    for (const [index, robot] of robots.entries()) {
      robot.x = 200
      robot.z = 200
      robot.speed = 0
      robot.targetX = 210
      robot.targetZ = 200 + index
      robot.goalX = robot.targetX
      robot.goalZ = robot.targetZ
    }
    updateMovement(world, 1 / 60)
    expect(Math.hypot(robots[0]!.x - robots[1]!.x, robots[0]!.z - robots[1]!.z)).toBeGreaterThanOrEqual(
      groundBodyRadius(robots[0]!) + groundBodyRadius(robots[1]!)
    )
  })
  it('marks humanoids as baton-equipped evacuation guides only during an active evacuation incident', () => {
    const world = new SimWorld(layout, 975)
    world.triggerEmergency('fire')
    world.setPhase('alarm')
    world.tick(1 / 60)
    const activePose = new Float32Array(world.poseSnapshot().buffer)
    const humanoids = world.entities.filter((entity) => entity.kind === 'humanoid')
    expect(humanoids.every((entity) =>
      (activePose[entity.index * POSE_STRIDE + PoseSlot.FLAGS]! & PoseFlags.EVACUATION_GUIDE) !== 0
    )).toBe(true)

    world.finishEmergency()
    world.tick(1 / 60)
    const normalPose = new Float32Array(world.poseSnapshot().buffer)
    expect(humanoids.every((entity) =>
      (normalPose[entity.index * POSE_STRIDE + PoseSlot.FLAGS]! & PoseFlags.EVACUATION_GUIDE) === 0
    )).toBe(true)
  })
  it('advances a crowd through a shared graph waypoint without violating personal space', () => {
    const world = new SimWorld(layout, 971)
    const graph = world.layout.walkGraph
    const waypointIndex = graph.edges.findIndex((neighbors) => neighbors.length > 0)
    const nextIndex = graph.edges[waypointIndex]![0]!.to
    const waypoint = graph.nodes[waypointIndex]!
    const next = graph.nodes[nextIndex]!
    const people = world.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder').slice(0, 4)
    people.forEach((person, index) => {
      const angle = index / people.length * Math.PI * 2
      person.x = waypoint.x + Math.cos(angle) * 0.3
      person.z = waypoint.z + Math.sin(angle) * 0.3
      person.behavior = 'evacuate'
      person.personActivity = 'evacuating'
      person.reactionUntil = 0
      person.route = [waypointIndex, nextIndex]
      person.routeCursor = 0
      person.targetX = waypoint.x
      person.targetZ = waypoint.z
      person.goalX = next.x
      person.goalZ = next.z
    })
    world.tick(1 / 60)
    expect(people.every((person) => person.routeCursor === 1)).toBe(true)
  })
  it('enters an alarm phase and assigns evacuation behavior', () => {
    const world = new SimWorld(layout, 77)
    world.triggerEmergency('gasLeak')
    for (let tick = 0; tick < 181; tick++) world.tick(1 / 60)
    expect(world.emergency.phase).toBe('alarm')
    expect(world.entities.some((entity) => entity.kind === 'person' && entity.role !== 'responder' && entity.behavior === 'evacuate')).toBe(true)
    expect(world.entities.some((entity) =>
      entity.kind === 'person' &&
      entity.role !== 'responder' &&
      entity.personActivity === 'reacting' &&
      entity.animation === 7 &&
      entity.speed === 0
    )).toBe(true)
  })
  it('uses trained role-dependent alarm acknowledgement delays before evacuation', () => {
    const world = new SimWorld(layout, 768)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    const operators = world.entities.filter((entity) => entity.kind === 'person' && entity.role === 'operator')
    const engineers = world.entities.filter((entity) => entity.kind === 'person' && entity.role === 'engineer')
    const delay = (person: (typeof operators)[number]): number =>
      (person.reactionUntil ?? world.simTime) - (person.reactionStartedAt ?? world.simTime)
    expect(operators.every((person) => delay(person) >= 0.55 && delay(person) <= 1.45)).toBe(true)
    expect(engineers.every((person) => delay(person) >= 1.15 && delay(person) <= 3.1)).toBe(true)
    expect(new Set(operators.map((person) => delay(person).toFixed(4))).size).toBeGreaterThan(operators.length * 0.8)
    expect(new Set(engineers.map((person) => delay(person).toFixed(4))).size).toBeGreaterThan(engineers.length * 0.8)
    expect(Math.max(...operators.map(delay)) - Math.min(...operators.map(delay))).toBeGreaterThan(0.7)
    expect(Math.max(...engineers.map(delay)) - Math.min(...engineers.map(delay))).toBeGreaterThan(1.6)
    expect(new Set(operators.map((person) => person.emergencySpeed?.toFixed(4))).size).toBeGreaterThan(operators.length * 0.8)
    expect(new Set(engineers.map((person) => person.emergencySpeed?.toFixed(4))).size).toBeGreaterThan(engineers.length * 0.8)
    expect(operators.every((person) => (person.emergencySpeed ?? 0) >= 2.05 && (person.emergencySpeed ?? 0) <= 2.3)).toBe(true)
    expect(engineers.every((person) => (person.emergencySpeed ?? 0) >= 2.05 && (person.emergencySpeed ?? 0) <= 2.3)).toBe(true)
    world.tick(1 / 60)
    expect([...operators, ...engineers].every((person) =>
      person.animation === 7 &&
      person.personActivity === 'reacting' &&
      person.speed === 0
    )).toBe(true)
  })
  it('settles evacuees into a mustered state facing the facility-side check-in exit', () => {
    const world = new SimWorld(layout, 769)
    world.triggerEmergency('fire')
    world.setPhase('alarm')
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator')!
    world.assignEvacuationSlot(person)
    const muster = layout.emergency.musterPoints.find((point) => point.id === person.evacuationMusterId)!
    const exit = [...layout.emergency.exits].sort((left, right) =>
      Math.hypot(left.position[0] - muster.position[0], left.position[2] - muster.position[2]) -
      Math.hypot(right.position[0] - muster.position[0], right.position[2] - muster.position[2])
    )[0]!
    person.x = person.goalX
    person.z = person.goalZ
    person.targetX = person.goalX
    person.targetZ = person.goalZ
    person.route = []
    person.routeCursor = 0
    person.speed = 0
    person.reactionUntil = 0
    person.yaw = Math.atan2(person.z - exit.position[2], person.x - exit.position[0])
    for (let tick = 0; tick < 2 * 60; tick++) world.tick(1 / 60)
    const checkInYaw = Math.atan2(exit.position[2] - person.z, exit.position[0] - person.x)
    const headingError = Math.abs(Math.atan2(
      Math.sin(person.yaw - checkInYaw),
      Math.cos(person.yaw - checkInYaw)
    ))
    expect(person.personActivity).toBe('mustered')
    expect(person.speed).toBeLessThan(0.05)
    expect(headingError).toBeLessThan(0.05)
  })
  it('fans evacuees into stable lateral flow bands before the muster formation', () => {
    const world = new SimWorld(layout, 771)
    const people = world.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
    const evacuees = people.slice(0, 8)
    for (const person of people) {
      person.x = 1_000 + person.index
      person.z = 1_000
    }
    for (const person of evacuees) {
      person.x = 0
      person.z = 0
      person.behavior = 'evacuate'
    }

    const lateralTargets = evacuees.map((person) => evacuationFlowSteering(world, person, 8, 0)[1])
    expect(Math.max(...lateralTargets) - Math.min(...lateralTargets)).toBeGreaterThan(0.7)
    expect(new Set(lateralTargets.map((target) => target.toFixed(2))).size).toBeGreaterThan(6)
    expect(evacuationFlowSteering(world, evacuees[0]!, 8, 0, true)).toEqual([8, 0])
  })
  it('clears an equipment edge laterally before turning around its corner', () => {
    const world = new SimWorld(layout, 773)
    const person = world.entities.find((entity) => entity.kind === 'person')!
    // Right edge of cleaner-291, reproducing a high-speed evacuation stall.
    person.x = 52.271
    person.z = -23.23
    const steering = staticObstacleSteering(
      world.layout.groundObstacleIndex,
      person,
      50.3 - person.x,
      -21.6 - person.z
    )

    expect(Math.abs(steering[0])).toBeLessThan(0.01)
    expect(steering[1]).toBeGreaterThan(1.4)
  })
  it('slows a running evacuee enough to capture a close navigation waypoint', () => {
    const world = new SimWorld(layout, 774)
    const person = world.entities.find((entity) => entity.kind === 'person')!
    for (const other of world.entities) {
      if (other === person || other.kind === 'oht' || other.kind === 'arm') continue
      other.x = 1_000 + other.index
      other.z = 1_000
    }
    const nodeIndex = 650
    const node = world.layout.walkGraph.nodes[nodeIndex]!
    person.x = 49.729
    person.z = -84.292
    person.goalX = 0
    person.goalZ = -115.5
    person.targetX = node.x
    person.targetZ = node.z
    person.route = world.layout.walkGraph.findPath(
      nodeIndex,
      world.layout.walkGraph.nearest(person.goalX, person.goalZ)
    )
    person.routeCursor = 0
    person.behavior = 'evacuate'
    person.personActivity = 'evacuating'
    person.speed = 2.06
    person.maxSpeed = 2.06
    person.trafficSpeedLimit = 2.06
    person.yaw = Math.atan2(node.z - person.z, node.x - person.x) + Math.PI / 2

    for (let tick = 0; tick < 6 * 60 && person.routeCursor === 0; tick++) updateMovement(world, 1 / 60)

    expect(person.routeCursor).toBeGreaterThan(0)
  })
  it('uses diagonal pedestrian route segments during an evacuation', () => {
    const world = new SimWorld(layout, 772)
    world.triggerEmergency('fire')
    for (let tick = 0; tick < 6 * 60; tick++) world.tick(1 / 60)

    const diagonalSegments = world.entities
      .filter((entity) => entity.kind === 'person' && entity.behavior === 'evacuate')
      .reduce((count, person) => count + person.route.slice(1).filter((nodeIndex, routeIndex) => {
        const from = world.layout.walkGraph.nodes[person.route[routeIndex]!]!
        const to = world.layout.walkGraph.nodes[nodeIndex]!
        return Math.abs(from.x - to.x) > 0.1 && Math.abs(from.z - to.z) > 0.1
      }).length, 0)

    expect(diagonalSegments).toBeGreaterThan(100)
  })
  it('does not clear a gas leak from a fallback timer or an unverified all-clear request', () => {
    const world = new SimWorld(layout, 770)
    world.triggerEmergency('gasLeak')
    world.emergency.hazard!.fixedAt = 0
    world.tick(1 / 60)
    expect(world.emergency.hazardControlled).not.toBe(true)
    world.setPhase('allClear')
    expect(world.emergency.phase).not.toBe('allClear')
    expect(world.events.some((event) =>
      event.type === 'hudMessage' && event.message?.includes('통제 피드백이 확인되지 않아')
    )).toBe(true)
  })
  it('requires an empty work zone before starting local gas-valve manipulation', () => {
    const world = new SimWorld(layout, 768)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    world.tick(1 / 60)
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'gas_isolation')!
    const robot = world.entities.find((entity) => entity.id === task.robotId)!
    expect(task.gasSpotterId).toBeUndefined()
    expect(world.metrics.gasSpotterClearance).toBe(0)

    task.status = 'observing'
    task.stageStartedAt = world.simTime - 3
    robot.x = task.targetX
    robot.z = task.targetZ
    robot.speed = 0
    robot.activity = 'observing'
    world.tick(1 / 60)
    expect(task.status).toBe('interacting')
    expect(task.gasSpotterAcknowledged).not.toBe(true)
    expect(world.metrics).toMatchObject({
      gasWorkPermitAuthorized: true,
      gasWorkZoneClear: true,
      gasWorkZonePeople: 0,
      gasWorkZoneHumanEntries: 0,
      gasWorkZoneRobotEntries: 1
    })

    const intruder = world.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')!
    intruder.x = task.targetX
    intruder.z = task.targetZ
    intruder.speed = 0
    intruder.behavior = 'halt'
    intruder.personActivity = 'idle'
    world.tick(1 / 60)
    expect(task.gasSpotterAcknowledged).not.toBe(true)
    expect(task.status).toBe('observing')
    expect(robot.activity).toBe('observing')
    expect(world.metrics.gasWorkZoneHumanEntries).toBe(1)
    expect(world.events.some((event) =>
      event.type === 'interaction' &&
      event.personId === intruder.id &&
      event.data?.interactionKind === 'gas_work_zone_breach'
    )).toBe(true)
  })
  it('measures the same gas-valve incident with a human baseline and a zero-human-entry humanoid run', () => {
    const humanWorld = new SimWorld(layout, 20260729)
    humanWorld.startRiskComparison('human')
    let manualValvePoseObserved = false
    for (let tick = 0; tick < 180 * 60 && !humanWorld.riskComparisonResult; tick++) {
      humanWorld.tick(1 / 60)
      manualValvePoseObserved ||= humanWorld.entities.some((entity) =>
        entity.kind === 'person' &&
        entity.manualGasRole === 'operator' &&
        entity.animation === 9
      )
    }
    const human = humanWorld.riskComparisonResult
    expect(human).toBeDefined()
    expect(human).toMatchObject({
      mode: 'human',
      humanEntries: 1,
      humanoidEntries: 0,
      verified: true
    })
    expect(manualValvePoseObserved).toBe(true)
    expect(human!.humanWorkZoneSeconds).toBeGreaterThanOrEqual(8.2)
    expect(human!.spotterClearance).toBeGreaterThanOrEqual(2.2)
    expect(human!.spotterClearance).toBeLessThanOrEqual(3.4)

    const humanoidWorld = new SimWorld(layout, 20260729)
    humanoidWorld.startRiskComparison('humanoid', {
      sourceEquipmentId: human!.sourceEquipmentId,
      targetId: human!.targetId
    })
    for (let tick = 0; tick < 180 * 60 && !humanoidWorld.riskComparisonResult; tick++) {
      humanoidWorld.tick(1 / 60)
    }
    const humanoid = humanoidWorld.riskComparisonResult
    expect(humanoid).toBeDefined()
    expect(humanoid).toMatchObject({
      mode: 'humanoid',
      sourceEquipmentId: human!.sourceEquipmentId,
      targetId: human!.targetId,
      humanEntries: 0,
      humanoidEntries: 1,
      humanWorkZoneSeconds: 0,
      verified: true
    })
    expect(humanoid!.isolationElapsed).toBeGreaterThan(0)
  }, 60_000)
  it('requires the authenticated external work-permit event for a live gas isolation', () => {
    const world = new SimWorld(layout, 766)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'gas_isolation')!
    const robot = world.entities.find((entity) => entity.id === 'humanoid-002')!
    expect(task.gasSpotterId).toBeUndefined()
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'observing',
      assignedRobot: robot.id,
      targetId: task.targetId,
      timestamp: 1_000
    })
    robot.x = task.targetX
    robot.z = task.targetZ
    robot.speed = 0
    world.tick(1 / 60)
    expect(task.gasSpotterAcknowledged).not.toBe(true)
    expect(world.metrics).toMatchObject({
      gasRmfAssigned: true,
      gasWorkPermitAuthorized: false,
      gasValveContactConfirmed: false,
      gasValveClosed: false,
      gasIsolationVerified: false
    })

    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'interacting',
      assignedRobot: robot.id,
      interactionKind: 'gas_isolation_verified',
      timestamp: 1_100
    })
    expect(world.emergency.hazardControlled).not.toBe(true)
    expect(robot.activity).toBe('observing')

    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'observing',
      assignedRobot: robot.id,
      timestamp: 1_200
    })
    world.applyRmfEvent({
      type: 'work_permit',
      taskId: task.id,
      authorized: true,
      authorizedBy: 'site-ehs',
      clearance: 2.25,
      timestamp: 1_300
    })
    expect(task.gasSpotterAcknowledged).not.toBe(true)
    expect(task.gasWorkPermitClearance).toBe(2.25)
    expect(world.metrics.gasSpotterClearance).toBe(0)
    expect(world.metrics).toMatchObject({
      gasWorkPermitAuthorized: true,
      gasWorkPermitAuthority: 'site-ehs'
    })
    expect(world.events.some((event) =>
      event.type === 'hudMessage' && event.message?.includes('원격 EHS 작업허가')
    )).toBe(true)

    world.applyRmfEvent({
      type: 'work_permit',
      taskId: task.id,
      authorized: false,
      authorizedBy: 'site-ehs',
      reason: 'residual gas rise',
      timestamp: 1_400
    })
    expect(task.gasSpotterAcknowledged).not.toBe(true)
    expect(world.metrics).toMatchObject({
      gasSpotterClearance: 0,
      gasWorkPermitAuthorized: false,
      gasWorkPermitRevoked: true
    })
    expect(world.events.some((event) =>
      event.type === 'interaction' && event.data?.interactionKind === 'gas_work_permit_revoked'
    )).toBe(true)

    const workZoneIntruder = world.entities.find((entity) =>
      entity.kind === 'person' && entity.role !== 'responder'
    )!
    workZoneIntruder.x = task.targetX
    workZoneIntruder.z = task.targetZ
    workZoneIntruder.speed = 0
    world.applyRmfEvent({
      type: 'work_permit',
      taskId: task.id,
      authorized: true,
      authorizedBy: 'site-ehs',
      clearance: 2.25,
      timestamp: 1_500
    })
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'interacting',
      assignedRobot: robot.id,
      interactionKind: 'gas_isolation_verified',
      timestamp: 1_600
    })
    expect(task.gasSpotterAcknowledged).not.toBe(true)
    expect(world.emergency.hazardControlled).not.toBe(true)
    expect(robot.activity).toBe('observing')
    expect(world.events.some((event) =>
      event.type === 'hudMessage' && event.message?.includes('완료 콜백을 거절')
    )).toBe(true)

    workZoneIntruder.x = task.targetX + 5
    workZoneIntruder.z = task.targetZ
    world.applyRmfEvent({
      type: 'work_permit',
      taskId: task.id,
      authorized: true,
      authorizedBy: 'site-ehs',
      clearance: 2.25,
      timestamp: 1_700
    })
    world.applyRmfEvent({
      type: 'action_telemetry',
      taskId: task.id,
      category: 'gas_isolation',
      robot: robot.id,
      phase: 'verified',
      progress: 1,
      leftHandContact: false,
      rightHandContact: false,
      valvePosition: 1,
      gasPpm: 0.8,
      sensorStable: true,
      timestamp: 1_750
    })
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'interacting',
      assignedRobot: robot.id,
      interactionKind: 'gas_isolation_verified',
      timestamp: 1_800
    })
    expect(robot.activity).toBe('manipulating')
    expect(world.emergency.hazardControlled).toBe(true)
    expect(world.metrics).toMatchObject({
      gasValveContactConfirmed: true,
      gasValveClosed: true,
      gasIsolationVerified: true,
      verifiedSafetyGates: 1
    })
  })
  it('keeps a failed robot-only gas isolation uncontrolled while the robot retreats for EHS handoff', () => {
    const world = new SimWorld(layout, 767)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    world.tick(1 / 60)
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'gas_isolation')!
    const robot = world.entities.find((entity) => entity.id === task.robotId)!
    expect(task.gasSpotterId).toBeUndefined()
    expect(robot.maxSpeed).toBeGreaterThanOrEqual(1.75)
    task.status = 'interacting'
    robot.x = task.targetX
    robot.z = task.targetZ
    robot.activity = 'manipulating'
    robot.speed = 0
    expect(task.status).toBe('interacting')
    const robotStart: [number, number] = [robot.x, robot.z]

    world.injectHumanoidFailure()
    expect(task.status).toBe('failed')
    expect(robot.taskId).toBeUndefined()
    expect(robot.activity).toBe('yielding')
    expect(world.emergency.hazardControlled).not.toBe(true)
    expect(world.metrics.verifiedSafetyGates).toBe(0)
    expect(world.metrics).toMatchObject({
      gasTaskFailed: true,
      gasWorkPermitAuthorized: false,
      gasIsolationVerified: false
    })
    expect(world.events.some((event) =>
      event.type === 'interaction' &&
      event.data?.interactionKind === 'gas_failure_handoff' &&
      event.message?.includes('EHS 수동 대응')
    )).toBe(true)

    for (let tick = 0; tick < 12 * 60; tick++) world.tick(1 / 60)
    expect(Math.hypot(robot.x - robotStart[0], robot.z - robotStart[1])).toBeGreaterThan(2.5)
    expect(robot.activity).toBe('safeStop')
    expect(world.emergency.hazardControlled).not.toBe(true)
    world.setPhase('allClear')
    expect(world.emergency.phase).not.toBe('allClear')
  })
  it('controls a gas leak only after contact, valve closure, and sensor feedback', () => {
    const world = new SimWorld(layout, 769)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    world.tick(1 / 60)
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'gas_isolation')!
    const robot = world.entities.find((entity) => entity.id === task.robotId)!
    task.status = 'interacting'
    robot.activity = 'manipulating'

    task.stageStartedAt = world.simTime - 1.2
    world.tick(1 / 60)
    expect(task.gasValveContactConfirmed).toBe(true)
    expect(task.gasValveActuationConfirmed).not.toBe(true)
    expect(world.emergency.hazardControlled).not.toBe(true)

    task.stageStartedAt = world.simTime - 5.2
    world.tick(1 / 60)
    expect(task.gasValveActuationConfirmed).toBe(true)
    expect(task.gasIsolationVerified).not.toBe(true)
    expect(world.emergency.hazardControlled).not.toBe(true)

    task.stageStartedAt = world.simTime - 8.2
    world.tick(1 / 60)
    expect(task.gasIsolationVerified).toBe(true)
    expect(world.emergency.hazardControlled).toBe(true)
    expect(world.emergency.controlledBy).toBe('humanoid_valve')
    expect(world.metrics.hazardousManualActionsDelegated).toBe(1)
    expect(world.metrics.verifiedSafetyGates).toBe(1)
    expect(world.metrics.gasIsolationElapsed).toBeGreaterThan(0)
    const sequence = world.events
      .map((event) => event.data?.interactionKind)
      .filter((kind) => typeof kind === 'string' && kind.startsWith('gas_'))
    expect(sequence).toEqual([
      'gas_valve_contact',
      'gas_valve_closed',
      'gas_sensor_monitoring',
      'gas_isolation_verified'
    ])
  })
  it('assigns each evacuee a stable reachable muster instead of switching by instantaneous distance', () => {
    const world = new SimWorld(layout, 771)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    const evacuees = world.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
    expect(evacuees.every((person) => person.evacuationMusterId !== undefined)).toBe(true)
    expect(new Set(evacuees.map((person) => person.evacuationMusterId)).size).toBe(2)
    const person = evacuees[0]!
    const assigned = person.evacuationMusterId
    const goal: [number, number] = [person.goalX, person.goalZ]
    const opposite = layout.emergency.musterPoints.find((point) => point.id !== assigned)!
    person.x = opposite.position[0]
    person.z = opposite.position[2]
    const reactionUntil = person.reactionUntil
    world.overrideBehavior('type:person role:!responder', 'evacuate')
    world.assignEvacuationMuster(person)
    expect({ id: person.evacuationMusterId, goal: [person.goalX, person.goalZ], reactionUntil: person.reactionUntil }).toEqual({
      id: assigned,
      goal,
      reactionUntil
    })
  })
  it('withdraws responders to separated staging points after source control so evacuation lanes reopen', () => {
    const world = new SimWorld(layout, 773)
    world.triggerEmergency('fire')
    world.setPhase('alarm')
    const hazard = world.emergency.hazard!
    hazard.radius = 10
    const responders = world.entities.filter((entity) => entity.kind === 'person' && entity.role === 'responder' && entity.behavior === 'respond')
    expect(responders).toHaveLength(3)
    world.markHazardControlled()
    expect(responders.every((responder) =>
      responder.behavior === 'yield' &&
      Math.hypot(responder.goalX - hazard.sourceX, responder.goalZ - hazard.sourceZ) >= 12
    )).toBe(true)
    for (let left = 0; left < responders.length; left++) {
      for (let right = left + 1; right < responders.length; right++) {
        expect(Math.hypot(responders[left]!.goalX - responders[right]!.goalX, responders[left]!.goalZ - responders[right]!.goalZ)).toBeGreaterThanOrEqual(3)
      }
    }
  })
  it('safe-stops an evacuee instead of taking a direct-line fallback when no graph route exists', () => {
    const world = new SimWorld(layout, 772)
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')!
    const muster = layout.emergency.musterPoints[0]!
    person.behavior = 'evacuate'
    person.personActivity = 'evacuating'
    person.reactionUntil = 0
    person.evacuationMusterId = muster.id
    person.goalX = muster.position[0]
    person.goalZ = muster.position[2]
    person.speed = 1
    person.targetX = Number.NaN
    person.targetZ = Number.NaN
    const start = [person.x, person.z] as const
    const from = world.layout.walkGraph.nearest(person.x, person.z)
    world.layout.walkGraph.edges[from] = []
    world.tick(1 / 60)
    expect([person.x, person.z]).toEqual(start)
    expect(person.status).toBe('waiting')
    expect([person.targetX, person.targetZ]).toEqual(start)
    expect(person.speed).toBeGreaterThan(0.9)
    expect(person.speed).toBeLessThan(1)
  })
  it('preserves the configured hazard kind when scenario steps enter detected phase', () => {
    const fireWorld = new SimWorld(layout, 76)
    fireWorld.loadScenario(ScenarioSchema.parse(fireJson))
    for (let tick = 0; tick < 190; tick++) fireWorld.tick(1 / 60)
    expect(fireWorld.emergency.kind).toBe('fire')
    const medicalWorld = new SimWorld(layout, 75)
    medicalWorld.loadScenario(ScenarioSchema.parse(medicalJson))
    for (let tick = 0; tick < 190; tick++) medicalWorld.tick(1 / 60)
    expect(medicalWorld.emergency.kind).toBe('medical')
    expect(medicalWorld.entities.some((entity) => entity.personActivity === 'collapsed')).toBe(true)
  })
  it('keeps a delayed medical transport in response after the 90-second escalation warning', () => {
    const world = new SimWorld(layout, 77)
    world.loadScenario(ScenarioSchema.parse(medicalJson))
    for (let tick = 0; tick < 7 * 60; tick++) world.tick(1 / 60)
    const vehicle = world.medicalResponse?.vehicleId
      ? world.entities.find((entity) => entity.id === world.medicalResponse?.vehicleId)
      : undefined
    if (vehicle && world.emergency.hazard) {
      // Model an unavailable transport without changing the medical workflow:
      // the timeout must escalate to an operator, never certify all-clear.
      vehicle.rmfControlled = true
      vehicle.x = world.emergency.hazard.sourceX
      vehicle.z = world.emergency.hazard.sourceZ
    }
    // Jump the deterministic scenario clock to its escalation threshold; the
    // transport remains at the incident and therefore cannot complete.
    world.simTime = 90
    world.tick(1 / 60)
    expect(world.emergency.phase).toBe('response')
    expect(world.events.some((event) => event.message?.includes('현장 지휘 확인 필요'))).toBe(true)
  })
  it('moves local humanoids outside the final fire perimeter before safe-stop', () => {
    const world = new SimWorld(layout, 74)
    world.triggerEmergency('fire')
    const hazard = world.emergency.hazard!
    const robot = world.entities.find((entity) => entity.kind === 'humanoid' && !entity.rmfControlled)!
    robot.x = hazard.sourceX
    robot.z = hazard.sourceZ
    world.setPhase('alarm')
    expect(robot.behavior).toBe('yield')
    expect(robot.activity).toBe('yielding')
    expect(Math.hypot(robot.goalX - hazard.sourceX, robot.goalZ - hazard.sourceZ)).toBeGreaterThan(hazard.maxRadius * 1.8 + 5)
    robot.x = robot.goalX
    robot.z = robot.goalZ
    world.tick(1 / 60)
    expect(robot.activity).toBe('safeStop')
    expect(world.events.some((event) => event.type === 'interaction' && event.robotId === robot.id && event.message?.includes('안전 지점'))).toBe(true)
  })
  it('holds only fire-adjacent equipment, blocks new intake, and resumes the exact process stage', () => {
    const world = new SimWorld(layout, 73)
    world.triggerEmergency('fire')
    const hazard = world.emergency.hazard!
    const byDistance = world.equipment
      .map((equipment) => {
        const position = world.layout.equipmentPositions.get(equipment.id)!
        return { equipment, distance: Math.hypot(position[0] - hazard.sourceX, position[2] - hazard.sourceZ) }
      })
      .sort((a, b) => a.distance - b.distance)
    const near = byDistance[0]!.equipment
    const far = byDistance.at(-1)!.equipment
    near.state = 'processing'; near.progress = 12
    far.state = 'processing'; far.progress = 12
    world.setPhase('alarm')
    world.tick(1 / 60)
    expect(near.state).toBe('held')
    expect(near.resumeState).toBe('processing')
    expect(near.progress).toBe(12)
    expect(far.state).toBe('processing')
    expect(far.progress).toBeGreaterThan(12)
    expect(world.metrics.heldEquipment).toBeGreaterThan(0)
    expect(world.metrics.heldEquipment).toBeLessThan(world.equipment.length)
    world.finishEmergency()
    world.tick(1 / 60)
    expect(near.state).toBe('processing')
    expect(near.progress).toBeGreaterThan(12)
    expect(world.metrics.heldEquipment).toBe(0)
  })
  it('keeps fab processing active during a localized medical response', () => {
    const world = new SimWorld(layout, 72)
    const equipment = world.equipment[0]!
    equipment.state = 'processing'; equipment.progress = 10
    world.triggerEmergency('medical')
    world.setPhase('alarm')
    world.tick(1 / 60)
    expect(equipment.state).toBe('processing')
    expect(equipment.progress).toBeGreaterThan(10)
    expect(world.metrics.heldEquipment).toBe(0)
  })
  it('gives people purposeful equipment inspection work during normal operation', () => {
    const world = new SimWorld(layout, 78)
    for (let tick = 0; tick < 900; tick++) world.tick(1 / 60)
    expect(world.entities.some((entity) => entity.kind === 'person' && (entity.personActivity === 'walkingToWork' || entity.personActivity === 'inspecting'))).toBe(true)
  })
  it('completes ordinary equipment inspections instead of freezing inspectors indefinitely', () => {
    const world = new SimWorld(layout, 781)
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator')!
    person.personActivity = 'inspecting'
    person.workTargetId = 'lithography-001'
    person.nextActionAt = world.simTime + 1
    for (let tick = 0; tick < 90; tick++) world.tick(1 / 60)
    expect(person.personActivity).not.toBe('inspecting')
    expect(person.workTargetId).toBeUndefined()
  })
  it('reserves a real operator at the showcase tool until the humanoid work-zone handoff', () => {
    const world = new SimWorld(layout, 782)
    world.setRmfConnection(true, true)
    world.startHumanoidShowcase()
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'inspection_round')!
    const operator = world.entities.find((entity) => entity.workReservationTaskId === task.id)!
    expect(operator.workTargetId).toBe(task.targetId)
    for (let tick = 0; tick < 3_600; tick++) world.tick(1 / 60)
    expect(operator.workReservationTaskId).toBe(task.id)
    expect(operator.personActivity).toBe('inspecting')
    expect(Math.hypot(operator.x - task.targetX, operator.z - task.targetZ)).toBeLessThan(0.8)
  }, 30_000)
  it('restarts the integrated showcase with one fresh causal task chain', () => {
    const world = new SimWorld(layout, 783)
    world.startHumanoidShowcase()
    world.tick(1 / 60)
    const first = world.humanoidTasks.find((task) => task.kind === 'inspection_round')!
    expect(first.status).not.toBe('cancelled')

    world.startHumanoidShowcase()
    const second = world.humanoidTasks.at(-1)!
    expect(first.status).toBe('cancelled')
    expect(second.id).not.toBe(first.id)
    expect(second.kind).toBe('inspection_round')
    expect(second.requestedBy).toBe('showcase')
    expect(world.humanoidTasks.filter((task) =>
      !['completed', 'failed', 'cancelled'].includes(task.status)
    )).toEqual([second])
    expect(world.entities.every((entity) => entity.taskId !== first.id)).toBe(true)
  })
  it('starts the showcase incident only from an explicit inspection anomaly report', () => {
    const world = new SimWorld(layout, 784)
    world.setRmfConnection(true, true)
    world.startHumanoidShowcase()
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'inspection_round')!

    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'inspection_round',
      status: 'reporting',
      assignedRobot: 'humanoid-002',
      timestamp: 1_000
    })
    world.tick(1 / 60)
    expect(world.emergency.phase).toBe('normal')
    expect(task.inspectionAnomalyReported).not.toBe(true)

    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'inspection_round',
      status: 'reporting',
      assignedRobot: 'humanoid-002',
      interactionKind: 'inspection_anomaly_reported',
      timestamp: 1_100
    })
    world.tick(1 / 60)
    expect(task.inspectionAnomalyReported).toBe(true)
    expect(world.emergency).toMatchObject({ kind: 'gasLeak', phase: 'detected' })
    expect(world.events).toContainEqual(expect.objectContaining({
      type: 'hudMessage',
      taskId: task.id,
      robotId: 'humanoid-002',
      data: expect.objectContaining({ interactionKind: 'inspection_anomaly_reported' })
    }))
  })
  it('moves a carrier through pickup, transport, and drop-off states', () => {
    const world = new SimWorld(layout, 80)
    world.pendingOutputs = 1
    world.tick(1 / 60)
    const mission = world.transportMissions[0]!
    const vehicle = world.entities.find((entity) => entity.id === mission.assigneeId)!
    vehicle.x = mission.fromX; vehicle.z = mission.fromZ; vehicle.targetX = Number.NaN; vehicle.targetZ = Number.NaN
    world.tick(1 / 60)
    expect(mission.state).toBe('picking')
    for (let tick = 0; tick < 181; tick++) world.tick(1 / 60)
    expect(mission.state).toBe('carrying')
    expect(vehicle.auxA).toBe(1)
    vehicle.x = mission.toX; vehicle.z = mission.toZ; vehicle.targetX = Number.NaN; vehicle.targetZ = Number.NaN
    world.tick(1 / 60)
    expect(mission.state).toBe('dropping')
    for (let tick = 0; tick < 181; tick++) world.tick(1 / 60)
    expect(mission.state).toBe('done')
    expect(vehicle.mission).toBeUndefined()
  })
  it('keeps evacuees at the muster point after arrival', () => {
    const world = new SimWorld(layout, 79)
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')!
    person.behavior = 'evacuate'; person.personActivity = 'evacuating'; person.reactionUntil = 0
    world.assignEvacuationMuster(person)
    world.assignEvacuationSlot(person)
    const musterSlot = [person.goalX, person.goalZ] as const
    person.x = musterSlot[0]; person.z = musterSlot[1]
    person.targetX = Number.NaN; person.targetZ = Number.NaN; person.route = []
    for (let tick = 0; tick < 300; tick++) world.tick(1 / 60)
    expect(Math.hypot(person.x - musterSlot[0], person.z - musterSlot[1])).toBeLessThan(0.1)
    expect(person.status).toBe('waiting')
  })
  it('reserves muster slots outside stationary robot body envelopes', () => {
    const world = new SimWorld(layout, 977)
    const person = world.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')!
    const robot = world.entities.find((entity) => entity.kind === 'agv')!
    world.triggerEmergency('fire')
    world.setPhase('alarm')
    world.assignEvacuationSlot(person)
    const initiallySelected = [person.goalX, person.goalZ] as const
    person.evacuationSlotIndex = undefined
    robot.x = initiallySelected[0]
    robot.z = initiallySelected[1]
    robot.speed = 0
    robot.behavior = 'halt'
    robot.status = 'waiting'

    world.assignEvacuationSlot(person)

    expect([person.goalX, person.goalZ]).not.toEqual(initiallySelected)
    expect(Math.hypot(person.goalX - robot.x, person.goalZ - robot.z)).toBeGreaterThanOrEqual(
      groundBodyRadius(person) + groundBodyRadius(robot) + 0.42
    )
  })
  it('holds evacuated people at muster through all-clear before staged re-entry', () => {
    const world = new SimWorld(layout, 791)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    const evacuees = world.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
    evacuees.forEach((person) => {
      world.assignEvacuationSlot(person)
      person.x = person.goalX
      person.z = person.goalZ
      person.speed = 0
      person.personActivity = 'mustered'
      person.yaw = world.musterCheckInYaw(person)!
    })
    world.markHazardControlled('operator')
    world.setPhase('allClear')
    const person = evacuees[0]!
    const position = [person.x, person.z]
    for (let tick = 0; tick < 120; tick++) world.tick(1 / 60)
    expect(world.emergency.phase).toBe('allClear')
    expect(person.behavior).toBe('halt')
    expect([person.x, person.z]).toEqual(position)
  })
  it('waits for assigned formation slots before declaring all-clear', () => {
    const world = new SimWorld(layout, 792)
    world.triggerEmergency('fire')
    world.setPhase('alarm')
    const evacuees = world.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
    evacuees.forEach((person) => {
      world.assignEvacuationSlot(person)
      const muster = layout.emergency.musterPoints.find((point) => point.id === person.evacuationMusterId)!
      person.x = muster.position[0]
      person.z = muster.position[2]
    })
    expect(world.evacuationComplete()).toBe(true)
    expect(world.assemblyComplete()).toBe(false)
    world.markHazardControlled('responder')
    world.setPhase('allClear')
    expect(world.emergency.phase).not.toBe('allClear')
    evacuees.forEach((person) => {
      person.x = person.goalX
      person.z = person.goalZ
      person.personActivity = 'mustered'
      person.yaw = world.musterCheckInYaw(person)!
    })
    expect(world.assemblyComplete()).toBe(true)
    world.setPhase('allClear')
    expect(world.emergency.phase).toBe('allClear')
  })
  it('executes a purposeful humanoid inspection through interaction and reporting', () => {
    const world = new SimWorld(layout, 123)
    const robot = world.entities.find((entity) => entity.kind === 'humanoid')!
    const operator = world.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator')!
    operator.x = robot.x + 1; operator.z = robot.z
    world.dispatchHumanoidTask({
      id: 'inspection-test',
      kind: 'inspection_round',
      target: [robot.x, robot.z],
      requestedBy: 'operator',
      priority: 50
    })
    for (let tick = 0; tick < 1_200; tick++) world.tick(1 / 60)
    const task = world.humanoidTasks.find((candidate) => candidate.id === 'inspection-test')
    expect(task?.status).toBe('completed')
    expect(world.completedHumanoidTasks).toBe(1)
    expect(world.events.some((event) => event.type === 'interaction' && event.taskId === 'inspection-test')).toBe(true)
  })
  it('waits for a nearby operator to physically clear the humanoid work zone', () => {
    const world = new SimWorld(layout, 325)
    const robot = world.entities.find((entity) => entity.kind === 'humanoid')!
    const operator = world.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator')!
    operator.x = robot.x + 0.8
    operator.z = robot.z
    operator.goalX = operator.x
    operator.goalZ = operator.z
    operator.personActivity = 'idle'
    world.dispatchHumanoidTask({
      id: 'clearance-test',
      kind: 'inspection_round',
      target: [robot.x, robot.z],
      requestedBy: 'operator',
      priority: 50
    })
    let task = world.humanoidTasks.find((candidate) => candidate.id === 'clearance-test')!
    for (let tick = 0; tick < 720 && task.status !== 'observing'; tick++) world.tick(1 / 60)
    task = world.humanoidTasks.find((candidate) => candidate.id === 'clearance-test')!
    expect(task.status).toBe('observing')
    expect(task.operatorClearanceConfirmed).toBe(true)
    expect(Math.hypot(operator.x - robot.x, operator.z - robot.z)).toBeGreaterThanOrEqual(2.2)
    expect(world.metrics.humanRobotClearances).toBe(1)
    expect(world.events.some((event) =>
      event.type === 'interaction' &&
      event.taskId === 'clearance-test' &&
      event.message?.includes('작업을 승인')
    )).toBe(true)
  })
  it('applies the same operator clearance behavior to a live RMF-controlled humanoid', () => {
    const world = new SimWorld(layout, 326)
    const robot = world.entities.find((entity) => entity.id === 'humanoid-001')!
    const operator = world.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator')!
    world.applyRmfEvent({
      type: 'robot_state',
      fleet: 'fab_humanoid_fleet',
      robot: robot.id,
      map: 'fab-L1',
      x: robot.x,
      y: robot.z,
      yaw: robot.yaw,
      battery: 80,
      mode: 'waiting',
      taskId: 'rmf-clearance-test',
      timestamp: 1_000
    })
    operator.x = robot.x + 0.8
    operator.z = robot.z
    operator.goalX = operator.x
    operator.goalZ = operator.z
    operator.personActivity = 'idle'
    world.applyRmfEvent({
      type: 'task_state',
      taskId: 'rmf-clearance-test',
      category: 'inspection_round',
      status: 'observing',
      assignedRobot: robot.id,
      timestamp: 1_100
    })
    for (let tick = 0; tick < 600; tick++) world.tick(1 / 60)
    const task = world.humanoidTasks.find((candidate) => candidate.id === 'rmf-clearance-test')!
    expect(task.operatorClearanceConfirmed).toBe(true)
    expect(Math.hypot(operator.x - robot.x, operator.z - robot.z)).toBeGreaterThanOrEqual(2.2)
    expect(world.metrics.humanRobotClearances).toBe(1)
  })
  it('accepts authoritative Open-RMF robot poses without local integration', () => {
    const world = new SimWorld(layout, 321)
    world.applyRmfEvent({
      type: 'robot_state',
      fleet: 'fab_humanoid_fleet',
      robot: 'humanoid-001',
      map: 'fab-L1',
      x: 12,
      y: -8,
      yaw: 1.2,
      battery: 73,
      mode: 'moving',
      taskId: 'rmf-task-1',
      timestamp: 1000
    })
    const robot = world.entities.find((entity) => entity.id === 'humanoid-001')!
    expect({ x: robot.x, z: robot.z, battery: robot.battery, controlled: robot.rmfControlled }).toEqual({ x: 12, z: -8, battery: 73, controlled: true })
  })
  it('smooths ordered RMF pose samples in wall time and ignores stale samples', () => {
    const world = new SimWorld(layout, 324)
    const sample = (x: number, timestamp: number): void => world.applyRmfEvent({
      type: 'robot_state',
      fleet: 'fab_humanoid_fleet',
      robot: 'humanoid-001',
      map: 'fab-L1',
      x,
      y: -8,
      yaw: Math.PI - 0.1,
      battery: 73,
      mode: 'moving',
      timestamp
    })
    sample(12, 1_000)
    sample(12.4, 1_200)
    const robot = world.entities.find((entity) => entity.id === 'humanoid-001')!
    expect(robot.x).toBe(12)
    world.updateRealtime(0.1)
    expect(robot.x).toBeCloseTo(12.2)
    world.updateRealtime(0.1)
    expect(robot.x).toBeCloseTo(12.4)
    sample(99, 1_100)
    expect(robot.rmfPose?.targetX).toBe(12.4)
    world.updateRealtime(1.6)
    expect({ status: robot.status, activity: robot.activity, speed: robot.speed }).toEqual({
      status: 'error',
      activity: 'safeStop',
      speed: 0
    })
    sample(12.8, 1_400)
    expect({ status: robot.status, activity: robot.activity, stale: robot.rmfPose?.stale }).toEqual({
      status: 'moving',
      activity: 'walking',
      stale: false
    })
  })
  it('holds executor-reported arm progress and safe-stops when action telemetry becomes stale', () => {
    const world = new SimWorld(layout, 327)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'gas_isolation')!
    const robot = world.entities.find((entity) => entity.id === 'humanoid-002')!
    expect(task.gasSpotterId).toBeUndefined()
    robot.x = task.targetX
    robot.z = task.targetZ
    robot.speed = 0
    for (const person of world.entities.filter((entity) =>
      entity.kind === 'person' &&
      Math.hypot(entity.x - task.targetX, entity.z - task.targetZ) < 1.5
    )) {
      person.x = task.targetX + 5
      person.z = task.targetZ
    }
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'observing',
      assignedRobot: 'humanoid-002',
      targetId: 'gas-valve-west',
      timestamp: 1_000
    })
    world.applyRmfEvent({
      type: 'work_permit',
      taskId: task.id,
      authorized: true,
      authorizedBy: 'site-ehs',
      clearance: 2.25,
      timestamp: 1_100
    })
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'interacting',
      assignedRobot: 'humanoid-002',
      targetId: 'gas-valve-west',
      timestamp: 1_200
    })
    world.applyRmfEvent({
      type: 'action_telemetry',
      taskId: task.id,
      category: 'gas_isolation',
      robot: robot.id,
      phase: 'turning',
      progress: 0.42,
      leftHandContact: true,
      rightHandContact: true,
      valvePosition: 0.35,
      sensorStable: false,
      handPose: {
        frame: 'base_link',
        leftPositionM: [...gasValveGripTarget(-1, 0.35)],
        rightPositionM: [...gasValveGripTarget(1, 0.35)]
      },
      timestamp: 1_300
    })
    expect(world.metrics.gasActionTelemetryHandPoseMeasured).toBe(true)
    expect(robot.measuredLeftHandPosition).toEqual(gasValveGripTarget(-1, 0.35))
    world.tick(0)
    const pose = new Float32Array(world.poseSnapshot().buffer)
    const slot = robot.index * POSE_STRIDE
    expect(pose[slot + PoseSlot.FLAGS]! & PoseFlags.MEASURED_HAND_POSE).toBe(PoseFlags.MEASURED_HAND_POSE)
    expect(pose[slot + PoseSlot.LEFT_HAND_X]).toBeCloseTo(gasValveGripTarget(-1, 0.35)[0])
    expect(pose[slot + PoseSlot.RIGHT_HAND_Z]).toBeCloseTo(gasValveGripTarget(1, 0.35)[2])
    for (let timestamp = 2_000; timestamp <= 3_000; timestamp += 1_000) {
      world.applyRmfEvent({
        type: 'robot_state',
        fleet: 'fab_humanoid_fleet',
        robot: robot.id,
        map: 'fab-L1',
        x: robot.x,
        y: robot.z,
        yaw: robot.yaw,
        battery: 92,
        mode: 'waiting',
        taskId: task.id,
        timestamp
      })
      world.updateRealtime(1)
    }
    expect(robot.auxA).toBeCloseTo(0.42)
    expect(task.actionTelemetryStale).toBe(true)
    expect({ activity: robot.activity, status: robot.status }).toEqual({
      activity: 'safeStop',
      status: 'error'
    })
    expect(world.events.some((event) =>
      event.type === 'hudMessage' && event.message?.includes('action executor 텔레메트리')
    )).toBe(true)
  })
  it('safe-stops externally controlled humanoids when the RMF bridge disconnects', () => {
    const world = new SimWorld(layout, 323)
    world.applyRmfEvent({
      type: 'robot_state',
      fleet: 'fab_humanoid_fleet',
      robot: 'humanoid-001',
      map: 'fab-L1',
      x: 12,
      y: -8,
      yaw: 1.2,
      battery: 73,
      mode: 'moving',
      timestamp: 1000
    })
    world.setRmfConnection(true, false)
    const robot = world.entities.find((entity) => entity.id === 'humanoid-001')!
    expect({ speed: robot.speed, status: robot.status, activity: robot.activity }).toEqual({
      speed: 0,
      status: 'error',
      activity: 'safeStop'
    })
    expect(world.events.some((event) => event.type === 'hudMessage' && event.message?.includes('안전 정지'))).toBe(true)
  })
  it('does not resurrect a terminal RMF task with a late non-terminal event', () => {
    const world = new SimWorld(layout, 324)
    world.applyRmfEvent({
      type: 'task_state',
      taskId: 'rmf-terminal-test',
      category: 'inspection_round',
      status: 'assigned',
      assignedRobot: 'humanoid-001',
      timestamp: 1_000
    })
    world.applyRmfEvent({
      type: 'task_state',
      taskId: 'rmf-terminal-test',
      category: 'inspection_round',
      status: 'completed',
      assignedRobot: 'humanoid-001',
      timestamp: 2_000
    })
    world.applyRmfEvent({
      type: 'task_state',
      taskId: 'rmf-terminal-test',
      category: 'inspection_round',
      status: 'assigned',
      assignedRobot: 'humanoid-001',
      timestamp: 1_500
    })
    const task = world.humanoidTasks.find((candidate) => candidate.id === 'rmf-terminal-test')!
    const robot = world.entities.find((entity) => entity.id === 'humanoid-001')!
    expect(task.status).toBe('completed')
    expect(robot.taskId).toBeUndefined()
    expect(world.completedHumanoidTasks).toBe(1)
  })
  it('dispatches medical support to a humanoid while responders clear the scene', () => {
    const world = new SimWorld(layout, 320)
    world.triggerEmergency('medical')
    world.setPhase('alarm')
    const station = layout.emergency.medicalStation.position
    const hazard = world.emergency.hazard!
    const patient = world.entities.find((entity) => entity.id === world.medicalResponse?.victimId)!
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'medical_support')!
    expect(Math.hypot(hazard.sourceX - station[0], hazard.sourceZ - station[2])).toBeGreaterThan(20)
    expect(Math.hypot(task.targetX - patient.x, task.targetZ - patient.z)).toBeGreaterThanOrEqual(2.8)
    expect(Math.hypot(task.targetX - patient.x, task.targetZ - patient.z)).toBeLessThanOrEqual(5.2)
    expect(world.entities.filter((entity) => entity.kind === 'person' && entity.role === 'responder' && entity.behavior === 'respond')).toHaveLength(2)
    expect(patient.personActivity).toBe('collapsed')
  })
  it('hands medical supplies to a responder without asking the collapsed patient to yield', () => {
    const world = new SimWorld(layout, 321)
    world.triggerEmergency('medical')
    world.setPhase('alarm')
    world.tick(1 / 60)
    const response = world.medicalResponse!
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'medical_support')!
    expect(task.robotId).toBe('humanoid-002')
    const robot = world.entities.find((entity) => entity.id === task.robotId)!
    const patient = world.entities.find((entity) => entity.id === response.victimId)!
    const responder = world.entities.find((entity) => entity.id === response.kitResponderId)!
    response.stage = 'treating'
    robot.x = task.targetX
    robot.z = task.targetZ
    responder.x = patient.x + (robot.x - patient.x) * 0.55
    responder.z = patient.z + (robot.z - patient.z) * 0.55
    world.tick(1 / 60)
    expect(task.status).toBe('observing')
    responder.x = robot.x + 1
    responder.z = robot.z
    responder.targetX = responder.x
    responder.targetZ = responder.z
    task.stageStartedAt = world.simTime
    world.tick(1 / 60)
    expect(task.status).toBe('observing')
    expect(task.medicalRendezvousAcknowledged).toBe(true)
    expect(responder.personActivity).toBe('acknowledgingRobot')
    expect(responder.animation).toBe(4)
    expect(world.events.some((event) =>
      event.type === 'interaction' &&
      event.taskId === task.id &&
      event.data?.interactionKind === 'medical_rendezvous_ack'
    )).toBe(true)
    task.stageStartedAt = world.simTime - 2.5
    world.tick(1 / 60)
    expect(task.status).toBe('interacting')
    expect(responder.personActivity).toBe('receivingKit')
    expect(responder.animation).toBe(5)
    expect(world.events.some((event) => event.data?.interactionKind === 'medical_handoff')).toBe(false)
    task.stageStartedAt = world.simTime - 0.8
    world.tick(1 / 60)
    expect(patient.yieldForTaskId).toBeUndefined()
    expect(Math.hypot(responder.x - robot.x, responder.z - robot.z)).toBeLessThanOrEqual(2.2)
    expect(robot.auxB).toBe(0)
    expect(responder.auxB).toBe(1)
    expect(responder.personActivity).toBe('receivingKit')
    expect(responder.interactionUntil).toBeGreaterThan(world.simTime)
    expect(world.events.some((event) =>
      event.type === 'interaction' &&
      event.taskId === task.id &&
      event.personId === responder.id &&
      event.data?.interactionKind === 'medical_handoff'
    )).toBe(true)
  })
  it('renders an externally confirmed RMF medical handoff at the simulated rendezvous', () => {
    const world = new SimWorld(layout, 322)
    world.triggerEmergency('medical')
    world.setRmfConnection(true, true)
    world.setPhase('alarm')
    const response = world.medicalResponse!
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'medical_support')!
    const robot = world.entities.find((entity) => entity.id === 'humanoid-002')!
    const responder = world.entities.find((entity) => entity.id === response.kitResponderId)!
    const patient = world.entities.find((entity) => entity.id === response.victimId)!
    robot.x = task.targetX - 0.5
    robot.z = task.targetZ
    responder.x = task.targetX + 0.5
    responder.z = task.targetZ
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'medical_support',
      status: 'interacting',
      assignedRobot: robot.id,
      targetId: patient.id,
      interactionKind: 'medical_handoff',
      timestamp: 1_000
    })
    expect(task.medicalHandoffConfirmed).toBe(true)
    expect(task.medicalHandoffEmitted).toBe(true)
    expect(robot.auxB).toBe(0)
    expect(responder.auxB).toBe(1)
    expect(patient.yieldForTaskId).toBeUndefined()
    expect(world.events.some((event) =>
      event.type === 'interaction' &&
      event.robotId === robot.id &&
      event.personId === responder.id &&
      event.data?.interactionKind === 'medical_handoff'
    )).toBe(true)
  })
  it('requires an explicit RMF valve-feedback confirmation before controlling a live gas leak', () => {
    const world = new SimWorld(layout, 323)
    world.triggerEmergency('gasLeak')
    world.setRmfConnection(true, true)
    world.setPhase('alarm')
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'gas_isolation')!
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'observing',
      assignedRobot: 'humanoid-002',
      targetId: task.targetId,
      timestamp: 1_000
    })
    expect(world.emergency.hazardControlled).not.toBe(true)
    const robot = world.entities.find((entity) => entity.id === task.robotId)!
    expect(task.gasSpotterId).toBeUndefined()
    robot.x = task.targetX
    robot.z = task.targetZ
    robot.speed = 0
    for (const person of world.entities.filter((entity) =>
      entity.kind === 'person' &&
      Math.hypot(entity.x - task.targetX, entity.z - task.targetZ) < 1.5
    )) {
      person.x = task.targetX + 5
      person.z = task.targetZ
    }
    world.applyRmfEvent({
      type: 'work_permit',
      taskId: task.id,
      authorized: true,
      authorizedBy: 'site-ehs',
      clearance: 2.25,
      timestamp: 1_500
    })
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'interacting',
      assignedRobot: 'humanoid-002',
      targetId: task.targetId,
      timestamp: 1_800
    })
    world.applyRmfEvent({
      type: 'action_telemetry',
      taskId: task.id,
      category: 'gas_isolation',
      robot: 'humanoid-002',
      phase: 'verified',
      progress: 1,
      leftHandContact: false,
      rightHandContact: false,
      valvePosition: 1,
      gasPpm: 0.7,
      sensorStable: true,
      timestamp: 1_900
    })
    robot.auxA = 0.64
    world.applyRmfEvent({
      type: 'task_state',
      taskId: task.id,
      category: 'gas_isolation',
      status: 'interacting',
      assignedRobot: 'humanoid-002',
      targetId: task.targetId,
      interactionKind: 'gas_isolation_verified',
      timestamp: 2_000
    })
    expect(task.gasValveContactConfirmed).toBe(true)
    expect(task.gasValveActuationConfirmed).toBe(true)
    expect(task.gasIsolationVerified).toBe(true)
    expect(world.emergency.hazardControlled).toBe(true)
    expect(world.emergency.controlledBy).toBe('humanoid_valve')
    expect(robot.auxA).toBe(0.64)
  })
  it('keeps scenario and built-in medical dispatch idempotent', () => {
    const world = new SimWorld(layout, 318)
    world.triggerEmergency('medical')
    world.setPhase('alarm')
    world.dispatchVehicle('igv', 'medical-transport')
    expect(world.entities.filter((entity) => entity.mission === 'medical-transport')).toHaveLength(1)
  })
  it('completes staged responder treatment and IGV transport before medical all-clear', () => {
    const world = new SimWorld(layout, 319)
    world.triggerEmergency('medical')
    world.setPhase('alarm')
    world.setPhase('response')
    const response = world.medicalResponse!
    const hazard = world.emergency.hazard!
    const responders = response.responderIds.map((id) => world.entities.find((entity) => entity.id === id)!)
    const vehicle = world.entities.find((entity) => entity.id === response.vehicleId)!
    for (const responder of responders) { responder.x = responder.goalX; responder.z = responder.goalZ }
    vehicle.x = hazard.sourceX; vehicle.z = hazard.sourceZ
    world.tick(1 / 60)
    expect(response.stage).toBe('treating')
    expect(responders.every((responder) =>
      responder.personActivity === 'treating' &&
      responder.animation === 6 &&
      responder.speed === 0
    )).toBe(true)
    response.kitHandoffComplete = true
    world.tick(1 / 60)
    expect(world.events.some((event) =>
      event.type === 'interaction' &&
      event.data?.interactionKind === 'medical_treatment_started' &&
      event.data?.patientId === response.victimId
    )).toBe(true)
    response.treatmentStartedAt = world.simTime - 30
    world.tick(1 / 60)
    expect(response.stage).toBe('transporting')
    const station = layout.emergency.medicalStation.position
    vehicle.x = station[0]; vehicle.z = station[2]
    world.tick(1 / 60)
    expect(response.stage).toBe('delivered')
    expect(world.emergency.phase).toBe('allClear')
  })
  it('keeps RMF task state synchronized with the assigned humanoid', () => {
    const world = new SimWorld(layout, 322)
    world.applyRmfEvent({
      type: 'task_state',
      taskId: 'rmf-inspection-1',
      category: 'inspection_round',
      status: 'assigned',
      assignedRobot: 'humanoid-001',
      targetId: 'lithography-001',
      timestamp: 1000
    })
    const robot = world.entities.find((entity) => entity.id === 'humanoid-001')!
    expect({ taskId: robot.taskId, activity: robot.activity, controlled: robot.rmfControlled }).toEqual({
      taskId: 'rmf-inspection-1',
      activity: 'walking',
      controlled: true
    })
    world.applyRmfEvent({
      type: 'task_state',
      taskId: 'rmf-inspection-1',
      category: 'inspection_round',
      status: 'completed',
      assignedRobot: 'humanoid-001',
      targetId: 'lithography-001',
      timestamp: 2000
    })
    expect({ taskId: robot.taskId, activity: robot.activity, completed: world.completedHumanoidTasks }).toEqual({
      taskId: undefined,
      activity: 'standby',
      completed: 1
    })
  })
})
