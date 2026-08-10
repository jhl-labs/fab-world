import { describe, expect, it } from 'vitest'
import layoutJson from '../data/layouts/fab-default.json'
import {
  GAS_VALVE_STANDOFF,
  HUMANOID_LOWER_ARM_LENGTH,
  HUMANOID_UPPER_ARM_LENGTH,
  gasValveGripResidual,
  gasValveGripTarget
} from '../src/core/interactionGeometry'
import { FabLayoutSchema } from '../src/core/schema'
import { humanoidFootTarget } from '../src/render/agents/humanoidGait'
import { solveTwoBone } from '../src/render/agents/limbIk'
import { SimWorld } from '../src/sim/world'

const layout = FabLayoutSchema.parse(layoutJson)

describe('humanoid physical interaction geometry', () => {
  it('places both gas-valve grips on the rendered wheel surface within arm reach', () => {
    for (const manipulation of [0, 0.25, 0.5, 0.75, 1]) {
      for (const side of [-1, 1] as const) {
        const target = gasValveGripTarget(side, manipulation)
        const shoulder = [0, 1.48, side * 0.34] as const
        const distance = Math.hypot(
          target[0] - shoulder[0],
          target[1] - shoulder[1],
          target[2] - shoulder[2]
        )
        const residual = gasValveGripResidual(target)
        expect(distance).toBeLessThanOrEqual(HUMANOID_UPPER_ARM_LENGTH + HUMANOID_LOWER_ARM_LENGTH)
        expect(residual.frontSurface).toBeLessThan(0.000_001)
        expect(residual.ringCenterline).toBeLessThan(0.000_001)
      }
    }
  })

  it('solves a reachable two-link arm without changing either segment length', () => {
    const start = [0, 1.48, 0.34] as const
    const target = gasValveGripTarget(1, 0.5)
    const solution = solveTwoBone(
      start,
      target,
      HUMANOID_UPPER_ARM_LENGTH,
      HUMANOID_LOWER_ARM_LENGTH,
      [0, -1, 0.18]
    )
    expect(solution.reachable).toBe(true)
    expect(Math.hypot(
      solution.elbow[0] - start[0],
      solution.elbow[1] - start[1],
      solution.elbow[2] - start[2]
    )).toBeCloseTo(HUMANOID_UPPER_ARM_LENGTH, 6)
    expect(Math.hypot(
      solution.end[0] - solution.elbow[0],
      solution.end[1] - solution.elbow[1],
      solution.end[2] - solution.elbow[2]
    )).toBeCloseTo(HUMANOID_LOWER_ARM_LENGTH, 6)
    expect(solution.end).toEqual(expect.arrayContaining(target.map((value) => expect.closeTo(value, 6))))
  })

  it('derives a valve-facing RMF work pose at the physical standoff', () => {
    const world = new SimWorld(layout, 420)
    world.triggerEmergency('gasLeak')
    world.setPhase('alarm')
    world.tick(1 / 60)
    const task = world.humanoidTasks.find((candidate) => candidate.kind === 'gas_isolation')!
    const device = layout.emergency.safetyDevices.find((candidate) => candidate.id === task.targetId)!
    expect(Math.hypot(task.targetX - device.position[0], task.targetZ - device.position[2])).toBeCloseTo(GAS_VALVE_STANDOFF, 6)
    expect(task.targetYaw).toBeCloseTo(device.heading, 6)
  })

  it('keeps one humanoid foot planted while the opposite foot follows a reachable swing arc', () => {
    for (let sample = 0; sample < 20; sample++) {
      const phase = sample / 20
      const left = humanoidFootTarget(phase, 1.15)
      const right = humanoidFootTarget(phase, 1.15, true)
      expect(left.stance || right.stance).toBe(true)
      for (const [target, side] of [[left, -1], [right, 1]] as const) {
        const distance = Math.hypot(target.forward, target.height - 0.82, side * 0.16 - side * 0.16)
        expect(distance).toBeLessThan(0.39 + 0.39)
        if (target.stance) expect(target.height).toBeCloseTo(0.08, 6)
      }
    }
    const earlyStance = humanoidFootTarget(0.1, 1.15)
    const lateStance = humanoidFootTarget(0.5, 1.15)
    const swing = humanoidFootTarget(0.8, 1.15)
    expect(earlyStance.forward).toBeGreaterThan(lateStance.forward)
    expect(swing.stance).toBe(false)
    expect(swing.height).toBeGreaterThan(0.08)
  })
})
