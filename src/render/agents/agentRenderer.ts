import * as THREE from 'three'
import { PoseFlags, type EntityKind, type EntityMeta } from '../../core/protocol'
import { PoseReader } from '../interpolate'

type InstancedKind = Exclude<EntityKind, 'humanoid' | 'person'>
const colors: Record<InstancedKind, number> = { oht: 0x3f7dc2, agv: 0x4e9f91, igv: 0x7896d9, arm: 0xf5c542 }
const geometry: Record<InstancedKind, THREE.BufferGeometry> = {
  oht: new THREE.BoxGeometry(1.7, 0.45, 0.75), agv: new THREE.BoxGeometry(1.25, 0.45, 0.9), igv: new THREE.BoxGeometry(1.9, 0.62, 1.25), arm: new THREE.BoxGeometry(0.8, 1.7, 0.8)
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
    make(new THREE.BoxGeometry(1.3, 0.12, 0.64), 0x243747, 0.27),
    make(new THREE.BoxGeometry(0.78, 0.12, 0.78), 0x66c8ff, 0.04, true),
    make(new THREE.BoxGeometry(0.14, 0.22, 0.12), 0x8a9aad, -0.27)
  ]
  if (kind === 'agv') return [
    make(new THREE.BoxGeometry(0.92, 0.12, 0.7), 0x213945, 0.27),
    make(new THREE.BoxGeometry(0.44, 0.12, 0.91), 0x62d1bd, 0.32, true),
    make(new THREE.CylinderGeometry(0.075, 0.075, 0.11, 10), 0xf5c542, 0.42, true)
  ]
  if (kind === 'igv') return [
    make(new THREE.BoxGeometry(1.42, 0.14, 1.02), 0x293b54, 0.37),
    make(new THREE.BoxGeometry(0.68, 0.16, 0.9), 0x7fc9ff, 0.46, true),
    make(new THREE.CylinderGeometry(0.11, 0.11, 0.09, 12), 0x2ee6e6, 0.57, true)
  ]
  return [
    make(new THREE.CylinderGeometry(0.48, 0.55, 0.2, 14), 0x2d3b48, 0.1),
    make(new THREE.BoxGeometry(0.16, 1.24, 0.18), 0xe5ae33, 1.22),
    make(new THREE.BoxGeometry(0.52, 0.1, 0.14), 0x58c8e8, 1.84, true)
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
      const mesh = new THREE.InstancedMesh(geometry[kind], material, Math.max(1, members.length)); mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, members.length) * 3), 3); mesh.castShadow = true; mesh.frustumCulled = false
      members.forEach((_, index) => mesh.setColorAt(index, new THREE.Color(colors[kind]))); mesh.instanceColor.needsUpdate = true; this.meshes.set(kind, mesh); scene.add(mesh)
      const layers = detailLayers(kind, members.length)
      this.details.set(kind, layers)
      for (const layer of layers) { members.forEach((_, index) => layer.mesh.setColorAt(index, new THREE.Color(layer.color))); layer.mesh.instanceColor!.needsUpdate = true; scene.add(layer.mesh) }
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
