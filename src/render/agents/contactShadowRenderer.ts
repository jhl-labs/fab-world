import * as THREE from 'three'
import type { EntityKind, EntityMeta } from '../../core/protocol'
import type { PoseReader } from '../interpolate'

const radiusByKind: Record<EntityKind, number> = {
  oht: 0.75,
  agv: 0.72,
  igv: 1,
  humanoid: 0.42,
  person: 0.3,
  arm: 0
}

/** A single dynamic draw call that grounds moving agents while static scene shadows stay cached. */
export class ContactShadowRenderer {
  private readonly members: EntityMeta[]
  private readonly mesh: THREE.InstancedMesh
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
  private readonly scale = new THREE.Vector3()

  constructor(private readonly scene: THREE.Scene, entities: EntityMeta[]) {
    this.members = entities.filter((entity) => entity.kind !== 'arm')
    this.mesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 16),
      new THREE.MeshBasicMaterial({
        color: 0x17212b,
        transparent: true,
        opacity: 0.13,
        depthWrite: false
      }),
      Math.max(1, this.members.length)
    )
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
    this.scene.add(this.mesh)
  }

  update(reader: PoseReader): void {
    this.members.forEach((entity, index) => {
      const pose = reader.pose(entity.index)
      const radius = radiusByKind[entity.kind]
      const motionStretch = 1 + Math.min(0.25, pose.speed * 0.08)
      this.position.set(pose.x, 0.025, pose.z)
      this.scale.set(radius * motionStretch, radius, 1)
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
