import { create } from 'zustand'
import type { EmergencyKind, EmergencyPhase } from '../core/schema'
import type { EntityMeta, SimMetrics } from '../core/protocol'
import type { HumanoidTaskKind, HumanoidTaskStatus } from '../core/schema'
import type { CameraMode } from '../render/camera/controller'
import type { LocalConnectionState } from '../integrations/localDemo'
import type { RmfBridgeStatus } from '../core/schema'

export interface LogItem { id: number; message: string; severity: 'info' | 'warning' | 'danger' }
export interface HumanoidTaskView {
  id: string
  kind: HumanoidTaskKind
  status: HumanoidTaskStatus
  robotId?: string
  requestedBy?: 'rmf' | 'showcase' | 'operator'
}
interface FabUiState {
  timeScale: number; cameraMode: CameraMode; entities: EntityMeta[]; selectedId?: string; phase: EmergencyPhase; emergencyKind?: EmergencyKind; metrics?: SimMetrics; logs: LogItem[]; stats?: { fps: number; drawCalls: number; triangles: number }
  rmfState: LocalConnectionState; rmfDetail: string; rmfBridgeStatus?: RmfBridgeStatus; humanoidTasks: HumanoidTaskView[]
  setTimeScale(value: number): void; setCameraMode(mode: CameraMode): void; setEntities(entities: EntityMeta[]): void; select(id?: string): void; setEmergency(kind: EmergencyKind | undefined, phase: EmergencyPhase): void; setMetrics(metrics: SimMetrics): void; addLog(message: string, severity?: LogItem['severity']): void; setStats(stats: { fps: number; drawCalls: number; triangles: number }): void
  setRmfState(rmfState: LocalConnectionState, rmfDetail?: string): void; setRmfBridgeStatus(status?: RmfBridgeStatus): void; upsertHumanoidTask(task: HumanoidTaskView): void; clearHumanoidTasks(): void
}
let logSequence = 1
export const useFabStore = create<FabUiState>((set) => ({
  timeScale: 1, cameraMode: 'orbit', entities: [], phase: 'normal', logs: [], rmfState: 'demo', rmfDetail: '결정적 데모 피드', humanoidTasks: [],
  setTimeScale: (timeScale) => set({ timeScale }), setCameraMode: (cameraMode) => set({ cameraMode }), setEntities: (entities) => set({ entities }), select: (selectedId) => set({ selectedId }), setEmergency: (emergencyKind, phase) => set({ emergencyKind, phase }), setMetrics: (metrics) => set({ metrics }),
  addLog: (message, severity = 'info') => set((state) => ({ logs: [{ id: logSequence++, message, severity }, ...state.logs].slice(0, 8) })), setStats: (stats) => set({ stats }),
  setRmfState: (rmfState, rmfDetail = '') => set({ rmfState, rmfDetail }),
  setRmfBridgeStatus: (rmfBridgeStatus) => set({ rmfBridgeStatus }),
  upsertHumanoidTask: (task) => set((state) => ({ humanoidTasks: [task, ...state.humanoidTasks.filter((item) => item.id !== task.id)].slice(0, 6) })),
  clearHumanoidTasks: () => set({ humanoidTasks: [] })
}))
