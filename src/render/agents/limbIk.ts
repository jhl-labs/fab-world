export type Vec3Tuple = readonly [number, number, number]

export interface TwoBoneSolution {
  upperDirection: Vec3Tuple
  lowerDirection: Vec3Tuple
  elbow: Vec3Tuple
  end: Vec3Tuple
  reachable: boolean
}

export function solveTwoBone(
  start: Vec3Tuple,
  target: Vec3Tuple,
  upperLength: number,
  lowerLength: number,
  bendHint: Vec3Tuple = [0, -1, 0]
): TwoBoneSolution {
  const delta = subtract(target, start)
  const requestedDistance = length(delta)
  const maximum = Math.max(0.0001, upperLength + lowerLength - 0.0001)
  const minimum = Math.abs(upperLength - lowerLength) + 0.0001
  const distance = Math.min(maximum, Math.max(minimum, requestedDistance))
  const direction = normalize(delta, [1, 0, 0])
  const end = add(start, scale(direction, distance))
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance)
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2))
  const projectedHint = subtract(bendHint, scale(direction, dot(bendHint, direction)))
  const perpendicular = normalize(projectedHint, normalize(cross(direction, [0, 0, 1]), [0, -1, 0]))
  const elbow = add(add(start, scale(direction, along)), scale(perpendicular, height))
  return {
    upperDirection: normalize(subtract(elbow, start), [0, -1, 0]),
    lowerDirection: normalize(subtract(end, elbow), [0, -1, 0]),
    elbow,
    end,
    reachable: requestedDistance <= maximum + 0.0001 && requestedDistance >= minimum - 0.0001
  }
}

const add = (left: Vec3Tuple, right: Vec3Tuple): Vec3Tuple =>
  [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
const subtract = (left: Vec3Tuple, right: Vec3Tuple): Vec3Tuple =>
  [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
const scale = (value: Vec3Tuple, amount: number): Vec3Tuple =>
  [value[0] * amount, value[1] * amount, value[2] * amount]
const dot = (left: Vec3Tuple, right: Vec3Tuple): number =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
const cross = (left: Vec3Tuple, right: Vec3Tuple): Vec3Tuple => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0]
]
const length = (value: Vec3Tuple): number => Math.hypot(value[0], value[1], value[2])
const normalize = (value: Vec3Tuple, fallback: Vec3Tuple): Vec3Tuple => {
  const magnitude = length(value)
  return magnitude < 0.000001 ? fallback : scale(value, 1 / magnitude)
}
