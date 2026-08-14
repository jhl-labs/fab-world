import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { PoseFlags, type EntityKind, type EntityMeta } from '../../core/protocol'
import { PoseReader } from '../interpolate'

type InstancedKind = Exclude<EntityKind, 'humanoid' | 'person'>
const colors: Record<InstancedKind, number> = { oht: 0x3f7dc2, agv: 0x4e9f91, igv: 0x7896d9, arm: 0xf5c542 }

interface GeometryPart {
  geometry: THREE.BufferGeometry
  position?: readonly [number, number, number]
  rotation?: readonly [number, number, number]
  scale?: readonly [number, number, number]
}

function mergeParts(parts: GeometryPart[]): THREE.BufferGeometry {
  const geometries = parts.map((part) => {
    const geometry = part.geometry
    if (part.scale) geometry.scale(...part.scale)
    if (part.rotation) geometry.rotateX(part.rotation[0]).rotateY(part.rotation[1]).rotateZ(part.rotation[2])
    if (part.position) geometry.translate(...part.position)
    if (!geometry.index) return geometry
    const normalized = geometry.toNonIndexed()
    geometry.dispose()
    return normalized
  })
  const merged = mergeGeometries(geometries, false)
  geometries.forEach((geometry) => geometry.dispose())
  if (!merged) throw new Error('Failed to merge industrial agent geometry')
  return merged
}

function roundedBox(width: number, height: number, depth: number, radius: number): THREE.BufferGeometry {
  return new RoundedBoxGeometry(width, height, depth, 1, radius)
}

function baseGeometry(kind: InstancedKind): THREE.BufferGeometry {
  if (kind === 'oht') return mergeParts([
    { geometry: roundedBox(1.62, 0.36, 0.7, 0.08) },
    { geometry: roundedBox(0.22, 0.29, 0.73, 0.045), position: [0.7, -0.02, 0] },
    { geometry: roundedBox(0.22, 0.29, 0.73, 0.045), position: [-0.7, -0.02, 0] },
    { geometry: new THREE.BoxGeometry(1.18, 0.07, 0.76), position: [0, -0.2, 0] }
  ])
  if (kind === 'agv') return mergeParts([
    { geometry: roundedBox(1.18, 0.37, 0.84, 0.13) },
    { geometry: roundedBox(0.12, 0.24, 0.88, 0.045), position: [0.56, -0.03, 0] },
    { geometry: roundedBox(0.12, 0.24, 0.88, 0.045), position: [-0.56, -0.03, 0] },
    { geometry: new THREE.BoxGeometry(0.76, 0.06, 0.91), position: [0, -0.21, 0] }
  ])
  if (kind === 'igv') return mergeParts([
    { geometry: roundedBox(1.82, 0.54, 1.17, 0.16) },
    { geometry: roundedBox(0.18, 0.3, 1.22, 0.055), position: [0.84, -0.06, 0] },
    { geometry: roundedBox(0.18, 0.3, 1.22, 0.055), position: [-0.84, -0.06, 0] },
    { geometry: new THREE.BoxGeometry(1.28, 0.07, 1.23), position: [0, -0.31, 0] }
  ])
  return mergeParts([
    { geometry: new THREE.CylinderGeometry(0.5, 0.57, 0.26, 14), position: [0, -0.7, 0] },
    { geometry: new THREE.CylinderGeometry(0.34, 0.42, 0.72, 14), position: [0, -0.24, 0] },
    { geometry: new THREE.SphereGeometry(0.31, 12, 8), position: [0, 0.12, 0] }
  ])
}

interface DetailLayer {
  mesh: THREE.InstancedMesh
  offsetY: number
  color: number
}

function detailLayers(kind: InstancedKind, count: number): DetailLayer[] {
  const make = (geometry: THREE.BufferGeometry, color: number, offsetY: number, emissive = false): DetailLayer => {
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: emissive ? color : 0x000000,
      emissiveIntensity: emissive ? 0.55 : 0,
      roughness: emissive ? 0.2 : 0.3,
      metalness: emissive ? 0.38 : 0.62
    })
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count))
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3)
    mesh.castShadow = true; mesh.frustumCulled = false
    return { mesh, offsetY, color }
  }
  if (kind === 'oht') return [
    make(mergeParts([
      { geometry: roundedBox(1.28, 0.13, 0.6, 0.04) },
      ...[-0.42, 0.42].flatMap((x) => [-0.28, 0.28].map((z): GeometryPart => ({
        geometry: new THREE.CylinderGeometry(0.11, 0.11, 0.09, 10), position: [x, 0.07, z], rotation: [Math.PI / 2, 0, 0]
      }))),
      { geometry: new THREE.BoxGeometry(0.46, 0.08, 0.68), position: [0, 0.1, 0] }
    ]), 0x243747, 0.27),
    make(mergeParts([
      { geometry: roundedBox(0.76, 0.11, 0.72, 0.035) },
      { geometry: new THREE.BoxGeometry(0.56, 0.025, 0.77), position: [0, -0.065, 0] },
      { geometry: new THREE.TorusGeometry(0.19, 0.022, 5, 12), position: [0, -0.075, 0], rotation: [Math.PI / 2, 0, 0] }
    ]), 0x66c8ff, 0.04, true),
    make(mergeParts([
      { geometry: roundedBox(0.14, 0.24, 0.12, 0.025) },
      { geometry: new THREE.BoxGeometry(0.48, 0.055, 0.11), position: [0, -0.13, 0] },
      { geometry: new THREE.CylinderGeometry(0.055, 0.07, 0.09, 10), position: [0, -0.18, 0] }
    ]), 0x8a9aad, -0.27)
  ]
  if (kind === 'agv') return [
    make(mergeParts([
      { geometry: roundedBox(0.9, 0.12, 0.68, 0.04) },
      ...[-0.38, 0.38].flatMap((x) => [-0.42, 0.42].map((z): GeometryPart => ({
        geometry: new THREE.CylinderGeometry(0.105, 0.105, 0.075, 10), position: [x, -0.29, z], rotation: [Math.PI / 2, 0, 0]
      }))),
      { geometry: new THREE.BoxGeometry(0.05, 0.14, 0.58), position: [0.48, -0.06, 0] }
    ]), 0x213945, 0.27),
    make(mergeParts([
      { geometry: roundedBox(0.46, 0.12, 0.82, 0.045) },
      { geometry: new THREE.BoxGeometry(0.04, 0.08, 0.64), position: [0.26, 0, 0] },
      { geometry: new THREE.BoxGeometry(0.32, 0.028, 0.87), position: [-0.13, 0.075, 0] }
    ]), 0x62d1bd, 0.32, true),
    make(mergeParts([
      { geometry: new THREE.CylinderGeometry(0.075, 0.085, 0.1, 10) },
      { geometry: new THREE.SphereGeometry(0.065, 10, 7), position: [0, 0.075, 0] },
      { geometry: new THREE.TorusGeometry(0.09, 0.012, 5, 10), position: [0, -0.06, 0], rotation: [Math.PI / 2, 0, 0] }
    ]), 0xf5c542, 0.42, true)
  ]
  if (kind === 'igv') return [
    make(mergeParts([
      { geometry: roundedBox(1.4, 0.15, 1, 0.05) },
      ...[-0.58, 0.58].flatMap((x) => [-0.57, 0.57].map((z): GeometryPart => ({
        geometry: new THREE.CylinderGeometry(0.15, 0.15, 0.1, 12), position: [x, -0.39, z], rotation: [Math.PI / 2, 0, 0]
      }))),
      { geometry: new THREE.BoxGeometry(0.07, 0.18, 0.76), position: [0.75, -0.03, 0] }
    ]), 0x293b54, 0.37),
    make(mergeParts([
      { geometry: roundedBox(0.7, 0.16, 0.88, 0.055) },
      { geometry: new THREE.BoxGeometry(0.05, 0.09, 0.66), position: [0.38, 0, 0] },
      { geometry: new THREE.BoxGeometry(0.46, 0.028, 0.94), position: [-0.13, 0.095, 0] }
    ]), 0x7fc9ff, 0.46, true),
    make(mergeParts([
      { geometry: new THREE.CylinderGeometry(0.11, 0.12, 0.09, 12) },
      { geometry: new THREE.SphereGeometry(0.09, 10, 7), position: [0, 0.075, 0] },
      { geometry: new THREE.TorusGeometry(0.135, 0.014, 5, 12), position: [0, -0.055, 0], rotation: [Math.PI / 2, 0, 0] }
    ]), 0x2ee6e6, 0.57, true)
  ]
  return [
    make(mergeParts([
      { geometry: new THREE.CylinderGeometry(0.48, 0.55, 0.2, 14) },
      { geometry: new THREE.TorusGeometry(0.38, 0.045, 6, 14), position: [0, 0.12, 0], rotation: [Math.PI / 2, 0, 0] }
    ]), 0x2d3b48, 0.1),
    make(mergeParts([
      { geometry: new THREE.CapsuleGeometry(0.1, 0.72, 3, 8), position: [0.12, 0, 0], rotation: [0, 0, -0.45] },
      { geometry: new THREE.SphereGeometry(0.18, 10, 8), position: [0.33, 0.36, 0] },
      { geometry: new THREE.CapsuleGeometry(0.085, 0.58, 3, 8), position: [0.52, 0.61, 0], rotation: [0, 0, 0.9] }
    ]), 0xe5ae33, 1.22),
    make(mergeParts([
      { geometry: roundedBox(0.46, 0.11, 0.15, 0.035) },
      { geometry: new THREE.CylinderGeometry(0.07, 0.07, 0.26, 10), position: [0.27, 0, 0], rotation: [Math.PI / 2, 0, 0] },
      { geometry: new THREE.SphereGeometry(0.075, 10, 7), position: [0.27, 0, 0.17] }
    ]), 0x58c8e8, 1.84, true)
  ]
}

export class AgentRenderer {
  private readonly meshes = new Map<InstancedKind, THREE.InstancedMesh>()
  private readonly details = new Map<InstancedKind, DetailLayer[]>()
  private readonly members = new Map<InstancedKind, EntityMeta[]>()
  private readonly matrix = new THREE.Matrix4()
  private readonly rotation = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3(1, 1, 1)
  private readonly position = new THREE.Vector3()
  private selected?: number
  constructor(private readonly scene: THREE.Scene, entities: EntityMeta[]) {
    const kinds: InstancedKind[] = ['oht', 'agv', 'igv', 'arm']
    for (const kind of kinds) {
      const members = entities.filter((entity) => entity.kind === kind); this.members.set(kind, members)
      const material = new THREE.MeshStandardMaterial({ color: colors[kind], roughness: 0.36, metalness: 0.4, emissive: 0x000000 })
      const mesh = new THREE.InstancedMesh(baseGeometry(kind), material, Math.max(1, members.length)); mesh.name = `agent-${kind}-base`; mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, members.length) * 3), 3); mesh.castShadow = true; mesh.frustumCulled = false
      members.forEach((_, index) => mesh.setColorAt(index, new THREE.Color(colors[kind]))); mesh.instanceColor.needsUpdate = true; this.meshes.set(kind, mesh); scene.add(mesh)
      const layers = detailLayers(kind, members.length)
      this.details.set(kind, layers)
      for (const [layerIndex, layer] of layers.entries()) { layer.mesh.name = `agent-${kind}-detail-${layerIndex}`; members.forEach((_, index) => layer.mesh.setColorAt(index, new THREE.Color(layer.color))); layer.mesh.instanceColor!.needsUpdate = true; scene.add(layer.mesh) }
    }
  }
  update(reader: PoseReader): void {
    for (const [kind, members] of this.members) {
      const mesh = this.meshes.get(kind)!; const baseColor = new THREE.Color(colors[kind]); const emergencyColor = new THREE.Color(0xff3b30)
      const layers = this.details.get(kind) ?? []
      members.forEach((entity, localIndex) => {
        const pose = reader.pose(entity.index)
        this.position.set(pose.x, pose.y, pose.z); this.rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -pose.yaw)
        this.matrix.compose(this.position, this.rotation, this.scale); mesh.setMatrixAt(localIndex, this.matrix)
        const color = entity.index === this.selected ? new THREE.Color(0xffffff) : (pose.flags & PoseFlags.EMERGENCY) !== 0 ? emergencyColor : baseColor
        mesh.setColorAt(localIndex, color)
        for (const layer of layers) {
          this.position.y = pose.y + layer.offsetY
          this.matrix.compose(this.position, this.rotation, this.scale)
          layer.mesh.setMatrixAt(localIndex, this.matrix)
          layer.mesh.setColorAt(localIndex, entity.index === this.selected ? new THREE.Color(0xffffff) : (pose.flags & PoseFlags.EMERGENCY) !== 0 ? emergencyColor : new THREE.Color(layer.color))
        }
      })
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      for (const layer of layers) { layer.mesh.instanceMatrix.needsUpdate = true; if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true }
    }
  }
  select(index?: number): void { this.selected = index }
  dispose(): void {
    for (const mesh of this.meshes.values()) { this.scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose() }
    for (const layers of this.details.values()) for (const layer of layers) { this.scene.remove(layer.mesh); layer.mesh.geometry.dispose(); (layer.mesh.material as THREE.Material).dispose() }
  }
}
