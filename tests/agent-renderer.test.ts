import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { EntityMeta } from '../src/core/protocol'
import { AgentRenderer } from '../src/render/agents/agentRenderer'
import { CarrierRenderer } from '../src/render/agents/carrierRenderer'
import { HumanoidRenderer } from '../src/render/agents/humanoidRenderer'
import { PersonRenderer } from '../src/render/agents/personRenderer'

describe('procedural agent appearance', () => {
  it('builds layered people and humanoids as merge-compatible runtime geometry', () => {
    const scene = new THREE.Scene()
    const entities: EntityMeta[] = [
      { id: 'humanoid-test', index: 0, kind: 'humanoid', name: 'Test humanoid' },
      { id: 'person-test', index: 1, kind: 'person', name: 'Test engineer', role: 'engineer' }
    ]

    const humanoids = new HumanoidRenderer(scene, entities)
    const people = new PersonRenderer(scene, entities)
    const personMeshes = scene.children.filter((object): object is THREE.InstancedMesh =>
      object instanceof THREE.InstancedMesh && object.name.startsWith('person-')
    )
    const humanoidRoot = scene.getObjectByName('Test humanoid')
    let humanoidMeshCount = 0
    humanoidRoot?.traverse((object) => { if (object instanceof THREE.Mesh) humanoidMeshCount++ })
    const triangles = (geometry: THREE.BufferGeometry): number =>
      (geometry.index?.count ?? geometry.getAttribute('position').count) / 3
    const personHand = scene.getObjectByName('person-leftHand') as THREE.InstancedMesh
    const personTorso = scene.getObjectByName('person-torso') as THREE.InstancedMesh
    const humanoidHands: THREE.Mesh[] = []
    const coloredHumanoidShells: THREE.Mesh[] = []
    humanoidRoot?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      if (object.name === 'humanoid-articulated-hand') humanoidHands.push(object)
      if (object.name.endsWith('-shell') && object.geometry.hasAttribute('color')) coloredHumanoidShells.push(object)
    })

    expect(humanoidRoot).toBeDefined()
    expect(humanoidMeshCount).toBeGreaterThan(12)
    expect(humanoidMeshCount).toBeLessThan(30)
    expect(personMeshes).toHaveLength(24)
    expect(personMeshes.every((mesh) => mesh.geometry.hasAttribute('color'))).toBe(true)
    expect(triangles(personHand.geometry)).toBeGreaterThan(200)
    expect(triangles(personTorso.geometry)).toBeGreaterThan(400)
    expect(humanoidHands).toHaveLength(2)
    expect(humanoidHands.every((mesh) => triangles(mesh.geometry) > 500)).toBe(true)
    expect(coloredHumanoidShells).toHaveLength(8)

    people.dispose()
    humanoids.dispose()
  })

  it('keeps detailed OHT, vehicles, arms, and carriers inside fixed instanced render layers', () => {
    const scene = new THREE.Scene()
    const entities: EntityMeta[] = [
      { id: 'oht-test', index: 0, kind: 'oht', name: 'Test OHT' },
      { id: 'agv-test', index: 1, kind: 'agv', name: 'Test AGV' },
      { id: 'igv-test', index: 2, kind: 'igv', name: 'Test IGV' },
      { id: 'arm-test', index: 3, kind: 'arm', name: 'Test arm' }
    ]

    const agents = new AgentRenderer(scene, entities)
    const carriers = new CarrierRenderer(scene, entities)
    const agentMeshes = scene.children.filter((object): object is THREE.InstancedMesh =>
      object instanceof THREE.InstancedMesh && object.name.startsWith('agent-')
    )
    const carrier = scene.getObjectByName('vehicle-wafer-carriers') as THREE.InstancedMesh
    const triangles = (geometry: THREE.BufferGeometry): number =>
      (geometry.index?.count ?? geometry.getAttribute('position').count) / 3

    expect(agentMeshes).toHaveLength(16)
    expect(['oht', 'agv', 'igv', 'arm'].every((kind) =>
      scene.getObjectByName(`agent-${kind}-base`) instanceof THREE.InstancedMesh
    )).toBe(true)
    expect(agentMeshes.every((mesh) => triangles(mesh.geometry) > 20)).toBe(true)
    expect(carrier).toBeInstanceOf(THREE.InstancedMesh)
    expect(triangles(carrier.geometry)).toBeGreaterThan(100)

    carriers.dispose()
    agents.dispose()
  })
})
