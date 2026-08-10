import type { FabLayout } from '../../core/schema'

export type ShotAnchor = readonly [number, number]

export interface ShotObstacle {
  center: ShotAnchor
  halfWidth: number
  halfDepth: number
  height: number
}

export interface PlannedOrbit {
  azimuth: number
  distance: number
}

const normalizeAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle))

export function buildShotAnchors(layout: FabLayout, spacing = 8): ShotAnchor[] {
  const anchors: ShotAnchor[] = []
  for (const zone of layout.zones) {
    if (zone.kind !== 'corridor' && zone.kind !== 'transfer-aisle' && zone.kind !== 'exit-zone') continue
    const xs = zone.polygon.map((point) => point[0])
    const zs = zone.polygon.map((point) => point[1])
    const minX = Math.min(...xs); const maxX = Math.max(...xs)
    const minZ = Math.min(...zs); const maxZ = Math.max(...zs)
    const centerX = (minX + maxX) / 2
    const centerZ = (minZ + maxZ) / 2
    if (maxX - minX >= maxZ - minZ) {
      for (let x = minX + spacing / 2; x < maxX; x += spacing) anchors.push([x, centerZ])
    } else {
      for (let z = minZ + spacing / 2; z < maxZ; z += spacing) anchors.push([centerX, z])
    }
  }
  const bayBounds = layout.zones.filter((zone) => zone.kind === 'bay-interior').map((zone) => {
    const xs = zone.polygon.map((point) => point[0])
    const zs = zone.polygon.map((point) => point[1])
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
  })
  const xSpans = [...new Map(bayBounds.map((bounds) => [`${bounds.minX}:${bounds.maxX}`, [bounds.minX, bounds.maxX] as const])).values()]
    .sort((left, right) => left[0] - right[0])
  const minZ = Math.min(...bayBounds.map((bounds) => bounds.minZ))
  const maxZ = Math.max(...bayBounds.map((bounds) => bounds.maxZ))
  const aisleXs: number[] = []
  for (let index = 1; index < xSpans.length; index++) aisleXs.push((xSpans[index - 1]![1] + xSpans[index]![0]) / 2)
  if (xSpans.length > 0) {
    aisleXs.push((-layout.fab.width / 2 + xSpans[0]![0]) / 2)
    aisleXs.push((layout.fab.width / 2 + xSpans.at(-1)![1]) / 2)
  }
  for (const x of aisleXs) for (let z = minZ + spacing / 2; z < maxZ; z += spacing) anchors.push([x, z])
  for (const exit of layout.emergency.exits) anchors.push([exit.position[0], exit.position[2]])
  return anchors
}

export function buildShotObstacles(layout: FabLayout, padding = 0.08): ShotObstacle[] {
  const equipment = layout.bays.flatMap((bay) => bay.equipment.map((equipment) => {
    const width = equipment.type === 'lithography' ? 4.6 : equipment.type === 'cmp' ? 5 : 3.5
    const depth = 4.2
    const quarterTurn = Math.abs(Math.sin(equipment.rotation)) > 0.7
    return {
      center: [equipment.position[0], equipment.position[2]] as const,
      halfWidth: (quarterTurn ? depth : width) / 2 + padding,
      halfDepth: (quarterTurn ? width : depth) / 2 + padding,
      height: equipment.type === 'furnace' ? 3.8 : 2.8
    }
  }))
  // The structural columns are tall enough to dominate a close-up even
  // though their footprint is small. Keep the camera planner's obstacle map
  // aligned with the structural grid rendered by fabScene.
  const columns: ShotObstacle[] = []
  for (let x = -96; x <= 96; x += 32) {
    for (let z = -96; z <= 96; z += 48) {
      columns.push({ center: [x, z], halfWidth: 0.305, halfDepth: 0.305, height: 9 })
    }
  }
  return [...equipment, ...columns]
}

export function isShotClear(anchor: ShotAnchor, focus: ShotAnchor, obstacles: readonly ShotObstacle[], ignoreNearFocus = 3.2): boolean {
  return obstacles.every((obstacle) => {
    if (Math.hypot(obstacle.center[0] - focus[0], obstacle.center[1] - focus[1]) < ignoreNearFocus) return true
    return !segmentIntersectsBox(anchor, focus, obstacle)
  })
}

export function planInteractionOrbit(
  obstacles: readonly ShotObstacle[],
  robot: ShotAnchor,
  person: ShotAnchor,
  desiredAzimuth: number,
  polar: number
): PlannedOrbit {
  const focus: ShotAnchor = [(robot[0] + person[0]) / 2, (robot[1] + person[1]) / 2]
  const candidates: Array<{ azimuth: number; horizontal: number; score: number }> = []
  for (const horizontal of [6.2, 8]) {
    for (let index = 0; index < 24; index++) {
      const azimuth = index / 24 * Math.PI * 2
      const anchor: ShotAnchor = [
        focus[0] + Math.cos(azimuth) * horizontal,
        focus[1] + Math.sin(azimuth) * horizontal
      ]
      const cameraY = 0.8 + horizontal / Math.max(0.1, Math.tan(polar))
      if (!isElevatedShotClear(anchor, cameraY, robot, 1.35, obstacles, 0.25) || !isElevatedShotClear(anchor, cameraY, person, 1.35, obstacles, 0.25)) continue
      const angleError = Math.abs(normalizeAngle(azimuth - desiredAzimuth))
      candidates.push({ azimuth, horizontal, score: angleError + (horizontal - 6.2) * 0.04 })
    }
  }
  candidates.sort((left, right) => left.score - right.score)
  const selected = candidates[0]
  if (!selected) return { azimuth: desiredAzimuth, distance: 9 }
  return { azimuth: selected.azimuth, distance: selected.horizontal / Math.max(0.1, Math.sin(polar)) }
}

export function isElevatedShotClear(
  anchor: ShotAnchor,
  cameraY: number,
  focus: ShotAnchor,
  focusY: number,
  obstacles: readonly ShotObstacle[],
  ignoreNearFocus = 0.25
): boolean {
  return obstacles.every((obstacle) => {
    if (Math.hypot(obstacle.center[0] - focus[0], obstacle.center[1] - focus[1]) < ignoreNearFocus) return true
    const interval = segmentBoxInterval(anchor, focus, obstacle)
    if (!interval) return true
    const lowestRayY = cameraY + (focusY - cameraY) * interval[1]
    return lowestRayY > obstacle.height + 0.1
  })
}

export function planShotOrbit(
  anchors: readonly ShotAnchor[],
  focus: ShotAnchor,
  desiredAzimuth: number,
  polar: number,
  fallbackDistance: number,
  minHorizontal = 8,
  maxHorizontal = 22,
  obstacles: readonly ShotObstacle[] = []
): PlannedOrbit {
  const candidates = anchors.flatMap((anchor) => {
    const dx = anchor[0] - focus[0]
    const dz = anchor[1] - focus[1]
    const horizontal = Math.hypot(dx, dz)
    if (horizontal < minHorizontal || horizontal > maxHorizontal) return []
    if (!isShotClear(anchor, focus, obstacles)) return []
    const azimuth = Math.atan2(dz, dx)
    const angleError = Math.abs(normalizeAngle(azimuth - desiredAzimuth))
    const distanceError = Math.abs(horizontal - 12)
    return [{ azimuth, horizontal, score: angleError * 5 + distanceError * 0.08 }]
  }).sort((a, b) => a.score - b.score)

  const selected = candidates[0]
  if (!selected) return { azimuth: desiredAzimuth, distance: fallbackDistance }
  return {
    azimuth: selected.azimuth,
    distance: selected.horizontal / Math.max(0.1, Math.sin(polar))
  }
}

function segmentIntersectsBox(from: ShotAnchor, to: ShotAnchor, obstacle: ShotObstacle): boolean {
  return segmentBoxInterval(from, to, obstacle) !== undefined
}

function segmentBoxInterval(from: ShotAnchor, to: ShotAnchor, obstacle: ShotObstacle): readonly [number, number] | undefined {
  const minX = obstacle.center[0] - obstacle.halfWidth
  const maxX = obstacle.center[0] + obstacle.halfWidth
  const minZ = obstacle.center[1] - obstacle.halfDepth
  const maxZ = obstacle.center[1] + obstacle.halfDepth
  const dx = to[0] - from[0]
  const dz = to[1] - from[1]
  let near = 0
  let far = 1
  for (const [origin, delta, min, max] of [[from[0], dx, minX, maxX], [from[1], dz, minZ, maxZ]] as const) {
    if (Math.abs(delta) < 0.0001) {
      if (origin < min || origin > max) return undefined
      continue
    }
    const first = (min - origin) / delta
    const second = (max - origin) / delta
    near = Math.max(near, Math.min(first, second))
    far = Math.min(far, Math.max(first, second))
    if (near > far) return undefined
  }
  return [near, far]
}
