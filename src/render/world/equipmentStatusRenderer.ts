import * as THREE from 'three'
import type { EquipmentStateView } from '../../core/protocol'
import type { FabLayout } from '../../core/schema'

const stateColor: Record<EquipmentStateView['state'], number> = {
  idle: 0x6b8494,
  loading: 0x42a5f5,
  processing: 0x3ddc84,
  unloading: 0xffb020,
  held: 0xff3b30,
  maintenance: 0xf06d3a
}

const equipmentHeight: Record<string, number> = {
  lithography: 2.8,
  etcher: 2.8,
  cvd: 2.8,
  pvd: 2.8,
  cmp: 2.8,
  implanter: 2.8,
  cleaner: 2.8,
  furnace: 3.8,
  metrology: 2.8
}

export class EquipmentStatusRenderer {
  private readonly mesh: THREE.InstancedMesh
  private readonly equipment: FabLayout['bays'][number]['equipment']
  private readonly indexById = new Map<string, number>()

  constructor(private readonly scene: THREE.Scene, layout: FabLayout) {
    this.equipment = layout.bays.flatMap((bay) => bay.equipment)
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.18, 0.16, 0.46),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
      this.equipment.length
    )
    const matrix = new THREE.Matrix4()
    this.equipment.forEach((item, index) => {
      this.indexById.set(item.id, index)
      matrix.makeRotationY(item.rotation)
      matrix.setPosition(item.position[0], (equipmentHeight[item.type] ?? 2.8) + 0.14, item.position[2])
      this.mesh.setMatrixAt(index, matrix)
      this.mesh.setColorAt(index, new THREE.Color(stateColor.idle))
    })
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.scene.add(this.mesh)
  }

  setStates(states: EquipmentStateView[]): void {
    for (const state of states) {
      const index = this.indexById.get(state.id)
      if (index !== undefined) this.mesh.setColorAt(index, new THREE.Color(stateColor[state.state]))
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
