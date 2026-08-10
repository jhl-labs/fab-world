import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { FabLayoutSchema } from '../src/core/schema'
import { FIXED_DT } from '../src/sim/clock'
import { SimWorld } from '../src/sim/world'

const layout = FabLayoutSchema.parse(JSON.parse(readFileSync(new URL('../data/layouts/fab-default.json', import.meta.url), 'utf8')))
const world = new SimWorld(layout, 20260730)

for (let tick = 0; tick < 120; tick++) world.tick(FIXED_DT)

const samples: number[] = []
for (let tick = 0; tick < 1_800; tick++) {
  const started = performance.now()
  world.tick(FIXED_DT)
  samples.push(performance.now() - started)
}

samples.sort((a, b) => a - b)
const averageMs = samples.reduce((sum, sample) => sum + sample, 0) / samples.length
const p95Ms = samples[Math.floor(samples.length * 0.95)]!
const maximumMs = samples.at(-1)!
const result = {
  entities: world.entities.length,
  ticks: samples.length,
  averageMs: Number(averageMs.toFixed(3)),
  p95Ms: Number(p95Ms.toFixed(3)),
  maximumMs: Number(maximumMs.toFixed(3))
}

console.log(JSON.stringify(result, null, 2))
if (p95Ms >= 8) throw new Error(`Simulation p95 ${p95Ms.toFixed(3)}ms exceeds the documented 8ms budget`)
