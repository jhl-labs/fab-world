import type { EmergencyKind, HumanoidTaskRequest } from '../core/schema'
import { GAS_VALVE_STANDOFF } from '../core/interactionGeometry'
import type { SimWorld } from './world'

interface HumanoidTarget {
  id: string
  x: number
  z: number
  yaw?: number
}

export function findHazardSource(world: SimWorld, kind: EmergencyKind, preferredId?: string): readonly [number, number, number] | undefined {
  if (kind === 'medical') {
    const station = world.layout.layout.emergency.medicalStation.position
    const demonstrationDistance = 45
    const person = world.entities
      .filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
      .sort((a, b) =>
        Math.abs(Math.hypot(a.x - station[0], a.z - station[2]) - demonstrationDistance) -
        Math.abs(Math.hypot(b.x - station[0], b.z - station[2]) - demonstrationDistance)
      )[0]
    return person ? [person.x, 0, person.z] : undefined
  }
  if (preferredId) {
    const selected = world.layout.equipmentPositions.get(preferredId)
    if (selected) return selected
  }
  const candidates = world.layout.layout.bays.flatMap((bay) => bay.equipment).filter((equipment) => equipment.hazardCapable)
  return candidates.length > 0 ? world.rng.pick(candidates).position : undefined
}

export function resolveHumanoidTarget(world: SimWorld, request: HumanoidTaskRequest): HumanoidTarget {
  if (request.kind === 'medical_support') {
    const patient = request.target
      ? { id: request.targetId ?? 'medical-patient', x: request.target[0], z: request.target[1] }
      : request.targetId
        ? world.entities.find((entity) => entity.id === request.targetId && entity.kind === 'person')
        : world.entities.find((entity) => entity.kind === 'person' && entity.personActivity === 'collapsed')
    if (patient) {
      const availableRobot = world.entities
        .filter((entity) => entity.kind === 'humanoid' && !entity.taskId)
        .sort((left, right) =>
          Math.hypot(left.x - patient.x, left.z - patient.z) -
          Math.hypot(right.x - patient.x, right.z - patient.z)
        )[0]
      // Use a real navigation node outside the patient treatment perimeter.
      // The world assigns one responder to rendezvous at this same safe point.
      const supportNode = world.layout.walkGraph.nodes
        .map((node, index) => ({
          node,
          index,
          patientDistance: Math.hypot(node.x - patient.x, node.z - patient.z),
          robotDistance: availableRobot ? Math.hypot(node.x - availableRobot.x, node.z - availableRobot.z) : 0
        }))
        .filter(({ patientDistance }) => patientDistance >= 2.8 && patientDistance <= 5.2)
        .sort((left, right) =>
          left.robotDistance + Math.abs(left.patientDistance - 3.4) * 2 -
            (right.robotDistance + Math.abs(right.patientDistance - 3.4) * 2) ||
          left.index - right.index
        )[0]?.node
      if (supportNode) return { id: patient.id, x: supportNode.x, z: supportNode.z }
    }
  }
  if (request.target) {
    return {
      id: request.targetId ?? 'operator-target',
      x: request.target[0],
      z: request.target[1],
      ...(request.targetYaw !== undefined ? { yaw: request.targetYaw } : {})
    }
  }
  if (request.targetId) {
    const equipment = world.layout.layout.bays.flatMap((bay) => bay.equipment).find((candidate) => candidate.id === request.targetId)
    if (equipment) {
      const loadport = equipment.loadports[0]!
      const offsetX = loadport.offset[0] * Math.cos(equipment.rotation) + loadport.offset[2] * Math.sin(equipment.rotation)
      const offsetZ = -loadport.offset[0] * Math.sin(equipment.rotation) + loadport.offset[2] * Math.cos(equipment.rotation)
      const x = equipment.position[0] + offsetX
      const z = equipment.position[2] + offsetZ
      return {
        id: request.targetId,
        x,
        z,
        yaw: Math.atan2(equipment.position[2] - z, equipment.position[0] - x)
      }
    }
    const device = world.layout.layout.emergency.safetyDevices.find((candidate) => candidate.id === request.targetId)
    if (device) {
      return {
        id: device.id,
        x: device.position[0] - Math.cos(device.heading) * GAS_VALVE_STANDOFF,
        z: device.position[2] - Math.sin(device.heading) * GAS_VALVE_STANDOFF,
        yaw: device.heading
      }
    }
  }
  if (request.kind === 'gas_isolation') {
    const hazard = world.emergency.hazard
    const devices = world.layout.layout.emergency.safetyDevices.filter((device) => device.kind === 'gas-isolation-valve')
    const device = devices.sort((a, b) => {
      if (!hazard) return 0
      return Math.hypot(a.position[0] - hazard.sourceX, a.position[2] - hazard.sourceZ) - Math.hypot(b.position[0] - hazard.sourceX, b.position[2] - hazard.sourceZ)
    })[0]
    if (device) {
      return {
        id: device.id,
        x: device.position[0] - Math.cos(device.heading) * GAS_VALVE_STANDOFF,
        z: device.position[2] - Math.sin(device.heading) * GAS_VALVE_STANDOFF,
        yaw: device.heading
      }
    }
  }
  if (request.kind === 'medical_support') {
    const station = world.layout.layout.emergency.medicalStation.position
    return { id: 'medical-station', x: station[0], z: station[2] }
  }
  const equipment = world.layout.layout.bays.flatMap((bay) => bay.equipment).find((item) => item.hazardCapable) ?? world.layout.layout.bays[0]!.equipment[0]!
  const loadport = equipment.loadports[0]!
  return { id: equipment.id, x: equipment.position[0] + loadport.offset[0], z: equipment.position[2] + loadport.offset[2] }
}
