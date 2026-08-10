# 08 — 데이터 스키마

모든 스키마는 `src/core/schema/`에 zod로 정의. **레이아웃 JSON이 SSOT** —
런타임은 항상 JSON을 로드하며, 절차 생성기는 JSON을 만들어내는 개발 도구일 뿐이다.
(이전 프로젝트의 "절차 생성 로직 이중화 + 에디터 포맷 분리" 문제의 해결책.)

## 1. FabLayout (`data/layouts/*.json`)

```jsonc
{
  "version": "1.0",
  "name": "fab-default",
  "fab": { "width": 220, "depth": 240, "wallHeight": 4.8, "ceilingHeight": 9 },
  "grid": {
    "rows": 6, "cols": 12,
    "columnWidths": [11,12,11,12,11,13,13,11,12,11,12,10],
    "rowDepths": [27,29,30,32,32,30],
    "aisleWidth": 3
  },
  "bays": [
    {
      "id": "bay-0-0", "row": 0, "col": 0,
      "processBand": "photo",          // photo|etch|deposition|implant|cmp
      "variant": "standard",           // standard|superbay|buffer|metrology|service-heavy
      "equipment": [
        {
          "id": "litho-001", "type": "lithography",
          "position": [x, 0, z], "rotation": 0,
          "hazardCapable": true,        // 가스 유출 발생원 후보
          "loadports": [{ "id": "litho-001-lp0", "offset": [dx, 0, dz] }]
        }
      ]
    }
  ],
  "stockers": [{ "id": "stk-01", "position": [x,0,z], "capacity": 24 }],
  "ohtRail": {
    "height": 7.5,
    "segments": [
      { "id": "seg-001", "kind": "trunk",      // trunk|spine|cross|bay-port|stocker
        "from": [x,7.5,z], "to": [x,7.5,z] }
    ]
  },
  "zones": [
    { "id": "zone-bay-0-0", "kind": "bay-interior",   // bay-interior|corridor|transfer-aisle|stocker-area|exit-zone
      "polygon": [[x,z], ...] }
  ],
  "emergency": {
    "exits":  [{ "id": "exit-n1", "position": [x,0,z], "heading": 0 }],
    "musterPoints": [{ "id": "mp-1", "position": [x,0,z], "capacity": 60 }],
    "medicalStation": { "position": [x,0,z] },
    "fireAccessRoutes": [{ "id": "far-1", "nodes": [[x,z], ...] }]
  },
  "population": {                        // 스폰 정의 (개별 나열 대신 개수 기반)
    "oht": 160, "agv": 160, "igv": 8, "humanoid": 2, "arm": 18,
    "humanoidStations": [[-86,0,-97.5], [-86,0,-70.5]], // 역할별 대기 지점
    "responderStations": [                              // 안전 설비 권역별 2인 1조 대기 지점
      [-72,0,-69], [-48,0,-69], [-20,0,-4],
      [20,0,-4], [48,0,66], [72,0,66]
    ],
    "people": [
      { "role": "engineer",  "count": 60 },
      { "role": "operator",  "count": 34 },
      { "role": "responder", "count": 6 }
    ]
  }
}
```

### 파생 데이터 (JSON에 없음 — `core/layout`이 로드 시 생성)
- RailGraph / RoadGraph / WalkGraph (노드·엣지·A* 인덱스)
- 공간 해시, 존 룩업 테이블, loadport ↔ 레일 포트 매핑
- 검증: zod 파싱 + 의미 검증 (설비가 베이 경계 밖, 레일 미연결, 비상구 미도달 존 등은 로드 실패)

## 2. Scenario (`data/scenarios/*.json`)

```jsonc
{
  "version": "1.0",
  "id": "gas-leak-photo-bay",
  "name": "포토 베이 가스 유출",
  "kind": "gasLeak",                    // gasLeak|fire|medical|custom
  "seed": 42,
  "params": {                           // kind별 파라미터 (zod discriminated union)
    "sourceEquipmentId": "litho-001",   // 생략 시 hazardCapable 중 랜덤(시드 기반)
    "spreadRate": 0.4, "maxRadius": 30,
    "responderFixDuration": 60          // fire/custom fallback. gasLeak는 런타임에서 사용하지 않음
  },
  "steps": [
    { "trigger": { "type": "time", "delay": 10 },
      "actions": [ { "type": "setPhase", "phase": "detected" } ] },
    { "trigger": { "type": "phase", "phase": "alarm" },
      "actions": [
        { "type": "overrideBehavior", "selector": "type:person role:!responder", "behavior": "evacuate" },
        { "type": "overrideBehavior", "selector": "type:agv", "behavior": "yield" },
        { "type": "dispatchResponder", "count": 2, "to": "hazard-source" },
        { "type": "hudMessage", "text": "가스 유출 경보 — 전원 대피", "severity": "danger" }
      ] },
    { "trigger": { "type": "all", "conditions": [
        { "type": "phase", "phase": "evacuation" },
        { "type": "populationAt", "zone": "muster", "ratio": 1.0 } ] },
      "actions": [ { "type": "hudMessage", "text": "전원 집결 확인 — 가스 격리 피드백 대기", "severity": "info" } ] }
  ],
  "cameraCues": [
    { "on": { "phase": "detected" }, "shot": "closeup", "target": "hazard-source", "duration": 3 },
    { "on": { "phase": "alarm" },    "shot": "aerial",  "target": "hazard-zone",   "duration": 5 },
    { "on": { "phase": "evacuation" }, "shot": "follow", "target": "nearest-evacuee", "duration": 8 }
  ]
}
```

가스 시나리오의 `allClear`는 JSON 절대 시간이나 인원 집결 action으로 만들지 않는다.
휴머노이드의 밸브 접촉·폐쇄와 센서 안정 확인이 끝난 뒤, 런타임이 전원 집결 대형까지 확인해
전환한다. `responderFixDuration`은 기존 공통 params 호환을 위해 허용하지만 가스 통제에는
사용하지 않는다.

`seed`는 메타데이터가 아니라 실행 계약이다. UI에서 시나리오를 로드하면 Worker가 기존 평시
월드를 폐기하고 이 값으로 동일 레이아웃의 월드를 새로 만든다. 따라서 시나리오 시작 전 배속이나
버튼 클릭 시점이 달라도 초기 사람 배치, 사고 대상, RMF 로컬 배정과 결과 KPI가 동일하다.

### Trigger 타입 (discriminated union, `all`/`any`는 z.lazy 재귀)
`time { delay }` · `phase { phase }` · `entityAt { selector, zone }` ·
`entityState { selector, state }` · `populationAt { zone, ratio }` ·
`all { conditions[] }` · `any { conditions[] }`

### Action 타입
`setPhase` · `spawnHazard` · `overrideBehavior { selector, behavior }` ·
`dispatchResponder` · `dispatchVehicle { type, mission }` · `cameraCue` ·
`hudMessage` · `wait` · `endScenario`

### Selector 문법
공백 구분 AND 조건: `type:agv`, `role:responder`, `role:!responder`(부정), `zone:bay-0-0`, `id:agv-042`

## 3. PoseBuffer 레이아웃 (`core/protocol.ts`)

```
슬롯 크기: 16 float (64B) × MAX_ENTITIES 1024 × 더블버퍼 2
[0..2] x, y, z        [3] yaw           [4] speed
[5] animState(enum)   [6] animPhase     [7] flags(bitfield: selected|hidden|emergency)
[8] auxA (호이스트 높이 / 사람 자세 블렌드)   [9] auxB
[10..15] 예약
헤더(별도 Int32Array): [0] generation, [1] entityCount, [2] frontBufferIndex, [3] simTimeMs
```

- Worker: 백버퍼 기록 → `Atomics.store(frontBufferIndex)` → `Atomics.add(generation)`.
- Main: generation 확인 후 프론트버퍼 읽기. 직전 세대 사본과 보간.

### 임무 효과 메트릭

`SimMetrics`의 `hazardousManualActionsDelegated`, `gasSpotterClearance`,
`gasWorkZoneClear`, `gasWorkZonePeople`, `gasWorkZoneHumanEntries`,
`gasWorkZoneRobotEntries`, `gasIsolationElapsed`, `verifiedSafetyGates`와 아래 proof 필드는
서로 다른 증거 시점에서만 갱신한다.

- 밸브 폐쇄 확인: 위험 수동작업 대체 1건
- 가스 격리 모드의 `gasSpotterClearance`: 현장 안전감시자를 두지 않으므로 항상 `0`; live 모드의
  EHS 허가는 원격 authority 필드로 추적한다.
- 원격 EHS 허가 후 1.5m 작업점 점유: distinct human/humanoid 실제 진입 수. 치명적 가스
  시연의 성공값은 `human=0`, `humanoid=1`이며 추정 절감 인원이 아니다.
- 센서 안정 확인: 격리 소요시간과 `1/1` 안전 게이트
- 실패·취소·후퇴: 위 성공 게이트와 격리 시간은 갱신하지 않음

`gasRmfAssigned`, `gasWorkPermitAuthorized`, `gasWorkPermitRevoked`, `gasWorkZoneClear`,
`gasValveContactConfirmed`, `gasValveClosed`, `gasSensorMonitoring`,
`gasIsolationVerified`, `gasTaskFailed`는 HUD의 책임 주체별 증거 사슬을 구성한다. 성공 문자열이나
경과 시간으로 역산하지 않고, 각각 task runtime의 배정·허가·접촉·폐쇄·검지·센서 플래그를 그대로
전달한다. 실패해도 이미 성립한 앞 단계 증거는 지우지 않고, 미통과 게이트만 실패로 표시한다.

`humanoids[]`는 각 로봇의 `id`, `name`, `battery`, `status`, `activity`, `speed`, 선택적
`taskId`, `rmfControlled`, `poseAgeMs`를 담는 250ms 운영 projection이다. HUD 플릿 보드는
렌더 애니메이션을 역추정하지 않고 이 Worker 상태와 연결 모드를 결합해
`SIM/TRACE/RMF/NO POSE` 권위를 표시한다.

`riskComparison`은 LOCAL DEMO의 순차 A/B projection이다.

- `stage`: `human-dispatch | human-work | transition | humanoid-dispatch | humanoid-work | complete`
- `human`, `humanoid`: 각 실행의 `sourceEquipmentId`, `targetId`, distinct
  `humanEntries`/`humanoidEntries`, `humanWorkZoneSeconds`, `isolationElapsed`,
  `spotterClearance`, `verified`
- `current*`: 진행 중 실행의 진입·person·seconds를 250ms마다 갱신

Worker coordinator는 A 결과를 보존하고 같은 seed의 새 `SimWorld`에서 B를 시작한다. 최종
`avoided exposure`는 schema에 별도 상수로 저장하지 않고 HUD가
`human.humanWorkZoneSeconds - humanoid.humanWorkZoneSeconds`로 계산한다. 따라서 표시 결론과
두 원시 관측값이 어긋날 수 없다. 이 projection은 결정적 비교용이며 LIVE RMF 현장 노출
계측을 의미하지 않는다.

따라서 HUD가 추정 절감액이나 태스크 상태 문자열만으로 효과를 선언하지 않는다.

## 4. RMF 정규화 이벤트

`RmfBridgeEvent`는 `robot_state | task_state | work_permit | action_telemetry | emergency`의
discriminated union이다. 가스 작업허가는 다음처럼 태스크에 결합한다.

```jsonc
{
  "type": "work_permit",
  "taskId": "gas-isolation-1",
  "authorized": true,
  "authorizedBy": "ehs-controller",
  "clearance": 2.4,          // EHS 승인 최소 배제 반경. authorized=true일 때 필수, 2.2~3.4m
  "timestamp": 1785400000000
}
```

`clearance`는 현장 감시자의 위치가 아니라 EHS가 승인한 작업점 배제 반경이다. 철회 이벤트는
`authorized=false`, `reason`을 사용하며 `clearance`를 포함하지 않는다.
브라우저는 이 이벤트를 생성할 수 없고, Bridge의 인증된 EHS ingest가 정규화해 읽기 전용
WebSocket 채널로 보낸다. recorded/reference trace도 같은 이벤트를 보존하고 재생 시 현재
FabWorld task id로 바꾼다.

LIVE/TRACE 가스 물리 작업은 별도 `action_telemetry`가 권위다.

```jsonc
{
  "type": "action_telemetry",
  "taskId": "gas-isolation-1",
  "category": "gas_isolation",
  "robot": "humanoid-002",
  "phase": "turning",
  "progress": 0.65,
  "leftHandContact": true,
  "rightHandContact": true,
  "valvePosition": 0.55,
  "sensorStable": false,
  "handPose": {
    "frame": "base_link",
    "leftPositionM": [0.4195, 1.1549, -0.1934],
    "rightPositionM": [0.4195, 1.2083, 0.1528]
  },
  "timestamp": 1785400000400
}
```

단계는 `approach|contact|turning|monitoring|verified`다. `monitoring/verified`는
`valvePosition=1`과 실제 `gasPpm`을 요구하고, `verified`는 `progress=1`,
`sensorStable=true`까지 요구한다. timestamp·phase·progress·valvePosition은 태스크 안에서
단조 증가해야 한다. Bridge는 유효 EHS 허가와 `interacting` 단계를 확인한 뒤 전용 WebSocket
채널로 전달한다. Worker는 이 값으로 팔과 밸브를 직접 구동하며, 1.5초 이상 샘플이 없으면
현재 자세에서 안전 정지하고 경과시간으로 누락 상태를 보간하지 않는다.

`handPose`는 선택적이지만 포함되면 화면 양팔 자세의 직접 권위가 된다. Fleet Adapter/action
executor가 제조사별 joint/link 좌표를 로봇 `base_link` 기준 `[forward, up, lateral]` 미터로
변환한다. 두 손은 항상 한 쌍으로 보내며, Bridge는 0.31m+0.31m 팔 도달 범위를 검사한다.
접촉을 보고한 샘플은 좌우 손이 각자 올바른 측면에 있고 밸브 전면·링 중심선 잔차가 8cm
이하여야 한다. 누락 시 HUD는 `REFERENCE IK`, 포함 시 `MEASURED EE`로 출처를 명시한다.
선택 필드이므로 기존 executor와의 호환성은 유지하지만, 현장 사실성 수용시험은 measured
좌표를 필수로 취급한다.

`task_state.interactionKind`의 책임 증거는 category·stage와 결합한다.

- `inspection_anomaly_reported`: `inspection_round/reporting`에서만 이상 사건을 시작
- `medical_handoff`: `medical_support/interacting`에서만 실물 소유권 이전
- `gas_isolation_verified`: `gas_isolation/interacting`, 유효한 원격 EHS 허가,
  fresh `verified` action telemetry, 1.5m 작업점 인원 0명 뒤에만 위험 통제. 침범 또는
  텔레메트리 단절 시 local/live 모두 조작·완료 콜백 거절

따라서 일반 inspection `reporting`은 정상 보고이며 가스 사건을 만들지 않는다.

## 5. 마이그레이션/도구

- `scripts/generate-layout.ts`: 이전 프로젝트의 절차 생성 파라미터(그리드, 베이 배치 규칙)를
  이식해 `fab-default.json`을 생성하는 CLI. **출력은 커밋되는 JSON** — 런타임 절차 생성 없음.
- 추후 2D 에디터를 만들 경우에도 동일한 FabLayout 스키마를 읽고 쓴다 (포맷 분기 금지).
