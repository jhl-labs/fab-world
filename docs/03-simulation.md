# 03 — 시뮬레이션 엔진

Worker에서 실행되는 권위(authoritative) 시뮬레이션. Three.js 의존 없는 순수 TypeScript.

## 1. 시간 모델

### 고정 타임스텝 + 배속

```ts
// sim/clock.ts
const SIM_HZ = 60
const FIXED_DT = 1 / SIM_HZ          // 시뮬레이션 시간 기준
let timeScale = 1                    // 0(pause) ~ 16

// Worker 루프 (accumulator 패턴)
onFrame(realDt) {
  accumulator += min(realDt, 0.25) * timeScale
  while (accumulator >= FIXED_DT) {
    world.tick(FIXED_DT)             // 항상 고정 dt — 결정성 보장
    accumulator -= FIXED_DT
  }
}
```

- **배속은 tick 횟수로 구현한다** (dt를 늘리지 않는다). 16×에서도 물리 정확도 동일.
  - 이전 프로젝트는 `dt × timeScale` 방식이라 고배속에서 터널링/스킵 위험이 있었음.
- 16× × 60Hz = 960 tick/s가 예산(틱당 <1ms)을 넘으면: 틱 내부에서 저비용 서브스텝으로
  강등하는 대신, **배속 상한에서 tick rate를 절반(30Hz 기준 dt 2배)으로 완화하는 옵션**을 둔다.
  단, 이 완화는 8× 이상에서만 허용 (저배속 결정성 유지).
- pause = `timeScale 0`. 스텝 실행(1 tick 전진) 디버그 명령 지원.

### 시뮬레이션 시각
- `simTime`(초, 누적)이 유일한 시계. 시나리오 트리거·프로세스 윈도우·dwell 모두 simTime 기준.

## 2. 시스템 파이프라인 (tick 순서)

```
1. scenarioSystem     — 트리거 평가, 액션 실행 (재난 발화 포함)
2. emergencySystem    — 재난 단계 전이, 존 hazard 갱신, 개체 행동 오버라이드
3. equipmentSystem    — 설비 상태머신, 프로세스 윈도우 진행
4. missionSystem      — 미션 생성/할당/상태 전이
5. navSystem          — 경로 요청 처리 (틱당 예산 N건, 큐잉)
6. trafficSystem      — headway/교차 감지 → directive(speedScale, halt) 생성
7. ohtSystem          — 레일 크루즈 적분 (directive 적용)
8. vehicleSystem      — AGV/IGV 경로 추종 적분
9. personSystem       — 사람 행동 상태머신 + 보행 적분
10. poseFlush         — PoseBuffer 백버퍼에 기록, generation++, swap
11. eventFlush        — 누적 이벤트 postMessage (배치)
```

## 3. 경로계획 (nav)

### 3중 그래프
레이아웃 JSON에서 `core/layout`이 빌드 타임에 파생 생성:

| 그래프 | 사용자 | 노드 |
|---|---|---|
| RailGraph | OHT | 레일 세그먼트 교점, bay-port, stocker-port |
| RoadGraph | AGV/IGV | 통로 중심선 격자점, loadport 접근점 |
| WalkGraph | Person | 보행 통로 + 비상구 + 집결지 |

### 알고리즘
- A* (이진 힙). 그래프 노드 수 ~수천 규모이므로 충분히 빠름.
- **엣지 비용 = 거리 × hazard 계수** (safe 1.0 / warning 10 / danger ∞).
  hazard 갱신 시 진행 중 경로는 재계획 큐에 투입 (틱당 최대 20건 — 스파이크 방지).
- 경로 캐시: (from, to, hazardVersion) 키. hazard 버전 바뀌면 무효화.

### 경로 추종 (PathFollower)
- pure-pursuit 유사: 전방 주시점(lookahead)으로 yaw 부드럽게, 코너 감속.
- 도착 판정 반경 0.3m, loadport 정밀 도킹은 마지막 2m 감속 직선 접근.

## 4. 교통 제어 (trafficSystem)

- **공간 해시 그리드** (셀 4m)로 근접 개체 질의 O(1).
- 규칙 (우선순위 순):
  1. 비상 대응 차량/사람(responder)은 최우선 — 타 개체가 yield
  2. 사람 > 차량: 차량은 전방 부채꼴 6m 내 보행자 감지 시 감속, 3m 내 정차
  3. 동종 차량: headway 유지 (전방 5.1m 정차 / 8.4m부터 감속)
  4. 교차점: 먼저 진입한 개체 우선, 티켓(예약) 방식
- 데드락 감지: 상호 대기 60틱 지속 시 우선순위 낮은 쪽 후진/우회 재계획.

## 5. 설비/미션 흐름 (팹이 살아있게)

```
[Stocker] --OHT--> [Bay OhtPort] --하강--> [Loadport] --> Equipment.processing
                                                             │ (프로세스 윈도우)
[Stocker] <--OHT-- [Bay OhtPort] <--상승-- [Loadport] <------┘ 반출 미션 생성
```

- 베이 내 근거리 이동은 AGV 담당 (loadport ↔ loadport).
- 각 설비는 `wip 목표치`를 갖고 missionSystem이 지속적으로 일감을 흘려보냄 →
  개입 없이도 팹 전체가 항상 동작하는 배경 활동(ambient activity) 형성.

## 6. Worker 부트/제어 프로토콜 (`core/protocol.ts`)

```ts
// Main → Worker
{ type: 'init', layout: FabLayout, seed: number, poseSAB: SharedArrayBuffer }
{ type: 'setTimeScale', value: number }        // 0 = pause
{ type: 'loadScenario', scenario: Scenario }
{ type: 'triggerEmergency', kind: 'gasLeak'|'fire'|'medical', at?: Position|EntityId }
{ type: 'command', ... }                        // spawn/despawn/개체 지시

// Worker → Main
{ type: 'ready', entityIndex: EntityMeta[] }    // id→슬롯/타입/이름 매핑
{ type: 'entityDelta', added: EntityMeta[], removed: EntityId[] }
{ type: 'event', events: SimEvent[] }           // 배치. missionDone, phaseChanged, ...
{ type: 'metrics', tickMs, entityCount, ... }   // 1Hz
```

## 7. 테스트 전략

- `sim/`은 DOM 없이 실행 가능 → vitest로 시스템 단위 테스트.
- 필수 테스트:
  - 결정성: 같은 시드로 1000틱 두 번 실행 → pose 완전 일치
  - headway: 선행 차량 정지 시 후행이 5.1m 밖에서 멈춤
  - hazard 회피: danger 존 설정 후 모든 신규 경로가 해당 존 미통과
  - 배속 등가성: 1×로 960틱 == 16×로 실시간 1초 (상태 해시 비교)
  - 데드락 해소: 인위적 상호 대기 구성 후 N틱 내 해소
