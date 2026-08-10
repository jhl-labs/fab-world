import * as THREE from 'three'
import { clamp } from '../../core/math/vec'
import type { EntityMeta } from '../../core/protocol'
import type { PoseReader } from '../interpolate'

export type CameraMode = 'orbit' | 'follow' | 'firstPerson'

export class CameraController {
  readonly camera = new THREE.PerspectiveCamera(48, 1, 1, 1500)
  mode: CameraMode = 'orbit'
  target?: EntityMeta
  private focus = new THREE.Vector3(0, 0, 0)
  private azimuth = -0.68
  private polar = 0.88
  private distance = 185
  private dragging = false
  private pointerX = 0
  private keys = new Set<string>()
  private snapFollow = false
  private snapOrbit = false
  constructor(element: HTMLElement, private readonly bounds: { width: number; depth: number }) {
    this.camera.position.set(110, 120, 135)
    element.addEventListener('pointerdown', (event) => { this.dragging = true; this.pointerX = event.clientX; element.setPointerCapture(event.pointerId) })
    element.addEventListener('pointerup', (event) => { this.dragging = false; element.releasePointerCapture(event.pointerId) })
    element.addEventListener('pointermove', (event) => {
      if (!this.dragging) return
      const dx = event.clientX - this.pointerX; this.pointerX = event.clientX
      if (this.mode === 'firstPerson') { this.azimuth -= dx * 0.004; this.polar = clamp(this.polar + event.movementY * 0.003, 0.15, Math.PI - 0.15) }
      else { this.azimuth -= dx * 0.006; this.polar = clamp(this.polar + event.movementY * 0.006, 0.16, 1.48); this.mode = 'orbit' }
    })
    element.addEventListener('wheel', (event) => { this.distance = clamp(this.distance + event.deltaY * 0.09, 8, 350) }, { passive: true })
    window.addEventListener('keydown', (event) => this.keys.add(event.code)); window.addEventListener('keyup', (event) => this.keys.delete(event.code))
  }
  setMode(mode: CameraMode): void { this.mode = mode }
  orbitTo(x: number, z: number, distance: number, polar = 0.72, azimuth?: number, focusY = 0.8): void {
    this.target = undefined
    this.mode = 'orbit'
    this.focus.set(x, focusY, z)
    this.distance = clamp(distance, 8, 350)
    this.polar = clamp(polar, 0.16, 1.48)
    if (azimuth !== undefined) this.azimuth = azimuth
    this.snapOrbit = true
  }
  follow(entity?: EntityMeta): void {
    this.snapFollow = entity !== undefined && entity.id !== this.target?.id
    this.target = entity; this.mode = entity ? 'follow' : 'orbit'
    // At 24m a humanoid becomes a dot against the fab floor. The showcase is
    // about its work, so keep a human-scale following distance while retaining
    // a wider view for material-handling vehicles.
    if (entity) this.distance = entity.kind === 'humanoid' ? 14 : entity.kind === 'person' ? 11 : entity.kind === 'oht' ? 28 : 20
  }
  update(dt: number, reader: PoseReader): void {
    if (this.mode === 'follow' && this.target) {
      const pose = reader.pose(this.target.index)
      const focusHeight = this.target.kind === 'humanoid' ? 1.05 : this.target.kind === 'person' ? 0.8 : 0.45
      const desired = new THREE.Vector3(
        pose.x - Math.cos(pose.yaw) * this.distance * 0.55,
        pose.y + focusHeight + this.distance * 0.25,
        pose.z - Math.sin(pose.yaw) * this.distance * 0.55
      )
      const focus = new THREE.Vector3(pose.x, pose.y + focusHeight, pose.z)
      if (this.snapFollow) {
        this.camera.position.copy(desired)
        this.focus.copy(focus)
        this.snapFollow = false
      } else {
        this.camera.position.lerp(desired, 1 - Math.exp(-dt * 4))
        this.focus.lerp(focus, 1 - Math.exp(-dt * 6))
      }
      this.camera.lookAt(this.focus)
      return
    }
    if (this.mode === 'firstPerson') {
      if (this.target) { const pose = reader.pose(this.target.index); this.camera.position.set(pose.x, pose.y + (this.target.kind === 'person' ? 0.65 : this.target.kind === 'humanoid' ? 1.62 : 0.45), pose.z) }
      else {
        const forward = new THREE.Vector3(Math.cos(this.azimuth), 0, Math.sin(this.azimuth)); const right = new THREE.Vector3(-forward.z, 0, forward.x); const pace = this.keys.has('ShiftLeft') ? 10 : 4
        if (this.keys.has('KeyW')) this.camera.position.addScaledVector(forward, pace * dt); if (this.keys.has('KeyS')) this.camera.position.addScaledVector(forward, -pace * dt); if (this.keys.has('KeyA')) this.camera.position.addScaledVector(right, -pace * dt); if (this.keys.has('KeyD')) this.camera.position.addScaledVector(right, pace * dt)
        this.camera.position.x = clamp(this.camera.position.x, -this.bounds.width / 2 + 2, this.bounds.width / 2 - 2); this.camera.position.z = clamp(this.camera.position.z, -this.bounds.depth / 2 + 2, this.bounds.depth / 2 - 2); this.camera.position.y = 1.7
      }
      const look = new THREE.Vector3(Math.cos(this.azimuth) * Math.sin(this.polar), Math.cos(this.polar), Math.sin(this.azimuth) * Math.sin(this.polar)); this.camera.lookAt(this.camera.position.clone().add(look)); return
    }
    const horizontal = Math.sin(this.polar) * this.distance
    const wanted = new THREE.Vector3(this.focus.x + Math.cos(this.azimuth) * horizontal, this.focus.y + Math.cos(this.polar) * this.distance, this.focus.z + Math.sin(this.azimuth) * horizontal)
    if (this.snapOrbit) { this.camera.position.copy(wanted); this.snapOrbit = false }
    else this.camera.position.lerp(wanted, 1 - Math.exp(-dt * 6))
    this.camera.lookAt(this.focus)
  }
}
