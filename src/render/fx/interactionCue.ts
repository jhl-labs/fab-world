import * as THREE from 'three'
import type { EntityMeta } from '../../core/protocol'
import type { PoseReader } from '../interpolate'

export class InteractionCue {
  private readonly group = new THREE.Group()
  private readonly robotRing = this.ring(0.48, 0.58, 0x42a5f5, 0.95)
  private readonly personRing = this.ring(0.4, 0.5, 0xffc857, 0.95)
  private readonly patientRing = this.ring(0.42, 0.54, 0xff6b6b, 0.95)
  private readonly clearanceRing = this.ring(2.16, 2.2, 0x42a5f5, 0.48)
  private readonly lineGeometry = new THREE.BufferGeometry()
  private readonly line = new THREE.Line(
    this.lineGeometry,
    new THREE.LineBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.9 })
  )
  private robot?: EntityMeta
  private person?: EntityMeta
  private patient?: EntityMeta
  private visibleUntil = 0
  private mode: 'clearance' | 'medical_handoff' | 'gas_monitoring' | 'gas_failure' = 'clearance'
  private faded = false
  private readonly equipmentMaterials: Array<{
    material: THREE.Material
    transparent: boolean
    opacity: number
    depthWrite: boolean
  }> = []

  constructor(private readonly scene: THREE.Scene) {
    this.group.add(this.clearanceRing, this.robotRing, this.personRing, this.patientRing, this.line)
    this.group.visible = false
    this.group.renderOrder = 20
    this.scene.add(this.group)
    this.scene.traverse((object) => {
      if (!object.name.startsWith('equipment:') || !(object instanceof THREE.Mesh)) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) this.equipmentMaterials.push({
        material,
        transparent: material.transparent,
        opacity: material.opacity,
        depthWrite: material.depthWrite
      })
    })
  }

  cue(
    robot: EntityMeta,
    person: EntityMeta,
    durationMs = 2_600,
    mode: 'clearance' | 'medical_handoff' | 'gas_monitoring' | 'gas_failure' = 'clearance',
    patient?: EntityMeta
  ): void {
    this.robot = robot
    this.person = person
    this.patient = patient
    this.mode = mode
    this.visibleUntil = performance.now() + durationMs
    this.clearanceRing.visible = mode === 'clearance'
    this.patientRing.visible = mode === 'medical_handoff' && patient !== undefined
    ;(this.line.material as THREE.LineBasicMaterial).color.setHex(
      mode === 'medical_handoff' ? 0x6ee7b7 : mode === 'gas_monitoring' ? 0x75d9ff : mode === 'gas_failure' ? 0xff6b6b : 0xeaf6ff
    )
    this.group.visible = true
    this.setEquipmentFade(true)
  }

  update(reader: PoseReader): void {
    if (!this.robot || !this.person || performance.now() >= this.visibleUntil) {
      this.group.visible = false
      this.setEquipmentFade(false)
      return
    }
    const robot = reader.pose(this.robot.index)
    const person = reader.pose(this.person.index)
    const patient = this.patient ? reader.pose(this.patient.index) : undefined
    if (this.mode === 'clearance') this.clearanceRing.position.set(robot.x, 0.055, robot.z)
    this.robotRing.position.set(robot.x, 0.065, robot.z)
    this.personRing.position.set(person.x, 0.07, person.z)
    if (patient) this.patientRing.position.set(patient.x, 0.075, patient.z)
    this.lineGeometry.setFromPoints([
      new THREE.Vector3(robot.x, 0.08, robot.z),
      new THREE.Vector3(person.x, 0.08, person.z)
    ])
  }

  dispose(): void {
    this.setEquipmentFade(false)
    this.scene.remove(this.group)
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) material.dispose()
    })
  }

  private ring(inner: number, outer: number, color: number, opacity: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide })
    )
    mesh.rotation.x = -Math.PI / 2
    return mesh
  }

  private setEquipmentFade(active: boolean): void {
    if (this.faded === active) return
    this.faded = active
    for (const entry of this.equipmentMaterials) {
      entry.material.transparent = active ? true : entry.transparent
      entry.material.opacity = active ? 0.2 : entry.opacity
      entry.material.depthWrite = active ? false : entry.depthWrite
      entry.material.needsUpdate = true
    }
  }
}
