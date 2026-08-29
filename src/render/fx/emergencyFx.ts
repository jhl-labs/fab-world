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
  private readonly flames = instancedMesh(flameLobeGeometry(), new THREE.MeshStandardMaterial({ color: 0xff641f, emissive: 0xff2408, emissiveIntensity: 3.8, roughness: 0.55 }), 28)
  private readonly innerFlames = instancedMesh(
    new THREE.ConeGeometry(0.23, 1.35, 7),
    new THREE.MeshBasicMaterial({ color: 0xffe66b, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    18
  )
  private readonly sparks = instancedMesh(
    new THREE.SphereGeometry(0.045, 6, 4),
    new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    36
  )
  private readonly heatRipples = instancedMesh(
    new THREE.TorusGeometry(0.72, 0.025, 5, 24),
    new THREE.MeshBasicMaterial({ color: 0xffa04d, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    6
  )
  private readonly emberGlow = new THREE.Mesh(
    new THREE.CircleGeometry(1.55, 36),
    new THREE.MeshBasicMaterial({ color: 0xff4b16, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
  )
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
  private emitterX = 0
  private emitterZ = 0

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
    this.innerFlames.name = 'fire-inner-flames'
    this.sparks.name = 'fire-sparks'
    this.heatRipples.name = 'fire-heat-ripples'
    this.emberGlow.name = 'fire-ember-glow'
    this.emberGlow.rotation.x = -Math.PI / 2
    this.emberGlow.position.y = 0.12
    this.smoke.name = 'fire-smoke-cloudlets'
    this.medicalMarker.name = 'medical-incident-beacon'
    this.medicalMarker.position.y = 2.25
    this.medicalMarker.add(this.medicalBeacon, this.medicalCross)
    this.group.add(this.hazard, this.ring, this.light, this.gasCloud, this.gasJet, this.emberGlow, this.flames, this.innerFlames, this.sparks, this.heatRipples, this.smoke, this.medicalMarker)
    this.group.visible = false
    scene.add(this.group)
  }

  setState(
    kind: EmergencyKind | undefined,
    phase: EmergencyPhase,
    position?: readonly [number, number],
    emitterOffset?: readonly [number, number]
  ): void {
    const newIncident = kind !== this.kind || this.phase === 'normal'
    this.kind = kind
    this.phase = phase
    if (newIncident) { this.elapsed = 0; this.radius = 1; this.targetRadius = 1 }
    this.group.visible = phase !== 'normal'
    if (position) this.group.position.set(position[0], 0, position[1])
    this.emitterX = emitterOffset?.[0] ?? 0
    this.emitterZ = emitterOffset?.[1] ?? 0
    this.gasCloud.visible = kind === 'gasLeak'
    this.gasJet.visible = kind === 'gasLeak'
    this.flames.visible = kind === 'fire'
    this.innerFlames.visible = kind === 'fire'
    this.sparks.visible = kind === 'fire'
    this.heatRipples.visible = kind === 'fire'
    this.emberGlow.visible = kind === 'fire'
    this.smoke.visible = kind === 'fire'
    this.medicalMarker.visible = kind === 'medical'
    this.hazard.visible = kind !== 'medical'
    const material = this.hazard.material as THREE.MeshBasicMaterial
    material.color.set(kind === 'fire' ? 0xff6a33 : 0xc8e05a)
    material.opacity = phase === 'allClear' ? 0.1 : kind === 'gasLeak' ? 0.3 : 0.22
    this.light.color.set(kind === 'gasLeak' ? 0xb7d94b : kind === 'fire' ? 0xff6a24 : 0xff3b30)
  }

  setRadius(radius: number): void { this.targetRadius = Math.max(0.1, radius) }

  update(dt: number): void {
    if (!this.group.visible) return
    this.elapsed += dt
    this.radius = THREE.MathUtils.lerp(this.radius, this.targetRadius, 1 - Math.exp(-dt * 5))
    this.hazard.scale.setScalar(this.radius)
    this.ring.scale.setScalar(this.kind === 'medical' ? 3 + Math.sin(this.elapsed * 3) * 0.35 : this.radius * (1 + 0.04 * Math.sin(this.elapsed * 6)))
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = 0.45 + 0.35 * Math.sin(this.elapsed * 6)
    this.light.intensity = this.kind === 'medical' ? 1.5 : this.phase === 'allClear' ? 0.5 : this.kind === 'fire' ? 7.5 + Math.sin(this.elapsed * 11) * 2.2 : 3 + Math.sin(this.elapsed * 8)
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
    for (const mesh of [this.hazard, this.ring, this.gasCloud, this.gasJet, this.emberGlow, this.flames, this.innerFlames, this.sparks, this.heatRipples, this.smoke, this.medicalBeacon, this.medicalCross]) {
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
        (plume ? this.emitterX : 0) + Math.cos(angle) * radial,
        plume ? 0.3 + rise : 0.26 + 0.2 * Math.sin(this.elapsed + index),
        (plume ? this.emitterZ : 0) + Math.sin(angle) * radial
      )
      const size = plume
        ? 0.48 + rise * 0.12 + Math.sin(this.elapsed * 1.4 + index) * 0.06
        : 0.62 + (index % 5) * 0.12 + Math.sin(this.elapsed * 0.7 + index) * 0.08
      particleScale.setScalar(size)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.gasCloud.setMatrixAt(index, particleMatrix)
    }
    this.gasCloud.instanceMatrix.needsUpdate = true
    this.gasJet.position.set(this.emitterX, 0.66, this.emitterZ)
    this.gasJet.scale.set(0.82 + Math.sin(this.elapsed * 8) * 0.12, 0.9 + Math.sin(this.elapsed * 5.4) * 0.12, 0.82 + Math.cos(this.elapsed * 7) * 0.1)
    ;(this.gasJet.material as THREE.MeshBasicMaterial).opacity = 0.42 + Math.sin(this.elapsed * 6.5) * 0.12
  }

  private updateFire(): void {
    this.light.position.set(this.emitterX, 2.6, this.emitterZ)
    this.emberGlow.position.x = this.emitterX
    this.emberGlow.position.z = this.emitterZ
    const glowPulse = 0.92 + Math.sin(this.elapsed * 8.5) * 0.1
    this.emberGlow.scale.setScalar(glowPulse)
    for (let index = 0; index < this.flames.count; index++) {
      const angle = index * 2.1 + Math.sin(this.elapsed * 1.7 + index) * 0.08
      const radial = 0.2 + (index % 7) * 0.19
      const flicker = 0.9 + Math.sin(this.elapsed * (7 + index % 4) + index) * 0.26
      const heightBias = 0.85 + (index % 4) * 0.13
      particlePosition.set(this.emitterX + Math.cos(angle) * radial, 0.92 * heightBias * flicker, this.emitterZ + Math.sin(angle) * radial)
      particleScale.set(0.72 * flicker, (1.08 + heightBias * 0.25) * flicker, 0.72 * flicker)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.flames.setMatrixAt(index, particleMatrix)
    }
    for (let index = 0; index < this.innerFlames.count; index++) {
      const angle = index * 2.47
      const radial = 0.12 + (index % 5) * 0.12
      const flicker = 0.84 + Math.sin(this.elapsed * (9 + index % 3) + index * 0.7) * 0.2
      particlePosition.set(this.emitterX + Math.cos(angle) * radial, 0.66 * flicker, this.emitterZ + Math.sin(angle) * radial)
      particleScale.set(0.72 * flicker, 1.2 * flicker, 0.72 * flicker)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.innerFlames.setMatrixAt(index, particleMatrix)
    }
    for (let index = 0; index < this.sparks.count; index++) {
      const rise = (this.elapsed * (2.2 + index % 4 * 0.18) + index * 0.29) % 5.4
      const angle = index * 2.39 + this.elapsed * (0.65 + index % 3 * 0.12)
      const radial = 0.24 + rise * 0.2
      particlePosition.set(this.emitterX + Math.cos(angle) * radial, 0.55 + rise, this.emitterZ + Math.sin(angle) * radial)
      particleScale.setScalar(0.65 + (index % 4) * 0.13)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.sparks.setMatrixAt(index, particleMatrix)
    }
    particleRotation.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
    for (let index = 0; index < this.heatRipples.count; index++) {
      const rise = (this.elapsed * 0.85 + index * 0.67) % 4.1
      particlePosition.set(this.emitterX, 0.42 + rise, this.emitterZ)
      const spread = 0.65 + rise * 0.28
      particleScale.set(spread, spread, spread)
      particleMatrix.compose(particlePosition, particleRotation, particleScale)
      this.heatRipples.setMatrixAt(index, particleMatrix)
    }
    particleRotation.identity()
    for (let index = 0; index < this.smoke.count; index++) {
      const rise = (this.elapsed * 0.7 + index * 0.38) % 8
      const angle = index * 1.73 + this.elapsed * 0.08
      particlePosition.set(this.emitterX + Math.cos(angle) * (0.35 + rise * 0.12), 2.45 + rise, this.emitterZ + Math.sin(angle) * (0.35 + rise * 0.12))
      particleScale.setScalar(0.7 + rise * 0.16)
      particleMatrix.compose(particlePosition, particleRotation.identity(), particleScale)
      this.smoke.setMatrixAt(index, particleMatrix)
    }
    this.flames.instanceMatrix.needsUpdate = true
    this.innerFlames.instanceMatrix.needsUpdate = true
    this.sparks.instanceMatrix.needsUpdate = true
    this.heatRipples.instanceMatrix.needsUpdate = true
    this.smoke.instanceMatrix.needsUpdate = true
  }
}
