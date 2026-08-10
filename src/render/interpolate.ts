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
  entityCount = 0
  simTime = 0
  constructor(buffer?: SharedArrayBuffer) {
    if (buffer) { this.header = new Int32Array(buffer, 0, POSE_HEADER_INTS); this.shared = new Float32Array(buffer, POSE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT, POSE_FLOATS) }
  }
  update(): void {
    if (!this.header || !this.shared) return
    const generation = Atomics.load(this.header, PoseHeader.GENERATION)
    if (generation === this.generation) return
    this.previous.set(this.current)
    const front = Atomics.load(this.header, PoseHeader.FRONT_BUFFER)
    const offset = front * MAX_ENTITIES * POSE_STRIDE
    this.current.set(this.shared.subarray(offset, offset + MAX_ENTITIES * POSE_STRIDE))
    this.entityCount = Atomics.load(this.header, PoseHeader.ENTITY_COUNT); this.simTime = Atomics.load(this.header, PoseHeader.SIM_TIME_MS) / 1000; this.generation = generation
  }
  acceptFallback(buffer: ArrayBuffer, generation: number, entityCount: number, simTimeMs: number): void {
    if (generation <= this.generation) return
    this.previous.set(this.current); this.current = new Float32Array(buffer); this.generation = generation; this.entityCount = entityCount; this.simTime = simTimeMs / 1000
  }
  pose(index: number, alpha = 0.65): SampledPose {
    const slot = index * POSE_STRIDE
    const flags = this.current[slot + PoseSlot.FLAGS]!
    const previousMeasured = (this.previous[slot + PoseSlot.FLAGS]! & PoseFlags.MEASURED_HAND_POSE) !== 0
    const measured = (flags & PoseFlags.MEASURED_HAND_POSE) !== 0
    const handValue = (poseSlot: number): number => previousMeasured
      ? lerp(this.previous[slot + poseSlot]!, this.current[slot + poseSlot]!, alpha)
      : this.current[slot + poseSlot]!
    return {
      x: lerp(this.previous[slot + PoseSlot.X]!, this.current[slot + PoseSlot.X]!, alpha), y: lerp(this.previous[slot + PoseSlot.Y]!, this.current[slot + PoseSlot.Y]!, alpha), z: lerp(this.previous[slot + PoseSlot.Z]!, this.current[slot + PoseSlot.Z]!, alpha),
      yaw: lerpAngle(this.previous[slot + PoseSlot.YAW]!, this.current[slot + PoseSlot.YAW]!, alpha), speed: this.current[slot + PoseSlot.SPEED]!, animation: this.current[slot + PoseSlot.ANIM_STATE]!, phase: this.current[slot + PoseSlot.ANIM_PHASE]!, flags, auxA: this.current[slot + PoseSlot.AUX_A]!, auxB: this.current[slot + PoseSlot.AUX_B]!,
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
}
