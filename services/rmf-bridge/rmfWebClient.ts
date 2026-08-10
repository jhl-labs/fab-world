import type { BridgeConfig } from './config'
import {
  RmfDispatchResponseSchema,
  RmfFireAlarmSchema,
  RmfFleetStateSchema,
  RmfTaskStateSchema,
  type RmfDispatchResponse,
  type RmfFleetState,
  type RmfTaskState
} from './contracts'

export interface RmfApi {
  getFleetState(): Promise<RmfFleetState>
  getTaskStates(ids: string[]): Promise<RmfTaskState[]>
  dispatchTask(payload: Record<string, unknown>): Promise<RmfDispatchResponse>
  cancelTask(payload: Record<string, unknown>): Promise<void>
  getFireAlarm(): Promise<{ unix_millis_time: number; trigger: boolean } | undefined>
}

export class RmfWebClient implements RmfApi {
  constructor(private readonly config: BridgeConfig['rmfWeb']) {}

  async getFleetState(): Promise<RmfFleetState> {
    return RmfFleetStateSchema.parse(await this.request(`/fleets/${encodeURIComponent(this.config.fleet)}/state`))
  }

  async getTaskStates(ids: string[]): Promise<RmfTaskState[]> {
    if (ids.length === 0) return []
    const query = new URLSearchParams({ task_id: ids.join(',') })
    const result = await this.request(`/tasks?${query.toString()}`)
    return RmfTaskStateSchema.array().parse(result)
  }

  async dispatchTask(payload: Record<string, unknown>): Promise<RmfDispatchResponse> {
    return RmfDispatchResponseSchema.parse(await this.request('/tasks/dispatch_task', {
      method: 'POST',
      body: JSON.stringify(payload)
    }))
  }

  async cancelTask(payload: Record<string, unknown>): Promise<void> {
    await this.request('/tasks/cancel_task', { method: 'POST', body: JSON.stringify(payload) })
  }

  async getFireAlarm(): Promise<{ unix_millis_time: number; trigger: boolean } | undefined> {
    try {
      return RmfFireAlarmSchema.parse(await this.request('/building_map/previous_fire_alarm_trigger'))
    } catch (error) {
      if (error instanceof RmfHttpError && error.status === 404) return undefined
      throw error
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(new URL(path, ensureTrailingSlash(this.config.baseUrl)), {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
        ...init.headers
      },
      signal: AbortSignal.timeout(this.config.timeoutMs)
    })
    const text = await response.text()
    if (!response.ok) throw new RmfHttpError(response.status, text)
    return text ? JSON.parse(text) as unknown : undefined
  }
}

export class RmfHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`RMF-Web request failed (${status}): ${body.slice(0, 500)}`)
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}
