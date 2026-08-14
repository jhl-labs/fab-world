import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
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

interface GeometryPart {
  geometry: THREE.BufferGeometry
  position?: readonly [number, number, number]
  rotation?: readonly [number, number, number]
  scale?: readonly [number, number, number]
}

function compoundGeometry(parts: GeometryPart[]): THREE.BufferGeometry {
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
  if (!merged) throw new Error('Failed to merge emergency effect geometry')
  return merged
}

function cloudletGeometry(): THREE.BufferGeometry {
  return compoundGeometry([
    { geometry: new THREE.SphereGeometry(0.56, 7, 5), scale: [1.2, 0.78, 1] },
    { geometry: new THREE.SphereGeometry(0.42, 7, 5), position: [0.38, 0.12, -0.08], scale: [1, 0.86, 1.12] },
    { geometry: new THREE.SphereGeometry(0.36, 7, 5), position: [-0.34, 0.08, 0.12], scale: [1.08, 0.82, 1] }
  ])
}

function flameLobeGeometry(): THREE.BufferGeometry {
  return compoundGeometry([
    { geometry: new THREE.ConeGeometry(0.42, 1.75, 7), position: [0, 0, 0] },
    { geometry: new THREE.ConeGeometry(0.24, 1.25, 7), position: [0.27, -0.16, 0.08], rotation: [0.12, 0, -0.2] },
    { geometry: new THREE.ConeGeometry(0.2, 1.05, 7), position: [-0.25, -0.25, -0.08], rotation: [-0.08, 0, 0.24] }
  ])
}

export class EmergencyFx {
  private readonly group = new THREE.Group()
  private readonly hazard = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0xc8e05a, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }))
  private readonly ring = new THREE.Mesh(compoundGeometry([
    { geometry: new THREE.RingGeometry(0.94, 1, 64) },
    { geometry: new THREE.RingGeometry(0.82, 0.845, 64) }
  ]), new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }))
  private readonly light = new THREE.PointLight(0xff3b30, 0, 26)
  private readonly gasCloud = instancedMesh(cloudletGeometry(), new THREE.MeshBasicMaterial({ color: 0xb7d94b, transparent: true, opacity: 0.2, depthWrite: false }), 48)
  private readonly gasJet = new THREE.Mesh(
    compoundGeometry([
      { geometry: new THREE.CylinderGeometry(0.1, 0.26, 1.3, 12, 1, true) },
      { geometry: new THREE.ConeGeometry(0.19, 0.52, 10, 1, true), position: [0, 0.7, 0] },
      { geometry: new THREE.TorusGeometry(0.22, 0.025, 5, 12), position: [0, -0.62, 0], rotation: [Math.PI / 2, 0, 0] }
    ]),
    new THREE.MeshBasicMaterial({ color: 0xd9ef62, transparent: true, opacity: 0.54, depthWrite: false, side: THREE.DoubleSide })
  )
  private readonly flames = instancedMesh(flameLobeGeometry(), new THREE.MeshStandardMaterial({ color: 0xff7a2f, emissive: 0xff3b18, emissiveIntensity: 2.4, roughness: 0.7 }), 18)
  private readonly smoke = instancedMesh(cloudletGeometry(), new THREE.MeshLambertMaterial({ color: 0x414954, transparent: true, opacity: 0.18, depthWrite: false }), 24)
  private readonly medicalMarker = new THREE.Group()
  private readonly medicalBeacon = new THREE.Mesh(
    compoundGeometry([
      { geometry: new THREE.CylinderGeometry(0.42, 0.48, 0.12, 16), rotation: [Math.PI / 2, 0, 0] },
      { geometry: new THREE.TorusGeometry(0.48, 0.035, 6, 20), rotation: [0, Math.PI / 2, 0] },
      { geometry: new THREE.ConeGeometry(0.16, 0.38, 10), position: [0, -0.42, 0] }
    ]),
    new THREE.MeshStandardMaterial({ color: 0xd9384b, emissive: 0xb9152d, emissiveIntensity: 1.8, roughness: 0.3, metalness: 0.18 })
  )
  private readonly medicalCross = new THREE.Mesh(
    compoundGeometry([
      { geometry: new RoundedBoxGeometry(0.08, 0.52, 0.16, 1, 0.025) },
      { geometry: new RoundedBoxGeometry(0.08, 0.16, 0.52, 1, 0.025) }
    ]),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
  )
  private kind?: EmergencyKind
  private phase: EmergencyPhase = 'normal'
  private elapsed = 0
  private radius = 1
  private targetRadius = 1
  private gasEmitterX = 0
  private gasEmitterZ = 0

  constructor(scene: THREE.Scene) {
    this.hazard.rotation.x = -Math.PI / 2
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.08
    this.light.position.y = 3
    this.gasCloud.name = 'gas-leak-cloud'
    this.gasCloud.renderOrder = 5
    this.gasJet.name = 'gas-leak-source-jet'
    this.gasJet.renderOrder = 6
    this.flames.name = 'fire-flame-lobes'
    this.smoke.name = 'fire-smoke-cloudlets'
    this.medicalMarker.name = 'medical-incident-beacon'
    this.medicalMarker.position.y = 2.25
    this.medicalMarker.add(this.medicalBeacon, this.medicalCross)
    this.group.add(this.hazard, this.ring, this.light, this.gasCloud, this.gasJet, this.flames, this.smoke, this.medicalMarker)
    this.group.visible = false
    scene.add(this.group)
  }

  setState(
    kind: EmergencyKind | undefined,
    phase: EmergencyPhase,
    position?: readonly [number, number],
    gasEmitterOffset?: readonly [number, number]
  ): void {
    const newIncident = kind !== this.kind || this.phase === 'normal'
    this.kind = kind
    this.phase = phase
    if (newIncident) { this.elapsed = 0; this.radius = 1; this.targetRadius = 1 }
    this.group.visible = phase !== 'normal'
    if (position) this.group.position.set(position[0], 0, position[1])
    this.gasEmitterX = gasEmitterOffset?.[0] ?? 0
    this.gasEmitterZ = gasEmitterOffset?.[1] ?? 0
    this.gasCloud.visible = kind === 'gasLeak'
    this.gasJet.visible = kind === 'gasLeak'
    this.flames.visible = kind === 'fire'
    this.smoke.visible = kind === 'fire'
    this.medicalMarker.visible = kind === 'medical'
    this.hazard.visible = kind !== 'medical'
    const material = this.hazard.material as THREE.MeshBasicMaterial
    material.color.set(kind === 'fire' ? 0xff6a33 : 0xc8e05a)
    material.opacity = phase === 'allClear' ? 0.1 : kind === 'gasLeak' ? 0.3 : 0.22
    this.light.color.set(kind === 'gasLeak' ? 0xb7d94b : 0xff3b30)
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
    if (this.kind === 'medical') {
      this.medicalMarker.position.y = 2.25 + Math.sin(this.elapsed * 2.4) * 0.12
      this.medicalMarker.rotation.y = this.elapsed * 0.42
      const pulse = 0.9 + Math.sin(this.elapsed * 4.8) * 0.08
      this.medicalCross.scale.setScalar(pulse)
    }
    if (this.kind === 'gasLeak') this.updateGas()
    if (this.kind === 'fire') this.updateFire()
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const mesh of [this.hazard, this.ring, this.gasCloud, this.gasJet, this.flames, this.smoke, this.medicalBeacon, this.medicalCross]) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  }

  private updateGas(): void {
    for (let index = 0; index < this.gasCloud.count; index++) {
      const plume = index < 20
      const angle = index * 2.399 + this.elapsed * (plume ? 0.42 : 0.06 + index % 3 * 0.012)
      const rise = plume ? (this.elapsed * 0.72 + index * 0.29) % 5.8 : 0
      const radial = plume
        ? 0.18 + rise * 0.12
        : this.radius * Math.sqrt((index - 19.5) / (this.gasCloud.count - 20)) * 0.96
      particlePosition.set(
        (plume ? this.gasEmitterX : 0) + Math.cos(angle) * radial,
        plume ? 0.3 + rise : 0.26 + 0.2 * Math.sin(this.elapsed + index),
        (plume ? this.gasEmitterZ : 0) + Math.sin(angle) * radial
      )
      const size = plume
        ? 0.48 + rise * 0.12 + Math.sin(this.elapsed * 1.4 + index) * 0.06
        : 0.62 + (index % 5) * 0.12 + Math.sin(this.elapsed * 0.7 + index) * 0.08
      particleScale.setScalar(size)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.gasCloud.setMatrixAt(index, particleMatrix)
    }
    this.gasCloud.instanceMatrix.needsUpdate = true
    this.gasJet.position.set(this.gasEmitterX, 0.66, this.gasEmitterZ)
    this.gasJet.scale.set(0.82 + Math.sin(this.elapsed * 8) * 0.12, 0.9 + Math.sin(this.elapsed * 5.4) * 0.12, 0.82 + Math.cos(this.elapsed * 7) * 0.1)
    ;(this.gasJet.material as THREE.MeshBasicMaterial).opacity = 0.42 + Math.sin(this.elapsed * 6.5) * 0.12
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
