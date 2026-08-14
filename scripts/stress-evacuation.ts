import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { FabLayoutSchema, type EmergencyKind } from '../src/core/schema'
import { FIXED_DT, SIM_HZ } from '../src/sim/clock'
import { SimWorld } from '../src/sim/world'

interface StressCase {
  kind: Extract<EmergencyKind, 'fire' | 'gasLeak'>
  seed: number
}

interface StressResult extends StressCase {
  evacuatedAt: number
  normalAt: number
  totalEvacuees: number
}

const cases: StressCase[] = [
  ...[1, 19, 77, 999].map((seed) => ({ kind: 'fire' as const, seed })),
  ...[2, 42, 314, 1001].map((seed) => ({ kind: 'gasLeak' as const, seed }))
]

if (process.argv[2] === '--case') {
  const kind = process.argv[3]
  const seed = Number(process.argv[4])
  if ((kind !== 'fire' && kind !== 'gasLeak') || !Number.isInteger(seed)) {
    throw new Error('stress child requires --case <fire|gasLeak> <integer seed>')
  }
  console.log(JSON.stringify(runCase({ kind, seed })))
} else {
  // Cases do not share clocks or mutable state. Running them in separate
  // processes preserves deterministic results and keeps this release gate
  // practical as collision-aware evacuation becomes more detailed.
  const outcomes = await Promise.allSettled(cases.map(runIsolatedCase))
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
  if (failures.length > 0) {
    throw new AggregateError(failures.map((failure) => failure.reason), `${failures.length} evacuation stress case(s) failed`)
  }
  const results = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<StressResult>).value)
  results.sort((left, right) =>
    cases.findIndex((item) => item.kind === left.kind && item.seed === left.seed) -
    cases.findIndex((item) => item.kind === right.kind && item.seed === right.seed)
  )
  console.log(JSON.stringify(results, null, 2))
}

function runCase({ kind, seed }: StressCase): StressResult {
  const layout = FabLayoutSchema.parse(JSON.parse(readFileSync(new URL('../data/layouts/fab-default.json', import.meta.url), 'utf8')))
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
}

function runIsolatedCase(testCase: StressCase): Promise<StressResult> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--case', testCase.kind, String(testCase.seed)], {
      silent: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${testCase.kind} seed ${testCase.seed}: child exited with code ${code}`))
        return
      }
      try {
        const result = JSON.parse(stdout) as StressResult
        console.error(`[stress] ${result.kind} seed ${result.seed} passed at ${result.normalAt}s`)
        resolve(result)
      } catch (error) {
        reject(new Error(`${testCase.kind} seed ${testCase.seed}: invalid child result (${String(error)})`))
      }
    })
  })
}
