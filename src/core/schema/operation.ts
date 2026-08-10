import { z } from 'zod'
import {
  HUMANOID_LOWER_ARM_LENGTH,
  HUMANOID_SHOULDER_HEIGHT,
  HUMANOID_SHOULDER_LATERAL,
  HUMANOID_UPPER_ARM_LENGTH,
  gasValveGripResidual
} from '../interactionGeometry'

export const HumanoidTaskKindSchema = z.enum([
  'inspection_round',
  'gas_isolation',
  'medical_support'
])

export const HumanoidTaskStatusSchema = z.enum([
  'queued',
  'assigned',
  'navigating',
  'observing',
  'interacting',
  'reporting',
  'returning',
  'completed',
  'failed',
  'cancelled'
])

export const HumanoidActivitySchema = z.enum([
  'standby',
  'walking',
  'yielding',
  'observing',
  'manipulating',
  'reporting',
  'safeStop'
])

export const HumanoidTaskRequestSchema = z.object({
  id: z.string().min(1),
  kind: HumanoidTaskKindSchema,
  targetId: z.string().min(1).optional(),
  target: z.tuple([z.number(), z.number()]).optional(),
  targetMap: z.string().min(1).optional(),
  targetYaw: z.number().finite().optional(),
  requestedBy: z.enum(['rmf', 'showcase', 'operator']).default('operator'),
  priority: z.number().int().min(0).max(100).default(50)
})

export const RmfRobotStateEventSchema = z.object({
  type: z.literal('robot_state'),
  fleet: z.string().min(1),
  robot: z.string().min(1),
  map: z.string().min(1),
  x: z.number(),
  y: z.number(),
  yaw: z.number(),
  battery: z.number().min(0).max(100),
  mode: z.enum(['idle', 'moving', 'charging', 'waiting', 'emergency', 'offline']),
  taskId: z.string().optional(),
  timestamp: z.number()
})

export const RmfTaskStateEventSchema = z.object({
  type: z.literal('task_state'),
  taskId: z.string().min(1),
  category: HumanoidTaskKindSchema,
  status: HumanoidTaskStatusSchema,
  assignedRobot: z.string().optional(),
  targetId: z.string().optional(),
  interactionKind: z.enum([
    'inspection_anomaly_reported',
    'medical_handoff',
    'gas_isolation_verified'
  ]).optional(),
  snapshot: z.literal(true).optional(),
  timestamp: z.number()
}).superRefine((event, ctx) => {
  const expected = event.interactionKind === 'inspection_anomaly_reported'
    ? { category: 'inspection_round', status: 'reporting' }
    : event.interactionKind === 'medical_handoff'
      ? { category: 'medical_support', status: 'interacting' }
      : event.interactionKind === 'gas_isolation_verified'
        ? { category: 'gas_isolation', status: 'interacting' }
        : undefined
  if (expected && (event.category !== expected.category || event.status !== expected.status)) {
    ctx.addIssue({
      code: 'custom',
      path: ['interactionKind'],
      message: `${event.interactionKind} requires ${expected.category}/${expected.status}`
    })
  }
})

export const RmfWorkPermitEventSchema = z.object({
  type: z.literal('work_permit'),
  taskId: z.string().min(1),
  authorized: z.boolean(),
  authorizedBy: z.string().min(1).max(128),
  clearance: z.number().min(2.2).max(3.4).optional(),
  personId: z.string().min(1).max(128).optional(),
  reason: z.string().min(1).max(500).optional(),
  snapshot: z.literal(true).optional(),
  timestamp: z.number().int().nonnegative()
}).superRefine((permit, ctx) => {
  if (permit.authorized && permit.clearance === undefined) {
    ctx.addIssue({ code: 'custom', path: ['clearance'], message: 'authorized work permit requires clearance' })
  }
  if (!permit.authorized && permit.clearance !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['clearance'], message: 'revoked work permit cannot include clearance' })
  }
})

export const GasActionTelemetryPhaseSchema = z.enum([
  'approach',
  'contact',
  'turning',
  'monitoring',
  'verified'
])

const RobotLocalPointSchema = z.tuple([
  z.number().finite().min(-2).max(2),
  z.number().finite().min(-2).max(2),
  z.number().finite().min(-2).max(2)
])

/**
 * Renderer-neutral end-effector evidence. A robot-specific executor converts
 * its joint/link state into metres in base_link before crossing the Bridge.
 */
export const HumanoidHandPoseSchema = z.object({
  frame: z.literal('base_link'),
  leftPositionM: RobotLocalPointSchema,
  rightPositionM: RobotLocalPointSchema
}).superRefine((pose, ctx) => {
  const maximumReach = HUMANOID_UPPER_ARM_LENGTH + HUMANOID_LOWER_ARM_LENGTH + 0.03
  const hands = [
    ['leftPositionM', pose.leftPositionM, -HUMANOID_SHOULDER_LATERAL],
    ['rightPositionM', pose.rightPositionM, HUMANOID_SHOULDER_LATERAL]
  ] as const
  for (const [field, position, shoulderZ] of hands) {
    const reach = Math.hypot(
      position[0],
      position[1] - HUMANOID_SHOULDER_HEIGHT,
      position[2] - shoulderZ
    )
    if (reach > maximumReach) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} exceeds the normalized humanoid arm workspace`
      })
    }
  }
})

export const RmfActionTelemetryEventSchema = z.object({
  type: z.literal('action_telemetry'),
  taskId: z.string().min(1),
  category: z.literal('gas_isolation'),
  robot: z.string().min(1).optional(),
  phase: GasActionTelemetryPhaseSchema,
  progress: z.number().finite().min(0).max(1),
  leftHandContact: z.boolean(),
  rightHandContact: z.boolean(),
  valvePosition: z.number().finite().min(0).max(1),
  gasPpm: z.number().finite().nonnegative().optional(),
  sensorStable: z.boolean(),
  handPose: HumanoidHandPoseSchema.optional(),
  snapshot: z.literal(true).optional(),
  timestamp: z.number().int().nonnegative()
}).superRefine((telemetry, ctx) => {
  const physicalContact = telemetry.leftHandContact && telemetry.rightHandContact
  if (['contact', 'turning'].includes(telemetry.phase) && !physicalContact) {
    ctx.addIssue({
      code: 'custom',
      path: ['leftHandContact'],
      message: `${telemetry.phase} requires both hand contacts`
    })
  }
  if (telemetry.phase === 'turning' && telemetry.valvePosition <= 0) {
    ctx.addIssue({ code: 'custom', path: ['valvePosition'], message: 'turning requires positive valvePosition' })
  }
  if (['monitoring', 'verified'].includes(telemetry.phase)) {
    if (telemetry.valvePosition !== 1) {
      ctx.addIssue({ code: 'custom', path: ['valvePosition'], message: `${telemetry.phase} requires a closed valve` })
    }
    if (telemetry.gasPpm === undefined) {
      ctx.addIssue({ code: 'custom', path: ['gasPpm'], message: `${telemetry.phase} requires gasPpm` })
    }
  }
  if (telemetry.phase === 'verified' && (!telemetry.sensorStable || telemetry.progress !== 1)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sensorStable'],
      message: 'verified requires progress 1 and a stable sensor'
    })
  }
  if (telemetry.handPose && physicalContact) {
    const measuredHands = [
      ['leftPositionM', telemetry.handPose.leftPositionM, -1],
      ['rightPositionM', telemetry.handPose.rightPositionM, 1]
    ] as const
    for (const [field, position, side] of measuredHands) {
      const residual = gasValveGripResidual(position)
      if (
        residual.frontSurface > 0.08 ||
        residual.ringCenterline > 0.08 ||
        position[2] * side <= 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['handPose', field],
          message: `${field} does not support the reported valve contact`
        })
      }
    }
  }
})

export const RmfEmergencyEventSchema = z.object({
  type: z.literal('emergency'),
  active: z.boolean(),
  kind: z.enum(['gasLeak', 'fire', 'medical']).optional(),
  snapshot: z.literal(true).optional(),
  timestamp: z.number()
})

export const RmfBridgeEventSchema = z.discriminatedUnion('type', [
  RmfRobotStateEventSchema,
  RmfTaskStateEventSchema,
  RmfWorkPermitEventSchema,
  RmfActionTelemetryEventSchema,
  RmfEmergencyEventSchema
])

export const RmfTraceEventSchema = z.object({
  atMs: z.number().int().nonnegative(),
  event: RmfBridgeEventSchema
})

export const RmfTaskTraceSchema = z.object({
  category: HumanoidTaskKindSchema,
  sourceTaskId: z.string().min(1),
  events: z.array(RmfTraceEventSchema).min(1)
}).superRefine((trace, ctx) => {
  let previous = -1
  let hasTaskState = false
  trace.events.forEach((entry, index) => {
    if (entry.atMs < previous) {
      ctx.addIssue({ code: 'custom', path: ['events', index, 'atMs'], message: 'trace events must be ordered by atMs' })
    }
    previous = entry.atMs
    if (entry.event.type === 'task_state') hasTaskState = true
    if (
      (
        entry.event.type === 'task_state' ||
        entry.event.type === 'work_permit' ||
        entry.event.type === 'action_telemetry'
      ) &&
      entry.event.taskId !== trace.sourceTaskId
    ) {
      ctx.addIssue({ code: 'custom', path: ['events', index, 'event', 'taskId'], message: 'task event must use sourceTaskId' })
    }
    if (entry.event.type === 'task_state') {
      if (entry.event.category !== trace.category) {
        ctx.addIssue({ code: 'custom', path: ['events', index, 'event', 'category'], message: 'task event category must match trace category' })
      }
    }
  })
  if (!hasTaskState) ctx.addIssue({ code: 'custom', path: ['events'], message: 'task trace requires at least one task_state event' })
})

export const RmfTraceSchema = z.object({
  version: z.literal('1.0'),
  name: z.string().min(1),
  source: z.enum(['reference', 'recorded']),
  recordedAt: z.string().optional(),
  fleet: z.string().min(1),
  map: z.string().min(1),
  tasks: z.array(RmfTaskTraceSchema).min(1)
}).superRefine((trace, ctx) => {
  const categories = new Set<string>()
  trace.tasks.forEach((task, index) => {
    if (categories.has(task.category)) {
      ctx.addIssue({ code: 'custom', path: ['tasks', index, 'category'], message: 'trace categories must be unique' })
    }
    categories.add(task.category)
  })
})

export const RmfBridgeStatusSchema = z.object({
  type: z.literal('bridge_status'),
  status: z.enum(['ready', 'degraded', 'offline']),
  fleet: z.string().min(1),
  robotsSeen: z.number().int().nonnegative(),
  robotsPublished: z.number().int().nonnegative(),
  robotsWithoutLocation: z.number().int().nonnegative(),
  unknownMaps: z.array(z.string()),
  pollLatencyMs: z.number().int().nonnegative(),
  maxPoseAgeMs: z.number().int().nonnegative().optional(),
  actionStageLatencyMs: z.number().int().nonnegative().optional(),
  actionTelemetryLatencyMs: z.number().int().nonnegative().optional(),
  detail: z.string(),
  timestamp: z.number().int()
})

export type HumanoidTaskKind = z.infer<typeof HumanoidTaskKindSchema>
export type HumanoidTaskStatus = z.infer<typeof HumanoidTaskStatusSchema>
export type HumanoidActivity = z.infer<typeof HumanoidActivitySchema>
export type GasActionTelemetryPhase = z.infer<typeof GasActionTelemetryPhaseSchema>
export type HumanoidHandPose = z.infer<typeof HumanoidHandPoseSchema>
export type HumanoidTaskRequest = z.infer<typeof HumanoidTaskRequestSchema>
export type RmfBridgeEvent = z.infer<typeof RmfBridgeEventSchema>
export type RmfBridgeStatus = z.infer<typeof RmfBridgeStatusSchema>
export type RmfTrace = z.infer<typeof RmfTraceSchema>
export type RmfTaskTrace = z.infer<typeof RmfTaskTraceSchema>
