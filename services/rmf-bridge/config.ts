import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const MapTransformSchema = z.object({
  fabMap: z.string().min(1),
  offsetX: z.number().finite().default(0),
  offsetZ: z.number().finite().default(0),
  yaw: z.number().finite().default(0),
  scale: z.number().positive().default(1)
})

export const NavigationWaypointSchema = z.object({
  map: z.string().min(1),
  waypoint: z.union([z.string().min(1), z.number().int().nonnegative()]),
  x: z.number().finite(),
  y: z.number().finite(),
  maxDistance: z.number().positive()
})

export const BridgeConfigSchema = z.object({
  listen: z.object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(4190),
    path: z.string().startsWith('/').default('/fabworld')
  }),
  rmfWeb: z.object({
    baseUrl: z.string().url(),
    fleet: z.string().min(1),
    pollMs: z.number().int().min(100).max(10_000).default(250),
    timeoutMs: z.number().int().min(100).max(30_000).default(3_000),
    token: z.string().optional()
  }),
  browserToken: z.string().min(16).optional(),
  ingestToken: z.string().min(16).optional(),
  allowedOrigins: z.array(z.string().min(1)).default([]),
  maps: z.record(z.string(), MapTransformSchema),
  navigationWaypoints: z.array(NavigationWaypointSchema).default([])
}).superRefine((config, context) => {
  if (!isLoopbackHost(config.listen.host)) {
    if (!config.browserToken) {
      context.addIssue({
        code: 'custom',
        path: ['browserToken'],
        message: 'A browser token is required when the bridge listens on a non-loopback interface'
      })
    }
    if (config.allowedOrigins.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['allowedOrigins'],
        message: 'At least one allowed origin is required when the bridge listens on a non-loopback interface'
      })
    }
  }
  const identities = new Set<string>()
  config.navigationWaypoints.forEach((anchor, index) => {
    if (!config.maps[anchor.map]) {
      context.addIssue({
        code: 'custom',
        path: ['navigationWaypoints', index, 'map'],
        message: `Navigation waypoint references unmapped RMF map ${anchor.map}`
      })
    }
    const identity = `${anchor.map}\u0000${String(anchor.waypoint)}`
    if (identities.has(identity)) {
      context.addIssue({
        code: 'custom',
        path: ['navigationWaypoints', index, 'waypoint'],
        message: `Duplicate navigation waypoint ${anchor.map}/${String(anchor.waypoint)}`
      })
    }
    identities.add(identity)
  })
})

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>
export type MapTransform = z.infer<typeof MapTransformSchema>

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const configPath = env.RMF_BRIDGE_CONFIG
  const fileConfig = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) as unknown : {}
  const fileRecord = typeof fileConfig === 'object' && fileConfig !== null ? fileConfig as Record<string, unknown> : {}
  const fileRmfWeb = typeof fileRecord.rmfWeb === 'object' && fileRecord.rmfWeb !== null ? fileRecord.rmfWeb as Record<string, unknown> : {}
  const rmfMap = env.RMF_MAP_NAME ?? 'fab-L1'
  const defaults = {
    listen: {
      host: env.RMF_BRIDGE_HOST ?? '127.0.0.1',
      port: Number(env.RMF_BRIDGE_PORT ?? 4190),
      path: env.RMF_BRIDGE_PATH ?? '/fabworld'
    },
    rmfWeb: {
      baseUrl: env.RMF_API_URL ?? 'http://127.0.0.1:8000',
      fleet: env.RMF_FLEET_NAME ?? 'fab_humanoid_fleet',
      pollMs: Number(env.RMF_POLL_MS ?? 250),
      timeoutMs: Number(env.RMF_TIMEOUT_MS ?? 3_000),
      ...(env.RMF_API_TOKEN ? { token: env.RMF_API_TOKEN } : {})
    },
    ...(env.FABWORLD_BRIDGE_TOKEN ? { browserToken: env.FABWORLD_BRIDGE_TOKEN } : {}),
    ...(env.RMF_INGEST_TOKEN ? { ingestToken: env.RMF_INGEST_TOKEN } : {}),
    allowedOrigins: env.RMF_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [],
    navigationWaypoints: [],
    maps: {
      [rmfMap]: {
        fabMap: env.FABWORLD_MAP_NAME ?? 'fab-L1',
        offsetX: Number(env.RMF_MAP_OFFSET_X ?? 0),
        offsetZ: Number(env.RMF_MAP_OFFSET_Z ?? 0),
        yaw: Number(env.RMF_MAP_YAW ?? 0),
        scale: Number(env.RMF_MAP_SCALE ?? 1)
      }
    }
  }
  const merged = {
    ...defaults,
    ...fileRecord,
    rmfWeb: {
      ...defaults.rmfWeb,
      ...fileRmfWeb,
      ...(env.RMF_API_TOKEN ? { token: env.RMF_API_TOKEN } : {})
    },
    ...(env.FABWORLD_BRIDGE_TOKEN ? { browserToken: env.FABWORLD_BRIDGE_TOKEN } : {}),
    ...(env.RMF_INGEST_TOKEN ? { ingestToken: env.RMF_INGEST_TOKEN } : {})
  }
  return BridgeConfigSchema.parse(merged)
}
