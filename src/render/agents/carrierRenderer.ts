import * as THREE from 'three'
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
      new THREE.BoxGeometry(0.76, 0.34, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x7b3f2a, roughness: 0.52, metalness: 0.18 }),
      Math.max(1, this.vehicles.length)
    )
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
