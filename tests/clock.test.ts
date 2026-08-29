import { describe, expect, it } from 'vitest'
import { FIXED_DT, SimulationClock } from '../src/sim/clock'

describe('SimulationClock accelerated playback', () => {
  it.each([
    { scale: 1, expectedTicks: 15, expectedStep: FIXED_DT },
    { scale: 4, expectedTicks: 15, expectedStep: FIXED_DT * 4 },
    { scale: 8, expectedTicks: 15, expectedStep: FIXED_DT * 8 },
    { scale: 16, expectedTicks: 30, expectedStep: FIXED_DT * 8 }
  ])('preserves simulated time at $scale× with bounded worker updates', ({ scale, expectedTicks, expectedStep }) => {
    const clock = new SimulationClock()
    const steps: number[] = []
    clock.setTimeScale(scale)

    const ticks = clock.advance(0.25, (dt) => steps.push(dt))

    expect(ticks).toBe(expectedTicks)
    expect(steps).toHaveLength(expectedTicks)
    expect(steps.every((dt) => dt === expectedStep)).toBe(true)
    expect(steps.reduce((total, dt) => total + dt, 0)).toBeCloseTo(0.25 * scale)
  })

  it('retains accelerated time while limiting one worker catch-up slice', () => {
    const clock = new SimulationClock()
    const steps: number[] = []
    clock.setTimeScale(16)

    expect(clock.advance(0.25, (dt) => steps.push(dt), 2)).toBe(2)
    for (let slice = 0; slice < 14; slice++) clock.advance(0, (dt) => steps.push(dt), 2)

    expect(steps).toHaveLength(30)
    expect(steps.reduce((total, dt) => total + dt, 0)).toBeCloseTo(4)
  })
})
