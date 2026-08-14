import type {
  EmergencyBehavior,
  EmergencyKind,
  EmergencyPhase,
  GasActionTelemetryPhase,
  HumanoidActivity,
  HumanoidTaskKind,
  HumanoidTaskStatus,
  PersonRole
} from '../core/schema'
import type { EntityKind } from '../core/protocol'

export type AgentStatus = 'idle' | 'moving' | 'working' | 'waiting' | 'charging' | 'error'
export type PersonActivity =
  | 'patrol'
  | 'walkingToWork'
  | 'returningToStation'
  | 'inspecting'
  | 'idle'
  | 'reacting'
  | 'yieldingToRobot'
  | 'acknowledgingRobot'
  | 'evacuating'
  | 'mustered'
  | 'responding'
  | 'fireApproach'
  | 'fireSuppressing'
  | 'medicalApproach'
  | 'gasPerimeter'
  | 'gasSpotting'
  | 'manualGasOperator'
  | 'manualGasSpotter'
  | 'receivingKit'
  | 'treating'
  | 'collapsed'
export interface RmfPoseInterpolation {
  startX: number
  startZ: number
  startYaw: number
  targetX: number
  targetZ: number
  targetYaw: number
  elapsed: number
  duration: number
  lastTimestamp: number
  moving: boolean
  age: number
  stale: boolean
}
export interface SimEntity {
  id: string; index: number; kind: EntityKind; role?: PersonRole; name: string
  x: number; y: number; z: number; yaw: number; speed: number; maxSpeed: number; preferredSpeed: number
  emergencySpeed?: number
  alarmReactionDelay?: number
  trafficSpeedLimit: number; waitTicks: number
  status: AgentStatus; behavior: EmergencyBehavior; targetX: number; targetZ: number
  targetIndex: number; route: number[]; routeCursor: number; targetDelay: number; animation: number; animationPhase: number
  emergency: boolean; mission?: string
  evacuationGuiding?: boolean
  missionActivity?: 'enroute' | 'inspecting' | 'reporting' | 'complete'
  missionActivityStartedAt?: number
  activity?: HumanoidActivity
  personActivity?: PersonActivity
  carriedById?: string
  reactionStartedAt?: number
  reactionUntil?: number
  interactionUntil?: number
  nextActionAt?: number
  workTargetId?: string
  workReservationTaskId?: string
  gasSpotterTaskId?: string
  manualGasRole?: 'operator' | 'spotter'
  yieldForTaskId?: string
  yieldResumeGoalX?: number
  yieldResumeGoalZ?: number
  evacuationMusterId?: string
  evacuationSlotIndex?: number
  avoidanceObstacleId?: string
  avoidanceX?: number
  avoidanceZ?: number
  navigationBestDistance?: number
  navigationLastProgressAt?: number
  formationBestDistance?: number
  formationLastProgressAt?: number
  formationReassignments?: number
  formationAvoidedSlotIndices?: number[]
  taskId?: string
  goalX: number; goalZ: number; homeX: number; homeZ: number
  auxA: number; auxB: number; rmfControlled: boolean; battery: number
  measuredLeftHandPosition?: readonly [number, number, number]
  measuredRightHandPosition?: readonly [number, number, number]
  rmfPose?: RmfPoseInterpolation
}
export interface HazardState {
  kind: EmergencyKind; sourceX: number; sourceZ: number; radius: number; maxRadius: number; spreadRate: number; fixedAt?: number
}
export interface EmergencyState {
  phase: EmergencyPhase
  kind?: EmergencyKind
  startedAt: number
  phaseStartedAt?: number
  hazard?: HazardState
  hazardControlled?: boolean
  controlledBy?: 'humanoid_valve' | 'responder' | 'operator'
}
export interface MedicalResponseRuntime {
  victimId: string
  responderIds: string[]
  kitResponderId?: string
  kitRendezvousX?: number
  kitRendezvousZ?: number
  kitHandoffComplete?: boolean
  treatmentCameraEmitted?: boolean
  treatmentStartedAt?: number
  vehicleId?: string
  stage: 'dispatched' | 'treating' | 'transporting' | 'delivered'
  stageStartedAt: number
}
export type EquipmentOperatingState = 'idle' | 'loading' | 'processing' | 'unloading'
export interface EquipmentRuntime {
  id: string
  state: EquipmentOperatingState | 'held' | 'maintenance'
  resumeState?: EquipmentOperatingState
  holdReason?: EmergencyKind
  progress: number
  duration: number
}
export interface TransportMissionRuntime {
  id: string
  carrierId: string
  fromId: string
  toId: string
  fromX: number
  fromZ: number
  toX: number
  toZ: number
  state: 'queued' | 'assigned' | 'picking' | 'carrying' | 'dropping' | 'done' | 'aborted'
  assigneeId?: string
  createdAt: number
  stageStartedAt: number
}
export interface HumanoidTaskRuntime {
  id: string
  kind: HumanoidTaskKind
  status: HumanoidTaskStatus
  requestedBy: 'rmf' | 'showcase' | 'operator'
  priority: number
  robotId?: string
  targetId: string
  targetX: number
  targetZ: number
  targetYaw?: number
  createdAt: number
  stageStartedAt: number
  operatorYielded: boolean
  operatorClearanceConfirmed: boolean
  yieldingPersonId?: string
  inspectionAnomalyReported?: boolean
  medicalHandoffEmitted?: boolean
  medicalHandoffConfirmed?: boolean
  medicalRendezvousAcknowledged?: boolean
  gasValveContactConfirmed?: boolean
  gasValveActuationConfirmed?: boolean
  gasIsolationVerified?: boolean
  gasSpotterId?: string
  gasSpotterArrivedAt?: number
  gasSpotterAcknowledged?: boolean
  gasSpotterClearance?: number
  gasWorkPermitExternalAuthorized?: boolean
  gasWorkPermitAuthorizedBy?: string
  gasWorkPermitPersonId?: string
  gasWorkPermitClearance?: number
  gasWorkPermitClearanceCounted?: boolean
  gasWorkZoneBreachActive?: boolean
  gasSensorMonitoringEmitted?: boolean
  gasIsolationVerifiedAt?: number
  actionTelemetryPhase?: GasActionTelemetryPhase
  actionTelemetryProgress?: number
  actionTelemetryValvePosition?: number
  actionTelemetryGasPpm?: number
  actionTelemetrySensorStable?: boolean
  actionTelemetryLeftHandContact?: boolean
  actionTelemetryRightHandContact?: boolean
  actionTelemetryLeftHandPosition?: readonly [number, number, number]
  actionTelemetryRightHandPosition?: readonly [number, number, number]
  actionTelemetryLastTimestamp?: number
  actionTelemetryAge?: number
  actionTelemetryStale?: boolean
}
export interface RiskComparisonRuntime {
  mode: 'human' | 'humanoid'
  stage: 'dispatching' | 'permit-check' | 'approaching' | 'manipulating' | 'monitoring' | 'verified'
  sourceEquipmentId: string
  targetId: string
  targetX: number
  targetZ: number
  targetYaw: number
  startedAt: number
  stageStartedAt: number
  manipulationStartedAt?: number
  contactEmitted?: boolean
  valveClosedEmitted?: boolean
  operatorId?: string
  spotterId?: string
  humanWorkZoneSeconds: number
  spotterClearance: number
}
