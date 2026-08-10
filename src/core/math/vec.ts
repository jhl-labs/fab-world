export type Vec2 = readonly [number, number]
export type Vec3 = readonly [number, number, number]
export const distance2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])
export const distance3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t
export const pointInPolygon = (point: Vec2, polygon: readonly Vec2[]): boolean => {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!
    const [xj, zj] = polygon[j]!
    if ((zi > point[1]) !== (zj > point[1]) && point[0] < (xj - xi) * (point[1] - zi) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
