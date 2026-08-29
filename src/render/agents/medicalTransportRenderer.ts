import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { PoseFlags, type EntityMeta } from '../../core/protocol'
import type { PoseReader } from '../interpolate'

interface TransportPart {
  mesh: THREE.InstancedMesh
  offsetY: number
}

export class MedicalTransportRenderer {
  private readonly vehicles: EntityMeta[]
  private readonly parts: TransportPart[] = []
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly rotation = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3()
  private readonly yAxis = new THREE.Vector3(0, 1, 0)

  constructor(private readonly scene: THREE.Scene, entities: EntityMeta[]) {
    this.vehicles = entities.filter((entity) => entity.kind === 'igv')
    const count = Math.max(1, this.vehicles.length)
    this.add('medical-transport-stretcher', stretcherGeometry(), 0xf5f8fb, 0.63, count)
    this.add('medical-transport-rails', railGeometry(), 0x69a8c7, 0.74, count, true)
    this.add('medical-transport-cross', crossGeometry(), 0xd92e42, 0.67, count, true)
    this.add('medical-transport-beacons', beaconGeometry(), 0x36b9ff, 1.03, count, true)
  }

  private add(name: string, geometry: THREE.BufferGeometry, color: number, offsetY: number, count: number, emissive = false): void {
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: emissive ? color : 0x000000,
      emissiveIntensity: emissive ? 1.1 : 0,
      roughness: 0.32,
      metalness: 0.38
    })
    const mesh = new THREE.InstancedMesh(geometry, material, count)
    mesh.name = name
    mesh.castShadow = true
    mesh.frustumCulled = false
    this.parts.push({ mesh, offsetY })
    this.scene.add(mesh)
  }

  update(reader: PoseReader): void {
    this.vehicles.forEach((entity, index) => {
      const pose = reader.pose(entity.index)
      const visible = (pose.flags & PoseFlags.MEDICAL_TRANSPORT) !== 0
      const deployment = THREE.MathUtils.smoothstep(pose.auxA, 0, 1)
      this.rotation.setFromAxisAngle(this.yAxis, -pose.yaw)
      for (const part of this.parts) {
        this.position.set(pose.x, pose.y + part.offsetY + (part.mesh.name === 'medical-transport-rails' ? deployment * 0.11 : 0), pose.z)
        const pulse = part.mesh.name === 'medical-transport-beacons' ? 0.88 + Math.sin(pose.phase * Math.PI * 8) * 0.12 : 1
        this.scale.setScalar(visible ? pulse : 0.001)
        this.matrix.compose(this.position, this.rotation, this.scale)
        part.mesh.setMatrixAt(index, this.matrix)
      }
    })
    for (const part of this.parts) {
      part.mesh.count = this.vehicles.length
      part.mesh.instanceMatrix.needsUpdate = true
    }
  }

  dispose(): void {
    for (const part of this.parts) {
      this.scene.remove(part.mesh)
      part.mesh.geometry.dispose()
      ;(part.mesh.material as THREE.Material).dispose()
    }
  }
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = parts.map((geometry) => {
    if (!geometry.index) return geometry
    const copy = geometry.toNonIndexed()
    geometry.dispose()
    return copy
  })
  const geometry = mergeGeometries(normalized, false)
  normalized.forEach((part) => part.dispose())
  if (!geometry) throw new Error('Failed to merge medical transport geometry')
  return geometry
}

function stretcherGeometry(): THREE.BufferGeometry {
  return merge([
    new RoundedBoxGeometry(1.65, 0.14, 0.9, 2, 0.06),
    new RoundedBoxGeometry(1.42, 0.09, 0.72, 2, 0.04).translate(0, 0.1, 0),
    new THREE.CylinderGeometry(0.09, 0.09, 0.14, 10).rotateX(Math.PI / 2).translate(-0.65, -0.12, 0.43),
    new THREE.CylinderGeometry(0.09, 0.09, 0.14, 10).rotateX(Math.PI / 2).translate(0.65, -0.12, 0.43),
    new THREE.CylinderGeometry(0.09, 0.09, 0.14, 10).rotateX(Math.PI / 2).translate(-0.65, -0.12, -0.43),
    new THREE.CylinderGeometry(0.09, 0.09, 0.14, 10).rotateX(Math.PI / 2).translate(0.65, -0.12, -0.43)
  ])
}

function railGeometry(): THREE.BufferGeometry {
  return merge([
    new RoundedBoxGeometry(1.5, 0.07, 0.07, 1, 0.025).translate(0, 0.13, 0.48),
    new RoundedBoxGeometry(1.5, 0.07, 0.07, 1, 0.025).translate(0, 0.13, -0.48),
    ...[-0.65, 0, 0.65].flatMap((x) => [
      new THREE.CylinderGeometry(0.025, 0.025, 0.3, 7).translate(x, 0, 0.48),
      new THREE.CylinderGeometry(0.025, 0.025, 0.3, 7).translate(x, 0, -0.48)
    ])
  ])
}

function crossGeometry(): THREE.BufferGeometry {
  return merge([
    new RoundedBoxGeometry(0.08, 0.28, 0.09, 1, 0.02).rotateX(Math.PI / 2).translate(0, 0, 0.5),
    new RoundedBoxGeometry(0.08, 0.09, 0.28, 1, 0.02).rotateX(Math.PI / 2).translate(0, 0, 0.5),
    new RoundedBoxGeometry(0.08, 0.28, 0.09, 1, 0.02).rotateX(Math.PI / 2).translate(0, 0, -0.5),
    new RoundedBoxGeometry(0.08, 0.09, 0.28, 1, 0.02).rotateX(Math.PI / 2).translate(0, 0, -0.5)
  ])
}

function beaconGeometry(): THREE.BufferGeometry {
  return merge([
    new THREE.CylinderGeometry(0.085, 0.1, 0.12, 10).translate(-0.62, 0, 0),
    new THREE.CylinderGeometry(0.085, 0.1, 0.12, 10).translate(0.62, 0, 0)
  ])
}
