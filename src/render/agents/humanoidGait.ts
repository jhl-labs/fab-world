export interface HumanoidFootTarget {
  forward: number
  height: number
  stance: boolean
}

const DUTY_FACTOR = 0.62
const FOOT_HEIGHT = 0.08

export function humanoidFootTarget(
  cyclePhase: number,
  speed: number,
  opposite = false
): HumanoidFootTarget {
  const phase = wrap01(cyclePhase + (opposite ? 0.5 : 0))
  // The simulation phase is already advanced at roughly one cycle per metre.
  // The former speed/frequency division made every walk use a full 62cm step,
  // even when a robot was creeping into a work position. Scale the visual
  // stride with speed while retaining a small shuffle at very low velocity.
  const stepLength = Math.min(0.4, Math.max(0.14, 0.12 + Math.max(0, speed) * 0.22))
  if (phase < DUTY_FACTOR) {
    const progress = phase / DUTY_FACTOR
    return {
      forward: stepLength * (0.5 - progress),
      height: FOOT_HEIGHT,
      stance: true
    }
  }
  const progress = (phase - DUTY_FACTOR) / (1 - DUTY_FACTOR)
  const smooth = progress * progress * (3 - 2 * progress)
  const lift = Math.sin(progress * Math.PI) * Math.min(0.11, speed * 0.11)
  return {
    forward: stepLength * (-0.5 + smooth),
    height: FOOT_HEIGHT + lift,
    stance: false
  }
}

const wrap01 = (value: number): number => ((value % 1) + 1) % 1
