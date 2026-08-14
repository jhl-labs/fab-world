import { distance2 } from '../math/vec'

export type HazardLevel = 'safe' | 'warning' | 'danger'
export interface GraphNode { id: string; x: number; z: number; zoneId?: string }
export interface GraphEdge { to: number; distance: number; zoneId?: string }

class MinHeap {
  private values: Array<{ node: number; priority: number }> = []
  push(value: { node: number; priority: number }): void {
    this.values.push(value)
    for (let index = this.values.length - 1; index > 0;) {
      const parent = (index - 1) >> 1
      if (this.values[parent]!.priority <= this.values[index]!.priority) break
      [this.values[parent], this.values[index]] = [this.values[index]!, this.values[parent]!]; index = parent
    }
  }
  pop(): { node: number; priority: number } | undefined {
    const first = this.values[0]; const last = this.values.pop()
    if (!first) return undefined
    if (last && this.values.length > 0) {
      this.values[0] = last
      for (let index = 0;;) {
        const left = index * 2 + 1; const right = left + 1
        let smallest = index
        if (left < this.values.length && this.values[left]!.priority < this.values[smallest]!.priority) smallest = left
        if (right < this.values.length && this.values[right]!.priority < this.values[smallest]!.priority) smallest = right
        if (smallest === index) break
        [this.values[index], this.values[smallest]] = [this.values[smallest]!, this.values[index]!]; index = smallest
      }
    }
    return first
  }
  get size(): number { return this.values.length }
}

export class NavGraph {
  readonly nodes: GraphNode[] = []
  readonly edges: GraphEdge[][] = []
  private readonly nodeById = new Map<string, number>()

  addNode(node: GraphNode): number {
    const existing = this.nodeById.get(node.id)
    if (existing !== undefined) return existing
    const index = this.nodes.length
    this.nodes.push(node); this.edges.push([]); this.nodeById.set(node.id, index)
    return index
  }
  indexOf(id: string): number | undefined { return this.nodeById.get(id) }
  addEdge(a: number, b: number, zoneId?: string): void {
    if (a === b || this.edges[a]!.some((edge) => edge.to === b)) return
    const distance = distance2([this.nodes[a]!.x, this.nodes[a]!.z], [this.nodes[b]!.x, this.nodes[b]!.z])
    this.edges[a]!.push({ to: b, distance, zoneId }); this.edges[b]!.push({ to: a, distance, zoneId })
  }
  nearest(x: number, z: number): number {
    let nearest = 0; let best = Infinity
    for (let index = 0; index < this.nodes.length; index++) {
      const node = this.nodes[index]!
      const distance = (node.x - x) ** 2 + (node.z - z) ** 2
      if (distance < best) { best = distance; nearest = index }
    }
    return nearest
  }
  findPath(
    from: number,
    to: number,
    hazards: ReadonlyMap<string, HazardLevel> = new Map(),
    blockedNodes: ReadonlySet<number> = new Set(),
    nodePenalties: ReadonlyMap<number, number> = new Map()
  ): number[] {
    if (from === to) return [from]
    const size = this.nodes.length
    const scores = new Float64Array(size); scores.fill(Infinity); scores[from] = 0
    const parents = new Int32Array(size); parents.fill(-1)
    const closed = new Uint8Array(size)
    const open = new MinHeap(); open.push({ node: from, priority: 0 })
    while (open.size > 0) {
      const current = open.pop()!.node
      if (closed[current]) continue
      if (current === to) {
        const path: number[] = []
        for (let node = current; node !== -1; node = parents[node]!) path.unshift(node)
        return path
      }
      closed[current] = 1
      for (const edge of this.edges[current]!) {
        if (edge.to !== to && blockedNodes.has(edge.to)) continue
        const edgeHazard = edge.zoneId ? hazards.get(edge.zoneId) : undefined
        const fromHazard = this.nodes[current]!.zoneId ? hazards.get(this.nodes[current]!.zoneId!) : undefined
        const toHazard = this.nodes[edge.to]!.zoneId ? hazards.get(this.nodes[edge.to]!.zoneId!) : undefined
        if ((edgeHazard === 'danger' || toHazard === 'danger') && fromHazard !== 'danger') continue
        const multiplier = edgeHazard === 'danger' || toHazard === 'danger' ? 100 : edgeHazard === 'warning' || toHazard === 'warning' ? 10 : 1
        const candidate = scores[current]! + edge.distance * multiplier * (nodePenalties.get(edge.to) ?? 1)
        if (candidate < scores[edge.to]!) {
          scores[edge.to] = candidate; parents[edge.to] = current
          const heuristic = distance2([this.nodes[edge.to]!.x, this.nodes[edge.to]!.z], [this.nodes[to]!.x, this.nodes[to]!.z])
          open.push({ node: edge.to, priority: candidate + heuristic })
        }
      }
    }
    return []
  }
}
