/** Mulberry32: stable, fast seeded random source for deterministic simulation. */
export class SeededRng {
  private state: number
  constructor(seed: number) { this.state = seed >>> 0 }
  next(): number {
    let value = this.state += 0x6D2B79F5
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
  range(min: number, max: number): number { return min + (max - min) * this.next() }
  int(min: number, maxExclusive: number): number { return Math.floor(this.range(min, maxExclusive)) }
  pick<T>(items: readonly T[]): T { return items[this.int(0, items.length)]! }
}
