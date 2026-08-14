# 01 — 전체 아키텍처

## 1. 기술 스택

| 영역 | 선택 | 사유 |
|---|---|---|
| 언어 | TypeScript 6 (strict) | 타입 안정성 |
| 빌드 | Vite 8 | HMR, worker 번들링 내장 |
| 3D | **Three.js (순수, r185)** | R3F 제외 — 이전 프로젝트에서 React 리렌더와 고빈도 3D 갱신의 충돌로 우회책이 누적됨. 씬 그래프는 명령형으로 직접 관리 |
| UI(HUD) | React 19 + zustand 5 + CSS | 패널/버튼/타임라인 등 저빈도 UI만 담당 |
| 스키마 | zod 4 | 레이아웃·시나리오 JSON 검증, 타입 추론 |
| 테스트 | vitest | 시뮬레이션 코어는 DOM 없이 순수 로직 → 테스트 용이 |
| 스타일 | 단일 CSS (`src/styles/index.css`) | HUD 전용, 런타임 CSS 프레임워크 없음 |

독립 시연은 **서버 없음**으로 동작한다. 이전 프로젝트의 자체 권위 gateway는 폐기하고
시뮬레이션은 브라우저 안의 Web Worker에서 실행한다. 실제 Open-RMF 연계 시에만 ROS/RMF의
버전별 메시지를 정규화하는 얇은 RMF Bridge를 외부 시스템 경계에 둔다. 상세 계약은
[10-humanoid-rmf-demo.md](10-humanoid-rmf-demo.md)를 참조한다.

## 2. 스레드/프로세스 구조

```
┌─────────────────────────── Browser ───────────────────────────┐
│                                                                │
│  ┌── Main Thread ─────────────┐   ┌── Sim Worker ───────────┐  │
│  │  Renderer (Three.js)       │   │  SimWorld (고정 60Hz)   │  │
│  │  - InstancedMesh 갱신      │   │  - 엔티티/시스템(ECS)   │  │
│  │  - LOD / 카메라            │◄──┤  - 경로계획/교통제어    │  │
│  │  - 보간(interpolation)     │   │  - 시나리오 엔진        │  │
│  │  React HUD (저빈도)        │   │  - timeScale 배속       │  │
│  └────────────▲───────────────┘   └───────────▲─────────────┘  │
│               │  SharedArrayBuffer PoseBuffer │                │
│               │  (Float32Array, lock-free)    │                │
│               └───── postMessage: 이벤트/명령(저빈도) ────────┘ │
└────────────────────────────────────────────────────────────────┘
                     ▲
                     │ normalized WebSocket (LIVE)
           Open-RMF / Humanoid Fleet Adapter / RMF Bridge
                     │
                     └── validated RMF trace (REPLAY fallback)
```

### 통신 채널 2종

1. **PoseBuffer (고빈도, 매 tick)** — `SharedArrayBuffer` 기반 `Float32Array`.
   엔티티당 고정 슬롯: `[x, y, z, yaw, animState, speed, flags, ...]` (엔티티당 16 float 예약).
   Worker가 쓰고 메인이 읽는다. 더블 버퍼링 + 세대(generation) 카운터로 tearing 방지.
   - COOP/COEP 헤더 불가 환경 폴백: `postMessage(transferable ArrayBuffer)` 핑퐁.
2. **이벤트/명령 채널 (저빈도)** — `postMessage`.
   - Main → Worker: `setTimeScale`, `pause`, `loadScenario`, `triggerEmergency`, `spawnEntity`...
   - Worker → Main: `entitySpawned/Removed`, `missionCompleted`, `emergencyPhaseChanged`,
     `metrics`, 변경 시 `equipment` 상태 묶음, `log`. 렌더러의 구조 변화와 HUD 갱신에만 사용.

**원칙: 위치는 버퍼로, 사건은 메시지로.**

## 3. 패키지(폴더) 구조

단일 저장소, 단일 앱. 논리 계층은 폴더로 강제한다 (의존 방향: 아래 → 위 금지).

```
fab-world/
├── docs/                     # 본 설계 문서
├── public/
│   └── assets/               # GLTF 모델, 환경맵(HDR)
├── src/
│   ├── core/                 # ★ 공유 커널 — DOM/Three 의존 금지 (worker/main 공용)
│   │   ├── math/             # Vec2/3, 보간, easing, RNG(seeded)
│   │   ├── schema/           # zod: FabLayout, Scenario, 엔티티 타입
│   │   ├── layout/           # 레이아웃 로더 + 파생 그래프 생성 (레일/도로/보행 그래프)
│   │   └── protocol.ts       # Worker↔Main 메시지 타입, PoseBuffer 슬롯 정의
│   ├── sim/                  # ★ 시뮬레이션 — Worker에서 실행, Three 의존 금지
│   │   ├── world.ts          # SimWorld: 엔티티 저장소 + 시스템 파이프라인
│   │   ├── clock.ts          # 고정 타임스텝 + timeScale
│   │   ├── systems/          # 시스템 하나 = 파일 하나 (각 <500줄)
│   │   │   ├── ohtSystem.ts        # 레일 크루즈, headway
│   │   │   ├── vehicleSystem.ts    # AGV/IGV 지상 주행
│   │   │   ├── personSystem.ts     # 사람 행동(순회/작업/대피)
│   │   │   ├── equipmentSystem.ts  # 설비 상태머신, 프로세스 윈도우
│   │   │   ├── missionSystem.ts    # 반송 미션 디스패치/할당
│   │   │   ├── trafficSystem.ts    # 교통 제어(감속/정차 directive)
│   │   │   └── emergencySystem.ts  # 재난 상태머신, 대피 오케스트레이션
│   │   ├── nav/               # A* 경로계획, 그래프 질의, 존(zone) 판정
│   │   ├── scenario/          # 트리거/액션 이벤트 엔진
│   │   └── worker.ts          # Worker 엔트리
│   ├── render/               # ★ 렌더링 — 메인 스레드, sim 내부에 의존 금지(core만)
│   │   ├── engine.ts         # Renderer 셋업, rAF 루프, 품질 프로파일
│   │   ├── world/            # 정적 씬: 바닥/벽/천장/레일/설비 (인스턴싱)
│   │   ├── agents/           # 동적 개체: 차량/사람 (LOD 3단계)
│   │   ├── fx/               # 비상 연출: 가스 볼륨, 화염, 경광등, 사이렌 링
│   │   ├── camera/           # Orbit / Follow / FirstPerson 컨트롤러
│   │   └── interpolate.ts    # PoseBuffer → 화면 보간
│   ├── ui/                   # React HUD (시간 컨트롤, 시나리오 패널, 미니맵, 개체 정보)
│   ├── integrations/rmf/     # Open-RMF Bridge 클라이언트, trace 기록 계약·wall-clock 재생
│   ├── app.tsx               # 부트스트랩: worker 생성, 렌더러/HUD 연결
│   └── main.tsx
├── data/
│   ├── layouts/fab-default.json   # 팹 레이아웃 (SSOT)
│   ├── rmf-traces/                 # 합성 참조 trace; 실제 기록과 UI에서 구분
│   └── scenarios/                 # gas-leak.json, fire.json, medical.json
└── tests/
```

### 의존성 규칙 (lint로 강제)

- `core` → 아무것도 의존하지 않음 (pure TS)
- `sim` → `core`만. **`three` import 금지**
- `render` → `core` + `three`. **`sim` 내부 import 금지** (protocol 통해서만)
- `ui` → `core` + zustand. 렌더러와는 이벤트 버스로만 통신

이 규칙이 이전 프로젝트의 "레이아웃 로직 이중화" 문제를 원천 차단한다:
레이아웃 파싱·그래프 생성은 `core/layout` 한 곳에만 존재하고, sim과 render가 같은 코드를 소비한다.

## 4. 상태 관리 원칙

| 데이터 | 위치 | 갱신 빈도 |
|---|---|---|
| 엔티티 pose (위치/방향/애니상태) | SharedArrayBuffer (store 밖) | 60Hz |
| 엔티티 메타 (id, 타입, 이름, 미션) | Worker 내 SimWorld + 메인의 읽기 미러(Map) | 이벤트 시 |
| UI 상태 (선택 개체, 카메라 모드, 배속, 패널) | zustand store (≤5개) | 사용자 조작 시 |
| 시나리오/비상 단계 | Worker가 SSOT, 이벤트로 HUD에 통지 | 단계 전이 시 |

**zustand에는 매 프레임 바뀌는 값을 절대 넣지 않는다.** 이것이 이전 프로젝트 최대 교훈.

## 5. 결정성(Determinism)

- 시뮬레이션은 고정 타임스텝(60Hz) + 시드 RNG(`core/math/rng.ts`)만 사용.
- `Date.now()`/`Math.random()` 사용 금지 → 같은 시드·같은 시나리오면 항상 같은 결과.
- JSON 시나리오를 로드할 때 Worker는 진행 중이던 월드 상태를 겹쳐 쓰지 않고, 시나리오의
  `seed`로 `SimWorld`를 다시 만든다. RMF 연결 권위와 pose 버퍼는 새 월드에 승계한다.
- 효과: 재현 가능한 데모, 리플레이 기능 확장 여지, 테스트 가능성.

## 6. 성능 목표 (수치 계약)

| 항목 | 목표 |
|---|---|
| 프레임 | 60fps (미들급 GPU), 최저 30fps (내장 GPU, 자동 품질 하향) |
| 개체 수 | OHT 160 + AGV 160 + IGV 8 + 사람 100 + 암 18 ≈ **450대** |
| Draw call | 정적 씬 < 50, 동적 개체 < 100 (인스턴싱 후) |
| Sim tick 비용 | < 8ms @450개체 (Worker 내, 60Hz 유지) |
| 메모리 | PoseBuffer: 1024 슬롯 × 16 float × 4B × 2(더블버퍼) = 128KB |

상세 렌더링 전략은 [04-rendering.md](04-rendering.md) 참조.
