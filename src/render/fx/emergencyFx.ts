import * as THREE from 'three'
import type { EmergencyKind, EmergencyPhase } from '../../core/schema'

const particleMatrix = new THREE.Matrix4()
const particlePosition = new THREE.Vector3()
const particleScale = new THREE.Vector3()
const particleRotation = new THREE.Quaternion()

function instancedMesh(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.frustumCulled = false
  return mesh
}

export class EmergencyFx {
  private readonly group = new THREE.Group()
  private readonly hazard = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0xc8e05a, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }))
  private readonly ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }))
  private readonly light = new THREE.PointLight(0xff3b30, 0, 26)
  private readonly gasCloud = instancedMesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ color: 0xc8e05a, transparent: true, opacity: 0.12, depthWrite: false }), 32)
  private readonly flames = instancedMesh(new THREE.ConeGeometry(0.45, 1.8, 7), new THREE.MeshStandardMaterial({ color: 0xff7a2f, emissive: 0xff3b18, emissiveIntensity: 2.4, roughness: 0.7 }), 18)
  private readonly smoke = instancedMesh(new THREE.SphereGeometry(0.72, 8, 6), new THREE.MeshLambertMaterial({ color: 0x414954, transparent: true, opacity: 0.22, depthWrite: false }), 24)
  private kind?: EmergencyKind
  private phase: EmergencyPhase = 'normal'
  private elapsed = 0
  private radius = 1
  private targetRadius = 1

  constructor(scene: THREE.Scene) {
    this.hazard.rotation.x = -Math.PI / 2
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.08
    this.light.position.y = 3
    this.group.add(this.hazard, this.ring, this.light, this.gasCloud, this.flames, this.smoke)
    this.group.visible = false
    scene.add(this.group)
  }

  setState(kind: EmergencyKind | undefined, phase: EmergencyPhase, position?: readonly [number, number]): void {
    const newIncident = kind !== this.kind || this.phase === 'normal'
    this.kind = kind
    this.phase = phase
    if (newIncident) { this.elapsed = 0; this.radius = 1; this.targetRadius = 1 }
    this.group.visible = phase !== 'normal'
    if (position) this.group.position.set(position[0], 0, position[1])
    this.gasCloud.visible = kind === 'gasLeak'
    this.flames.visible = kind === 'fire'
    this.smoke.visible = kind === 'fire'
    this.hazard.visible = kind !== 'medical'
    const material = this.hazard.material as THREE.MeshBasicMaterial
    material.color.set(kind === 'fire' ? 0xff6a33 : 0xc8e05a)
    material.opacity = phase === 'allClear' ? 0.1 : 0.22
  }

  setRadius(radius: number): void { this.targetRadius = Math.max(0.1, radius) }

  update(dt: number): void {
    if (!this.group.visible) return
    this.elapsed += dt
    this.radius = THREE.MathUtils.lerp(this.radius, this.targetRadius, 1 - Math.exp(-dt * 5))
    this.hazard.scale.setScalar(this.radius)
    this.ring.scale.setScalar(this.kind === 'medical' ? 3 + Math.sin(this.elapsed * 3) * 0.35 : this.radius * (1 + 0.04 * Math.sin(this.elapsed * 6)))
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = 0.45 + 0.35 * Math.sin(this.elapsed * 6)
    this.light.intensity = this.kind === 'medical' ? 1.5 : this.phase === 'allClear' ? 0.5 : 3 + Math.sin(this.elapsed * 8)
    if (this.kind === 'gasLeak') this.updateGas()
    if (this.kind === 'fire') this.updateFire()
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const mesh of [this.hazard, this.ring, this.gasCloud, this.flames, this.smoke]) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  }

  private updateGas(): void {
    for (let index = 0; index < this.gasCloud.count; index++) {
      const angle = index * 2.399 + this.elapsed * (0.04 + index % 3 * 0.012)
      const radial = this.radius * Math.sqrt((index + 0.5) / this.gasCloud.count) * 0.92
      particlePosition.set(Math.cos(angle) * radial, 0.24 + 0.18 * Math.sin(this.elapsed + index), Math.sin(angle) * radial)
      const size = 0.55 + (index % 5) * 0.11 + Math.sin(this.elapsed * 0.7 + index) * 0.08
      particleScale.setScalar(size)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.gasCloud.setMatrixAt(index, particleMatrix)
    }
    this.gasCloud.instanceMatrix.needsUpdate = true
  }

  private updateFire(): void {
    for (let index = 0; index < this.flames.count; index++) {
      const angle = index * 2.1
      const radial = 0.3 + (index % 6) * 0.22
      const flicker = 0.75 + Math.sin(this.elapsed * (7 + index % 4) + index) * 0.22
      particlePosition.set(Math.cos(angle) * radial, 0.8 * flicker, Math.sin(angle) * radial)
      particleScale.set(0.7 * flicker, flicker, 0.7 * flicker)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.flames.setMatrixAt(index, particleMatrix)
    }
    for (let index = 0; index < this.smoke.count; index++) {
      const rise = (this.elapsed * 0.7 + index * 0.38) % 8
      const angle = index * 1.73 + this.elapsed * 0.08
      particlePosition.set(Math.cos(angle) * (0.35 + rise * 0.12), 1.7 + rise, Math.sin(angle) * (0.35 + rise * 0.12))
      particleScale.setScalar(0.7 + rise * 0.16)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.smoke.setMatrixAt(index, particleMatrix)
    }
    this.flames.instanceMatrix.needsUpdate = true
    this.smoke.instanceMatrix.needsUpdate = true
  }
}
