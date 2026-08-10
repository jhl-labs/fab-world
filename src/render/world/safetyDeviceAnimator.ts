import * as THREE from 'three'
import type { EntityMeta } from '../../core/protocol'
import type { FabLayout } from '../../core/schema'
import type { PoseReader } from '../interpolate'

interface AnimatedDevice {
  x: number
  z: number
  pivot: THREE.Group
  progress: number
}

export class SafetyDeviceAnimator {
  private readonly humanoids: EntityMeta[]
  private readonly devices: AnimatedDevice[]

  constructor(scene: THREE.Scene, layout: FabLayout, entities: EntityMeta[]) {
    this.humanoids = entities.filter((entity) => entity.kind === 'humanoid')
    this.devices = layout.emergency.safetyDevices
      .filter((device) => device.kind === 'gas-isolation-valve')
      .map((device) => ({
        x: device.position[0],
        z: device.position[2],
        pivot: scene.getObjectByName(`safety-wheel:${device.id}`) as THREE.Group,
        progress: 0
      }))
      .filter((device) => device.pivot instanceof THREE.Group)
  }

  update(reader: PoseReader): void {
    for (const device of this.devices) {
      for (const humanoid of this.humanoids) {
        const pose = reader.pose(humanoid.index)
        if (pose.animation !== 5 || Math.hypot(pose.x - device.x, pose.z - device.z) > 1.6) continue
        const executorValvePosition = pose.auxB < -1.0005
          ? THREE.MathUtils.clamp(-pose.auxB - 1.001, 0, 1)
          : undefined
        // LIVE/TRACE frames carry the executor's normalized valve position in
        // AUX_B. Local physics retains the deterministic arm-progress mapping.
        const reportedProgress = executorValvePosition ??
          THREE.MathUtils.smoothstep(pose.auxA, 0.18, 0.74)
        device.progress = Math.max(device.progress, reportedProgress)
      }
      device.pivot.rotation.x = device.progress * Math.PI * 2.5
    }
  }

  reset(): void {
    for (const device of this.devices) {
      device.progress = 0
      device.pivot.rotation.x = 0
    }
  }
}
