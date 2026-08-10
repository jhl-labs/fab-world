import { RmfBridgeEventSchema, RmfBridgeStatusSchema, type HumanoidTaskRequest, type RmfBridgeEvent, type RmfBridgeStatus } from '../../core/schema'

export type RmfConnectionState = 'demo' | 'connecting' | 'connected' | 'replay' | 'disconnected' | 'error'

export interface RmfConnectionOptions {
  url?: string
  onEvent(event: RmfBridgeEvent): void
  onState(state: RmfConnectionState, detail?: string): void
  onStatus?(status: RmfBridgeStatus): void
}

export interface RmfTaskConnection {
  connect(): void
  dispatchTask(request: HumanoidTaskRequest): boolean
  cancelTasks(taskIds: string[]): void
  disconnect(): void
}

export function bridgeEndpointLabel(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return 'RMF Bridge endpoint'
  }
}

/**
 * Browser-facing connection to the FabWorld RMF bridge.
 *
 * The bridge deliberately exposes a small, versioned contract instead of
 * coupling the renderer to rmf-web's private `/_internal` endpoint.
 */
export class RmfBridgeClient implements RmfTaskConnection {
  private socket?: WebSocket
  private reconnectTimer?: number
  private manuallyClosed = false
  private bridgeReadiness: 'unknown' | 'ready' | 'blocked' = 'unknown'
  private readonly pendingTasks = new Map<string, HumanoidTaskRequest>()
  private readonly sentTasks = new Set<string>()
  constructor(private readonly options: RmfConnectionOptions) {}

  connect(): void {
    if (!this.options.url) { this.options.onState('demo', '결정적 RMF 데모 피드'); return }
    this.manuallyClosed = false
    this.bridgeReadiness = 'unknown'
    this.options.onState('connecting', bridgeEndpointLabel(this.options.url))
    try {
      const socket = new WebSocket(this.options.url)
      this.socket = socket
      socket.addEventListener('open', () => {
        this.bridgeReadiness = 'unknown'
        this.options.onState('connecting', 'RMF Bridge 연결됨 · readiness 확인 중')
        socket.send(JSON.stringify({
          type: 'subscribe',
          channels: ['robot_states', 'task_states', 'work_permits', 'action_telemetry', 'emergency']
        }))
      })
      socket.addEventListener('message', (message) => {
        try {
          const parsed = JSON.parse(String(message.data)) as unknown
          const status = RmfBridgeStatusSchema.safeParse(parsed)
          if (status.success) {
            this.options.onStatus?.(status.data)
            this.bridgeReadiness = status.data.status === 'ready' ? 'ready' : 'blocked'
            this.options.onState(status.data.status === 'ready' ? 'connected' : 'error', bridgeStatusDetail(status.data))
            if (status.data.status === 'ready') {
              for (const request of this.pendingTasks.values()) {
                if (this.sentTasks.has(request.id)) continue
                this.sendTask(socket, request)
                this.sentTasks.add(request.id)
              }
            } else {
              this.failPendingTasks(status.data.detail)
            }
            return
          }
          const candidate = typeof parsed === 'object' && parsed !== null && 'event' in parsed ? (parsed as { event: unknown }).event : parsed
          if (typeof candidate === 'object' && candidate !== null && 'type' in candidate && candidate.type === 'bridge_error') {
            const detail = 'message' in candidate && typeof candidate.message === 'string' ? candidate.message : 'RMF bridge 요청 오류'
            const taskId = 'task_id' in candidate && typeof candidate.task_id === 'string' ? candidate.task_id : undefined
            const request = taskId ? this.pendingTasks.get(taskId) : undefined
            if (taskId && request) {
              this.pendingTasks.delete(taskId)
              this.sentTasks.delete(taskId)
              this.options.onEvent({
                type: 'task_state',
                taskId,
                category: request.kind,
                status: 'failed',
                ...(request.targetId ? { targetId: request.targetId } : {}),
                timestamp: Date.now()
              })
            }
            this.options.onState('error', detail)
            return
          }
          const event = RmfBridgeEventSchema.safeParse(candidate)
          if (event.success) {
            if (event.data.type === 'task_state') {
              this.pendingTasks.delete(event.data.taskId)
              this.sentTasks.delete(event.data.taskId)
            }
            this.options.onEvent(event.data)
          }
        } catch {
          this.options.onState('error', 'RMF bridge 메시지 형식 오류')
        }
      })
      socket.addEventListener('close', () => {
        this.bridgeReadiness = 'unknown'
        this.sentTasks.clear()
        this.options.onState('disconnected', 'RMF bridge 연결 종료')
        if (!this.manuallyClosed) this.reconnectTimer = window.setTimeout(() => this.connect(), 2_000)
      })
      socket.addEventListener('error', () => this.options.onState('error', 'RMF bridge 연결 실패'))
    } catch {
      this.options.onState('error', 'RMF bridge URL 오류')
    }
  }

  dispatchTask(request: HumanoidTaskRequest): boolean {
    if (this.socket?.readyState === WebSocket.OPEN && this.bridgeReadiness === 'ready') {
      this.pendingTasks.set(request.id, request)
      this.sendTask(this.socket, request)
      this.sentTasks.add(request.id)
      return true
    }
    if (!this.options.url) return false
    if (this.bridgeReadiness === 'blocked') return false
    this.pendingTasks.set(request.id, request)
    return true
  }

  cancelTasks(taskIds: string[]): void {
    for (const taskId of taskIds) {
      this.pendingTasks.delete(taskId)
      this.sentTasks.delete(taskId)
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel_task', task_id: taskId }))
    }
  }

  private sendTask(socket: WebSocket, request: HumanoidTaskRequest): void {
    socket.send(JSON.stringify({
      type: 'dispatch_task',
      request: {
        category: 'perform_action',
        description: {
          category: request.kind,
          target_id: request.targetId,
          ...(request.target ? {
            target_pose: {
              map: request.targetMap ?? 'fab-L1',
              x: request.target[0],
              y: request.target[1],
              ...(request.targetYaw !== undefined ? { yaw: request.targetYaw } : {})
            }
          } : {}),
          fabworld_task_id: request.id
        },
        priority: request.priority
      }
    }))
  }

  disconnect(): void {
    this.manuallyClosed = true
    this.bridgeReadiness = 'unknown'
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.pendingTasks.clear()
    this.sentTasks.clear()
    this.socket?.close(); this.socket = undefined
  }

  private failPendingTasks(detail: string): void {
    for (const request of this.pendingTasks.values()) {
      if (this.sentTasks.has(request.id) && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'cancel_task', task_id: request.id }))
      }
      this.options.onEvent({
        type: 'task_state',
        taskId: request.id,
        category: request.kind,
        status: 'failed',
        ...(request.targetId ? { targetId: request.targetId } : {}),
        timestamp: Date.now()
      })
    }
    this.pendingTasks.clear()
    this.sentTasks.clear()
    if (detail) this.options.onState('error', detail)
  }
}

function bridgeStatusDetail(status: RmfBridgeStatus): string {
  const latency = [
    `poll ${status.pollLatencyMs}ms`,
    ...(status.maxPoseAgeMs !== undefined ? [`pose ${status.maxPoseAgeMs}ms`] : []),
    ...(status.actionStageLatencyMs !== undefined ? [`action ${status.actionStageLatencyMs}ms`] : []),
    ...(status.actionTelemetryLatencyMs !== undefined ? [`telemetry ${status.actionTelemetryLatencyMs}ms`] : [])
  ].join(' · ')
  return `${status.status.toUpperCase()} · ${status.robotsPublished}/${status.robotsSeen} robots · ${latency}${status.status === 'ready' ? '' : ` · ${status.detail}`}`
}

export function configuredRmfBridgeUrl(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get('rmf')
  return fromQuery ?? import.meta.env.VITE_RMF_BRIDGE_URL
}

export function configuredRmfTraceSource(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get('rmfTrace')
  return fromQuery ?? import.meta.env.VITE_RMF_TRACE_URL
}
