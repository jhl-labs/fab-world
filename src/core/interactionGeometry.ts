export const GAS_VALVE_STANDOFF = 0.75
// No person may enter this radius around the valve access pose after the
// physical-work gate has been authorized. The assigned humanoid is measured
// separately so the demo can report observed staffing, not a counterfactual.
export const GAS_WORK_ZONE_RADIUS = 1.5
// The access pose is behind the device heading, so the wheel is mounted on
// that same service face rather than on the far side of the cabinet.
export const GAS_VALVE_WHEEL_OFFSET = -0.2
export const GAS_VALVE_WHEEL_HEIGHT = 1.05
export const GAS_VALVE_WHEEL_RING_RADIUS = 0.22
export const GAS_VALVE_WHEEL_TUBE_RADIUS = 0.045

export const HUMANOID_UPPER_ARM_LENGTH = 0.31
export const HUMANOID_LOWER_ARM_LENGTH = 0.31
export const HUMANOID_HAND_RADIUS = 0.095 * 0.9
export const HUMANOID_SHOULDER_HEIGHT = 1.48
export const HUMANOID_SHOULDER_LATERAL = 0.34

export function gasValveGripTarget(side: -1 | 1, manipulation: number): readonly [number, number, number] {
  const regrip = Math.sin(Math.max(0, Math.min(1, manipulation)) * Math.PI * 4) * 0.26
  const angle = side === 1 ? 0.65 + regrip : Math.PI - 0.65 + regrip
  return [
    GAS_VALVE_STANDOFF + GAS_VALVE_WHEEL_OFFSET - GAS_VALVE_WHEEL_TUBE_RADIUS - HUMANOID_HAND_RADIUS,
    GAS_VALVE_WHEEL_HEIGHT + Math.sin(angle) * GAS_VALVE_WHEEL_RING_RADIUS,
    Math.cos(angle) * GAS_VALVE_WHEEL_RING_RADIUS
  ]
}

export function gasValveGripResidual(target: readonly [number, number, number]): {
  frontSurface: number
  ringCenterline: number
} {
  const wheelFront = GAS_VALVE_STANDOFF + GAS_VALVE_WHEEL_OFFSET - GAS_VALVE_WHEEL_TUBE_RADIUS
  return {
    frontSurface: Math.abs(target[0] + HUMANOID_HAND_RADIUS - wheelFront),
    ringCenterline: Math.abs(
      Math.hypot(target[1] - GAS_VALVE_WHEEL_HEIGHT, target[2]) - GAS_VALVE_WHEEL_RING_RADIUS
    )
  }
}
