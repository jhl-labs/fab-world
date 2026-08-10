import * as THREE from 'three'
import type { EmergencyKind, EmergencyPhase, FabLayout } from '../core/schema'
import type { EntityMeta, EquipmentStateView } from '../core/protocol'
import { AgentRenderer } from './agents/agentRenderer'
import { CarrierRenderer } from './agents/carrierRenderer'
import { ContactShadowRenderer } from './agents/contactShadowRenderer'
import { HumanoidRenderer } from './agents/humanoidRenderer'
import { PersonRenderer } from './agents/personRenderer'
import { CameraController, type CameraMode } from './camera/controller'
import { buildShotAnchors, buildShotObstacles, planInteractionOrbit, planShotOrbit, type ShotAnchor, type ShotObstacle } from './camera/shotPlanner'
import { EmergencyFx } from './fx/emergencyFx'
import { InteractionCue } from './fx/interactionCue'
import { PoseReader } from './interpolate'
import { EntityLabelRenderer } from './labels/entityLabelRenderer'
import { buildFabScene } from './world/fabScene'
import { EquipmentStatusRenderer } from './world/equipmentStatusRenderer'
import { SafetyDeviceAnimator } from './world/safetyDeviceAnimator'

export interface RenderStats { fps: number; drawCalls: number; triangles: number }
interface InteractionEventPose { robotX: number; robotZ: number; personX: number; personZ: number }
interface MedicalEventPose extends InteractionEventPose {
  patientX?: number
  patientZ?: number
  robotGoalX?: number
  robotGoalZ?: number
  personGoalX?: number
  personGoalZ?: number
}

export class RenderEngine {
  readonly reader: PoseReader
  readonly camera: CameraController
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly agents: AgentRenderer
  private readonly carriers: CarrierRenderer
  private readonly contactShadows: ContactShadowRenderer
  private readonly humanoids: HumanoidRenderer
  private readonly people: PersonRenderer
  private readonly equipmentStatus: EquipmentStatusRenderer
  private readonly safetyDevices: SafetyDeviceAnimator
  private readonly fx: EmergencyFx
  private readonly interactionCue: InteractionCue
  private readonly labels: EntityLabelRenderer
  private lastRenderAt = performance.now()
  private readonly resizeObserver: ResizeObserver
  private active = true
  private frames = 0
  private frameWindow = 0
  private stats: RenderStats = { fps: 0, drawCalls: 0, triangles: 0 }
  private readonly source: readonly [number, number]
  private readonly shotAnchors: ShotAnchor[]
  private readonly shotObstacles: ShotObstacle[]
  constructor(private readonly container: HTMLElement, layout: FabLayout, entities: EntityMeta[], poseBuffer?: SharedArrayBuffer, onStats?: (stats: RenderStats) => void) {
    this.reader = new PoseReader(poseBuffer)
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' }); this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); this.renderer.setSize(container.clientWidth, container.clientHeight); this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.autoUpdate = true; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1; container.append(this.renderer.domElement)
    this.scene.background = new THREE.Color(0xeef2f7); this.scene.fog = new THREE.Fog(0xeef2f7, 170, 520)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd8dee7, 2.2)); const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(80, 150, 50); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); this.scene.add(sun)
    this.scene.add(buildFabScene(layout)); this.equipmentStatus = new EquipmentStatusRenderer(this.scene, layout); this.safetyDevices = new SafetyDeviceAnimator(this.scene, layout, entities); this.contactShadows = new ContactShadowRenderer(this.scene, entities); this.agents = new AgentRenderer(this.scene, entities); this.carriers = new CarrierRenderer(this.scene, entities); this.humanoids = new HumanoidRenderer(this.scene, entities); this.people = new PersonRenderer(this.scene, entities); this.fx = new EmergencyFx(this.scene); this.interactionCue = new InteractionCue(this.scene); this.labels = new EntityLabelRenderer(container, entities)
    this.camera = new CameraController(this.renderer.domElement, layout.fab)
    this.shotAnchors = buildShotAnchors(layout)
    this.shotObstacles = buildShotObstacles(layout)
    const first = layout.bays.flatMap((bay) => bay.equipment).find((equipment) => equipment.hazardCapable) ?? layout.bays[0]!.equipment[0]!; this.source = [first.position[0], first.position[2]]
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container)
    let firstFrame = true
    const frame = (): void => { if (!this.active) return; requestAnimationFrame(frame); const now = performance.now(); const dt = Math.min((now - this.lastRenderAt) / 1000, 0.1); this.lastRenderAt = now; this.reader.update(); this.contactShadows.update(this.reader); this.agents.update(this.reader); this.carriers.update(this.reader); this.humanoids.update(this.reader); this.people.update(this.reader); this.safetyDevices.update(this.reader); this.interactionCue.update(this.reader); this.camera.update(dt, this.reader); this.labels.update(this.reader, this.camera.camera); this.fx.update(dt); this.renderer.render(this.scene, this.camera.camera); if (firstFrame) { this.renderer.shadowMap.autoUpdate = false; firstFrame = false } this.frames++; this.frameWindow += dt; if (this.frameWindow >= 1) { this.stats = { fps: Math.round(this.frames / this.frameWindow), drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles }; onStats?.(this.stats); this.frames = 0; this.frameWindow = 0 } }
    frame()
  }
  acceptFallbackPose(buffer: ArrayBuffer, generation: number, entityCount: number, simTimeMs: number): void { this.reader.acceptFallback(buffer, generation, entityCount, simTimeMs) }
  select(entity?: EntityMeta): void { this.agents.select(entity?.index); this.people.select(entity?.index); if (entity) this.camera.follow(entity) }
  setCameraMode(mode: CameraMode): void { this.camera.setMode(mode) }
  setEntityLabelBadge(entityId: string, badge?: string): void { this.labels.setBadge(entityId, badge) }
  cueInteraction(robot: EntityMeta, person: EntityMeta, eventPose?: InteractionEventPose): void {
    this.cuePersonInteraction(robot, person, eventPose, 'clearance')
  }
  cueMedicalHandoff(robot: EntityMeta, responder: EntityMeta, patient?: EntityMeta, eventPose?: MedicalEventPose): void {
    this.cuePersonInteraction(robot, responder, eventPose, 'medical_handoff', patient)
  }
  cueGasMonitoring(robot: EntityMeta, spotter: EntityMeta, eventPose?: InteractionEventPose): void {
    this.cuePersonInteraction(robot, spotter, eventPose, 'gas_monitoring')
  }
  cueGasFailureRetreat(robot: EntityMeta, spotter: EntityMeta, eventPose?: MedicalEventPose): void {
    this.cuePersonInteraction(robot, spotter, eventPose, 'gas_failure')
  }
  private cuePersonInteraction(
    robot: EntityMeta,
    person: EntityMeta,
    eventPose: MedicalEventPose | undefined,
    mode: 'clearance' | 'medical_handoff' | 'gas_monitoring' | 'gas_failure',
    patient?: EntityMeta
  ): void {
    const robotPose = this.reader.pose(robot.index)
    const personPose = this.reader.pose(person.index)
    const robotX = eventPose?.robotX ?? robotPose.x
    const robotZ = eventPose?.robotZ ?? robotPose.z
    const personX = eventPose?.personX ?? personPose.x
    const personZ = eventPose?.personZ ?? personPose.z
    const distance = Math.hypot(robotX - personX, robotZ - personZ)
    const separationYaw = distance > 0.2 ? Math.atan2(personZ - robotZ, personX - robotX) : robotPose.yaw + Math.PI / 2
    const patientPose = patient ? this.reader.pose(patient.index) : undefined
    const patientX = eventPose?.patientX ?? patientPose?.x
    const patientZ = eventPose?.patientZ ?? patientPose?.z
    const retreatPoints =
      mode === 'gas_failure' &&
      eventPose?.robotGoalX !== undefined &&
      eventPose.robotGoalZ !== undefined &&
      eventPose.personGoalX !== undefined &&
      eventPose.personGoalZ !== undefined
        ? [[eventPose.robotGoalX, eventPose.robotGoalZ], [eventPose.personGoalX, eventPose.personGoalZ]]
        : []
    const points = [
      [robotX, robotZ],
      [personX, personZ],
      ...(patientX !== undefined && patientZ !== undefined ? [[patientX, patientZ]] : []),
      ...retreatPoints
    ]
    const focus: ShotAnchor = [
      (Math.min(...points.map((point) => point[0]!)) + Math.max(...points.map((point) => point[0]!))) / 2,
      (Math.min(...points.map((point) => point[1]!)) + Math.max(...points.map((point) => point[1]!))) / 2
    ]
    const polar = mode === 'medical_handoff' ? 1.16 : mode === 'gas_monitoring' ? 1.08 : 0.78
    const retreatYaw = retreatPoints.length === 2
      ? Math.atan2(retreatPoints[1]![1]! - retreatPoints[0]![1]!, retreatPoints[1]![0]! - retreatPoints[0]![0]!)
      : separationYaw
    const desiredAzimuth = mode === 'gas_monitoring'
      ? robotPose.yaw + Math.PI + 0.95
      : (mode === 'gas_failure' ? retreatYaw : separationYaw) + Math.PI / 2
    const planned = planInteractionOrbit(this.shotObstacles, [robotX, robotZ], [personX, personZ], desiredAzimuth, polar)
    const span = Math.max(...points.flatMap((left) => points.map((right) => Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!))))
    this.camera.orbitTo(
      focus[0],
      focus[1],
      Math.max(
        planned.distance,
        span * (mode === 'gas_failure' ? 1.45 : 2.7),
        mode === 'medical_handoff' ? 10.5 : mode === 'gas_monitoring' ? 7.2 : mode === 'gas_failure' ? 12 : 0
      ),
      polar,
      planned.azimuth
    )
    this.interactionCue.cue(
      robot,
      person,
      mode === 'medical_handoff' ? 4_500 : mode === 'gas_monitoring' ? 4_000 : mode === 'gas_failure' ? 5_500 : 2_600,
      mode,
      patient
    )
  }
  cueCamera(shot: string, position?: readonly [number, number], entity?: EntityMeta): void {
    if (shot === 'follow' && entity) { this.select(entity); return }
    if (!position) return
    const pose = entity ? this.reader.pose(entity.index) : undefined
    const valveCloseup = shot === 'valve-closeup'
    const closeup = shot === 'closeup' || valveCloseup
    const inspection = shot === 'inspection'
    const muster = shot === 'muster'
    const evacuationWide = shot === 'evacuation-wide'
    const egress = shot === 'egress'
    const resolution = shot === 'resolution'
    const polar = valveCloseup ? 1.38 : closeup ? 1.26 : inspection ? 1.08 : resolution ? 1.12 : muster ? 1.05 : evacuationWide ? 0.98 : shot === 'aerial' ? 0.42 : egress ? 0.86 : 0.82
    const focus: ShotAnchor = (closeup || resolution || inspection) && pose ? [(position[0] + pose.x) / 2, (position[1] + pose.z) / 2] : position
    const planned = valveCloseup && pose
      ? { azimuth: pose.yaw + Math.PI - 0.95, distance: 8.4 }
      : (closeup || resolution || inspection)
        ? planShotOrbit(
        this.shotAnchors,
        focus,
        pose ? pose.yaw + Math.PI / 2 : -0.68,
        polar,
        resolution ? 16 : inspection ? 14 : 10.5,
        resolution ? 10 : inspection ? 10 : 6,
        resolution ? 18 : inspection ? 18 : 16,
        this.shotObstacles
      )
        : undefined
    this.camera.orbitTo(
      focus[0],
      focus[1],
      planned?.distance ?? (valveCloseup ? 9 : closeup ? 10.5 : inspection ? 14 : resolution ? 16 : muster ? 24 : evacuationWide ? 62 : shot === 'aerial' ? 72 : egress ? 48 : 42),
      polar,
      planned?.azimuth ?? (muster ? (position[1] < 0 ? -Math.PI / 2 - 0.34 : Math.PI / 2 - 0.34) : undefined),
      0.8
    )
  }
  setEmergency(kind: EmergencyKind | undefined, phase: EmergencyPhase, position?: readonly [number, number]): void { if (phase === 'normal') this.safetyDevices.reset(); this.fx.setState(kind, phase, position ?? this.source) }
  setHazardRadius(radius: number): void { this.fx.setRadius(radius) }
  setEquipmentStates(states: EquipmentStateView[]): void { this.equipmentStatus.setStates(states) }
  dispose(): void { this.active = false; this.resizeObserver.disconnect(); this.labels.dispose(); this.equipmentStatus.dispose(); this.contactShadows.dispose(); this.agents.dispose(); this.carriers.dispose(); this.humanoids.dispose(); this.people.dispose(); this.interactionCue.dispose(); this.fx.dispose(); this.renderer.dispose(); this.renderer.domElement.remove() }
  private resize(): void { const width = Math.max(1, this.container.clientWidth); const height = Math.max(1, this.container.clientHeight); this.renderer.setSize(width, height); this.camera.camera.aspect = width / height; this.camera.camera.updateProjectionMatrix() }
}
