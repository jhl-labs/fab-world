import { distance2 } from '../core/math/vec'
import { GAS_WORK_ZONE_RADIUS } from '../core/interactionGeometry'
import { SeededRng } from '../core/math/rng'
import { deriveLayout, type DerivedLayout, type HazardLevel } from '../core/layout'
import type { EmergencyBehavior, EmergencyKind, EmergencyPhase, FabLayout, HumanoidActivity, HumanoidTaskRequest, HumanoidTaskStatus, RmfBridgeEvent, Scenario } from '../core/schema'
import {
  MAX_ENTITIES,
  POSE_FLOATS,
  POSE_HEADER_INTS,
  POSE_STRIDE,
  PoseFlags,
  PoseHeader,
  PoseSlot,
  type EntityMeta,
  type RiskComparisonMetrics,
  type RiskComparisonMode,
  type RiskComparisonRunMetrics,
  type SimEvent,
  type SimMetrics
} from '../core/protocol'
import { spawnPopulation } from './population'
import { ScenarioEngine } from './scenario/engine'
import { findHazardSource, resolveHumanoidTarget } from './targeting'
import { updateEmergency } from './systems/emergencySystem'
import { updateEquipment } from './systems/equipmentSystem'
import { updateMissions } from './systems/missionSystem'
import { groundBodyRadius, isStationaryGroundRobot, updateMovement } from './systems/movementSystem'
import { applyGasWorkPermit, confirmMedicalHandoff, gasWorkZonePeople, preemptLocalHumanoidTasks, requestOperatorClearance, updateHumanoids } from './systems/humanoidSystem'
import { updatePeople } from './systems/personSystem'
import { updateTraffic } from './systems/trafficSystem'
import type { EmergencyState, EquipmentRuntime, HumanoidTaskRuntime, MedicalResponseRuntime, RiskComparisonRuntime, SimEntity, TransportMissionRuntime } from './types'

const rmfActivityForStatus: Record<HumanoidTaskStatus, HumanoidActivity> = {
  queued: 'standby',
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
const ACTION_TELEMETRY_FRESHNESS_SECONDS = 1.5
const ACTION_TELEMETRY_PHASE_ORDER = {
  approach: 0,
  contact: 1,
  turning: 2,
  monitoring: 3,
  verified: 4
} as const
const MUSTER_SAFE_RADIUS = 5

export class SimWorld {
  readonly layout: DerivedLayout
  readonly rng: SeededRng
  readonly entities: SimEntity[] = []
  readonly equipment: EquipmentRuntime[] = []
  readonly events: SimEvent[] = []
  readonly humanoidTasks: HumanoidTaskRuntime[] = []
  readonly transportMissions: TransportMissionRuntime[] = []
  readonly hazardLevels = new Map<string, HazardLevel>()
  readonly scenario = new ScenarioEngine()
  readonly pose: Float32Array
  readonly poseHeader?: Int32Array
  readonly sharedPose: boolean
  emergency: EmergencyState = { phase: 'normal', startedAt: 0 }
  medicalResponse?: MedicalResponseRuntime
  simTime = 0
  tickCount = 0
  completedProcesses = 0
  heldEquipmentCount = 0
  pendingOutputs = 0
  completedTransportMissions = 0
  lastMissionAt = -Infinity
  missionSequence = 1
  completedHumanoidTasks = 0
  humanRobotClearances = 0
  hazardousManualActionsDelegated = 0
  gasSpotterClearance = 0
  gasIsolationElapsed = 0
  verifiedSafetyGates = 0
  rmfLive = false
  private readonly gasWorkZoneHumanEntrants = new Set<string>()
  private readonly gasWorkZoneRobotEntrants = new Set<string>()
  private riskComparison?: RiskComparisonRuntime
  private riskComparisonResultValue?: RiskComparisonRunMetrics
  private taskSequence = 1
  private showcaseInspectionTaskId?: string
  private showcaseIncidentTriggered = false
  private scenarioSourceEquipmentId?: string
  private scenarioKind?: EmergencyKind
  private scenarioHazardConfig?: { spreadRate?: number; maxRadius?: number; fixedAt?: number }
  private readonly cancelledRmfTaskIds = new Set<string>()
  private readonly evacuationAssignments = new Map<string, number>()
  private frontBuffer = 0
  private fallbackGeneration = 0

  constructor(rawLayout: FabLayout, seed: number, poseBuffer?: SharedArrayBuffer) {
    this.layout = deriveLayout(rawLayout); this.rng = new SeededRng(seed)
    if (poseBuffer) { this.poseHeader = new Int32Array(poseBuffer, 0, POSE_HEADER_INTS); this.pose = new Float32Array(poseBuffer, POSE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT, POSE_FLOATS); this.sharedPose = true }
    else { this.pose = new Float32Array(POSE_FLOATS); this.sharedPose = false }
    spawnPopulation(this); this.flushPose()
  }
  get metas(): EntityMeta[] {
    return this.entities.map(({ id, index, kind, name, role }) => ({
      id, index, kind, name,
      ...(role ? { role } : {}),
      ...(kind === 'humanoid' ? { fleet: 'fab_humanoid_fleet', capabilities: ['inspection_round', 'gas_isolation', 'medical_support'] as const } : {})
    }))
  }
  get riskComparisonResult(): RiskComparisonRunMetrics | undefined {
    return this.riskComparisonResultValue
      ? { ...this.riskComparisonResultValue }
      : undefined
  }
  get riskComparisonMetrics(): RiskComparisonMetrics {
    const comparison = this.riskComparison
    if (!comparison) {
      return {
        active: false,
        stage: 'inactive',
        currentHumanEntries: 0,
        currentHumanoidEntries: 0,
        currentHumanWorkZoneSeconds: 0
      }
    }
    const task = [...this.humanoidTasks].reverse().find((candidate) => candidate.kind === 'gas_isolation')
    const stage = this.riskComparisonResultValue
      ? 'complete'
      : comparison.mode === 'human'
        ? ['approaching', 'manipulating', 'monitoring'].includes(comparison.stage)
          ? 'human-work'
          : 'human-dispatch'
        : task && ['interacting', 'reporting', 'returning', 'completed'].includes(task.status)
          ? 'humanoid-work'
          : 'humanoid-dispatch'
    return {
      active: true,
      stage,
      currentMode: comparison.mode,
      currentTargetId: comparison.targetId,
      currentHumanEntries: this.gasWorkZoneHumanEntrants.size,
      currentHumanoidEntries: this.gasWorkZoneRobotEntrants.size,
      currentHumanWorkZoneSeconds: comparison.humanWorkZoneSeconds,
      ...(this.riskComparisonResultValue?.mode === 'human'
        ? { human: { ...this.riskComparisonResultValue } }
        : this.riskComparisonResultValue?.mode === 'humanoid'
          ? { humanoid: { ...this.riskComparisonResultValue } }
          : {})
    }
  }
  get metrics(): SimMetrics {
    const people = this.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
    const gasTask = [...this.humanoidTasks].reverse().find((task) => task.kind === 'gas_isolation')
    const gasWorkZoneActive = gasTask !== undefined &&
      !['completed', 'failed', 'cancelled'].includes(gasTask.status)
    // Gas isolation is a robot-only intervention. In live mode the remote
    // work permit authorizes the robot; in local mode the empty work zone is
    // the interlock. No person is retained as an on-scene spotter.
    const workPermitAuthorized = gasTask?.gasIsolationVerified === true ||
      (gasWorkZoneActive && !this.rmfLive) ||
      (gasWorkZoneActive && gasTask?.gasWorkPermitExternalAuthorized === true)
    const workZonePeople = gasWorkZoneActive ? gasWorkZonePeople(this, gasTask) : []
    const evacuated = this.emergency.phase === 'normal' || this.emergency.kind === 'medical'
      ? 0
      : people.filter((entity) => {
          const muster = entity.evacuationMusterId
            ? this.layout.layout.emergency.musterPoints.find((point) => point.id === entity.evacuationMusterId)
            : undefined
          return muster !== undefined && Math.hypot(entity.x - muster.position[0], entity.z - muster.position[2]) < MUSTER_SAFE_RADIUS
        }).length
    return {
      tickMs: 0, entityCount: this.entities.length, simTime: this.simTime, phase: this.emergency.phase, evacuated,
      totalEvacuees: people.length,
      emergencyElapsed: this.emergency.phase === 'normal' ? 0 : Math.max(0, this.simTime - this.emergency.startedAt),
      hazardRadius: this.emergency.hazard?.radius ?? 0,
      haltedRobots: this.entities.filter((entity) =>
        entity.kind !== 'person' &&
        entity.kind !== 'arm' &&
        (entity.behavior === 'halt' || (entity.behavior === 'yield' && entity.status === 'waiting') || entity.activity === 'safeStop')
      ).length,
      activeTransportMissions: this.transportMissions.filter((mission) => !['done', 'aborted'].includes(mission.state)).length,
      completedProcesses: this.completedProcesses,
      heldEquipment: this.heldEquipmentCount,
      activeHumanoids: this.entities.filter((entity) => entity.kind === 'humanoid' && entity.taskId).length,
      completedHumanoidTasks: this.completedHumanoidTasks,
      humanRobotClearances: this.humanRobotClearances,
      hazardousManualActionsDelegated: this.hazardousManualActionsDelegated,
      gasSpotterClearance: this.gasSpotterClearance,
      gasWorkZoneClear:
        gasTask !== undefined &&
        (
          gasTask.gasIsolationVerified === true ||
          (gasWorkZoneActive && workZonePeople.length === 0)
        ),
      gasWorkZonePeople: workZonePeople.length,
      gasWorkZoneHumanEntries: this.gasWorkZoneHumanEntrants.size,
      gasWorkZoneRobotEntries: this.gasWorkZoneRobotEntrants.size,
      gasIsolationElapsed: this.gasIsolationElapsed,
      verifiedSafetyGates: this.verifiedSafetyGates,
      gasRmfAssigned: Boolean(gasTask?.robotId) && gasTask?.status !== 'queued',
      gasWorkPermitAuthorized: workPermitAuthorized,
      gasWorkPermitRevoked: gasTask?.gasWorkPermitExternalAuthorized === false && gasTask.gasWorkPermitAuthorizedBy !== undefined,
      gasWorkPermitAuthority: gasTask?.gasWorkPermitExternalAuthorized
        ? gasTask.gasWorkPermitAuthorizedBy ?? 'EHS'
        : gasTask
          ? '자동 안전 인터록'
          : '',
      gasValveContactConfirmed: gasTask?.gasValveContactConfirmed === true,
      gasValveClosed: gasTask?.gasValveActuationConfirmed === true,
      gasSensorMonitoring: gasTask?.gasSensorMonitoringEmitted === true,
      gasIsolationVerified: gasTask?.gasIsolationVerified === true,
      gasActionTelemetryAvailable: gasTask?.actionTelemetryPhase !== undefined,
      gasActionTelemetryFresh:
        gasTask?.actionTelemetryPhase !== undefined &&
        gasTask.actionTelemetryStale !== true &&
        (gasTask.actionTelemetryAge ?? Infinity) <= ACTION_TELEMETRY_FRESHNESS_SECONDS,
      gasActionTelemetryPhase: gasTask?.actionTelemetryPhase ?? '',
      gasActionTelemetryProgress: gasTask?.actionTelemetryProgress ?? 0,
      gasActionTelemetryValvePosition: gasTask?.actionTelemetryValvePosition ?? 0,
      gasActionTelemetryGasPpm: gasTask?.actionTelemetryGasPpm ?? 0,
      gasActionTelemetryHandPoseMeasured:
        gasTask?.actionTelemetryLeftHandPosition !== undefined &&
        gasTask.actionTelemetryRightHandPosition !== undefined,
      gasTaskFailed: gasTask?.status === 'failed',
      riskComparison: this.riskComparisonMetrics,
      humanoids: this.entities
        .filter((entity) => entity.kind === 'humanoid')
        .map((entity) => ({
          id: entity.id,
          name: entity.name,
          battery: entity.battery,
          status: entity.status,
          activity: entity.activity ?? 'standby',
          speed: entity.speed,
          ...(entity.taskId ? { taskId: entity.taskId } : {}),
          rmfControlled: entity.rmfControlled,
          ...(entity.rmfPose ? { poseAgeMs: Math.round(entity.rmfPose.age * 1_000) } : {})
        }))
    }
  }
  tick(dt: number): void {
    this.simTime += dt; this.tickCount++
    this.scenario.update(this)
    updateEmergency(this, dt)
    updateEquipment(this, dt)
    updateMissions(this)
    updateHumanoids(this)
    updatePeople(this)
    this.updateShowcase()
    updateTraffic(this)
    updateMovement(this, dt)
    this.updateRemoteGasInspections()
    this.updateGasWorkZoneEntries()
    this.updateRiskComparison(dt)
    this.flushPose()
  }
  updateRealtime(realDt: number): void {
    let hasExternalPose = false
    for (const robot of this.entities) {
      const pose = robot.rmfPose
      if (robot.kind !== 'humanoid' || !robot.rmfControlled) continue
      if (pose) {
        hasExternalPose = true
        pose.age += Math.max(0, realDt)
        if (pose.age > 1.5 && !pose.stale) {
          pose.stale = true
          pose.moving = false
          robot.speed = 0
          robot.status = 'error'
          robot.activity = 'safeStop'
          this.events.push({
            type: 'hudMessage',
            message: `${robot.name}의 Open-RMF pose가 1.5초 이상 갱신되지 않아 안전 정지했습니다.`,
            data: { severity: 'danger' }
          })
        }
        if (pose.duration > 0 && pose.elapsed < pose.duration) {
          pose.elapsed = Math.min(pose.duration, pose.elapsed + Math.max(0, realDt))
          const alpha = pose.elapsed / pose.duration
          robot.x = pose.startX + (pose.targetX - pose.startX) * alpha
          robot.z = pose.startZ + (pose.targetZ - pose.startZ) * alpha
          robot.yaw = pose.startYaw + (pose.targetYaw - pose.startYaw) * alpha
        }
        if (pose.moving) {
          robot.animationPhase = (robot.animationPhase + Math.max(0, realDt) * Math.max(robot.speed, 0.2)) % 1
        }
      }
      const task = robot.taskId ? this.humanoidTasks.find((candidate) => candidate.id === robot.taskId) : undefined
      if (task?.kind === 'gas_isolation' && task.status === 'interacting' && !task.gasIsolationVerified) {
        task.actionTelemetryAge = (task.actionTelemetryAge ?? 0) + Math.max(0, realDt)
        if (
          task.actionTelemetryAge > ACTION_TELEMETRY_FRESHNESS_SECONDS &&
          task.actionTelemetryStale !== true
        ) {
          task.actionTelemetryStale = true
          robot.speed = 0
          robot.status = 'error'
          robot.activity = 'safeStop'
          this.events.push({
            type: 'hudMessage',
            taskId: task.id,
            robotId: robot.id,
            message: task.actionTelemetryPhase
              ? `${robot.name}의 action executor 텔레메트리가 1.5초 이상 끊겨 현재 관절 자세에서 안전 정지했습니다.`
              : `${robot.name}의 action executor 텔레메트리를 받지 못해 밸브 조작을 시작하지 않습니다.`,
            data: { severity: 'danger' }
          })
        }
        // The arm and valve hold their last executor-reported state. Never
        // synthesize physical contact or actuation from the task wall clock.
        continue
      }
      if (task && ['observing', 'interacting', 'reporting'].includes(task.status)) {
        const duration = task.status === 'observing'
          ? 2.5
          : task.status === 'reporting'
            ? 2.5
            : 4
        robot.auxA = Math.min(1, robot.auxA + Math.max(0, realDt) / duration)
      }
    }
    // Live RMF motion follows wall time, even while the deterministic simulation is paused or accelerated.
    if (hasExternalPose) this.flushPose()
  }
  loadScenario(scenario: Scenario): void {
    this.scenario.load(scenario, this.simTime); this.scenarioKind = scenario.kind; this.scenarioSourceEquipmentId = scenario.params.sourceEquipmentId
    this.scenarioHazardConfig = {
      spreadRate: scenario.params.spreadRate,
      maxRadius: scenario.params.maxRadius,
      // A gas leak is controlled only by the valve/sensor confirmation
      // sequence. Keep the generic fire/custom fallback out of its runtime
      // hazard state so a future consumer cannot mistake it for authority.
      fixedAt: scenario.kind === 'gasLeak' ? undefined : scenario.params.responderFixDuration
    }
    this.events.push({ type: 'log', message: `${scenario.name} 시나리오를 준비했습니다.` })
  }
  startHumanoidShowcase(): void {
    // A stage operator may restart the story after a rehearsal, failure, or
    // partial live run. Cancel the previous local authority before creating a
    // new causal chain so two inspections cannot trigger competing incidents.
    this.resetOperation()
    const robot = this.entities.find((entity) => entity.kind === 'humanoid')
    const candidates = this.layout.layout.bays.flatMap((bay) => bay.equipment).filter((equipment) => equipment.hazardCapable)
    const target = candidates.sort((a, b) => {
      const distanceA = robot ? Math.hypot(a.position[0] - robot.x, a.position[2] - robot.z) : 0
      const distanceB = robot ? Math.hypot(b.position[0] - robot.x, b.position[2] - robot.z) : 0
      return distanceA - distanceB
    })[0]
    if (!target) return
    const request: HumanoidTaskRequest = {
      id: `showcase-inspection-${this.taskSequence++}`,
      kind: 'inspection_round',
      targetId: target.id,
      requestedBy: 'showcase',
      priority: 70
    }
    this.showcaseInspectionTaskId = request.id
    this.scenarioSourceEquipmentId = target.id
    this.dispatchHumanoidTask(request)
    const runtimeTask = this.humanoidTasks.find((task) => task.id === request.id)
    if (runtimeTask) this.reserveShowcaseOperator(runtimeTask)
    this.events.push({
      type: 'hudMessage',
      taskId: request.id,
      message: '휴머노이드 현장 점검 태스크를 Open-RMF에 배정 요청했습니다.',
      data: { severity: 'info' }
    })
  }
  startRiskComparison(
    mode: RiskComparisonMode,
    reference?: Pick<RiskComparisonRunMetrics, 'sourceEquipmentId' | 'targetId'>
  ): void {
    this.resetOperation()
    this.riskComparisonResultValue = undefined
    const responderStations = this.entities.filter((entity) => entity.kind === 'person' && entity.role === 'responder')
    const humanoidStations = this.entities.filter((entity) => entity.kind === 'humanoid')
    const hazardSources = this.layout.layout.bays
      .flatMap((bay) => bay.equipment)
      .filter((equipment) => equipment.hazardCapable)
      .map((equipment) => {
        const responderDistance = Math.min(...responderStations.map((entity) =>
          Math.hypot(entity.homeX - equipment.position[0], entity.homeZ - equipment.position[2])
        ))
        const humanoidDistance = Math.min(...humanoidStations.map((entity) =>
          Math.hypot(entity.homeX - equipment.position[0], entity.homeZ - equipment.position[2])
        ))
        return {
          equipment,
          coverageDistance: Math.max(responderDistance, humanoidDistance),
          imbalance: Math.abs(responderDistance - humanoidDistance)
        }
      })
      .sort((left, right) =>
        left.coverageDistance - right.coverageDistance ||
        left.imbalance - right.imbalance ||
        left.equipment.id.localeCompare(right.equipment.id)
      )
      .map(({ equipment }) => equipment)
    const source = reference
      ? hazardSources.find((equipment) => equipment.id === reference.sourceEquipmentId)
      : hazardSources[0]
    if (!source) return
    this.scenarioSourceEquipmentId = source.id
    this.triggerEmergency('gasLeak')
    const target = resolveHumanoidTarget(this, {
      id: `comparison-target-${mode}`,
      kind: 'gas_isolation',
      ...(reference ? { targetId: reference.targetId } : {}),
      requestedBy: 'operator',
      priority: 100
    })
    this.riskComparison = {
      mode,
      stage: 'dispatching',
      sourceEquipmentId: source.id,
      targetId: target.id,
      targetX: target.x,
      targetZ: target.z,
      targetYaw: target.yaw ?? 0,
      startedAt: this.simTime,
      stageStartedAt: this.simTime,
      humanWorkZoneSeconds: 0,
      spotterClearance: 0
    }
    this.events.push({
      type: 'hudMessage',
      message: mode === 'human'
        ? 'A/B 기준선 A를 시작합니다. 보호구를 갖춘 방재요원이 동일 밸브를 직접 조작합니다.'
        : '동일 초기상태로 복원했습니다. A/B 비교군 B의 휴머노이드 격리 태스크를 시작합니다.',
      data: {
        interactionKind: mode === 'human' ? 'risk_comparison_human_started' : 'risk_comparison_humanoid_started',
        targetId: target.id,
        sourceEquipmentId: source.id,
        severity: 'warning'
      }
    })
  }
  dispatchHumanoidTask(request: HumanoidTaskRequest, restored = false): void {
    if (this.humanoidTasks.some((task) => task.id === request.id)) return
    const target = resolveHumanoidTarget(this, request)
    if (request.kind === 'medical_support' && this.medicalResponse) {
      const kitResponder = this.medicalResponse.responderIds
        .map((id) => this.entities.find((entity) => entity.id === id))
        .filter((entity) => entity !== undefined)
        .sort((left, right) =>
          Math.hypot(left.x - target.x, left.z - target.z) -
          Math.hypot(right.x - target.x, right.z - target.z) ||
          left.index - right.index
        )[0]
      this.medicalResponse.kitResponderId = kitResponder?.id
      this.medicalResponse.kitRendezvousX = target.x
      this.medicalResponse.kitRendezvousZ = target.z
      this.medicalResponse.kitHandoffComplete = false
    }
    const task: HumanoidTaskRuntime = {
      id: request.id,
      kind: request.kind,
      status: 'queued',
      requestedBy: request.requestedBy,
      priority: request.priority,
      targetId: target.id,
      targetX: target.x,
      targetZ: target.z,
      targetYaw: target.yaw,
      createdAt: this.simTime,
      stageStartedAt: this.simTime,
      operatorYielded: false,
      operatorClearanceConfirmed: false
    }
    this.humanoidTasks.push(task)
    this.emitTaskState(task, restored)
  }
  injectHumanoidFailure(): void {
    const task = this.humanoidTasks
      .filter((candidate) =>
        candidate.kind === 'gas_isolation' &&
        ['queued', 'assigned', 'navigating', 'observing', 'interacting'].includes(candidate.status)
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0]
    if (!task || task.gasIsolationVerified) return
    task.status = 'failed'
    task.stageStartedAt = this.simTime
    this.cancelledRmfTaskIds.add(task.id)
    const robot = task.robotId
      ? this.entities.find((entity) => entity.id === task.robotId && entity.kind === 'humanoid')
      : undefined
    const spotter = task.gasSpotterId
      ? this.entities.find((entity) => entity.id === task.gasSpotterId && entity.kind === 'person')
      : undefined
    if (robot) {
      robot.taskId = undefined
      robot.speed = 0
      robot.auxA = 0
      robot.auxB = 0
      if (robot.rmfControlled) {
        robot.behavior = 'halt'
        robot.activity = 'safeStop'
        robot.status = 'error'
      } else {
        const retreat = this.failureRetreatNode(robot)
        robot.behavior = 'yield'
        robot.activity = 'yielding'
        robot.status = 'waiting'
        robot.goalX = retreat[0]
        robot.goalZ = retreat[1]
        robot.route = []
        robot.routeCursor = 0
        robot.targetX = Number.NaN
        robot.targetZ = Number.NaN
      }
    }
    if (spotter) {
      const retreat = this.failureRetreatNode(spotter, robot ? [robot.goalX, robot.goalZ] : undefined)
      spotter.gasSpotterTaskId = undefined
      spotter.behavior = 'yield'
      spotter.emergency = true
      spotter.personActivity = 'reacting'
      spotter.reactionStartedAt = this.simTime
      spotter.reactionUntil = this.simTime + 0.8
      spotter.goalX = retreat[0]
      spotter.goalZ = retreat[1]
      spotter.route = []
      spotter.routeCursor = 0
      spotter.targetX = Number.NaN
      spotter.targetZ = Number.NaN
      spotter.speed = 0
      spotter.animation = 7
      spotter.auxA = 0
    }
    this.emitTaskState(task)
    this.events.push({
      type: 'interaction',
      taskId: task.id,
      robotId: robot?.id,
      personId: spotter?.id,
      message: spotter
        ? '격리 밸브 조작 실패 — 위험원은 미통제 상태로 유지하고 로봇·안전감시자를 후퇴시켜 EHS 수동 대응에 인계합니다.'
        : '격리 밸브 조작 실패 — 위험원은 미통제 상태로 유지하고 로봇을 후퇴시켜 EHS 수동 대응에 인계합니다.',
      data: {
        interactionKind: 'gas_failure_handoff',
        ...(robot ? { robotX: robot.x, robotZ: robot.z } : {}),
        ...(spotter ? { personX: spotter.x, personZ: spotter.z } : {}),
        ...(robot ? { robotGoalX: robot.goalX, robotGoalZ: robot.goalZ } : {}),
        ...(spotter ? { personGoalX: spotter.goalX, personGoalZ: spotter.goalZ } : {}),
        severity: 'danger'
      }
    })
  }
  assignQueuedHumanoidTasks(): void {
    if (this.rmfLive) return
    const queued = this.humanoidTasks.filter((task) => task.status === 'queued').sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
    for (const task of queued) {
      const continuityInspector = task.kind === 'inspection_round' && task.id.startsWith('gas-continuity-')
      const robot = this.entities
        .filter((entity) =>
          entity.kind === 'humanoid' &&
          !entity.taskId &&
          !entity.rmfControlled &&
          (!continuityInspector || entity.id === 'humanoid-001')
        )
        .sort((left, right) =>
          (task.kind === 'medical_support' ? Number(right.id === 'humanoid-002') - Number(left.id === 'humanoid-002') : 0) ||
          Math.hypot(left.x - task.targetX, left.z - task.targetZ) -
            Math.hypot(right.x - task.targetX, right.z - task.targetZ) ||
          right.battery - left.battery ||
          left.index - right.index
        )[0]
      if (!robot) return
      task.robotId = robot.id; task.status = 'assigned'; task.stageStartedAt = this.simTime
      robot.taskId = task.id; robot.activity = 'walking'; robot.goalX = task.targetX; robot.goalZ = task.targetZ
      // A robot performing isolation or continuity inspection is not an
      // evacuation marshal. Leaving this role set made a stationary reporting
      // robot wave a baton indefinitely instead of completing its work cycle.
      robot.evacuationGuiding = false
      robot.emergency = task.kind === 'gas_isolation' || task.kind === 'medical_support' || continuityInspector
      if (continuityInspector) robot.maxSpeed = Math.max(robot.maxSpeed, 1.75)
      if (task.kind === 'gas_isolation') robot.maxSpeed = Math.max(robot.maxSpeed, 1.75)
      if (task.kind === 'medical_support') robot.maxSpeed = Math.max(robot.maxSpeed, 2.2)
      robot.auxB = task.kind === 'medical_support' ? 1 : task.kind === 'gas_isolation' ? -1 : 0
      robot.targetX = Number.NaN; robot.targetZ = Number.NaN; robot.route = []; robot.routeCursor = 0
      this.emitTaskState(task)
    }
  }
  emitTaskState(task: HumanoidTaskRuntime, restored = false): void {
    const statusLabel = {
      queued: '대기', assigned: '배정', navigating: '이동', observing: '현장 관찰', interacting: '물리 작업',
      reporting: '결과 보고', returning: '복귀', completed: '완료', failed: '실패', cancelled: '취소'
    }[task.status]
    this.events.push({
      type: 'taskStateChanged',
      taskId: task.id,
      taskKind: task.kind,
      taskStatus: task.status,
      robotId: task.robotId,
      ...(restored ? {} : { message: `${task.robotId ?? 'Open-RMF'} · ${task.id} · ${statusLabel}` }),
      data: {
        requestedBy: task.requestedBy,
        targetId: task.targetId,
        targetX: task.targetX,
        targetZ: task.targetZ,
        ...(task.targetYaw !== undefined ? { targetYaw: task.targetYaw } : {}),
        priority: task.priority,
        ...(restored ? { restored: 1 } : {})
      }
    })
  }
  applyRmfEvent(event: RmfBridgeEvent): void {
    this.rmfLive = true
    const restored = 'snapshot' in event && event.snapshot === true
    if (event.type === 'robot_state') {
      const robot = this.entities.find((entity) => entity.id === event.robot)
      if (!robot || robot.kind !== 'humanoid') return
      if (robot.rmfPose && event.timestamp <= robot.rmfPose.lastTimestamp) return
      const previousPose = robot.rmfPose
      const duration = previousPose
        ? Math.min(0.5, Math.max(0.08, (event.timestamp - previousPose.lastTimestamp) / 1_000))
        : 0
      const distance = Math.hypot(event.x - robot.x, event.y - robot.z)
      const yawDelta = Math.atan2(Math.sin(event.yaw - robot.yaw), Math.cos(event.yaw - robot.yaw))
      robot.rmfPose = {
        startX: robot.x,
        startZ: robot.z,
        startYaw: robot.yaw,
        targetX: event.x,
        targetZ: event.y,
        targetYaw: robot.yaw + yawDelta,
        elapsed: 0,
        duration,
        lastTimestamp: event.timestamp,
        moving: event.mode === 'moving',
        age: 0,
        stale: false
      }
      if (!previousPose || event.mode === 'offline') {
        robot.x = event.x
        robot.z = event.y
        robot.yaw = event.yaw
        robot.rmfPose.startX = event.x
        robot.rmfPose.startZ = event.y
        robot.rmfPose.startYaw = event.yaw
        robot.rmfPose.targetYaw = event.yaw
        robot.rmfPose.elapsed = duration
      }
      robot.battery = event.battery; robot.rmfControlled = true
      if ('taskId' in event) robot.taskId = event.taskId
      const activeTask = robot.taskId ? this.humanoidTasks.find((task) => task.id === robot.taskId) : undefined
      const actionTelemetryStale =
        activeTask?.kind === 'gas_isolation' &&
        activeTask.status === 'interacting' &&
        activeTask.actionTelemetryStale === true
      const taskActivity = activeTask
        ? activeTask.kind === 'gas_isolation' &&
          activeTask.status === 'interacting' &&
          !(
            activeTask.gasWorkPermitExternalAuthorized &&
            gasWorkZonePeople(this, activeTask).length === 0 &&
            activeTask.actionTelemetryPhase !== undefined &&
            activeTask.actionTelemetryStale !== true &&
            (activeTask.actionTelemetryAge ?? Infinity) <= ACTION_TELEMETRY_FRESHNESS_SECONDS
          )
          ? 'observing'
          : rmfActivityForStatus[activeTask.status]
        : undefined
      robot.status = actionTelemetryStale || event.mode === 'offline'
        ? 'error'
        : event.mode === 'moving'
          ? 'moving'
          : event.mode === 'charging'
            ? 'charging'
            : 'waiting'
      robot.activity = actionTelemetryStale || event.mode === 'offline'
        ? 'safeStop'
        : event.mode === 'moving'
          ? 'walking'
          : taskActivity ?? 'standby'
      robot.speed = actionTelemetryStale
        ? 0
        : event.mode === 'moving'
          ? Math.min(2, distance / Math.max(duration, 0.08))
          : 0
      if (activeTask && ['observing', 'interacting'].includes(activeTask.status)) {
        requestOperatorClearance(this, activeTask, robot)
      }
      return
    }
    if (event.type === 'task_state') {
      if (this.cancelledRmfTaskIds.has(event.taskId)) return
      let task = this.humanoidTasks.find((candidate) => candidate.id === event.taskId)
      if (!task) {
        this.dispatchHumanoidTask({
          id: event.taskId,
          kind: event.category,
          targetId: event.targetId,
          requestedBy: 'rmf',
          priority: 80
        }, restored)
        task = this.humanoidTasks.find((candidate) => candidate.id === event.taskId)
      }
      if (!task) return
      const previousStatus = task.status
      if (
        ['completed', 'failed', 'cancelled'].includes(previousStatus) &&
        event.status !== previousStatus
      ) return
      const statusChanged = event.status !== previousStatus
      task.status = event.status
      task.robotId = event.assignedRobot ?? task.robotId
      if (statusChanged) task.stageStartedAt = this.simTime
      const robot = task.robotId ? this.entities.find((candidate) => candidate.id === task.robotId && candidate.kind === 'humanoid') : undefined
      if (robot) {
        const terminal = ['completed', 'failed', 'cancelled'].includes(event.status)
        robot.rmfControlled = true
        robot.taskId = terminal ? undefined : task.id
        robot.emergency = !terminal && (task.kind === 'gas_isolation' || task.kind === 'medical_support')
        const gasInteractionAuthorized =
          task.kind !== 'gas_isolation' ||
          event.status !== 'interacting' ||
          (
            task.gasWorkPermitExternalAuthorized === true &&
            gasWorkZonePeople(this, task).length === 0 &&
            task.actionTelemetryPhase !== undefined &&
            task.actionTelemetryStale !== true
          )
        robot.activity = gasInteractionAuthorized ? rmfActivityForStatus[event.status] : 'observing'
        if (statusChanged) {
          robot.auxA = 0
          if (task.kind === 'gas_isolation' && event.status === 'interacting') {
            task.actionTelemetryAge = 0
            task.actionTelemetryStale = false
          }
        }
        robot.auxB = terminal || task.medicalHandoffEmitted
          ? 0
          : task.kind === 'medical_support'
            ? 1
            : task.kind === 'gas_isolation'
              ? -1
              : 0
        if (event.status === 'failed') robot.status = 'error'
        else if (terminal) robot.status = 'waiting'
        if (robot.rmfPose && ['observing', 'interacting'].includes(event.status)) {
          requestOperatorClearance(this, task, robot)
        }
      }
      if (event.interactionKind === 'medical_handoff') {
        task.medicalHandoffConfirmed = true
        if (robot) confirmMedicalHandoff(this, task, robot, restored)
      }
      if (
        event.interactionKind === 'inspection_anomaly_reported' &&
        task.kind === 'inspection_round'
      ) {
        task.inspectionAnomalyReported = true
      }
      const gasVerificationAuthorized =
        task.kind === 'gas_isolation' &&
        task.gasWorkPermitExternalAuthorized === true &&
        task.actionTelemetryPhase === 'verified' &&
        task.actionTelemetrySensorStable === true &&
        task.actionTelemetryValvePosition === 1 &&
        (
          restored ||
          (
            task.actionTelemetryStale !== true &&
            (task.actionTelemetryAge ?? Infinity) <= ACTION_TELEMETRY_FRESHNESS_SECONDS
          )
        ) && (restored || gasWorkZonePeople(this, task).length === 0)
      if (
        event.interactionKind === 'gas_isolation_verified' &&
        gasVerificationAuthorized
      ) {
        task.gasValveContactConfirmed = true
        task.gasValveActuationConfirmed = true
        task.gasIsolationVerified = true
        task.gasIsolationVerifiedAt = this.simTime
        this.hazardousManualActionsDelegated = 1
        this.gasIsolationElapsed = Math.max(0, this.simTime - this.emergency.startedAt)
        this.verifiedSafetyGates = 1
        if (this.emergency.kind === 'gasLeak' && this.emergency.phase !== 'normal') {
          this.markHazardControlled('humanoid_valve', restored)
        }
        if (!restored) this.events.push({
          type: 'interaction',
          taskId: task.id,
          robotId: robot?.id,
          message: `${robot?.name ?? '휴머노이드'}의 센서 안정 확인으로 전원 대피 상태를 유지한 채 설비 복구를 준비합니다.`,
          data: {
            interactionKind: 'gas_isolation_verified',
            targetX: task.targetX,
            targetZ: task.targetZ,
          }
        })
      } else if (
        event.interactionKind === 'gas_isolation_verified' &&
        task.kind === 'gas_isolation' &&
        !restored
      ) {
        this.events.push({
          type: 'hudMessage',
          taskId: task.id,
          robotId: robot?.id,
          message: '가스 격리 완료 콜백을 거절했습니다. 원격 작업허가, action executor 검증, 무인 작업구역을 다시 확인합니다.',
          data: { severity: 'danger' }
        })
      }
      if (event.status === 'completed' && previousStatus !== 'completed') this.completedHumanoidTasks++
      this.emitTaskState(task, restored)
      return
    }
    if (event.type === 'action_telemetry') {
      const task = this.humanoidTasks.find((candidate) => candidate.id === event.taskId)
      if (
        !task ||
        task.kind !== 'gas_isolation' ||
        task.status !== 'interacting' ||
        task.gasWorkPermitExternalAuthorized !== true ||
        (
          event.robot !== undefined &&
          task.robotId !== undefined &&
          event.robot !== task.robotId
        ) ||
        (
          task.actionTelemetryLastTimestamp !== undefined &&
          event.timestamp <= task.actionTelemetryLastTimestamp
        ) ||
        (
          task.actionTelemetryPhase !== undefined &&
          (
            ACTION_TELEMETRY_PHASE_ORDER[event.phase] < ACTION_TELEMETRY_PHASE_ORDER[task.actionTelemetryPhase] ||
            event.progress < (task.actionTelemetryProgress ?? 0) ||
            event.valvePosition < (task.actionTelemetryValvePosition ?? 0)
          )
        ) ||
        (!restored && gasWorkZonePeople(this, task).length > 0)
      ) return
      const previousContact = task.gasValveContactConfirmed === true
      const previousValveClosed = task.gasValveActuationConfirmed === true
      const previousMonitoring = task.gasSensorMonitoringEmitted === true
      task.actionTelemetryPhase = event.phase
      task.actionTelemetryProgress = event.progress
      task.actionTelemetryValvePosition = event.valvePosition
      task.actionTelemetryGasPpm = event.gasPpm
      task.actionTelemetrySensorStable = event.sensorStable
      task.actionTelemetryLeftHandContact = event.leftHandContact
      task.actionTelemetryRightHandContact = event.rightHandContact
      task.actionTelemetryLeftHandPosition = event.handPose?.leftPositionM
      task.actionTelemetryRightHandPosition = event.handPose?.rightPositionM
      task.actionTelemetryLastTimestamp = event.timestamp
      task.actionTelemetryAge = restored
        ? Math.max(0, (Date.now() - event.timestamp) / 1_000)
        : 0
      task.actionTelemetryStale = task.actionTelemetryAge > ACTION_TELEMETRY_FRESHNESS_SECONDS
      task.gasValveContactConfirmed =
        task.gasValveContactConfirmed === true ||
        (event.leftHandContact && event.rightHandContact)
      task.gasValveActuationConfirmed =
        task.gasValveActuationConfirmed === true ||
        event.valvePosition === 1
      task.gasSensorMonitoringEmitted =
        task.gasSensorMonitoringEmitted === true ||
        ['monitoring', 'verified'].includes(event.phase)
      if (task.gasValveActuationConfirmed) this.hazardousManualActionsDelegated = 1
      const robotId = event.robot ?? task.robotId
      const robot = robotId
        ? this.entities.find((candidate) => candidate.id === robotId && candidate.kind === 'humanoid')
        : undefined
      if (robot) {
        robot.auxA = event.progress
        // Values below -1 encode executor-reported valve position separately
        // from arm progress while preserving the gas-manipulation pose marker.
        robot.auxB = -1.001 - event.valvePosition
        robot.measuredLeftHandPosition = event.handPose?.leftPositionM
        robot.measuredRightHandPosition = event.handPose?.rightPositionM
        if (task.actionTelemetryStale || robot.rmfPose?.stale) {
          robot.speed = 0
          robot.status = 'error'
          robot.activity = 'safeStop'
        } else if (task.status === 'interacting') {
          robot.status = 'waiting'
          robot.activity = 'manipulating'
        }
      }
      if (!restored && !previousContact && task.gasValveContactConfirmed) {
        this.events.push({
          type: 'interaction',
          taskId: task.id,
          robotId,
          message: `${robot?.name ?? robotId ?? '휴머노이드'}의 양손 밸브 접촉 텔레메트리를 확인했습니다.`,
          data: { interactionKind: 'gas_valve_contact', telemetry: 'executor' }
        })
      }
      if (!restored && !previousValveClosed && task.gasValveActuationConfirmed) {
        this.events.push({
          type: 'interaction',
          taskId: task.id,
          robotId,
          message: `${robot?.name ?? robotId ?? '휴머노이드'}의 밸브 폐쇄 위치 텔레메트리를 확인했습니다.`,
          data: { interactionKind: 'gas_valve_closed', telemetry: 'executor' }
        })
      }
      if (!restored && !previousMonitoring && task.gasSensorMonitoringEmitted) {
        this.events.push({
          type: 'interaction',
          taskId: task.id,
          robotId,
          message: `action executor가 잔류 가스 ${event.gasPpm?.toFixed(1) ?? '—'} ppm 검지를 보고했습니다.`,
          data: {
            interactionKind: 'gas_sensor_monitoring',
            telemetry: 'executor',
            ...(event.gasPpm !== undefined ? { gasPpm: event.gasPpm } : {})
          }
        })
      }
      return
    }
    if (event.type === 'work_permit') {
      const task = this.humanoidTasks.find((candidate) => candidate.id === event.taskId)
      if (!task) return
      if (task.kind === 'gas_isolation') {
        task.actionTelemetryPhase = undefined
        task.actionTelemetryProgress = undefined
        task.actionTelemetryValvePosition = undefined
        task.actionTelemetryGasPpm = undefined
        task.actionTelemetrySensorStable = undefined
        task.actionTelemetryLeftHandContact = undefined
        task.actionTelemetryRightHandContact = undefined
        task.actionTelemetryLeftHandPosition = undefined
        task.actionTelemetryRightHandPosition = undefined
        task.actionTelemetryLastTimestamp = undefined
        task.actionTelemetryAge = 0
        task.actionTelemetryStale = false
        const robot = task.robotId
          ? this.entities.find((candidate) => candidate.id === task.robotId && candidate.kind === 'humanoid')
          : undefined
        if (robot && !task.gasIsolationVerified) {
          robot.auxA = 0
          robot.auxB = -1
          robot.measuredLeftHandPosition = undefined
          robot.measuredRightHandPosition = undefined
          robot.activity = 'observing'
        }
      }
      applyGasWorkPermit(this, task, {
        authorized: event.authorized,
        authorizedBy: event.authorizedBy,
        ...(event.clearance !== undefined ? { clearance: event.clearance } : {}),
        ...(event.personId ? { personId: event.personId } : {}),
        ...(event.reason ? { reason: event.reason } : {})
      }, restored)
      return
    }
    if (event.active && event.kind) this.triggerEmergency(event.kind, restored)
    else if (!event.active) this.finishEmergency(restored)
  }
  setRmfConnection(external: boolean, connected: boolean): void {
    this.rmfLive = external
    if (!external || connected) return
    const controlled = this.entities.filter((entity) => entity.kind === 'humanoid' && entity.rmfControlled)
    if (controlled.length === 0) return
    controlled.forEach((entity) => {
        entity.speed = 0
        entity.status = 'error'
        entity.activity = 'safeStop'
        entity.rmfPose = undefined
      })
    this.events.push({
      type: 'hudMessage',
      message: 'Open-RMF 연결이 끊겨 외부 제어 휴머노이드를 안전 정지했습니다.',
      data: { severity: 'danger' }
    })
  }
  triggerEmergency(kind: EmergencyKind, restored = false): void {
    if (this.emergency.phase !== 'normal' && this.emergency.phase !== 'allClear') return
    const equipment = findHazardSource(this, kind, this.scenarioSourceEquipmentId)
    const [sourceX, , sourceZ] = equipment ?? [0, 0, 0]
    const defaults = kind === 'gasLeak' ? { spreadRate: 0.4, maxRadius: 30, finish: 75 } : kind === 'fire' ? { spreadRate: 0.22, maxRadius: 24, finish: 85 } : { spreadRate: 0.1, maxRadius: 10, finish: 42 }
    const config = this.scenarioKind === kind ? this.scenarioHazardConfig : undefined
    const params = { spreadRate: config?.spreadRate ?? defaults.spreadRate, maxRadius: config?.maxRadius ?? defaults.maxRadius, finish: config?.fixedAt ?? defaults.finish }
    this.hazardousManualActionsDelegated = 0
    this.gasSpotterClearance = 0
    this.gasIsolationElapsed = 0
    this.verifiedSafetyGates = 0
    this.gasWorkZoneHumanEntrants.clear()
    this.gasWorkZoneRobotEntrants.clear()
    this.evacuationAssignments.clear()
    this.entities.forEach((entity) => {
      if (entity.kind !== 'person') return
      entity.evacuationMusterId = undefined
      entity.evacuationSlotIndex = undefined
      entity.formationBestDistance = undefined
      entity.formationLastProgressAt = undefined
      entity.formationReassignments = undefined
      entity.formationAvoidedSlotIndices = undefined
    })
    this.emergency = { phase: 'detected', kind, startedAt: this.simTime, phaseStartedAt: this.simTime, hazard: { kind, sourceX, sourceZ, radius: 1, maxRadius: params.maxRadius, spreadRate: params.spreadRate, fixedAt: params.finish } }
    if (kind === 'medical') {
      const victim = this.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder' && Math.hypot(entity.x - sourceX, entity.z - sourceZ) < 0.1)
      if (victim) {
        victim.behavior = 'halt'; victim.emergency = true; victim.animation = 3; victim.personActivity = 'collapsed'
        this.medicalResponse = { victimId: victim.id, responderIds: [], stage: 'dispatched', stageStartedAt: this.simTime }
      }
    }
    if (!restored) this.events.push({ type: 'log', message: `${kind === 'gasLeak' ? '가스 유출' : kind === 'fire' ? '화재' : '응급 환자'} 감지` })
    this.events.push({ type: 'phaseChanged', phase: 'detected', kind, data: { sourceX, sourceZ, ...(restored ? { restored: 1 } : {}) } })
  }
  setPhase(phase: EmergencyPhase): void {
    if (this.emergency.phase === phase) return
    if (phase !== 'normal' && !this.emergency.hazard) {
      this.triggerEmergency(this.scenarioKind ?? 'gasLeak')
      if (phase === 'detected') return
    }
    if (phase === 'allClear' && this.emergency.kind !== 'medical') {
      if (!this.emergency.hazardControlled) {
        this.events.push({
          type: 'hudMessage',
          message: '위험원 통제 피드백이 확인되지 않아 상황 해제를 보류합니다.',
          data: { severity: 'warning' }
        })
        return
      }
      if (!this.assemblyComplete()) return
    }
    this.emergency.phase = phase
    this.emergency.phaseStartedAt = this.simTime
    if (phase === 'alarm') {
      const kind = this.emergency.kind
      this.overrideBehavior('type:person', kind === 'medical' ? 'yield' : 'evacuate')
      this.entities.filter((entity) => entity.kind === 'humanoid').forEach((entity) => {
        // This is an explicit simulated response role, not a generic
        // "emergency-colored robot". The renderer uses it to put a lit baton
        // in the robot's hand while it is available to guide evacuation.
        // Fire marshaling benefits from a visible baton. Gas-response
        // humanoids instead perform source isolation while remote vehicles
        // cover equipment continuity, so a baton would communicate the wrong
        // role and can visually mask a stalled task.
        entity.evacuationGuiding = kind === 'fire'
      })
      if (kind === 'gasLeak') {
        this.overrideBehavior('type:agv', 'yield')
        this.overrideBehavior('type:oht', 'yield')
        this.overrideBehavior('type:igv', 'yield')
        this.dispatchVehicle('igv', 'hazmat-equipment')
        this.dispatchVehicle('agv', 'remote-equipment-inspection')
      } else if (kind === 'fire') {
        this.overrideBehavior('type:agv', 'halt')
        this.overrideBehavior('type:oht', 'halt')
        this.overrideBehavior('type:igv', 'yield')
        preemptLocalHumanoidTasks(this)
        this.overrideBehavior('type:humanoid', 'yield')
        this.entities.filter((entity) => entity.kind === 'humanoid').forEach((entity) => {
          entity.activity = entity.rmfControlled ? 'safeStop' : 'yielding'
        })
      } else if (kind === 'medical') this.overrideBehavior('type:agv', 'yield')
      if (kind !== 'gasLeak') this.dispatchResponders(kind === 'fire' ? 3 : 2)
      if (kind === 'gasLeak' && this.riskComparison?.mode === 'human') {
        // The robot-only gas workflow deliberately retains no on-scene
        // person. Its A/B human baseline still needs a two-person direct-work
        // team so the comparison measures an observed, equivalent operation.
        this.dispatchResponders(2)
        this.assignManualGasTeam()
      }
      if (kind === 'medical') this.dispatchVehicle('igv', 'medical-transport')
      if (
        kind === 'gasLeak' &&
        this.riskComparison?.mode !== 'human' &&
        !this.humanoidTasks.some((task) => task.kind === 'gas_isolation' && !['completed', 'failed', 'cancelled'].includes(task.status))
      ) {
        this.dispatchHumanoidTask({
          id: `gas-isolation-${this.taskSequence++}`,
          kind: 'gas_isolation',
          ...(this.riskComparison?.mode === 'humanoid' ? { targetId: this.riskComparison.targetId } : {}),
          requestedBy: this.showcaseInspectionTaskId ? 'showcase' : 'operator',
          priority: 100
        })
      }
      if (kind === 'medical' && !this.humanoidTasks.some((task) => task.kind === 'medical_support' && !['completed', 'failed', 'cancelled'].includes(task.status))) {
        const victim = this.entities.find((entity) => entity.kind === 'person' && entity.personActivity === 'collapsed')
        this.dispatchHumanoidTask({
          id: `medical-support-${this.taskSequence++}`,
          kind: 'medical_support',
          ...(victim ? { target: [victim.x, victim.z] as [number, number], targetId: victim.id } : {}),
          requestedBy: this.showcaseInspectionTaskId ? 'showcase' : 'operator',
          priority: 95
        })
      }
    }
    if (phase === 'allClear') this.entities.forEach((entity) => {
      const holdAtMuster = entity.kind === 'person' && this.emergency.kind !== 'medical'
      entity.behavior = holdAtMuster ? 'halt' : 'normal'
      entity.emergency = false
      entity.evacuationGuiding = false
      if (entity.kind !== 'arm') entity.targetDelay = 0
      if (entity.kind === 'person') {
        entity.maxSpeed = entity.preferredSpeed
        entity.personActivity = 'idle'
        entity.gasSpotterTaskId = undefined
        entity.speed = 0
        entity.route = []
        entity.routeCursor = 0
        entity.targetX = Number.NaN
        entity.targetZ = Number.NaN
        if (!holdAtMuster) {
          entity.evacuationMusterId = undefined
          entity.evacuationSlotIndex = undefined
          entity.formationBestDistance = undefined
          entity.formationLastProgressAt = undefined
          entity.formationReassignments = undefined
          entity.formationAvoidedSlotIndices = undefined
        }
        entity.nextActionAt = this.simTime + 2 + (entity.index % 7)
        entity.reactionUntil = undefined
        entity.animation = 0
      }
      if (entity.kind === 'humanoid' && !entity.taskId && !entity.rmfControlled) entity.activity = 'standby'
      if (entity.mission === 'hazmat-equipment' || entity.mission === 'remote-equipment-inspection' || entity.mission === 'medical-transport') {
        entity.mission = undefined
        entity.missionActivity = undefined
        entity.missionActivityStartedAt = undefined
      }
    })
    const hazard = this.emergency.hazard
    this.events.push({ type: 'phaseChanged', phase, kind: this.emergency.kind, ...(hazard ? { data: { sourceX: hazard.sourceX, sourceZ: hazard.sourceZ } } : {}) })
    this.events.push({ type: 'log', message: `비상 단계: ${phase}` })
  }
  finishEmergency(restored = false): void {
    if (this.emergency.phase !== 'normal' && !restored) this.events.push({ type: 'log', message: '비상 상황 종료. 정상 가동으로 복귀합니다.' })
    this.emergency = { phase: 'normal', startedAt: this.simTime }; this.medicalResponse = undefined; this.hazardLevels.clear(); this.events.push({
      type: 'phaseChanged',
      phase: 'normal',
      ...(restored ? { data: { restored: 1 } } : {})
    })
    this.evacuationAssignments.clear()
    this.entities.forEach((entity) => {
      entity.behavior = 'normal'
      entity.emergency = false
      entity.evacuationGuiding = false
      if (entity.kind === 'person') {
        entity.auxB = 0
        entity.gasSpotterTaskId = undefined
        entity.maxSpeed = entity.preferredSpeed
        entity.evacuationMusterId = undefined
        entity.evacuationSlotIndex = undefined
        entity.formationBestDistance = undefined
        entity.formationLastProgressAt = undefined
        entity.formationReassignments = undefined
        entity.formationAvoidedSlotIndices = undefined
        entity.personActivity = entity.personActivity === 'collapsed' ? 'idle' : entity.personActivity
        entity.reactionStartedAt = undefined
        entity.reactionUntil = undefined
        entity.nextActionAt = this.simTime + 2 + (entity.index % 7)
        entity.animation = 0
      }
      if (entity.kind === 'humanoid' && !entity.taskId && !entity.rmfControlled) entity.activity = 'standby'
      if (entity.mission === 'hazmat-equipment' || entity.mission === 'remote-equipment-inspection' || entity.mission === 'medical-transport') {
        entity.mission = undefined
        entity.missionActivity = undefined
        entity.missionActivityStartedAt = undefined
      }
    })
  }
  markHazardControlled(
    controlledBy: NonNullable<EmergencyState['controlledBy']> = 'responder',
    restored = false
  ): void {
    if (this.emergency.hazardControlled) return
    this.emergency.hazardControlled = true
    this.emergency.controlledBy = controlledBy
    this.withdrawRespondersFromControlledHazard()
    if (!restored) this.events.push({
      type: 'hudMessage',
      message: controlledBy === 'humanoid_valve'
        ? '휴머노이드의 밸브 폐쇄·내장 센서 검증으로 위험원이 통제되었습니다. 전원 집결과 원격 설비 점검을 확인합니다.'
        : controlledBy === 'operator'
          ? '방재요원의 직접 밸브 폐쇄로 위험원이 통제되었습니다. 작업자의 위험구역 체류 기록을 보존합니다.'
          : '위험원은 통제되었습니다. 전원 집결 확인 후 상황을 해제합니다.',
      data: { severity: 'info' }
    })
  }
  evacuationComplete(): boolean {
    const people = this.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
    return people.length > 0 && people.every((entity) => {
      const muster = entity.evacuationMusterId
        ? this.layout.layout.emergency.musterPoints.find((point) => point.id === entity.evacuationMusterId)
        : undefined
      return muster !== undefined && Math.hypot(entity.x - muster.position[0], entity.z - muster.position[2]) < MUSTER_SAFE_RADIUS
    })
  }
  assemblyComplete(): boolean {
    const people = this.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
    return people.length > 0 && people.every((person) => {
      const checkInYaw = this.musterCheckInYaw(person)
      if (person.evacuationSlotIndex === undefined || checkInYaw === undefined) return false
      const headingError = Math.abs(Math.atan2(
        Math.sin(person.yaw - checkInYaw),
        Math.cos(person.yaw - checkInYaw)
      ))
      return person.personActivity === 'mustered' &&
        Math.hypot(person.x - person.goalX, person.z - person.goalZ) < 0.12 &&
        person.speed < 0.08 &&
        headingError < 0.08
    })
  }
  musterCheckInYaw(person: SimEntity): number | undefined {
    const muster = person.evacuationMusterId
      ? this.layout.layout.emergency.musterPoints.find((point) => point.id === person.evacuationMusterId)
      : undefined
    if (!muster) return undefined
    const exit = [...this.layout.layout.emergency.exits]
      .sort((left, right) =>
        Math.hypot(left.position[0] - muster.position[0], left.position[2] - muster.position[2]) -
        Math.hypot(right.position[0] - muster.position[0], right.position[2] - muster.position[2])
      )[0]
    return exit
      ? Math.atan2(exit.position[2] - person.z, exit.position[0] - person.x)
      : undefined
  }
  resetOperation(): void {
    this.humanRobotClearances = 0
    this.hazardousManualActionsDelegated = 0
    this.gasSpotterClearance = 0
    this.gasIsolationElapsed = 0
    this.verifiedSafetyGates = 0
    this.gasWorkZoneHumanEntrants.clear()
    this.gasWorkZoneRobotEntrants.clear()
    this.riskComparison = undefined
    this.riskComparisonResultValue = undefined
    this.entities.forEach((entity) => {
      if (entity.kind === 'person') entity.manualGasRole = undefined
    })
    for (const task of this.humanoidTasks) {
      if (['completed', 'failed', 'cancelled'].includes(task.status)) continue
      task.status = 'cancelled'
      this.cancelledRmfTaskIds.add(task.id)
      const robot = task.robotId ? this.entities.find((entity) => entity.id === task.robotId) : undefined
      if (robot) {
        robot.taskId = undefined
        robot.activity = robot.rmfControlled ? 'safeStop' : 'standby'
        robot.emergency = false
        robot.speed = 0
        robot.auxA = 0
        robot.auxB = 0
        robot.measuredLeftHandPosition = undefined
        robot.measuredRightHandPosition = undefined
      }
    }
    this.showcaseInspectionTaskId = undefined
    this.showcaseIncidentTriggered = false
    this.scenario.clear()
    this.finishEmergency()
  }
  overrideBehavior(selector: string, behavior: EmergencyBehavior): void {
    this.entities.filter((entity) => this.matchesSelector(entity, selector)).forEach((entity) => {
      if (entity.kind === 'person' && entity.personActivity === 'collapsed' && behavior !== 'normal') return
      if (entity.behavior === behavior && behavior !== 'normal') return
      entity.behavior = behavior
      entity.emergency = behavior !== 'normal'
      entity.route = []
      entity.routeCursor = 0
      entity.targetX = Number.NaN
      entity.targetZ = Number.NaN
      if (entity.kind === 'person') {
        if (behavior === 'evacuate') {
          entity.reactionStartedAt = this.simTime
          const reactionDuration = entity.alarmReactionDelay ??
            (entity.role === 'operator' ? 0.9 : 1.8)
          entity.reactionUntil = this.simTime + reactionDuration
          entity.personActivity = 'reacting'
          this.assignEvacuationMuster(entity)
        } else if (behavior === 'yield') {
          entity.reactionStartedAt = this.simTime
          entity.reactionUntil = this.simTime + 0.4 + (entity.index % 5) * 0.24
          entity.personActivity = 'reacting'
          const hazard = this.emergency.hazard
          if (hazard) {
            const dx = entity.x - hazard.sourceX
            const dz = entity.z - hazard.sourceZ
            const length = Math.max(0.1, Math.hypot(dx, dz))
            entity.goalX = entity.x + dx / length * 5
            entity.goalZ = entity.z + dz / length * 5
          }
        }
      } else if (behavior === 'yield') this.assignSafeParking(entity)
    })
  }
  assignEvacuationMuster(person: SimEntity, force = false): number[] {
    if (person.kind !== 'person') return []
    const graph = this.layout.walkGraph
    const from = graph.nearest(person.x, person.z)
    const current = person.evacuationMusterId
      ? this.layout.layout.emergency.musterPoints.find((point) => point.id === person.evacuationMusterId)
      : undefined
    if (current && !force) {
      return graph.findPath(from, graph.nearest(current.position[0], current.position[2]), this.hazardLevels)
    }
    const candidates = this.layout.layout.emergency.musterPoints
      .map((point) => {
        const path = graph.findPath(from, graph.nearest(point.position[0], point.position[2]), this.hazardLevels)
        const distance = path.length > 0 ? pathDistance(graph, path) : Infinity
        const assigned = this.evacuationAssignments.get(point.id) ?? 0
        const crowdPenalty = 1 + assigned / Math.max(1, point.capacity) * 1.5
        return { point, path, score: distance * crowdPenalty }
      })
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((left, right) => left.score - right.score || left.point.id.localeCompare(right.point.id))
    const selected = candidates[0]
    if (!selected) return []
    if (current?.id !== selected.point.id) {
      if (current) this.evacuationAssignments.set(current.id, Math.max(0, (this.evacuationAssignments.get(current.id) ?? 1) - 1))
      this.evacuationAssignments.set(selected.point.id, (this.evacuationAssignments.get(selected.point.id) ?? 0) + 1)
      person.evacuationSlotIndex = undefined
      person.formationBestDistance = undefined
      person.formationLastProgressAt = undefined
      person.formationReassignments = undefined
      person.formationAvoidedSlotIndices = undefined
    }
    person.evacuationMusterId = selected.point.id
    if (person.evacuationSlotIndex === undefined) {
      person.goalX = selected.point.position[0]
      person.goalZ = selected.point.position[2]
    } else {
      const slot = musterSlot(person.evacuationSlotIndex, selected.point.capacity, selected.point.position[2])
      person.goalX = selected.point.position[0] + slot[0]
      person.goalZ = selected.point.position[2] + slot[1]
    }
    return selected.path
  }
  assignEvacuationSlot(person: SimEntity): void {
    if (person.kind !== 'person' || person.evacuationSlotIndex !== undefined || !person.evacuationMusterId) return
    const muster = this.layout.layout.emergency.musterPoints.find((point) => point.id === person.evacuationMusterId)
    if (!muster) return
    person.evacuationSlotIndex = claimMusterSlot(
      this,
      person,
      muster.id,
      muster.capacity,
      muster.position[0],
      muster.position[2]
    )
    const slot = musterSlot(person.evacuationSlotIndex, muster.capacity, muster.position[2])
    person.goalX = muster.position[0] + slot[0]
    person.goalZ = muster.position[2] + slot[1]
    person.avoidanceObstacleId = undefined
    person.avoidanceX = undefined
    person.avoidanceZ = undefined
    person.formationBestDistance = Math.hypot(person.x - person.goalX, person.z - person.goalZ)
    person.formationLastProgressAt = this.simTime
    person.formationReassignments = 0
    person.formationAvoidedSlotIndices = undefined
  }
  reassignBlockedEvacuationSlot(person: SimEntity): boolean {
    if (person.kind !== 'person' || person.evacuationSlotIndex === undefined || !person.evacuationMusterId) return false
    const muster = this.layout.layout.emergency.musterPoints.find((point) => point.id === person.evacuationMusterId)
    if (!muster) return false
    const previous = person.evacuationSlotIndex
    const avoided = [...new Set([...(person.formationAvoidedSlotIndices ?? []), previous])]
    const next = claimMusterSlot(
      this,
      person,
      muster.id,
      muster.capacity,
      muster.position[0],
      muster.position[2],
      true,
      avoided
    )
    if (next === previous) return false
    person.evacuationSlotIndex = next
    const slot = musterSlot(next, muster.capacity, muster.position[2])
    person.goalX = muster.position[0] + slot[0]
    person.goalZ = muster.position[2] + slot[1]
    person.targetX = person.goalX
    person.targetZ = person.goalZ
    person.avoidanceObstacleId = undefined
    person.avoidanceX = undefined
    person.avoidanceZ = undefined
    person.formationBestDistance = Math.hypot(person.x - person.goalX, person.z - person.goalZ)
    person.formationLastProgressAt = this.simTime
    person.formationReassignments = (person.formationReassignments ?? 0) + 1
    person.formationAvoidedSlotIndices = avoided
    return true
  }
  dispatchResponders(count: number): void {
    const hazard = this.emergency.hazard
    const responders = this.entities
      .filter((entity) => entity.kind === 'person' && entity.role === 'responder')
      .sort((a, b) => hazard ? Math.hypot(a.x - hazard.sourceX, a.z - hazard.sourceZ) - Math.hypot(b.x - hazard.sourceX, b.z - hazard.sourceZ) : a.index - b.index)
      .slice(0, count)
    responders.forEach((entity, index) => {
      entity.behavior = 'respond'
      entity.emergency = true
      entity.maxSpeed = entity.emergencySpeed ?? 1.9
      const kind = hazard?.kind
      // Give each emergency role a reserved arrival position. Sending every
      // responder to the incident origin looked like a crowd clipping through
      // the source equipment and made the response impossible to read.
      if (hazard && kind === 'fire') {
        const angle = [-Math.PI / 2, 0, Math.PI / 2][index % 3]!
        entity.goalX = hazard.sourceX + Math.cos(angle) * 2.65
        entity.goalZ = hazard.sourceZ + Math.sin(angle) * 2.65
        entity.personActivity = 'fireApproach'
      } else if (hazard && kind === 'medical') {
        const side = index === 0 ? -1 : 1
        entity.goalX = hazard.sourceX + side * 1.05
        entity.goalZ = hazard.sourceZ + (index === 0 ? 0.35 : -0.35)
        entity.personActivity = 'medicalApproach'
      } else {
        entity.personActivity = 'responding'
      }
      entity.route = []; entity.routeCursor = 0; entity.targetX = Number.NaN; entity.targetZ = Number.NaN
    })
    if (this.medicalResponse) this.medicalResponse.responderIds = responders.map((entity) => entity.id)
  }
  dispatchVehicle(kind: 'agv' | 'igv' | 'oht', mission: string): void {
    const hazard = this.emergency.hazard
    const dispatched = this.entities.find((candidate) => candidate.kind === kind && candidate.behavior === 'respond' && candidate.mission === mission)
    if (dispatched) {
      if (mission === 'medical-transport' && this.medicalResponse) this.medicalResponse.vehicleId = dispatched.id
      return
    }
    const entity = this.entities
      .filter((candidate) => candidate.kind === kind && (candidate.behavior === 'normal' || candidate.behavior === 'yield'))
      .sort((a, b) => hazard ? Math.hypot(a.x - hazard.sourceX, a.z - hazard.sourceZ) - Math.hypot(b.x - hazard.sourceX, b.z - hazard.sourceZ) : a.index - b.index)[0]
    if (entity) {
      entity.behavior = 'respond'; entity.emergency = true; entity.mission = mission
      entity.maxSpeed = Math.max(
        entity.maxSpeed,
        mission === 'hazmat-equipment' || mission === 'remote-equipment-inspection'
          ? 3
          : mission === 'medical-transport'
            ? 3.2
            : 2.2
      )
      entity.missionActivity = (mission === 'hazmat-equipment' || mission === 'remote-equipment-inspection') ? 'enroute' : undefined
      entity.missionActivityStartedAt = this.simTime
      entity.route = []; entity.routeCursor = 0; entity.targetX = Number.NaN; entity.targetZ = Number.NaN; entity.targetDelay = 0
      if (mission === 'hazmat-equipment' || mission === 'remote-equipment-inspection') {
        const target = this.layout.layout.bays.flatMap((bay) => bay.equipment)
          .filter((equipment) => !hazard || Math.hypot(equipment.position[0] - hazard.sourceX, equipment.position[2] - hazard.sourceZ) >= hazard.maxRadius + 8)
          .sort((left, right) =>
            Math.hypot(left.position[0] - entity.x, left.position[2] - entity.z) -
              Math.hypot(right.position[0] - entity.x, right.position[2] - entity.z) ||
            left.id.localeCompare(right.id)
          )[0]
        if (target) {
          entity.goalX = target.position[0]
          entity.goalZ = target.position[2]
          this.events.push({
            type: 'interaction',
            robotId: entity.id,
            message: `${entity.name}이 위험 반경 밖 ${target.id} 설비의 비접촉 상태 점검으로 배정되었습니다.`,
            data: { interactionKind: 'remote_equipment_inspection', targetId: target.id, targetX: target.position[0], targetZ: target.position[2], severity: 'info' }
          })
        }
      }
      if (mission === 'medical-transport' && this.medicalResponse) this.medicalResponse.vehicleId = entity.id
    }
  }
  matchesSelector(entity: SimEntity, selector: string): boolean {
    return selector.split(/\s+/).filter(Boolean).every((part) => {
      const [key, rawValue] = part.split(':'); const negated = rawValue?.startsWith('!'); const value = rawValue?.replace(/^!/, '')
      const actual = key === 'type' ? entity.kind : key === 'role' ? entity.role : key === 'id' ? entity.id : key === 'zone' ? this.layout.zoneAt(entity.x, entity.z)?.replace('zone-', '') : undefined
      return negated ? actual !== value : actual === value
    })
  }
  refreshHazards(): void {
    const previous = new Map(this.hazardLevels)
    this.hazardLevels.clear(); const hazard = this.emergency.hazard
    if (!hazard) return
    for (const zone of this.layout.layout.zones) {
      const center = zone.polygon.reduce<[number, number]>((sum, point) => [sum[0] + point[0] / zone.polygon.length, sum[1] + point[1] / zone.polygon.length], [0, 0])
      const distance = distance2(center, [hazard.sourceX, hazard.sourceZ])
      if (distance <= hazard.radius) this.hazardLevels.set(zone.id, 'danger')
      else if (distance <= hazard.radius * 1.8) this.hazardLevels.set(zone.id, 'warning')
    }
    const changed = previous.size !== this.hazardLevels.size || [...this.hazardLevels].some(([zone, level]) => previous.get(zone) !== level)
    if (changed) this.entities.filter((entity) => entity.behavior !== 'respond' && entity.kind !== 'arm').forEach((entity) => { entity.route = []; entity.routeCursor = 0; entity.targetX = Number.NaN; entity.targetZ = Number.NaN })
  }
  poseSnapshot(): { buffer: ArrayBuffer; generation: number; entityCount: number; simTimeMs: number } {
    const front = this.frontBuffer * MAX_ENTITIES * POSE_STRIDE
    return { buffer: this.pose.slice(front, front + this.entities.length * POSE_STRIDE).buffer, generation: this.fallbackGeneration, entityCount: this.entities.length, simTimeMs: Math.round(this.simTime * 1000) }
  }
  log(message: string): void { this.events.push({ type: 'log', message }) }
  drainEvents(): SimEvent[] { return this.events.splice(0) }
  private updateRemoteGasInspections(): void {
    if (this.emergency.kind !== 'gasLeak' || this.emergency.phase === 'normal') return
    for (const entity of this.entities) {
      if (
        (entity.mission !== 'hazmat-equipment' && entity.mission !== 'remote-equipment-inspection') ||
        entity.missionActivity === undefined ||
        entity.missionActivity === 'complete'
      ) continue
      const distance = Math.hypot(entity.x - entity.goalX, entity.z - entity.goalZ)
      if (entity.missionActivity === 'enroute' && distance < 1.2) {
        entity.missionActivity = 'inspecting'
        entity.missionActivityStartedAt = this.simTime
        entity.speed = 0
        entity.status = 'working'
        entity.auxA = 0
        this.events.push({
          type: 'interaction',
          robotId: entity.id,
          message: `${entity.name}이 ${entity.mission === 'hazmat-equipment' ? '열화상·가스 경계' : '인터록·반송 상태'} 비접촉 스캔을 시작했습니다.`,
          data: {
            interactionKind: 'remote_equipment_scan',
            targetX: entity.goalX,
            targetZ: entity.goalZ,
            severity: 'info'
          }
        })
        continue
      }
      const elapsed = this.simTime - (entity.missionActivityStartedAt ?? this.simTime)
      if (entity.missionActivity === 'inspecting') {
        entity.auxA = Math.min(1, elapsed / 4)
        if (elapsed < 4) continue
        entity.missionActivity = 'reporting'
        entity.missionActivityStartedAt = this.simTime
        this.events.push({
          type: 'interaction',
          robotId: entity.id,
          message: `${entity.name}이 비상 설비 스캔 결과를 Open-RMF에 전송했습니다.`,
          data: { interactionKind: 'remote_equipment_report', targetX: entity.goalX, targetZ: entity.goalZ, severity: 'info' }
        })
        continue
      }
      if (entity.missionActivity === 'reporting' && elapsed >= 2) {
        entity.missionActivity = 'complete'
        entity.speed = 0
        entity.status = 'waiting'
        entity.auxA = 1
      }
    }
  }
  private updateGasWorkZoneEntries(): void {
    const task = [...this.humanoidTasks].reverse().find((candidate) => candidate.kind === 'gas_isolation')
    if (!task) return
    const gatedWorkActive = task.status === 'interacting' || task.gasWorkZoneBreachActive === true
    if (!gatedWorkActive) return
    for (const person of gasWorkZonePeople(this, task)) this.gasWorkZoneHumanEntrants.add(person.id)
    const robot = task.robotId
      ? this.entities.find((entity) => entity.id === task.robotId && entity.kind === 'humanoid')
      : undefined
    if (
      robot &&
      Math.hypot(robot.x - task.targetX, robot.z - task.targetZ) < GAS_WORK_ZONE_RADIUS
    ) this.gasWorkZoneRobotEntrants.add(robot.id)
  }
  private updateRiskComparison(dt: number): void {
    const comparison = this.riskComparison
    if (!comparison || this.riskComparisonResultValue) return
    if (comparison.mode === 'humanoid') {
      const task = [...this.humanoidTasks].reverse().find((candidate) =>
        candidate.kind === 'gas_isolation' &&
        candidate.targetId === comparison.targetId
      )
      if (!task?.gasIsolationVerified) return
      this.riskComparisonResultValue = {
        mode: 'humanoid',
        sourceEquipmentId: comparison.sourceEquipmentId,
        targetId: comparison.targetId,
        humanEntries: this.gasWorkZoneHumanEntrants.size,
        humanoidEntries: this.gasWorkZoneRobotEntrants.size,
        humanWorkZoneSeconds: 0,
        isolationElapsed: Math.max(0, this.simTime - comparison.startedAt),
        spotterClearance: this.gasSpotterClearance,
        verified: true
      }
      comparison.stage = 'verified'
      comparison.stageStartedAt = this.simTime
      this.events.push({
        type: 'missionDone',
        taskId: task.id,
        taskKind: task.kind,
        robotId: task.robotId,
        message: `A/B 비교군 B 완료 — 사람의 밸브 작업점 진입 없이 휴머노이드가 동일 격리 작업을 검증했습니다.`,
        data: {
          interactionKind: 'risk_comparison_humanoid_verified',
          targetId: comparison.targetId,
          humanEntries: this.gasWorkZoneHumanEntrants.size,
          humanoidEntries: this.gasWorkZoneRobotEntrants.size,
          humanWorkZoneSeconds: 0,
          isolationElapsed: this.riskComparisonResultValue.isolationElapsed,
          severity: 'info'
        }
      })
      return
    }

    const operator = comparison.operatorId
      ? this.entities.find((entity) => entity.id === comparison.operatorId && entity.kind === 'person')
      : undefined
    const spotter = comparison.spotterId
      ? this.entities.find((entity) => entity.id === comparison.spotterId && entity.kind === 'person')
      : undefined
    if (!operator || !spotter) return
    const peopleAtWorkPoint = this.entities.filter((entity) =>
      entity.kind === 'person' &&
      Math.hypot(entity.x - comparison.targetX, entity.z - comparison.targetZ) < GAS_WORK_ZONE_RADIUS
    )
    const exposureActive = ['approaching', 'manipulating', 'monitoring'].includes(comparison.stage)
    if (exposureActive) {
      for (const person of peopleAtWorkPoint) this.gasWorkZoneHumanEntrants.add(person.id)
      comparison.humanWorkZoneSeconds += peopleAtWorkPoint.length * Math.max(0, dt)
    }
    const operatorAtGoal =
      Math.hypot(operator.x - operator.goalX, operator.z - operator.goalZ) < 0.12 &&
      operator.speed < 0.2
    const spotterAtGoal =
      Math.hypot(spotter.x - spotter.goalX, spotter.z - spotter.goalZ) < 0.12 &&
      spotter.speed < 0.2
    comparison.spotterClearance = Math.hypot(
      spotter.x - comparison.targetX,
      spotter.z - comparison.targetZ
    )
    this.gasSpotterClearance = comparison.spotterClearance
    if (spotterAtGoal) {
      spotter.yaw = Math.atan2(comparison.targetZ - spotter.z, comparison.targetX - spotter.x)
    }
    spotter.animation = spotterAtGoal ? 8 : 2
    spotter.auxA = comparison.stage === 'monitoring' || comparison.stage === 'verified' ? 1 : 0.45

    if (comparison.stage === 'dispatching' && operatorAtGoal && spotterAtGoal && peopleAtWorkPoint.length === 0) {
      comparison.stage = 'permit-check'
      comparison.stageStartedAt = this.simTime
      operator.speed = 0
      operator.animation = 4
      operator.yaw = Math.atan2(comparison.targetZ - operator.z, comparison.targetX - operator.x)
      this.events.push({
        type: 'interaction',
        personId: operator.id,
        message: `${operator.name}과 ${spotter.name}이 진입 전 위치를 확보했습니다. 작업점 무인 상태와 EHS 허가를 확인합니다.`,
        data: {
          interactionKind: 'manual_gas_permit_check',
          targetX: comparison.targetX,
          targetZ: comparison.targetZ,
          workZoneRadius: GAS_WORK_ZONE_RADIUS,
          workZonePeople: 0,
          spotterClearance: comparison.spotterClearance
        }
      })
      return
    }
    if (
      comparison.stage === 'permit-check' &&
      peopleAtWorkPoint.length === 0 &&
      this.simTime - comparison.stageStartedAt >= 0.8
    ) {
      comparison.stage = 'approaching'
      comparison.stageStartedAt = this.simTime
      operator.goalX = comparison.targetX
      operator.goalZ = comparison.targetZ
      operator.route = []
      operator.routeCursor = 0
      operator.targetX = Number.NaN
      operator.targetZ = Number.NaN
      operator.targetDelay = 0
      this.events.push({
        type: 'interaction',
        personId: operator.id,
        message: `EHS 허가가 확인되어 ${operator.name}이 직접 조작을 위해 ${GAS_WORK_ZONE_RADIUS.toFixed(1)}m 작업점에 진입합니다.`,
        data: {
          interactionKind: 'manual_gas_authorized',
          targetX: comparison.targetX,
          targetZ: comparison.targetZ,
          spotterX: spotter.x,
          spotterZ: spotter.z,
          spotterClearance: comparison.spotterClearance
        }
      })
      return
    }
    if (
      comparison.stage === 'approaching' &&
      Math.hypot(operator.x - comparison.targetX, operator.z - comparison.targetZ) < 0.08 &&
      operator.speed < 0.2
    ) {
      comparison.stage = 'manipulating'
      comparison.stageStartedAt = this.simTime
      comparison.manipulationStartedAt = this.simTime
      operator.speed = 0
      operator.status = 'working'
      operator.animation = 9
      operator.auxA = 0
      operator.yaw = comparison.targetYaw
    }
    const manipulationElapsed = comparison.manipulationStartedAt === undefined
      ? 0
      : this.simTime - comparison.manipulationStartedAt
    if (!['manipulating', 'monitoring'].includes(comparison.stage)) return
    operator.speed = 0
    operator.status = 'working'
    operator.animation = 9
    operator.auxA = Math.min(1, manipulationElapsed / 8.2)
    operator.yaw = comparison.targetYaw
    if (!comparison.contactEmitted && manipulationElapsed >= 1.2) {
      comparison.contactEmitted = true
      this.events.push({
        type: 'interaction',
        personId: operator.id,
        message: `${operator.name}이 수동 격리 밸브 손잡이에 직접 접촉했습니다.`,
        data: {
          interactionKind: 'manual_gas_valve_contact',
          personX: operator.x,
          personZ: operator.z,
          targetX: comparison.targetX,
          targetZ: comparison.targetZ
        }
      })
    }
    if (!comparison.valveClosedEmitted && manipulationElapsed >= 5.2) {
      comparison.valveClosedEmitted = true
      comparison.stage = 'monitoring'
      comparison.stageStartedAt = this.simTime
      this.events.push({
        type: 'interaction',
        personId: operator.id,
        message: `${operator.name}이 밸브를 폐쇄 위치까지 회전했고 ${spotter.name}이 잔류 가스를 확인합니다.`,
        data: {
          interactionKind: 'manual_gas_valve_closed',
          personX: operator.x,
          personZ: operator.z,
          targetX: comparison.targetX,
          targetZ: comparison.targetZ,
          spotterX: spotter.x,
          spotterZ: spotter.z
        }
      })
    }
    if (manipulationElapsed < 8.2) return
    comparison.stage = 'verified'
    comparison.stageStartedAt = this.simTime
    this.gasIsolationElapsed = Math.max(0, this.simTime - comparison.startedAt)
    this.verifiedSafetyGates = 1
    this.riskComparisonResultValue = {
      mode: 'human',
      sourceEquipmentId: comparison.sourceEquipmentId,
      targetId: comparison.targetId,
      humanEntries: this.gasWorkZoneHumanEntrants.size,
      humanoidEntries: 0,
      humanWorkZoneSeconds: comparison.humanWorkZoneSeconds,
      isolationElapsed: this.gasIsolationElapsed,
      spotterClearance: comparison.spotterClearance,
      verified: true
    }
    this.events.push({
      type: 'missionDone',
      personId: operator.id,
      message: `A/B 기준선 A 완료 — 사람 ${this.gasWorkZoneHumanEntrants.size}명이 작업점에 진입했고 ${comparison.humanWorkZoneSeconds.toFixed(1)} person·sec가 관측되었습니다.`,
      data: {
        interactionKind: 'risk_comparison_human_verified',
        targetId: comparison.targetId,
        humanEntries: this.gasWorkZoneHumanEntrants.size,
        humanWorkZoneSeconds: comparison.humanWorkZoneSeconds,
        isolationElapsed: this.gasIsolationElapsed,
        severity: 'warning'
      }
    })
    this.markHazardControlled('operator')
  }
  private updateShowcase(): void {
    if (!this.showcaseInspectionTaskId || this.showcaseIncidentTriggered) return
    const task = this.humanoidTasks.find((candidate) => candidate.id === this.showcaseInspectionTaskId)
    if (!task?.inspectionAnomalyReported) return
    this.showcaseIncidentTriggered = true
    this.events.push({
      type: 'hudMessage',
      taskId: task.id,
      robotId: task.robotId,
      message: '휴머노이드의 명시적 이상 보고를 확인했습니다. Open-RMF에 비상 재조율을 요청합니다.',
      data: {
        interactionKind: 'inspection_anomaly_reported',
        targetId: task.targetId,
        severity: 'warning'
      }
    })
    this.triggerEmergency('gasLeak')
  }
  private reserveShowcaseOperator(task: HumanoidTaskRuntime): void {
    const operator = this.entities
      .filter((entity) => entity.kind === 'person' && entity.role === 'operator')
      .sort((left, right) =>
        Math.hypot(left.x - task.targetX, left.z - task.targetZ) -
        Math.hypot(right.x - task.targetX, right.z - task.targetZ)
      )[0]
    if (!operator) return
    operator.goalX = task.targetX
    operator.goalZ = task.targetZ
    operator.workTargetId = task.targetId
    operator.workReservationTaskId = task.id
    operator.personActivity = 'walkingToWork'
    operator.nextActionAt = undefined
    operator.targetDelay = 0
    operator.route = []
    operator.routeCursor = 0
    operator.targetX = Number.NaN
    operator.targetZ = Number.NaN
    this.events.push({
      type: 'interaction',
      taskId: task.id,
      personId: operator.id,
      message: `${operator.name}이 ${task.targetId} 현장 점검을 수행 중이며 휴머노이드와 작업 구역을 인계할 예정입니다.`
    })
  }
  private assignManualGasTeam(): void {
    const comparison = this.riskComparison
    if (!comparison || comparison.mode !== 'human' || comparison.operatorId || comparison.spotterId) return
    const responders = this.entities
      .filter((entity) => entity.kind === 'person' && entity.role === 'responder' && entity.behavior === 'respond')
      .sort((left, right) =>
        Math.hypot(left.x - comparison.targetX, left.z - comparison.targetZ) -
          Math.hypot(right.x - comparison.targetX, right.z - comparison.targetZ) ||
        left.index - right.index
      )
    const operator = responders[0]
    const spotter = responders[1]
    if (!operator || !spotter) return
    const heading = comparison.targetYaw
    const side = (spotter.index & 1) === 0 ? 1 : -1
    const operatorStagingX = comparison.targetX - Math.cos(heading) * (GAS_WORK_ZONE_RADIUS + 0.25)
    const operatorStagingZ = comparison.targetZ - Math.sin(heading) * (GAS_WORK_ZONE_RADIUS + 0.25)
    const spotterX = comparison.targetX - Math.cos(heading) * 0.35 - Math.sin(heading) * side * 2.25
    const spotterZ = comparison.targetZ - Math.sin(heading) * 0.35 + Math.cos(heading) * side * 2.25
    comparison.operatorId = operator.id
    comparison.spotterId = spotter.id
    for (const [person, role, goalX, goalZ] of [
      [operator, 'operator', operatorStagingX, operatorStagingZ],
      [spotter, 'spotter', spotterX, spotterZ]
    ] as const) {
      person.manualGasRole = role
      person.personActivity = role === 'operator' ? 'manualGasOperator' : 'manualGasSpotter'
      person.goalX = goalX
      person.goalZ = goalZ
      person.route = []
      person.routeCursor = 0
      person.targetX = Number.NaN
      person.targetZ = Number.NaN
      person.targetDelay = 0
      person.auxA = 0
    }
    this.events.push({
      type: 'interaction',
      personId: operator.id,
      message: `${operator.name}이 직접 조작자로, ${spotter.name}이 가스 안전감시자로 배정되었습니다.`,
      data: {
        interactionKind: 'manual_gas_team_dispatched',
        targetX: comparison.targetX,
        targetZ: comparison.targetZ,
        operatorStagingX,
        operatorStagingZ,
        spotterX,
        spotterZ
      }
    })
  }
  private assignSafeParking(entity: SimEntity): void {
    const graph = entity.kind === 'oht' ? this.layout.railGraph : entity.kind === 'humanoid' || entity.kind === 'person' ? this.layout.walkGraph : this.layout.roadGraph
    const hazard = this.emergency.hazard
    const from = graph.nearest(entity.x, entity.z)
    const reserved = this.entities
      .filter((other) =>
        other !== entity &&
        other.behavior === 'yield' &&
        other.emergency &&
        (entity.kind === 'oht' ? other.kind === 'oht' : other.kind !== 'oht' && other.kind !== 'person' && other.kind !== 'humanoid') &&
        Number.isFinite(other.goalX) &&
        Number.isFinite(other.goalZ)
      )
      .map((other) => [other.goalX, other.goalZ] as const)
    const humanoidStations = entity.kind === 'oht'
      ? []
      : this.entities
          .filter((other) => other.kind === 'humanoid')
          .map((other) => [other.x, other.z] as const)
    // OHTs do not emergency-brake in place for a gas incident. They finish
    // their current rail segment, clear the affected transfer corridor, and
    // wait at a reachable rail-side parking node beyond the warning boundary.
    const target = graph.nodes
      .map((node, index) => ({ node, index, distance: Math.hypot(node.x - entity.x, node.z - entity.z) }))
      .filter(({ node }) =>
        (!hazard || Math.hypot(node.x - hazard.sourceX, node.z - hazard.sourceZ) > hazard.maxRadius * 1.8 + 5) &&
        reserved.every(([x, z]) => Math.hypot(node.x - x, node.z - z) >= (entity.kind === 'oht' ? 4 : 2.2)) &&
        humanoidStations.every(([x, z]) => Math.hypot(node.x - x, node.z - z) >= 3)
      )
      .sort((left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id))
      .find(({ index }) => graph.findPath(from, index, this.hazardLevels).length > 0)?.node
    if (target) { entity.goalX = target.x; entity.goalZ = target.z }
  }
  private withdrawRespondersFromControlledHazard(): void {
    const hazard = this.emergency.hazard
    if (!hazard) return
    const graph = this.layout.walkGraph
    const reserved: Array<readonly [number, number]> = []
    const responders = this.entities.filter((entity) =>
      entity.kind === 'person' && entity.role === 'responder' && entity.behavior === 'respond'
    )
    for (const responder of responders) {
      const from = graph.nearest(responder.x, responder.z)
      const minimumHazardDistance = Math.max(12, hazard.radius + 2)
      const target = graph.nodes
        .map((node, index) => ({
          node,
          index,
          travel: Math.hypot(node.x - responder.x, node.z - responder.z)
        }))
        .filter(({ node }) =>
          Math.hypot(node.x - hazard.sourceX, node.z - hazard.sourceZ) >= minimumHazardDistance &&
          reserved.every(([x, z]) => Math.hypot(node.x - x, node.z - z) >= 3)
        )
        .sort((left, right) => left.travel - right.travel || left.node.id.localeCompare(right.node.id))
        .find(({ index }) => graph.findPath(from, index, this.hazardLevels).length > 0)?.node
      if (!target) continue
      reserved.push([target.x, target.z])
      responder.behavior = 'yield'
      responder.personActivity = 'responding'
      responder.goalX = target.x
      responder.goalZ = target.z
      responder.route = []
      responder.routeCursor = 0
      responder.targetX = Number.NaN
      responder.targetZ = Number.NaN
      responder.targetDelay = 0
    }
  }
  private failureRetreatNode(entity: SimEntity, avoid?: readonly [number, number]): readonly [number, number] {
    const graph = this.layout.walkGraph
    const hazard = this.emergency.hazard
    const from = graph.nearest(entity.x, entity.z)
    const minimum = hazard ? Math.max(6, hazard.radius + 3) : 6
    const target = graph.nodes
      .map((node, index) => ({
        node,
        index,
        distance: Math.hypot(node.x - entity.x, node.z - entity.z)
      }))
      .filter(({ node }) =>
        Math.hypot(node.x - entity.x, node.z - entity.z) >= 4 &&
        (!hazard || Math.hypot(node.x - hazard.sourceX, node.z - hazard.sourceZ) >= minimum) &&
        (!avoid || Math.hypot(node.x - avoid[0], node.z - avoid[1]) >= 2.5)
      )
      .sort((left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id))
      .find(({ index }) => graph.findPath(from, index, this.hazardLevels).length > 0)?.node
    return target ? [target.x, target.z] : [entity.x, entity.z]
  }
  private flushPose(): void {
    const back = this.sharedPose ? 1 - this.frontBuffer : this.frontBuffer
    const offset = back * MAX_ENTITIES * POSE_STRIDE
    this.entities.forEach((entity) => {
      const slot = offset + entity.index * POSE_STRIDE
      const measuredHandPose =
        entity.measuredLeftHandPosition !== undefined &&
        entity.measuredRightHandPosition !== undefined
      this.pose[slot + PoseSlot.X] = entity.x; this.pose[slot + PoseSlot.Y] = entity.y; this.pose[slot + PoseSlot.Z] = entity.z; this.pose[slot + PoseSlot.YAW] = entity.yaw; this.pose[slot + PoseSlot.SPEED] = entity.speed
      this.pose[slot + PoseSlot.ANIM_STATE] = entity.animation; this.pose[slot + PoseSlot.ANIM_PHASE] = entity.animationPhase
      this.pose[slot + PoseSlot.FLAGS] =
        (entity.emergency ? PoseFlags.EMERGENCY : 0) |
        (entity.rmfControlled ? PoseFlags.RMF_CONTROLLED : 0) |
        (entity.taskId ? PoseFlags.HAS_TASK : 0) |
        (entity.activity === 'safeStop' || entity.status === 'error' ? PoseFlags.SAFE_STOP : 0) |
        (measuredHandPose ? PoseFlags.MEASURED_HAND_POSE : 0) |
        (entity.evacuationGuiding && !entity.taskId && entity.activity !== 'manipulating' && entity.status !== 'error' ? PoseFlags.EVACUATION_GUIDE : 0) |
        (entity.mission === 'medical-transport' ? PoseFlags.MEDICAL_TRANSPORT : 0)
      this.pose[slot + PoseSlot.AUX_A] = entity.auxA; this.pose[slot + PoseSlot.AUX_B] = entity.auxB
      this.pose[slot + PoseSlot.LEFT_HAND_X] = entity.measuredLeftHandPosition?.[0] ?? 0
      this.pose[slot + PoseSlot.LEFT_HAND_Y] = entity.measuredLeftHandPosition?.[1] ?? 0
      this.pose[slot + PoseSlot.LEFT_HAND_Z] = entity.measuredLeftHandPosition?.[2] ?? 0
      this.pose[slot + PoseSlot.RIGHT_HAND_X] = entity.measuredRightHandPosition?.[0] ?? 0
      this.pose[slot + PoseSlot.RIGHT_HAND_Y] = entity.measuredRightHandPosition?.[1] ?? 0
      this.pose[slot + PoseSlot.RIGHT_HAND_Z] = entity.measuredRightHandPosition?.[2] ?? 0
    })
    this.frontBuffer = back
    if (this.poseHeader) { Atomics.store(this.poseHeader, PoseHeader.ENTITY_COUNT, this.entities.length); Atomics.store(this.poseHeader, PoseHeader.SIM_TIME_MS, Math.round(this.simTime * 1000)); Atomics.store(this.poseHeader, PoseHeader.FRONT_BUFFER, this.frontBuffer); Atomics.add(this.poseHeader, PoseHeader.GENERATION, 1) }
    else this.fallbackGeneration++
  }
}

function pathDistance(graph: DerivedLayout['walkGraph'], path: number[]): number {
  let distance = 0
  for (let index = 1; index < path.length; index++) {
    const from = graph.nodes[path[index - 1]!]!
    const to = graph.nodes[path[index]!]!
    distance += Math.hypot(to.x - from.x, to.z - from.z)
  }
  return distance
}

function claimMusterSlot(
  world: SimWorld,
  person: SimEntity,
  musterId: string,
  capacity: number,
  musterX: number,
  musterZ: number,
  nearest = false,
  avoidIndices: readonly number[] = []
): number {
  const occupied = new Set(world.entities
    .filter((entity) => entity !== person && entity.evacuationMusterId === musterId && entity.evacuationSlotIndex !== undefined)
    .map((entity) => entity.evacuationSlotIndex!))
  const fixedRobotBodies = world.entities.filter((entity) => entity !== person && isStationaryGroundRobot(entity))
  const slots = musterSlots(capacity, musterZ)
  const outward = musterZ < 0 ? -1 : 1
  const available = slots
    .map((slot, index) => {
      const slotX = musterX + slot[0]
      const slotZ = musterZ + slot[1]
      const approachX = person.x + (slotX - person.x) * 0.25
      const approachZ = person.z + (slotZ - person.z) * 0.25
      const endpointRobotMargin = fixedRobotBodies.length === 0
        ? Infinity
        : Math.min(...fixedRobotBodies.map((robot) =>
            Math.hypot(slotX - robot.x, slotZ - robot.z) - groundBodyRadius(person) - groundBodyRadius(robot)
          ))
      const robotMargin = fixedRobotBodies.length === 0
        ? Infinity
        : Math.min(...fixedRobotBodies.map((robot) =>
            Math.min(
              Math.hypot(slotX - robot.x, slotZ - robot.z),
              pointToSegmentDistance(robot.x, robot.z, approachX, approachZ, slotX, slotZ)
            ) - groundBodyRadius(person) - groundBodyRadius(robot)
          ))
      return {
        index,
        score: nearest
          ? Math.hypot(slotX - person.x, slotZ - person.z) + Math.max(0, 1.2 - robotMargin) * 12
          : -(slot[1] * outward) * 100 + Math.abs(slotX - person.x) +
            Math.max(0, 0.72 - endpointRobotMargin) * 1_000
      }
    })
    .filter(({ index }) => {
      if (occupied.has(index)) return false
      const slot = slots[index]!
      return fixedRobotBodies.every((robot) =>
        Math.hypot(musterX + slot[0] - robot.x, musterZ + slot[1] - robot.z) >=
          groundBodyRadius(person) + groundBodyRadius(robot) + 0.42
      )
    })
    .sort((left, right) => left.score - right.score || left.index - right.index)
  const alternatives = available.filter(({ index }) => !avoidIndices.includes(index))
  return alternatives[0]?.index ?? available[0]?.index ?? person.index % slots.length
}

function pointToSegmentDistance(
  pointX: number,
  pointZ: number,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number
): number {
  const deltaX = toX - fromX
  const deltaZ = toZ - fromZ
  const lengthSquared = deltaX ** 2 + deltaZ ** 2
  const projection = lengthSquared < 0.000_001
    ? 0
    : Math.max(0, Math.min(1, ((pointX - fromX) * deltaX + (pointZ - fromZ) * deltaZ) / lengthSquared))
  return Math.hypot(pointX - (fromX + deltaX * projection), pointZ - (fromZ + deltaZ * projection))
}

function musterSlot(index: number, capacity: number, musterZ: number): readonly [number, number] {
  const points = musterSlots(capacity, musterZ)
  return points[index % points.length] ?? [0, 0]
}

function musterSlots(capacity: number, musterZ: number): Array<readonly [number, number]> {
  const radius = 4.5
  const spacing = 0.75
  const extent = Math.ceil(radius / spacing) + 1
  const points: Array<readonly [number, number]> = []
  const outward = musterZ < 0 ? -1 : 1
  for (let row = -extent; row <= extent; row++) {
    for (let column = -extent; column <= extent; column++) {
      const x = spacing * (column + row / 2)
      const z = spacing * Math.sqrt(3) / 2 * row
      if (Math.hypot(x, z) <= radius && z * outward >= -0.001) points.push([x, z])
    }
  }
  points.sort((left, right) =>
    right[1] * outward - left[1] * outward ||
    Math.abs(left[0]) - Math.abs(right[0]) ||
    left[0] - right[0]
  )
  return points.slice(0, Math.max(1, capacity))
}
