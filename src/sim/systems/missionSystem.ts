import type { SimWorld } from '../world'
import type { SimEntity, TransportMissionRuntime } from '../types'

function equipmentPoint(world: SimWorld, index: number): { id: string; x: number; z: number } {
  const equipment = world.layout.layout.bays.flatMap((bay) => bay.equipment)
  const target = equipment[index % equipment.length]!
  const loadport = target.loadports[0]!
  const x = target.position[0] + loadport.offset[0] * Math.cos(target.rotation) + loadport.offset[2] * Math.sin(target.rotation)
  const z = target.position[2] - loadport.offset[0] * Math.sin(target.rotation) + loadport.offset[2] * Math.cos(target.rotation)
  return { id: loadport.id, x, z }
}

function createMission(world: SimWorld): void {
  if (world.pendingOutputs === 0 || world.simTime - world.lastMissionAt < 2) return
  const sequence = world.missionSequence++
  const from = equipmentPoint(world, sequence * 19)
  const stocker = world.layout.layout.stockers[sequence % world.layout.layout.stockers.length]!
  // A stocker mission ends at its facility-facing dock, not at the middle of
  // the rendered cabinet. The previous centre goal only looked successful
  // because ground vehicles were allowed to overlap static geometry.
  const stockerDockX = stocker.position[0] - Math.sign(stocker.position[0] || 1) * 3.1
  const mission: TransportMissionRuntime = {
    id: `transport-${String(sequence).padStart(4, '0')}`,
    carrierId: `carrier-${String(sequence).padStart(4, '0')}`,
    fromId: from.id,
    toId: stocker.id,
    fromX: from.x,
    fromZ: from.z,
    toX: stockerDockX,
    toZ: stocker.position[2],
    state: 'queued',
    createdAt: world.simTime,
    stageStartedAt: world.simTime
  }
  world.transportMissions.push(mission)
  world.pendingOutputs--
  world.lastMissionAt = world.simTime
  world.log(`${mission.carrierId} 반출 미션이 생성되었습니다.`)
}

function chooseVehicle(world: SimWorld, mission: TransportMissionRuntime): SimEntity | undefined {
  const preferredKind = Number(mission.id.slice(-1)) % 3 === 0 ? 'agv' : 'oht'
  const available = world.entities.filter((entity) => entity.kind === preferredKind && !entity.mission && entity.behavior === 'normal')
  return available.sort((a, b) => Math.hypot(a.x - mission.fromX, a.z - mission.fromZ) - Math.hypot(b.x - mission.fromX, b.z - mission.fromZ))[0]
}

function setGoal(vehicle: SimEntity, x: number, z: number): void {
  vehicle.goalX = x
  vehicle.goalZ = z
  vehicle.route = []
  vehicle.routeCursor = 0
  vehicle.targetX = Number.NaN
  vehicle.targetZ = Number.NaN
  vehicle.targetDelay = 0
}

function updateMission(world: SimWorld, mission: TransportMissionRuntime): void {
  if (mission.state === 'queued') {
    const vehicle = chooseVehicle(world, mission)
    if (!vehicle) return
    mission.assigneeId = vehicle.id
    mission.state = 'assigned'
    mission.stageStartedAt = world.simTime
    vehicle.mission = mission.id
    vehicle.auxA = 0
    vehicle.auxB = 0
    if (vehicle.kind === 'oht') {
      const fromNode = world.layout.railGraph.nodes[world.layout.railGraph.nearest(mission.fromX, mission.fromZ)]!
      const toNode = world.layout.railGraph.nodes[world.layout.railGraph.nearest(mission.toX, mission.toZ)]!
      mission.fromX = fromNode.x; mission.fromZ = fromNode.z; mission.toX = toNode.x; mission.toZ = toNode.z
    }
    setGoal(vehicle, mission.fromX, mission.fromZ)
    world.log(`${vehicle.name}이 ${mission.carrierId} 픽업을 시작합니다.`)
    return
  }
  const vehicle = mission.assigneeId ? world.entities.find((entity) => entity.id === mission.assigneeId) : undefined
  if (!vehicle) { mission.state = 'aborted'; return }
  if (world.emergency.phase !== 'normal' && world.emergency.phase !== 'allClear' && vehicle.behavior !== 'normal') return
  const elapsed = world.simTime - mission.stageStartedAt
  if (mission.state === 'assigned' && Math.hypot(vehicle.x - mission.fromX, vehicle.z - mission.fromZ) < 1.4) {
    mission.state = 'picking'; mission.stageStartedAt = world.simTime; vehicle.targetDelay = 3; vehicle.auxB = 0
  } else if (mission.state === 'picking') {
    vehicle.auxB = Math.min(1, elapsed / 3)
    if (elapsed >= 3) {
      mission.state = 'carrying'; mission.stageStartedAt = world.simTime; vehicle.auxA = 1; vehicle.auxB = 1
      setGoal(vehicle, mission.toX, mission.toZ)
    }
  } else if (mission.state === 'carrying' && Math.hypot(vehicle.x - mission.toX, vehicle.z - mission.toZ) < 1.4) {
    mission.state = 'dropping'; mission.stageStartedAt = world.simTime; vehicle.targetDelay = 3; vehicle.auxB = 1
  } else if (mission.state === 'dropping') {
    vehicle.auxB = Math.max(0, 1 - elapsed / 3)
    if (elapsed >= 3) {
      mission.state = 'done'; mission.stageStartedAt = world.simTime; vehicle.mission = undefined; vehicle.auxA = 0; vehicle.auxB = 0
      world.completedTransportMissions++
      world.events.push({ type: 'missionDone', message: `${vehicle.name}이 ${mission.carrierId} 반출을 완료했습니다.` })
    }
  }
}

export function updateMissions(world: SimWorld): void {
  if (world.emergency.phase === 'normal' || world.emergency.phase === 'allClear') createMission(world)
  for (const mission of world.transportMissions) updateMission(world, mission)
  if (world.transportMissions.length > 80) {
    const active = world.transportMissions.filter((mission) => !['done', 'aborted'].includes(mission.state))
    const recentFinished = world.transportMissions.filter((mission) => ['done', 'aborted'].includes(mission.state)).slice(-20)
    world.transportMissions.splice(0, world.transportMissions.length, ...recentFinished, ...active)
  }
}
