import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { PoseFlags, type EntityMeta } from '../../core/protocol'
import type { PoseReader } from '../interpolate'

type BodyPart =
  | 'head'
  | 'visor'
  | 'mask'
  | 'goggles'
  | 'eyes'
  | 'hardhat'
  | 'hardhatBrim'
  | 'torso'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftForearm'
  | 'rightForearm'
  | 'leftHand'
  | 'rightHand'
  | 'leftThigh'
  | 'rightThigh'
  | 'leftShin'
  | 'rightShin'
  | 'leftBoot'
  | 'rightBoot'
  | 'medicalKit'
  | 'medicalMarkVertical'
  | 'medicalMarkHorizontal'
  | 'fireExtinguisher'
  | 'fireNozzle'
  | 'gasDetector'
  | 'gasDetectorScreen'

const partOrder: BodyPart[] = [
  'head',
  'visor',
  'mask',
  'goggles',
  'eyes',
  'hardhat',
  'hardhatBrim',
  'torso',
  'leftUpperArm',
  'rightUpperArm',
  'leftForearm',
  'rightForearm',
  'leftHand',
  'rightHand',
  'leftThigh',
  'rightThigh',
  'leftShin',
  'rightShin',
  'leftBoot',
  'rightBoot',
  'medicalKit',
  'medicalMarkVertical',
  'medicalMarkHorizontal',
  'fireExtinguisher',
  'fireNozzle',
  'gasDetector',
  'gasDetectorScreen'
]
// Fab personnel remain in cleanroom coveralls during alarms. Operators and
// engineers use pale, role-tinted suits; emergency responders add the orange
// chemical-response layer and helmet.
const roleColor = { engineer: 0x9fc8d6, operator: 0xd4e2ea, responder: 0xd87836 } as const
const skinTones = [0xf1c7a3, 0xd9a17b, 0xb97857, 0x86553f] as const

interface GeometryLayer {
  geometry: THREE.BufferGeometry
  tint?: number
  position?: readonly [number, number, number]
  rotation?: readonly [number, number, number]
  scale?: readonly [number, number, number]
}

function layeredGeometry(layers: GeometryLayer[]): THREE.BufferGeometry {
  const prepared = layers.map((layer) => {
    const geometry = layer.geometry
    if (layer.scale) geometry.scale(...layer.scale)
    if (layer.rotation) geometry.rotateX(layer.rotation[0]).rotateY(layer.rotation[1]).rotateZ(layer.rotation[2])
    if (layer.position) geometry.translate(...layer.position)
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
  const merged = mergeGeometries(prepared, false)
  prepared.forEach((geometry) => geometry.dispose())
  if (!merged) throw new Error('Failed to merge cleanroom personnel geometry')
  return merged
}

function roundedBox(width: number, height: number, depth: number, radius: number): THREE.BufferGeometry {
  // One bevel segment keeps the PPE silhouette soft at follow-camera scale
  // while avoiding hundreds of thousands of duplicate instanced vertices.
  return new RoundedBoxGeometry(width, height, depth, 1, radius)
}

function geometryFor(part: BodyPart): THREE.BufferGeometry {
  if (part === 'medicalKit') {
    return layeredGeometry([
      { geometry: roundedBox(0.16, 0.2, 0.28, 0.025) },
      { geometry: new THREE.TorusGeometry(0.055, 0.012, 5, 10), position: [0, 0.12, 0], rotation: [0, Math.PI / 2, 0], tint: 0xd6dce1 }
    ])
  }
  if (part === 'medicalMarkVertical') return layeredGeometry([{ geometry: new THREE.BoxGeometry(0.018, 0.11, 0.04) }])
  if (part === 'medicalMarkHorizontal') return layeredGeometry([{ geometry: new THREE.BoxGeometry(0.018, 0.04, 0.11) }])
  if (part === 'fireExtinguisher') {
    return layeredGeometry([
      { geometry: new THREE.CylinderGeometry(0.07, 0.07, 0.28, 12) },
      { geometry: new THREE.CylinderGeometry(0.05, 0.06, 0.05, 12), position: [0, 0.16, 0], tint: 0xd7dde2 }
    ])
  }
  if (part === 'fireNozzle') return layeredGeometry([{ geometry: new THREE.BoxGeometry(0.2, 0.045, 0.05) }])
  if (part === 'gasDetector') return layeredGeometry([{ geometry: roundedBox(0.055, 0.18, 0.11, 0.016) }])
  if (part === 'gasDetectorScreen') return layeredGeometry([{ geometry: new THREE.BoxGeometry(0.058, 0.085, 0.072) }])
  if (part.endsWith('Hand')) {
    const side = part.startsWith('left') ? -1 : 1
    return layeredGeometry([
      // Cleanroom gloves read as soft mitts at crowd scale. Individual rigid
      // fingers made personnel look like small articulated robots.
      { geometry: new THREE.CapsuleGeometry(0.048, 0.055, 4, 9), position: [0, -0.025, 0], scale: [0.82, 1, 1.02] },
      { geometry: new THREE.CylinderGeometry(0.054, 0.05, 0.055, 10), position: [0, 0.045, 0], tint: 0xf1f7f8 },
      {
        geometry: new THREE.CapsuleGeometry(0.017, 0.035, 3, 7),
        position: [0.006, -0.025, side * 0.05],
        rotation: [Math.PI / 2, 0, 0.28 * side],
        tint: 0xe8f3f5
      }
    ])
  }
  if (part.endsWith('Boot')) {
    return layeredGeometry([
      { geometry: roundedBox(0.235, 0.095, 0.145, 0.038), position: [0.012, 0, 0] },
      { geometry: new THREE.SphereGeometry(0.078, 11, 8), position: [0.105, 0.005, 0], scale: [0.86, 0.6, 0.92], tint: 0xf4f7f8 },
      { geometry: new THREE.CylinderGeometry(0.074, 0.067, 0.075, 11), position: [-0.075, 0.065, 0], tint: 0xe8f0f2 },
      { geometry: roundedBox(0.255, 0.018, 0.155, 0.008), position: [0.02, -0.054, 0], tint: 0xb9c8ce }
    ])
  }
  if (part === 'hardhat') {
    return layeredGeometry([
      { geometry: new THREE.SphereGeometry(0.168, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2), scale: [1, 1.04, 1] },
      { geometry: roundedBox(0.25, 0.035, 0.045, 0.012), position: [0, 0.125, 0], tint: 0xe4e9ed }
    ])
  }
  if (part === 'hardhatBrim') {
    return layeredGeometry([
      { geometry: new THREE.CylinderGeometry(0.18, 0.18, 0.022, 16) },
      { geometry: roundedBox(0.12, 0.02, 0.23, 0.008), position: [0.135, 0, 0], tint: 0xe7ecef }
    ])
  }
  if (part === 'head') {
    return layeredGeometry([
      { geometry: new THREE.SphereGeometry(0.145, 18, 12), scale: [0.92, 1.08, 1] },
      { geometry: new THREE.SphereGeometry(0.12, 12, 8), position: [-0.065, 0.005, 0], scale: [0.72, 1.02, 1.08], tint: 0xf3f6f7 },
      { geometry: new THREE.CylinderGeometry(0.13, 0.17, 0.13, 14), position: [0, -0.14, 0], tint: 0xe8eff1 },
      { geometry: new THREE.TorusGeometry(0.105, 0.013, 6, 18), position: [0.116, 0.015, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1.12, 0.94], tint: 0xf7f9fa }
    ])
  }
  if (part === 'visor') {
    return layeredGeometry([{ geometry: roundedBox(0.024, 0.14, 0.174, 0.028) }])
  }
  if (part === 'mask') {
    return layeredGeometry([
      { geometry: roundedBox(0.026, 0.064, 0.17, 0.018) },
      { geometry: new THREE.BoxGeometry(0.012, 0.008, 0.145), position: [0.014, 0.018, 0], tint: 0xd3e3e8 },
      { geometry: new THREE.BoxGeometry(0.012, 0.008, 0.13), position: [0.014, -0.008, 0], tint: 0xd3e3e8 }
    ])
  }
  if (part === 'goggles') {
    return layeredGeometry([
      { geometry: roundedBox(0.018, 0.047, 0.07, 0.015), position: [0, 0, -0.047] },
      { geometry: roundedBox(0.018, 0.047, 0.07, 0.015), position: [0, 0, 0.047] },
      { geometry: new THREE.BoxGeometry(0.018, 0.012, 0.035), tint: 0xe8f3f6 },
      { geometry: new THREE.BoxGeometry(0.012, 0.012, 0.19), position: [-0.008, 0, 0], tint: 0xd7e8ed }
    ])
  }
  if (part === 'eyes') {
    return layeredGeometry([
      { geometry: new THREE.SphereGeometry(0.012, 8, 6), position: [0, 0, -0.047], scale: [0.45, 0.72, 1] },
      { geometry: new THREE.SphereGeometry(0.012, 8, 6), position: [0, 0, 0.047], scale: [0.45, 0.72, 1] }
    ])
  }
  if (part === 'torso') {
    return layeredGeometry([
      { geometry: new THREE.CylinderGeometry(0.195, 0.15, 0.5, 16), scale: [0.78, 1, 1.08] },
      { geometry: new THREE.SphereGeometry(0.2, 14, 8), position: [0, 0.195, 0], scale: [0.76, 0.34, 1.13], tint: 0xf5f8f9 },
      { geometry: new THREE.CylinderGeometry(0.15, 0.16, 0.12, 14), position: [0, -0.28, 0], scale: [0.82, 1, 1.02], tint: 0xe9f0f2 },
      { geometry: new THREE.BoxGeometry(0.018, 0.34, 0.018), position: [0.156, 0.015, 0], tint: 0xc4d2d7 },
      { geometry: new THREE.TorusGeometry(0.15, 0.008, 5, 18), position: [0, -0.18, 0], rotation: [Math.PI / 2, 0, 0], scale: [0.8, 1, 1.05], tint: 0xd3dfe3 },
      { geometry: roundedBox(0.018, 0.065, 0.095, 0.008), position: [0.157, 0.105, -0.075], tint: 0xe5ecef }
    ])
  }
  if (part.endsWith('UpperArm')) {
    return layeredGeometry([
      { geometry: new THREE.CapsuleGeometry(0.057, 0.182, 4, 10), scale: [0.94, 1, 1] },
      { geometry: new THREE.SphereGeometry(0.061, 10, 7), position: [0, 0.137, 0], scale: [0.92, 0.5, 1], tint: 0xf5f8f9 }
    ])
  }
  if (part.endsWith('Forearm')) {
    return layeredGeometry([
      { geometry: new THREE.CapsuleGeometry(0.049, 0.168, 4, 10), scale: [0.94, 1, 1] },
      { geometry: new THREE.TorusGeometry(0.046, 0.006, 5, 12), position: [0, -0.13, 0], rotation: [Math.PI / 2, 0, 0], tint: 0xd5e2e5 }
    ])
  }
  if (part.endsWith('Thigh')) {
    return layeredGeometry([
      { geometry: new THREE.CapsuleGeometry(0.075, 0.245, 4, 10), scale: [0.96, 1, 1.03] },
      { geometry: new THREE.BoxGeometry(0.01, 0.2, 0.01), position: [0.071, -0.02, 0], tint: 0xdce6e9 }
    ])
  }
  return layeredGeometry([
    { geometry: new THREE.CapsuleGeometry(0.062, 0.226, 4, 10), scale: [0.95, 1, 1.02] },
    { geometry: new THREE.BoxGeometry(0.01, 0.19, 0.01), position: [0.059, -0.015, 0], tint: 0xdce6e9 },
    { geometry: new THREE.TorusGeometry(0.058, 0.007, 5, 12), position: [0, -0.151, 0], rotation: [Math.PI / 2, 0, 0], tint: 0xd2dfe3 }
  ])
}

export class PersonRenderer {
  private readonly members: EntityMeta[]
  private readonly meshes = new Map<BodyPart, THREE.InstancedMesh>()
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly localPosition = new THREE.Vector3()
  private readonly rootRotation = new THREE.Quaternion()
  private readonly localRotation = new THREE.Quaternion()
  private readonly worldRotation = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3(1, 1, 1)
  private readonly yAxis = new THREE.Vector3(0, 1, 0)
  private readonly zAxis = new THREE.Vector3(0, 0, 1)
  private readonly color = new THREE.Color()
  private selected?: number

  constructor(private readonly scene: THREE.Scene, entities: EntityMeta[]) {
    this.members = entities.filter((entity) => entity.kind === 'person')
    for (const part of partOrder) {
      const material = part === 'gasDetectorScreen' || part === 'eyes'
        ? new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true })
        : new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: part === 'goggles' ? 0.28 : 0.72,
            metalness: 0,
            vertexColors: true
          })
      const mesh = new THREE.InstancedMesh(geometryFor(part), material, Math.max(1, this.members.length))
      mesh.name = `person-${part}`
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.members.length) * 3), 3)
      mesh.castShadow = true
      mesh.frustumCulled = false
      this.meshes.set(part, mesh)
      this.scene.add(mesh)
    }
  }

  update(reader: PoseReader): void {
    this.members.forEach((entity, index) => {
      const pose = reader.pose(entity.index)
      const fast = pose.animation === 2
      const fallen = pose.animation === 3
      const acknowledging = pose.animation === 4
      const receiving = pose.animation === 5
      const treating = pose.animation === 6
      const alarmed = pose.animation === 7
      const monitoring = pose.animation === 8
      const manualValve = pose.animation === 9
      const fireSuppressing = pose.animation === 10
      const pace = pose.animation === 1 || fast ? THREE.MathUtils.clamp(pose.speed / (fast ? 1.7 : 1.2), 0, 1) : 0
      const gait = Math.sin(pose.phase * Math.PI * 2) * pace * (fast ? 0.78 : 0.52)
      const baseY = pose.y - 0.9 + (fallen ? 0.24 : (1 - Math.cos(pose.phase * Math.PI * 4)) * pace * 0.009) - (treating ? 0.18 : 0)
      this.rootRotation.setFromAxisAngle(this.yAxis, -pose.yaw)
      if (fallen) this.rootRotation.multiply(this.localRotation.setFromAxisAngle(this.zAxis, Math.PI / 2))
      const baseSuit = entity.role === 'responder' && (pose.flags & PoseFlags.EMERGENCY) !== 0
        ? 0xf06d3a
        : roleColor[entity.role ?? 'operator']
      const suit = this.selected === entity.index
        ? this.color.setHex(baseSuit).lerp(new THREE.Color(0xffffff), 0.28).getHex()
        : baseSuit
      const postureSway = fallen || treating ? 0 : gait * 0.028
      const torsoLean = (treating ? -0.18 : manualValve ? -0.1 : fast ? -0.12 : 0) + postureSway
      this.place('torso', index, pose.x, baseY, pose.z, treating ? 0.08 : 0, 0.98, 0, torsoLean, this.rootRotation, suit)
      // The hood stays continuous with the coverall while a small exposed
      // face area, eyes, goggles, and mask make the wearer unmistakably human.
      const headLean = (treating ? -0.12 : 0) - postureSway * 0.45
      const headX = treating ? 0.13 : 0
      const skin = skinTones[entity.index % skinTones.length]
      this.place('head', index, pose.x, baseY, pose.z, headX, 1.48, 0, headLean, this.rootRotation, suit)
      this.place('visor', index, pose.x, baseY, pose.z, headX + 0.132, 1.495, 0, headLean, this.rootRotation, skin)
      this.place('mask', index, pose.x, baseY, pose.z, headX + 0.151, 1.458, 0, headLean, this.rootRotation, 0xf1f7f8)
      this.place('goggles', index, pose.x, baseY, pose.z, headX + 0.154, 1.535, 0, headLean, this.rootRotation, 0xaed7e4)
      this.place('eyes', index, pose.x, baseY, pose.z, headX + 0.165, 1.535, 0, headLean, this.rootRotation, 0x2e211d)
      const helmetColor = entity.role === 'responder' ? 0xf4f7f9 : 0xf0b833
      this.scale.setScalar(entity.role === 'operator' ? 0 : 1)
      this.place('hardhat', index, pose.x, baseY, pose.z, treating ? 0.145 : 0, 1.54, 0, treating ? -0.12 : 0, this.rootRotation, helmetColor)
      this.place('hardhatBrim', index, pose.x, baseY, pose.z, treating ? 0.17 : 0.025, 1.545, 0, treating ? -0.12 : 0, this.rootRotation, helmetColor)
      this.scale.set(1, 1, 1)

      const gesture = THREE.MathUtils.smoothstep(pose.auxA, 0, 1)
      const idleVariation = pace === 0 && !fallen && !treating
        ? Math.sin(entity.index * 1.618) * 0.035
        : 0
      let leftUpperArm = gait * -0.62 + idleVariation
      let leftForearm = leftUpperArm - 0.16 - Math.max(0, -gait) * 0.24
      let rightUpperArm = gait * 0.62 - idleVariation * 0.65
      let rightForearm = rightUpperArm - 0.11 - Math.max(0, gait) * 0.24
      let leftThigh = gait * 0.62 + idleVariation * 0.22
      let leftShin = -Math.max(0, gait) * 0.48
      let rightThigh = gait * -0.62 - idleVariation * 0.22
      let rightShin = -Math.max(0, -gait) * 0.48
      if (acknowledging) {
        rightUpperArm = THREE.MathUtils.lerp(0.1, 1.22, Math.max(0.35, gesture))
        rightForearm = THREE.MathUtils.lerp(-0.1, 2.15, Math.max(0.35, gesture))
      }
      if (alarmed) {
        const acknowledge = Math.max(0.25, Math.min(1, gesture / 0.55))
        rightUpperArm = THREE.MathUtils.lerp(0, 1.18, acknowledge)
        rightForearm = THREE.MathUtils.lerp(-0.12, 2.1, acknowledge)
        leftUpperArm = THREE.MathUtils.lerp(0, 0.58, gesture)
        leftForearm = THREE.MathUtils.lerp(-0.12, 0.32, gesture)
      }
      if (receiving) {
        const reach = Math.max(0.25, gesture)
        leftUpperArm = THREE.MathUtils.lerp(0, 1.02, reach)
        leftForearm = THREE.MathUtils.lerp(-0.12, 1.42, reach)
        rightUpperArm = THREE.MathUtils.lerp(0, 1.02, reach)
        rightForearm = THREE.MathUtils.lerp(-0.12, 1.42, reach)
      }
      if (treating) {
        leftUpperArm = 0.65
        leftForearm = 0.35
        rightUpperArm = 0.82
        rightForearm = 0.5
        leftThigh = 0.75
        leftShin = -0.75
        rightThigh = 0.15
        rightShin = 1
      }
      if (monitoring) {
        rightUpperArm = 1
        rightForearm = 1.45
        leftUpperArm = 0.25
        leftForearm = 0.45
      }
      if (manualValve) {
        // A responder uses both hands on the same wheel plane. The asymmetric
        // elbows keep the silhouette readable while the body remains planted.
        leftUpperArm = 1.02
        leftForearm = 1.48
        rightUpperArm = 1.2
        rightForearm = 1.72
      }
      if (fireSuppressing) {
        // Two hands remain on a compact extinguisher. The stance is low and
        // asymmetric so three responders do not look like synchronized waves.
        leftUpperArm = 0.7
        leftForearm = 1.04
        rightUpperArm = 0.98
        rightForearm = 1.32
        leftThigh = 0.2
        leftShin = -0.14
        rightThigh = -0.16
        rightShin = 0.18
      }

      const leftHand = this.placeTwoSegmentLimb(
        index, pose.x, baseY, pose.z, -0.245, 1.34, 0.29, 0.26,
        leftUpperArm, leftForearm, 'leftUpperArm', 'leftForearm', this.rootRotation, suit
      )
      const rightHand = this.placeTwoSegmentLimb(
        index, pose.x, baseY, pose.z, 0.245, 1.34, 0.29, 0.26,
        rightUpperArm, rightForearm, 'rightUpperArm', 'rightForearm', this.rootRotation, suit
      )
      const gloveColor = entity.role === 'responder' ? 0x263746 : 0xb8e4ec
      this.place('leftHand', index, pose.x, baseY, pose.z, leftHand[0], leftHand[1], leftHand[2], leftForearm, this.rootRotation, gloveColor)
      this.place('rightHand', index, pose.x, baseY, pose.z, rightHand[0], rightHand[1], rightHand[2], rightForearm, this.rootRotation, gloveColor)
      const leftFoot = this.placeTwoSegmentLimb(
        index, pose.x, baseY, pose.z, -0.12, 0.78, 0.38, 0.35,
        leftThigh, leftShin, 'leftThigh', 'leftShin', this.rootRotation, suit
      )
      const rightFoot = this.placeTwoSegmentLimb(
        index, pose.x, baseY, pose.z, 0.12, 0.78, 0.38, 0.35,
        rightThigh, rightShin, 'rightThigh', 'rightShin', this.rootRotation, suit
      )
      const bootColor = entity.role === 'responder' ? 0x283943 : 0xc9dce4
      this.place('leftBoot', index, pose.x, baseY, pose.z, leftFoot[0] + 0.08, leftFoot[1] + 0.035, leftFoot[2], 0, this.rootRotation, bootColor)
      this.place('rightBoot', index, pose.x, baseY, pose.z, rightFoot[0] + 0.08, rightFoot[1] + 0.035, rightFoot[2], 0, this.rootRotation, bootColor)

      const kitScale = pose.auxB > 0.5 ? 1 : 0
      this.scale.setScalar(kitScale)
      const kitX = treating ? 0.42 : receiving ? 0.48 : 0.32
      const kitY = treating ? 0.38 : receiving ? 1.03 : 1.05
      const kitZ = treating ? 0.16 : 0
      this.place('medicalKit', index, pose.x, baseY, pose.z, kitX, kitY, kitZ, 0, this.rootRotation, 0xd94747)
      this.place('medicalMarkVertical', index, pose.x, baseY, pose.z, kitX + 0.088, kitY, kitZ, 0, this.rootRotation, 0xffffff)
      this.place('medicalMarkHorizontal', index, pose.x, baseY, pose.z, kitX + 0.089, kitY, kitZ, 0, this.rootRotation, 0xffffff)
      this.scale.set(1, 1, 1)

      this.scale.setScalar(fireSuppressing ? 1 : 0)
      this.place('fireExtinguisher', index, pose.x, baseY, pose.z, rightHand[0] - 0.02, rightHand[1] + 0.06, rightHand[2], 0, this.rootRotation, 0xd7493f)
      this.place('fireNozzle', index, pose.x, baseY, pose.z, rightHand[0] + 0.12, rightHand[1] + 0.16, rightHand[2], 0, this.rootRotation, 0xd9e2e9)
      this.scale.set(1, 1, 1)

      this.scale.setScalar(monitoring ? 1 : 0)
      const detectorPulse = pose.auxA >= 0.98
        ? 0x50e89a
        : pose.auxA >= 0.72
          ? 0x75d9ff
          : 0xffc247
      this.place(
        'gasDetector',
        index,
        pose.x,
        baseY,
        pose.z,
        rightHand[0] + 0.035,
        rightHand[1] + 0.02,
        rightHand[2],
        0,
        this.rootRotation,
        0x17232d
      )
      this.place(
        'gasDetectorScreen',
        index,
        pose.x,
        baseY,
        pose.z,
        rightHand[0] + 0.065,
        rightHand[1] + 0.035,
        rightHand[2],
        0,
        this.rootRotation,
        detectorPulse
      )
      this.scale.set(1, 1, 1)
    })
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  select(index?: number): void { this.selected = index }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  }

  private place(part: BodyPart, index: number, x: number, y: number, z: number, localX: number, localY: number, localZ: number, angle: number, rootRotation: THREE.Quaternion, color: number): void {
    this.localPosition.set(localX, localY, localZ).applyQuaternion(rootRotation)
    this.position.set(x, y, z).add(this.localPosition)
    this.localRotation.setFromAxisAngle(this.zAxis, angle)
    this.worldRotation.copy(rootRotation).multiply(this.localRotation)
    this.matrix.compose(this.position, this.worldRotation, this.scale)
    const mesh = this.meshes.get(part)!
    mesh.setMatrixAt(index, this.matrix)
    mesh.setColorAt(index, new THREE.Color(color))
  }

  private placeTwoSegmentLimb(
    index: number,
    x: number,
    y: number,
    z: number,
    localZ: number,
    anchorY: number,
    upperLength: number,
    lowerLength: number,
    upperAngle: number,
    lowerAngle: number,
    upperPart: BodyPart,
    lowerPart: BodyPart,
    rootRotation: THREE.Quaternion,
    color: number
  ): readonly [number, number, number] {
    const elbowX = Math.sin(upperAngle) * upperLength
    const elbowY = anchorY - Math.cos(upperAngle) * upperLength
    this.place(
      upperPart,
      index,
      x,
      y,
      z,
      Math.sin(upperAngle) * upperLength / 2,
      anchorY - Math.cos(upperAngle) * upperLength / 2,
      localZ,
      upperAngle,
      rootRotation,
      color
    )
    this.place(
      lowerPart,
      index,
      x,
      y,
      z,
      elbowX + Math.sin(lowerAngle) * lowerLength / 2,
      elbowY - Math.cos(lowerAngle) * lowerLength / 2,
      localZ,
      lowerAngle,
      rootRotation,
      color
    )
    return [
      elbowX + Math.sin(lowerAngle) * lowerLength,
      elbowY - Math.cos(lowerAngle) * lowerLength,
      localZ
    ]
  }
}
