import { z } from 'zod'
import {
  GasActionTelemetryPhaseSchema,
  HumanoidTaskKindSchema,
  RmfActionTelemetryEventSchema
} from '../../src/core/schema'

const FabTargetPoseSchema = z.object({
  map: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  yaw: z.number().finite().optional()
})

export const BrowserBridgeCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    channels: z.array(z.enum(['robot_states', 'task_states', 'work_permits', 'action_telemetry', 'emergency'])).max(5)
  }),
  z.object({
    type: z.literal('dispatch_task'),
    request: z.object({
      category: z.literal('perform_action'),
      description: z.object({
        category: HumanoidTaskKindSchema,
        target_id: z.string().min(1).optional(),
        target_pose: FabTargetPoseSchema.optional(),
        fabworld_task_id: z.string().min(1)
      }),
      priority: z.number().int().min(0).max(100)
    })
  }),
  z.object({
    type: z.literal('cancel_task'),
    task_id: z.string().min(1)
  })
])

export const RmfLocationSchema = z.object({
  map: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  yaw: z.number().finite()
})

export const RmfRobotStateSchema = z.object({
  name: z.string().optional(),
  status: z.enum(['uninitialized', 'offline', 'shutdown', 'idle', 'charging', 'working', 'error']).optional(),
  task_id: z.string().optional(),
  unix_millis_time: z.number().int().optional(),
  location: RmfLocationSchema.optional(),
  battery: z.number().min(0).max(1).optional()
}).passthrough()

export const RmfFleetStateSchema = z.object({
  name: z.string().optional(),
  robots: z.record(z.string(), RmfRobotStateSchema).optional()
})

export const RmfTaskStateSchema = z.object({
  booking: z.object({
    id: z.string().min(1),
    unix_millis_request_time: z.number().int().optional()
  }).passthrough(),
  category: z.string().optional(),
  detail: z.unknown().optional(),
  assigned_to: z.object({ group: z.string(), name: z.string() }).optional(),
  status: z.enum([
    'uninitialized', 'blocked', 'error', 'failed', 'queued', 'standby', 'underway',
    'delayed', 'skipped', 'canceled', 'killed', 'completed'
  ]).optional(),
  active: z.union([z.number().int(), z.string()]).optional(),
  phases: z.record(z.string(), z.unknown()).optional(),
  unix_millis_start_time: z.number().int().optional(),
  unix_millis_finish_time: z.number().int().optional()
}).passthrough()

export const RmfDispatchResponseSchema = z.union([
  z.object({ success: z.literal(true), state: RmfTaskStateSchema }),
  z.object({ success: z.literal(false).optional(), errors: z.array(z.unknown()).optional() })
])

export const RmfFireAlarmSchema = z.object({
  unix_millis_time: z.number().int(),
  trigger: z.boolean()
})

export const ActionStageIngestSchema = z.object({
  fabworld_task_id: z.string().min(1).optional(),
  rmf_task_id: z.string().min(1).optional(),
  stage: z.enum(['assigned', 'navigating', 'observing', 'interacting', 'reporting', 'returning', 'completed', 'failed', 'cancelled']),
  interaction_kind: z.enum([
    'inspection_anomaly_reported',
    'medical_handoff',
    'gas_isolation_verified'
  ]).optional(),
  robot: z.string().min(1).optional(),
  timestamp: z.number().int().optional()
}).refine((value) => value.fabworld_task_id !== undefined || value.rmf_task_id !== undefined, {
  message: 'fabworld_task_id or rmf_task_id is required'
}).refine((value) =>
  value.interaction_kind === undefined ||
  (
    value.interaction_kind === 'inspection_anomaly_reported'
      ? value.stage === 'reporting'
      : value.stage === 'interacting'
  ), {
  message: 'interaction_kind does not match the required action stage'
})

export const ActionTelemetryIngestSchema = z.object({
  fabworld_task_id: z.string().min(1).optional(),
  rmf_task_id: z.string().min(1).optional(),
  robot: z.string().min(1).optional(),
  phase: GasActionTelemetryPhaseSchema,
  progress: z.number().finite().min(0).max(1),
  left_hand_contact: z.boolean(),
  right_hand_contact: z.boolean(),
  valve_position: z.number().finite().min(0).max(1),
  gas_ppm: z.number().finite().nonnegative().optional(),
  sensor_stable: z.boolean(),
  hand_pose: z.object({
    frame_id: z.literal('base_link'),
    left_position_m: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    right_position_m: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
  }).optional(),
  timestamp: z.number().int().nonnegative()
}).superRefine((telemetry, ctx) => {
  if (telemetry.fabworld_task_id === undefined && telemetry.rmf_task_id === undefined) {
    ctx.addIssue({ code: 'custom', path: ['fabworld_task_id'], message: 'fabworld_task_id or rmf_task_id is required' })
  }
  const normalized = RmfActionTelemetryEventSchema.safeParse({
    type: 'action_telemetry',
    taskId: telemetry.fabworld_task_id ?? telemetry.rmf_task_id ?? 'ingest-validation',
    category: 'gas_isolation',
    ...(telemetry.robot ? { robot: telemetry.robot } : {}),
    phase: telemetry.phase,
    progress: telemetry.progress,
    leftHandContact: telemetry.left_hand_contact,
    rightHandContact: telemetry.right_hand_contact,
    valvePosition: telemetry.valve_position,
    ...(telemetry.gas_ppm !== undefined ? { gasPpm: telemetry.gas_ppm } : {}),
    sensorStable: telemetry.sensor_stable,
    ...(telemetry.hand_pose ? {
      handPose: {
        frame: telemetry.hand_pose.frame_id,
        leftPositionM: telemetry.hand_pose.left_position_m,
        rightPositionM: telemetry.hand_pose.right_position_m
      }
    } : {}),
    timestamp: telemetry.timestamp
  })
  if (!normalized.success) {
    const fields: Record<string, string> = {
      leftHandContact: 'left_hand_contact',
      rightHandContact: 'right_hand_contact',
      valvePosition: 'valve_position',
      gasPpm: 'gas_ppm',
      sensorStable: 'sensor_stable',
      handPose: 'hand_pose'
    }
    for (const issue of normalized.error.issues) {
      const [head, ...tail] = issue.path
      ctx.addIssue({
        code: 'custom',
        path: [typeof head === 'string' ? fields[head] ?? head : head, ...tail],
        message: issue.message
      })
    }
  }
})

export const EmergencyIngestSchema = z.object({
  active: z.boolean(),
  kind: z.enum(['gasLeak', 'fire', 'medical']).optional(),
  timestamp: z.number().int().optional()
}).refine((value) => !value.active || value.kind !== undefined, {
  message: 'kind is required for an active emergency'
})

export const WorkPermitIngestSchema = z.object({
  fabworld_task_id: z.string().min(1).optional(),
  rmf_task_id: z.string().min(1).optional(),
  authorized: z.boolean(),
  authorized_by: z.string().min(1).max(128),
  clearance_m: z.number().min(2.2).max(3.4).optional(),
  person_id: z.string().min(1).max(128).optional(),
  reason: z.string().min(1).max(500).optional(),
  timestamp: z.number().int().nonnegative().optional()
}).superRefine((permit, ctx) => {
  if (permit.fabworld_task_id === undefined && permit.rmf_task_id === undefined) {
    ctx.addIssue({ code: 'custom', path: ['fabworld_task_id'], message: 'fabworld_task_id or rmf_task_id is required' })
  }
  if (permit.authorized && permit.clearance_m === undefined) {
    ctx.addIssue({ code: 'custom', path: ['clearance_m'], message: 'authorized work permit requires clearance_m' })
  }
  if (!permit.authorized && permit.clearance_m !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['clearance_m'], message: 'revoked work permit cannot include clearance_m' })
  }
})

export type BrowserBridgeCommand = z.infer<typeof BrowserBridgeCommandSchema>
export type DispatchBrowserCommand = Extract<BrowserBridgeCommand, { type: 'dispatch_task' }>
export type RmfFleetState = z.infer<typeof RmfFleetStateSchema>
export type RmfRobotState = z.infer<typeof RmfRobotStateSchema>
export type RmfTaskState = z.infer<typeof RmfTaskStateSchema>
export type RmfDispatchResponse = z.infer<typeof RmfDispatchResponseSchema>
