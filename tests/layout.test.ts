import { describe, expect, it } from 'vitest'
import layoutJson from '../data/layouts/fab-default.json'
import { deriveLayout } from '../src/core/layout'
import { buildShotAnchors, buildShotObstacles, isElevatedShotClear, isShotClear, planInteractionOrbit, planShotOrbit } from '../src/render/camera/shotPlanner'

describe('default fab layout', () => {
  it('parses the committed SSOT layout and creates all navigation graphs', () => {
    const layout = deriveLayout(layoutJson)
    expect(layout.layout.bays).toHaveLength(72)
    expect(layout.layout.bays.flatMap((bay) => bay.equipment)).toHaveLength(324)
    expect(layout.roadGraph.nodes.length).toBeGreaterThan(100)
    expect(layout.walkGraph.nodes.length).toBeGreaterThan(100)
    expect(layout.railGraph.nodes.length).toBeGreaterThan(100)
    expect(layout.equipmentPositions.has('lithography-001')).toBe(true)
  })
  it('connects obstacle-clear pedestrian intersections diagonally', () => {
    const layout = deriveLayout(layoutJson)
    const diagonalEdges = layout.walkGraph.edges.flatMap((edges, from) => edges.filter(({ to }) => {
      const start = layout.walkGraph.nodes[from]!
      const end = layout.walkGraph.nodes[to]!
      return Math.abs(start.x - end.x) > 0.1 && Math.abs(start.z - end.z) > 0.1
    }))

    expect(diagonalEdges.length).toBeGreaterThan(20)
  })
  it('routes safe traffic around a real danger zone while allowing occupants to exit it', () => {
    const layout = deriveLayout(layoutJson)
    const dangerZone = layout.layout.zones[0]!.id
    const dangerNode = layout.walkGraph.nodes.findIndex((node) => node.zoneId === dangerZone)
    const safeNodes = layout.walkGraph.nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.zoneId !== dangerZone)
    expect(dangerNode).toBeGreaterThanOrEqual(0)
    const hazards = new Map([[dangerZone, 'danger' as const]])
    const safePath = layout.walkGraph.findPath(safeNodes[0]!.index, safeNodes.at(-1)!.index, hazards)
    expect(safePath.length).toBeGreaterThan(0)
    expect(safePath.every((index) => layout.walkGraph.nodes[index]!.zoneId !== dangerZone)).toBe(true)
    const escapePath = layout.walkGraph.findPath(dangerNode, safeNodes.at(-1)!.index, hazards)
    expect(escapePath.length).toBeGreaterThan(0)
    expect(layout.walkGraph.nodes[escapePath.at(-1)!]!.zoneId).not.toBe(dangerZone)
  })
  it('places a close-up camera in a real aisle instead of inside dense equipment', () => {
    const layout = deriveLayout(layoutJson)
    const focus = [-82.7, -86.3] as const
    const polar = 1.22
    const obstacles = buildShotObstacles(layout.layout)
    const planned = planShotOrbit(buildShotAnchors(layout.layout), focus, 0, polar, 10.5, 6, 16, obstacles)
    const horizontal = Math.sin(polar) * planned.distance
    const cameraX = focus[0] + Math.cos(planned.azimuth) * horizontal
    const cameraZ = focus[1] + Math.sin(planned.azimuth) * horizontal
    expect(isShotClear([cameraX, cameraZ], focus, obstacles)).toBe(true)
    expect(cameraX).toBeLessThan(-86)
    expect(horizontal).toBeGreaterThanOrEqual(6)
    expect(horizontal).toBeLessThanOrEqual(16)
  })
  it('treats full-height structural columns as camera obstacles', () => {
    const layout = deriveLayout(layoutJson)
    const obstacles = buildShotObstacles(layout.layout)
    const column = obstacles.find((obstacle) => obstacle.center[0] === -96 && obstacle.center[1] === -96)
    expect(column).toEqual({
      center: [-96, -96],
      halfWidth: 0.305,
      halfDepth: 0.305,
      height: 9
    })
    expect(isShotClear([-100, -96], [-92, -96], obstacles, 0)).toBe(false)
  })
  it('finds an equipment-clear view to both participants in a human-robot handoff', () => {
    const layout = deriveLayout(layoutJson)
    const obstacles = buildShotObstacles(layout.layout)
    const robot = [-82.7, -85.1] as const
    const person = [-84.925, -84.32] as const
    const polar = 0.78
    const planned = planInteractionOrbit(obstacles, robot, person, 0, polar)
    const horizontal = Math.sin(polar) * planned.distance
    const focus = [(robot[0] + person[0]) / 2, (robot[1] + person[1]) / 2] as const
    const camera = [
      focus[0] + Math.cos(planned.azimuth) * horizontal,
      focus[1] + Math.sin(planned.azimuth) * horizontal
    ] as const
    const cameraY = 0.8 + horizontal / Math.tan(polar)
    expect(isElevatedShotClear(camera, cameraY, robot, 1.35, obstacles, 0.25)).toBe(true)
    expect(isElevatedShotClear(camera, cameraY, person, 1.35, obstacles, 0.25)).toBe(true)
  })
})
