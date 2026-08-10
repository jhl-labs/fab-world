import {
  RmfTraceSchema,
  type HumanoidTaskRequest,
  type RmfBridgeEvent,
  type RmfTaskTrace,
  type RmfTrace
} from '../../core/schema'
import type { RmfConnectionOptions, RmfTaskConnection } from './client'

interface RmfTracePlayerOptions extends Omit<RmfConnectionOptions, 'url'> {
  loadTrace(): Promise<unknown> | unknown
}

export class RmfTracePlayer implements RmfTaskConnection {
  private trace?: RmfTrace
  private loading?: Promise<void>
  private closed = false
  private readonly pending = new Map<string, HumanoidTaskRequest>()
  private readonly timers = new Map<string, Set<ReturnType<typeof setTimeout>>>()
  private readonly idleHeartbeats = new Map<string, ReturnType<typeof setInterval>>()
  private readonly latestRobotStates = new Map<string, Extract<RmfBridgeEvent, { type: 'robot_state' }>>()

  constructor(private readonly options: RmfTracePlayerOptions) {}

  connect(): void {
    if (this.loading || this.trace) return
    this.closed = false
    this.options.onState('connecting', 'RMF trace 검증 중')
    this.loading = Promise.resolve(this.options.loadTrace())
      .then((input) => {
        if (this.closed) return
        this.trace = RmfTraceSchema.parse(input)
        this.options.onState('replay', traceDetail(this.trace, '준비'))
        for (const request of this.pending.values()) this.schedule(request)
      })
      .catch((error: unknown) => {
        if (this.closed) return
        const detail = error instanceof Error ? error.message : '알 수 없는 trace 오류'
        this.options.onState('error', `RMF trace 로드 실패 · ${detail}`)
      })
  }

  dispatchTask(request: HumanoidTaskRequest): boolean {
    if (this.closed) return false
    this.cancelTasks([request.id])
    this.pending.set(request.id, request)
    if (this.trace) this.schedule(request)
    return true
  }

  cancelTasks(taskIds: string[]): void {
    for (const taskId of taskIds) {
      this.pending.delete(taskId)
      const timers = this.timers.get(taskId)
      if (timers) for (const timer of timers) clearTimeout(timer)
      this.timers.delete(taskId)
    }
  }

  disconnect(): void {
    this.closed = true
    this.cancelTasks([...this.pending.keys(), ...this.timers.keys()])
    for (const heartbeat of this.idleHeartbeats.values()) clearInterval(heartbeat)
    this.idleHeartbeats.clear()
    this.latestRobotStates.clear()
    this.trace = undefined
    this.loading = undefined
  }

  async ready(): Promise<void> {
    await this.loading
  }

  private schedule(request: HumanoidTaskRequest): void {
    const trace = this.trace
    if (!trace) return
    this.pending.delete(request.id)
    const template = trace.tasks.find((candidate) => candidate.category === request.kind)
    if (!template) {
      this.options.onEvent({
        type: 'task_state',
        taskId: request.id,
        category: request.kind,
        status: 'failed',
        targetId: request.targetId,
        timestamp: Date.now()
      })
      this.options.onState('error', `${request.kind} trace가 없어 ${request.id}을 재생하지 못했습니다.`)
      return
    }
    const epoch = Date.now()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    this.timers.set(request.id, timers)
    this.options.onState('replay', traceDetail(trace, `${request.kind} 재생`))
    template.events.forEach((entry, index) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (this.closed || this.timers.get(request.id) !== timers) return
        const event = remapEvent(entry.event, template, request, epoch + entry.atMs)
        if (event.type === 'robot_state') {
          this.stopIdleHeartbeat(event.robot)
          this.latestRobotStates.set(event.robot, event)
        }
        this.options.onEvent(event)
        if (index === template.events.length - 1) {
          this.timers.delete(request.id)
          const latestRobot = [...template.events]
            .reverse()
            .map((candidate) => candidate.event)
            .find((candidate): candidate is Extract<RmfBridgeEvent, { type: 'robot_state' }> => candidate.type === 'robot_state')
          if (latestRobot) this.startIdleHeartbeat(latestRobot.robot)
          this.options.onState('replay', traceDetail(trace, '준비'))
        }
      }, entry.atMs)
      timers.add(timer)
    })
  }

  private startIdleHeartbeat(robot: string): void {
    this.stopIdleHeartbeat(robot)
    const latest = this.latestRobotStates.get(robot)
    if (!latest) return
    const heartbeat = setInterval(() => {
      if (this.closed) return
      this.options.onEvent({
        type: 'robot_state',
        fleet: latest.fleet,
        robot: latest.robot,
        map: latest.map,
        x: latest.x,
        y: latest.y,
        yaw: latest.yaw,
        battery: latest.battery,
        mode: 'idle',
        timestamp: Date.now()
      })
    }, 1_000)
    this.idleHeartbeats.set(robot, heartbeat)
  }

  private stopIdleHeartbeat(robot: string): void {
    const heartbeat = this.idleHeartbeats.get(robot)
    if (heartbeat !== undefined) clearInterval(heartbeat)
    this.idleHeartbeats.delete(robot)
  }
}

function remapEvent(
  event: RmfBridgeEvent,
  template: RmfTaskTrace,
  request: HumanoidTaskRequest,
  timestamp: number
): RmfBridgeEvent {
  if (event.type === 'task_state') {
    return {
      ...event,
      taskId: request.id,
      category: request.kind,
      targetId: request.targetId ?? event.targetId,
      timestamp
    }
  }
  if (event.type === 'work_permit') {
    return {
      ...event,
      taskId: request.id,
      timestamp
    }
  }
  if (event.type === 'action_telemetry') {
    return {
      ...event,
      taskId: request.id,
      timestamp
    }
  }
  if (event.type === 'robot_state') {
    return {
      ...event,
      ...(event.taskId === template.sourceTaskId ? { taskId: request.id } : {}),
      timestamp
    }
  }
  return { ...event, timestamp }
}

function traceDetail(trace: RmfTrace, state: string): string {
  const source = trace.source === 'recorded' ? 'RECORDED' : 'REFERENCE'
  return `${source} TRACE · ${trace.name} · ${state}`
}
