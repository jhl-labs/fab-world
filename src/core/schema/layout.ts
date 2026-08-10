import { z } from 'zod'

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])
export const Vec2Schema = z.tuple([z.number(), z.number()])

export const ProcessBandSchema = z.enum(['photo', 'etch', 'deposition', 'implant', 'cmp'])
export const BayVariantSchema = z.enum(['standard', 'superbay', 'buffer', 'metrology', 'service-heavy'])
export const EquipmentTypeSchema = z.enum([
  'lithography', 'etcher', 'cvd', 'pvd', 'cmp', 'implanter', 'cleaner', 'furnace', 'metrology', 'stocker'
])
export const RailKindSchema = z.enum(['trunk', 'spine', 'cross', 'bay-port', 'stocker'])
export const ZoneKindSchema = z.enum(['bay-interior', 'corridor', 'transfer-aisle', 'stocker-area', 'exit-zone'])
export const PersonRoleSchema = z.enum(['engineer', 'operator', 'responder'])

export const LoadportSchema = z.object({
  id: z.string().min(1),
  offset: Vec3Schema
})

export const EquipmentSchema = z.object({
  id: z.string().min(1),
  type: EquipmentTypeSchema,
  position: Vec3Schema,
  rotation: z.number(),
  hazardCapable: z.boolean().default(false),
  loadports: z.array(LoadportSchema).min(1).max(2)
})

export const BaySchema = z.object({
  id: z.string().min(1),
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  processBand: ProcessBandSchema,
  variant: BayVariantSchema,
  equipment: z.array(EquipmentSchema).min(1)
})

export const FabLayoutSchema = z.object({
  version: z.string(),
  name: z.string().min(1),
  fab: z.object({
    width: z.number().positive(), depth: z.number().positive(), wallHeight: z.number().positive(), ceilingHeight: z.number().positive()
  }),
  grid: z.object({
    rows: z.number().int().positive(), cols: z.number().int().positive(),
    columnWidths: z.array(z.number().positive()), rowDepths: z.array(z.number().positive()), aisleWidth: z.number().positive()
  }),
  bays: z.array(BaySchema),
  stockers: z.array(z.object({ id: z.string(), position: Vec3Schema, capacity: z.number().int().positive() })),
  ohtRail: z.object({
    height: z.number().positive(),
    segments: z.array(z.object({ id: z.string(), kind: RailKindSchema, from: Vec3Schema, to: Vec3Schema }))
  }),
  zones: z.array(z.object({ id: z.string(), kind: ZoneKindSchema, polygon: z.array(Vec2Schema).min(3) })),
  emergency: z.object({
    exits: z.array(z.object({ id: z.string(), position: Vec3Schema, heading: z.number() })).min(1),
    musterPoints: z.array(z.object({ id: z.string(), position: Vec3Schema, capacity: z.number().int().positive() })).min(1),
    medicalStation: z.object({ position: Vec3Schema }),
    fireAccessRoutes: z.array(z.object({ id: z.string(), nodes: z.array(Vec2Schema).min(2) })),
    safetyDevices: z.array(z.object({
      id: z.string(),
      kind: z.enum(['gas-isolation-valve', 'emergency-stop', 'fire-panel']),
      position: Vec3Schema,
      heading: z.number(),
      servesZone: z.string()
    })).default([])
  }),
  population: z.object({
    oht: z.number().int().nonnegative(), agv: z.number().int().nonnegative(), igv: z.number().int().nonnegative(), humanoid: z.number().int().nonnegative().default(2), arm: z.number().int().nonnegative(),
    humanoidStations: z.array(Vec3Schema).default([]),
    responderStations: z.array(Vec3Schema).default([]),
    people: z.array(z.object({ role: PersonRoleSchema, count: z.number().int().nonnegative() }))
  })
}).superRefine((layout, ctx) => {
  if (layout.grid.columnWidths.length !== layout.grid.cols) ctx.addIssue({ code: 'custom', path: ['grid', 'columnWidths'], message: '열 너비 수가 cols와 일치해야 합니다.' })
  if (layout.grid.rowDepths.length !== layout.grid.rows) ctx.addIssue({ code: 'custom', path: ['grid', 'rowDepths'], message: '행 깊이 수가 rows와 일치해야 합니다.' })
  if (layout.bays.length !== layout.grid.rows * layout.grid.cols) ctx.addIssue({ code: 'custom', path: ['bays'], message: '모든 grid bay가 필요합니다.' })
  const ids = new Set<string>()
  for (const bay of layout.bays) {
    if (bay.row >= layout.grid.rows || bay.col >= layout.grid.cols) ctx.addIssue({ code: 'custom', path: ['bays'], message: `${bay.id}: grid 범위 밖 bay입니다.` })
    for (const equipment of bay.equipment) {
      if (ids.has(equipment.id)) ctx.addIssue({ code: 'custom', path: ['bays'], message: `중복 설비 id: ${equipment.id}` })
      ids.add(equipment.id)
    }
  }
})

export type FabLayout = z.infer<typeof FabLayoutSchema>
export type ProcessBand = z.infer<typeof ProcessBandSchema>
export type EquipmentType = z.infer<typeof EquipmentTypeSchema>
export type PersonRole = z.infer<typeof PersonRoleSchema>
export type ZoneKind = z.infer<typeof ZoneKindSchema>
