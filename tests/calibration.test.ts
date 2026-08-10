import { describe, expect, it } from 'vitest'
import { solveMapCalibration } from '../services/rmf-bridge/calibration'

describe('RMF map calibration', () => {
  it('recovers a known rotation, scale, and translation from measured control points', () => {
    const yaw = 0.37
    const scale = 1.25
    const offsetX = -42
    const offsetZ = 18
    const cosine = Math.cos(yaw)
    const sine = Math.sin(yaw)
    const rmfPoints: Array<[number, number]> = [[0, 0], [15, 2], [-4, 18], [22, 25]]
    const result = solveMapCalibration({
      rmfMap: 'L1',
      fabMap: 'fab-L1',
      points: rmfPoints.map((rmf, index) => ({
        name: `point-${index}`,
        rmf,
        fab: [
          offsetX + scale * (cosine * rmf[0] - sine * rmf[1]),
          offsetZ + scale * (sine * rmf[0] + cosine * rmf[1])
        ]
      }))
    })
    expect(result.transform.offsetX).toBeCloseTo(offsetX, 10)
    expect(result.transform.offsetZ).toBeCloseTo(offsetZ, 10)
    expect(result.transform.yaw).toBeCloseTo(yaw, 10)
    expect(result.transform.scale).toBeCloseTo(scale, 10)
    expect(result.maxError).toBeLessThan(1e-10)
    expect(result.geometryRatio).toBeGreaterThan(0.01)
  })

  it('reports residual error instead of hiding inconsistent field measurements', () => {
    const result = solveMapCalibration({
      rmfMap: 'L1',
      fabMap: 'fab-L1',
      points: [
        { name: 'a', rmf: [0, 0], fab: [10, 20] },
        { name: 'b', rmf: [10, 0], fab: [20.1, 20] },
        { name: 'c', rmf: [0, 10], fab: [10, 30.2] },
        { name: 'bad', rmf: [10, 10], fab: [21, 31] }
      ]
    })
    expect(result.rmsError).toBeGreaterThan(0.2)
    expect(result.maxError).toBeGreaterThan(result.rmsError)
    expect(result.residuals.find((residual) => residual.name === 'bad')?.error).toBeGreaterThan(0.2)
  })

  it('rejects coincident or insufficient calibration points', () => {
    expect(() => solveMapCalibration({
      rmfMap: 'L1',
      fabMap: 'fab-L1',
      points: [
        { name: 'a', rmf: [1, 1], fab: [0, 0] },
        { name: 'b', rmf: [1, 1], fab: [1, 0] },
        { name: 'c', rmf: [1, 1], fab: [0, 1] }
      ]
    })).toThrow(/span more than one location/)
    expect(() => solveMapCalibration({
      rmfMap: 'L1',
      fabMap: 'fab-L1',
      points: [
        { name: 'a', rmf: [0, 0], fab: [0, 0] },
        { name: 'b', rmf: [1, 0], fab: [1, 0] }
      ]
    })).toThrow()
    expect(() => solveMapCalibration({
      rmfMap: 'L1',
      fabMap: 'fab-L1',
      points: [
        { name: 'a', rmf: [0, 0], fab: [0, 0] },
        { name: 'b', rmf: [5, 0], fab: [5, 0] },
        { name: 'c', rmf: [10, 0], fab: [10, 0] }
      ]
    })).toThrow(/must not be collinear/)
  })
})
