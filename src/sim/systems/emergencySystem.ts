import type { EmergencyPhase } from '../../core/schema'
import type { SimWorld } from '../world'

const PHASE_ORDER: EmergencyPhase[] = ['normal', 'detected', 'alarm', 'response', 'evacuation', 'allClear']

export function updateEmergency(world: SimWorld, dt: number): void {
  const hazard = world.emergency.hazard
  if (!hazard) return
  const elapsed = world.simTime - world.emergency.startedAt
  if (world.emergency.phase === 'detected' && elapsed >= 3) world.setPhase('alarm')
  if (world.emergency.phase === 'alarm' && elapsed >= 7) world.setPhase('response')
  if (hazard.kind !== 'medical' && world.emergency.phase === 'response' && elapsed >= 13) world.setPhase('evacuation')
  if (hazard.kind === 'medical') updateMedicalResponse(world)
  if (hazard.kind !== 'medical' && hazard.kind !== 'gasLeak' && elapsed >= (hazard.fixedAt ?? 75)) {
    world.markHazardControlled('responder')
  }
  if (hazard.kind !== 'medical' && world.emergency.hazardControlled && world.assemblyComplete()) world.setPhase('allClear')
  if (world.emergency.phase === 'allClear' || world.emergency.hazardControlled) hazard.radius = Math.max(0, hazard.radius - hazard.spreadRate * 1.5 * dt)
  else hazard.radius = Math.min(hazard.maxRadius, hazard.radius + hazard.spreadRate * dt)
  world.refreshHazards()
  if (world.emergency.phase === 'allClear' && hazard.radius === 0 && world.simTime - (world.emergency.phaseStartedAt ?? world.simTime) >= 3) world.finishEmergency()
}

function updateMedicalResponse(world: SimWorld): void {
  const response = world.medicalResponse
  const hazard = world.emergency.hazard
  if (!response || !hazard) return
  const victim = world.entities.find((entity) => entity.id === response.victimId)
  const responders = response.responderIds.map((id) => world.entities.find((entity) => entity.id === id)).filter((entity) => entity !== undefined)
  const vehicle = response.vehicleId ? world.entities.find((entity) => entity.id === response.vehicleId) : undefined
  // The patient, two kneeling responders, and the staged IGV all have real
  // body envelopes. Treat 2.7m as the cleared treatment perimeter so collision
  // separation does not invalidate an otherwise ready two-person team.
  if (response.stage === 'dispatched' && responders.length >= 2 && responders.every((entity) => Math.hypot(entity.x - hazard.sourceX, entity.z - hazard.sourceZ) < 2.7)) {
    response.stage = 'treating'
    response.stageStartedAt = world.simTime
    world.events.push({ type: 'hudMessage', message: '구조 인력 2인이 환자 상태를 평가하고 응급처치를 시작합니다.', data: { severity: 'warning' } })
  }
  const treatmentReady = response.stage === 'treating' &&
    response.kitHandoffComplete === true &&
    responders.length >= 2 &&
    responders.every((responder) => responder.personActivity === 'treating' && responder.speed === 0)
  if (treatmentReady && response.treatmentStartedAt === undefined) {
    response.treatmentStartedAt = world.simTime
  }
  if (treatmentReady && !response.treatmentCameraEmitted) {
    const medicalTask = world.humanoidTasks.find((task) => task.kind === 'medical_support')
    const robot = medicalTask?.robotId ? world.entities.find((entity) => entity.id === medicalTask.robotId) : undefined
    const leadResponder = responders.find((entity) => entity.id === response.kitResponderId) ?? responders[0]
    if (robot && leadResponder && victim) {
      response.treatmentCameraEmitted = true
      world.events.push({
        type: 'interaction',
        taskId: medicalTask?.id,
        robotId: robot.id,
        personId: leadResponder.id,
        message: `${leadResponder.name}이 전달받은 키트를 열고 환자 처치를 시작합니다.`,
        data: {
          interactionKind: 'medical_treatment_started',
          robotX: robot.x,
          robotZ: robot.z,
          personX: leadResponder.x,
          personZ: leadResponder.z,
          patientId: victim.id,
          patientX: victim.x,
          patientZ: victim.z
        }
      })
    }
  }
  if (
    response.stage === 'treating' &&
    response.treatmentStartedAt !== undefined &&
    world.simTime - response.treatmentStartedAt >= 10 &&
    vehicle &&
    Math.hypot(vehicle.x - hazard.sourceX, vehicle.z - hazard.sourceZ) < 3
  ) {
    response.stage = 'loading'
    response.stageStartedAt = world.simTime
    vehicle.speed = 0
    vehicle.auxA = 0
    vehicle.goalX = vehicle.x; vehicle.goalZ = vehicle.z; vehicle.route = []; vehicle.routeCursor = 0; vehicle.targetX = vehicle.x; vehicle.targetZ = vehicle.z
    if (victim) {
      response.loadingStartX = victim.x
      response.loadingStartY = victim.y
      response.loadingStartZ = victim.z
      response.loadingStartYaw = victim.yaw
      victim.carriedById = vehicle.id
    }
    world.events.push({
      type: 'interaction',
      robotId: vehicle.id,
      personId: victim?.id,
      message: '구조 인력이 환자를 구급 IGV의 전동 들것에 탑승시킵니다.',
      data: {
        interactionKind: 'medical_loading_started',
        robotX: vehicle.x,
        robotZ: vehicle.z,
        personX: victim?.x ?? hazard.sourceX,
        personZ: victim?.z ?? hazard.sourceZ,
        patientId: victim?.id ?? response.victimId,
        patientX: victim?.x ?? hazard.sourceX,
        patientZ: victim?.z ?? hazard.sourceZ
      }
    })
    for (const responder of responders) {
      responder.behavior = 'yield'
      responder.goalX = responder.x + Math.cos(responder.yaw + Math.PI / 2) * 4
      responder.goalZ = responder.z + Math.sin(responder.yaw + Math.PI / 2) * 4
      responder.route = []; responder.routeCursor = 0; responder.targetX = Number.NaN; responder.targetZ = Number.NaN
    }
  }
  if (response.stage === 'loading' && vehicle) {
    const elapsed = world.simTime - response.stageStartedAt
    const progress = Math.min(1, elapsed / 4)
    const eased = progress * progress * (3 - 2 * progress)
    vehicle.speed = 0
    vehicle.auxA = progress
    if (victim) {
      const targetX = vehicle.x + Math.cos(vehicle.yaw) * 0.72
      const targetZ = vehicle.z + Math.sin(vehicle.yaw) * 0.72
      victim.x = (response.loadingStartX ?? victim.x) + (targetX - (response.loadingStartX ?? victim.x)) * eased
      victim.y = (response.loadingStartY ?? victim.y) + (vehicle.y + 1.25 - (response.loadingStartY ?? victim.y)) * eased
      victim.z = (response.loadingStartZ ?? victim.z) + (targetZ - (response.loadingStartZ ?? victim.z)) * eased
      victim.yaw = (response.loadingStartYaw ?? victim.yaw) + (vehicle.yaw - (response.loadingStartYaw ?? victim.yaw)) * eased
    }
    if (progress >= 1) {
      response.stage = 'transporting'
      response.stageStartedAt = world.simTime
      const station = world.layout.layout.emergency.medicalStation.position
      vehicle.auxA = 1
      vehicle.goalX = station[0]; vehicle.goalZ = station[2]; vehicle.route = []; vehicle.routeCursor = 0; vehicle.targetX = Number.NaN; vehicle.targetZ = Number.NaN
      world.events.push({
        type: 'interaction',
        robotId: vehicle.id,
        personId: victim?.id,
        message: '환자를 고정하고 의료 안전 구역으로 긴급 이송을 시작합니다.',
        data: {
          interactionKind: 'medical_transport_started',
          robotX: vehicle.x,
          robotZ: vehicle.z,
          personX: victim?.x ?? vehicle.x,
          personZ: victim?.z ?? vehicle.z,
          patientId: victim?.id ?? response.victimId,
          patientX: victim?.x ?? vehicle.x,
          patientZ: victim?.z ?? vehicle.z,
          stationX: station[0],
          stationZ: station[2]
        }
      })
      world.events.push({ type: 'hudMessage', message: '환자를 구급 IGV에 탑승시켜 의료 안전 구역으로 이송합니다.', data: { severity: 'info' } })
    }
  }
  if (response.stage === 'transporting' && vehicle) {
    if (victim) { victim.x = vehicle.x + Math.cos(vehicle.yaw) * 0.72; victim.y = vehicle.y + 1.25; victim.z = vehicle.z + Math.sin(vehicle.yaw) * 0.72; victim.yaw = vehicle.yaw }
    const station = world.layout.layout.emergency.medicalStation.position
    if (Math.hypot(vehicle.x - station[0], vehicle.z - station[2]) < 2) {
      response.stage = 'delivered'
      response.stageStartedAt = world.simTime
      vehicle.speed = 0; vehicle.goalX = vehicle.x; vehicle.goalZ = vehicle.z; vehicle.targetX = vehicle.x; vehicle.targetZ = vehicle.z; vehicle.auxA = 1
      world.events.push({
        type: 'interaction',
        robotId: vehicle.id,
        personId: victim?.id,
        message: '구급 IGV가 의료 안전 구역에 도착해 환자 인계를 시작합니다.',
        data: {
          interactionKind: 'medical_transport_arrived',
          robotX: vehicle.x,
          robotZ: vehicle.z,
          personX: victim?.x ?? vehicle.x,
          personZ: victim?.z ?? vehicle.z,
          patientId: victim?.id ?? response.victimId,
          patientX: victim?.x ?? vehicle.x,
          patientZ: victim?.z ?? vehicle.z,
          stationX: station[0],
          stationZ: station[2]
        }
      })
      world.events.push({ type: 'hudMessage', message: '환자가 의료 안전 구역에 도착했습니다. 인계 절차를 진행합니다.', data: { severity: 'info' } })
    }
  }
  if (response.stage === 'delivered' && vehicle && world.simTime - response.stageStartedAt >= 4) {
      const station = world.layout.layout.emergency.medicalStation.position
      vehicle.mission = undefined; vehicle.behavior = 'normal'; vehicle.emergency = false; vehicle.maxSpeed = 1.7; vehicle.auxA = 0
      if (victim) { victim.x = station[0] + 2.2; victim.y = 0.9; victim.z = station[2]; victim.behavior = 'normal'; victim.emergency = false; victim.personActivity = 'idle'; victim.animation = 0; victim.carriedById = undefined }
      for (const responder of responders) {
        responder.behavior = 'normal'
        responder.emergency = false
        responder.personActivity = 'idle'
        responder.maxSpeed = responder.preferredSpeed
        responder.interactionUntil = undefined
        responder.auxA = 0
        responder.auxB = 0
      }
      world.events.push({ type: 'hudMessage', message: '환자가 의료진에게 인계되었습니다. 현장 통제를 해제합니다.', data: { severity: 'info' } })
      world.setPhase('allClear')
  }
}

export const nextPhase = (phase: EmergencyPhase): EmergencyPhase => PHASE_ORDER[Math.min(PHASE_ORDER.indexOf(phase) + 1, PHASE_ORDER.length - 1)]!
