import { pointInPolygon, type Vec2 } from '../math/vec'
import { FabLayoutSchema, type FabLayout } from '../schema'
import { NavGraph } from './graph'

export interface DerivedLayout {
  layout: FabLayout
  railGraph: NavGraph
  roadGraph: NavGraph
  walkGraph: NavGraph
  bayCenters: Map<string, readonly [number, number]>
  equipmentPositions: Map<string, readonly [number, number, number]>
  zoneAt(x: number, z: number): string | undefined
}

const nodeId = (x: number, z: number) => `${x.toFixed(3)}:${z.toFixed(3)}`
const addGraphPoint = (graph: NavGraph, x: number, z: number, zoneId?: string) => graph.addNode({ id: nodeId(x, z), x, z, zoneId })

function uniqueSorted(values: number[]): number[] { return [...new Set(values.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b) }
function layoutZoneAt(layout: FabLayout, x: number, z: number): string | undefined {
  return layout.zones.find((zone) => pointInPolygon([x, z], zone.polygon as Vec2[]))?.id
}
function connect(graph: NavGraph, a: number, b: number): void {
  graph.addEdge(a, b, graph.nodes[a]!.zoneId ?? graph.nodes[b]!.zoneId)
}

function buildGroundGraph(layout: FabLayout, includeBays: boolean): NavGraph {
  const graph = new NavGraph()
  const xEdges: number[] = []; const zEdges: number[] = []
  let x = -layout.grid.columnWidths.reduce((sum, value) => sum + value, 0) / 2 - layout.grid.aisleWidth * (layout.grid.cols - 1) / 2
  for (const width of layout.grid.columnWidths) { xEdges.push(x, x + width); x += width + layout.grid.aisleWidth }
  let z = -layout.grid.rowDepths.reduce((sum, value) => sum + value, 0) / 2 - layout.grid.aisleWidth * (layout.grid.rows - 1) / 2
  for (const depth of layout.grid.rowDepths) { zEdges.push(z, z + depth); z += depth + layout.grid.aisleWidth }
  const xs = uniqueSorted([...xEdges, ...layout.emergency.exits.map((exit) => exit.position[0]), ...layout.emergency.musterPoints.map((point) => point.position[0]), ...layout.emergency.safetyDevices.map((device) => device.position[0]), layout.emergency.medicalStation.position[0]])
  const zs = uniqueSorted([...zEdges, ...layout.emergency.exits.map((exit) => exit.position[2]), ...layout.emergency.musterPoints.map((point) => point.position[2]), ...layout.emergency.safetyDevices.map((device) => device.position[2]), layout.emergency.medicalStation.position[2]])
  for (const currentX of xs) for (const currentZ of zs) addGraphPoint(graph, currentX, currentZ, layoutZoneAt(layout, currentX, currentZ))
  for (const currentX of xs) for (let i = 1; i < zs.length; i++) connect(graph, graph.indexOf(nodeId(currentX, zs[i - 1]!))!, graph.indexOf(nodeId(currentX, zs[i]!))!)
  for (const currentZ of zs) for (let i = 1; i < xs.length; i++) connect(graph, graph.indexOf(nodeId(xs[i - 1]!, currentZ))!, graph.indexOf(nodeId(xs[i]!, currentZ))!)
  if (includeBays) for (const bay of layout.bays) {
    const equipment = bay.equipment[0]!
    const nearest = graph.nearest(equipment.position[0], equipment.position[2])
    const point = addGraphPoint(graph, equipment.position[0], equipment.position[2], `zone-${bay.id}`)
    connect(graph, point, nearest)
  }
  return graph
}

function buildRailGraph(layout: FabLayout): NavGraph {
  const graph = new NavGraph()
  const segments = layout.ohtRail.segments.map((segment) => ({ ax: segment.from[0], az: segment.from[2], bx: segment.to[0], bz: segment.to[2] }))
  const onSegment = (x: number, z: number, segment: typeof segments[number]) => Math.min(segment.ax, segment.bx) - 0.001 <= x && x <= Math.max(segment.ax, segment.bx) + 0.001 && Math.min(segment.az, segment.bz) - 0.001 <= z && z <= Math.max(segment.az, segment.bz) + 0.001 && Math.abs((segment.bx - segment.ax) * (z - segment.az) - (segment.bz - segment.az) * (x - segment.ax)) < 0.001
  for (const segment of segments) {
    const points: [number, number][] = [[segment.ax, segment.az], [segment.bx, segment.bz]]
    for (const other of segments) {
      for (const point of [[other.ax, other.az], [other.bx, other.bz]] as const) if (onSegment(point[0], point[1], segment)) points.push([point[0], point[1]])
      const denominator = (segment.ax - segment.bx) * (other.az - other.bz) - (segment.az - segment.bz) * (other.ax - other.bx)
      if (Math.abs(denominator) < 0.0001) continue
      const determinantA = segment.ax * segment.bz - segment.az * segment.bx; const determinantB = other.ax * other.bz - other.az * other.bx
      const x = (determinantA * (other.ax - other.bx) - (segment.ax - segment.bx) * determinantB) / denominator
      const z = (determinantA * (other.az - other.bz) - (segment.az - segment.bz) * determinantB) / denominator
      if (onSegment(x, z, segment) && onSegment(x, z, other)) points.push([x, z])
    }
    const unique = [...new Map(points.map((point) => [nodeId(point[0], point[1]), point])).values()]
    unique.sort((a, b) => (Math.abs(segment.bx - segment.ax) > Math.abs(segment.bz - segment.az) ? a[0] - b[0] : a[1] - b[1]) * ((segment.bx - segment.ax || segment.bz - segment.az) >= 0 ? 1 : -1))
    for (let index = 1; index < unique.length; index++) {
      const a = addGraphPoint(graph, unique[index - 1]![0], unique[index - 1]![1], layoutZoneAt(layout, unique[index - 1]![0], unique[index - 1]![1]))
      const b = addGraphPoint(graph, unique[index]![0], unique[index]![1], layoutZoneAt(layout, unique[index]![0], unique[index]![1]))
      connect(graph, a, b)
    }
  }
  return graph
}

function assertSemanticValidity(derived: Omit<DerivedLayout, 'zoneAt'> & { zoneAt(x: number, z: number): string | undefined }): void {
  for (const bay of derived.layout.bays) for (const equipment of bay.equipment) {
    if (derived.zoneAt(equipment.position[0], equipment.position[2]) !== `zone-${bay.id}`) throw new Error(`${equipment.id} is outside ${bay.id}`)
  }
  const start = derived.walkGraph.nearest(derived.layout.bays[0]!.equipment[0]!.position[0], derived.layout.bays[0]!.equipment[0]!.position[2])
  if (!derived.layout.emergency.exits.some((exit) => derived.walkGraph.findPath(start, derived.walkGraph.nearest(exit.position[0], exit.position[2])).length > 0)) throw new Error('No reachable emergency exit')
}

export function deriveLayout(input: unknown): DerivedLayout {
  const layout = FabLayoutSchema.parse(input)
  const bayCenters = new Map<string, readonly [number, number]>()
  const equipmentPositions = new Map<string, readonly [number, number, number]>()
  for (const bay of layout.bays) {
    const xs = bay.equipment.map((equipment) => equipment.position[0]); const zs = bay.equipment.map((equipment) => equipment.position[2])
    bayCenters.set(bay.id, [xs.reduce((a, b) => a + b, 0) / xs.length, zs.reduce((a, b) => a + b, 0) / zs.length])
    for (const equipment of bay.equipment) equipmentPositions.set(equipment.id, equipment.position)
  }
  const zoneAt = (pointX: number, pointZ: number): string | undefined => {
    for (const zone of layout.zones) if (pointInPolygon([pointX, pointZ], zone.polygon as Vec2[])) return zone.id
    return undefined
  }
  const derived = { layout, railGraph: buildRailGraph(layout), roadGraph: buildGroundGraph(layout, true), walkGraph: buildGroundGraph(layout, true), bayCenters, equipmentPositions, zoneAt }
  assertSemanticValidity(derived)
  return derived
}

export { NavGraph } from './graph'
export type { HazardLevel } from './graph'
