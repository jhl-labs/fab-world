import type { EmergencyKind, EmergencyPhase, FabLayout, HumanoidActivity, HumanoidTaskKind, HumanoidTaskRequest, HumanoidTaskStatus, RmfBridgeEvent, Scenario } from './schema'

export const MAX_ENTITIES = 1024
export const POSE_STRIDE = 16
export const POSE_BUFFER_COUNT = 2
export const POSE_FLOATS = MAX_ENTITIES * POSE_STRIDE * POSE_BUFFER_COUNT
export const POSE_HEADER_INTS = 4

export const PoseSlot = {
  X: 0,
  Y: 1,
  Z: 2,
  YAW: 3,
  SPEED: 4,
  ANIM_STATE: 5,
  ANIM_PHASE: 6,
  FLAGS: 7,
  AUX_A: 8,
  AUX_B: 9,
  LEFT_HAND_X: 10,
  LEFT_HAND_Y: 11,
  LEFT_HAND_Z: 12,
  RIGHT_HAND_X: 13,
  RIGHT_HAND_Y: 14,
  RIGHT_HAND_Z: 15
} as const
export const PoseHeader = { GENERATION: 0, ENTITY_COUNT: 1, FRONT_BUFFER: 2, SIM_TIME_MS: 3 } as const
export const PoseFlags = {
  EMERGENCY: 1,
  RMF_CONTROLLED: 2,
  HAS_TASK: 4,
  SAFE_STOP: 8,
  MEASURED_HAND_POSE: 16,
  EVACUATION_GUIDE: 32
} as const

export type EntityKind = 'oht' | 'agv' | 'igv' | 'humanoid' | 'person' | 'arm'
export interface EntityMeta {
  id: string
  index: number
  kind: EntityKind
  name: string
  role?: 'engineer' | 'operator' | 'responder'
  fleet?: string
  capabilities?: readonly HumanoidTaskKind[]
}
export interface SimEvent {
  type: 'phaseChanged' | 'log' | 'hudMessage' | 'missionDone' | 'taskStateChanged' | 'interaction'
  message?: string
  phase?: EmergencyPhase
  kind?: EmergencyKind
  taskId?: string
  taskKind?: HumanoidTaskKind
  taskStatus?: HumanoidTaskStatus
  robotId?: string
  personId?: string
  data?: Record<string, number | string>
}
export type RiskComparisonMode = 'human' | 'humanoid'
export type RiskComparisonStage =
  | 'inactive'
  | 'human-dispatch'
  | 'human-work'
  | 'transition'
  | 'humanoid-dispatch'
  | 'humanoid-work'
  | 'complete'
export interface RiskComparisonRunMetrics {
  mode: RiskComparisonMode
  sourceEquipmentId: string
  targetId: string
  humanEntries: number
  humanoidEntries: number
  humanWorkZoneSeconds: number
  isolationElapsed: number
  spotterClearance: number
  verified: boolean
}
export interface RiskComparisonMetrics {
  active: boolean
  stage: RiskComparisonStage
  currentMode?: RiskComparisonMode
  currentTargetId?: string
  currentHumanEntries: number
  currentHumanoidEntries: number
  currentHumanWorkZoneSeconds: number
  human?: RiskComparisonRunMetrics
  humanoid?: RiskComparisonRunMetrics
}
export interface SimMetrics {
  tickMs: number
  entityCount: number
  simTime: number
  phase: EmergencyPhase
  evacuated: number
  totalEvacuees: number
  emergencyElapsed: number
  hazardRadius: number
  haltedRobots: number
  activeTransportMissions: number
  completedProcesses: number
  heldEquipment: number
  activeHumanoids: number
  completedHumanoidTasks: number
  humanRobotClearances: number
  hazardousManualActionsDelegated: number
  gasSpotterClearance: number
  gasWorkZoneClear: boolean
  gasWorkZonePeople: number
  gasWorkZoneHumanEntries: number
  gasWorkZoneRobotEntries: number
  gasIsolationElapsed: number
  verifiedSafetyGates: number
  gasRmfAssigned: boolean
  gasWorkPermitAuthorized: boolean
  gasWorkPermitRevoked: boolean
  gasWorkPermitAuthority: string
  gasValveContactConfirmed: boolean
  gasValveClosed: boolean
  gasSensorMonitoring: boolean
  gasIsolationVerified: boolean
  gasActionTelemetryAvailable: boolean
  gasActionTelemetryFresh: boolean
  gasActionTelemetryPhase: string
  gasActionTelemetryProgress: number
  gasActionTelemetryValvePosition: number
  gasActionTelemetryGasPpm: number
  gasActionTelemetryHandPoseMeasured: boolean
  gasTaskFailed: boolean
  riskComparison: RiskComparisonMetrics
  humanoids: HumanoidOperationalState[]
}
export interface HumanoidOperationalState {
  id: string
  name: string
  battery: number
  status: 'idle' | 'moving' | 'working' | 'waiting' | 'charging' | 'error'
  activity: HumanoidActivity
  speed: number
  taskId?: string
  rmfControlled: boolean
  poseAgeMs?: number
}
export interface EquipmentStateView {
  id: string
  state: 'idle' | 'loading' | 'processing' | 'unloading' | 'held' | 'maintenance'
}

export type MainToWorker =
  | { type: 'init'; layout: FabLayout; seed: number; poseBuffer?: SharedArrayBuffer }
  | { type: 'setTimeScale'; value: number }
  | { type: 'step' }
  | { type: 'loadScenario'; scenario: Scenario }
  | { type: 'triggerEmergency'; kind: EmergencyKind }
  | { type: 'dispatchHumanoidTask'; request: HumanoidTaskRequest }
  | { type: 'injectHumanoidFailure' }
  | { type: 'startHumanoidShowcase' }
  | { type: 'startRiskComparison' }
  | { type: 'setRmfConnection'; external: boolean; connected: boolean }
  | { type: 'rmfEvent'; event: RmfBridgeEvent }
  | { type: 'reset' }

export type WorkerToMain =
  | { type: 'ready'; entities: EntityMeta[]; usingSharedBuffer: boolean }
  | { type: 'event'; events: SimEvent[] }
  | { type: 'metrics'; metrics: SimMetrics }
  | { type: 'equipment'; states: EquipmentStateView[] }
  | { type: 'pose'; buffer: ArrayBuffer; generation: number; entityCount: number; simTimeMs: number }
