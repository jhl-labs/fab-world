import { RmfTraceSchema, type HumanoidTaskKind, type RmfBridgeEvent, type RmfTrace } from '../../src/core/schema'

interface ObservedEvent {
  receivedAt: number
  event: RmfBridgeEvent
}

export class RmfTraceRecorder {
  private readonly observed: ObservedEvent[] = []

  add(event: RmfBridgeEvent, receivedAt: number): void {
    if (!Number.isFinite(receivedAt) || receivedAt < 0) throw new Error('receivedAt must be a non-negative monotonic timestamp')
    this.observed.push({ event, receivedAt })
  }

  build(input: { name: string; recordedAt: string; fleet?: string; map?: string }): RmfTrace {
    const categories = new Map<string, HumanoidTaskKind>()
    for (const { event } of this.observed) {
      if (event.type === 'task_state') categories.set(event.taskId, event.category)
    }
    const grouped = new Map<string, ObservedEvent[]>()
    for (const observation of this.observed) {
      const taskId = observation.event.type === 'task_state'
        ? observation.event.taskId
        : observation.event.type === 'work_permit'
          ? observation.event.taskId
        : observation.event.type === 'action_telemetry'
          ? observation.event.taskId
        : observation.event.type === 'robot_state'
          ? observation.event.taskId
          : undefined
      if (!taskId || !categories.has(taskId)) continue
      const group = grouped.get(taskId)
      if (group) group.push(observation); else grouped.set(taskId, [observation])
    }
    const selected = new Map<HumanoidTaskKind, { taskId: string; events: ObservedEvent[]; score: number }>()
    for (const [taskId, events] of grouped) {
      const category = categories.get(taskId)!
      const completed = events.some(({ event }) => event.type === 'task_state' && event.status === 'completed')
      const score = events.length + (completed ? 100_000 : 0)
      const current = selected.get(category)
      if (!current || score > current.score) selected.set(category, { taskId, events, score })
    }
    const robot = this.observed.find((observation) => observation.event.type === 'robot_state')?.event
    const fleet = input.fleet ?? (robot?.type === 'robot_state' ? robot.fleet : undefined)
    const map = input.map ?? (robot?.type === 'robot_state' ? robot.map : undefined)
    if (!fleet || !map) throw new Error('Trace needs at least one robot_state event or explicit fleet/map values')
    const tasks = [...selected.entries()].map(([category, candidate]) => {
      const ordered = [...candidate.events].sort((left, right) => left.receivedAt - right.receivedAt)
      const startedAt = ordered[0]!.receivedAt
      return {
        category,
        sourceTaskId: candidate.taskId,
        events: ordered.map(({ event, receivedAt }) => ({
          atMs: Math.max(0, Math.round(receivedAt - startedAt)),
          event
        }))
      }
    })
    return RmfTraceSchema.parse({
      version: '1.0',
      name: input.name,
      source: 'recorded',
      recordedAt: input.recordedAt,
      fleet,
      map,
      tasks
    })
  }

  get eventCount(): number {
    return this.observed.length
  }
}
