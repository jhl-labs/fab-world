export const SIM_HZ = 60
export const FIXED_DT = 1 / SIM_HZ

/** Fixed-step accumulator. Scaling increases the number of fixed ticks, never dt. */
export class SimulationClock {
  private accumulator = 0
  timeScale = 1
  setTimeScale(value: number): void { this.timeScale = Math.max(0, Math.min(16, value)) }
  resetAccumulator(): void { this.accumulator = 0 }
  advance(realDt: number, tick: (dt: number) => void): number {
    this.accumulator += Math.min(realDt, 0.25) * this.timeScale
    // At 8× and above we intentionally use a 30 Hz step. It preserves elapsed
    // simulation time while keeping the Worker responsive to pause/command messages.
    const step = this.timeScale >= 8 ? FIXED_DT * 2 : FIXED_DT
    let ticks = 0
    const maxTicks = this.timeScale >= 8 ? 120 : 480
    while (this.accumulator >= step && ticks < maxTicks) { tick(step); this.accumulator -= step; ticks++ }
    return ticks
  }
  step(tick: (dt: number) => void): void { tick(FIXED_DT) }
}
