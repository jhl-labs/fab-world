import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { PoseFlags, type EntityMeta } from '../../core/protocol'
import { PoseReader } from '../interpolate'

interface ArmPart {
  mesh: THREE.InstancedMesh
  color: THREE.Color
  mode: 'base' | 'column' | 'shoulder' | 'upper' | 'elbow' | 'forearm' | 'wrist' | 'palm' | 'finger-left' | 'finger-right' | 'lamp'
}

const Y_AXIS = new THREE.Vector3(0, 1, 0)

export class IndustrialArmRenderer {
  private readonly members: EntityMeta[]
  private readonly parts: ArmPart[] = []
  private readonly matrix = new THREE.Matrix4()
  private readonly quaternion = new THREE.Quaternion()
  private readonly position = new THREE.Vector3()
  private readonly scale = new THREE.Vector3(1, 1, 1)
  private readonly start = new THREE.Vector3()
  private readonly end = new THREE.Vector3()
  private readonly delta = new THREE.Vector3()
  private selected?: number

  constructor(private readonly scene: THREE.Scene, entities: EntityMeta[]) {
    this.members = entities.filter((entity) => entity.kind === 'arm')
    const count = Math.max(1, this.members.length)
    this.addPart('base', new THREE.CylinderGeometry(0.52, 0.58, 0.2, 18), 0x25313b, count)
    this.addPart('column', new THREE.CylinderGeometry(0.36, 0.43, 0.72, 16), 0xf2b632, count)
    this.addPart('shoulder', new THREE.SphereGeometry(0.3, 16, 10), 0x263746, count)
    this.addPart('upper', new RoundedBoxGeometry(0.27, 1, 0.32, 2, 0.085), 0xf5c542, count)
    this.addPart('elbow', new THREE.SphereGeometry(0.25, 14, 10), 0x263746, count)
    this.addPart('forearm', new RoundedBoxGeometry(0.22, 1, 0.27, 2, 0.07), 0xf3b92f, count)
    this.addPart('wrist', new THREE.CylinderGeometry(0.16, 0.18, 0.3, 14), 0x263746, count)
    this.addPart('palm', new RoundedBoxGeometry(0.32, 0.17, 0.48, 2, 0.045), 0x5ecbe5, count, true)
    this.addPart('finger-left', new RoundedBoxGeometry(0.36, 0.08, 0.08, 2, 0.028), 0x263746, count)
    this.addPart('finger-right', new RoundedBoxGeometry(0.36, 0.08, 0.08, 2, 0.028), 0x263746, count)
    this.addPart('lamp', new THREE.SphereGeometry(0.065, 10, 7), 0x57f287, count, true)
  }

  private addPart(mode: ArmPart['mode'], geometry: THREE.BufferGeometry, color: number, count: number, emissive = false): void {
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: emissive ? color : 0x000000,
      emissiveIntensity: emissive ? 0.8 : 0,
      roughness: 0.3,
      metalness: 0.55
    })
    const mesh = new THREE.InstancedMesh(geometry, material, count)
    mesh.name = `industrial-arm-${mode}`
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
    mesh.castShadow = true
    mesh.frustumCulled = false
    this.parts.push({ mesh, color: new THREE.Color(color), mode })
    this.scene.add(mesh)
  }

  update(reader: PoseReader): void {
    for (let index = 0; index < this.members.length; index++) {
      const entity = this.members[index]!
      const pose = reader.pose(entity.index)
      const phase = pose.phase * Math.PI * 2
      const rootYaw = -pose.yaw + Math.sin(phase * 0.47) * 0.3
      const rootY = pose.y - 1
      const shoulderAngle = 0.62 + Math.sin(phase * 0.7) * 0.18
      const forearmAngle = 1.62 + Math.sin(phase * 0.7 + 1.2) * 0.34
      const shoulderHeight = 0.92
      const upperLength = 1.2
      const forearmLength = 0.95
      const shoulder = this.worldPoint(pose.x, rootY, pose.z, rootYaw, 0, shoulderHeight, 0)
      const elbow = this.worldPoint(pose.x, rootY, pose.z, rootYaw, Math.sin(shoulderAngle) * upperLength, shoulderHeight + Math.cos(shoulderAngle) * upperLength, 0)
      const wrist = this.worldPoint(
        pose.x,
        rootY,
        pose.z,
        rootYaw,
        Math.sin(shoulderAngle) * upperLength + Math.sin(forearmAngle) * forearmLength,
        shoulderHeight + Math.cos(shoulderAngle) * upperLength + Math.cos(forearmAngle) * forearmLength,
        0
      )
      const forwardX = Math.cos(rootYaw)
      const forwardZ = -Math.sin(rootYaw)
      const sideX = Math.sin(rootYaw)
      const sideZ = Math.cos(rootYaw)
      const open = 0.12 + (Math.sin(phase * 1.4) * 0.5 + 0.5) * 0.09

      for (const part of this.parts) {
        if (part.mode === 'base') this.compose(index, part, pose.x, rootY + 0.1, pose.z, rootYaw)
        else if (part.mode === 'column') this.compose(index, part, pose.x, rootY + 0.53, pose.z, rootYaw)
        else if (part.mode === 'shoulder') this.compose(index, part, shoulder.x, shoulder.y, shoulder.z, rootYaw)
        else if (part.mode === 'upper') this.composeSegment(index, part, shoulder, elbow)
        else if (part.mode === 'elbow') this.compose(index, part, elbow.x, elbow.y, elbow.z, rootYaw)
        else if (part.mode === 'forearm') this.composeSegment(index, part, elbow, wrist)
        else if (part.mode === 'wrist') this.compose(index, part, wrist.x, wrist.y, wrist.z, rootYaw, Math.PI / 2)
        else if (part.mode === 'palm') this.compose(index, part, wrist.x + forwardX * 0.17, wrist.y, wrist.z + forwardZ * 0.17, rootYaw)
        else if (part.mode === 'finger-left') this.compose(index, part, wrist.x + forwardX * 0.34 + sideX * open, wrist.y, wrist.z + forwardZ * 0.34 + sideZ * open, rootYaw, 0, Math.PI / 2)
        else if (part.mode === 'finger-right') this.compose(index, part, wrist.x + forwardX * 0.34 - sideX * open, wrist.y, wrist.z + forwardZ * 0.34 - sideZ * open, rootYaw, 0, Math.PI / 2)
        else this.compose(index, part, pose.x, rootY + 0.97, pose.z, rootYaw)

        const highlighted = entity.index === this.selected
        const emergency = (pose.flags & PoseFlags.EMERGENCY) !== 0
        part.mesh.setColorAt(index, highlighted ? new THREE.Color(0xffffff) : emergency ? new THREE.Color(0xff5544) : part.color)
      }
    }
    for (const part of this.parts) {
      part.mesh.count = this.members.length
      part.mesh.instanceMatrix.needsUpdate = true
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true
    }
  }

  private worldPoint(x: number, y: number, z: number, yaw: number, localX: number, localY: number, localZ: number): THREE.Vector3 {
    return new THREE.Vector3(
      x + Math.cos(yaw) * localX + Math.sin(yaw) * localZ,
      y + localY,
      z - Math.sin(yaw) * localX + Math.cos(yaw) * localZ
    )
  }

  private compose(index: number, part: ArmPart, x: number, y: number, z: number, yaw: number, pitch = 0, roll = 0): void {
    this.position.set(x, y, z)
    this.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'))
    this.scale.set(1, 1, 1)
    this.matrix.compose(this.position, this.quaternion, this.scale)
    part.mesh.setMatrixAt(index, this.matrix)
  }

  private composeSegment(index: number, part: ArmPart, start: THREE.Vector3, end: THREE.Vector3): void {
    this.start.copy(start)
    this.end.copy(end)
    this.delta.subVectors(this.end, this.start)
    const length = this.delta.length()
    this.position.addVectors(this.start, this.end).multiplyScalar(0.5)
    this.quaternion.setFromUnitVectors(Y_AXIS, this.delta.normalize())
    this.scale.set(1, length, 1)
    this.matrix.compose(this.position, this.quaternion, this.scale)
    part.mesh.setMatrixAt(index, this.matrix)
  }

  select(index?: number): void { this.selected = index }

  dispose(): void {
    for (const part of this.parts) {
      this.scene.remove(part.mesh)
      part.mesh.geometry.dispose()
      ;(part.mesh.material as THREE.Material).dispose()
    }
  }
}
