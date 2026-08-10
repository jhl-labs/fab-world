import * as THREE from 'three'
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
  visualPosition: THREE.Vector3
  visualYaw: number
  initialized: boolean
}

const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xe7edf2, roughness: 0.32, metalness: 0.38 })
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

function articulatedLimb(upperLength: number, lowerLength: number, radius: number, leg = false): ArticulatedLimb {
  const root = new THREE.Group()
  // Each limb segment moves as one rigid body. Merge its cover, collar, and
  // guard so close-up robots keep their silhouette without spending three
  // draw calls per segment.
  const upper = mergedBodyMesh([
    translatedGeometry(new THREE.CapsuleGeometry(radius, upperLength - radius * 2, 4, 8), 0, -upperLength / 2, 0),
    new THREE.SphereGeometry(radius * 1.12, 10, 8),
    translatedGeometry(new THREE.BoxGeometry(radius * 1.62, upperLength * 0.36, radius * 1.3), 0, -upperLength * 0.52, 0)
  ])
  const lower = new THREE.Group()
  lower.position.y = -upperLength
  const lowerParts = [
    translatedGeometry(new THREE.CapsuleGeometry(radius * 0.9, lowerLength - radius * 1.8, 4, 8), 0, -lowerLength / 2, 0)
  ]
  const end = leg
    ? new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, radius * 2.1), jointMaterial)
    : new THREE.Mesh(new THREE.SphereGeometry(radius * 0.9, 10, 8), jointMaterial)
  end.position.set(leg ? 0.1 : 0, -lowerLength, 0)
  if (leg) {
    lowerParts.push(translatedGeometry(new THREE.BoxGeometry(radius * 1.55, lowerLength * 0.38, radius * 1.25), 0.04, -lowerLength * 0.54, 0))
  } else {
    lowerParts.push(translatedGeometry(new THREE.CylinderGeometry(radius, radius, radius * 0.52, 10), 0, -lowerLength + radius * 0.12, 0))
  }
  lower.add(mergedBodyMesh(lowerParts), end)
  root.add(upper, lower)
  return { root, lower, end }
}

function translatedGeometry(geometry: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geometry.translate(x, y, z)
  return geometry
}

function mergedBodyMesh(parts: THREE.BufferGeometry[]): THREE.Mesh {
  const geometry = mergeGeometries(parts, false)
  parts.forEach((part) => part.dispose())
  if (!geometry) throw new Error('Failed to merge humanoid limb geometry')
  return new THREE.Mesh(geometry, bodyMaterial)
}

function createRig(): HumanoidRig {
  const root = new THREE.Group()
  const torso = new THREE.Group(); torso.position.y = 1.28
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.55, 0.56), bodyMaterial); torso.add(chest)
  const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.035), bodyPanelMaterial); chestPlate.position.set(0.04, 0.04, 0.295); torso.add(chestPlate)
  const chestCore = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.3), visorMaterial); chestCore.position.x = 0.2; torso.add(chestCore)
  const chestStrip = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.025, 0.04), accentMaterial); chestStrip.position.set(0.05, 0.17, 0.32); torso.add(chestStrip)
  for (const side of [-1, 1]) {
    const shoulderPlate = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.3), bodyPanelMaterial)
    shoulderPlate.position.set(0, 0.2, side * 0.31); torso.add(shoulderPlate)
  }
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.22, 0.48), jointMaterial); pelvis.position.y = 0.9; root.add(pelvis, torso)
  const waistRing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.5), accentMaterial); waistRing.position.y = 1.01; root.add(waistRing)

  const head = new THREE.Group(); head.position.set(0, 1.73, 0)
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), bodyMaterial); skull.scale.set(0.9, 1.08, 1)
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.32), visorMaterial); visor.position.x = 0.19
  const crown = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.055, 0.28), bodyPanelMaterial); crown.position.y = 0.18
  const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), accentMaterial); sensor.position.set(0.2, 0.11, 0)
  head.add(skull, visor, crown, sensor); root.add(head)

  const armRadius = HUMANOID_HAND_RADIUS / 0.9
  const leftArm = articulatedLimb(HUMANOID_UPPER_ARM_LENGTH, HUMANOID_LOWER_ARM_LENGTH, armRadius); leftArm.root.position.set(0, HUMANOID_SHOULDER_HEIGHT, -HUMANOID_SHOULDER_LATERAL)
  const rightArm = articulatedLimb(HUMANOID_UPPER_ARM_LENGTH, HUMANOID_LOWER_ARM_LENGTH, armRadius); rightArm.root.position.set(0, HUMANOID_SHOULDER_HEIGHT, HUMANOID_SHOULDER_LATERAL)
  const leftLeg = articulatedLimb(0.39, 0.39, 0.115, true); leftLeg.root.position.set(0, 0.82, -0.16)
  const rightLeg = articulatedLimb(0.39, 0.39, 0.115, true); rightLeg.root.position.set(0, 0.82, 0.16)
  root.add(leftArm.root, rightArm.root, leftLeg.root, rightLeg.root)

  const statusMaterial = new THREE.MeshStandardMaterial({ color: 0x3ddc84, emissive: 0x3ddc84, emissiveIntensity: 2 })
  const status = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), statusMaterial); status.position.set(0.2, 1.46, 0.22); root.add(status)
  const medicalKit = new THREE.Group()
  const kitCase = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.3), medicalKitMaterial)
  const verticalMark = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.09, 0.035), medicalMarkMaterial); verticalMark.position.x = 0.126
  const horizontalMark = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.035, 0.09), medicalMarkMaterial); horizontalMark.position.x = 0.126
  medicalKit.add(kitCase, verticalMark, horizontalMark)
  medicalKit.position.set(0.12, 1.02, -0.3)
  medicalKit.visible = false
  root.add(medicalKit)
  const pack = new THREE.Group(); pack.name = 'power-pack'; pack.position.set(-0.08, 1.32, -0.34)
  const packCase = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.43, 0.14), jointMaterial)
  const packRail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.025, 0.02), accentMaterial); packRail.position.z = -0.08; packRail.position.y = 0.08
  pack.add(packCase, packRail); root.add(pack)
  root.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true })
  return { root, torso, head, leftArm, rightArm, leftLeg, rightLeg, status, medicalKit, visualPosition: new THREE.Vector3(), visualYaw: 0, initialized: false }
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
      rig.leftArm.root.rotation.set(0, 0, -walk * 0.34)
      rig.rightArm.root.rotation.set(0, 0, walk * 0.34)
      rig.leftArm.lower.rotation.set(0, 0, -0.18)
      rig.rightArm.lower.rotation.set(0, 0, -0.18)
      const supportSway = (leftFoot.stance ? -1 : 1) * Math.sin(cycle) * 0.018 * Math.min(1, pace)
      rig.torso.rotation.set(supportSway, 0, pace > 0 ? -0.025 * Math.min(1, pace) : 0)
      rig.head.rotation.set(0, 0, 0)
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
