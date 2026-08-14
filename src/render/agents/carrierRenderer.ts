import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { EntityMeta } from '../../core/protocol'
import type { PoseReader } from '../interpolate'

export class CarrierRenderer {
  private readonly vehicles: EntityMeta[]
  private readonly mesh: THREE.InstancedMesh
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly rotation = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3()
  private readonly yAxis = new THREE.Vector3(0, 1, 0)

  constructor(private readonly scene: THREE.Scene, entities: EntityMeta[]) {
    this.vehicles = entities.filter((entity) => entity.kind === 'oht' || entity.kind === 'agv' || entity.kind === 'igv')
    this.mesh = new THREE.InstancedMesh(
      carrierGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x7b3f2a, roughness: 0.52, metalness: 0.18 }),
      Math.max(1, this.vehicles.length)
    )
    this.mesh.name = 'vehicle-wafer-carriers'
    this.mesh.castShadow = true
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  update(reader: PoseReader): void {
    this.vehicles.forEach((entity, index) => {
      const pose = reader.pose(entity.index)
      const visible = pose.auxA > 0.5
      const hoistDrop = entity.kind === 'oht' ? (1 - pose.auxB) * 2.5 : 0
      this.position.set(pose.x, pose.y + (entity.kind === 'oht' ? -0.48 - hoistDrop : 0.48), pose.z)
      this.rotation.setFromAxisAngle(this.yAxis, -pose.yaw)
      this.scale.setScalar(visible ? 1 : 0.001)
      this.matrix.compose(this.position, this.rotation, this.scale)
      this.mesh.setMatrixAt(index, this.matrix)
    })
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

function carrierGeometry(): THREE.BufferGeometry {
  const parts = [
    new RoundedBoxGeometry(0.7, 0.31, 0.58, 1, 0.07),
    new RoundedBoxGeometry(0.76, 0.055, 0.62, 1, 0.018).translate(0, -0.18, 0),
    new RoundedBoxGeometry(0.5, 0.055, 0.08, 1, 0.018).translate(0, 0.18, 0),
    new THREE.TorusGeometry(0.12, 0.026, 5, 12).rotateX(Math.PI / 2).scale(1.5, 1, 1).translate(0, 0.23, 0),
    ...[-0.22, 0, 0.22].map((z) => new THREE.BoxGeometry(0.025, 0.25, 0.035).translate(0.355, 0, z))
  ].map((geometry) => {
    if (!geometry.index) return geometry
    const normalized = geometry.toNonIndexed()
    geometry.dispose()
    return normalized
  })
  const merged = mergeGeometries(parts, false)
  parts.forEach((geometry) => geometry.dispose())
  if (!merged) throw new Error('Failed to merge wafer carrier geometry')
  return merged
}
