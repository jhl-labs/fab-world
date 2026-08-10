import { describe, expect, it } from 'vitest'
import { NavGraph } from '../src/core/layout'

describe('hazard aware A*', () => {
  it('does not use a danger edge when a safe detour exists', () => {
    const graph = new NavGraph()
    const start = graph.addNode({ id: 'start', x: 0, z: 0 })
    const danger = graph.addNode({ id: 'danger', x: 1, z: 0 })
    const safe = graph.addNode({ id: 'safe', x: 0, z: 2 })
    const end = graph.addNode({ id: 'end', x: 2, z: 0 })
    graph.addEdge(start, danger, 'hazard-zone'); graph.addEdge(danger, end, 'hazard-zone'); graph.addEdge(start, safe); graph.addEdge(safe, end)
    expect(graph.findPath(start, end, new Map([['hazard-zone', 'danger']]))).toEqual([start, safe, end])
  })
})
