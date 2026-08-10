import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { RmfBridgeEvent, RmfBridgeStatus } from '../../src/core/schema'
import {
  ActionStageIngestSchema,
  ActionTelemetryIngestSchema,
  BrowserBridgeCommandSchema,
  EmergencyIngestSchema,
  WorkPermitIngestSchema,
  type BrowserBridgeCommand
} from './contracts'
import { loadBridgeConfig, type BridgeConfig } from './config'
import { RmfWebClient, type RmfApi } from './rmfWebClient'
import {
  buildRmfCancelRequest,
  buildRmfDispatchRequest,
  isTerminalRmfTask,
  RmfEventNormalizer,
  TargetMapResolutionError,
  TargetWaypointResolutionError,
  type TrackedTask
} from './transform'

type Channel = 'robot_states' | 'task_states' | 'work_permits' | 'action_telemetry' | 'emergency'
type WorkPermitEvent = Extract<RmfBridgeEvent, { type: 'work_permit' }>
type ActionTelemetryEvent = Extract<RmfBridgeEvent, { type: 'action_telemetry' }>
type EmergencyEvent = Extract<RmfBridgeEvent, { type: 'emergency' }>
type TaskAuthorityEvent = Extract<RmfBridgeEvent, { type: 'task_state' }> | WorkPermitEvent | ActionTelemetryEvent
type TaskStateEvent = Extract<RmfBridgeEvent, { type: 'task_state' }>

const MAX_TASK_AUTHORITY_EVENTS = 64
const ACTION_TELEMETRY_FRESHNESS_MS = 1_500
const ACTION_TELEMETRY_PHASE_ORDER: Record<ActionTelemetryEvent['phase'], number> = {
  approach: 0,
  contact: 1,
  turning: 2,
  monitoring: 3,
  verified: 4
}

interface ClientState {
  channels: Set<Channel>
  messageWindowStartedAt: number
  messageCount: number
}

interface TaskRecord extends TrackedTask {
  lastEvent?: TaskStateEvent
  lastActionTelemetry?: ActionTelemetryEvent
  lastActionTelemetryReceivedAt?: number
  snapshotEvents: TaskAuthorityEvent[]
  terminal: boolean
  ingestAuthority: boolean
}

function workPermitEffective(record: TaskRecord, permit: WorkPermitEvent | undefined): boolean {
  return permit?.authorized === true &&
    !record.terminal &&
    record.lastEvent?.type === 'task_state' &&
    ['observing', 'interacting'].includes(record.lastEvent.status)
}

export interface RunningBridge {
  url: string
  port: number
  close(): Promise<void>
}

export async function startBridge(config: BridgeConfig, api: RmfApi = new RmfWebClient(config.rmfWeb)): Promise<RunningBridge> {
  const normalizer = new RmfEventNormalizer(config)
  const tasksByFabId = new Map<string, TaskRecord>()
  const fabIdsByRmfId = new Map<string, string>()
  const workPermitsByFabId = new Map<string, WorkPermitEvent>()
  const clients = new Map<WebSocket, ClientState>()
  let lastRmfSuccessAt = 0
  let lastRmfError = 'RMF-Web has not responded yet'
  let correlationFault: string | undefined
  let lastFireAlarm: boolean | undefined
  let currentEmergencyEvent: EmergencyEvent | undefined
  let polling = false
  let diagnostics: RmfBridgeStatus = {
    type: 'bridge_status',
    status: 'offline',
    fleet: config.rmfWeb.fleet,
    robotsSeen: 0,
    robotsPublished: 0,
    robotsWithoutLocation: 0,
    unknownMaps: [],
    pollLatencyMs: 0,
    detail: 'RMF-Web 응답 대기 중',
    timestamp: Date.now()
  }
  let lastStatusSignature = ''
  let lastStatusBroadcastAt = 0

  const httpServer = createServer((request, response) => {
    void handleHttp(request, response).catch((error: unknown) => {
      console.error(error)
      if (!response.headersSent) json(response, 500, { error: 'internal_error' })
      else response.end()
    })
  })
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

  const send = (socket: WebSocket, value: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
  }
  const rememberTaskAuthority = (record: TaskRecord, event: TaskAuthorityEvent): void => {
    const previous = record.snapshotEvents.at(-1)
    if (previous && authorityEventSignature(previous) === authorityEventSignature(event)) {
      // A poll may repeat an unchanged authority state with a new transport
      // timestamp. Keep the newest evidence without turning it into a new
      // lifecycle transition on reconnect.
      record.snapshotEvents[record.snapshotEvents.length - 1] = event
      return
    }
    record.snapshotEvents.push(event)
    if (record.snapshotEvents.length > MAX_TASK_AUTHORITY_EVENTS) {
      record.snapshotEvents = compactTaskAuthorityHistory(record.snapshotEvents)
    }
  }
  const broadcast = (channel: Channel, event: RmfBridgeEvent): void => {
    for (const [socket, state] of clients) if (state.channels.has(channel)) send(socket, { event })
  }
  const sendError = (socket: WebSocket, code: string, message: string, taskId?: string): void => {
    send(socket, { type: 'bridge_error', code, message, ...(taskId ? { task_id: taskId } : {}) })
  }
  const publishStatus = (force = false): void => {
    const signature = JSON.stringify({
      ...diagnostics,
      timestamp: 0,
      pollLatencyMs: Math.round(diagnostics.pollLatencyMs / 25) * 25,
      ...(diagnostics.maxPoseAgeMs !== undefined
        ? { maxPoseAgeMs: Math.round(diagnostics.maxPoseAgeMs / 100) * 100 }
        : {})
    })
    const now = Date.now()
    if (!force && signature === lastStatusSignature && now - lastStatusBroadcastAt < 2_000) return
    lastStatusSignature = signature
    lastStatusBroadcastAt = now
    for (const socket of clients.keys()) send(socket, diagnostics)
  }
  const sendAuthoritySnapshot = (socket: WebSocket, channels: Set<Channel>): void => {
    if (channels.has('emergency') && currentEmergencyEvent) {
      send(socket, { event: { ...currentEmergencyEvent, snapshot: true } })
    }
    if (channels.has('task_states') || channels.has('work_permits') || channels.has('action_telemetry')) {
      for (const record of tasksByFabId.values()) {
        for (const event of record.snapshotEvents) {
          if (
            (event.type === 'task_state' && channels.has('task_states')) ||
            (event.type === 'work_permit' && channels.has('work_permits')) ||
            (event.type === 'action_telemetry' && channels.has('action_telemetry'))
          ) send(socket, { event: { ...event, snapshot: true } })
        }
      }
    }
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://bridge.local').pathname
    if (path === '/healthz') return json(response, 200, {
      status: 'ok',
      clients: clients.size,
      trackedTasks: tasksByFabId.size,
      authorizedWorkPermits: [...workPermitsByFabId.entries()].filter(([taskId, permit]) =>
        tasksByFabId.has(taskId) && workPermitEffective(tasksByFabId.get(taskId)!, permit)
      ).length,
      bridgeStatus: diagnostics.status,
      uptimeSeconds: Math.round(process.uptime())
    })
    if (path === '/readyz') {
      const freshnessMs = Math.max(config.rmfWeb.pollMs * 4, config.rmfWeb.timeoutMs * 2)
      const ready = bridgeReady(freshnessMs)
      return json(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        lastRmfSuccessAt: lastRmfSuccessAt || null,
        diagnostics,
        ...(ready ? {} : { error: lastRmfError || diagnostics.detail })
      })
    }
    if (request.method === 'GET' && path.startsWith('/action-permits/')) {
      if (!config.ingestToken) return json(response, 404, { error: 'ingest_disabled' })
      if (!authorizedBearer(request, config.ingestToken)) return json(response, 401, { error: 'unauthorized' })
      let fabworldId: string
      try {
        fabworldId = decodeURIComponent(path.slice('/action-permits/'.length))
      } catch {
        return json(response, 400, { error: 'invalid_task_id' })
      }
      if (!fabworldId || fabworldId.includes('/')) return json(response, 400, { error: 'invalid_task_id' })
      const record = tasksByFabId.get(fabworldId)
      if (!record) return json(response, 404, { error: 'unknown_task' })
      const permit = workPermitsByFabId.get(fabworldId)
      const authorized = workPermitEffective(record, permit)
      const state = record.terminal || (permit?.authorized === true && !authorized)
        ? 'expired'
        : permit
          ? permit.authorized ? 'authorized' : 'revoked'
          : 'pending'
      return json(response, 200, {
        taskId: fabworldId,
        rmfTaskId: record.rmfId,
        category: record.category,
        state,
        authorized,
        ...(permit ? {
          authorizedBy: permit.authorizedBy,
          ...(permit.clearance !== undefined ? { clearance: permit.clearance } : {}),
          ...(permit.personId ? { personId: permit.personId } : {}),
          ...(permit.reason ? { reason: permit.reason } : {}),
          timestamp: permit.timestamp
        } : {})
      })
    }
    if (
      request.method === 'POST' &&
      (
        path === '/ingest/action-stage' ||
        path === '/ingest/action-telemetry' ||
        path === '/ingest/work-permit' ||
        path === '/ingest/emergency'
      )
    ) {
      if (!config.ingestToken) return json(response, 404, { error: 'ingest_disabled' })
      if (!authorizedBearer(request, config.ingestToken)) return json(response, 401, { error: 'unauthorized' })
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        return json(response, 415, { error: 'json_content_type_required' })
      }
      let body: unknown
      try {
        body = await readJsonBody(request, 16 * 1024)
      } catch (error) {
        return json(response, error instanceof PayloadTooLargeError ? 413 : 400, {
          error: error instanceof PayloadTooLargeError ? 'payload_too_large' : 'invalid_json'
        })
      }
      if (path === '/ingest/action-telemetry') {
        const parsed = ActionTelemetryIngestSchema.safeParse(body)
        if (!parsed.success) return json(response, 400, { error: 'invalid_action_telemetry' })
        const mappedFabworldId = parsed.data.rmf_task_id ? fabIdsByRmfId.get(parsed.data.rmf_task_id) : undefined
        if (parsed.data.fabworld_task_id && parsed.data.rmf_task_id && mappedFabworldId !== parsed.data.fabworld_task_id) {
          return json(response, 409, { error: 'task_id_mismatch' })
        }
        const fabworldId = parsed.data.fabworld_task_id ?? mappedFabworldId
        const record = fabworldId ? tasksByFabId.get(fabworldId) : undefined
        if (!record) return json(response, 404, { error: 'unknown_task' })
        if (record.terminal) return json(response, 409, { error: 'task_terminal' })
        if (record.category !== 'gas_isolation') {
          return json(response, 409, { error: 'action_telemetry_category_mismatch' })
        }
        const lastTaskEvent = record.lastEvent?.type === 'task_state' ? record.lastEvent : undefined
        if (lastTaskEvent?.status !== 'interacting') {
          return json(response, 409, { error: 'action_telemetry_stage_invalid', requiredStage: 'interacting' })
        }
        if (
          parsed.data.robot &&
          lastTaskEvent.assignedRobot &&
          parsed.data.robot !== lastTaskEvent.assignedRobot
        ) {
          return json(response, 409, { error: 'action_telemetry_robot_mismatch' })
        }
        const permit = workPermitsByFabId.get(record.fabworldId)
        if (!workPermitEffective(record, permit)) return json(response, 409, { error: 'work_permit_required' })
        const previous = record.lastActionTelemetry
        if (previous && parsed.data.timestamp <= previous.timestamp) {
          return json(response, 409, { error: 'stale_action_telemetry' })
        }
        if (
          previous &&
          (
            ACTION_TELEMETRY_PHASE_ORDER[parsed.data.phase] < ACTION_TELEMETRY_PHASE_ORDER[previous.phase] ||
            parsed.data.progress < previous.progress ||
            parsed.data.valve_position < previous.valvePosition
          )
        ) {
          return json(response, 409, { error: 'non_monotonic_action_telemetry' })
        }
        const event: ActionTelemetryEvent = {
          type: 'action_telemetry',
          taskId: record.fabworldId,
          category: 'gas_isolation',
          ...(parsed.data.robot ? { robot: parsed.data.robot } : {}),
          phase: parsed.data.phase,
          progress: parsed.data.progress,
          leftHandContact: parsed.data.left_hand_contact,
          rightHandContact: parsed.data.right_hand_contact,
          valvePosition: parsed.data.valve_position,
          ...(parsed.data.gas_ppm !== undefined ? { gasPpm: parsed.data.gas_ppm } : {}),
          sensorStable: parsed.data.sensor_stable,
          ...(parsed.data.hand_pose ? {
            handPose: {
              frame: parsed.data.hand_pose.frame_id,
              leftPositionM: parsed.data.hand_pose.left_position_m,
              rightPositionM: parsed.data.hand_pose.right_position_m
            }
          } : {}),
          timestamp: parsed.data.timestamp
        }
        record.lastActionTelemetry = event
        record.lastActionTelemetryReceivedAt = Date.now()
        rememberTaskAuthority(record, event)
        diagnostics = {
          ...diagnostics,
          actionTelemetryLatencyMs: Math.max(0, Date.now() - parsed.data.timestamp),
          timestamp: Date.now()
        }
        publishStatus()
        broadcast('action_telemetry', event)
        return json(response, 202, {
          accepted: true,
          taskId: record.fabworldId,
          phase: event.phase
        })
      }
      if (path === '/ingest/action-stage') {
        const parsed = ActionStageIngestSchema.safeParse(body)
        if (!parsed.success) return json(response, 400, { error: 'invalid_action_stage' })
        const mappedFabworldId = parsed.data.rmf_task_id ? fabIdsByRmfId.get(parsed.data.rmf_task_id) : undefined
        if (parsed.data.fabworld_task_id && parsed.data.rmf_task_id && mappedFabworldId !== parsed.data.fabworld_task_id) {
          return json(response, 409, { error: 'task_id_mismatch' })
        }
        const fabworldId = parsed.data.fabworld_task_id ?? mappedFabworldId
        const record = fabworldId ? tasksByFabId.get(fabworldId) : undefined
        if (!record) return json(response, 404, { error: 'unknown_task' })
        if (record.terminal) return json(response, 409, { error: 'task_terminal' })
        if (
          (parsed.data.interaction_kind === 'inspection_anomaly_reported' && record.category !== 'inspection_round') ||
          (parsed.data.interaction_kind === 'medical_handoff' && record.category !== 'medical_support') ||
          (parsed.data.interaction_kind === 'gas_isolation_verified' && record.category !== 'gas_isolation')
        ) return json(response, 409, { error: 'interaction_category_mismatch' })
        if (record.category === 'gas_isolation' && parsed.data.stage === 'interacting') {
          const permit = workPermitsByFabId.get(record.fabworldId)
          if (!workPermitEffective(record, permit)) return json(response, 409, { error: 'work_permit_required' })
        }
        if (
          parsed.data.interaction_kind === 'gas_isolation_verified' &&
          (
            record.lastActionTelemetry?.phase !== 'verified' ||
            record.lastActionTelemetryReceivedAt === undefined ||
            Date.now() - record.lastActionTelemetryReceivedAt > ACTION_TELEMETRY_FRESHNESS_MS
          )
        ) return json(response, 409, { error: 'verified_action_telemetry_required' })
        if (
          parsed.data.interaction_kind === 'gas_isolation_verified' &&
          parsed.data.timestamp !== undefined &&
          record.lastActionTelemetry &&
          parsed.data.timestamp < record.lastActionTelemetry.timestamp
        ) return json(response, 409, { error: 'action_stage_precedes_telemetry' })
        const event: RmfBridgeEvent = {
          type: 'task_state',
          taskId: record.fabworldId,
          category: record.category,
          status: parsed.data.stage,
          ...(parsed.data.robot ? { assignedRobot: parsed.data.robot } : {}),
          ...(record.targetId ? { targetId: record.targetId } : {}),
          ...(parsed.data.interaction_kind ? { interactionKind: parsed.data.interaction_kind } : {}),
          timestamp: parsed.data.timestamp ?? Date.now()
        }
        record.lastEvent = event
        record.terminal = ['completed', 'failed', 'cancelled'].includes(parsed.data.stage)
        record.ingestAuthority = !record.terminal
        rememberTaskAuthority(record, event)
        if (parsed.data.timestamp !== undefined) {
          diagnostics = {
            ...diagnostics,
            actionStageLatencyMs: Math.max(0, Date.now() - parsed.data.timestamp),
            timestamp: Date.now()
          }
          publishStatus()
        }
        broadcast('task_states', event)
        return json(response, 202, { accepted: true })
      }
      if (path === '/ingest/work-permit') {
        const parsed = WorkPermitIngestSchema.safeParse(body)
        if (!parsed.success) return json(response, 400, { error: 'invalid_work_permit' })
        const mappedFabworldId = parsed.data.rmf_task_id ? fabIdsByRmfId.get(parsed.data.rmf_task_id) : undefined
        if (parsed.data.fabworld_task_id && parsed.data.rmf_task_id && mappedFabworldId !== parsed.data.fabworld_task_id) {
          return json(response, 409, { error: 'task_id_mismatch' })
        }
        const fabworldId = parsed.data.fabworld_task_id ?? mappedFabworldId
        const record = fabworldId ? tasksByFabId.get(fabworldId) : undefined
        if (!record) return json(response, 404, { error: 'unknown_task' })
        if (record.category !== 'gas_isolation') return json(response, 409, { error: 'work_permit_category_mismatch' })
        if (record.terminal) return json(response, 409, { error: 'task_terminal' })
        const lastTaskStatus = record.lastEvent?.type === 'task_state' ? record.lastEvent.status : undefined
        if (parsed.data.authorized && lastTaskStatus !== 'observing') {
          return json(response, 409, { error: 'work_permit_stage_invalid', requiredStage: 'observing' })
        }
        const timestamp = parsed.data.timestamp ?? Date.now()
        const previous = workPermitsByFabId.get(record.fabworldId)
        if (previous && timestamp <= previous.timestamp) return json(response, 409, { error: 'stale_work_permit' })
        const event: WorkPermitEvent = {
          type: 'work_permit',
          taskId: record.fabworldId,
          authorized: parsed.data.authorized,
          authorizedBy: parsed.data.authorized_by,
          ...(parsed.data.clearance_m !== undefined ? { clearance: parsed.data.clearance_m } : {}),
          ...(parsed.data.person_id ? { personId: parsed.data.person_id } : {}),
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
          timestamp
        }
        workPermitsByFabId.set(record.fabworldId, event)
        record.lastActionTelemetry = undefined
        record.lastActionTelemetryReceivedAt = undefined
        rememberTaskAuthority(record, event)
        broadcast('work_permits', event)
        return json(response, 202, {
          accepted: true,
          taskId: record.fabworldId,
          state: event.authorized ? 'authorized' : 'revoked'
        })
      }
      const parsed = EmergencyIngestSchema.safeParse(body)
      if (!parsed.success) return json(response, 400, { error: 'invalid_emergency' })
      const event: EmergencyEvent = {
        type: 'emergency',
        active: parsed.data.active,
        ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
        timestamp: parsed.data.timestamp ?? Date.now()
      }
      currentEmergencyEvent = event
      broadcast('emergency', event)
      return json(response, 202, { accepted: true })
    }
    return json(response, 404, { error: 'not_found' })
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://bridge.local')
    if (url.pathname !== config.listen.path) return rejectUpgrade(socket, 404, 'Not Found')
    if (!authorized(request, url, config)) return rejectUpgrade(socket, 401, 'Unauthorized')
    const origin = request.headers.origin
    if (config.allowedOrigins.length > 0 && (!origin || !config.allowedOrigins.includes(origin))) return rejectUpgrade(socket, 403, 'Forbidden')
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => webSocketServer.emit('connection', webSocket, request))
  })

  const handleCommand = async (socket: WebSocket, command: BrowserBridgeCommand): Promise<void> => {
    if (command.type === 'subscribe') {
      const state = clients.get(socket)
      if (state) state.channels = new Set(command.channels)
      send(socket, diagnostics)
      // A browser reload or WebSocket reconnect starts with an empty Worker.
      // Replay the current authoritative task/permit state immediately instead
      // of waiting for a future RMF transition that may never occur.
      sendAuthoritySnapshot(socket, new Set(command.channels))
      return
    }
    if (command.type === 'dispatch_task') {
      const fabworldId = command.request.description.fabworld_task_id
      const existing = tasksByFabId.get(fabworldId)
      if (existing) {
        if (existing.lastEvent) send(socket, { event: existing.lastEvent })
        return
      }
      const freshnessMs = Math.max(config.rmfWeb.pollMs * 4, config.rmfWeb.timeoutMs * 2)
      if (!bridgeReady(freshnessMs)) {
        sendError(
          socket,
          'bridge_not_ready',
          `Open-RMF readiness가 충족되지 않아 새 태스크를 배정하지 않습니다. ${lastRmfError || diagnostics.detail}`,
          fabworldId
        )
        return
      }
      let rmfRequest: Record<string, unknown>
      try {
        rmfRequest = buildRmfDispatchRequest(command, config.rmfWeb.fleet, config.maps, config.navigationWaypoints)
      } catch (error) {
        if (error instanceof TargetMapResolutionError) {
          sendError(
            socket,
            error.matches === 0 ? 'target_map_unmapped' : 'target_map_ambiguous',
            error.message,
            fabworldId
          )
          return
        }
        if (error instanceof TargetWaypointResolutionError) {
          sendError(
            socket,
            error.reason === 'ambiguous' ? 'target_waypoint_ambiguous' : 'target_waypoint_unmapped',
            error.message,
            fabworldId
          )
          return
        }
        throw error
      }
      const response = await api.dispatchTask(rmfRequest)
      if (response.success !== true) {
        sendError(socket, 'rmf_dispatch_rejected', 'Open-RMF가 태스크를 거절했습니다.', fabworldId)
        return
      }
      const rmfId = response.state.booking.id
      if (!bridgeReady(freshnessMs)) {
        await api.cancelTask(buildRmfCancelRequest(rmfId)).catch(() => undefined)
        sendError(
          socket,
          'bridge_not_ready',
          `태스크 배정 중 Open-RMF readiness가 해제되어 booking을 취소했습니다. ${lastRmfError || diagnostics.detail}`,
          fabworldId
        )
        return
      }
      const correlatedFabworldId = fabIdsByRmfId.get(rmfId)
      if (correlatedFabworldId && correlatedFabworldId !== fabworldId) {
        correlationFault = `RMF booking ${rmfId} is already correlated with ${correlatedFabworldId}`
        lastRmfError = correlationFault
        diagnostics = {
          ...diagnostics,
          status: 'degraded',
          detail: correlationFault,
          timestamp: Date.now()
        }
        publishStatus(true)
        sendError(
          socket,
          'rmf_booking_collision',
          'Open-RMF가 이미 사용 중인 booking id를 반환해 새 태스크를 안전하게 추적할 수 없습니다.',
          fabworldId
        )
        return
      }
      const record: TaskRecord = {
        fabworldId,
        rmfId,
        category: command.request.description.category,
        ...(command.request.description.target_id ? { targetId: command.request.description.target_id } : {}),
        snapshotEvents: [],
        terminal: false,
        ingestAuthority: false
      }
      tasksByFabId.set(fabworldId, record)
      fabIdsByRmfId.set(rmfId, fabworldId)
      const event = normalizer.task(response.state, record)
      record.lastEvent = event
      record.terminal = isTerminalRmfTask(response.state)
      rememberTaskAuthority(record, event)
      broadcast('task_states', event)
      pruneTaskRecords(tasksByFabId, fabIdsByRmfId, workPermitsByFabId)
      return
    }
    const record = tasksByFabId.get(command.task_id)
    if (!record) {
      sendError(socket, 'unknown_task', 'Bridge가 알지 못하는 FabWorld task id입니다.', command.task_id)
      return
    }
    await api.cancelTask(buildRmfCancelRequest(record.rmfId))
  }

  const bridgeReady = (freshnessMs: number): boolean =>
    diagnostics.status === 'ready' &&
    lastRmfSuccessAt > 0 &&
    Date.now() - lastRmfSuccessAt <= freshnessMs

  webSocketServer.on('connection', (socket) => {
    clients.set(socket, { channels: new Set(), messageWindowStartedAt: Date.now(), messageCount: 0 })
    socket.on('message', (data: RawData) => {
      const state = clients.get(socket)
      if (!state) return
      const now = Date.now()
      if (now - state.messageWindowStartedAt >= 1_000) {
        state.messageWindowStartedAt = now
        state.messageCount = 0
      }
      state.messageCount++
      if (state.messageCount > 30) {
        socket.close(1008, 'Rate limit exceeded')
        return
      }
      try {
        const parsed = BrowserBridgeCommandSchema.safeParse(JSON.parse(data.toString()) as unknown)
        if (!parsed.success) {
          sendError(socket, 'invalid_command', 'Bridge 명령 스키마가 올바르지 않습니다.')
          return
        }
        void handleCommand(socket, parsed.data).catch((error: unknown) => {
          lastRmfError = error instanceof Error ? error.message : String(error)
          sendError(socket, 'rmf_request_failed', 'RMF-Web 요청에 실패했습니다.')
        })
      } catch {
        sendError(socket, 'invalid_json', 'JSON 메시지가 아닙니다.')
      }
    })
    socket.on('close', () => clients.delete(socket))
  })

  const poll = async (): Promise<void> => {
    if (polling) return
    polling = true
    const pollStartedAt = Date.now()
    try {
      const fleet = await api.getFleetState()
      const fleetName = fleet.name ?? config.rmfWeb.fleet
      let robotsSeen = 0
      let robotsPublished = 0
      let robotsWithoutLocation = 0
      let maxPoseAgeMs: number | undefined
      const unknownMaps = new Set<string>()
      for (const [name, robot] of Object.entries(fleet.robots ?? {})) {
        robotsSeen++
        if (!robot.location) {
          robotsWithoutLocation++
          continue
        }
        if (!config.maps[robot.location.map]) {
          unknownMaps.add(robot.location.map)
          continue
        }
        if (robot.unix_millis_time !== undefined) {
          const age = Math.max(0, Date.now() - robot.unix_millis_time)
          maxPoseAgeMs = Math.max(maxPoseAgeMs ?? 0, age)
        }
        const event = normalizer.robot(fleetName, name, robot, fabIdsByRmfId)
        if (event) {
          robotsPublished++
          broadcast('robot_states', event)
        }
      }
      const activeRecords = [...tasksByFabId.values()].filter((record) => !record.terminal)
      const states = await api.getTaskStates(activeRecords.map((record) => record.rmfId))
      for (const state of states) {
        const fabworldId = fabIdsByRmfId.get(state.booking.id)
        const record = fabworldId ? tasksByFabId.get(fabworldId) : undefined
        if (!record) continue
        const terminal = isTerminalRmfTask(state)
        if (record.ingestAuthority && !terminal) continue
        const event = normalizer.task(state, record)
        if (!taskStateEquivalent(event, record.lastEvent)) {
          record.lastEvent = event
          rememberTaskAuthority(record, event)
          broadcast('task_states', event)
        }
        record.terminal = terminal
        if (terminal) record.ingestAuthority = false
      }
      const fireAlarm = await api.getFireAlarm()
      if (fireAlarm) {
        if (lastFireAlarm === undefined) {
          lastFireAlarm = fireAlarm.trigger
          if (fireAlarm.trigger) {
            currentEmergencyEvent = { type: 'emergency', active: true, kind: 'fire', timestamp: fireAlarm.unix_millis_time }
            broadcast('emergency', currentEmergencyEvent)
          }
        } else if (fireAlarm.trigger !== lastFireAlarm) {
          lastFireAlarm = fireAlarm.trigger
          currentEmergencyEvent = {
            type: 'emergency',
            active: fireAlarm.trigger,
            ...(fireAlarm.trigger ? { kind: 'fire' as const } : {}),
            timestamp: fireAlarm.unix_millis_time
          }
          broadcast('emergency', currentEmergencyEvent)
        }
      }
      const now = Date.now()
      const staleThresholdMs = Math.max(1_500, config.rmfWeb.pollMs * 4)
      const degradedReasons = [
        ...(correlationFault ? [correlationFault] : []),
        ...(unknownMaps.size > 0 ? [`미등록 RMF map: ${[...unknownMaps].join(', ')}`] : []),
        ...(robotsWithoutLocation > 0 ? [`location 없는 로봇 ${robotsWithoutLocation}대`] : []),
        ...(maxPoseAgeMs !== undefined && maxPoseAgeMs > staleThresholdMs ? [`pose age ${maxPoseAgeMs}ms`] : [])
      ]
      lastRmfSuccessAt = now
      lastRmfError = degradedReasons.join(' · ')
      const actionStageLatencyMs = diagnostics.actionStageLatencyMs
      const actionTelemetryLatencyMs = diagnostics.actionTelemetryLatencyMs
      diagnostics = {
        type: 'bridge_status',
        status: degradedReasons.length > 0 ? 'degraded' : 'ready',
        fleet: fleetName,
        robotsSeen,
        robotsPublished,
        robotsWithoutLocation,
        unknownMaps: [...unknownMaps].sort(),
        pollLatencyMs: now - pollStartedAt,
        ...(maxPoseAgeMs !== undefined ? { maxPoseAgeMs } : {}),
        ...(actionStageLatencyMs !== undefined ? { actionStageLatencyMs } : {}),
        ...(actionTelemetryLatencyMs !== undefined ? { actionTelemetryLatencyMs } : {}),
        detail: degradedReasons.length > 0
          ? degradedReasons.join(' · ')
          : `${robotsPublished}/${robotsSeen}대 pose 정규화`,
        timestamp: now
      }
      publishStatus()
    } catch (error) {
      lastRmfError = error instanceof Error ? error.message : String(error)
      diagnostics = {
        ...diagnostics,
        status: 'offline',
        pollLatencyMs: Date.now() - pollStartedAt,
        detail: lastRmfError,
        timestamp: Date.now()
      }
      publishStatus()
    } finally {
      polling = false
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen)
    httpServer.listen(config.listen.port, config.listen.host, () => {
      httpServer.off('error', rejectListen)
      resolveListen()
    })
  })
  await poll()
  const interval = setInterval(() => void poll(), config.rmfWeb.pollMs)
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Bridge did not bind to a TCP port')
  return {
    port: address.port,
    url: `ws://${config.listen.host}:${address.port}${config.listen.path}`,
    close: async () => {
      clearInterval(interval)
      for (const socket of clients.keys()) socket.close(1001, 'Bridge shutdown')
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()))
      await new Promise<void>((resolveClose, rejectClose) => httpServer.close((error) => error ? rejectClose(error) : resolveClose()))
    }
  }
}

function authorityEventSignature(event: TaskAuthorityEvent): string {
  return event.type === 'task_state'
    ? JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        category: event.category,
        status: event.status,
        assignedRobot: event.assignedRobot,
        targetId: event.targetId,
        interactionKind: event.interactionKind
      })
    : event.type === 'work_permit'
      ? JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        authorized: event.authorized,
        authorizedBy: event.authorizedBy,
        clearance: event.clearance,
        personId: event.personId,
        reason: event.reason
      })
      : JSON.stringify({
        type: event.type,
        taskId: event.taskId,
        category: event.category,
        robot: event.robot,
        phase: event.phase,
        progress: event.progress,
        leftHandContact: event.leftHandContact,
        rightHandContact: event.rightHandContact,
        valvePosition: event.valvePosition,
        gasPpm: event.gasPpm,
        sensorStable: event.sensorStable
      })
}

function taskStateEquivalent(event: TaskStateEvent, previous: RmfBridgeEvent | undefined): boolean {
  return previous?.type === 'task_state' &&
    authorityEventSignature(event) === authorityEventSignature(previous)
}

function compactTaskAuthorityHistory(events: TaskAuthorityEvent[]): TaskAuthorityEvent[] {
  const required = new Set<number>([0, events.length - 1])
  const latestEvidence = new Map<string, number>()
  for (const [index, event] of events.entries()) {
    const evidenceKey = event.type === 'work_permit'
      ? `permit:${event.authorized}`
      : event.type === 'action_telemetry'
        ? `telemetry:${event.phase}`
      : `task:${event.status}:${event.interactionKind ?? ''}`
    latestEvidence.set(evidenceKey, index)
  }
  for (const index of latestEvidence.values()) required.add(index)

  // The evidence keys above are intentionally bounded by the protocol's
  // lifecycle/status vocabulary. Fill any spare capacity with the most recent
  // transitions so reconnect remains useful for diagnostics as well.
  for (let index = events.length - 1; required.size < MAX_TASK_AUTHORITY_EVENTS && index >= 0; index--) {
    required.add(index)
  }
  return [...required]
    .sort((left, right) => left - right)
    .slice(-MAX_TASK_AUTHORITY_EVENTS)
    .map((index) => events[index]!)
}

function authorized(request: IncomingMessage, url: URL, config: BridgeConfig): boolean {
  if (!config.browserToken) return true
  const provided = url.searchParams.get('token') ?? bearerToken(request.headers.authorization)
  return provided !== undefined && safeEqual(provided, config.browserToken)
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value?.startsWith('Bearer ')) return undefined
  return value.slice('Bearer '.length)
}

function authorizedBearer(request: IncomingMessage, token: string): boolean {
  const provided = bearerToken(request.headers.authorization)
  return provided !== undefined && safeEqual(provided, token)
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new PayloadTooLargeError()
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

class PayloadTooLargeError extends Error {}

function pruneTaskRecords(
  tasksByFabId: Map<string, TaskRecord>,
  fabIdsByRmfId: Map<string, string>,
  workPermitsByFabId: Map<string, WorkPermitEvent>
): void {
  if (tasksByFabId.size <= 1_000) return
  for (const [fabworldId, record] of tasksByFabId) {
    if (!record.terminal) continue
    tasksByFabId.delete(fabworldId)
    fabIdsByRmfId.delete(record.rmfId)
    workPermitsByFabId.delete(fabworldId)
    if (tasksByFabId.size <= 800) break
  }
}

async function main(): Promise<void> {
  const config = loadBridgeConfig()
  const bridge = await startBridge(config)
  console.log(`FabWorld RMF Bridge listening on ${bridge.url}`)
  if (!config.browserToken) console.warn('FABWORLD_BRIDGE_TOKEN is not set; browser WebSocket authentication is disabled.')
  const stop = (): void => { void bridge.close().finally(() => process.exit(0)) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
