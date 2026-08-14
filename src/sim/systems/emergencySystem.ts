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
    world.simTime - response.treatmentStartedAt >= 30 &&
    vehicle &&
    Math.hypot(vehicle.x - hazard.sourceX, vehicle.z - hazard.sourceZ) < 3
  ) {
    response.stage = 'transporting'
    response.stageStartedAt = world.simTime
    const station = world.layout.layout.emergency.medicalStation.position
    vehicle.auxA = 1
    vehicle.goalX = station[0]; vehicle.goalZ = station[2]; vehicle.route = []; vehicle.routeCursor = 0; vehicle.targetX = Number.NaN; vehicle.targetZ = Number.NaN
    if (victim) victim.carriedById = vehicle.id
    for (const responder of responders) {
      responder.behavior = 'yield'
      responder.goalX = responder.x + Math.cos(responder.yaw + Math.PI / 2) * 4
      responder.goalZ = responder.z + Math.sin(responder.yaw + Math.PI / 2) * 4
      responder.route = []; responder.routeCursor = 0; responder.targetX = Number.NaN; responder.targetZ = Number.NaN
    }
    world.events.push({ type: 'hudMessage', message: '환자를 구급 IGV에 인계해 의무실로 이송합니다.', data: { severity: 'info' } })
  }
  if (response.stage === 'transporting' && vehicle) {
    if (victim) { victim.x = vehicle.x; victim.y = vehicle.y + 0.55; victim.z = vehicle.z; victim.yaw = vehicle.yaw }
    const station = world.layout.layout.emergency.medicalStation.position
    if (Math.hypot(vehicle.x - station[0], vehicle.z - station[2]) < 2) {
      response.stage = 'delivered'
      response.stageStartedAt = world.simTime
      vehicle.mission = undefined; vehicle.behavior = 'normal'; vehicle.emergency = false; vehicle.maxSpeed = 1.7; vehicle.auxA = 0
      if (victim) { victim.x = station[0]; victim.y = 0.9; victim.z = station[2]; victim.behavior = 'normal'; victim.emergency = false; victim.personActivity = 'idle'; victim.animation = 0; victim.carriedById = undefined }
      for (const responder of responders) {
        responder.behavior = 'normal'
        responder.emergency = false
        responder.personActivity = 'idle'
        responder.maxSpeed = responder.preferredSpeed
        responder.interactionUntil = undefined
        responder.auxA = 0
        responder.auxB = 0
      }
      world.events.push({ type: 'hudMessage', message: '환자가 의무실에 인계되었습니다. 현장 통제를 해제합니다.', data: { severity: 'info' } })
      world.setPhase('allClear')
    }
  }
}

export const nextPhase = (phase: EmergencyPhase): EmergencyPhase => PHASE_ORDER[Math.min(PHASE_ORDER.indexOf(phase) + 1, PHASE_ORDER.length - 1)]!
