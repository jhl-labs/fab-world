import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  GAS_VALVE_WHEEL_HEIGHT,
  GAS_VALVE_WHEEL_OFFSET,
  GAS_VALVE_WHEEL_RING_RADIUS,
  GAS_VALVE_WHEEL_TUBE_RADIUS
} from '../../core/interactionGeometry'
import { EQUIPMENT_DIMENSIONS } from '../../core/layout'
import type { EquipmentType, FabLayout, ProcessBand } from '../../core/schema'

const bandColors: Record<ProcessBand, number> = {
  photo: 0xf5c542, etch: 0x29a9a4, deposition: 0x4c7bd9, implant: 0x9f7aea, cmp: 0x64a96c
}

const equipmentProfiles: Record<EquipmentType, { width: number; height: number; depth: number; accent: number; crown: number; ports: number }> = {
  lithography: { ...EQUIPMENT_DIMENSIONS.lithography, accent: 0xf3c84b, crown: 0.58, ports: 2 },
  etcher: { ...EQUIPMENT_DIMENSIONS.etcher, accent: 0x2eb8b0, crown: 0.42, ports: 1 },
  cvd: { ...EQUIPMENT_DIMENSIONS.cvd, accent: 0x638ce8, crown: 0.62, ports: 1 },
  pvd: { ...EQUIPMENT_DIMENSIONS.pvd, accent: 0x78a0ef, crown: 0.56, ports: 1 },
  cmp: { ...EQUIPMENT_DIMENSIONS.cmp, accent: 0x75ba79, crown: 0.35, ports: 2 },
  implanter: { ...EQUIPMENT_DIMENSIONS.implanter, accent: 0xb082ef, crown: 0.7, ports: 1 },
  cleaner: { ...EQUIPMENT_DIMENSIONS.cleaner, accent: 0x5fc5ca, crown: 0.32, ports: 1 },
  furnace: { ...EQUIPMENT_DIMENSIONS.furnace, accent: 0xdb8c4a, crown: 0.82, ports: 1 },
  metrology: { ...EQUIPMENT_DIMENSIONS.metrology, accent: 0x5d9fd7, crown: 0.3, ports: 1 },
  stocker: { ...EQUIPMENT_DIMENSIONS.stocker, accent: 0x7692af, crown: 0.2, ports: 1 }
}

const materials = {
  floor: new THREE.MeshStandardMaterial({ color: 0xe9edf2, roughness: 0.28, metalness: 0.08 }),
  apron: new THREE.MeshStandardMaterial({ color: 0xc7d0d9, roughness: 0.76, metalness: 0.04 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xf6f8fb, roughness: 0.52, metalness: 0.04 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x263340, roughness: 0.36, metalness: 0.66 }),
  frame: new THREE.MeshStandardMaterial({ color: 0x718093, roughness: 0.28, metalness: 0.72 }),
  shell: new THREE.MeshStandardMaterial({ color: 0xd5dee7, roughness: 0.33, metalness: 0.44 }),
  shellDark: new THREE.MeshStandardMaterial({ color: 0x566576, roughness: 0.38, metalness: 0.58 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x16374c, emissive: 0x0d2e46, emissiveIntensity: 0.55, roughness: 0.14, metalness: 0.52 }),
  whiteLight: new THREE.MeshBasicMaterial({ color: 0xfafdff }),
  route: new THREE.MeshBasicMaterial({ color: 0x72a3c8, transparent: true, opacity: 0.3 }),
  corridor: new THREE.MeshBasicMaterial({ color: 0xd4e3ef, transparent: true, opacity: 0.3 }),
  status: new THREE.MeshStandardMaterial({ color: 0x58d68d, emissive: 0x58d68d, emissiveIntensity: 1.4, roughness: 0.24, metalness: 0.42 }),
  safety: new THREE.MeshBasicMaterial({ color: 0xf1c64e, transparent: true, opacity: 0.82 })
}

const accentMaterials = new Map<number, THREE.MeshStandardMaterial>()
const processFloorMaterials = new Map<number, THREE.MeshBasicMaterial>()
const processLineMaterials = new Map<number, THREE.MeshBasicMaterial>()
const roundedGeometryCache = new Map<string, THREE.BufferGeometry>()

function accentMaterial(color: number): THREE.MeshStandardMaterial {
  let material = accentMaterials.get(color)
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.18, roughness: 0.28, metalness: 0.48 })
    accentMaterials.set(color, material)
  }
  return material
}

function processFloorMaterial(color: number): THREE.MeshBasicMaterial {
  let material = processFloorMaterials.get(color)
  if (!material) { material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12 }); processFloorMaterials.set(color, material) }
  return material
}

function processLineMaterial(color: number): THREE.MeshBasicMaterial {
  let material = processLineMaterials.get(color)
  if (!material) { material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.56 }); processLineMaterials.set(color, material) }
  return material
}

function addBox(parent: THREE.Object3D, size: readonly [number, number, number], position: readonly [number, number, number], material: THREE.Material, name?: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...position)
  mesh.receiveShadow = true
  mesh.castShadow = true
  if (name) mesh.name = name
  parent.add(mesh)
  return mesh
}

function addRoundedBox(parent: THREE.Object3D, size: readonly [number, number, number], position: readonly [number, number, number], radius: number, material: THREE.Material, name?: string): THREE.Mesh {
  // RoundedBoxGeometry is non-indexed by default. Re-indexing each reusable
  // static part cuts its vertex payload by roughly 70% and lets the final
  // material batches stay indexed instead of expanding every ordinary box.
  const cacheKey = `${size[0]}:${size[1]}:${size[2]}:${radius}`
  let geometry = roundedGeometryCache.get(cacheKey)
  if (!geometry) {
    const source = new RoundedBoxGeometry(size[0], size[1], size[2], 1, radius)
    geometry = mergeVertices(source)
    source.dispose()
    roundedGeometryCache.set(cacheKey, geometry)
  }
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(...position)
  mesh.receiveShadow = true
  mesh.castShadow = true
  if (name) mesh.name = name
  parent.add(mesh)
  return mesh
}

interface GeometryPart {
  geometry: THREE.BufferGeometry
  position?: readonly [number, number, number]
  rotation?: readonly [number, number, number]
}

function mergeGeometryParts(parts: GeometryPart[]): THREE.BufferGeometry {
  const geometries = parts.map((part) => {
    const geometry = part.geometry
    if (part.rotation) geometry.rotateX(part.rotation[0]).rotateY(part.rotation[1]).rotateZ(part.rotation[2])
    if (part.position) geometry.translate(...part.position)
    if (!geometry.index) return geometry
    const normalized = geometry.toNonIndexed()
    geometry.dispose()
    return normalized
  })
  const merged = mergeGeometries(geometries, false)
  geometries.forEach((geometry) => geometry.dispose())
  if (!merged) throw new Error('Failed to merge fab detail geometry')
  return merged
}

function addCompound(parent: THREE.Object3D, parts: GeometryPart[], material: THREE.Material, name?: string): THREE.Mesh {
  const source = mergeGeometryParts(parts)
  const geometry = mergeVertices(source)
  source.dispose()
  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  if (name) mesh.name = name
  parent.add(mesh)
  return mesh
}

function addCylinder(parent: THREE.Object3D, radius: number, height: number, position: readonly [number, number, number], material: THREE.Material, radialSegments = 12): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, radialSegments), material)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

export function buildFabScene(layout: FabLayout): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Fab static world'
  addBox(group, [layout.fab.width + 30, 0.12, layout.fab.depth + 40], [0, -0.24, 0], materials.apron, 'exterior-service-apron')
  addBox(group, [layout.fab.width, 0.18, layout.fab.depth], [0, -0.1, 0], materials.floor, 'cleanroom-floor')
  addFloorSystem(group, layout)
  addExitAwareWalls(group, layout, materials.wall)
  addMusterAreas(group, layout)
  addFabStructure(group, layout)
  addOhtInfrastructure(group, layout)
  for (const bay of layout.bays) {
    addBayAccent(group, bay)
    for (const equipment of bay.equipment) addProcessTool(group, equipment, bay.processBand)
  }
  for (const stocker of layout.stockers) addStocker(group, stocker.position)
  for (const device of layout.emergency.safetyDevices) addSafetyDevice(group, device)
  batchStaticMeshes(group)
  return group
}

function addFloorSystem(group: THREE.Group, layout: FabLayout): void {
  const seamMaterial = new THREE.MeshBasicMaterial({ color: 0xb9c7d3, transparent: true, opacity: 0.48 })
  for (let x = -layout.fab.width / 2 + 6; x < layout.fab.width / 2; x += 6) addBox(group, [0.025, 0.007, layout.fab.depth - 0.6], [x, 0, 0], seamMaterial)
  for (let z = -layout.fab.depth / 2 + 6; z < layout.fab.depth / 2; z += 6) addBox(group, [layout.fab.width - 0.6, 0.007, 0.025], [0, 0, z], seamMaterial)
  for (const zone of layout.zones) {
    if (zone.kind !== 'corridor' && zone.kind !== 'transfer-aisle') continue
    const xs = zone.polygon.map((point) => point[0]); const zs = zone.polygon.map((point) => point[1])
    const width = Math.max(...xs) - Math.min(...xs); const depth = Math.max(...zs) - Math.min(...zs)
    const centerX = (Math.max(...xs) + Math.min(...xs)) / 2; const centerZ = (Math.max(...zs) + Math.min(...zs)) / 2
    const material = zone.kind === 'transfer-aisle' ? materials.route : materials.corridor
    addBox(group, [width, 0.012, depth], [centerX, 0.008, centerZ], material, `${zone.kind}:${zone.id}`)
    const longX = width > depth
    const centerline = addBox(group, longX ? [width * 0.92, 0.018, 0.07] : [0.07, 0.018, depth * 0.92], [centerX, 0.018, centerZ], zone.kind === 'transfer-aisle' ? materials.safety : seamMaterial)
    centerline.name = `wayfinding:${zone.id}`
  }
}

function addFabStructure(group: THREE.Group, layout: FabLayout): void {
  const ceilingHeight = Math.min(layout.fab.ceilingHeight, 9)
  const columns = new THREE.Group(); columns.name = 'cleanroom-structural-grid'; group.add(columns)
  for (let x = -96; x <= 96; x += 32) for (let z = -96; z <= 96; z += 48) {
    addBox(columns, [0.42, ceilingHeight, 0.42], [x, ceilingHeight / 2, z], materials.frame)
    addBox(columns, [0.7, 0.12, 0.7], [x, ceilingHeight - 0.15, z], materials.dark)
  }
  const lights = new THREE.InstancedMesh(new THREE.PlaneGeometry(10, 4), materials.whiteLight, 60)
  const matrix = new THREE.Matrix4(); let index = 0
  for (let x = -90; x <= 90; x += 30) for (let z = -84; z <= 84; z += 28) {
    matrix.makeRotationX(Math.PI / 2); matrix.setPosition(x, ceilingHeight - 0.12, z); lights.setMatrixAt(index++, matrix)
  }
  lights.count = index; lights.name = 'cleanroom-ceiling-light-panels'; group.add(lights)
  const cableTrays = new THREE.Group(); cableTrays.name = 'overhead-utility-trays'; group.add(cableTrays)
  for (let z = -84; z <= 84; z += 28) {
    addBox(cableTrays, [layout.fab.width - 8, 0.16, 0.42], [0, ceilingHeight - 0.62, z], materials.dark)
    addBox(cableTrays, [layout.fab.width - 8, 0.045, 0.58], [0, ceilingHeight - 0.48, z], materials.frame)
  }
}

function addBayAccent(group: THREE.Group, bay: FabLayout['bays'][number]): void {
  const points = bay.equipment.map((equipment) => equipment.position)
  const minX = Math.min(...points.map((point) => point[0])) - 3.2; const maxX = Math.max(...points.map((point) => point[0])) + 3.2
  const minZ = Math.min(...points.map((point) => point[2])) - 3.7; const maxZ = Math.max(...points.map((point) => point[2])) + 3.7
  const accent = processFloorMaterial(bandColors[bay.processBand])
  addBox(group, [maxX - minX, 0.012, maxZ - minZ], [(minX + maxX) / 2, 0.016, (minZ + maxZ) / 2], accent, `process-zone:${bay.id}`)
  const line = processLineMaterial(bandColors[bay.processBand])
  addBox(group, [maxX - minX - 0.35, 0.02, 0.1], [(minX + maxX) / 2, 0.026, minZ + 0.16], line)
  addBox(group, [maxX - minX - 0.35, 0.02, 0.1], [(minX + maxX) / 2, 0.026, maxZ - 0.16], line)
}

function addProcessTool(group: THREE.Group, equipment: FabLayout['bays'][number]['equipment'][number], band: ProcessBand): void {
  const profile = equipmentProfiles[equipment.type]
  const tool = new THREE.Group(); tool.name = `process-tool:${equipment.id}`
  tool.position.set(equipment.position[0], 0, equipment.position[2]); tool.rotation.y = equipment.rotation
  group.add(tool)
  const accent = accentMaterial(profile.accent)
  // Anti-vibration plinth, chamfer-like stepped enclosure, and service gap.
  addBox(tool, [profile.width + 0.26, 0.18, profile.depth + 0.26], [0, 0.09, 0], materials.dark)
  addRoundedBox(tool, [profile.width, 0.22, profile.depth], [0, 0.28, 0], 0.07, materials.shellDark)
  addRoundedBox(tool, [profile.width - 0.16, profile.height - 0.38, profile.depth - 0.16], [0, profile.height / 2 + 0.1, 0], 0.12, materials.shell)
  addRoundedBox(tool, [profile.width - 0.42, 0.13, profile.depth - 0.42], [0, profile.height + 0.05, 0], 0.045, materials.frame)
  addBox(tool, [profile.width * 0.78, 0.055, 0.08], [0, profile.height * 0.67, profile.depth / 2 + 0.045], accent)
  // Readable front control column and dark service door.
  addRoundedBox(tool, [0.58, profile.height * 0.58, 0.07], [profile.width * 0.34, profile.height * 0.48, profile.depth / 2 + 0.05], 0.035, materials.shellDark)
  addRoundedBox(tool, [0.38, 0.28, 0.025], [profile.width * 0.34, profile.height * 0.63, profile.depth / 2 + 0.095], 0.018, materials.glass)
  addBox(tool, [0.36, 0.035, 0.025], [profile.width * 0.34, profile.height * 0.83, profile.depth / 2 + 0.1], accent)
  addCylinder(tool, 0.045, 0.04, [profile.width * 0.34, profile.height * 0.43, profile.depth / 2 + 0.11], materials.status, 10).rotation.x = Math.PI / 2
  // Panel seams and service ventilation make the enclosure read as a
  // maintainable machine rather than one large block. They batch back into
  // the existing frame/dark material draws with the rest of the static fab.
  addCompound(tool, [profile.height * 0.28, profile.height * 0.5, profile.height * 0.72].map((y) => ({
    geometry: new THREE.BoxGeometry(profile.width * 0.52, 0.018, 0.028),
    position: [-profile.width * 0.13, y, profile.depth / 2 + 0.09] as const
  })), materials.frame)
  addCompound(tool, [profile.height * 0.34, profile.height * 0.43, profile.height * 0.52].map((y) => ({
    geometry: new THREE.BoxGeometry(0.035, 0.045, profile.depth * 0.36),
    position: [profile.width / 2 + 0.085, y, -profile.depth * 0.12] as const
  })), materials.shellDark)
  const portSpacing = profile.ports === 2 ? profile.width * 0.22 : 0
  for (let index = 0; index < profile.ports; index++) addLoadport(tool, (index - (profile.ports - 1) / 2) * portSpacing, profile, accent, index)
  // Type-specific crown gives each tool a distinctive silhouette at aerial and close range.
  if (equipment.type === 'lithography' || equipment.type === 'metrology') {
    addCylinder(tool, profile.width * 0.18, profile.crown, [-profile.width * 0.12, profile.height + profile.crown / 2, -0.18], materials.shellDark, 16)
    addCylinder(tool, profile.width * 0.12, 0.08, [-profile.width * 0.12, profile.height + profile.crown + 0.04, -0.18], accent, 16)
  } else if (equipment.type === 'furnace') {
    for (const x of [-0.48, 0, 0.48]) addCylinder(tool, 0.18, profile.crown, [x, profile.height + profile.crown / 2, -0.35], materials.shellDark, 12)
  } else if (equipment.type === 'cmp') {
    for (const x of [-profile.width * 0.22, profile.width * 0.22]) addCylinder(tool, 0.42, profile.crown, [x, profile.height + profile.crown / 2, -0.2], materials.shellDark, 16)
  } else if (equipment.type === 'etcher' || equipment.type === 'cvd' || equipment.type === 'pvd') {
    addRoundedBox(tool, [profile.width * 0.48, profile.crown, profile.depth * 0.44], [-profile.width * 0.12, profile.height + profile.crown / 2, -0.22], 0.08, materials.shellDark)
    for (const x of [-profile.width * 0.22, profile.width * 0.04]) {
      addCylinder(tool, 0.11, profile.crown * 0.5, [x, profile.height + profile.crown * 1.05, -0.22], materials.frame, 10)
    }
  } else if (equipment.type === 'implanter') {
    addRoundedBox(tool, [profile.width * 0.7, profile.crown * 0.56, profile.depth * 0.28], [-profile.width * 0.06, profile.height + profile.crown * 0.28, -0.18], 0.07, materials.shellDark)
    const beam = addCylinder(tool, 0.13, profile.width * 0.48, [-profile.width * 0.06, profile.height + profile.crown * 0.73, -0.18], materials.frame, 12)
    beam.rotation.z = Math.PI / 2
  } else if (equipment.type === 'cleaner') {
    for (const x of [-profile.width * 0.23, 0, profile.width * 0.23]) {
      addCylinder(tool, 0.16, profile.crown, [x, profile.height + profile.crown / 2, -0.22], materials.shellDark, 12)
      addCylinder(tool, 0.1, 0.07, [x, profile.height + profile.crown + 0.035, -0.22], accent, 10)
    }
  } else {
    addRoundedBox(tool, [profile.width * 0.45, profile.crown, profile.depth * 0.42], [-profile.width * 0.12, profile.height + profile.crown / 2, -0.22], 0.07, materials.shellDark)
  }
  addUtilityPack(tool, profile, accent)
  if (equipment.hazardCapable) addHazardMarker(tool, profile, band)
}

function addLoadport(tool: THREE.Group, x: number, profile: { width: number; height: number; depth: number }, accent: THREE.Material, index: number): void {
  const port = new THREE.Group(); port.name = `loadport:${index}`; port.position.set(x, 0.57, profile.depth / 2 + 0.15); tool.add(port)
  addRoundedBox(port, [0.78, 0.82, 0.28], [0, 0, 0], 0.055, materials.dark)
  addRoundedBox(port, [0.59, 0.49, 0.035], [0, 0.05, 0.16], 0.025, materials.glass)
  addBox(port, [0.62, 0.045, 0.05], [0, 0.37, 0.18], accent)
  addRoundedBox(port, [0.7, 0.1, 0.35], [0, -0.42, 0], 0.028, materials.frame)
  for (const side of [-1, 1]) addCylinder(port, 0.028, 0.055, [side * 0.28, 0.24, 0.19], accent, 8).rotation.x = Math.PI / 2
}

function addUtilityPack(tool: THREE.Group, profile: { width: number; height: number; depth: number }, accent: THREE.Material): void {
  const x = -profile.width / 2 - 0.18
  addRoundedBox(tool, [0.24, profile.height * 0.54, profile.depth * 0.48], [x, profile.height * 0.48, -profile.depth * 0.14], 0.05, materials.shellDark)
  for (const z of [-0.48, 0, 0.48]) {
    const pipe = addCylinder(tool, 0.065, profile.height * 0.73, [x - 0.14, profile.height * 0.57, z], materials.frame, 10)
    pipe.rotation.z = Math.PI / 2
  }
  addBox(tool, [0.08, profile.height * 0.38, profile.depth * 0.32], [profile.width / 2 + 0.08, profile.height * 0.54, -profile.depth * 0.2], accent)
}

function addHazardMarker(tool: THREE.Group, profile: { width: number; height: number; depth: number }, band: ProcessBand): void {
  const material = new THREE.MeshBasicMaterial({ color: bandColors[band], transparent: true, opacity: 0.9 })
  addBox(tool, [0.06, 0.62, 0.06], [-profile.width / 2 - 0.3, 1.36, profile.depth / 2 + 0.18], materials.frame)
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), material); beacon.position.set(-profile.width / 2 - 0.3, 1.72, profile.depth / 2 + 0.18); tool.add(beacon)
}

function addStocker(group: THREE.Group, position: readonly [number, number, number]): void {
  const profile = equipmentProfiles.stocker; const stocker = new THREE.Group(); stocker.name = 'automated-stocker'; stocker.position.set(position[0], 0, position[2]); group.add(stocker)
  addBox(stocker, [profile.width, profile.height, profile.depth], [0, profile.height / 2, 0], materials.shellDark)
  addBox(stocker, [profile.width - 0.35, profile.height - 0.4, 0.08], [0, profile.height / 2, profile.depth / 2 + 0.045], materials.frame)
  for (let y = 0.52; y < profile.height - 0.2; y += 0.48) {
    addBox(stocker, [profile.width - 0.62, 0.05, 0.13], [0, y, profile.depth / 2 + 0.11], materials.shell)
    for (const x of [-profile.width * 0.28, profile.width * 0.28]) addBox(stocker, [0.06, 0.22, 0.05], [x, y + 0.1, profile.depth / 2 + 0.13], materials.glass)
  }
  addBox(stocker, [0.64, 0.95, 0.18], [0, 0.78, profile.depth / 2 + 0.14], materials.dark)
}

function addOhtInfrastructure(group: THREE.Group, layout: FabLayout): void {
  const rails = new THREE.Group(); rails.name = 'oht-dual-rail-network'; group.add(rails)
  for (const segment of layout.ohtRail.segments) {
    const from = new THREE.Vector3(...segment.from); const to = new THREE.Vector3(...segment.to)
    const delta = new THREE.Vector3().subVectors(to, from); const length = delta.length(); const center = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)
    const rail = new THREE.Group(); rail.position.copy(center); rail.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), delta.normalize()); rails.add(rail)
    for (const lateral of [-0.23, 0.23]) addBox(rail, [length, 0.12, 0.09], [0, 0, lateral], materials.dark)
    addBox(rail, [length, 0.045, 0.62], [0, -0.12, 0], materials.frame)
    const hangerCount = Math.max(1, Math.floor(length / 7))
    for (let index = 0; index <= hangerCount; index++) {
      const x = -length / 2 + index / hangerCount * length
      addBox(rail, [0.06, 0.7, 0.06], [x, 0.38, 0], materials.frame)
      addBox(rail, [0.68, 0.05, 0.1], [x, 0.72, 0], materials.frame)
    }
  }
}

function addSafetyDevice(group: THREE.Group, device: FabLayout['emergency']['safetyDevices'][number]): void {
  const deviceGroup = new THREE.Group(); deviceGroup.name = `safety-device:${device.id}`
  deviceGroup.userData.keepSeparate = true
  deviceGroup.position.set(device.position[0], 0, device.position[2]); deviceGroup.rotation.y = -device.heading; group.add(deviceGroup)
  const deviceColor = device.kind === 'gas-isolation-valve' ? 0xffb020 : 0xff3b30
  const accent = new THREE.MeshStandardMaterial({ color: deviceColor, emissive: deviceColor, emissiveIntensity: 0.45, roughness: 0.3, metalness: 0.6 })
  addCompound(deviceGroup, [
    { geometry: new RoundedBoxGeometry(0.42, 1.43, 0.82, 1, 0.065), position: [0, 0.8, 0] },
    { geometry: new RoundedBoxGeometry(0.54, 0.14, 0.94, 1, 0.04), position: [0, 1.49, 0] },
    { geometry: new THREE.BoxGeometry(0.12, 0.18, 0.68), position: [-0.22, 0.12, 0] },
    { geometry: new THREE.BoxGeometry(0.12, 0.18, 0.68), position: [0.22, 0.12, 0] }
  ], materials.shell, `safety-cabinet:${device.id}`)
  addCompound(deviceGroup, [
    { geometry: new RoundedBoxGeometry(0.32, 0.92, 0.035, 1, 0.025), position: [0.05, 0.82, 0.43] },
    ...[0.57, 0.67, 0.77].map((y): GeometryPart => ({ geometry: new THREE.BoxGeometry(0.21, 0.025, 0.025), position: [0.05, y, 0.46] }))
  ], materials.dark)
  addCompound(deviceGroup, [
    { geometry: new RoundedBoxGeometry(0.18, 0.07, 0.04, 1, 0.018), position: [0.05, 1.23, 0.46] },
    { geometry: new THREE.BoxGeometry(0.03, 0.2, 0.35), position: [GAS_VALVE_WHEEL_OFFSET, 1.38, 0] }
  ], accent)
  const wheelPivot = new THREE.Group(); wheelPivot.name = `safety-wheel:${device.id}`; wheelPivot.position.set(GAS_VALVE_WHEEL_OFFSET, GAS_VALVE_WHEEL_HEIGHT, 0); deviceGroup.add(wheelPivot)
  addCompound(wheelPivot, [
    { geometry: new THREE.TorusGeometry(GAS_VALVE_WHEEL_RING_RADIUS, GAS_VALVE_WHEEL_TUBE_RADIUS, 8, 20), rotation: [0, Math.PI / 2, 0] },
    { geometry: new THREE.BoxGeometry(0.035, 0.36, 0.035) },
    { geometry: new THREE.BoxGeometry(0.035, 0.36, 0.035), rotation: [Math.PI / 2, 0, 0] },
    { geometry: new THREE.BoxGeometry(0.035, 0.36, 0.035), rotation: [Math.PI / 4, 0, 0] },
    { geometry: new THREE.BoxGeometry(0.035, 0.36, 0.035), rotation: [-Math.PI / 4, 0, 0] },
    { geometry: new THREE.CylinderGeometry(0.065, 0.065, 0.08, 10), rotation: [0, 0, Math.PI / 2] },
    { geometry: new THREE.SphereGeometry(0.055, 10, 8), position: [0, 0.18, 0] }
  ], accent, `safety-wheel-assembly:${device.id}`)
}

/**
 * All process tools are static. Merging their transformed geometry once keeps
 * the close-up detail while avoiding thousands of tiny draw calls in an aerial
 * shot. Safety-device descendants remain separate because their valve wheels
 * are animated by SafetyDeviceAnimator.
 */
function batchStaticMeshes(group: THREE.Group): void {
  group.updateMatrixWorld(true)
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>()
  const removable: THREE.Mesh[] = []
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || hasDynamicAncestor(object, group)) return
    const geometry = object.geometry.clone()
    geometry.applyMatrix4(object.matrixWorld)
    const collection = byMaterial.get(object.material) ?? []
    collection.push(geometry); byMaterial.set(object.material, collection); removable.push(object)
  })
  for (const mesh of removable) mesh.parent?.remove(mesh)
  for (const [material, geometries] of byMaterial) {
    const hasIndexed = geometries.some((geometry) => geometry.index !== null)
    const hasNonIndexed = geometries.some((geometry) => geometry.index === null)
    const compatible = hasIndexed && hasNonIndexed
      ? geometries.map((geometry) => {
          if (!geometry.index) return geometry
          const nonIndexed = geometry.toNonIndexed()
          geometry.dispose()
          return nonIndexed
        })
      : geometries
    const geometry = mergeGeometries(compatible, false)
    compatible.forEach((part) => part.dispose())
    if (!geometry) continue
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'batched-static-fab-geometry'; mesh.castShadow = true; mesh.receiveShadow = true
    group.add(mesh)
  }
}

function hasDynamicAncestor(object: THREE.Object3D, root: THREE.Object3D): boolean {
  let cursor: THREE.Object3D | null = object
  while (cursor && cursor !== root) {
    if (cursor.userData.keepSeparate === true) return true
    cursor = cursor.parent
  }
  return false
}

function addExitAwareWalls(group: THREE.Group, layout: FabLayout, material: THREE.Material): void {
  const doorWidth = 4.8; const doorHeight = 3.4
  const horizontalSegment = (layout.fab.width - doorWidth) / 2; const horizontalOffset = doorWidth / 2 + horizontalSegment / 2
  const verticalSegment = (layout.fab.depth - doorWidth) / 2; const verticalOffset = doorWidth / 2 + verticalSegment / 2
  for (const z of [-layout.fab.depth / 2, layout.fab.depth / 2]) {
    addBox(group, [horizontalSegment, layout.fab.wallHeight, 0.3], [-horizontalOffset, layout.fab.wallHeight / 2, z], material)
    addBox(group, [horizontalSegment, layout.fab.wallHeight, 0.3], [horizontalOffset, layout.fab.wallHeight / 2, z], material)
    addBox(group, [doorWidth, layout.fab.wallHeight - doorHeight, 0.3], [0, doorHeight + (layout.fab.wallHeight - doorHeight) / 2, z], material)
    addBox(group, [doorWidth, 0.11, 0.08], [0, doorHeight + 0.08, z * 0.998], materials.frame)
  }
  for (const x of [-layout.fab.width / 2, layout.fab.width / 2]) {
    addBox(group, [0.3, layout.fab.wallHeight, verticalSegment], [x, layout.fab.wallHeight / 2, -verticalOffset], material)
    addBox(group, [0.3, layout.fab.wallHeight, verticalSegment], [x, layout.fab.wallHeight / 2, verticalOffset], material)
    addBox(group, [0.3, layout.fab.wallHeight - doorHeight, doorWidth], [x, doorHeight + (layout.fab.wallHeight - doorHeight) / 2, 0], material)
    addBox(group, [0.08, 0.11, doorWidth], [x * 0.998, doorHeight + 0.08, 0], materials.frame)
  }
}

function addMusterAreas(group: THREE.Group, layout: FabLayout): void {
  const padMaterial = new THREE.MeshStandardMaterial({ color: 0x287454, roughness: 0.78, metalness: 0 })
  const boundaryMaterial = new THREE.MeshBasicMaterial({ color: 0xffd84d })
  const checkInMaterial = new THREE.MeshBasicMaterial({ color: 0x74e5a2 })
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xf7fff9, side: THREE.DoubleSide, transparent: true, opacity: 0.82 })
  const markerGeometry = new THREE.RingGeometry(0.22, 0.27, 16)
  const signMaterial = buildMusterSignMaterial()
  const floorLabelMaterial = buildMusterFloorMaterial()
  const markerCount = layout.emergency.musterPoints.reduce((count, point) => count + point.capacity, 0)
  const markers = new THREE.InstancedMesh(markerGeometry, markerMaterial, markerCount); markers.name = 'muster-position-markers'
  const markerMatrix = new THREE.Matrix4(); const markerRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); let markerIndex = 0
  for (const muster of layout.emergency.musterPoints) {
    const outward = muster.position[2] < 0 ? -1 : 1; const padZ = muster.position[2] + outward * 2.35
    const pad = addBox(group, [12, 0.08, 6.2], [muster.position[0], -0.11, padZ], padMaterial); pad.name = `muster-pad:${muster.id}`
    addBox(group, [12, 0.035, 0.22], [muster.position[0], -0.045, padZ - 3.04], boundaryMaterial)
    addBox(group, [12, 0.035, 0.22], [muster.position[0], -0.045, padZ + 3.04], boundaryMaterial)
    addBox(group, [0.22, 0.035, 6.2], [muster.position[0] - 5.94, -0.045, padZ], boundaryMaterial)
    addBox(group, [0.22, 0.035, 6.2], [muster.position[0] + 5.94, -0.045, padZ], boundaryMaterial)
    addBox(group, [9.4, 0.035, 0.22], [muster.position[0], -0.035, muster.position[2] - outward * 0.18], checkInMaterial)
    const floorLabel = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 2.05), floorLabelMaterial)
    floorLabel.name = `muster-floor-label:${muster.id}`
    floorLabel.position.set(muster.position[0], -0.015, padZ + outward * 1.65)
    floorLabel.rotation.set(-Math.PI / 2, 0, outward > 0 ? Math.PI : 0)
    floorLabel.userData.keepSeparate = true
    group.add(floorLabel)
    const signX = muster.position[0]; const signZ = muster.position[2] + outward * 5.05
    addBox(group, [0.1, 3.1, 0.1], [signX - 1.55, 1.53, signZ], checkInMaterial); addBox(group, [0.1, 3.1, 0.1], [signX + 1.55, 1.53, signZ], checkInMaterial)
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 1.42), signMaterial); sign.name = `muster-sign:${muster.id}`; sign.position.set(signX, 2.7, signZ - outward * 0.055); sign.rotation.y = outward > 0 ? Math.PI : 0; sign.userData.keepSeparate = true; group.add(sign)
    const rearSign = sign.clone(); rearSign.name = `muster-sign-rear:${muster.id}`; rearSign.position.z = signZ + outward * 0.055; rearSign.rotation.y += Math.PI; group.add(rearSign)
    const exit = [...layout.emergency.exits].sort((left, right) => Math.hypot(left.position[0] - muster.position[0], left.position[2] - muster.position[2]) - Math.hypot(right.position[0] - muster.position[0], right.position[2] - muster.position[2]))[0]
    if (exit) { const centerX = (exit.position[0] + muster.position[0]) / 2; const centerZ = (exit.position[2] + muster.position[2]) / 2; const length = Math.hypot(exit.position[0] - muster.position[0], exit.position[2] - muster.position[2]); const path = addBox(group, [length, 0.035, 2.2], [centerX, -0.14, centerZ], checkInMaterial); path.rotation.y = -Math.atan2(exit.position[2] - muster.position[2], exit.position[0] - muster.position[0]); path.name = `muster-egress:${muster.id}` }
    for (const slot of visualMusterSlots(muster.capacity, muster.position[2])) { markerMatrix.compose(new THREE.Vector3(muster.position[0] + slot[0], -0.045, muster.position[2] + slot[1]), markerRotation, new THREE.Vector3(1, 1, 1)); markers.setMatrixAt(markerIndex++, markerMatrix) }
  }
  markers.count = markerIndex; group.add(markers)
}

function buildMusterSignMaterial(): THREE.MeshBasicMaterial {
  const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 288; const context = canvas.getContext('2d')!
  context.fillStyle = '#087443'; context.fillRect(0, 0, canvas.width, canvas.height); context.strokeStyle = '#ffffff'; context.lineWidth = 14; context.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)
  context.fillStyle = '#ffffff'; context.textAlign = 'center'; context.font = '800 82px sans-serif'; context.fillText('대피 구역', canvas.width / 2, 122); context.font = '700 57px sans-serif'; context.fillText('EVACUATION AREA', canvas.width / 2, 218)
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return new THREE.MeshBasicMaterial({ map: texture })
}

function buildMusterFloorMaterial(): THREE.MeshBasicMaterial {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256; const context = canvas.getContext('2d')!
  context.fillStyle = '#126d4a'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = '#ffdd52'; context.lineWidth = 18; context.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)
  context.fillStyle = '#ffffff'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.font = '800 92px sans-serif'; context.fillText('대피 구역  ·  EVACUATION AREA', canvas.width / 2, canvas.height / 2)
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
  return new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
}

function visualMusterSlots(capacity: number, musterZ: number): Array<readonly [number, number]> {
  const radius = 4.35; const spacing = Math.min(0.75, 7.5 / Math.sqrt(Math.max(1, capacity))); const extent = Math.ceil(radius / spacing) + 1; const points: Array<readonly [number, number]> = []; const outward = musterZ < 0 ? -1 : 1
  for (let row = -extent; row <= extent; row++) for (let column = -extent; column <= extent; column++) { const x = spacing * (column + row / 2); const z = spacing * Math.sqrt(3) / 2 * row; if (Math.hypot(x, z) <= radius && z * outward >= -0.001) points.push([x, z]) }
  return points.sort((left, right) => right[1] * outward - left[1] * outward || Math.abs(left[0]) - Math.abs(right[0]) || left[0] - right[0]).slice(0, capacity)
}
