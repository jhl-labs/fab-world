import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'
import { RmfBridgeEventSchema } from '../src/core/schema'
import { RmfTraceRecorder } from '../services/rmf-bridge/traceRecording'

const args = process.argv.slice(2)
const bridgeUrl = args[0]
const outputArg = args[1]
if (!bridgeUrl || !outputArg) {
  throw new Error('Usage: npm run record:rmf -- <ws-url> <output.json> [--duration 90] [--name "site trace"] [--fleet name] [--map name]')
}
const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const durationSeconds = Number(option('--duration') ?? 90)
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3_600) throw new Error('--duration must be between 0 and 3600 seconds')
const name = option('--name') ?? 'FabWorld recorded RMF trace'
const fleet = option('--fleet')
const map = option('--map')
const output = resolve(outputArg)
const recorder = new RmfTraceRecorder()
const startedAt = performance.now()
const socket = new WebSocket(bridgeUrl, { maxPayload: 1_000_000 })
let finished = false

socket.on('open', () => {
  socket.send(JSON.stringify({
    type: 'subscribe',
    channels: ['robot_states', 'task_states', 'work_permits', 'action_telemetry', 'emergency']
  }))
  console.log(`Recording normalized RMF events for ${durationSeconds}s. Dispatch the tasks that should become replay templates.`)
})

socket.on('message', (raw) => {
  try {
    const parsed = JSON.parse(raw.toString()) as unknown
    const candidate = typeof parsed === 'object' && parsed !== null && 'event' in parsed ? (parsed as { event: unknown }).event : parsed
    const event = RmfBridgeEventSchema.safeParse(candidate)
    if (event.success) recorder.add(event.data, performance.now() - startedAt)
  } catch {
    // Ignore bridge status and non-contract messages; malformed event counts are reported by the bridge itself.
  }
})

socket.on('error', (error) => {
  if (!finished) console.error(`RMF trace socket error: ${error.message}`)
})

const finish = (): void => {
  if (finished) return
  finished = true
  try {
    const trace = recorder.build({
      name,
      recordedAt: new Date().toISOString(),
      ...(fleet ? { fleet } : {}),
      ...(map ? { map } : {})
    })
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(trace, null, 2)}\n`)
    console.log(`Saved ${recorder.eventCount} events as ${trace.tasks.length} task templates to ${output}.`)
  } finally {
    socket.close()
  }
}

const timer = setTimeout(finish, durationSeconds * 1_000)
process.once('SIGINT', () => {
  clearTimeout(timer)
  finish()
})
