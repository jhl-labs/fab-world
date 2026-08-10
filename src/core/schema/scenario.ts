import { z } from 'zod'

export const EmergencyPhaseSchema = z.enum(['normal', 'detected', 'alarm', 'response', 'evacuation', 'allClear'])
export const EmergencyKindSchema = z.enum(['gasLeak', 'fire', 'medical', 'custom'])
export const EmergencyBehaviorSchema = z.enum(['normal', 'halt', 'yield', 'evacuate', 'respond', 'shelter'])

const TriggerBaseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('time'), delay: z.number().nonnegative() }),
  z.object({ type: z.literal('phase'), phase: EmergencyPhaseSchema }),
  z.object({ type: z.literal('entityAt'), selector: z.string(), zone: z.string() }),
  z.object({ type: z.literal('entityState'), selector: z.string(), state: z.string() }),
  z.object({ type: z.literal('populationAt'), zone: z.string(), ratio: z.number().min(0).max(1) })
])
export type ScenarioTrigger = z.infer<typeof TriggerBaseSchema> | { type: 'all' | 'any'; conditions: ScenarioTrigger[] }
export const ScenarioTriggerSchema: z.ZodType<ScenarioTrigger> = z.lazy(() => z.union([
  TriggerBaseSchema,
  z.object({ type: z.literal('all'), conditions: z.array(ScenarioTriggerSchema).min(1) }),
  z.object({ type: z.literal('any'), conditions: z.array(ScenarioTriggerSchema).min(1) })
]))

export const ScenarioActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setPhase'), phase: EmergencyPhaseSchema }),
  z.object({ type: z.literal('spawnHazard'), kind: EmergencyKindSchema, at: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal('overrideBehavior'), selector: z.string(), behavior: EmergencyBehaviorSchema }),
  z.object({ type: z.literal('dispatchResponder'), count: z.number().int().positive(), to: z.string() }),
  z.object({ type: z.literal('dispatchVehicle'), vehicleType: z.enum(['agv', 'igv', 'oht']), mission: z.string() }),
  z.object({ type: z.literal('cameraCue'), shot: z.string() }),
  z.object({ type: z.literal('hudMessage'), text: z.string(), severity: z.enum(['info', 'warning', 'danger']) }),
  z.object({ type: z.literal('wait'), duration: z.number().nonnegative() }),
  z.object({ type: z.literal('endScenario') })
])

const ScenarioParamsSchema = z.union([
  z.object({ sourceEquipmentId: z.string().optional(), spreadRate: z.number().positive().default(0.4), maxRadius: z.number().positive().default(30), responderFixDuration: z.number().positive().default(60) }),
  z.object({ sourceEquipmentId: z.string().optional(), spreadRate: z.number().positive().optional(), maxRadius: z.number().positive().optional(), responderFixDuration: z.number().positive().optional() }).passthrough()
])

export const ScenarioSchema = z.object({
  version: z.string(), id: z.string(), name: z.string(), kind: EmergencyKindSchema, seed: z.number().int(), params: ScenarioParamsSchema,
  steps: z.array(z.object({ trigger: ScenarioTriggerSchema, actions: z.array(ScenarioActionSchema).min(1) })),
  cameraCues: z.array(z.object({ on: z.object({ phase: EmergencyPhaseSchema }), shot: z.string(), target: z.string(), duration: z.number().positive() }))
})

export type Scenario = z.infer<typeof ScenarioSchema>
export type EmergencyPhase = z.infer<typeof EmergencyPhaseSchema>
export type EmergencyKind = z.infer<typeof EmergencyKindSchema>
export type EmergencyBehavior = z.infer<typeof EmergencyBehaviorSchema>
export type ScenarioAction = z.infer<typeof ScenarioActionSchema>
