import { readFileSync } from 'node:fs'
import { FabLayoutSchema, ScenarioSchema } from '../src/core/schema'
import { FIXED_DT, SIM_HZ } from '../src/sim/clock'
import { SimWorld } from '../src/sim/world'

const layout = FabLayoutSchema.parse(JSON.parse(readFileSync(new URL('../data/layouts/fab-default.json', import.meta.url), 'utf8')))
const medicalScenario = ScenarioSchema.parse(JSON.parse(readFileSync(new URL('../data/scenarios/medical.json', import.meta.url), 'utf8')))

function runFor(world: SimWorld, seconds: number): void {
  for (let tick = 0; tick < seconds * SIM_HZ; tick++) world.tick(FIXED_DT)
}

const showcaseWorld = new SimWorld(layout, 20260729)
showcaseWorld.startHumanoidShowcase()
let showcaseIncidentAt: number | undefined
let showcaseGasTaskAt: number | undefined
let showcaseVerifiedAt: number | undefined
let showcaseReturnedToNormalAt: number | undefined
for (let tick = 0; tick < 240 * SIM_HZ; tick++) {
  showcaseWorld.tick(FIXED_DT)
  showcaseIncidentAt ??= showcaseWorld.events.some((event) =>
    event.message?.includes('가스 이상 징후를 보고')
  ) ? showcaseWorld.simTime : undefined
  showcaseGasTaskAt ??= showcaseWorld.humanoidTasks.some((task) =>
    task.kind === 'gas_isolation'
  ) ? showcaseWorld.simTime : undefined
  showcaseVerifiedAt ??= showcaseWorld.metrics.gasIsolationVerified
    ? showcaseWorld.simTime
    : undefined
  if (showcaseVerifiedAt !== undefined && showcaseWorld.emergency.phase === 'normal') {
    showcaseReturnedToNormalAt = showcaseWorld.simTime
    break
  }
}
const showcaseInspection = showcaseWorld.humanoidTasks.find((task) => task.kind === 'inspection_round')
const showcaseGasTask = showcaseWorld.humanoidTasks.find((task) => task.kind === 'gas_isolation')
if (!showcaseInspection || !showcaseGasTask) {
  throw new Error('Integrated showcase did not create both inspection and gas-isolation tasks')
}
if (
  showcaseIncidentAt === undefined ||
  showcaseGasTaskAt === undefined ||
  showcaseVerifiedAt === undefined ||
  showcaseReturnedToNormalAt === undefined
) {
  throw new Error(`Integrated showcase did not complete its inspection→incident→gas verification→recovery chain: ${JSON.stringify({
    incidentAt: showcaseIncidentAt,
    gasTaskAt: showcaseGasTaskAt,
    verifiedAt: showcaseVerifiedAt,
    returnedToNormalAt: showcaseReturnedToNormalAt,
    phase: showcaseWorld.emergency.phase,
    evacuated: showcaseWorld.metrics.evacuated,
    totalEvacuees: showcaseWorld.metrics.totalEvacuees,
    tasks: showcaseWorld.humanoidTasks.map((task) => ({ kind: task.kind, status: task.status, robotId: task.robotId }))
  })}`)
}
if (!(showcaseIncidentAt <= showcaseGasTaskAt && showcaseGasTaskAt < showcaseVerifiedAt)) {
  throw new Error(
    `Integrated showcase causal order is invalid: ${showcaseIncidentAt}, ` +
    `${showcaseGasTaskAt}, ${showcaseVerifiedAt}`
  )
}
if (
  showcaseInspection.requestedBy !== 'showcase' ||
  showcaseGasTask.requestedBy !== 'showcase' ||
  showcaseInspection.status !== 'completed' ||
  showcaseGasTask.status !== 'completed'
) {
  throw new Error('Integrated showcase tasks did not preserve showcase provenance through completion')
}
if (!showcaseInspection.robotId || !showcaseGasTask.robotId || showcaseInspection.robotId === showcaseGasTask.robotId) {
  throw new Error(
    `Integrated showcase did not split inspection and hazardous isolation roles: ` +
    `${showcaseInspection.robotId ?? 'none'}, ${showcaseGasTask.robotId ?? 'none'}`
  )
}

const comparisonHumanWorld = new SimWorld(layout, 20260729)
comparisonHumanWorld.startRiskComparison('human')
for (let tick = 0; tick < 180 * SIM_HZ && !comparisonHumanWorld.riskComparisonResult; tick++) {
  comparisonHumanWorld.tick(FIXED_DT)
}
const comparisonHuman = comparisonHumanWorld.riskComparisonResult
if (
  !comparisonHuman ||
  comparisonHuman.humanEntries !== 1 ||
  comparisonHuman.humanoidEntries !== 0 ||
  comparisonHuman.humanWorkZoneSeconds < 8.2 ||
  !comparisonHuman.verified
) {
  throw new Error(`Human A/B baseline is not a verified direct-work observation: ${JSON.stringify(comparisonHuman)}`)
}
const comparisonHumanoidWorld = new SimWorld(layout, 20260729)
comparisonHumanoidWorld.startRiskComparison('humanoid', {
  sourceEquipmentId: comparisonHuman.sourceEquipmentId,
  targetId: comparisonHuman.targetId
})
for (let tick = 0; tick < 180 * SIM_HZ && !comparisonHumanoidWorld.riskComparisonResult; tick++) {
  comparisonHumanoidWorld.tick(FIXED_DT)
}
const comparisonHumanoid = comparisonHumanoidWorld.riskComparisonResult
if (
  !comparisonHumanoid ||
  comparisonHumanoid.sourceEquipmentId !== comparisonHuman.sourceEquipmentId ||
  comparisonHumanoid.targetId !== comparisonHuman.targetId ||
  comparisonHumanoid.humanEntries !== 0 ||
  comparisonHumanoid.humanoidEntries !== 1 ||
  comparisonHumanoid.humanWorkZoneSeconds !== 0 ||
  !comparisonHumanoid.verified
) {
  throw new Error(`Humanoid A/B run did not preserve the same incident with zero human entry: ${JSON.stringify(comparisonHumanoid)}`)
}

const gasWorld = new SimWorld(layout, 42)
gasWorld.triggerEmergency('gasLeak')
let evacuationCompletedAt: number | undefined
let gasPeakHeldEquipment = 0
let gasValveContactAt: number | undefined
let gasValveClosedAt: number | undefined
let gasIsolationVerifiedAt: number | undefined
let gasSensorMonitoringAt: number | undefined
let gasControlledAtValveClosure = false
let gasEventCursor = 0
let gasWorkPoseError: number | undefined
let gasWorkYawError: number | undefined
const gasCollaborationSequence: string[] = []
for (let tick = 0; tick < 300 * SIM_HZ; tick++) {
  gasWorld.tick(FIXED_DT)
  for (const event of gasWorld.events.slice(gasEventCursor)) {
    if (event.type !== 'interaction') continue
    if (typeof event.data?.interactionKind === 'string' && event.data.interactionKind.startsWith('gas_')) {
      gasCollaborationSequence.push(event.data.interactionKind)
    }
    if (event.data?.interactionKind === 'gas_valve_contact') {
      gasValveContactAt ??= gasWorld.metrics.emergencyElapsed
      const task = gasWorld.humanoidTasks.find((candidate) => candidate.id === event.taskId)
      const robot = task?.robotId
        ? gasWorld.entities.find((entity) => entity.id === task.robotId)
        : undefined
      if (task && robot) {
        gasWorkPoseError ??= Math.hypot(robot.x - task.targetX, robot.z - task.targetZ)
        if (task.targetYaw !== undefined) {
          gasWorkYawError ??= Math.abs(Math.atan2(
            Math.sin(robot.yaw - task.targetYaw),
            Math.cos(robot.yaw - task.targetYaw)
          ))
        }
      }
    }
    if (event.data?.interactionKind === 'gas_valve_closed') {
      gasValveClosedAt ??= gasWorld.metrics.emergencyElapsed
      gasControlledAtValveClosure ||= gasWorld.emergency.hazardControlled === true
    }
    if (event.data?.interactionKind === 'gas_sensor_monitoring') gasSensorMonitoringAt ??= gasWorld.metrics.emergencyElapsed
    if (event.data?.interactionKind === 'gas_isolation_verified') gasIsolationVerifiedAt ??= gasWorld.metrics.emergencyElapsed
  }
  gasEventCursor = gasWorld.events.length
  gasPeakHeldEquipment = Math.max(gasPeakHeldEquipment, gasWorld.metrics.heldEquipment)
  if (gasWorld.metrics.evacuated === gasWorld.metrics.totalEvacuees) {
    evacuationCompletedAt = gasWorld.simTime
    break
  }
}
if (evacuationCompletedAt === undefined) throw new Error('Gas evacuation did not complete within 300 sim seconds')
if (gasPeakHeldEquipment === 0 || gasPeakHeldEquipment >= gasWorld.equipment.length) throw new Error(`Gas equipment hold scope is not localized: ${gasPeakHeldEquipment}`)
if (gasValveContactAt === undefined || gasValveClosedAt === undefined || gasIsolationVerifiedAt === undefined) {
  throw new Error('Gas isolation did not emit the complete contact, valve-closure, and sensor-verification sequence')
}
if (gasSensorMonitoringAt === undefined) {
  throw new Error('Gas isolation did not include the humanoid sensor-monitoring stage')
}
if (!(
  gasValveContactAt < gasValveClosedAt &&
  gasValveClosedAt <= gasSensorMonitoringAt &&
  gasSensorMonitoringAt < gasIsolationVerifiedAt
)) {
  throw new Error(
    `Gas isolation is out of order: ${gasValveContactAt}, ` +
      `${gasValveClosedAt}, ${gasSensorMonitoringAt}, ${gasIsolationVerifiedAt}`
  )
}
if (gasCollaborationSequence.join(',') !== [
  'gas_valve_contact',
  'gas_valve_closed',
  'gas_sensor_monitoring',
  'gas_isolation_verified'
].join(',')) {
  throw new Error(`Robot-only gas isolation event order is invalid: ${gasCollaborationSequence.join(',')}`)
}
if (gasControlledAtValveClosure) throw new Error('Gas hazard was controlled before sensor verification')
if (gasWorkPoseError === undefined || gasWorkPoseError > 0.05) {
  throw new Error(`Humanoid did not reach the precise valve work pose before contact: ${gasWorkPoseError ?? 'missing'}`)
}
if (gasWorkYawError === undefined || gasWorkYawError > 0.05) {
  throw new Error(`Humanoid was not facing the valve before contact: ${gasWorkYawError ?? 'missing'}`)
}
if (gasWorld.emergency.controlledBy !== 'humanoid_valve') {
  throw new Error(`Gas hazard was not attributed to humanoid valve feedback: ${gasWorld.emergency.controlledBy ?? 'none'}`)
}
if (gasWorld.metrics.hazardousManualActionsDelegated !== 1) {
  throw new Error(`Gas mission effect did not record one delegated hazardous manual action: ${gasWorld.metrics.hazardousManualActionsDelegated}`)
}
if (
  gasWorld.metrics.gasWorkZoneHumanEntries !== 0 ||
  gasWorld.metrics.gasWorkZoneRobotEntries !== 1
) {
  throw new Error(
    `Authorized gas work-point staffing was not human=0/humanoid=1: ` +
    `${gasWorld.metrics.gasWorkZoneHumanEntries}/${gasWorld.metrics.gasWorkZoneRobotEntries}`
  )
}
if (gasWorld.metrics.gasSpotterClearance !== 0) {
  throw new Error(`No person may be retained as a gas spotter: ${gasWorld.metrics.gasSpotterClearance}`)
}
if (
  gasWorld.metrics.verifiedSafetyGates !== 1 ||
  gasWorld.metrics.gasIsolationElapsed !== gasIsolationVerifiedAt
) {
  throw new Error(
    `Gas mission effect did not preserve the verified isolation result: ` +
    `${gasWorld.metrics.verifiedSafetyGates}, ${gasWorld.metrics.gasIsolationElapsed}`
  )
}
const gasControlSource = gasWorld.emergency.controlledBy
while (gasWorld.emergency.phase !== 'normal' && gasWorld.simTime < 310) gasWorld.tick(FIXED_DT)
const baselineWorld = new SimWorld(layout, 42)
runFor(baselineWorld, gasWorld.simTime)
const beforeBaselineWindow = baselineWorld.completedProcesses
runFor(baselineWorld, 60)
const baselineThroughput = baselineWorld.completedProcesses - beforeBaselineWindow
const beforeRecovery = gasWorld.completedProcesses
runFor(gasWorld, 60)
const recoveredThroughput = gasWorld.completedProcesses - beforeRecovery
const recoveryRatio = baselineThroughput === 0 ? 0 : recoveredThroughput / baselineThroughput
if (recoveryRatio < 0.9) throw new Error(`Throughput recovery ${recoveryRatio.toFixed(3)} is below 90%`)

const fireWorld = new SimWorld(layout, 77)
fireWorld.triggerEmergency('fire')
let fireEvacuationCompletedAt: number | undefined
let fireReturnedToNormalAt: number | undefined
let firePeakHeldEquipment = 0
let fireSafeStoppedHumanoids = 0
for (let tick = 0; tick < 300 * SIM_HZ; tick++) {
  fireWorld.tick(FIXED_DT)
  firePeakHeldEquipment = Math.max(firePeakHeldEquipment, fireWorld.metrics.heldEquipment)
  fireSafeStoppedHumanoids = Math.max(fireSafeStoppedHumanoids, fireWorld.entities.filter((entity) => entity.kind === 'humanoid' && entity.activity === 'safeStop').length)
  if (fireEvacuationCompletedAt === undefined && fireWorld.metrics.evacuated === fireWorld.metrics.totalEvacuees) {
    fireEvacuationCompletedAt = fireWorld.simTime
  }
  if (fireWorld.emergency.phase === 'normal') {
    fireReturnedToNormalAt = fireWorld.simTime
    break
  }
}
if (fireEvacuationCompletedAt === undefined) throw new Error('Fire evacuation did not complete within 300 sim seconds')
if (fireReturnedToNormalAt === undefined) throw new Error('Fire scenario did not recover to normal within 300 sim seconds')
if (firePeakHeldEquipment === 0 || firePeakHeldEquipment >= fireWorld.equipment.length) throw new Error(`Fire equipment hold scope is not localized: ${firePeakHeldEquipment}`)
if (fireSafeStoppedHumanoids === 0) throw new Error('No humanoid reached a fire safe-stop point')

const medicalWorld = new SimWorld(layout, 126)
medicalWorld.loadScenario(medicalScenario)
let medicalDeliveredAt: number | undefined
let medicalSupportCompletedAt: number | undefined
let medicalHandoffAt: number | undefined
let medicalAcknowledgedAt: number | undefined
let treatmentPostureObserved = false
let treatmentCameraEventObserved = false
let vehicleInterferenceTicks = 0
let medicalPeakHeldEquipment = 0
for (let tick = 0; tick < 90 * SIM_HZ; tick++) {
  medicalWorld.tick(FIXED_DT)
  medicalPeakHeldEquipment = Math.max(medicalPeakHeldEquipment, medicalWorld.metrics.heldEquipment)
  const response = medicalWorld.medicalResponse
  const vehicle = response?.vehicleId ? medicalWorld.entities.find((entity) => entity.id === response.vehicleId) : undefined
  if (response?.stage === 'transporting' && vehicle) {
    const interfering = medicalWorld.entities.some((entity) =>
      entity !== vehicle &&
      !entity.carriedById &&
      (entity.kind === 'agv' || entity.kind === 'igv') &&
      Math.hypot(entity.x - vehicle.x, entity.z - vehicle.z) < 1.5
    )
    if (interfering) vehicleInterferenceTicks++
  }
  const medicalTask = medicalWorld.humanoidTasks.find((task) => task.kind === 'medical_support')
  if (medicalTask?.status === 'completed' && medicalSupportCompletedAt === undefined) medicalSupportCompletedAt = medicalWorld.metrics.emergencyElapsed
  if (
    medicalAcknowledgedAt === undefined &&
    medicalWorld.events.some((event) => event.type === 'interaction' && event.data?.interactionKind === 'medical_rendezvous_ack')
  ) medicalAcknowledgedAt = medicalWorld.metrics.emergencyElapsed
  if (
    medicalHandoffAt === undefined &&
    medicalWorld.events.some((event) => event.type === 'interaction' && event.data?.interactionKind === 'medical_handoff')
  ) medicalHandoffAt = medicalWorld.metrics.emergencyElapsed
  if (response?.stage === 'treating') {
    const responders = response.responderIds
      .map((id) => medicalWorld.entities.find((entity) => entity.id === id))
      .filter((entity) => entity !== undefined)
    treatmentPostureObserved ||= responders.length >= 2 && responders.every((responder) =>
      responder.personActivity === 'treating' &&
      responder.animation === 6 &&
      responder.speed === 0
    )
    treatmentCameraEventObserved ||= medicalWorld.events.some((event) =>
      event.type === 'interaction' && event.data?.interactionKind === 'medical_treatment_started'
    )
  }
  if (response?.stage === 'delivered') medicalDeliveredAt ??= medicalWorld.metrics.emergencyElapsed
  if (medicalDeliveredAt !== undefined && medicalSupportCompletedAt !== undefined && medicalHandoffAt !== undefined) break
}
if (medicalDeliveredAt === undefined) throw new Error('Medical IGV did not deliver the patient within 90 sim seconds')
if (medicalAcknowledgedAt === undefined) throw new Error('Responder did not visibly acknowledge the humanoid before the medical handoff')
if (medicalHandoffAt === undefined) throw new Error('Humanoid did not hand the medical kit to a responder within 90 sim seconds')
if (medicalAcknowledgedAt >= medicalHandoffAt) throw new Error('Medical kit transferred before the responder acknowledgement')
if (medicalSupportCompletedAt === undefined) throw new Error('Humanoid medical support task did not complete within 90 sim seconds')
if (!treatmentPostureObserved) throw new Error('Responders never entered the kneeling treatment posture')
if (!treatmentCameraEventObserved) throw new Error('Medical treatment never emitted a three-party camera event')
if (vehicleInterferenceTicks > 0) throw new Error(`Medical route had ${vehicleInterferenceTicks} vehicle interference ticks`)
if (medicalPeakHeldEquipment !== 0) throw new Error(`Medical response incorrectly held ${medicalPeakHeldEquipment} fab equipment`)

console.log(JSON.stringify({
  showcase: {
    inspectionRobot: showcaseInspection.robotId,
    isolationRobot: showcaseGasTask.robotId,
    incidentAt: Number(showcaseIncidentAt.toFixed(3)),
    isolationTaskAt: Number(showcaseGasTaskAt.toFixed(3)),
    verifiedAt: Number(showcaseVerifiedAt.toFixed(3)),
    returnedToNormalAt: Number(showcaseReturnedToNormalAt.toFixed(3))
  },
  riskComparison: {
    sourceEquipmentId: comparisonHuman.sourceEquipmentId,
    targetId: comparisonHuman.targetId,
    human: {
      entries: comparisonHuman.humanEntries,
      exposurePersonSeconds: Number(comparisonHuman.humanWorkZoneSeconds.toFixed(3)),
      isolationElapsed: Number(comparisonHuman.isolationElapsed.toFixed(3))
    },
    humanoid: {
      humanEntries: comparisonHumanoid.humanEntries,
      humanoidEntries: comparisonHumanoid.humanoidEntries,
      exposurePersonSeconds: Number(comparisonHumanoid.humanWorkZoneSeconds.toFixed(3)),
      isolationElapsed: Number(comparisonHumanoid.isolationElapsed.toFixed(3))
    },
    avoidedExposurePersonSeconds: Number(
      (comparisonHuman.humanWorkZoneSeconds - comparisonHumanoid.humanWorkZoneSeconds).toFixed(3)
    )
  },
  gas: {
    valveContactAt: Number(gasValveContactAt.toFixed(3)),
    valveClosedAt: Number(gasValveClosedAt.toFixed(3)),
    sensorMonitoringAt: Number(gasSensorMonitoringAt.toFixed(3)),
    isolationVerifiedAt: Number(gasIsolationVerifiedAt.toFixed(3)),
    controlledBy: gasControlSource,
    peopleAtWorkPoint: gasWorld.metrics.gasWorkZonePeople,
    hazardousManualActionsDelegated: gasWorld.metrics.hazardousManualActionsDelegated,
    gasWorkZoneStaffing: {
      human: gasWorld.metrics.gasWorkZoneHumanEntries,
      humanoid: gasWorld.metrics.gasWorkZoneRobotEntries
    },
    verifiedSafetyGates: gasWorld.metrics.verifiedSafetyGates,
    workPoseError: Number(gasWorkPoseError.toFixed(3)),
    workYawError: Number(gasWorkYawError.toFixed(3)),
    evacuationCompletedAt: Number(evacuationCompletedAt.toFixed(3)),
    totalEvacuees: gasWorld.metrics.totalEvacuees,
    peakHeldEquipment: gasPeakHeldEquipment
  },
  fire: {
    evacuationCompletedAt: Number(fireEvacuationCompletedAt.toFixed(3)),
    returnedToNormalAt: Number(fireReturnedToNormalAt.toFixed(3)),
    totalEvacuees: fireWorld.metrics.totalEvacuees,
    peakHeldEquipment: firePeakHeldEquipment,
    safeStoppedHumanoids: fireSafeStoppedHumanoids
  },
  medical: {
    acknowledgedAt: Number(medicalAcknowledgedAt.toFixed(3)),
    handoffAt: Number(medicalHandoffAt.toFixed(3)),
    supportCompletedAt: Number(medicalSupportCompletedAt.toFixed(3)),
    deliveredAt: Number(medicalDeliveredAt.toFixed(3)),
    vehicleInterferenceTicks,
    peakHeldEquipment: medicalPeakHeldEquipment,
    treatmentPostureObserved,
    treatmentCameraEventObserved
  },
  recovery: { baselineThroughput, recoveredThroughput, ratio: Number(recoveryRatio.toFixed(3)) }
}, null, 2))
