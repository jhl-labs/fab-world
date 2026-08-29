export interface PersonLocomotionPose {
  pace: number
  bob: number
  torsoLean: number
  headForward: number
  headLean: number
  lateralSway: number
  leftUpperArm: number
  leftForearm: number
  rightUpperArm: number
  rightForearm: number
  leftThigh: number
  leftShin: number
  rightThigh: number
  rightShin: number
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/**
 * Produces deliberately different silhouettes for routine walking (state 1)
 * and emergency running (state 2). Angles are absolute rotations around the
 * character's local Z axis, matching PersonRenderer's two-segment limbs.
 */
export function personLocomotionPose(
  animation: number,
  speed: number,
  cyclePhase: number
): PersonLocomotionPose {
  const cycle = cyclePhase * Math.PI * 2
  const wave = Math.sin(cycle)
  const bounce = 1 - Math.cos(cycle * 2)

  if (animation === 2) {
    // A controlled emergency run: forward centre of mass, compact bent arms,
    // long airborne stride, and substantially more vertical displacement.
    // The blend lets a runner naturally shorten the stride near a muster slot.
    const pace = clamp01(speed / 2.5)
    const runBlend = clamp01(speed / 1.35)
    const armAmplitude = 0.88 * runBlend
    const legAmplitude = 0.94 * runBlend
    const leftUpperArm = -wave * armAmplitude
    const rightUpperArm = wave * armAmplitude
    const leftThigh = wave * legAmplitude
    const rightThigh = -wave * legAmplitude
    const elbowFlex = 0.92 * runBlend
    const baseLeftForearm = -0.16 * (1 - runBlend)
    const baseRightForearm = -0.11 * (1 - runBlend)
    const leftKneeFlex = (0.2 + Math.max(0, wave) * 0.86) * runBlend
    const rightKneeFlex = (0.2 + Math.max(0, -wave) * 0.86) * runBlend
    return {
      pace,
      bob: bounce * runBlend * 0.027,
      torsoLean: -0.23 * clamp01(speed / 0.9),
      headForward: 0.075 * clamp01(speed / 0.9),
      headLean: -0.075 * clamp01(speed / 0.9),
      lateralSway: wave * runBlend * 0.012,
      leftUpperArm,
      leftForearm: baseLeftForearm + leftUpperArm + elbowFlex,
      rightUpperArm,
      rightForearm: baseRightForearm + rightUpperArm + elbowFlex,
      leftThigh,
      leftShin: leftThigh - leftKneeFlex,
      rightThigh,
      rightShin: rightThigh - rightKneeFlex
    }
  }

  const pace = animation === 1 ? clamp01(speed / 1.2) : 0
  const gait = wave * pace * 0.52
  return {
    pace,
    bob: bounce * pace * 0.009,
    torsoLean: 0,
    headForward: 0,
    headLean: 0,
    lateralSway: gait * 0.028,
    leftUpperArm: -gait * 0.62,
    leftForearm: -gait * 0.62 - 0.16 - Math.max(0, -gait) * 0.24,
    rightUpperArm: gait * 0.62,
    rightForearm: gait * 0.62 - 0.11 - Math.max(0, gait) * 0.24,
    leftThigh: gait * 0.62,
    leftShin: -Math.max(0, gait) * 0.48,
    rightThigh: -gait * 0.62,
    rightShin: -Math.max(0, -gait) * 0.48
  }
}
