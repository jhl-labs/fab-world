export const SIM_HZ = 60
export const FIXED_DT = 1 / SIM_HZ

/** Accumulator that preserves simulated elapsed time with bounded accelerated steps. */
export class SimulationClock {
  private accumulator = 0
  timeScale = 1
  setTimeScale(value: number): void { this.timeScale = Math.max(0, Math.min(16, value)) }
  resetAccumulator(): void { this.accumulator = 0 }
  advance(realDt: number, tick: (dt: number) => void, tickBudget = Number.POSITIVE_INFINITY): number {
    this.accumulator += Math.min(realDt, 0.25) * this.timeScale
    // Keep accelerated playback between 60 and 120 world updates per wall second. A
    // 448-body world at 4×/8×/16× otherwise saturates a CPU core and
    // starves the browser renderer even though the simulation is in a Worker.
    // Swept collision checks keep these larger high-speed steps safe, while
    // pose interpolation supplies display-rate motion between snapshots.
    const stepStride = Math.min(8, Math.max(1, Math.round(this.timeScale)))
    const step = FIXED_DT * stepStride
    let ticks = 0
    const maxTicks = Math.min(Math.ceil(480 / stepStride), Math.max(1, Math.floor(tickBudget)))
    while (this.accumulator + 1e-9 >= step && ticks < maxTicks) {
      tick(step)
      this.accumulator = Math.max(0, this.accumulator - step)
      ticks++
    }
    return ticks
  }
  step(tick: (dt: number) => void): void { tick(FIXED_DT) }
}
