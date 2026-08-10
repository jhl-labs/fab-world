import type { SimWorld } from '../world'

export function updateEquipment(world: SimWorld, dt: number): void {
  const activeEmergency = world.emergency.phase !== 'normal' && world.emergency.phase !== 'allClear'
  const hazard = world.emergency.hazard
  let heldEquipment = 0
  for (const equipment of world.equipment) {
    const position = world.layout.equipmentPositions.get(equipment.id)
    const distance = position && hazard ? Math.hypot(position[0] - hazard.sourceX, position[2] - hazard.sourceZ) : Infinity
    const shouldHold = activeEmergency && hazard
      ? hazard.kind === 'gasLeak'
        ? distance <= Math.max(6, hazard.radius * 1.8)
        : hazard.kind === 'fire'
          ? distance <= hazard.maxRadius + 8
          : false
      : false
    if (shouldHold) {
      if (equipment.state !== 'held') {
        equipment.resumeState = equipment.state === 'maintenance' ? 'processing' : equipment.state
        equipment.state = 'held'
        equipment.holdReason = hazard?.kind
      }
      heldEquipment++
      continue
    }
    if (equipment.state === 'held' || equipment.state === 'maintenance') {
      if (activeEmergency) {
        heldEquipment++
        continue
      }
      equipment.state = equipment.resumeState ?? 'processing'
      equipment.resumeState = undefined
      equipment.holdReason = undefined
    }
    const blockNewInput = activeEmergency && hazard && (
      (hazard.kind === 'fire' && equipment.state === 'idle') ||
      (hazard.kind === 'medical' && equipment.state === 'idle' && distance < 12)
    )
    if (blockNewInput) continue
    equipment.progress += dt
    if (equipment.state === 'idle' && equipment.progress > 4) { equipment.state = 'loading'; equipment.progress = 0 }
    else if (equipment.state === 'loading' && equipment.progress > 2) { equipment.state = 'processing'; equipment.progress = 0 }
    else if (equipment.state === 'processing' && equipment.progress > equipment.duration) { equipment.state = 'unloading'; equipment.progress = 0; world.completedProcesses++; world.pendingOutputs++ }
    else if (equipment.state === 'unloading' && equipment.progress > 2) { equipment.state = 'idle'; equipment.progress = 0 }
  }
  if (world.heldEquipmentCount === 0 && heldEquipment > 0) {
    world.events.push({ type: 'hudMessage', message: `위험원 인접 설비 ${heldEquipment}대를 안전 hold로 전환했습니다.`, data: { severity: 'warning' } })
  } else if (world.heldEquipmentCount > 0 && heldEquipment === 0) {
    world.events.push({ type: 'hudMessage', message: '설비 hold를 해제하고 중단 지점부터 공정을 재개합니다.', data: { severity: 'info' } })
  }
  world.heldEquipmentCount = heldEquipment
}
