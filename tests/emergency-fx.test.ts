import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { EmergencyFx } from '../src/render/fx/emergencyFx'

describe('emergency visual effects', () => {
  it('keeps a gas leak visible above equipment and marks its service-side source', () => {
    const scene = new THREE.Scene()
    const fx = new EmergencyFx(scene)
    fx.setState('gasLeak', 'detected', [10, 20], [0, 2.4])
    fx.setRadius(1)
    fx.update(1 / 60)

    const cloud = scene.getObjectByName('gas-leak-cloud') as THREE.InstancedMesh
    const sourceJet = scene.getObjectByName('gas-leak-source-jet') as THREE.Mesh
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    let highestParticle = 0
    for (let index = 0; index < cloud.count; index++) {
      cloud.getMatrixAt(index, matrix)
      position.setFromMatrixPosition(matrix)
      highestParticle = Math.max(highestParticle, position.y)
    }

    expect(cloud.visible).toBe(true)
    expect((cloud.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThanOrEqual(0.2)
    expect(highestParticle).toBeGreaterThan(4)
    expect(sourceJet.visible).toBe(true)
    expect(sourceJet.position.z).toBeCloseTo(2.4)

    fx.setState('fire', 'detected', [10, 20])
    expect(sourceJet.visible).toBe(false)
    const flames = scene.getObjectByName('fire-flame-lobes') as THREE.InstancedMesh
    const smoke = scene.getObjectByName('fire-smoke-cloudlets') as THREE.InstancedMesh
    expect(flames.visible).toBe(true)
    expect(flames.geometry.getAttribute('position').count).toBeGreaterThan(120)
    expect(smoke.geometry.getAttribute('position').count).toBeGreaterThan(300)

    fx.setState('medical', 'response', [4, 8])
    fx.update(1 / 60)
    const medicalBeacon = scene.getObjectByName('medical-incident-beacon') as THREE.Group
    expect(medicalBeacon.visible).toBe(true)
    expect(medicalBeacon.children).toHaveLength(2)
    expect(medicalBeacon.position.y).toBeGreaterThan(2)
    fx.dispose()
  })
})
