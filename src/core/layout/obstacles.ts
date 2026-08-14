import type { EquipmentType, FabLayout } from '../schema'

export interface EquipmentDimensions {
  width: number
  height: number
  depth: number
}

export interface GroundObstacle {
  id: string
  kind: 'equipment' | 'stocker' | 'safety-device' | 'column'
  centerX: number
  centerZ: number
  halfWidth: number
  halfDepth: number
}

export class GroundObstacleIndex {
  private readonly buckets = new Map<string, GroundObstacle[]>()

  constructor(readonly obstacles: readonly GroundObstacle[], private readonly cellSize = 8) {
    for (const obstacle of obstacles) {
      const minimumX = Math.floor((obstacle.centerX - obstacle.halfWidth) / cellSize)
      const maximumX = Math.floor((obstacle.centerX + obstacle.halfWidth) / cellSize)
      const minimumZ = Math.floor((obstacle.centerZ - obstacle.halfDepth) / cellSize)
      const maximumZ = Math.floor((obstacle.centerZ + obstacle.halfDepth) / cellSize)
      for (let x = minimumX; x <= maximumX; x++) for (let z = minimumZ; z <= maximumZ; z++) {
        const key = `${x},${z}`
        const bucket = this.buckets.get(key) ?? []
        bucket.push(obstacle)
        this.buckets.set(key, bucket)
      }
    }
  }

  aroundPoint(x: number, z: number, radius: number): GroundObstacle[] {
    return this.queryBounds(x - radius, z - radius, x + radius, z + radius)
  }

  alongSegment(fromX: number, fromZ: number, toX: number, toZ: number, radius: number): GroundObstacle[] {
    return this.queryBounds(
      Math.min(fromX, toX) - radius,
      Math.min(fromZ, toZ) - radius,
      Math.max(fromX, toX) + radius,
      Math.max(fromZ, toZ) + radius
    )
  }

  private queryBounds(minimumX: number, minimumZ: number, maximumX: number, maximumZ: number): GroundObstacle[] {
    const matches = new Set<GroundObstacle>()
    const fromX = Math.floor(minimumX / this.cellSize)
    const toX = Math.floor(maximumX / this.cellSize)
    const fromZ = Math.floor(minimumZ / this.cellSize)
    const toZ = Math.floor(maximumZ / this.cellSize)
    for (let x = fromX; x <= toX; x++) for (let z = fromZ; z <= toZ; z++) {
      for (const obstacle of this.buckets.get(`${x},${z}`) ?? []) matches.add(obstacle)
    }
    return [...matches]
  }
}

export const EQUIPMENT_DIMENSIONS: Record<EquipmentType, EquipmentDimensions> = {
  lithography: { width: 4.6, height: 3.2, depth: 4.2 },
  etcher: { width: 3.5, height: 2.75, depth: 4.2 },
  cvd: { width: 3.5, height: 2.85, depth: 4.2 },
  pvd: { width: 3.5, height: 2.85, depth: 4.2 },
  cmp: { width: 5, height: 2.35, depth: 4.2 },
  implanter: { width: 3.5, height: 2.85, depth: 4.2 },
  cleaner: { width: 3.5, height: 2.45, depth: 4.2 },
  furnace: { width: 3.5, height: 3.65, depth: 4.2 },
  metrology: { width: 3.5, height: 2.35, depth: 4.2 },
  stocker: { width: 4.2, height: 5.8, depth: 2.4 }
}

type Equipment = FabLayout['bays'][number]['equipment'][number]

export function equipmentAccessPoint(equipment: Equipment, extraStandoff = 0): readonly [number, number] {
  const loadport = equipment.loadports[0]!
  const offsetX = loadport.offset[0] * Math.cos(equipment.rotation) + loadport.offset[2] * Math.sin(equipment.rotation)
  const offsetZ = -loadport.offset[0] * Math.sin(equipment.rotation) + loadport.offset[2] * Math.cos(equipment.rotation)
  const length = Math.max(0.001, Math.hypot(offsetX, offsetZ))
  return [
    equipment.position[0] + offsetX + offsetX / length * extraStandoff,
    equipment.position[2] + offsetZ + offsetZ / length * extraStandoff
  ]
}

export function buildGroundObstacles(layout: FabLayout): GroundObstacle[] {
  const obstacles: GroundObstacle[] = []
  for (const bay of layout.bays) for (const equipment of bay.equipment) {
    const dimensions = EQUIPMENT_DIMENSIONS[equipment.type]
    const cosine = Math.abs(Math.cos(equipment.rotation))
    const sine = Math.abs(Math.sin(equipment.rotation))
    obstacles.push({
      id: equipment.id,
      kind: 'equipment',
      centerX: equipment.position[0],
      centerZ: equipment.position[2],
      halfWidth: dimensions.width / 2 * cosine + dimensions.depth / 2 * sine,
      halfDepth: dimensions.width / 2 * sine + dimensions.depth / 2 * cosine
    })
  }
  for (const stocker of layout.stockers) {
    const dimensions = EQUIPMENT_DIMENSIONS.stocker
    obstacles.push({
      id: stocker.id,
      kind: 'stocker',
      centerX: stocker.position[0],
      centerZ: stocker.position[2],
      halfWidth: dimensions.width / 2,
      halfDepth: dimensions.depth / 2
    })
  }
  for (const device of layout.emergency.safetyDevices) {
    const cosine = Math.abs(Math.cos(device.heading))
    const sine = Math.abs(Math.sin(device.heading))
    obstacles.push({
      id: device.id,
      kind: 'safety-device',
      centerX: device.position[0],
      centerZ: device.position[2],
      halfWidth: 0.21 * cosine + 0.41 * sine,
      halfDepth: 0.21 * sine + 0.41 * cosine
    })
  }
  // Keep this footprint in lock-step with the cleanroom structural grid in
  // fabScene. Columns are small, but silently walking through one is highly
  // visible in close camera shots.
  for (let x = -96; x <= 96; x += 32) for (let z = -96; z <= 96; z += 48) {
    obstacles.push({ id: `column:${x}:${z}`, kind: 'column', centerX: x, centerZ: z, halfWidth: 0.21, halfDepth: 0.21 })
  }
  return obstacles
}

export function circleIntersectsObstacle(x: number, z: number, radius: number, obstacle: GroundObstacle): boolean {
  const nearestX = Math.max(obstacle.centerX - obstacle.halfWidth, Math.min(x, obstacle.centerX + obstacle.halfWidth))
  const nearestZ = Math.max(obstacle.centerZ - obstacle.halfDepth, Math.min(z, obstacle.centerZ + obstacle.halfDepth))
  return (x - nearestX) ** 2 + (z - nearestZ) ** 2 < radius ** 2
}

export function sweptCircleIntersectsObstacle(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  radius: number,
  obstacle: GroundObstacle
): boolean {
  const minX = obstacle.centerX - obstacle.halfWidth - radius
  const maxX = obstacle.centerX + obstacle.halfWidth + radius
  const minZ = obstacle.centerZ - obstacle.halfDepth - radius
  const maxZ = obstacle.centerZ + obstacle.halfDepth + radius
  const deltaX = toX - fromX
  const deltaZ = toZ - fromZ
  let near = 0
  let far = 1
  for (const [origin, delta, minimum, maximum] of [[fromX, deltaX, minX, maxX], [fromZ, deltaZ, minZ, maxZ]] as const) {
    if (Math.abs(delta) < 0.000_001) {
      if (origin <= minimum || origin >= maximum) return false
      continue
    }
    const first = (minimum - origin) / delta
    const second = (maximum - origin) / delta
    near = Math.max(near, Math.min(first, second))
    far = Math.min(far, Math.max(first, second))
    if (near > far) return false
  }
  return far >= 0 && near <= 1
}
