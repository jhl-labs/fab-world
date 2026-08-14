import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  HUMANOID_HAND_RADIUS,
  HUMANOID_LOWER_ARM_LENGTH,
  HUMANOID_SHOULDER_HEIGHT,
  HUMANOID_SHOULDER_LATERAL,
  HUMANOID_UPPER_ARM_LENGTH,
  gasValveGripTarget
} from '../../core/interactionGeometry'
import { PoseFlags, type EntityMeta } from '../../core/protocol'
import type { PoseReader } from '../interpolate'
import { humanoidFootTarget } from './humanoidGait'
import { solveTwoBone, type Vec3Tuple } from './limbIk'

interface ArticulatedLimb {
  root: THREE.Group
  lower: THREE.Group
  end: THREE.Object3D
}

interface HumanoidRig {
  root: THREE.Group
  torso: THREE.Group
  head: THREE.Group
  leftArm: ArticulatedLimb
  rightArm: ArticulatedLimb
  leftLeg: ArticulatedLimb
  rightLeg: ArticulatedLimb
  status: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  medicalKit: THREE.Group
  evacuationBaton: THREE.Group
  batonGlow: THREE.MeshStandardMaterial
  batonLight: THREE.PointLight
  visualPosition: THREE.Vector3
  visualYaw: number
  initialized: boolean
}

const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xe7edf2, roughness: 0.32, metalness: 0.38, vertexColors: true })
const bodyPanelMaterial = new THREE.MeshStandardMaterial({ color: 0xc5d1dc, roughness: 0.27, metalness: 0.58 })
const jointMaterial = new THREE.MeshStandardMaterial({ color: 0x263746, roughness: 0.45, metalness: 0.58 })
const visorMaterial = new THREE.MeshStandardMaterial({ color: 0x16384d, emissive: 0x0f638e, emissiveIntensity: 1.5, roughness: 0.18, metalness: 0.5 })
const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x42c9ee, emissive: 0x167f9f, emissiveIntensity: 0.7, roughness: 0.2, metalness: 0.5 })
const medicalKitMaterial = new THREE.MeshStandardMaterial({ color: 0xd94747, roughness: 0.48, metalness: 0.12 })
const medicalMarkMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current))
  return current + difference * (1 - Math.exp(-lambda * dt))
}

interface BodyGeometryLayer {
  geometry: THREE.BufferGeometry
  tint?: number
}

function articulatedLimb(upperLength: number, lowerLength: number, radius: number, leg = false, side: -1 | 1 = 1): ArticulatedLimb {
  const root = new THREE.Group()
  // Each limb segment moves as one rigid body. Merge its cover, collar, and
  // guard so close-up robots keep their silhouette without spending three
  // draw calls per segment.
  const upper = mergedBodyMesh([
    { geometry: translatedGeometry(new THREE.CapsuleGeometry(radius, upperLength - radius * 2, 4, 8), 0, -upperLength / 2, 0), tint: 0xf5f8fa },
    ...(!leg ? [{ geometry: new THREE.SphereGeometry(radius * 1.04, 10, 8), tint: 0xb7c6d0 }] : []),
    { geometry: translatedGeometry(new RoundedBoxGeometry(radius * 1.72, upperLength * 0.42, radius * 1.42, 1, radius * 0.24), radius * 0.29, -upperLength * 0.5, 0), tint: 0xd4dee5 },
    { geometry: translatedGeometry(new THREE.TorusGeometry(radius * 0.91, radius * 0.13, 5, 10), 0, -upperLength + radius * 0.1, 0), tint: 0x647887 }
  ])
  upper.name = leg ? 'humanoid-thigh-shell' : 'humanoid-upper-arm-shell'
  const lower = new THREE.Group()
  lower.position.y = -upperLength
  const lowerParts: BodyGeometryLayer[] = [
    { geometry: translatedGeometry(new THREE.CapsuleGeometry(radius * 0.9, lowerLength - radius * 1.8, 4, 8), 0, -lowerLength / 2, 0), tint: 0xf5f8fa }
  ]
  const end = leg
    ? mergedMesh([
        translatedGeometry(new RoundedBoxGeometry(0.28, 0.105, radius * 2.1, 1, 0.025), 0.07, 0, 0),
        translatedGeometry(new RoundedBoxGeometry(0.17, 0.07, radius * 2.24, 1, 0.02), -0.1, 0.025, 0),
        translatedGeometry(new RoundedBoxGeometry(0.31, 0.028, radius * 2.24, 1, 0.008), 0.075, -0.063, 0),
        translatedGeometry(new RoundedBoxGeometry(0.065, 0.027, radius * 1.82, 1, 0.008), 0.115, 0.063, 0),
        translatedGeometry(new RoundedBoxGeometry(0.065, 0.027, radius * 1.82, 1, 0.008), 0.04, 0.063, 0)
      ], jointMaterial)
    : mergedMesh([
        new RoundedBoxGeometry(radius * 1.05, radius * 1.35, radius * 1.5, 1, radius * 0.25),
        translatedGeometry(new THREE.TorusGeometry(radius * 0.62, radius * 0.1, 5, 10).rotateX(Math.PI / 2), 0, radius * 0.72, 0),
        ...[-0.38, 0, 0.38].map((lateral) => translatedGeometry(
          new THREE.CapsuleGeometry(radius * 0.14, radius * 0.44, 3, 6),
          radius * 0.04,
          -radius * 0.92,
          lateral * radius
        )),
        translatedGeometry(
          new THREE.CapsuleGeometry(radius * 0.18, radius * 0.38, 3, 6).rotateX(Math.PI / 2).rotateZ(side * 0.16),
          radius * 0.02,
          -radius * 0.12,
          side * radius * 0.82
        )
      ], jointMaterial)
  end.name = leg ? 'humanoid-articulated-foot' : 'humanoid-articulated-hand'
  end.position.set(leg ? 0.1 : 0, -lowerLength, 0)
  if (leg) {
    lowerParts.push(
      { geometry: translatedGeometry(new RoundedBoxGeometry(radius * 1.72, lowerLength * 0.4, radius * 1.35, 1, radius * 0.22), radius * 0.34, -lowerLength * 0.52, 0), tint: 0xd0dbe3 },
      { geometry: translatedGeometry(new RoundedBoxGeometry(radius * 0.34, lowerLength * 0.34, radius * 1.12, 1, radius * 0.1), radius * 0.83, -lowerLength * 0.19, 0), tint: 0x8395a2 },
      { geometry: translatedGeometry(new THREE.TorusGeometry(radius * 0.8, radius * 0.11, 5, 10), 0, -radius * 0.08, 0), tint: 0x647887 }
    )
  } else {
    lowerParts.push(
      { geometry: translatedGeometry(new RoundedBoxGeometry(radius * 1.68, lowerLength * 0.38, radius * 1.4, 1, radius * 0.22), radius * 0.26, -lowerLength * 0.48, 0), tint: 0xd0dbe3 },
      { geometry: translatedGeometry(new RoundedBoxGeometry(radius * 0.28, lowerLength * 0.3, radius * 1.08, 1, radius * 0.1), radius * 0.82, -lowerLength * 0.22, 0), tint: 0x8ba0ad },
      { geometry: translatedGeometry(new THREE.CylinderGeometry(radius, radius * 0.9, radius * 0.52, 10), 0, -lowerLength + radius * 0.12, 0), tint: 0x647887 }
    )
  }
  const lowerShell = mergedBodyMesh(lowerParts)
  lowerShell.name = leg ? 'humanoid-shin-shell' : 'humanoid-forearm-shell'
  lower.add(lowerShell, end)
  root.add(upper, lower)
  return { root, lower, end }
}

function translatedGeometry(geometry: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geometry.translate(x, y, z)
  return geometry
}

function mergedBodyMesh(parts: Array<THREE.BufferGeometry | BodyGeometryLayer>): THREE.Mesh {
  const prepared = parts.map((part) => {
    const layer = part instanceof THREE.BufferGeometry ? { geometry: part } : part
    const geometry = layer.geometry
    const normalized = geometry.index ? geometry.toNonIndexed() : geometry
    if (normalized !== geometry) geometry.dispose()
    const tint = new THREE.Color(layer.tint ?? 0xffffff)
    const colors = new Float32Array(normalized.getAttribute('position').count * 3)
    for (let offset = 0; offset < colors.length; offset += 3) {
      colors[offset] = tint.r
      colors[offset + 1] = tint.g
      colors[offset + 2] = tint.b
    }
    normalized.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return normalized
  })
  const geometry = mergeGeometries(prepared, false)
  prepared.forEach((part) => part.dispose())
  if (!geometry) throw new Error('Failed to merge humanoid body geometry')
  return new THREE.Mesh(geometry, bodyMaterial)
}

function mergedMesh(parts: THREE.BufferGeometry[], material: THREE.Material): THREE.Mesh {
  // Procedural primitives do not all use the same indexed representation
  // (notably RoundedBoxGeometry). Normalize before merging so a visual-only
  // detail can never turn into a renderer boot failure at runtime.
  const normalized = parts.map((part) => {
    if (!part.index) return part
    const nonIndexed = part.toNonIndexed()
    part.dispose()
    return nonIndexed
  })
  const geometry = mergeGeometries(normalized, false)
  normalized.forEach((part) => part.dispose())
  if (!geometry) throw new Error('Failed to merge humanoid limb geometry')
  return new THREE.Mesh(geometry, material)
}

function createRig(): HumanoidRig {
  const root = new THREE.Group()
  const torso = new THREE.Group(); torso.position.y = 1.28
  const chest = mergedBodyMesh([
    { geometry: new RoundedBoxGeometry(0.42, 0.43, 0.48, 1, 0.065), tint: 0xf3f7f9 },
    { geometry: translatedGeometry(new RoundedBoxGeometry(0.32, 0.12, 0.62, 1, 0.045), -0.01, 0.19, 0), tint: 0xd4dee5 },
    { geometry: translatedGeometry(new RoundedBoxGeometry(0.34, 0.18, 0.38, 1, 0.045), -0.015, -0.26, 0), tint: 0xc4d1da },
    { geometry: translatedGeometry(new THREE.TorusGeometry(0.13, 0.025, 6, 16).rotateX(Math.PI / 2).scale(0.85, 1, 1), 0, 0.28, 0), tint: 0x718692 }
  ]); torso.add(chest)
  const torsoPanels = mergedMesh([
    translatedGeometry(new RoundedBoxGeometry(0.035, 0.31, 0.31, 1, 0.014), 0.218, 0.015, 0),
    translatedGeometry(new RoundedBoxGeometry(0.3, 0.12, 0.13, 1, 0.025), 0, 0.2, -0.285),
    translatedGeometry(new RoundedBoxGeometry(0.3, 0.12, 0.13, 1, 0.025), 0, 0.2, 0.285),
    translatedGeometry(new RoundedBoxGeometry(0.04, 0.12, 0.2, 1, 0.012), 0.232, -0.2, 0)
  ], bodyPanelMaterial)
  torso.add(torsoPanels)
  const chestCore = new THREE.Mesh(new RoundedBoxGeometry(0.055, 0.17, 0.245, 1, 0.018), visorMaterial); chestCore.position.x = 0.24; torso.add(chestCore)
  const chestStrip = new THREE.Mesh(new RoundedBoxGeometry(0.026, 0.035, 0.22, 1, 0.01), accentMaterial); chestStrip.position.set(0.249, 0.14, 0); torso.add(chestStrip)
  const pelvis = mergedMesh([
    new RoundedBoxGeometry(0.34, 0.18, 0.39, 1, 0.045),
    translatedGeometry(new THREE.SphereGeometry(0.115, 10, 8), 0, -0.075, -0.16),
    translatedGeometry(new THREE.SphereGeometry(0.115, 10, 8), 0, -0.075, 0.16)
  ], jointMaterial); pelvis.position.y = 0.9; root.add(pelvis, torso)
  const waistRing = new THREE.Mesh(new THREE.TorusGeometry(0.215, 0.024, 6, 18).rotateX(Math.PI / 2).scale(0.83, 1, 1), accentMaterial); waistRing.position.y = 1.015; root.add(waistRing)

  const head = new THREE.Group(); head.position.set(0, 1.73, 0)
  const skull = mergedBodyMesh([
    { geometry: new THREE.CapsuleGeometry(0.17, 0.08, 5, 12).scale(0.92, 1, 1.08), tint: 0xf4f7f9 },
    { geometry: translatedGeometry(new RoundedBoxGeometry(0.12, 0.12, 0.29, 1, 0.025), -0.1, -0.08, 0), tint: 0xd0dbe2 },
    { geometry: translatedGeometry(new THREE.CylinderGeometry(0.105, 0.13, 0.105, 12), 0, -0.22, 0), tint: 0x697d8a }
  ])
  const visor = new THREE.Mesh(new RoundedBoxGeometry(0.065, 0.145, 0.315, 1, 0.03), visorMaterial); visor.position.x = 0.17
  const crown = mergedMesh([
    translatedGeometry(new RoundedBoxGeometry(0.2, 0.06, 0.27, 1, 0.018), -0.015, 0.18, 0),
    translatedGeometry(new RoundedBoxGeometry(0.08, 0.13, 0.045, 1, 0.014), -0.075, 0.08, -0.18),
    translatedGeometry(new RoundedBoxGeometry(0.08, 0.13, 0.045, 1, 0.014), -0.075, 0.08, 0.18)
  ], bodyPanelMaterial)
  const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), accentMaterial); sensor.position.set(0.2, 0.11, 0)
  head.add(skull, visor, crown, sensor); root.add(head)

  const armRadius = HUMANOID_HAND_RADIUS / 0.9
  const leftArm = articulatedLimb(HUMANOID_UPPER_ARM_LENGTH, HUMANOID_LOWER_ARM_LENGTH, armRadius, false, -1); leftArm.root.position.set(0, HUMANOID_SHOULDER_HEIGHT, -HUMANOID_SHOULDER_LATERAL)
  const rightArm = articulatedLimb(HUMANOID_UPPER_ARM_LENGTH, HUMANOID_LOWER_ARM_LENGTH, armRadius, false, 1); rightArm.root.position.set(0, HUMANOID_SHOULDER_HEIGHT, HUMANOID_SHOULDER_LATERAL)
  const leftLeg = articulatedLimb(0.39, 0.39, 0.115, true, -1); leftLeg.root.position.set(0, 0.82, -0.16)
  const rightLeg = articulatedLimb(0.39, 0.39, 0.115, true, 1); rightLeg.root.position.set(0, 0.82, 0.16)
  root.add(leftArm.root, rightArm.root, leftLeg.root, rightLeg.root)

  const statusMaterial = new THREE.MeshStandardMaterial({ color: 0x3ddc84, emissive: 0x3ddc84, emissiveIntensity: 2 })
  const status = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), statusMaterial); status.position.set(0.2, 1.46, 0.22); root.add(status)
  const medicalKit = new THREE.Group()
  const kitCase = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.3), medicalKitMaterial)
  const kitMark = mergedMesh([
    translatedGeometry(new THREE.BoxGeometry(0.012, 0.09, 0.035), 0.126, 0, 0),
    translatedGeometry(new THREE.BoxGeometry(0.012, 0.035, 0.09), 0.126, 0, 0)
  ], medicalMarkMaterial)
  medicalKit.add(kitCase, kitMark)
  medicalKit.position.set(0.12, 1.02, -0.3)
  medicalKit.visible = false
  root.add(medicalKit)
  const evacuationBaton = new THREE.Group()
  evacuationBaton.name = 'evacuation-guidance-baton'
  const batonHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.2, 10), jointMaterial)
  batonHandle.position.y = 0.1
  const batonGlow = new THREE.MeshStandardMaterial({
    color: 0xff7a20,
    emissive: 0xff3b00,
    emissiveIntensity: 4.2,
    transparent: true,
    opacity: 0.94,
    roughness: 0.18,
    metalness: 0.08
  })
  const batonSignal = mergedMesh([
    translatedGeometry(new THREE.CylinderGeometry(0.042, 0.052, 0.66, 12), 0, 0.53, 0),
    translatedGeometry(new THREE.SphereGeometry(0.065, 12, 8), 0, 0.88, 0)
  ], batonGlow)
  const batonLight = new THREE.PointLight(0xff5a18, 0, 4.5, 2)
  batonLight.position.y = 0.62
  evacuationBaton.add(batonHandle, batonSignal, batonLight)
  evacuationBaton.visible = false
  root.add(evacuationBaton)
  const pack = new THREE.Group(); pack.name = 'power-pack'; pack.position.set(-0.08, 1.32, -0.34)
  const packCase = mergedMesh([
    new RoundedBoxGeometry(0.27, 0.39, 0.13, 1, 0.035),
    translatedGeometry(new THREE.CylinderGeometry(0.045, 0.045, 0.31, 10), 0, 0, -0.095),
    translatedGeometry(new THREE.CylinderGeometry(0.045, 0.045, 0.31, 10), 0, 0, 0.095)
  ], jointMaterial)
  const packRail = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.028, 0.024, 1, 0.008), accentMaterial); packRail.position.z = -0.08; packRail.position.y = 0.08
  pack.add(packCase, packRail); root.add(pack)
  root.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true })
  return { root, torso, head, leftArm, rightArm, leftLeg, rightLeg, status, medicalKit, evacuationBaton, batonGlow, batonLight, visualPosition: new THREE.Vector3(), visualYaw: 0, initialized: false }
}

export class HumanoidRenderer {
  private readonly rigs: Array<{ entity: EntityMeta; rig: HumanoidRig }> = []
  private lastUpdatedAt = performance.now()
  constructor(private readonly scene: THREE.Scene, entities: EntityMeta[]) {
    for (const entity of entities.filter((candidate) => candidate.kind === 'humanoid')) {
      const rig = createRig(); rig.root.name = entity.name; scene.add(rig.root); this.rigs.push({ entity, rig })
    }
  }
  update(reader: PoseReader): void {
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastUpdatedAt) / 1000))
    this.lastUpdatedAt = now
    for (const { entity, rig } of this.rigs) {
      const pose = reader.pose(entity.index)
      const pace = pose.animation === 1 ? THREE.MathUtils.clamp(pose.speed / 1.15, 0, 1.25) : 0
      const cycle = pose.phase * Math.PI * 2
      const walk = Math.sin(cycle) * pace
      const bob = pace > 0 ? (1 - Math.cos(cycle * 2)) * 0.009 * Math.min(1, pace) : 0
      if (!rig.initialized) {
        rig.visualPosition.set(pose.x, pose.y, pose.z); rig.visualYaw = -pose.yaw; rig.initialized = true
      } else {
        const positionBlend = 1 - Math.exp(-dt * 15)
        rig.visualPosition.lerp(new THREE.Vector3(pose.x, pose.y, pose.z), positionBlend)
        rig.visualYaw = dampAngle(rig.visualYaw, -pose.yaw, 15, dt)
      }
      rig.root.position.set(rig.visualPosition.x, rig.visualPosition.y + bob, rig.visualPosition.z)
      rig.root.rotation.y = rig.visualYaw
      const leftFoot = humanoidFootTarget(pose.phase, pose.animation === 1 ? pose.speed : 0)
      const rightFoot = humanoidFootTarget(pose.phase, pose.animation === 1 ? pose.speed : 0, true)
      applyLegIk(rig.leftLeg, [leftFoot.forward, leftFoot.height, -0.16], -1)
      applyLegIk(rig.rightLeg, [rightFoot.forward, rightFoot.height, 0.16], 1)
      rig.leftArm.root.rotation.set(-0.045 * pace, 0, -walk * 0.34)
      rig.rightArm.root.rotation.set(0.045 * pace, 0, walk * 0.34)
      const elbowFlex = -0.24 - Math.abs(walk) * 0.1
      rig.leftArm.lower.rotation.set(0, 0, elbowFlex)
      rig.rightArm.lower.rotation.set(0, 0, elbowFlex)
      const supportSway = (leftFoot.stance ? -1 : 1) * Math.sin(cycle) * 0.018 * Math.min(1, pace)
      rig.torso.rotation.set(supportSway, 0, pace > 0 ? -0.025 * Math.min(1, pace) : 0)
      rig.head.rotation.set(0, 0, 0)
      rig.head.rotation.x = -supportSway * 0.55
      rig.head.rotation.y = pose.animation === 4 ? Math.sin(pose.phase * Math.PI * 4) * 0.26 : 0
      rig.torso.rotation.z = pose.animation === 4 ? -0.08 : 0
      const carryingMedicalKit = pose.auxB > 0.5
      rig.medicalKit.visible = carryingMedicalKit
      rig.medicalKit.position.set(0.12, 1.02, -0.3)
      rig.medicalKit.rotation.set(0, 0, 0)
      if (pose.animation === 5) {
        const gasManipulation = pose.auxB < -0.5
        const reach = THREE.MathUtils.smoothstep(pose.auxA, 0, gasManipulation ? 0.17 : 0.55)
        const manipulation = THREE.MathUtils.smoothstep(pose.auxA, gasManipulation ? 0.18 : 0.45, gasManipulation ? 0.74 : 1)
        if (gasManipulation) {
          const measuredHands =
            (pose.flags & PoseFlags.MEASURED_HAND_POSE) !== 0 &&
            pose.leftHandPosition !== undefined &&
            pose.rightHandPosition !== undefined
          applyArmIk(
            rig.leftArm,
            measuredHands ? pose.leftHandPosition! : gasValveGripTarget(-1, manipulation),
            measuredHands ? 1 : reach,
            -1
          )
          applyArmIk(
            rig.rightArm,
            measuredHands ? pose.rightHandPosition! : gasValveGripTarget(1, manipulation),
            measuredHands ? 1 : reach,
            1
          )
          rig.torso.rotation.z = -0.045 * reach
          rig.head.rotation.z = -0.08 * reach
        } else {
          rig.rightArm.root.rotation.z = THREE.MathUtils.lerp(0, 1.48, reach)
          rig.rightArm.root.rotation.x = -0.12 * reach
          rig.rightArm.lower.rotation.z = THREE.MathUtils.lerp(-0.18, -0.28, reach)
          rig.rightArm.lower.rotation.y = Math.sin(manipulation * Math.PI * 2) * 0.16
          rig.leftArm.root.rotation.z = -0.2 * reach
          rig.torso.rotation.z = -0.07 * reach
          rig.head.rotation.z = -0.1 * reach
        }
        if (carryingMedicalKit && !gasManipulation) {
          rig.leftArm.root.rotation.z = 1.05 * reach
          rig.leftArm.lower.rotation.z = -0.42 * reach
          rig.rightArm.root.rotation.z = 0.82 * reach
          rig.medicalKit.position.set(
            THREE.MathUtils.lerp(0.12, 0.52, reach),
            THREE.MathUtils.lerp(1.02, 1.18, reach),
            THREE.MathUtils.lerp(-0.3, 0, reach)
          )
          rig.medicalKit.rotation.z = -0.12 * reach
        }
      }
      if (pose.animation === 6) {
        const report = THREE.MathUtils.smoothstep(pose.auxA, 0, 0.45)
        rig.leftArm.root.rotation.z = -0.9 * report
        rig.leftArm.lower.rotation.z = -0.45 * report
        rig.head.rotation.y = 0.25 * report
      }
      const evacuationGuide = (pose.flags & PoseFlags.EVACUATION_GUIDE) !== 0
      rig.evacuationBaton.visible = evacuationGuide
      if (evacuationGuide) {
        const signal = now / 1_000 * 4.6 + entity.index * 1.7
        const wave = Math.sin(signal)
        const handTarget: Vec3Tuple = [0.28, 1.33, 0.48]
        rig.evacuationBaton.position.set(...handTarget)
        rig.evacuationBaton.rotation.set(wave * 0.08, 0, -0.12 + wave * 0.16)
        applyArmIk(rig.rightArm, handTarget, 1, 1)
        // The free arm points toward the safe flow while the lit baton remains
        // high enough to read above an evacuating crowd.
        applyArmIk(rig.leftArm, [0.34, 1.24, -0.48], 0.88, -1)
        const pulse = 0.68 + 0.32 * Math.sin(signal * 2.25)
        rig.batonGlow.emissiveIntensity = 3.4 + pulse * 2.2
        rig.batonLight.intensity = 1.8 + pulse * 2.6
      } else {
        rig.batonLight.intensity = 0
      }
      const emergency = (pose.flags & PoseFlags.EMERGENCY) !== 0
      const controlled = (pose.flags & PoseFlags.RMF_CONTROLLED) !== 0
      const safeStop = (pose.flags & PoseFlags.SAFE_STOP) !== 0
      rig.status.material.color.setHex(safeStop ? 0xff3b30 : emergency ? 0xffa726 : controlled ? 0x42a5f5 : 0x3ddc84)
      rig.status.material.emissive.copy(rig.status.material.color)
    }
  }
  dispose(): void {
    for (const { rig } of this.rigs) {
      this.scene.remove(rig.root)
      rig.root.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose()
      })
      rig.batonGlow.dispose()
    }
  }
}

const down = new THREE.Vector3(0, -1, 0)

function applyArmIk(limb: ArticulatedLimb, grip: Vec3Tuple, reach: number, side: -1 | 1): void {
  const shoulder: Vec3Tuple = [limb.root.position.x, limb.root.position.y, limb.root.position.z]
  const rest: Vec3Tuple = [
    shoulder[0],
    shoulder[1] - HUMANOID_UPPER_ARM_LENGTH - HUMANOID_LOWER_ARM_LENGTH,
    shoulder[2]
  ]
  const target: Vec3Tuple = [
    THREE.MathUtils.lerp(rest[0], grip[0], reach),
    THREE.MathUtils.lerp(rest[1], grip[1], reach),
    THREE.MathUtils.lerp(rest[2], grip[2], reach)
  ]
  const solution = solveTwoBone(
    shoulder,
    target,
    HUMANOID_UPPER_ARM_LENGTH,
    HUMANOID_LOWER_ARM_LENGTH,
    [0, -1, side * 0.18]
  )
  const upperDirection = new THREE.Vector3(...solution.upperDirection)
  const lowerDirection = new THREE.Vector3(...solution.lowerDirection)
  limb.root.quaternion.setFromUnitVectors(down, upperDirection)
  const lowerLocal = lowerDirection.applyQuaternion(limb.root.quaternion.clone().invert())
  limb.lower.quaternion.setFromUnitVectors(down, lowerLocal)
}

function applyLegIk(limb: ArticulatedLimb, foot: Vec3Tuple, side: -1 | 1): void {
  const hip: Vec3Tuple = [limb.root.position.x, limb.root.position.y, limb.root.position.z]
  const solution = solveTwoBone(hip, foot, 0.39, 0.39, [0.28, -1, side * 0.02])
  const upperDirection = new THREE.Vector3(...solution.upperDirection)
  const lowerDirection = new THREE.Vector3(...solution.lowerDirection)
  limb.root.quaternion.setFromUnitVectors(down, upperDirection)
  const lowerLocal = lowerDirection.applyQuaternion(limb.root.quaternion.clone().invert())
  limb.lower.quaternion.setFromUnitVectors(down, lowerLocal)
  const combined = limb.root.quaternion.clone().multiply(limb.lower.quaternion)
  limb.end.quaternion.copy(combined.invert())
}
