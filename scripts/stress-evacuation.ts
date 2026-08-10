import { readFileSync } from 'node:fs'
import { FabLayoutSchema, type EmergencyKind } from '../src/core/schema'
import { FIXED_DT, SIM_HZ } from '../src/sim/clock'
import { SimWorld } from '../src/sim/world'

const layout = FabLayoutSchema.parse(JSON.parse(readFileSync(new URL('../data/layouts/fab-default.json', import.meta.url), 'utf8')))
const cases: Array<{ kind: Extract<EmergencyKind, 'fire' | 'gasLeak'>; seed: number }> = [
  ...[1, 19, 77, 999].map((seed) => ({ kind: 'fire' as const, seed })),
  ...[2, 42, 314, 1001].map((seed) => ({ kind: 'gasLeak' as const, seed }))
]

const results = cases.map(({ kind, seed }) => {
  const world = new SimWorld(layout, seed)
  world.triggerEmergency(kind)
  let evacuatedAt: number | undefined
  let normalAt: number | undefined
  for (let tick = 0; tick < 300 * SIM_HZ; tick++) {
    world.tick(FIXED_DT)
    if (evacuatedAt === undefined && world.metrics.evacuated === world.metrics.totalEvacuees) evacuatedAt = world.simTime
    if (world.emergency.phase === 'normal') {
      normalAt = world.simTime
      break
    }
  }
  if (evacuatedAt === undefined) throw new Error(`${kind} seed ${seed}: all evacuees did not muster within 300 sim seconds`)
  if (normalAt === undefined) throw new Error(`${kind} seed ${seed}: scenario did not return to normal within 300 sim seconds`)
  return {
    kind,
    seed,
    evacuatedAt: Number(evacuatedAt.toFixed(3)),
    normalAt: Number(normalAt.toFixed(3)),
    totalEvacuees: world.metrics.totalEvacuees
  }
})

console.log(JSON.stringify(results, null, 2))
