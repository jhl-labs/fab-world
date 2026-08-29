import { describe, expect, it } from 'vitest'
import { personLocomotionPose } from '../src/render/agents/personGait'

describe('person locomotion', () => {
  it('uses a visibly different running silhouette during emergency movement', () => {
    const walking = personLocomotionPose(1, 1.2, 0.25)
    const running = personLocomotionPose(2, 2.5, 0.25)

    expect(running.torsoLean).toBeLessThan(-0.2)
    expect(running.headForward).toBeGreaterThan(0.06)
    expect(Math.abs(running.leftUpperArm)).toBeGreaterThan(Math.abs(walking.leftUpperArm) * 2)
    expect(Math.abs(running.leftThigh)).toBeGreaterThan(Math.abs(walking.leftThigh) * 2)
    expect(Math.abs(running.leftForearm - running.leftUpperArm)).toBeGreaterThan(0.85)
    expect(running.bob).toBeGreaterThan(walking.bob * 2.5)
  })

  it('keeps routine walking upright and shortens an emergency stride while braking', () => {
    const walking = personLocomotionPose(1, 1.2, 0.25)
    const running = personLocomotionPose(2, 2.5, 0.25)
    const braking = personLocomotionPose(2, 0.45, 0.25)

    expect(walking.torsoLean).toBe(0)
    expect(walking.headForward).toBe(0)
    expect(Math.abs(braking.leftThigh)).toBeLessThan(Math.abs(running.leftThigh) * 0.4)
    expect(braking.bob).toBeLessThan(running.bob * 0.4)
  })
})
