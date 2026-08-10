import type { SimWorld } from '../world'
import type { SimEntity } from '../types'

function medicalRendezvousTask(world: SimWorld, person: SimEntity) {
  if (person.id !== world.medicalResponse?.kitResponderId) return undefined
  return world.humanoidTasks.find((task) => {
    if (
      task.kind !== 'medical_support' ||
      task.medicalHandoffEmitted ||
      !['observing', 'interacting'].includes(task.status) ||
      task.robotId === undefined
    ) return false
    const robot = world.entities.find((entity) => entity.id === task.robotId)
    return robot !== undefined && Math.hypot(robot.x - person.x, robot.z - person.z) <= 2.2
  })
}

function assignEquipmentInspection(world: SimWorld, person: SimEntity): void {
  const equipment = world.layout.layout.bays.flatMap((bay) => bay.equipment)
  const target = equipment[(person.index * 37 + Math.floor(world.simTime / 45)) % equipment.length]!
  const loadport = target.loadports[person.index % target.loadports.length]!
  // Operators work from the load-port face; engineers inspect the opposite
  // service face. This keeps normal work role-specific instead of making all
  // workers perform the same generic patrol.
  const face = person.role === 'engineer' ? -1 : 1
  const offsetX = face * (loadport.offset[0] * Math.cos(target.rotation) + loadport.offset[2] * Math.sin(target.rotation))
  const offsetZ = face * (-loadport.offset[0] * Math.sin(target.rotation) + loadport.offset[2] * Math.cos(target.rotation))
  person.goalX = target.position[0] + offsetX
  person.goalZ = target.position[2] + offsetZ
  person.workTargetId = target.id
  person.personActivity = 'walkingToWork'
  person.route = []
  person.routeCursor = 0
  person.targetX = Number.NaN
  person.targetZ = Number.NaN
}

function updateNormalPerson(world: SimWorld, person: SimEntity): void {
  if (person.personActivity === 'inspecting') {
    const reservation = person.workReservationTaskId
      ? world.humanoidTasks.find((task) => task.id === person.workReservationTaskId)
      : undefined
    if (reservation && !['returning', 'completed', 'failed', 'cancelled'].includes(reservation.status)) return
    person.workReservationTaskId = undefined
    if (world.simTime < (person.nextActionAt ?? world.simTime)) return
    person.personActivity = 'idle'
    person.workTargetId = undefined
    person.nextActionAt = world.simTime +
      (person.role === 'engineer' ? 9 + (person.index % 6) : 5 + (person.index % 5))
    person.animation = 0
    person.route = []
    person.targetX = Number.NaN
    person.targetZ = Number.NaN
    return
  }
  if (person.personActivity === 'walkingToWork' && Math.hypot(person.x - person.goalX, person.z - person.goalZ) < 0.2 && person.speed < 0.2) {
    person.personActivity = 'inspecting'
    person.targetDelay = 0
    person.nextActionAt = world.simTime +
      (person.role === 'engineer' ? 8 + (person.index % 5) : 4 + (person.index % 4))
    person.animation = 4
    person.speed = 0
    const equipment = person.workTargetId
      ? world.layout.layout.bays.flatMap((bay) => bay.equipment).find((candidate) => candidate.id === person.workTargetId)
      : undefined
    if (equipment) person.yaw = Math.atan2(equipment.position[2] - person.z, equipment.position[0] - person.x)
    return
  }
  if (person.personActivity === 'walkingToWork') return
  if (world.simTime >= (person.nextActionAt ?? 0)) assignEquipmentInspection(world, person)
}

function updateReadyResponder(world: SimWorld, person: SimEntity): void {
  person.workTargetId = undefined
  person.workReservationTaskId = undefined
  const distance = Math.hypot(person.x - person.homeX, person.z - person.homeZ)
  if (distance >= 0.2) {
    person.personActivity = 'returningToStation'
    person.goalX = person.homeX
    person.goalZ = person.homeZ
    person.route = []
    person.routeCursor = 0
    person.targetX = Number.NaN
    person.targetZ = Number.NaN
    person.targetDelay = 0
    return
  }
  person.personActivity = 'idle'
  person.goalX = person.homeX
  person.goalZ = person.homeZ
  person.speed = 0
  person.status = 'waiting'
  person.animation = 0
  person.route = []
  person.routeCursor = 0
  person.targetX = Number.NaN
  person.targetZ = Number.NaN
  const device = [...world.layout.layout.emergency.safetyDevices]
    .sort((left, right) =>
      Math.hypot(left.position[0] - person.x, left.position[2] - person.z) -
      Math.hypot(right.position[0] - person.x, right.position[2] - person.z)
    )[0]
  if (device) person.yaw = Math.atan2(device.position[2] - person.z, device.position[0] - person.x)
}

function releaseRobotYield(world: SimWorld, person: SimEntity): void {
  const resumeX = person.yieldResumeGoalX
  const resumeZ = person.yieldResumeGoalZ
  person.workReservationTaskId = undefined
  person.yieldForTaskId = undefined
  person.yieldResumeGoalX = undefined
  person.yieldResumeGoalZ = undefined
  person.reactionStartedAt = undefined
  person.reactionUntil = undefined
  person.route = []
  person.routeCursor = 0
  person.targetX = Number.NaN
  person.targetZ = Number.NaN
  if (person.workTargetId && resumeX !== undefined && resumeZ !== undefined) {
    person.goalX = resumeX
    person.goalZ = resumeZ
    person.personActivity = 'walkingToWork'
  } else {
    person.personActivity = 'idle'
    person.nextActionAt = world.simTime + 3 + (person.index % 5)
  }
}

function updateRobotYield(world: SimWorld, person: SimEntity): void {
  const task = world.humanoidTasks.find((candidate) => candidate.id === person.yieldForTaskId)
  const robot = task?.robotId ? world.entities.find((entity) => entity.id === task.robotId) : undefined
  if (!task || !robot || ['returning', 'completed', 'failed', 'cancelled'].includes(task.status)) {
    releaseRobotYield(world, person)
    return
  }
  if (world.simTime < (person.reactionUntil ?? world.simTime)) {
    person.yaw = Math.atan2(robot.z - person.z, robot.x - person.x)
    person.speed = 0
    person.status = 'waiting'
    person.animation = 4
    return
  }
  const atClearancePoint = Math.hypot(person.x - person.goalX, person.z - person.goalZ) < 0.2 && person.speed < 0.2
  if (!atClearancePoint) return
  person.yaw = Math.atan2(robot.z - person.z, robot.x - person.x)
  person.speed = 0
  person.status = 'waiting'
  person.animation = 4
  const clearance = Math.hypot(person.x - robot.x, person.z - robot.z)
  if (clearance < 2.2 || task.operatorClearanceConfirmed) return
  task.operatorClearanceConfirmed = true
  world.humanRobotClearances++
  world.events.push({
    type: 'interaction',
    taskId: task.id,
    robotId: robot.id,
    personId: person.id,
    message: `${person.name}이 ${robot.name}과 ${clearance.toFixed(1)}m 안전거리를 확보해 작업을 승인했습니다.`,
    data: { robotX: robot.x, robotZ: robot.z, personX: person.x, personZ: person.z }
  })
}

function updateGasSpotter(world: SimWorld, person: SimEntity): boolean {
  if (!person.gasSpotterTaskId) return false
  const task = world.humanoidTasks.find((candidate) =>
    candidate.id === person.gasSpotterTaskId &&
    candidate.kind === 'gas_isolation' &&
    !['returning', 'completed', 'failed', 'cancelled'].includes(candidate.status)
  )
  if (!task) {
    person.gasSpotterTaskId = undefined
    person.personActivity = 'responding'
    person.auxA = 0
    return false
  }
  const atPermitPosition =
    Math.hypot(person.x - person.goalX, person.z - person.goalZ) < 0.2 &&
    person.speed < 0.2
  if (!atPermitPosition) {
    person.personActivity = 'responding'
    person.animation = 2
    person.auxA = 0
    return true
  }
  task.gasSpotterArrivedAt ??= world.simTime
  const robot = task.robotId
    ? world.entities.find((entity) => entity.id === task.robotId && entity.kind === 'humanoid')
    : undefined
  person.yaw = robot
    ? Math.atan2(robot.z - person.z, robot.x - person.x)
    : Math.atan2(task.targetZ - person.z, task.targetX - person.x)
  person.personActivity = 'gasSpotting'
  person.speed = 0
  person.status = 'working'
  person.animation = task.gasSpotterAcknowledged ? 8 : 4
  person.auxA = task.status === 'interacting'
    ? Math.min(1, Math.max(0, (world.simTime - task.stageStartedAt) / 6.2))
    : Math.min(1, Math.max(0, (world.simTime - task.gasSpotterArrivedAt) / 0.8))
  return true
}

export function updatePeople(world: SimWorld): void {
  for (const person of world.entities.filter((entity) => entity.kind === 'person')) {
    if (person.personActivity === 'collapsed') {
      person.speed = 0
      person.animation = 3
      continue
    }
    if (person.manualGasRole && person.behavior === 'respond') {
      const atGoal =
        Math.hypot(person.x - person.goalX, person.z - person.goalZ) < 0.12 &&
        person.speed < 0.2
      person.personActivity = person.manualGasRole === 'operator'
        ? 'manualGasOperator'
        : 'manualGasSpotter'
      if (atGoal) {
        person.speed = 0
        person.status = 'working'
        person.animation = person.manualGasRole === 'spotter'
          ? 8
          : person.animation === 9
            ? 9
            : 4
      } else {
        person.animation = 2
      }
      continue
    }
    const rendezvousTask = medicalRendezvousTask(world, person)
    if (rendezvousTask) {
      person.personActivity = rendezvousTask.status === 'interacting' ? 'receivingKit' : 'acknowledgingRobot'
      person.speed = 0
      person.status = 'working'
      person.animation = rendezvousTask.status === 'interacting' ? 5 : 4
      continue
    }
    if (person.personActivity === 'acknowledgingRobot') {
      person.personActivity = 'responding'
      person.auxA = 0
    }
    if (person.personActivity === 'receivingKit') {
      if (world.simTime < (person.interactionUntil ?? world.simTime)) {
        person.speed = 0
        person.status = 'working'
        person.animation = 5
        continue
      }
      person.interactionUntil = undefined
      person.auxA = 0
      person.personActivity = 'responding'
      person.route = []
      person.routeCursor = 0
      person.targetX = Number.NaN
      person.targetZ = Number.NaN
    }
    if (person.behavior === 'evacuate') {
      if (world.simTime < (person.reactionUntil ?? world.simTime)) {
        person.personActivity = 'reacting'
        person.speed = 0
        const duration = Math.max(0.1, (person.reactionUntil ?? world.simTime) - (person.reactionStartedAt ?? world.simTime))
        const progress = Math.max(0, Math.min(1, (world.simTime - (person.reactionStartedAt ?? world.simTime)) / duration))
        const hazard = world.emergency.hazard
        const lookX = progress < 0.55 && hazard ? hazard.sourceX : person.goalX
        const lookZ = progress < 0.55 && hazard ? hazard.sourceZ : person.goalZ
        person.yaw = Math.atan2(lookZ - person.z, lookX - person.x)
        person.animation = 7
        person.auxA = progress
      } else {
        const atMusterSlot =
          person.evacuationSlotIndex !== undefined &&
          Math.hypot(person.x - person.goalX, person.z - person.goalZ) < 0.08
        person.personActivity = atMusterSlot ? 'mustered' : 'evacuating'
        person.maxSpeed = person.emergencySpeed ?? 1.65
        person.reactionStartedAt = undefined
        person.auxA = 0
      }
      continue
    }
    if (person.behavior === 'respond') {
      if (updateGasSpotter(world, person)) continue
      const hazard = world.emergency.hazard
      const roleTarget = ['fireApproach', 'fireSuppressing', 'medicalApproach', 'treating', 'gasPerimeter'].includes(person.personActivity ?? '')
        ? [person.goalX, person.goalZ] as const
        : hazard ? [hazard.sourceX, hazard.sourceZ] as const : undefined
      // Response positions share space with the patient, emergency vehicle,
      // and another responder. Match the movement system's 0.48m shared-goal
      // arrival envelope so traffic yielding cannot leave a responder
      // permanently just outside the posture transition.
      const arrived = roleTarget && Math.hypot(person.x - roleTarget[0], person.z - roleTarget[1]) < 0.48
      if (hazard?.kind === 'fire') {
        person.personActivity = arrived ? 'fireSuppressing' : 'fireApproach'
        person.animation = arrived ? 10 : 2
        person.auxA = arrived ? Math.min(1, Math.max(0, (world.simTime - (world.emergency.phaseStartedAt ?? world.simTime)) / 2)) : 0
      } else if (hazard?.kind === 'gasLeak' && person.personActivity === 'gasPerimeter') {
        person.animation = arrived ? 8 : 2
        person.auxA = arrived ? 0.7 : 0
      } else {
        person.personActivity = arrived ? 'treating' : 'medicalApproach'
        person.animation = arrived ? 6 : 2
        person.auxA = arrived ? ((person.index & 1) === 0 ? 0.35 : 0.75) : 0
      }
      if (arrived) {
        person.speed = 0
        person.yaw = Math.atan2(
          (hazard?.sourceZ ?? person.z) - person.z,
          (hazard?.sourceX ?? person.x) - person.x
        )
      }
      continue
    }
    if (person.behavior === 'yield') {
      person.personActivity = world.simTime < (person.reactionUntil ?? world.simTime) ? 'reacting' : 'patrol'
      continue
    }
    if (person.personActivity === 'yieldingToRobot') {
      updateRobotYield(world, person)
      continue
    }
    if (person.role === 'responder') {
      updateReadyResponder(world, person)
      continue
    }
    updateNormalPerson(world, person)
  }
}
