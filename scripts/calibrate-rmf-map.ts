import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CalibrationInputSchema, solveMapCalibration } from '../services/rmf-bridge/calibration'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function rounded(value: number): number {
  return Number(value.toFixed(6))
}

function main(): void {
  const inputPath = process.argv[2]
  if (!inputPath || inputPath.startsWith('--')) {
    throw new Error('Usage: npm run calibrate:rmf -- <points.json> [--max-error 0.25]')
  }
  const maxError = Number(argument('--max-error') ?? 0.25)
  if (!Number.isFinite(maxError) || maxError <= 0) throw new Error('--max-error must be a positive number')
  const input = CalibrationInputSchema.parse(JSON.parse(readFileSync(resolve(inputPath), 'utf8')) as unknown)
  const result = solveMapCalibration(input)
  const output = {
    maps: {
      [result.rmfMap]: {
        fabMap: result.transform.fabMap,
        offsetX: rounded(result.transform.offsetX),
        offsetZ: rounded(result.transform.offsetZ),
        yaw: rounded(result.transform.yaw),
        scale: rounded(result.transform.scale)
      }
    },
    quality: {
      points: result.residuals.length,
      pointSpan: rounded(result.pointSpan),
      geometryRatio: rounded(result.geometryRatio),
      rmsError: rounded(result.rmsError),
      maxError: rounded(result.maxError),
      maxAllowedError: maxError,
      accepted: result.maxError <= maxError
    },
    residuals: result.residuals.map((residual) => ({
      name: residual.name,
      predicted: residual.predicted.map(rounded),
      measured: residual.measured.map(rounded),
      error: rounded(residual.error)
    }))
  }
  console.log(JSON.stringify(output, null, 2))
  if (result.maxError > maxError) {
    throw new Error(`Calibration max error ${result.maxError.toFixed(3)}m exceeds ${maxError.toFixed(3)}m`)
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
