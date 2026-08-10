import { z } from 'zod'
import type { MapTransform } from './config'

export const CalibrationInputSchema = z.object({
  rmfMap: z.string().min(1),
  fabMap: z.string().min(1),
  points: z.array(z.object({
    name: z.string().min(1),
    rmf: z.tuple([z.number().finite(), z.number().finite()]),
    fab: z.tuple([z.number().finite(), z.number().finite()])
  })).min(3)
})

export type CalibrationInput = z.infer<typeof CalibrationInputSchema>

export interface CalibrationResidual {
  name: string
  predicted: [number, number]
  measured: [number, number]
  error: number
}

export interface CalibrationResult {
  rmfMap: string
  transform: MapTransform
  rmsError: number
  maxError: number
  pointSpan: number
  geometryRatio: number
  residuals: CalibrationResidual[]
}

/** Least-squares 2D similarity fit without reflection: scale × rotation + translation. */
export function solveMapCalibration(raw: CalibrationInput): CalibrationResult {
  const input = CalibrationInputSchema.parse(raw)
  const count = input.points.length
  const rmfCenter = input.points.reduce<[number, number]>((sum, point) => [
    sum[0] + point.rmf[0] / count,
    sum[1] + point.rmf[1] / count
  ], [0, 0])
  const fabCenter = input.points.reduce<[number, number]>((sum, point) => [
    sum[0] + point.fab[0] / count,
    sum[1] + point.fab[1] / count
  ], [0, 0])

  let denominator = 0
  let varianceX = 0
  let varianceY = 0
  let covariance = 0
  let real = 0
  let imaginary = 0
  for (const point of input.points) {
    const x = point.rmf[0] - rmfCenter[0]
    const y = point.rmf[1] - rmfCenter[1]
    const u = point.fab[0] - fabCenter[0]
    const v = point.fab[1] - fabCenter[1]
    denominator += x * x + y * y
    varianceX += x * x
    varianceY += y * y
    covariance += x * y
    real += x * u + y * v
    imaginary += x * v - y * u
  }
  if (denominator < 1e-8) throw new Error('RMF calibration points must span more than one location')
  const discriminant = Math.sqrt((varianceX - varianceY) ** 2 + 4 * covariance ** 2)
  const majorVariance = (denominator + discriminant) / 2
  const minorVariance = Math.max(0, (denominator - discriminant) / 2)
  const geometryRatio = minorVariance / majorVariance
  if (geometryRatio < 0.01) throw new Error('RMF calibration points must not be collinear; spread points across both map axes')

  const a = real / denominator
  const b = imaginary / denominator
  const scale = Math.hypot(a, b)
  if (!Number.isFinite(scale) || scale < 1e-8) throw new Error('Calibration produced a degenerate scale')
  const yaw = Math.atan2(b, a)
  const offsetX = fabCenter[0] - (a * rmfCenter[0] - b * rmfCenter[1])
  const offsetZ = fabCenter[1] - (b * rmfCenter[0] + a * rmfCenter[1])
  const transform: MapTransform = { fabMap: input.fabMap, offsetX, offsetZ, yaw, scale }
  const residuals = input.points.map<CalibrationResidual>((point) => {
    const predicted: [number, number] = [
      offsetX + a * point.rmf[0] - b * point.rmf[1],
      offsetZ + b * point.rmf[0] + a * point.rmf[1]
    ]
    return {
      name: point.name,
      predicted,
      measured: [...point.fab],
      error: Math.hypot(predicted[0] - point.fab[0], predicted[1] - point.fab[1])
    }
  })
  const rmsError = Math.sqrt(residuals.reduce((sum, residual) => sum + residual.error ** 2, 0) / residuals.length)
  const maxError = Math.max(...residuals.map((residual) => residual.error))
  const pointSpan = maximumPairDistance(input.points.map((point) => point.rmf))
  if (pointSpan < 1) throw new Error('RMF calibration points must be at least 1 metre apart')
  return { rmfMap: input.rmfMap, transform, rmsError, maxError, pointSpan, geometryRatio, residuals }
}

function maximumPairDistance(points: Array<readonly [number, number]>): number {
  let maximum = 0
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      maximum = Math.max(maximum, Math.hypot(points[left]![0] - points[right]![0], points[left]![1] - points[right]![1]))
    }
  }
  return maximum
}
