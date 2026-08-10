import type { HumanoidActivity, HumanoidTaskStatus } from '../../core/schema'
import { GAS_WORK_ZONE_RADIUS } from '../../core/interactionGeometry'
import type { SimWorld } from '../world'
import type { HumanoidTaskRuntime, SimEntity } from '../types'

const activityForStatus: Partial<Record<HumanoidTaskStatus, HumanoidActivity>> = {
  assigned: 'walking',
  navigating: 'walking',
  observing: 'observing',
  interacting: 'manipulating',
  reporting: 'reporting',
  returning: 'walking',
  completed: 'standby',
  failed: 'safeStop',
  cancelled: 'safeStop'
}

function setStatus(world: SimWorld, task: HumanoidTaskRuntime, status: HumanoidTaskStatus): void {
  if (task.status === status) return
  task.status = status; task.stageStartedAt = world.simTime
  const robot = task.robotId ? world.entities.find((entity) => entity.id === task.robotId) : undefined
  if (robot) {
    // A gas report is not a presentation gesture. Keep the robot facing the
    // valve while the spotter observes the concentration decay.
    robot.activity = status === 'reporting' && task.kind === 'gas_isolation'
      ? 'observing'
      : activityForStatus[status] ?? robot.activity
    robot.targetX = Number.NaN; robot.targetZ = Number.NaN; robot.route = []; robot.routeCursor = 0
  }
  if (
    status === 'reporting' &&
    task.kind === 'inspection_round' &&
    task.requestedBy === 'showcase' &&
    !task.inspectionAnomalyReported
  ) {
    task.inspectionAnomalyReported = true
    world.events.push({
      type: 'interaction',
      taskId: task.id,
      robotId: robot?.id,
      message: `${robot?.name ?? '휴머노이드'}가 현장 계기와 설비 상태를 교차 확인해 가스 이상 징후를 보고했습니다.`,
      data: {
        interactionKind: 'inspection_anomaly_reported',
        targetId: task.targetId,
        targetX: task.targetX,
        targetZ: task.targetZ,
        ...(robot ? { robotX: robot.x, robotZ: robot.z } : {})
      }
    })
  }
  world.emitTaskState(task)
}

export function requestOperatorClearance(world: SimWorld, task: HumanoidTaskRuntime, robot: SimEntity): boolean {
  if (task.kind === 'medical_support') return true
  if (task.operatorClearanceConfirmed) return true
  if (task.yieldingPersonId) return false
  const operator = world.entities
    .filter((entity) =>
      entity.kind === 'person' &&
      entity.role !== 'responder' &&
      entity.behavior === 'normal' &&
      !entity.emergency
    )
    .sort((a, b) => Math.hypot(a.x - robot.x, a.z - robot.z) - Math.hypot(b.x - robot.x, b.z - robot.z))[0]
  if (!operator) return true
  const distance = Math.hypot(operator.x - robot.x, operator.z - robot.z)
  if (distance > 5) return true
  operator.workReservationTaskId = undefined
  task.operatorYielded = true
  if (distance >= 2.4) {
    task.operatorClearanceConfirmed = true
    world.humanRobotClearances++
    world.events.push({
      type: 'interaction',
      taskId: task.id,
      robotId: robot.id,
      personId: operator.id,
      message: `${operator.name}이 ${robot.name}을 확인하고 기존 안전거리를 유지했습니다.`,
      data: { robotX: robot.x, robotZ: robot.z, personX: operator.x, personZ: operator.z }
    })
    return true
  }
  task.yieldingPersonId = operator.id
  operator.yaw = Math.atan2(robot.z - operator.z, robot.x - operator.x)
  operator.animation = 4
  operator.yieldForTaskId = task.id
  operator.yieldResumeGoalX = Number.isFinite(operator.goalX) ? operator.goalX : operator.x
  operator.yieldResumeGoalZ = Number.isFinite(operator.goalZ) ? operator.goalZ : operator.z
  const awayX = distance > 0.05 ? (operator.x - robot.x) / distance : Math.cos(robot.yaw + Math.PI / 2)
  const awayZ = distance > 0.05 ? (operator.z - robot.z) / distance : Math.sin(robot.yaw + Math.PI / 2)
  const clearancePoint = chooseClearancePoint(world, robot, awayX, awayZ)
  operator.goalX = clearancePoint[0]
  operator.goalZ = clearancePoint[1]
  operator.personActivity = 'yieldingToRobot'
  operator.reactionUntil = world.simTime + 0.8
  operator.targetDelay = 0
  operator.route = []
  operator.routeCursor = 0
  operator.targetX = Number.NaN
  operator.targetZ = Number.NaN
  world.events.push({
    type: 'interaction',
    taskId: task.id,
    robotId: robot.id,
    personId: operator.id,
    message: `${operator.name}이 ${robot.name}의 접근을 인지하고 작업 구역에서 비켜섭니다.`,
    data: { robotX: robot.x, robotZ: robot.z, personX: operator.x, personZ: operator.z }
  })
  return false
}

function chooseClearancePoint(world: SimWorld, robot: SimEntity, awayX: number, awayZ: number): readonly [number, number] {
  const baseAngle = Math.atan2(awayZ, awayX)
  const angleOffsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI]
  for (const offset of angleOffsets) {
    const x = robot.x + Math.cos(baseAngle + offset) * 2.7
    const z = robot.z + Math.sin(baseAngle + offset) * 2.7
    if (isClearOfEquipment(world, x, z)) return [x, z]
  }
  return [robot.x + awayX * 2.7, robot.z + awayZ * 2.7]
}

function isClearOfEquipment(world: SimWorld, x: number, z: number): boolean {
  return world.layout.layout.bays.every((bay) => bay.equipment.every((equipment) => {
    const width = equipment.type === 'lithography' ? 4.6 : equipment.type === 'cmp' ? 5 : 3.5
    const depth = 4.2
    const quarterTurn = Math.abs(Math.sin(equipment.rotation)) > 0.7
    const halfWidth = (quarterTurn ? depth : width) / 2 + 0.55
    const halfDepth = (quarterTurn ? width : depth) / 2 + 0.55
    return Math.abs(x - equipment.position[0]) > halfWidth || Math.abs(z - equipment.position[2]) > halfDepth
  }))
}

export function gasWorkZonePeople(world: SimWorld, task: HumanoidTaskRuntime): SimEntity[] {
  if (task.kind !== 'gas_isolation') return []
  return world.entities.filter((entity) =>
    entity.kind === 'person' &&
    Math.hypot(entity.x - task.targetX, entity.z - task.targetZ) < GAS_WORK_ZONE_RADIUS
  )
}

function updateTask(world: SimWorld, task: HumanoidTaskRuntime): void {
  const robot = task.robotId ? world.entities.find((entity) => entity.id === task.robotId) : undefined
  if (!robot || robot.rmfControlled) return
  const elapsed = world.simTime - task.stageStartedAt
  switch (task.status) {
    case 'assigned':
      robot.goalX = task.targetX; robot.goalZ = task.targetZ
      setStatus(world, task, 'navigating')
      break
    case 'navigating':
      robot.goalX = task.targetX; robot.goalZ = task.targetZ
      // The responder occupies the rendezvous node first; the humanoid stops at
      // a realistic interpersonal distance rather than trying to overlap it.
      {
        const workDistance = Math.hypot(robot.x - task.targetX, robot.z - task.targetZ)
        if (workDistance < 1.7 && !requestOperatorClearance(world, task, robot)) return
        const workThreshold = task.kind === 'medical_support' ? 1.15 : 0.04
        if (workDistance >= workThreshold) break
        robot.speed = 0
        robot.activity = 'standby'
        const equipment = world.layout.equipmentPositions.get(task.targetId)
        const device = world.layout.layout.emergency.safetyDevices.find((candidate) => candidate.id === task.targetId)
        const targetEntity = world.entities.find((candidate) => candidate.id === task.targetId)
        const lookX = equipment?.[0] ?? device?.position[0] ?? targetEntity?.x ?? task.targetX
        const lookZ = equipment?.[2] ?? device?.position[2] ?? targetEntity?.z ?? task.targetZ
        robot.yaw = task.targetYaw ?? Math.atan2(lookZ - robot.z, lookX - robot.x)
        setStatus(world, task, 'observing')
      }
      break
    case 'observing':
      robot.speed = 0; robot.auxA = Math.min(1, elapsed / 2.5)
      if (task.kind === 'gas_isolation' && gasWorkZonePeople(world, task).length === 0) {
        task.gasWorkZoneBreachActive = false
      }
      if (
        elapsed >= 2.5 &&
        (
          task.kind !== 'gas_isolation' ||
          gasWorkZonePeople(world, task).length === 0
        ) &&
        (
          task.kind !== 'medical_support' ||
          closestMedicalResponder(world, robot, 2.2) !== undefined
        )
      ) {
        setStatus(world, task, 'interacting')
        robot.auxA = 0
      }
      break
    case 'interacting': {
      robot.speed = 0
      if (task.kind === 'gas_isolation') {
        const intruder = gasWorkZonePeople(world, task)[0]
        if (intruder) {
          task.gasWorkZoneBreachActive = true
          setStatus(world, task, 'observing')
          robot.activity = 'observing'
          robot.auxA = 0
          world.events.push({
            type: 'interaction',
            taskId: task.id,
            robotId: robot.id,
            personId: intruder.id,
            message: `${intruder.name}의 가스 작업구역 진입을 감지해 밸브 조작을 중지하고 무인 상태를 다시 확인합니다.`,
            data: {
              interactionKind: 'gas_work_zone_breach',
              workZonePeople: gasWorkZonePeople(world, task).length,
              personX: intruder.x,
              personZ: intruder.z,
              severity: 'danger'
            }
          })
          break
        }
      }
      const duration = task.kind === 'gas_isolation' ? 7 : 4
      robot.auxA = Math.min(1, elapsed / (task.kind === 'medical_support' ? 0.8 : duration))
      if (task.kind === 'gas_isolation') updateGasIsolation(world, task, robot, elapsed)
      if (task.kind === 'medical_support' && !task.medicalHandoffEmitted && elapsed >= 0.8) {
        const responder = closestMedicalResponder(world, robot, 2.2)
        if (responder) emitMedicalHandoff(world, task, robot, responder)
      }
      if (
        elapsed >= duration &&
        (task.kind !== 'medical_support' || task.medicalHandoffEmitted) &&
        (task.kind !== 'gas_isolation' || task.gasIsolationVerified)
      ) setStatus(world, task, 'reporting')
      break
    }
    case 'reporting':
      robot.speed = 0; robot.auxA = Math.min(1, elapsed / 2.5)
      // A gas-continuity inspection remains on station after its first report.
      // It keeps monitoring the exterior equipment while people finish their
      // evacuation, instead of walking home and leaving the response story
      // with a static valve shot.
      if (
        task.kind === 'inspection_round' &&
        task.id.startsWith('gas-continuity-') &&
        world.emergency.kind === 'gasLeak' &&
        world.emergency.phase !== 'allClear' &&
        world.emergency.phase !== 'normal'
      ) {
        robot.activity = 'reporting'
        return
      }
      if (elapsed >= 2.5) {
        robot.goalX = robot.homeX; robot.goalZ = robot.homeZ
        setStatus(world, task, 'returning')
      }
      break
    case 'returning':
      robot.goalX = robot.homeX; robot.goalZ = robot.homeZ
      if (Math.hypot(robot.x - robot.homeX, robot.z - robot.homeZ) < 1.2) {
        setStatus(world, task, 'completed')
        robot.taskId = undefined; robot.activity = 'standby'; robot.speed = 0; robot.auxA = 0; robot.auxB = 0
        if (task.kind === 'inspection_round') robot.maxSpeed = robot.preferredSpeed
        world.completedHumanoidTasks++
      }
      break
  }
}

function updateGasIsolation(world: SimWorld, task: HumanoidTaskRuntime, robot: SimEntity, elapsed: number): void {
  if (!task.gasValveContactConfirmed && elapsed >= 1.2) {
    task.gasValveContactConfirmed = true
    world.events.push({
      type: 'interaction',
      taskId: task.id,
      robotId: robot.id,
      message: `${robot.name}가 수동 격리 밸브 손잡이에 접촉했습니다.`,
      data: {
        interactionKind: 'gas_valve_contact',
        robotX: robot.x,
        robotZ: robot.z,
        targetX: task.targetX,
        targetZ: task.targetZ
      }
    })
  }
  if (!task.gasValveActuationConfirmed && elapsed >= 5.2) {
    task.gasValveActuationConfirmed = true
    world.hazardousManualActionsDelegated = 1
    world.events.push({
      type: 'interaction',
      taskId: task.id,
      robotId: robot.id,
      message: `${robot.name}가 격리 밸브를 폐쇄 위치까지 회전했습니다.`,
      data: {
        interactionKind: 'gas_valve_closed',
        robotX: robot.x,
        robotZ: robot.z,
        targetX: task.targetX,
        targetZ: task.targetZ
      }
    })
    emitGasSensorMonitoring(world, task, robot)
  }
  if (!task.gasIsolationVerified && elapsed >= 6.2) {
    task.gasIsolationVerified = true
    task.gasIsolationVerifiedAt = world.simTime
    world.gasIsolationElapsed = Math.max(0, world.simTime - world.emergency.startedAt)
    world.verifiedSafetyGates = 1
    world.events.push({
      type: 'interaction',
      taskId: task.id,
      robotId: robot.id,
      message: `${robot.name}가 밸브 폐쇄와 가스 센서 안정 피드백을 확인했습니다.`,
      data: {
        interactionKind: 'gas_isolation_verified',
        robotX: robot.x,
        robotZ: robot.z,
        targetX: task.targetX,
        targetZ: task.targetZ,
      }
    })
    if (world.emergency.kind === 'gasLeak' && world.emergency.phase !== 'normal') {
      world.markHazardControlled('humanoid_valve')
    }
  }
}

export function applyGasWorkPermit(
  world: SimWorld,
  task: HumanoidTaskRuntime,
  permit: {
    authorized: boolean
    authorizedBy: string
    clearance?: number
    personId?: string
    reason?: string
  },
  silent = false
): void {
  if (task.kind !== 'gas_isolation') return
  if (!permit.authorized) {
    const hadPermit = task.gasWorkPermitExternalAuthorized === true
    task.gasWorkPermitExternalAuthorized = false
    task.gasWorkPermitAuthorizedBy = permit.authorizedBy
    task.gasWorkPermitPersonId = permit.personId
    task.gasWorkPermitClearance = undefined
    if (hadPermit && !silent) {
      world.events.push({
        type: 'interaction',
        taskId: task.id,
        robotId: task.robotId,
        message: `${permit.authorizedBy}가 EHS 작업허가를 철회했습니다.${permit.reason ? ` ${permit.reason}` : ''}`,
        data: {
          interactionKind: 'gas_work_permit_revoked',
          authorizedBy: permit.authorizedBy,
          ...(permit.reason ? { reason: permit.reason } : {}),
          severity: 'danger'
        }
      })
    }
    return
  }
  task.gasWorkPermitExternalAuthorized = true
  task.gasWorkPermitAuthorizedBy = permit.authorizedBy
  task.gasWorkPermitPersonId = permit.personId
  task.gasWorkPermitClearance = permit.clearance
  const robot = task.robotId
    ? world.entities.find((entity) => entity.id === task.robotId && entity.kind === 'humanoid')
    : undefined
  if (robot) {
    if (task.status === 'interacting') robot.activity = 'manipulating'
  }
  if (!silent) {
    world.events.push({
      type: 'hudMessage',
      taskId: task.id,
      robotId: robot?.id,
      message: `${permit.authorizedBy}의 원격 EHS 작업허가를 수신했습니다. 전원 대피와 무인 작업구역을 확인합니다.`,
      data: { severity: 'info' }
    })
  }
}

function emitGasSensorMonitoring(world: SimWorld, task: HumanoidTaskRuntime, robot: SimEntity): void {
  if (task.gasSensorMonitoringEmitted) return
  task.gasSensorMonitoringEmitted = true
  world.events.push({
    type: 'interaction',
    taskId: task.id,
    robotId: robot.id,
    message: `${robot.name}의 내장 가스 센서가 밸브 폐쇄 후 잔류 가스 농도 하강을 확인합니다.`,
    data: {
      interactionKind: 'gas_sensor_monitoring',
      robotX: robot.x,
      robotZ: robot.z,
      targetX: task.targetX,
      targetZ: task.targetZ
    }
  })
}

function closestMedicalResponder(world: SimWorld, robot: SimEntity, maxDistance = Infinity): SimEntity | undefined {
  const responder = world.medicalResponse?.responderIds
    .map((id) => world.entities.find((entity) => entity.id === id))
    .filter((entity) => entity !== undefined)
    .sort((left, right) =>
      Math.hypot(left.x - robot.x, left.z - robot.z) -
      Math.hypot(right.x - robot.x, right.z - robot.z)
    )[0]
  return responder && Math.hypot(responder.x - robot.x, responder.z - robot.z) <= maxDistance ? responder : undefined
}

function updateMedicalRendezvous(world: SimWorld, task: HumanoidTaskRuntime, robot: SimEntity): void {
  if (
    task.kind !== 'medical_support' ||
    !['observing', 'interacting'].includes(task.status) ||
    task.medicalHandoffEmitted
  ) return
  const responder = closestMedicalResponder(world, robot, 2.2)
  if (!responder) return
  robot.yaw = Math.atan2(responder.z - robot.z, responder.x - robot.x)
  responder.yaw = Math.atan2(robot.z - responder.z, robot.x - responder.x)
  responder.speed = 0
  responder.status = 'working'
  responder.animation = task.status === 'interacting' ? 5 : 4
  responder.personActivity = task.status === 'interacting' ? 'receivingKit' : 'acknowledgingRobot'
  responder.auxA = task.status === 'interacting'
    ? Math.min(1, (world.simTime - task.stageStartedAt) / 0.8)
    : Math.min(1, (world.simTime - task.stageStartedAt) / 1.2)
  if (task.medicalRendezvousAcknowledged) return
  task.medicalRendezvousAcknowledged = true
  const patient = world.medicalResponse
    ? world.entities.find((entity) => entity.id === world.medicalResponse?.victimId)
    : undefined
  world.events.push({
    type: 'interaction',
    taskId: task.id,
    robotId: robot.id,
    personId: responder.id,
    message: `${responder.name}이 ${robot.name}을 확인하고 응급 키트 수령 자세를 취합니다.`,
    data: {
      interactionKind: 'medical_rendezvous_ack',
      robotX: robot.x,
      robotZ: robot.z,
      personX: responder.x,
      personZ: responder.z,
      ...(patient ? { patientId: patient.id, patientX: patient.x, patientZ: patient.z } : {})
    }
  })
}

function emitMedicalHandoff(
  world: SimWorld,
  task: HumanoidTaskRuntime,
  robot: SimEntity,
  responder: SimEntity,
  silent = false
): void {
  const patient = world.medicalResponse
    ? world.entities.find((entity) => entity.id === world.medicalResponse?.victimId)
    : undefined
  robot.yaw = Math.atan2(responder.z - robot.z, responder.x - robot.x)
  responder.yaw = Math.atan2(robot.z - responder.z, robot.x - responder.x)
  responder.animation = 5
  responder.personActivity = 'receivingKit'
  responder.interactionUntil = world.simTime + 1.2
  responder.auxA = 1
  responder.auxB = 1
  robot.auxB = 0
  task.medicalHandoffEmitted = true
  task.medicalHandoffConfirmed = true
  if (world.medicalResponse) world.medicalResponse.kitHandoffComplete = true
  if (!silent) world.events.push({
    type: 'interaction',
    taskId: task.id,
    robotId: robot.id,
    personId: responder.id,
    message: `${robot.name}가 ${responder.name}에게 응급 키트를 인계하고 처치 공간 지원을 시작했습니다.`,
    data: {
      interactionKind: 'medical_handoff',
      robotX: robot.x,
      robotZ: robot.z,
      personX: responder.x,
      personZ: responder.z,
      ...(patient ? { patientId: patient.id, patientX: patient.x, patientZ: patient.z } : {})
    }
  })
}

export function confirmMedicalHandoff(
  world: SimWorld,
  task: HumanoidTaskRuntime,
  robot: SimEntity,
  silent = false
): boolean {
  if (task.kind !== 'medical_support' || task.medicalHandoffEmitted) return task.medicalHandoffEmitted === true
  const responder = closestMedicalResponder(world, robot, 2.2)
  if (!responder) return false
  emitMedicalHandoff(world, task, robot, responder, silent)
  return true
}

export function updateHumanoids(world: SimWorld): void {
  world.assignQueuedHumanoidTasks()
  for (const robot of world.entities.filter((entity) => entity.kind === 'humanoid' && entity.activity === 'yielding' && entity.behavior === 'yield')) {
    if (Math.hypot(robot.x - robot.goalX, robot.z - robot.goalZ) >= 1.2) continue
    robot.activity = 'safeStop'
    robot.speed = 0
    robot.status = 'waiting'
    world.events.push({
      type: 'interaction',
      robotId: robot.id,
      message: `${robot.name}이 대피 동선 밖 안전 지점에서 정지했습니다.`
    })
  }
  for (const task of world.humanoidTasks) {
    const robot = task.robotId ? world.entities.find((entity) => entity.id === task.robotId && entity.kind === 'humanoid') : undefined
    if (robot) updateMedicalRendezvous(world, task, robot)
    if (
      robot?.rmfControlled &&
      task.medicalHandoffConfirmed &&
      ['interacting', 'reporting'].includes(task.status)
    ) confirmMedicalHandoff(world, task, robot)
    updateTask(world, task)
  }
}

export function preemptLocalHumanoidTasks(world: SimWorld): void {
  for (const task of world.humanoidTasks) {
    if (['completed', 'failed', 'cancelled'].includes(task.status)) continue
    const robot = task.robotId ? world.entities.find((entity) => entity.id === task.robotId && entity.kind === 'humanoid') : undefined
    if (robot?.rmfControlled) continue
    task.status = 'cancelled'
    task.stageStartedAt = world.simTime
    if (robot) {
      robot.taskId = undefined
      robot.speed = 0
      robot.auxA = 0
      robot.auxB = 0
    }
    world.emitTaskState(task)
  }
}
