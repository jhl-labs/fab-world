import { MAX_ENTITIES, type EntityKind } from '../core/protocol'
import type { SimEntity } from './types'
import type { SimWorld } from './world'

const maxSpeed: Record<EntityKind, number> = { oht: 5, agv: 1.5, igv: 1.7, humanoid: 1.15, person: 1.2, arm: 0 }
const kindName: Record<EntityKind, string> = { oht: 'OHT', agv: 'AGV', igv: 'IGV', humanoid: '휴머노이드', person: '작업자', arm: '로봇암' }

export function spawnPopulation(world: SimWorld): void {
  const { population } = world.layout.layout
  spawnMany(world, 'oht', population.oht)
  spawnMany(world, 'agv', population.agv)
  spawnMany(world, 'igv', population.igv)
  spawnMany(world, 'humanoid', population.humanoid)
  for (const group of population.people) spawnMany(world, 'person', group.count, group.role)
  spawnMany(world, 'arm', population.arm)
  for (const bay of world.layout.layout.bays) {
    for (const item of bay.equipment) {
      world.equipment.push({ id: item.id, state: 'idle', progress: world.rng.range(0, 5), duration: world.rng.range(35, 90) })
    }
  }
}

function spawnMany(world: SimWorld, kind: EntityKind, count: number, role?: SimEntity['role']): void {
  const graph = kind === 'oht' ? world.layout.railGraph : kind === 'person' || kind === 'humanoid' ? world.layout.walkGraph : world.layout.roadGraph
  const kindOffset = world.entities.filter((entity) => entity.kind === kind).length
  for (let number = 0; number < count; number++) {
    if (world.entities.length >= MAX_ENTITIES) throw new Error(`MAX_ENTITIES(${MAX_ENTITIES})를 초과했습니다.`)
    const index = world.entities.length
    const base = world.layout.layout.emergency.medicalStation.position
    const station = kind === 'humanoid'
      ? world.layout.layout.population.humanoidStations[number]
      : kind === 'person' && role === 'responder'
        ? world.layout.layout.population.responderStations[number]
        : undefined
    const startX = kind === 'humanoid' ? station?.[0] ?? base[0] + number * 2.2 : Number.NaN
    const startZ = kind === 'humanoid' ? station?.[2] ?? base[2] + 3 : Number.NaN
    const randomNode = world.rng.int(0, graph.nodes.length)
    const node = kind === 'humanoid'
      ? graph.nodes[graph.nearest(startX, startZ)]!
      : kind === 'person'
        ? station
          ? findNearestUnoccupiedPersonNode(world, graph.nodes, station[0], station[2])
          : findUnoccupiedPersonNode(world, graph.nodes, randomNode)
        : graph.nodes[randomNode]!
    const y = kind === 'oht' ? world.layout.layout.ohtRail.height - 0.45 : kind === 'person' ? 0.9 : kind === 'arm' ? 1 : kind === 'humanoid' ? 0 : 0.35
    const personProfile = kind === 'person' ? buildPersonMotionProfile(index, role) : undefined
    const preferredSpeed = personProfile?.preferredSpeed ?? maxSpeed[kind]
    const entity: SimEntity = {
      id: `${kind}-${String(kindOffset + number + 1).padStart(3, '0')}`, index, kind, role,
      name: kind === 'humanoid' ? `H${number + 1} ${number === 0 ? '점검 휴머노이드' : '안전 대응 휴머노이드'}` : role ? `${role === 'responder' ? '방재요원' : role === 'engineer' ? '엔지니어' : '오퍼레이터'} ${number + 1}` : `${kindName[kind]} ${number + 1}`,
      x: node.x, y, z: node.z, yaw: world.rng.range(-Math.PI, Math.PI), speed: 0,
      maxSpeed: preferredSpeed, preferredSpeed, trafficSpeedLimit: preferredSpeed, waitTicks: 0,
      status: 'idle', behavior: 'normal', targetX: Number.NaN, targetZ: Number.NaN, targetIndex: world.rng.int(0, Math.max(1, graph.nodes.length)),
      route: [], routeCursor: 0, targetDelay: 0, animation: 0, animationPhase: world.rng.next(), emergency: false,
      ...(kind === 'humanoid' ? { activity: 'standby' as const } : {}),
      ...(kind === 'person' ? {
        personActivity: role === 'responder' ? 'idle' as const : 'patrol' as const,
        nextActionAt: world.simTime + world.rng.range(2, 12),
        emergencySpeed: personProfile!.emergencySpeed,
        alarmReactionDelay: personProfile!.alarmReactionDelay
      } : {}),
      goalX: node.x, goalZ: node.z, homeX: node.x, homeZ: node.z, auxA: 0, auxB: 0, rmfControlled: false, battery: 96 - number * 4
    }
    world.entities.push(entity)
  }
}

function buildPersonMotionProfile(index: number, role: SimEntity['role']): {
  preferredSpeed: number
  emergencySpeed: number
  alarmReactionDelay: number
} {
  // Stable per-person traits avoid synchronized crowds while keeping the
  // exact same worker recognizable and deterministic across scenario runs.
  const pace = stableTrait(index, 11.31)
  const urgency = stableTrait(index, 29.87)
  const acknowledgement = stableTrait(index, 47.53)
  if (role === 'responder') return {
    preferredSpeed: 1.2 + pace * 0.18,
    emergencySpeed: 1.56 + urgency * 0.16,
    alarmReactionDelay: 0.35 + acknowledgement * 0.45
  }
  if (role === 'operator') return {
    preferredSpeed: 1.1 + pace * 0.18,
    emergencySpeed: 1.56 + urgency * 0.16,
    alarmReactionDelay: 0.55 + acknowledgement * 0.9
  }
  return {
    preferredSpeed: 1.05 + pace * 0.19,
    emergencySpeed: 1.56 + urgency * 0.16,
    alarmReactionDelay: 1.15 + acknowledgement * 1.95
  }
}

function stableTrait(index: number, salt: number): number {
  const raw = Math.sin((index + 1) * 12.9898 + salt) * 43_758.5453
  return raw - Math.floor(raw)
}

function findUnoccupiedPersonNode(world: SimWorld, nodes: Array<{ x: number; z: number }>, start: number): { x: number; z: number } {
  const people = world.entities.filter((entity) => entity.kind === 'person')
  for (let offset = 0; offset < nodes.length; offset++) {
    const node = nodes[(start + offset * 37) % nodes.length]!
    if (people.every((person) => Math.hypot(person.x - node.x, person.z - node.z) >= 0.65)) return node
  }
  return nodes[start]!
}

function findNearestUnoccupiedPersonNode(
  world: SimWorld,
  nodes: Array<{ x: number; z: number }>,
  x: number,
  z: number
): { x: number; z: number } {
  const people = world.entities.filter((entity) => entity.kind === 'person')
  const candidates = nodes
    .map((node, index) => ({ node, index, distance: Math.hypot(node.x - x, node.z - z) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
  return candidates.find(({ node }) => people.every((person) => Math.hypot(person.x - node.x, person.z - node.z) >= 0.65))?.node
    ?? candidates[0]!.node
}
