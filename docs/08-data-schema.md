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
    "oht": 160, "agv": 160, "igv": 8, "arm": 18,
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
    "responderFixDuration": 60
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
      "actions": [ { "type": "setPhase", "phase": "allClear" } ] }
  ],
  "cameraCues": [
    { "on": { "phase": "detected" }, "shot": "closeup", "target": "hazard-source", "duration": 3 },
    { "on": { "phase": "alarm" },    "shot": "aerial",  "target": "hazard-zone",   "duration": 5 },
    { "on": { "phase": "evacuation" }, "shot": "follow", "target": "nearest-evacuee", "duration": 8 }
  ]
}
```

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

## 4. 마이그레이션/도구

- `scripts/generate-layout.ts`: 이전 프로젝트의 절차 생성 파라미터(그리드, 베이 배치 규칙)를
  이식해 `fab-default.json`을 생성하는 CLI. **출력은 커밋되는 JSON** — 런타임 절차 생성 없음.
- 추후 2D 에디터를 만들 경우에도 동일한 FabLayout 스키마를 읽고 쓴다 (포맷 분기 금지).
