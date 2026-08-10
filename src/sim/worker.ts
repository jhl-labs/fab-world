/// <reference lib="webworker" />
import type {
  MainToWorker,
  RiskComparisonRunMetrics,
  SimMetrics,
  WorkerToMain
} from '../core/protocol'
import type { FabLayout } from '../core/schema'
import { SimulationClock } from './clock'
import { SimWorld } from './world'

let world: SimWorld | undefined
let configuredLayout: FabLayout | undefined
let configuredPoseBuffer: SharedArrayBuffer | undefined
let rmfExternal = false
let rmfConnected = false
interface RiskComparisonCoordinator {
  phase: 'human' | 'transition' | 'humanoid' | 'complete'
  human?: RiskComparisonRunMetrics
  humanoid?: RiskComparisonRunMetrics
  transitionAt?: number
}
let comparison: RiskComparisonCoordinator | undefined
const comparisonSeed = 20260729
const clock = new SimulationClock()
let lastFrame = performance.now()
let lastMetrics = 0
let lastEquipmentSignature = ''

const send = (message: WorkerToMain, transfer?: Transferable[]) => postMessage(message, transfer ?? [])
const createWorld = (seed: number): SimWorld | undefined => {
  if (!configuredLayout) return undefined
  const nextWorld = new SimWorld(configuredLayout, seed, configuredPoseBuffer)
  nextWorld.setRmfConnection(rmfExternal, rmfConnected)
  clock.resetAccumulator()
  lastFrame = performance.now()
  lastMetrics = 0
  lastEquipmentSignature = ''
  return nextWorld
}
const clearComparison = (): void => { comparison = undefined }
const synchronizeComparison = (now: number): void => {
  if (!world || !comparison) return
  const result = world.riskComparisonResult
  if (comparison.phase === 'human' && result?.mode === 'human') {
    comparison.human = result
    comparison.phase = 'transition'
    comparison.transitionAt = now + 2_500
    return
  }
  if (
    comparison.phase === 'transition' &&
    comparison.human &&
    now >= (comparison.transitionAt ?? Infinity)
  ) {
    const nextWorld = createWorld(comparisonSeed)
    if (!nextWorld) return
    world = nextWorld
    world.startRiskComparison('humanoid', {
      sourceEquipmentId: comparison.human.sourceEquipmentId,
      targetId: comparison.human.targetId
    })
    comparison.phase = 'humanoid'
    return
  }
  if (comparison.phase === 'humanoid' && result?.mode === 'humanoid') {
    comparison.humanoid = result
    comparison.phase = 'complete'
  }
}
const withComparison = (metrics: SimMetrics): SimMetrics => {
  if (!comparison) return metrics
  const stage = comparison.phase === 'transition'
    ? 'transition'
    : comparison.phase === 'complete'
      ? 'complete'
      : metrics.riskComparison.stage
  return {
    ...metrics,
    riskComparison: {
      ...metrics.riskComparison,
      active: true,
      stage,
      ...(comparison.human ? { human: comparison.human } : {}),
      ...(comparison.humanoid ? { humanoid: comparison.humanoid } : {})
    }
  }
}
const loop = (): void => {
  const now = performance.now(); const realDt = (now - lastFrame) / 1000; lastFrame = now
  if (world) {
    const start = performance.now(); clock.advance(realDt, (dt) => world?.tick(dt)); const tickMs = performance.now() - start
    synchronizeComparison(now)
    world.updateRealtime(realDt)
    const events = world.drainEvents(); if (events.length) send({ type: 'event', events })
    if (!world.sharedPose) { const snapshot = world.poseSnapshot(); send({ type: 'pose', ...snapshot }, [snapshot.buffer]) }
    if (now - lastMetrics > 250 || events.some((event) => event.type === 'phaseChanged')) {
      lastMetrics = now
      send({ type: 'metrics', metrics: withComparison({ ...world.metrics, tickMs }) })
      const equipmentSignature = world.equipment.map((equipment) => equipment.state[0]).join('')
      if (equipmentSignature !== lastEquipmentSignature) {
        lastEquipmentSignature = equipmentSignature
        send({ type: 'equipment', states: world.equipment.map(({ id, state }) => ({ id, state })) })
      }
    }
  }
  setTimeout(loop, 4)
}
self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data
  switch (message.type) {
    case 'init':
      configuredLayout = message.layout
      configuredPoseBuffer = message.poseBuffer
      world = createWorld(message.seed)
      if (world) send({ type: 'ready', entities: world.metas, usingSharedBuffer: world.sharedPose })
      break
    case 'setTimeScale':
      clock.setTimeScale(message.value)
      send({ type: 'event', events: [{ type: 'log', message: message.value === 0 ? '시뮬레이션 일시정지' : `시뮬레이션 ${message.value}× 재생` }] })
      break
    case 'step': if (world) clock.step((dt) => world?.tick(dt)); break
    case 'loadScenario':
      // A scenario is a reproducible demonstration run, not an overlay on whatever
      // incidental state happened to exist when its button was pressed.
      clearComparison()
      world = createWorld(message.scenario.seed)
      world?.loadScenario(message.scenario)
      break
    case 'triggerEmergency': clearComparison(); world?.triggerEmergency(message.kind); break
    case 'dispatchHumanoidTask': clearComparison(); world?.dispatchHumanoidTask(message.request); break
    case 'injectHumanoidFailure': clearComparison(); world?.injectHumanoidFailure(); break
    case 'startHumanoidShowcase': clearComparison(); world?.startHumanoidShowcase(); break
    case 'startRiskComparison':
      if (rmfExternal) {
        send({
          type: 'event',
          events: [{
            type: 'hudMessage',
            message: 'A/B 실측은 동일 초기상태를 재생성해야 하므로 LOCAL DEMO에서만 실행할 수 있습니다.',
            data: { severity: 'danger' }
          }]
        })
        break
      }
      comparison = { phase: 'human' }
      world = createWorld(comparisonSeed)
      world?.startRiskComparison('human')
      break
    case 'setRmfConnection':
      rmfExternal = message.external
      rmfConnected = message.connected
      if (message.external && comparison) clearComparison()
      world?.setRmfConnection(message.external, message.connected)
      break
    case 'rmfEvent': world?.applyRmfEvent(message.event); break
    case 'reset': clearComparison(); world?.resetOperation(); break
  }
}
loop()
