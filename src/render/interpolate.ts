import { MAX_ENTITIES, POSE_FLOATS, POSE_HEADER_INTS, POSE_STRIDE, PoseFlags, PoseHeader, PoseSlot } from '../core/protocol'
import { lerp, lerpAngle } from '../core/math/vec'

export interface SampledPose {
  x: number
  y: number
  z: number
  yaw: number
  speed: number
  animation: number
  phase: number
  flags: number
  auxA: number
  auxB: number
  leftHandPosition?: readonly [number, number, number]
  rightHandPosition?: readonly [number, number, number]
}

export class PoseReader {
  private readonly header?: Int32Array
  private readonly shared?: Float32Array
  private previous = new Float32Array(MAX_ENTITIES * POSE_STRIDE)
  private current = new Float32Array(MAX_ENTITIES * POSE_STRIDE)
  private generation = -1
  private snapshotReceivedAt = performance.now()
  private snapshotIntervalMs = 1000 / 60
  private snapshotSimInterval = 1 / 60
  private hasSnapshot = false
  private frameAlpha = 1
  entityCount = 0
  simTime = 0
  constructor(buffer?: SharedArrayBuffer) {
    if (buffer) { this.header = new Int32Array(buffer, 0, POSE_HEADER_INTS); this.shared = new Float32Array(buffer, POSE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT, POSE_FLOATS) }
  }
  update(): void {
    if (!this.header || !this.shared) {
      this.frameAlpha = this.interpolationAlpha()
      return
    }
    const generation = Atomics.load(this.header, PoseHeader.GENERATION)
    if (generation === this.generation) {
      this.frameAlpha = this.interpolationAlpha()
      return
    }
    const firstSnapshot = this.generation < 0
    this.previous.set(this.current)
    const front = Atomics.load(this.header, PoseHeader.FRONT_BUFFER)
    const offset = front * MAX_ENTITIES * POSE_STRIDE
    this.current.set(this.shared.subarray(offset, offset + MAX_ENTITIES * POSE_STRIDE))
    if (firstSnapshot) this.previous.set(this.current)
    const nextSimTime = Atomics.load(this.header, PoseHeader.SIM_TIME_MS) / 1000
    if (!firstSnapshot) this.snapshotSimInterval = Math.max(1 / 240, Math.min(1, nextSimTime - this.simTime))
    this.entityCount = Atomics.load(this.header, PoseHeader.ENTITY_COUNT); this.simTime = nextSimTime; this.generation = generation
    this.recordSnapshotArrival()
    this.frameAlpha = this.interpolationAlpha()
  }
  acceptFallback(buffer: ArrayBuffer, generation: number, entityCount: number, simTimeMs: number): void {
    if (generation <= this.generation) return
    const firstSnapshot = this.generation < 0
    this.previous.set(this.current); this.current = new Float32Array(buffer)
    if (firstSnapshot) this.previous.set(this.current)
    const nextSimTime = simTimeMs / 1000
    if (!firstSnapshot) this.snapshotSimInterval = Math.max(1 / 240, Math.min(1, nextSimTime - this.simTime))
    this.generation = generation; this.entityCount = entityCount; this.simTime = nextSimTime
    this.recordSnapshotArrival()
  }
  pose(index: number, alpha?: number): SampledPose {
    const timeline = alpha ?? this.frameAlpha
    const blend = Math.max(0, Math.min(1, timeline))
    const extrapolation = Math.max(0, timeline - 1)
    const slot = index * POSE_STRIDE
    const flags = this.current[slot + PoseSlot.FLAGS]!
    const previousYaw = this.previous[slot + PoseSlot.YAW]!
    const currentYaw = this.current[slot + PoseSlot.YAW]!
    const previousSpeed = this.previous[slot + PoseSlot.SPEED]!
    const currentSpeed = this.current[slot + PoseSlot.SPEED]!
    const previousX = this.previous[slot + PoseSlot.X]!
    const previousZ = this.previous[slot + PoseSlot.Z]!
    const currentX = this.current[slot + PoseSlot.X]!
    const currentZ = this.current[slot + PoseSlot.Z]!
    const x = hermite(
      previousX,
      currentX,
      Math.cos(previousYaw) * previousSpeed * this.snapshotSimInterval,
      Math.cos(currentYaw) * currentSpeed * this.snapshotSimInterval,
      blend
    ) + Math.cos(currentYaw) * currentSpeed * this.snapshotSimInterval * extrapolation
    const z = hermite(
      previousZ,
      currentZ,
      Math.sin(previousYaw) * previousSpeed * this.snapshotSimInterval,
      Math.sin(currentYaw) * currentSpeed * this.snapshotSimInterval,
      blend
    ) + Math.sin(currentYaw) * currentSpeed * this.snapshotSimInterval * extrapolation
    const previousMeasured = (this.previous[slot + PoseSlot.FLAGS]! & PoseFlags.MEASURED_HAND_POSE) !== 0
    const measured = (flags & PoseFlags.MEASURED_HAND_POSE) !== 0
    const handValue = (poseSlot: number): number => previousMeasured
      ? lerp(this.previous[slot + poseSlot]!, this.current[slot + poseSlot]!, blend)
      : this.current[slot + poseSlot]!
    return {
      x, y: lerp(this.previous[slot + PoseSlot.Y]!, this.current[slot + PoseSlot.Y]!, blend), z,
      yaw: lerpAngle(previousYaw, currentYaw, blend), speed: lerp(previousSpeed, currentSpeed, blend), animation: this.current[slot + PoseSlot.ANIM_STATE]!, phase: lerpCycle(this.previous[slot + PoseSlot.ANIM_PHASE]!, this.current[slot + PoseSlot.ANIM_PHASE]!, timeline), flags, auxA: lerp(this.previous[slot + PoseSlot.AUX_A]!, this.current[slot + PoseSlot.AUX_A]!, blend), auxB: lerp(this.previous[slot + PoseSlot.AUX_B]!, this.current[slot + PoseSlot.AUX_B]!, blend),
      ...(measured ? {
        leftHandPosition: [
          handValue(PoseSlot.LEFT_HAND_X),
          handValue(PoseSlot.LEFT_HAND_Y),
          handValue(PoseSlot.LEFT_HAND_Z)
        ] as const,
        rightHandPosition: [
          handValue(PoseSlot.RIGHT_HAND_X),
          handValue(PoseSlot.RIGHT_HAND_Y),
          handValue(PoseSlot.RIGHT_HAND_Z)
        ] as const
      } : {})
    }
  }
  private recordSnapshotArrival(): void {
    const now = performance.now()
    if (this.hasSnapshot) {
      const interval = Math.max(4, Math.min(250, now - this.snapshotReceivedAt))
      this.snapshotIntervalMs = this.snapshotIntervalMs * 0.72 + interval * 0.28
    }
    this.snapshotReceivedAt = now
    this.hasSnapshot = true
  }
  private interpolationAlpha(): number {
    if (!this.hasSnapshot) return 1
    return Math.max(0, Math.min(1.25, (performance.now() - this.snapshotReceivedAt) / Math.max(4, this.snapshotIntervalMs)))
  }
}

function hermite(start: number, end: number, startTangent: number, endTangent: number, alpha: number): number {
  const squared = alpha * alpha
  const cubed = squared * alpha
  return (2 * cubed - 3 * squared + 1) * start +
    (cubed - 2 * squared + alpha) * startTangent +
    (-2 * cubed + 3 * squared) * end +
    (cubed - squared) * endTangent
}

function lerpCycle(previous: number, current: number, alpha: number): number {
  let delta = current - previous
  if (delta > 0.5) delta -= 1
  else if (delta < -0.5) delta += 1
  const value = previous + delta * alpha
  const normalized = ((value % 1) + 1) % 1
  return normalized > 1 - 1e-6 ? 0 : normalized
}
