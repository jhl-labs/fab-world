import type { HumanoidTaskRequest } from '../core/schema'

// Keep the UI's existing status model stable while this implementation only
// ever emits `demo`.
export type LocalConnectionState = 'demo' | 'connecting' | 'connected' | 'replay' | 'disconnected' | 'error'

export interface LocalTaskConnection {
  connect(): void
  dispatchTask(request: HumanoidTaskRequest): boolean
  cancelTasks(taskIds: string[]): void
  disconnect(): void
}

/**
 * Static-hosting connection: the simulation worker is the sole task authority.
 * There is intentionally no HTTP or WebSocket path in the frontend-only build.
 */
export class LocalDemoConnection implements LocalTaskConnection {
  constructor(private readonly onState: (state: LocalConnectionState, detail?: string) => void) {}

  connect(): void {
    this.onState('demo', '결정적 로컬 시뮬레이션 · 외부 dispatch 없음')
  }

  dispatchTask(): boolean {
    return false
  }

  cancelTasks(): void {}

  disconnect(): void {}
}
