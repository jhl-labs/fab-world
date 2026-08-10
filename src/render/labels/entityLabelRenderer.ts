import * as THREE from 'three'
import type { EntityMeta } from '../../core/protocol'
import type { PoseReader } from '../interpolate'

interface LabelEntry {
  entity: EntityMeta
  element: HTMLDivElement
  detail: HTMLSpanElement
  baseDetail: string
}

const yOffset: Record<EntityMeta['kind'], number> = {
  person: 1.18,
  humanoid: 2.15,
  oht: 1.05,
  agv: 0.92,
  igv: 1.08,
  arm: 2.08
}

function callsign(entity: EntityMeta): string {
  const suffix = entity.id.split('-').at(-1) ?? entity.id
  if (entity.kind === 'humanoid') return entity.name.split(' ')[0] ?? entity.id
  if (entity.kind === 'person') {
    const prefix = entity.role === 'responder' ? 'EHS' : entity.role === 'engineer' ? 'ENG' : 'OP'
    return `${prefix}-${suffix}`
  }
  return `${entity.kind.toUpperCase()}-${suffix}`
}

function roleLabel(entity: EntityMeta): string {
  if (entity.kind === 'humanoid') return entity.id.endsWith('001') ? '설비 점검' : '안전 대응'
  if (entity.kind === 'person') return entity.role === 'responder' ? '방재 대응' : entity.role === 'engineer' ? '엔지니어' : '오퍼레이터'
  if (entity.kind === 'oht') return '천장 반송'
  if (entity.kind === 'agv') return '자율 반송'
  if (entity.kind === 'igv') return '현장 지원'
  return '로봇암'
}

/**
 * Screen-projected HTML tags identify every rendered actor without adding a
 * WebGL draw call per label. They remain compact at wide shots and become
 * fully readable as the camera approaches the actor.
 */
export class EntityLabelRenderer {
  private readonly layer = document.createElement('div')
  private readonly entries = new Map<string, LabelEntry>()
  private readonly world = new THREE.Vector3()

  constructor(private readonly container: HTMLElement, entities: readonly EntityMeta[]) {
    this.layer.className = 'entity-label-layer'
    for (const entity of entities) {
      const element = document.createElement('div')
      element.className = `entity-label entity-label-${entity.kind}${entity.role ? ` entity-label-${entity.role}` : ''}`
      element.dataset.entityId = entity.id
      const primary = document.createElement('b')
      primary.textContent = callsign(entity)
      const detail = document.createElement('span')
      const baseDetail = roleLabel(entity)
      detail.textContent = baseDetail
      element.append(primary, detail)
      this.layer.append(element)
      this.entries.set(entity.id, { entity, element, detail, baseDetail })
    }
    container.append(this.layer)
  }

  setBadge(entityId: string, badge?: string): void {
    const entry = this.entries.get(entityId)
    if (!entry) return
    entry.detail.textContent = badge ?? entry.baseDetail
    entry.element.classList.toggle('entity-label-active', badge !== undefined)
  }

  update(reader: PoseReader, camera: THREE.Camera): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width <= 0 || height <= 0) return
    for (const { entity, element } of this.entries.values()) {
      const pose = reader.pose(entity.index)
      this.world.set(pose.x, pose.y + yOffset[entity.kind], pose.z).project(camera)
      const visible = this.world.z >= -1 && this.world.z <= 1 && Math.abs(this.world.x) <= 1.08 && Math.abs(this.world.y) <= 1.08
      if (!visible) { element.hidden = true; continue }
      const ndcX = this.world.x
      const ndcY = this.world.y
      const distance = camera.position.distanceTo(this.world.unproject(camera))
      // A label must identify the subject of a shot, not turn a wide emergency
      // overview into a wall of names. Keep the response team readable from
      // afar; reveal routine people and logistics only when the camera is near.
      const isResponseSubject = entity.kind === 'humanoid' || (entity.kind === 'person' && entity.role === 'responder')
      // At an assembly-point overview, dozens of worker tags overlap into a
      // false visual alarm. People still identify themselves at operational
      // distance, while the response assets remain legible across the floor.
      const labelDistance = isResponseSubject ? 210 : entity.kind === 'person' ? 18 : 36
      if (distance > labelDistance) { element.hidden = true; continue }
      const scale = THREE.MathUtils.clamp(1.12 - distance / 180, 0.58, 1)
      const opacity = entity.kind === 'person' && entity.role !== 'responder'
        ? THREE.MathUtils.clamp(1.15 - distance / 150, 0.36, 0.82)
        : THREE.MathUtils.clamp(1.22 - distance / 240, 0.58, 1)
      element.hidden = false
      element.style.opacity = opacity.toFixed(2)
      element.style.transform = `translate(-50%, -100%) translate(${((ndcX + 1) * 0.5 * width).toFixed(1)}px, ${((-ndcY + 1) * 0.5 * height).toFixed(1)}px) scale(${scale.toFixed(2)})`
    }
  }

  dispose(): void { this.layer.remove(); this.entries.clear() }
}
