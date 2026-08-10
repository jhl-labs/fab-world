import { useEffect, useRef, useState, type ReactElement } from 'react'
import layoutJson from '../data/layouts/fab-default.json'
import gasJson from '../data/scenarios/gas-leak.json'
import fireJson from '../data/scenarios/fire.json'
import medicalJson from '../data/scenarios/medical.json'
import referenceRmfTraceUrl from '../data/rmf-traces/humanoid-showcase.json?url'
import { FabLayoutSchema, ScenarioSchema, type EmergencyKind, type Scenario } from './core/schema'
import type { EntityMeta, EquipmentStateView, MainToWorker, WorkerToMain } from './core/protocol'
import { POSE_FLOATS, POSE_HEADER_INTS } from './core/protocol'
import { RenderEngine } from './render/engine'
import type { CameraMode } from './render/camera/controller'
import { configuredRmfBridgeUrl, configuredRmfTraceSource, RmfBridgeClient, type RmfConnectionOptions, type RmfTaskConnection } from './integrations/rmf/client'
import { RmfTracePlayer } from './integrations/rmf/trace'
import { Hud } from './ui/Hud'
import { useFabStore } from './ui/store'

const layout = FabLayoutSchema.parse(layoutJson)
const scenarios = [ScenarioSchema.parse(gasJson), ScenarioSchema.parse(fireJson), ScenarioSchema.parse(medicalJson)] as const
const fabMapName = import.meta.env.VITE_FAB_MAP_NAME ?? 'fab-L1'
const poseByteLength = POSE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT + POSE_FLOATS * Float32Array.BYTES_PER_ELEMENT
const taskTargets = new Map<string, readonly [number, number]>([
  ...layout.bays.flatMap((bay) => bay.equipment).map((equipment) => [equipment.id, [equipment.position[0], equipment.position[2]] as const] as const),
  ...layout.emergency.safetyDevices.map((device) => [device.id, [device.position[0], device.position[2]] as const] as const)
])

export function FabApp(): ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<RenderEngine | undefined>(undefined)
  const workerRef = useRef<Worker | undefined>(undefined)
  const sharedRef = useRef<SharedArrayBuffer | undefined>(undefined)
  const rmfRef = useRef<RmfTaskConnection | undefined>(undefined)
  const activeScenarioRef = useRef<Scenario | undefined>(undefined)
  const equipmentStatesRef = useRef<EquipmentStateView[]>([])
  const taskSequenceRef = useRef(1)
  const interactionCameraUntilRef = useRef(0)
  const purposeCameraUntilRef = useRef(0)
  const cinematicCameraUntilRef = useRef(0)
  const cinematicSequenceRef = useRef(0)
  const cinematicTimersRef = useRef<number[]>([])
  const resolutionSequenceRef = useRef(0)
  const resolutionTimersRef = useRef<number[]>([])
  const gasTargetsRef = useRef(new Map<string, readonly [number, number]>())
  const gasInspectionRobotsRef = useRef(new Set<string>())
  const gasInspectionTargetsRef = useRef(new Map<string, readonly [number, number]>())
  const humanoidTaskTargetsRef = useRef(new Map<string, readonly [number, number]>())
  const gasInspectionShotShownRef = useRef(new Set<string>())
  const gasTailRobotShotTaskRef = useRef<string | undefined>(undefined)
  const gasIsolationVerifiedRef = useRef(false)
  const showcaseRequestedAtRef = useRef(-Infinity)
  const comparisonRequestedAtRef = useRef(-Infinity)
  const [ready, setReady] = useState(false)
  const entities = useFabStore((state) => state.entities)
  const store = useFabStore
  const post = (message: MainToWorker): void => workerRef.current?.postMessage(message)
  const cancelCinematicSequence = (): void => {
    cinematicSequenceRef.current++
    cinematicTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    cinematicTimersRef.current = []
    cinematicCameraUntilRef.current = 0
    resolutionSequenceRef.current++
    resolutionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    resolutionTimersRef.current = []
  }
  const startGasResolutionCinematic = (
    robotId?: string,
    target?: readonly [number, number]
  ): void => {
    gasIsolationVerifiedRef.current = true
    // Stop the pre-verification sequence once the sensor has accepted the
    // clearance. From this point the viewer stays on the verified work zone;
    // there is no generic "return" shot to an empty stretch of floor.
    cinematicSequenceRef.current++
    cinematicTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    cinematicTimersRef.current = []
    resolutionSequenceRef.current++
    resolutionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    resolutionTimersRef.current = []
    const sequence = resolutionSequenceRef.current
    const schedule = (delay: number, action: () => void): void => {
      resolutionTimersRef.current.push(window.setTimeout(() => {
        if (resolutionSequenceRef.current === sequence) action()
      }, delay))
    }
    schedule(650, () => {
      const state = store.getState()
      if (state.emergencyKind !== 'gasLeak' || state.phase === 'normal') return
      const robot = robotId ? state.entities.find((entity) => entity.id === robotId) : undefined
      if (robot) engineRef.current?.setEntityLabelBadge(robot.id, '센서 안정 · 격리 완료')
      if (robot && target) {
        state.setCameraMode('orbit')
        // A deliberately wider angle makes the state change readable: the
        // valve is closed, the work zone opens, and the two roles separate.
        engineRef.current?.cueCamera('resolution', target, robot)
      }
    })
    const showPostIsolationBeat = (next: 'evacuation' | 'inspection'): void => {
      const state = store.getState()
      if (state.emergencyKind !== 'gasLeak' || state.phase === 'normal') return
      const metrics = state.metrics
      const evacuationComplete = Boolean(metrics && metrics.totalEvacuees > 0 && metrics.evacuated >= metrics.totalEvacuees)
      if (evacuationComplete) {
        const muster = target && [...layout.emergency.musterPoints].sort((left, right) =>
          Math.hypot(left.position[0] - target[0], left.position[2] - target[1]) -
          Math.hypot(right.position[0] - target[0], right.position[2] - target[1])
        )[0]
        if (muster) {
          state.setCameraMode('orbit')
          engineRef.current?.cueCamera('muster', [muster.position[0], muster.position[2]])
        }
        return
      }
      const evacueesRemaining = metrics ? Math.max(0, metrics.totalEvacuees - metrics.evacuated) : Number.POSITIVE_INFINITY
      // A follow camera inside a nearly full muster group reads as a collision,
      // not as evacuation. The last arrivals remain visible in one calm wide
      // muster frame instead of cutting through bodies.
      const finalMusterTransit = evacueesRemaining <= 8
      // Once people are inside the final muster perimeter, no new individual
      // follow or muster cut is useful. Hold the current robot-response frame
      // until the live count reaches 100%, then show the single final check.
      if (finalMusterTransit) {
        schedule(700, () => showPostIsolationBeat(next))
        return
      }
      const movingEvacuee = state.entities
        .filter((entity) => entity.kind === 'person' && (entity.role === 'responder' || entity.role !== undefined))
        .map((entity) => ({ entity, speed: engineRef.current?.reader.pose(entity.index).speed ?? 0 }))
        .filter(({ speed }) => speed > 0.12)
        .sort((left, right) => (left.entity.role === 'responder' ? -1 : 0) - (right.entity.role === 'responder' ? -1 : 0) || right.speed - left.speed)[0]?.entity
      const movingInspector = state.entities
        .filter((entity) => gasInspectionRobotsRef.current.has(entity.id) && !gasInspectionShotShownRef.current.has(entity.id))
        .map((entity) => ({ entity, speed: engineRef.current?.reader.pose(entity.index).speed ?? 0 }))
        .filter(({ speed }) => speed > 0.08)
        .sort((left, right) => (left.entity.kind === 'igv' ? -1 : 0) - (right.entity.kind === 'igv' ? -1 : 0) || right.speed - left.speed)[0]?.entity
      // Prefer the intended narrative beat, but never hold on a completed
      // robot just because it is that beat's turn.  If its live subject is
      // unavailable, cut only to the other subject when that one is moving.
      const showEvacuation = next === 'evacuation'
        ? movingEvacuee !== undefined
        : movingInspector === undefined && movingEvacuee !== undefined
      const showInspection = next === 'inspection'
        ? movingInspector !== undefined
        : movingEvacuee === undefined && movingInspector !== undefined
      let producedShot = false
      if (showEvacuation && movingEvacuee) {
        state.select(movingEvacuee.id)
        state.setCameraMode('follow')
        engineRef.current?.setEntityLabelBadge(movingEvacuee.id, '안전 구역 대피')
        engineRef.current?.select(movingEvacuee)
        producedShot = true
      } else if (showInspection && movingInspector) {
        const inspectionTarget = gasInspectionTargetsRef.current.get(movingInspector.id)
        state.select(movingInspector.id)
        state.setCameraMode('orbit')
        engineRef.current?.setEntityLabelBadge(movingInspector.id, '비접촉 설비 점검')
        if (inspectionTarget) engineRef.current?.cueCamera('inspection', inspectionTarget, movingInspector)
        else engineRef.current?.cueCamera('closeup', [0, 0], movingInspector)
        gasInspectionShotShownRef.current.add(movingInspector.id)
        producedShot = true
      }
      // A phase name alone is not a reason to cut. When the remaining people
      // are temporarily occluded or a robot has finished its inspection, hold
      // the current frame and poll quietly instead of creating a fake montage.
      schedule(producedShot ? (next === 'evacuation' ? 2_700 : 3_600) : 700, () => showPostIsolationBeat(
        producedShot
          ? (showEvacuation ? 'inspection' : 'evacuation')
          : next
      ))
    }
    // Isolation is the midpoint, not the ending: keep the evacuation and the
    // autonomous continuity work in view until every person is at muster.
    schedule(3_000, () => showPostIsolationBeat('inspection'))
  }
  const startGasEvacuationCinematic = (source?: readonly [number, number]): void => {
    cancelCinematicSequence()
    const sequence = cinematicSequenceRef.current
    const now = performance.now()
    // This is a three-beat story, not a timer-driven slideshow: establish the
    // evacuation, follow one real person out, then stay with the robot's work.
    // The short protection period prevents a late RMF assignment from cutting
    // through either of the two human beats.
    cinematicCameraUntilRef.current = now + 5_200
    purposeCameraUntilRef.current = now + 5_200
    const cue = (delay: number, shot: string, position: readonly [number, number]): void => {
      const timer = window.setTimeout(() => {
        if (cinematicSequenceRef.current !== sequence) return
        const state = store.getState()
        if (state.emergencyKind !== 'gasLeak' || state.phase === 'normal') return
        state.setCameraMode('orbit')
        engineRef.current?.cueCamera(shot, position)
      }, delay)
      cinematicTimersRef.current.push(timer)
    }
    const cueEvacuationFlow = (): void => {
      const state = store.getState()
      const evacuee = state.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator') ??
        state.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')
      if (!evacuee) return
      state.select(evacuee.id)
      state.setCameraMode('follow')
      engineRef.current?.setEntityLabelBadge(evacuee.id, '안전 구역 대피')
      engineRef.current?.select(evacuee)
    }
    // Establish the full evacuation, then let the viewer travel with a real
    // evacuee. This shows movement and direction instead of an empty exit.
    cue(0, 'evacuation-wide', source ?? [0, 0])
    const evacuationFlowTimer = window.setTimeout(() => {
      if (cinematicSequenceRef.current !== sequence) return
      const state = store.getState()
      if (state.emergencyKind !== 'gasLeak' || state.phase === 'normal') return
      cueEvacuationFlow()
    }, 2_600)
    cinematicTimersRef.current.push(evacuationFlowTimer)
    const valve = source
      ? [...layout.emergency.safetyDevices].sort((left, right) =>
          Math.hypot(left.position[0] - source[0], left.position[2] - source[1]) -
          Math.hypot(right.position[0] - source[0], right.position[2] - source[1])
        )[0]
      : layout.emergency.safetyDevices[0]
    const cueRobotWork = (): void => {
      const state = store.getState()
      const task = state.humanoidTasks.find((candidate) =>
        candidate.kind === 'gas_isolation' && !['completed', 'failed', 'cancelled'].includes(candidate.status)
      )
      const robot = task?.robotId ? state.entities.find((entity) => entity.id === task.robotId) : undefined
      if (!valve) return
      // Do not pretend that a distant robot is already at the valve. During
      // approach, a live follow shot makes its purposeful route legible; the
      // observation/interacting events below take over at the actual device.
      if (robot) {
        const pose = engineRef.current?.reader.pose(robot.index)
        if (pose && Math.hypot(pose.x - valve.position[0], pose.z - valve.position[2]) > 24) {
          state.select(robot.id)
          state.setCameraMode('follow')
          engineRef.current?.select(robot)
          return
        }
      }
      state.setCameraMode('orbit')
      engineRef.current?.cueCamera('closeup', [valve.position[0], valve.position[2]], robot)
    }
    const fieldCutTimer = window.setTimeout(() => {
      if (cinematicSequenceRef.current !== sequence) return
      const state = store.getState()
      if (state.emergencyKind !== 'gasLeak' || state.phase === 'normal') return
      cueRobotWork()
    }, 5_200)
    cinematicTimersRef.current.push(fieldCutTimer)
  }
  const startGasRecoveryCinematic = (): void => {
    resolutionSequenceRef.current++
    resolutionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    resolutionTimersRef.current = []
    const sequence = resolutionSequenceRef.current
    const timer = window.setTimeout(() => {
      if (resolutionSequenceRef.current !== sequence) return
      const state = store.getState()
      if (state.emergencyKind !== undefined || state.phase !== 'normal') return
      const worker = state.entities.find((entity) => entity.kind === 'person' && entity.role === 'engineer') ??
        state.entities.find((entity) => entity.kind === 'person' && entity.role === 'operator')
      if (!worker) return
      state.select(worker.id)
      state.setCameraMode('follow')
      engineRef.current?.setEntityLabelBadge(worker.id, '정상 설비 업무 복귀')
      engineRef.current?.select(worker)
    }, 3_800)
    resolutionTimersRef.current.push(timer)
  }
  useEffect(() => {
    const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' }); workerRef.current = worker
    const sab = crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(poseByteLength) : undefined; sharedRef.current = sab
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const message = event.data
      if (message.type === 'ready') { store.getState().setEntities(message.entities); store.getState().addLog(`시뮬레이션 준비 완료 — ${message.entities.length}개체`, 'info'); setReady(true) }
      else if (message.type === 'pose') engineRef.current?.acceptFallbackPose(message.buffer, message.generation, message.entityCount, message.simTimeMs)
      else if (message.type === 'metrics') {
        const state = store.getState()
        state.setMetrics(message.metrics)
        engineRef.current?.setHazardRadius(message.metrics.hazardRadius)
        const remaining = message.metrics.totalEvacuees - message.metrics.evacuated
        const activeContinuityTask = state.humanoidTasks.find((task) =>
          task.kind === 'inspection_round' &&
          ['assigned', 'navigating', 'observing', 'interacting', 'reporting'].includes(task.status)
        )
        // Preserve the actual response work during the final few safe-zone
        // arrivals. This is a single meaningful handoff from the valve to the
        // continuing inspection—not a timer-driven camera cut.
        if (
          gasIsolationVerifiedRef.current &&
          remaining > 0 &&
          remaining <= 8 &&
          activeContinuityTask &&
          activeContinuityTask.id !== gasTailRobotShotTaskRef.current
        ) {
          const robot = activeContinuityTask.robotId
            ? state.entities.find((entity) => entity.id === activeContinuityTask.robotId)
            : undefined
          const target = humanoidTaskTargetsRef.current.get(activeContinuityTask.id)
          if (robot && target) {
            state.select(robot.id)
            state.setCameraMode('orbit')
            engineRef.current?.setEntityLabelBadge(robot.id, '비상 설비 검증')
            engineRef.current?.cueCamera('inspection', target, robot)
            gasTailRobotShotTaskRef.current = activeContinuityTask.id
          }
        }
      }
      else if (message.type === 'equipment') { equipmentStatesRef.current = message.states; engineRef.current?.setEquipmentStates(message.states) }
      else if (message.type === 'event') for (const item of message.events) {
        if (item.type === 'interaction' && item.robotId && item.data?.interactionKind === 'remote_equipment_inspection') {
          gasInspectionRobotsRef.current.add(item.robotId)
          if (typeof item.data.targetX === 'number' && typeof item.data.targetZ === 'number') {
            gasInspectionTargetsRef.current.set(item.robotId, [item.data.targetX, item.data.targetZ])
          }
          engineRef.current?.setEntityLabelBadge(item.robotId, '비접촉 설비 점검')
        }
        if (item.type === 'interaction' && item.robotId && item.data?.interactionKind === 'remote_equipment_scan') {
          const state = store.getState()
          const robot = state.entities.find((entity) => entity.id === item.robotId)
          const targetX = item.data?.targetX
          const targetZ = item.data?.targetZ
          if (robot && typeof targetX === 'number' && typeof targetZ === 'number') {
            state.select(robot.id)
            state.setCameraMode('orbit')
            engineRef.current?.setEntityLabelBadge(robot.id, '비접촉 설비 스캔')
            engineRef.current?.cueCamera('inspection', [targetX, targetZ], robot)
          }
        }
        const manualGasInteraction =
          item.personId &&
          typeof item.data?.interactionKind === 'string' &&
          item.data.interactionKind.startsWith('manual_gas_')
        if (manualGasInteraction) {
          const state = store.getState()
          const person = state.entities.find((entity) => entity.id === item.personId)
          const targetX = item.data?.targetX
          const targetZ = item.data?.targetZ
          if (person && typeof targetX === 'number' && typeof targetZ === 'number') {
            interactionCameraUntilRef.current = performance.now() + 4_200
            purposeCameraUntilRef.current = performance.now() + 4_200
            state.select(person.id)
            state.setCameraMode('orbit')
            engineRef.current?.cueCamera('valve-closeup', [targetX, targetZ], person)
          }
        }
        if (item.type === 'interaction' && item.robotId && item.personId) {
          const state = store.getState()
          const robot = state.entities.find((entity) => entity.id === item.robotId)
            const person = state.entities.find((entity) => entity.id === item.personId)
            if (robot && person) {
            const robotX = item.data?.robotX
            const robotZ = item.data?.robotZ
            const personX = item.data?.personX
            const personZ = item.data?.personZ
              const eventPose = [robotX, robotZ, personX, personZ].every((value) => typeof value === 'number')
              ? {
                  robotX: robotX as number,
                  robotZ: robotZ as number,
                  personX: personX as number,
                  personZ: personZ as number,
                  ...(typeof item.data?.patientX === 'number' && typeof item.data?.patientZ === 'number'
                    ? { patientX: item.data.patientX, patientZ: item.data.patientZ }
                    : {}),
                  ...([
                    item.data?.robotGoalX,
                    item.data?.robotGoalZ,
                    item.data?.personGoalX,
                    item.data?.personGoalZ
                  ].every((value) => typeof value === 'number')
                    ? {
                        robotGoalX: item.data?.robotGoalX as number,
                        robotGoalZ: item.data?.robotGoalZ as number,
                        personGoalX: item.data?.personGoalX as number,
                        personGoalZ: item.data?.personGoalZ as number
                      }
                    : {})
                }
              : undefined
            const medicalHandoff = item.data?.interactionKind === 'medical_handoff'
            const medicalTreatment = item.data?.interactionKind === 'medical_treatment_started'
            const medicalInteraction = medicalHandoff || medicalTreatment
            const gasMonitoring = item.data?.interactionKind === 'gas_sensor_monitoring'
            const gasAuthorization = item.data?.interactionKind === 'gas_work_authorized'
            const gasFailure = item.data?.interactionKind === 'gas_failure_handoff'
            const patientId = typeof item.data?.patientId === 'string' ? item.data.patientId : undefined
            const patient = patientId ? state.entities.find((entity) => entity.id === patientId) : undefined
            const gasCinematicProtected =
              (gasMonitoring || gasAuthorization) && performance.now() < cinematicCameraUntilRef.current
            if (!gasCinematicProtected) {
              interactionCameraUntilRef.current = performance.now() + (
                medicalTreatment ? 5_500 :
                  medicalHandoff ? 4_300 :
                    gasMonitoring ? 4_000 :
                      gasFailure ? 5_500 :
                      gasAuthorization ? 3_200 :
                        2_200
              )
              state.setCameraMode('orbit')
              if (medicalInteraction) engineRef.current?.cueMedicalHandoff(robot, person, patient, eventPose)
              else if (gasFailure) engineRef.current?.cueGasFailureRetreat(robot, person, eventPose)
              else if (gasMonitoring) engineRef.current?.cueGasMonitoring(robot, person, eventPose)
              else engineRef.current?.cueInteraction(robot, person, eventPose)
            }
          }
        }
        if (item.type === 'interaction' && item.data?.interactionKind === 'gas_isolation_verified') {
          const target = typeof item.data?.targetX === 'number' && typeof item.data?.targetZ === 'number'
            ? [item.data.targetX, item.data.targetZ] as const
            : undefined
          if (item.taskId && target) gasTargetsRef.current.set(item.taskId, target)
          startGasResolutionCinematic(item.robotId, target)
        }
        if (item.type === 'phaseChanged' && item.phase) {
          const state = store.getState()
          const wasGasLeak = state.emergencyKind === 'gasLeak'
          const restored = item.data?.restored === 1
          state.setEmergency(item.kind, item.phase)
          const sourceX = item.data?.sourceX
          const sourceZ = item.data?.sourceZ
          const source = typeof sourceX === 'number' && typeof sourceZ === 'number' ? [sourceX, sourceZ] as const : undefined
          engineRef.current?.setEmergency(item.kind, item.phase, source)
          if (!restored && item.kind === 'gasLeak' && item.phase === 'alarm') {
            state.entities
              .filter((entity) => entity.kind === 'person')
              .forEach((entity) => engineRef.current?.setEntityLabelBadge(entity.id, '안전 구역 대피'))
            startGasEvacuationCinematic(source)
          }
          if (item.phase === 'normal') {
            state.entities
              .filter((entity) => entity.kind === 'person')
              .forEach((entity) => engineRef.current?.setEntityLabelBadge(entity.id))
            if (wasGasLeak) startGasRecoveryCinematic()
          }
          const configuredCue = activeScenarioRef.current?.cameraCues.find((cue) => cue.on.phase === item.phase)
          // Gas is one continuous causal story: source → alarm overview →
          // assigned robot → permit/valve/monitoring. Generic phase-follow
          // shots used to interrupt that story with a responder or evacuee
          // cut just as the work became meaningful.
          const gasPhaseCue = item.kind === 'gasLeak'
            ? (item.phase === 'detected'
              ? { shot: 'closeup' as const, target: 'hazard-source' as const }
              : item.phase === 'alarm'
                ? { shot: 'aerial' as const, target: 'hazard-zone' as const }
                : item.phase === 'allClear'
                  ? { shot: 'muster' as const, target: 'muster' as const }
                  : undefined)
            : undefined
          const defaultCue = gasPhaseCue ?? (item.kind === 'gasLeak'
            ? undefined
            : item.phase === 'detected' ? { shot: 'closeup', target: 'hazard-source' } : item.phase === 'alarm' ? { shot: 'aerial', target: 'hazard-zone' } : item.phase === 'response' ? { shot: 'follow', target: 'responder' } : item.phase === 'evacuation' ? { shot: 'follow', target: 'nearest-evacuee' } : item.phase === 'allClear' && item.kind !== 'medical' ? { shot: 'muster', target: 'muster' } : undefined)
          const cue = configuredCue ?? defaultCue
          // The detected cue is the opening beat of the gas story. Later gas
          // phases have their own event-driven sequence above, so they remain
          // protected from generic camera cuts.
          if (!restored && cue && (item.kind !== 'gasLeak' || item.phase === 'detected') && performance.now() >= purposeCameraUntilRef.current) {
            const target = cue.target === 'responder'
              ? state.entities.find((entity) => entity.kind === 'person' && entity.role === 'responder')
              : cue.target === 'nearest-evacuee'
                ? state.entities.find((entity) => entity.kind === 'person' && entity.role !== 'responder')
                : undefined
            const muster = cue.target === 'muster'
              ? [...layout.emergency.musterPoints].sort((left, right) => {
                  if (!source) return left.id.localeCompare(right.id)
                  return Math.hypot(left.position[0] - source[0], left.position[2] - source[1]) -
                    Math.hypot(right.position[0] - source[0], right.position[2] - source[1])
                })[0]
              : undefined
            const cuePosition = muster ? [muster.position[0], muster.position[2]] as const : source
            engineRef.current?.cueCamera(cue.shot, cuePosition, target)
            if (target && cue.shot === 'follow') { state.select(target.id); state.setCameraMode('follow') }
            else state.setCameraMode('orbit')
          }
        }
        if (item.type === 'taskStateChanged' && item.taskId && item.taskKind && item.taskStatus) {
          const state = store.getState()
          if (typeof item.data?.targetX === 'number' && typeof item.data?.targetZ === 'number') {
            humanoidTaskTargetsRef.current.set(item.taskId, [item.data.targetX, item.data.targetZ])
          }
          const restored = item.data?.restored === 1
          const requestedBy = item.data?.requestedBy
          state.upsertHumanoidTask({
            id: item.taskId,
            kind: item.taskKind,
            status: item.taskStatus,
            robotId: item.robotId,
            ...(requestedBy === 'rmf' || requestedBy === 'showcase' || requestedBy === 'operator'
              ? { requestedBy }
              : {})
          })
          if (item.taskStatus === 'queued' && item.data && item.data.requestedBy !== 'rmf') {
            const taskData = item.data
            const target = typeof taskData.targetX === 'number' && typeof taskData.targetZ === 'number'
              ? [taskData.targetX, taskData.targetZ] as [number, number]
              : undefined
            const accepted = rmfRef.current?.dispatchTask({
              id: item.taskId,
              kind: item.taskKind,
              targetId: typeof taskData.targetId === 'string' ? taskData.targetId : undefined,
              ...(target ? { target, targetMap: fabMapName } : {}),
              ...(typeof taskData.targetYaw === 'number' ? { targetYaw: taskData.targetYaw } : {}),
              requestedBy: taskData.requestedBy === 'showcase' ? 'showcase' : 'operator',
              priority: typeof taskData.priority === 'number' ? taskData.priority : 70
            })
            if (accepted === false && state.rmfState !== 'demo') {
              worker.postMessage({
                type: 'rmfEvent',
                event: {
                  type: 'task_state',
                  taskId: item.taskId,
                  category: item.taskKind,
                  status: 'failed',
                  ...(typeof taskData.targetId === 'string' ? { targetId: taskData.targetId } : {}),
                  timestamp: Date.now()
                }
              } satisfies MainToWorker)
              state.addLog(`Open-RMF readiness 미충족으로 ${item.taskId} 배정을 차단했습니다.`, 'danger')
            }
          }
          if (!restored && item.taskStatus === 'assigned' && item.robotId && performance.now() >= cinematicCameraUntilRef.current) {
            const robot = state.entities.find((entity) => entity.id === item.robotId)
            if (robot) {
              const target = typeof item.data?.targetX === 'number' && typeof item.data?.targetZ === 'number'
                ? [item.data.targetX, item.data.targetZ] as const
                : undefined
              state.select(robot.id)
              if (item.taskKind === 'inspection_round' && target) {
                state.setCameraMode('orbit')
                engineRef.current?.cueCamera('inspection', target, robot)
              } else {
                state.setCameraMode('follow')
                engineRef.current?.select(robot)
              }
            }
          }
          if (item.robotId) {
            const badge = item.taskKind === 'inspection_round' && item.taskStatus === 'navigating'
              ? '비상 설비 점검 이동'
              : item.taskKind === 'inspection_round' && item.taskStatus === 'observing'
                ? '설비 상태 스캔'
                : item.taskKind === 'inspection_round' && item.taskStatus === 'interacting'
                  ? '원격 인터록 확인'
                  : item.taskKind === 'inspection_round' && item.taskStatus === 'reporting'
                    ? '점검 결과 전송'
              : item.taskStatus === 'interacting' && item.taskKind === 'gas_isolation'
              ? '수동 밸브 조작'
              : item.taskStatus === 'reporting' && item.taskKind === 'gas_isolation'
                ? '센서 안정 · 결과 보고'
                : item.taskStatus === 'returning' && item.taskKind === 'gas_isolation'
                  ? '안전 복귀'
              : item.taskStatus === 'completed'
                    ? item.taskKind === 'gas_isolation' ? '격리 완료 · 안전 확인' : undefined
                    : item.taskStatus === 'navigating'
                      ? '현장 이동'
                      : item.taskStatus === 'observing'
                        ? '현장 확인'
                        : undefined
            engineRef.current?.setEntityLabelBadge(item.robotId, badge)
          }
          if (!restored && item.taskKind === 'gas_isolation' && item.taskStatus === 'completed') {
            const target = gasTargetsRef.current.get(item.taskId)
            const robot = item.robotId ? state.entities.find((entity) => entity.id === item.robotId) : undefined
            if (target && robot) {
              state.setCameraMode('orbit')
              // Reaffirm the completed response as a composition of the
              // valve, robot and safety officer—never a post-task follow shot
              // through unrelated empty factory space.
              engineRef.current?.cueCamera('resolution', target, robot)
            }
          }
          if (!restored && (item.taskStatus === 'observing' || item.taskStatus === 'interacting') && performance.now() >= cinematicCameraUntilRef.current) {
            const targetId = typeof item.data?.targetId === 'string' ? item.data.targetId : undefined
            const eventTarget = typeof item.data?.targetX === 'number' && typeof item.data?.targetZ === 'number'
              ? [item.data.targetX, item.data.targetZ] as const
              : undefined
            const target = (targetId ? taskTargets.get(targetId) : undefined) ?? eventTarget
            const showingInteraction = performance.now() < interactionCameraUntilRef.current
            const holdMs = item.taskStatus === 'observing' ? 2_800 : item.taskKind === 'gas_isolation' ? 6_200 : 4_200
            purposeCameraUntilRef.current = performance.now() + holdMs
            if (target && !showingInteraction) {
              state.setCameraMode('orbit')
              const robot = item.robotId ? state.entities.find((entity) => entity.id === item.robotId) : undefined
              engineRef.current?.cueCamera(item.taskKind === 'gas_isolation' ? 'valve-closeup' : 'closeup', target, robot)
            }
          }
          if (!restored && item.taskKind !== 'gas_isolation' && (item.taskStatus === 'reporting' || item.taskStatus === 'returning') && item.robotId) {
            const robot = state.entities.find((entity) => entity.id === item.robotId)
            const target = typeof item.data?.targetX === 'number' && typeof item.data?.targetZ === 'number'
              ? [item.data.targetX, item.data.targetZ] as const
              : undefined
            if (robot && item.taskKind === 'inspection_round' && item.taskStatus === 'reporting' && target) {
              state.select(robot.id)
              state.setCameraMode('orbit')
              engineRef.current?.setEntityLabelBadge(robot.id, '외곽 설비 지속 감시')
              engineRef.current?.cueCamera('inspection', target, robot)
            } else if (robot) {
              state.select(robot.id)
              state.setCameraMode('follow')
              engineRef.current?.select(robot)
            }
          }
        }
        if (item.message) {
          const eventSeverity = item.data?.severity
          store.getState().addLog(
            item.message,
            eventSeverity === 'warning' || eventSeverity === 'danger'
              ? eventSeverity
              : item.type === 'phaseChanged'
                ? 'warning'
                : 'info'
          )
        }
      }
    }
    worker.postMessage({ type: 'init', layout, seed: 20260729, ...(sab ? { poseBuffer: sab } : {}) } satisfies MainToWorker)
    const traceSource = configuredRmfTraceSource()
    const connectionOptions: Omit<RmfConnectionOptions, 'url'> = {
      onEvent: (rmfEvent) => worker.postMessage({ type: 'rmfEvent', event: rmfEvent } satisfies MainToWorker),
      onState: (rmfState, detail) => {
        if (rmfState === 'connecting' || rmfState === 'disconnected' || rmfState === 'demo' || rmfState === 'replay') {
          store.getState().setRmfBridgeStatus(undefined)
        }
        store.getState().setRmfState(rmfState, detail)
        worker.postMessage({
          type: 'setRmfConnection',
          external: rmfState !== 'demo',
          connected: rmfState === 'connected' || rmfState === 'replay'
        } satisfies MainToWorker)
      },
      onStatus: (status) => store.getState().setRmfBridgeStatus(status)
    }
    const rmf: RmfTaskConnection = traceSource
      ? new RmfTracePlayer({
          ...connectionOptions,
          loadTrace: () => fetch(traceSource === 'reference' ? referenceRmfTraceUrl : new URL(traceSource, window.location.href))
            .then(async (response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return response.json() as Promise<unknown>
            })
        })
      : new RmfBridgeClient({ ...connectionOptions, url: configuredRmfBridgeUrl() })
    rmfRef.current = rmf; rmf.connect()
    return () => { cancelCinematicSequence(); rmf.disconnect(); rmfRef.current = undefined; engineRef.current?.dispose(); worker.terminate(); workerRef.current = undefined }
  }, [])
  useEffect(() => {
    if (!ready || !viewportRef.current || engineRef.current) return
    engineRef.current = new RenderEngine(viewportRef.current, layout, entities, sharedRef.current, (stats) => store.getState().setStats(stats))
    engineRef.current.setEquipmentStates(equipmentStatesRef.current)
    return () => { engineRef.current?.dispose(); engineRef.current = undefined }
  }, [ready, entities])
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      const target = event.target
      const hasInteractiveFocus = target instanceof Element && target.closest(
        'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"]'
      ) !== null
      if (hasInteractiveFocus || event.ctrlKey || event.metaKey || event.altKey) return
      const state = store.getState()
      if (event.code === 'Space' && !event.repeat) { event.preventDefault(); const value = state.timeScale === 0 ? 1 : 0; state.setTimeScale(value); post({ type: 'setTimeScale', value }) }
      if (event.key === '[' || event.key === ']') { const values = [0.5, 1, 2, 4, 8, 16]; const index = Math.max(0, values.indexOf(state.timeScale)); const value = values[Math.max(0, Math.min(values.length - 1, index + (event.key === ']' ? 1 : -1)))]!; state.setTimeScale(value); post({ type: 'setTimeScale', value }) }
      const mode = event.key === '1' ? 'orbit' : event.key === '2' ? 'follow' : event.key === '3' ? 'firstPerson' : undefined
      if (mode) { state.setCameraMode(mode); engineRef.current?.setCameraMode(mode) }
      if (event.key.toLowerCase() === 'e') { const list = state.entities; const index = Math.max(0, list.findIndex((entity) => entity.id === state.selectedId)); const entity = list[(index + 1) % Math.max(1, list.length)]; state.select(entity?.id); engineRef.current?.select(entity) }
      if (event.key.toLowerCase() === 'f') { const entity = state.entities.find((item) => item.id === state.selectedId); engineRef.current?.select(entity) }
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown)
  }, [])
  const setScenario = (scenario: Scenario): void => {
    cancelCinematicSequence()
    gasInspectionRobotsRef.current.clear()
    gasInspectionTargetsRef.current.clear()
    humanoidTaskTargetsRef.current.clear()
    gasInspectionShotShownRef.current.clear()
    gasTailRobotShotTaskRef.current = undefined
    gasIsolationVerifiedRef.current = false
    const state = store.getState()
    rmfRef.current?.cancelTasks(state.humanoidTasks.filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status)).map((task) => task.id))
    state.clearHumanoidTasks()
    activeScenarioRef.current = scenario
    post({ type: 'reset' })
    post({ type: 'loadScenario', scenario })
    state.addLog(`${scenario.name}을 시작합니다.`, 'warning')
  }
  const trigger = (kind: EmergencyKind): void => {
    cancelCinematicSequence()
    gasInspectionRobotsRef.current.clear()
    gasInspectionTargetsRef.current.clear()
    humanoidTaskTargetsRef.current.clear()
    gasInspectionShotShownRef.current.clear()
    gasTailRobotShotTaskRef.current = undefined
    gasIsolationVerifiedRef.current = false
    activeScenarioRef.current = undefined
    post({ type: 'triggerEmergency', kind })
  }
  const startShowcase = (): void => {
    const requestedAt = performance.now()
    if (requestedAt - showcaseRequestedAtRef.current < 750) return
    showcaseRequestedAtRef.current = requestedAt
    cancelCinematicSequence()
    activeScenarioRef.current = undefined
    const state = store.getState()
    if (!['demo', 'replay', 'connected'].includes(state.rmfState)) {
      state.addLog(`통합 시연 시작 차단 — ${state.rmfDetail || 'Open-RMF readiness를 확인할 수 없습니다.'}`, 'danger')
      return
    }
    const activeTaskIds = state.humanoidTasks
      .filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status))
      .map((task) => task.id)
    if (activeTaskIds.length > 0) {
      rmfRef.current?.cancelTasks(activeTaskIds)
      state.addLog(`기존 진행 태스크 ${activeTaskIds.length}건을 취소하고 통합 시연을 다시 준비합니다.`, 'warning')
    }
    state.clearHumanoidTasks()
    if (state.timeScale !== 1) { state.setTimeScale(1); post({ type: 'setTimeScale', value: 1 }) }
    post({ type: 'startHumanoidShowcase' })
    state.addLog('휴머노이드 통합 운영 시연을 실제 시간(1×)으로 시작합니다.', 'info')
  }
  const startRiskComparison = (): void => {
    const requestedAt = performance.now()
    if (requestedAt - comparisonRequestedAtRef.current < 750) return
    comparisonRequestedAtRef.current = requestedAt
    cancelCinematicSequence()
    activeScenarioRef.current = undefined
    const state = store.getState()
    if (state.rmfState !== 'demo') {
      state.addLog('위험작업 A/B 실측은 동일 초기상태를 재생성하는 LOCAL DEMO에서만 실행할 수 있습니다.', 'danger')
      return
    }
    const activeTaskIds = state.humanoidTasks
      .filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status))
      .map((task) => task.id)
    if (activeTaskIds.length > 0) rmfRef.current?.cancelTasks(activeTaskIds)
    state.clearHumanoidTasks()
    if (state.timeScale !== 1) {
      state.setTimeScale(1)
      post({ type: 'setTimeScale', value: 1 })
    }
    state.setCameraMode('orbit')
    engineRef.current?.setCameraMode('orbit')
    post({ type: 'startRiskComparison' })
    state.addLog('동일 seed·설비·밸브·조작시간으로 사람 직접 조작과 휴머노이드 투입을 순차 실측합니다.', 'warning')
  }
  const dispatchInspection = (): void => {
    const state = store.getState()
    if (!['demo', 'replay', 'connected'].includes(state.rmfState)) {
      state.addLog(`점검 태스크 요청 차단 — ${state.rmfDetail || 'Open-RMF readiness를 확인할 수 없습니다.'}`, 'danger')
      return
    }
    const request = { id: `operator-inspection-${taskSequenceRef.current++}`, kind: 'inspection_round' as const, requestedBy: 'operator' as const, priority: 60 }
    // Resolve the equipment and exact approach point in the authoritative world
    // before sending the task to an external RMF dispatcher.
    post({ type: 'dispatchHumanoidTask', request })
  }
  const injectHumanoidFailure = (): void => {
    const task = store.getState().humanoidTasks.find((candidate) =>
      candidate.kind === 'gas_isolation' &&
      ['queued', 'assigned', 'navigating', 'observing', 'interacting'].includes(candidate.status)
    )
    if (!task) return
    rmfRef.current?.cancelTasks([task.id])
    post({ type: 'injectHumanoidFailure' })
  }
  const select = (entity?: EntityMeta): void => { store.getState().select(entity?.id); engineRef.current?.select(entity) }
  return <main className="app-shell"><div className="viewport" ref={viewportRef} />{ready ? <Hud scenarios={scenarios} onTimeScale={(value) => post({ type: 'setTimeScale', value })} onStep={() => post({ type: 'step' })} onScenario={setScenario} onEmergency={trigger} onCamera={(mode: CameraMode) => engineRef.current?.setCameraMode(mode)} onSelect={select} onShowcase={startShowcase} onRiskComparison={startRiskComparison} onInspection={dispatchInspection} onInjectFailure={injectHumanoidFailure} /> : <div className="boot-screen"><div className="spinner" /><p>FABWORLD INITIALIZING</p><small>레이아웃과 결정적 시뮬레이션을 준비하고 있습니다.</small></div>}</main>
}
