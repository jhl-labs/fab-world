import type { ReactElement } from 'react'
import type { EmergencyKind, Scenario } from '../core/schema'
import type { EntityMeta } from '../core/protocol'
import type { CameraMode } from '../render/camera/controller'
import { useFabStore } from './store'
import { taskNarrative } from './taskNarrative'

interface HudProps {
  scenarios: readonly Scenario[]
  onTimeScale(value: number): void
  onScenario(scenario: Scenario): void
  onEmergency(kind: EmergencyKind): void
  onCamera(mode: CameraMode): void
  onSelect(entity?: EntityMeta): void
  onStep(): void
  onShowcase(): void
  onRiskComparison(): void
  onInspection(): void
  onInjectFailure(): void
}

const scales = [0.5, 1, 2, 4, 8, 16]
const phaseLabel: Record<string, string> = { normal: '정상 가동', detected: '감지', alarm: '경보', response: '대응', evacuation: '대피', allClear: '해제' }
const kindLabel: Record<EmergencyKind, string> = { gasLeak: '가스 유출', fire: '화재', medical: '응급 환자', custom: '사용자 정의' }
const taskLabel = { inspection_round: '설비 점검', gas_isolation: '가스 격리', medical_support: '의료 지원' } as const
const taskStatusLabel = { queued: '대기', assigned: '배정', navigating: '이동', observing: '관찰', interacting: '작업', reporting: '보고', returning: '복귀', completed: '완료', failed: '실패', cancelled: '취소' } as const
const activityLabel = {
  standby: '대기',
  walking: '목적 이동',
  yielding: '동선 양보',
  observing: '현장 관찰',
  manipulating: '물리 작업',
  reporting: '결과 보고',
  safeStop: '안전 정지'
} as const
type ProofState = 'pending' | 'current' | 'complete' | 'failed'

export function Hud(props: HudProps): ReactElement {
  const state = useFabStore()
  const metrics = state.metrics
  const comparison = metrics?.riskComparison
  const comparisonActive = comparison?.active === true
  const comparisonComplete = comparisonActive && comparison?.stage === 'complete'
  const comparisonRunning = comparisonActive && !comparisonComplete
  const humanRun = comparison?.human
  const humanoidRun = comparison?.humanoid
  const currentIsHuman = comparison?.currentMode === 'human' && !humanRun
  const currentIsHumanoid = comparison?.currentMode === 'humanoid' && !humanoidRun
  const humanEntries = humanRun?.humanEntries ?? (currentIsHuman ? comparison?.currentHumanEntries ?? 0 : 0)
  const humanoidEntries = humanoidRun?.humanoidEntries ?? (currentIsHumanoid ? comparison?.currentHumanoidEntries ?? 0 : 0)
  const humanExposure = humanRun?.humanWorkZoneSeconds ??
    (currentIsHuman ? comparison?.currentHumanWorkZoneSeconds ?? 0 : 0)
  const humanoidExposure = humanoidRun?.humanWorkZoneSeconds ??
    (currentIsHumanoid ? comparison?.currentHumanWorkZoneSeconds ?? 0 : 0)
  const sameComparisonTarget =
    humanRun !== undefined &&
    humanoidRun !== undefined &&
    humanRun.sourceEquipmentId === humanoidRun.sourceEquipmentId &&
    humanRun.targetId === humanoidRun.targetId
  const avoidedHumanExposure = Math.max(0, humanExposure - humanoidExposure)
  const comparisonNarrative = comparisonActive
    ? comparison?.stage === 'human-dispatch'
      ? { stage: '동일 조건 A/B · A HUMAN', value: '방재요원이 진입 전 EHS 허가 위치로 이동합니다.' }
      : comparison?.stage === 'human-work'
        ? { stage: '동일 조건 A/B · A HUMAN', value: '방재요원이 직접 위험 작업점에 진입해 수동 밸브를 조작합니다.' }
        : comparison?.stage === 'transition'
          ? { stage: '동일 조건 A/B · RESET', value: '사람 기준선 결과를 보존하고 동일 초기상태를 복원합니다.' }
          : comparison?.stage === 'humanoid-dispatch'
            ? { stage: '동일 조건 A/B · B HUMANOID', value: 'Open-RMF 태스크 모델이 휴머노이드를 동일 밸브로 배정합니다.' }
            : comparison?.stage === 'humanoid-work'
              ? { stage: '동일 조건 A/B · B HUMANOID', value: '사람은 안전 경계에 남고 휴머노이드가 밸브 작업점에 진입합니다.' }
              : { stage: '동일 조건 A/B · VERIFIED', value: `관측 결과: 사람 위험구역 체류 ${avoidedHumanExposure.toFixed(1)} person·sec를 제거했습니다.` }
    : undefined
  const selected = state.entities.find((entity) => entity.id === state.selectedId)
  const activeTask = state.humanoidTasks.find((task) => !['completed', 'failed', 'cancelled'].includes(task.status)) ?? state.humanoidTasks[0]
  const narrative = taskNarrative(activeTask)
  const gasMissionVisible = state.emergencyKind === 'gasLeak' || state.humanoidTasks.some((task) => task.kind === 'gas_isolation')
  const showcaseInspection = state.humanoidTasks.find((task) =>
    task.kind === 'inspection_round' && task.requestedBy === 'showcase'
  )
  const inspectionRobot = showcaseInspection?.robotId
    ? state.entities.find((entity) => entity.id === showcaseInspection.robotId)
    : undefined
  const inspectionCallsign = inspectionRobot?.name.match(/^H\d+/)?.[0] ?? showcaseInspection?.robotId ?? 'RMF'
  const gasTask = state.humanoidTasks.find((task) => task.kind === 'gas_isolation')
  const gasRobot = gasTask?.robotId
    ? state.entities.find((entity) => entity.id === gasTask.robotId)
    : undefined
  const gasCallsign = gasRobot?.name.match(/^H\d+/)?.[0] ?? gasTask?.robotId
  const externalActionAuthority = state.rmfState === 'connected' || state.rmfState === 'replay'
  const actionTelemetryRequired =
    externalActionAuthority &&
    gasTask?.status === 'interacting' &&
    metrics?.gasIsolationVerified !== true
  const actionTelemetryStale =
    actionTelemetryRequired &&
    metrics?.gasActionTelemetryFresh !== true &&
    metrics?.gasActionTelemetryAvailable === true
  const actionPhaseLabel = ({
    approach: '접근',
    contact: '양손 접촉',
    turning: '밸브 회전',
    monitoring: '잔류가스 검지',
    verified: '센서 안정'
  } as Record<string, string>)[metrics?.gasActionTelemetryPhase ?? '']
  const missionProofVisible = !comparisonActive && (gasMissionVisible || showcaseInspection !== undefined)
  const inspectionOriginState: ProofState = gasMissionVisible
    ? 'complete'
    : showcaseInspection && ['failed', 'cancelled'].includes(showcaseInspection.status)
      ? 'failed'
      : showcaseInspection
        ? 'current'
        : 'pending'
  const inspectionOrigin = showcaseInspection
    ? {
        owner: `${inspectionCallsign} / FIELD`,
        label: gasMissionVisible ? '가스 이상 보고' : '설비 현장 점검',
        value: gasMissionVisible
          ? 'RMF 재조율 요청'
          : ['reporting', 'returning', 'completed'].includes(showcaseInspection.status)
            ? '점검 결과 확인'
            : '이상 징후 판별 중'
      }
    : {
        owner: 'FAB SENSOR',
        label: gasMissionVisible ? '가스 이상 감지' : '현장 감지',
        value: gasMissionVisible ? 'RMF 재조율 요청' : '알람 대기'
      }
  const rmfDispatchReady = state.rmfState === 'demo' || state.rmfState === 'replay' || state.rmfState === 'connected'
  const preflight = state.rmfState === 'demo'
    ? { state: 'local', label: 'LOCAL DEMO', detail: '결정적 합성 권위 · 현장 dispatch 없음' }
    : state.rmfState === 'replay'
      ? { state: 'trace', label: 'TRACE READY', detail: state.rmfDetail }
      : state.rmfState === 'connected' && state.rmfBridgeStatus?.status === 'ready'
        ? {
            state: 'ready',
            label: 'LIVE READY',
            detail: `${state.rmfBridgeStatus.robotsPublished}/${state.rmfBridgeStatus.robotsSeen} robot · ` +
              `map 정상 · pose ${state.rmfBridgeStatus.maxPoseAgeMs ?? 0}ms · poll ${state.rmfBridgeStatus.pollLatencyMs}ms`
          }
        : state.rmfState === 'connecting'
          ? { state: 'checking', label: 'CHECKING', detail: state.rmfDetail || 'Bridge readiness 확인 중' }
          : {
              state: 'blocked',
              label: 'DISPATCH BLOCKED',
              detail: state.rmfBridgeStatus?.detail || state.rmfDetail || 'Open-RMF readiness 확인 불가'
            }
  const proofSteps: Array<{ key: string; owner: string; label: string; value: string; state: ProofState }> = [
    {
      key: 'rmf',
      owner: 'OPEN-RMF',
      label: '배정·이동',
      value: metrics?.gasRmfAssigned ? `${gasCallsign ?? '로봇'} 격리 배정` : '배정 대기',
      state: metrics?.gasRmfAssigned ? 'complete' : 'pending'
    },
    {
      key: 'permit',
      owner: 'EHS',
      label: '작업허가',
      value: metrics?.gasWorkPermitRevoked
        ? '허가 철회'
        : (metrics?.gasWorkZonePeople ?? 0) > 0
          ? `작업점 ${metrics?.gasWorkZonePeople ?? 0}명 · 대기`
        : metrics?.gasWorkPermitAuthorized
          ? `${metrics.gasWorkPermitAuthority || 'EHS'} · 작업점 0명`
          : '허가 대기',
      state: metrics?.gasWorkPermitRevoked
        ? 'failed'
        : metrics?.gasWorkPermitAuthorized
          ? 'complete'
          : metrics?.gasRmfAssigned ? 'current' : 'pending'
    },
    {
      key: 'valve',
      owner: 'HUMANOID',
      label: '수동 밸브',
      value: actionTelemetryStale
        ? 'TELEMETRY STALE · 정지'
        : actionTelemetryRequired && !metrics?.gasActionTelemetryAvailable
          ? 'EXECUTOR TELEMETRY 대기'
          : metrics?.gasValveClosed
            ? externalActionAuthority
              ? `폐쇄 ${Math.round((metrics?.gasActionTelemetryValvePosition ?? 1) * 100)}% · executor`
              : '폐쇄 확인'
            : metrics?.gasValveContactConfirmed
              ? externalActionAuthority
                ? `${actionPhaseLabel ?? '손 접촉'} · ${Math.round((metrics?.gasActionTelemetryValvePosition ?? 0) * 100)}%`
                : '손 접촉'
              : '조작 대기',
      state: metrics?.gasValveClosed
        ? 'complete'
        : metrics?.gasTaskFailed || actionTelemetryStale
          ? 'failed'
          : metrics?.gasWorkPermitAuthorized || metrics?.gasValveContactConfirmed ? 'current' : 'pending'
    },
    {
      key: 'sensor',
      owner: 'PLC / GAS',
      label: '잔류 농도',
      value: metrics?.gasIsolationVerified
        ? externalActionAuthority
          ? `${(metrics?.gasActionTelemetryGasPpm ?? 0).toFixed(1)} ppm · 안정`
          : '안정 확인'
        : metrics?.gasSensorMonitoring
          ? externalActionAuthority
            ? `${(metrics?.gasActionTelemetryGasPpm ?? 0).toFixed(1)} ppm · 모니터링`
            : '모니터링'
          : metrics?.gasTaskFailed ? '미확인' : '검증 대기',
      state: metrics?.gasIsolationVerified
        ? 'complete'
        : metrics?.gasTaskFailed
          ? 'failed'
          : metrics?.gasSensorMonitoring || metrics?.gasValveClosed ? 'current' : 'pending'
    }
  ]
  const failureInjectable = state.humanoidTasks.some((task) =>
    task.kind === 'gas_isolation' &&
    ['queued', 'assigned', 'navigating', 'observing', 'interacting'].includes(task.status)
  )
  const entities = [...state.entities].sort((a, b) => {
    if (a.kind === 'humanoid' && b.kind === 'humanoid') return a.index - b.index
    if (a.kind === 'humanoid') return -1
    if (b.kind === 'humanoid') return 1
    return a.index - b.index
  }).slice(0, 30)
  const updateScale = (value: number) => { state.setTimeScale(value); props.onTimeScale(value) }
  return <div className="hud">
    <header className="topbar">
      <div><p className="eyebrow">FABWORLD / HUMANOID OPERATIONS</p><h1>Semiconductor Fab</h1></div>
      <div className={`rmf-state rmf-${state.rmfState}`} role="status" aria-live="polite" aria-atomic="true"><span aria-hidden="true" />OPEN-RMF · {state.rmfState === 'connected' ? 'LIVE' : state.rmfState === 'demo' ? 'DEMO' : state.rmfState.toUpperCase()}</div>
      <div className={`phase phase-${state.phase}`} role="status" aria-live="assertive" aria-atomic="true"><span className="pulse" aria-hidden="true" />{state.emergencyKind ? kindLabel[state.emergencyKind] : 'FAB ONLINE'} · {phaseLabel[state.phase]}</div>
      <div className="stats" data-draw-calls={state.stats?.drawCalls ?? 0} data-tick-ms={state.metrics?.tickMs ?? 0}><span>{state.stats?.fps ?? '—'} FPS</span><span>{state.stats?.drawCalls ?? '—'} DRAW</span><span>{state.metrics?.entityCount ?? 0} ENT</span></div>
    </header>

    <section
      className="scoreboard"
      aria-label="운영 현황"
      data-evacuated={state.metrics?.evacuated ?? 0}
      data-total-evacuees={state.metrics?.totalEvacuees ?? 0}
      data-emergency-elapsed={state.metrics?.emergencyElapsed ?? 0}
      data-held-equipment={state.metrics?.heldEquipment ?? 0}
      data-human-robot-clearances={state.metrics?.humanRobotClearances ?? 0}
    >
      <div><small>대피 완료</small><b>{state.metrics?.evacuated ?? 0}<i>/ {state.metrics?.totalEvacuees ?? 94}</i></b></div>
      <div><small>비상 경과</small><b>{Math.floor(state.metrics?.emergencyElapsed ?? 0)}<i> sec</i></b></div>
      <div><small>안전 대기</small><b>{state.metrics?.haltedRobots ?? 0}<i> robot</i></b></div>
      <div><small>설비 HOLD</small><b>{state.metrics?.heldEquipment ?? 0}<i> tool</i></b></div>
      <div><small>휴머노이드 작업</small><b>{state.metrics?.activeHumanoids ?? 0}<i> active · {state.metrics?.completedHumanoidTasks ?? 0} done</i></b></div>
      <div><small>안전 협업</small><b>{state.metrics?.humanRobotClearances ?? 0}<i> clear</i></b></div>
      <div><small>팹 처리</small><b>{state.metrics?.completedProcesses ?? 0}<i> lot</i></b></div>
    </section>

    <aside className="panel controls" aria-label="시뮬레이션과 카메라 제어">
      <p className="panel-title">시간 제어</p>
      <div className="time-row"><button aria-pressed={state.timeScale === 0} className={state.timeScale === 0 ? 'active' : ''} onClick={() => updateScale(state.timeScale === 0 ? 1 : 0)}>{state.timeScale === 0 ? '▶ 재생' : 'Ⅱ 정지'}</button><button onClick={props.onStep}>+1 tick</button></div>
      <div className="scale-row">{scales.map((scale) => <button key={scale} aria-pressed={state.timeScale === scale} className={state.timeScale === scale ? 'active' : ''} onClick={() => updateScale(scale)}>{scale}×</button>)}</div>
      <p className="sim-clock">SIM {Math.floor(state.metrics?.simTime ?? 0).toString().padStart(4, '0')}s</p>
      <p className="panel-title second">카메라</p>
      <div className="camera-row">{(['orbit', 'follow', 'firstPerson'] as CameraMode[]).map((mode) => <button key={mode} aria-pressed={state.cameraMode === mode} className={state.cameraMode === mode ? 'active' : ''} onClick={() => { state.setCameraMode(mode); props.onCamera(mode) }}>{mode === 'orbit' ? 'Orbit' : mode === 'follow' ? 'Follow' : '1인칭'}</button>)}</div>
    </aside>

    <aside className={`panel mission-panel ${comparisonActive ? 'comparison-active' : ''}`} aria-label="휴머노이드 임무 제어와 안전 증거">
      <p className="panel-title">휴머노이드 목적 기반 데모</p>
      <button className="showcase-button" disabled={!rmfDispatchReady} onClick={props.onShowcase}><strong>▶ 통합 시연 시작</strong><small>{rmfDispatchReady ? '설비 점검 → 이상 감지 → RMF 재배정 → 가스 격리' : 'Open-RMF preflight 통과 후 시작할 수 있습니다.'}</small></button>
      <button
        className="comparison-button"
        disabled={state.rmfState !== 'demo' || comparisonRunning}
        onClick={props.onRiskComparison}
      >
        <strong>{comparisonComplete ? '↻ A/B 실측 완료 · 다시 실행' : comparisonRunning ? '● A/B 실측 진행 중' : '▶ 위험작업 A/B 실측'}</strong>
        <small>{state.rmfState === 'demo'
          ? comparisonComplete
            ? '검증 결과를 유지한 채 동일 조건 비교를 다시 시작할 수 있습니다.'
            : '동일 사고: 방재요원 직접 조작 → 초기화 → 휴머노이드 투입'
          : '동일 초기상태 비교는 LOCAL DEMO에서 실행합니다.'}</small>
      </button>
      <div className={`rmf-preflight preflight-${preflight.state}`} data-preflight={preflight.state} role="status" aria-live="polite" aria-atomic="true">
        <span>RMF PREFLIGHT</span><b>{preflight.label}</b>
        <small className="rmf-detail" title={preflight.detail}>{preflight.detail}</small>
      </div>
      <p className="capability-note">사람용 환경 그대로 · 보행 이동 · 계기 관찰 · 수동 밸브 조작</p>
      <div
        className="purpose-callout"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-task-kind={comparisonActive ? 'risk_comparison' : activeTask?.kind ?? 'none'}
        data-task-status={comparisonActive ? comparison?.stage : activeTask?.status ?? 'idle'}
      >
        <small>{comparisonNarrative?.stage ?? narrative.stage}</small>
        <strong>{comparisonNarrative?.value ?? narrative.value}</strong>
      </div>
      {comparisonActive ? <div
        className={`risk-comparison comparison-${comparison?.stage ?? 'inactive'}`}
        data-comparison-stage={comparison?.stage ?? 'inactive'}
        data-human-verified={humanRun?.verified ?? false}
        data-humanoid-verified={humanoidRun?.verified ?? false}
        data-human-entries={humanEntries}
        data-humanoid-entries={humanoidEntries}
        data-human-exposure-seconds={humanExposure}
        data-humanoid-exposure-seconds={humanoidExposure}
        data-avoided-exposure-seconds={avoidedHumanExposure}
        data-human-isolation-elapsed={humanRun?.isolationElapsed ?? 0}
        data-humanoid-isolation-elapsed={humanoidRun?.isolationElapsed ?? 0}
        data-same-target={sameComparisonTarget}
      >
        <div className="comparison-title">
          <span>동일 조건 관측 A/B</span>
          <b>{comparison?.stage === 'complete' ? 'VERIFIED' : 'RUNNING'}</b>
        </div>
        <small className="comparison-contract">
          seed 20260729 · {humanRun?.targetId ?? comparison?.currentTargetId ?? '동일 밸브'} · 조작/검증 8.2s
        </small>
        <div className="comparison-grid">
          <article className={`${humanRun?.verified ? 'complete' : currentIsHuman ? 'current' : ''}`}>
            <em>A · HUMAN</em>
            <strong>방재요원 직접 조작</strong>
            <span><i>작업점 진입</i><b>{humanEntries}<small>human</small></b></span>
            <span><i>사람 체류</i><b>{humanExposure > 0 ? humanExposure.toFixed(1) : '—'}<small>person·sec</small></b></span>
            <span><i>격리 검증</i><b>{humanRun ? humanRun.isolationElapsed.toFixed(1) : '—'}<small>sec</small></b></span>
          </article>
          <article className={`${humanoidRun?.verified ? 'complete' : currentIsHumanoid ? 'current' : ''}`}>
            <em>B · HUMANOID</em>
            <strong>RMF 태스크 투입</strong>
            <span><i>작업점 진입</i><b>{humanoidEntries}<small>humanoid</small></b></span>
            <span><i>사람 체류</i><b>{humanoidExposure.toFixed(1)}<small>person·sec</small></b></span>
            <span><i>격리 검증</i><b>{humanoidRun ? humanoidRun.isolationElapsed.toFixed(1) : '—'}<small>sec</small></b></span>
          </article>
        </div>
        <p className="comparison-verdict">
          {humanRun && humanoidRun
            ? `위험구역 사람 체류 ${avoidedHumanExposure.toFixed(1)} person·sec 제거`
            : comparison?.stage === 'transition'
              ? 'A 결과 고정 · 같은 초기상태로 B 복원 중'
              : '추정치가 아닌 시뮬레이션 관측값을 기록 중'}
        </p>
      </div> : null}
      <div
        className={`mission-proof ${missionProofVisible ? 'visible' : ''} ${metrics?.gasTaskFailed ? 'failed' : ''} ${actionTelemetryStale ? 'telemetry-stale' : ''} ${comparisonActive ? 'comparison-suppressed' : ''}`}
        data-origin={showcaseInspection ? 'showcase-inspection' : 'site-alarm'}
        data-origin-state={inspectionOriginState}
        data-inspection-robot={showcaseInspection?.robotId ?? ''}
        data-gas-robot={gasTask?.robotId ?? ''}
        data-rmf-assigned={metrics?.gasRmfAssigned ?? false}
        data-permit-authorized={metrics?.gasWorkPermitAuthorized ?? false}
        data-permit-revoked={metrics?.gasWorkPermitRevoked ?? false}
        data-work-zone-clear={metrics?.gasWorkZoneClear ?? false}
        data-work-zone-people={metrics?.gasWorkZonePeople ?? 0}
        data-valve-contact={metrics?.gasValveContactConfirmed ?? false}
        data-valve-closed={metrics?.gasValveClosed ?? false}
        data-sensor-verified={metrics?.gasIsolationVerified ?? false}
        data-action-telemetry-available={metrics?.gasActionTelemetryAvailable ?? false}
        data-action-telemetry-fresh={metrics?.gasActionTelemetryFresh ?? false}
        data-action-telemetry-phase={metrics?.gasActionTelemetryPhase ?? ''}
        data-action-progress={metrics?.gasActionTelemetryProgress ?? 0}
        data-valve-position={metrics?.gasActionTelemetryValvePosition ?? 0}
        data-gas-ppm={metrics?.gasActionTelemetryGasPpm ?? 0}
        data-hand-pose-measured={metrics?.gasActionTelemetryHandPoseMeasured ?? false}
      >
        <div className="mission-proof-title">
          <span>운영 인과 · 안전 증거</span>
          <b>{metrics?.gasTaskFailed
            ? 'FAILED / UNCONTROLLED'
            : state.rmfState === 'connected'
              ? 'LIVE CONTRACT'
              : state.rmfState === 'replay'
                ? 'TRACE EVIDENCE'
                : state.rmfState === 'demo'
                  ? 'SIM PHYSICS'
                  : 'DISPATCH BLOCKED'}</b>
        </div>
        {externalActionAuthority && gasTask ? <div className={`action-telemetry ${actionTelemetryStale ? 'stale' : metrics?.gasActionTelemetryFresh ? 'fresh' : 'waiting'}`}>
          <span>ACTION EXECUTOR</span>
          <b>{actionTelemetryStale
            ? 'STALE / SAFE STOP'
            : metrics?.gasActionTelemetryFresh
              ? `${actionPhaseLabel ?? 'STREAM'} · ${Math.round((metrics?.gasActionTelemetryProgress ?? 0) * 100)}%`
              : 'WAITING FOR MEASURED STATE'}</b>
          <small>{metrics?.gasActionTelemetryFresh
            ? `valve ${Math.round((metrics?.gasActionTelemetryValvePosition ?? 0) * 100)}% · gas ${(metrics?.gasActionTelemetryGasPpm ?? 0).toFixed(1)} ppm · ${metrics?.gasActionTelemetryHandPoseMeasured ? 'MEASURED EE' : 'REFERENCE IK'}`
            : '태스크 시간으로 접촉·회전을 추정하지 않음'}</small>
        </div> : null}
        <div className={`mission-origin ${inspectionOriginState}`}>
          <span><em>{inspectionOrigin.owner}</em><strong>{inspectionOrigin.label}</strong></span>
          <i>→</i>
          <small>{inspectionOrigin.value}</small>
        </div>
        <div className="mission-proof-steps">
          {proofSteps.map((step) => <div className={`proof-step ${step.state}`} data-proof={step.key} key={step.key}>
            <em>{step.owner}</em>
            <i />
            <strong>{step.label}</strong>
            <small title={step.key === 'permit' ? metrics?.gasWorkPermitAuthority : undefined}>{step.value}</small>
          </div>)}
        </div>
      </div>
      <div
        className={`mission-impact ${gasMissionVisible && !comparisonActive ? 'visible' : ''} ${comparisonActive ? 'comparison-suppressed' : ''}`}
        data-hazardous-actions={state.metrics?.hazardousManualActionsDelegated ?? 0}
        data-spotter-clearance={state.metrics?.gasSpotterClearance ?? 0}
        data-work-zone-human-entries={state.metrics?.gasWorkZoneHumanEntries ?? 0}
        data-work-zone-robot-entries={state.metrics?.gasWorkZoneRobotEntries ?? 0}
        data-isolation-elapsed={state.metrics?.gasIsolationElapsed ?? 0}
        data-verified-gates={state.metrics?.verifiedSafetyGates ?? 0}
      >
        <p>검증된 임무 효과</p>
        {gasMissionVisible ? <div>
          <span><small>허가 후 작업점</small><b>{state.metrics?.gasWorkZoneHumanEntries ?? 0} / {state.metrics?.gasWorkZoneRobotEntries ?? 0}<i>human / humanoid</i></b></span>
          <span><small>EHS 허가 권위</small><b>{state.metrics?.gasWorkPermitAuthorized ? state.metrics.gasWorkPermitAuthority || 'EHS' : '—'}<i>permit authority</i></b></span>
          <span><small>검증 후 격리</small><b>{(state.metrics?.gasIsolationElapsed ?? 0) > 0 ? Math.round(state.metrics?.gasIsolationElapsed ?? 0) : '—'}<i>sec · {state.metrics?.verifiedSafetyGates ?? 0}/1 gate</i></b></span>
        </div> : <small>가스 격리 태스크에서 위험 작업 대체 효과를 계측합니다.</small>}
      </div>
      <button className="inspection-button" disabled={!rmfDispatchReady} onClick={props.onInspection}>단일 설비 점검 태스크 요청</button>
      <button className="failure-button" disabled={!failureInjectable} onClick={props.onInjectFailure}>데모: 밸브 조작 실패 주입</button>
      <div className="task-list">
        {state.humanoidTasks.length === 0 ? <p>RMF 태스크 대기 중</p> : state.humanoidTasks.map((task) => <div key={task.id}><span>{taskLabel[task.kind]}</span><b>{taskStatusLabel[task.status]}</b><small>{task.robotId ?? 'dispatcher'}</small></div>)}
      </div>
    </aside>

    <aside className="panel scenarios" aria-label="비상 시나리오 실행">
      <p className="panel-title">비상 상황 단독 시연</p>
      {props.scenarios.map((scenario) => <button className="scenario-button" key={scenario.id} onClick={() => props.onScenario(scenario)}><span>{kindLabel[scenario.kind]}</span><small>{scenario.name}</small></button>)}
      <div className="quick-actions"><button onClick={() => props.onEmergency('gasLeak')}>즉시 가스</button><button onClick={() => props.onEmergency('fire')}>즉시 화재</button><button onClick={() => props.onEmergency('medical')}>즉시 응급</button></div>
    </aside>

    <aside className="panel entity-panel" aria-label="Open-RMF 플릿과 개체 추적">
      <p className="panel-title">Open-RMF 휴머노이드 플릿</p>
      <div className="fleet-board">
        {(state.metrics?.humanoids ?? []).map((robot) => {
          const entity = state.entities.find((candidate) => candidate.id === robot.id)
          const callsign = robot.name.match(/^H\d+/)?.[0] ?? robot.id
          const authority = state.rmfState === 'demo'
            ? 'simulation'
            : state.rmfState === 'replay'
              ? 'trace'
              : robot.rmfControlled
                ? 'rmf'
                : 'unavailable'
          const authorityLabel = authority === 'simulation'
            ? 'SIM'
            : authority === 'trace'
              ? 'TRACE'
              : authority === 'rmf'
                ? 'RMF'
                : 'NO POSE'
          return <button
            key={robot.id}
            className={`${robot.id === selected?.id ? 'active' : ''} fleet-robot fleet-authority-${authority} fleet-robot-${robot.activity === 'safeStop' || robot.status === 'error' ? 'error' : robot.taskId ? 'active' : 'idle'}`}
            data-robot-id={robot.id}
            data-task-id={robot.taskId ?? ''}
            data-authority={authority}
            data-activity={robot.activity}
            aria-pressed={robot.id === selected?.id}
            onClick={() => { state.select(robot.id); props.onSelect(entity) }}
          >
            <span><strong>{callsign}</strong><em>{authorityLabel}</em></span>
            <b>{activityLabel[robot.activity]}</b>
            <small>{Math.round(robot.battery)}% · {robot.taskId ?? 'ready'}{robot.poseAgeMs !== undefined ? ` · ${robot.poseAgeMs}ms` : ''}</small>
          </button>
        })}
      </div>
      <p className="panel-title entity-list-title">개체 추적</p>
      <div className="entity-list">{entities.map((entity) => <button key={entity.id} aria-pressed={entity.id === selected?.id} className={entity.id === selected?.id ? 'active' : ''} onClick={() => { state.select(entity.id); props.onSelect(entity) }}><span className={`entity-dot ${entity.kind}`} aria-hidden="true" />{entity.name}<small>{entity.id}</small></button>)}</div>
    </aside>
    <section className={`log-feed ${state.phase === 'allClear' ? 'log-feed-compact' : ''}`} role="log" aria-label="운영 이벤트" aria-live="polite" aria-relevant="additions text">
      {state.logs.slice(0, state.phase === 'allClear' ? 2 : 8).map((item) =>
        <div key={item.id} className={`log-${item.severity}`}>{item.message}</div>
      )}
    </section>
    <footer className="help">1 Orbit · 2 Follow · 3 1인칭 · Space 정지 · [ / ] 배속 · E 다음 개체 · F 추적</footer>
  </div>
}
