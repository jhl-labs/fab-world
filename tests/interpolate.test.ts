import { describe, expect, it } from 'vitest'
import { POSE_STRIDE, PoseSlot } from '../src/core/protocol'
import { PoseReader } from '../src/render/interpolate'

function snapshot(values: Partial<Record<(typeof PoseSlot)[keyof typeof PoseSlot], number>>): ArrayBuffer {
  const pose = new Float32Array(POSE_STRIDE)
  for (const [slot, value] of Object.entries(values)) pose[Number(slot)] = value
  return pose.buffer
}

describe('PoseReader interpolation', () => {
  it('starts the first fallback snapshot at its published pose instead of the world origin', () => {
    const reader = new PoseReader()
    reader.acceptFallback(snapshot({ [PoseSlot.X]: 24, [PoseSlot.Z]: -18 }), 1, 1, 16)

    expect(reader.pose(0, 0).x).toBe(24)
    expect(reader.pose(0, 0).z).toBe(-18)
  })

  it('interpolates position, speed, and wrapped walk phase between fallback snapshots', () => {
    const reader = new PoseReader()
    reader.acceptFallback(snapshot({
      [PoseSlot.X]: 10,
      [PoseSlot.SPEED]: 1,
      [PoseSlot.ANIM_PHASE]: 0.95
    }), 1, 1, 16)
    reader.acceptFallback(snapshot({
      [PoseSlot.X]: 14,
      [PoseSlot.SPEED]: 3,
      [PoseSlot.ANIM_PHASE]: 0.05
    }), 2, 1, 32)

    const pose = reader.pose(0, 0.5)
    expect(pose.x).toBeCloseTo(12)
    expect(pose.speed).toBeCloseTo(2)
    expect(pose.phase).toBeCloseTo(0)
  })

  it('briefly extrapolates a moving pose when a high-speed snapshot arrives late', () => {
    const reader = new PoseReader()
    reader.acceptFallback(snapshot({ [PoseSlot.X]: 0, [PoseSlot.SPEED]: 1 }), 1, 1, 0)
    reader.acceptFallback(snapshot({ [PoseSlot.X]: 1, [PoseSlot.SPEED]: 1 }), 2, 1, 1_000)

    expect(reader.pose(0, 1.2).x).toBeCloseTo(1.2)
  })
})
