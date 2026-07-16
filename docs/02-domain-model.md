# 02 — 도메인 모델

팹 세계를 구성하는 개념과 데이터 모델. 모든 타입은 `src/core/schema/`에 zod로 정의하며
sim/render가 공유한다.

## 1. 공간 구조

```
Fab (220m × 240m, 천장고 9m)
└── Bay (베이, 14×28m 기본) — 그리드 배치 (예: 6행 × 12열)
    ├── Equipment[] (설비 4~8대)
    │   └── Loadport[] (설비당 1~2개, 캐리어 인터페이스)
    ├── ServiceCorridor (전면 통로)
    └── OhtPort (천장 레일 분기점)
Fab-level:
    ├── OhtRailGraph (천장, 높이 7.5m)
    ├── GroundNav (지상 도로/보행 그래프)
    ├── Stocker[] (캐리어 보관소)
    ├── EmergencyExit[] (비상구)
    └── MusterPoint[] (대피 집결지)
```

### Bay
- 속성: `id, row, col, processBand, variant`
- `processBand`: `photo | etch | implant | deposition | cmp` — **색채 코딩의 기준** ([05](05-visual-design.md))
- `variant`: `standard | superbay | buffer | metrology | service-heavy`

### 좌표계
- Three.js 표준: X(폭), Z(깊이), Y(높이). 원점은 팹 중앙 바닥.
- 모든 스키마 좌표는 미터 단위. 레이아웃 JSON이 SSOT — 절차 생성기는 "JSON을 만들어내는 도구"일 뿐, 런타임은 항상 JSON을 읽는다.

## 2. 설비 (Equipment)

10종: `lithography, etcher, cvd, pvd, cmp, implanter, cleaner, furnace, metrology, stocker`

### 상태머신

```
idle ──carrier 도착──▶ loading ──▶ processing ──▶ unloading ──▶ idle
  │                                    │
  └──▶ maintenance (PM 스케줄)          └──▶ error / GAS_LEAK_SOURCE (시나리오)
```

- `processing`은 프로세스 윈도우(타입별 60~600 sim초)를 가지며 진행률을 노출 → 렌더에서 상태등으로 표현.
- 설비는 **가스 유출 시나리오의 발생원**이 될 수 있다 (`hazardCapable: true`).

### Loadport
- 설비 전면의 캐리어 도킹 위치. `reserved | occupied | free` 상태로 반송 예약 관리.

## 3. 이동 개체 (Agents)

| 타입 | 수량(기본) | 속도 | 영역 | 역할 |
|---|---|---|---|---|
| OHT | 160 | 5.0 m/s (레일) | 천장 레일 | 베이 간 캐리어 장거리 반송 |
| AGV | 160 | 1.5 m/s | 지상 도로 | 베이 내/근거리 캐리어 반송 |
| IGV | 8 | 1.7 m/s | 지상 도로 | 대형 자재/특수 반송 |
| Person | 100 | 1.2 m/s | 보행 그래프 | 순회 점검, 설비 작업, PM |
| RobotArm | 18 | 고정 | 베이 내 | 로드포트 캐리어 핸들링 연출 |

### 공통 Agent 모델

```ts
interface Agent {
  id: EntityId
  kind: 'oht' | 'agv' | 'igv' | 'person' | 'arm'
  pose: { x, y, z, yaw }          // PoseBuffer에 존재
  status: 'idle' | 'moving' | 'working' | 'waiting' | 'charging' | 'error'
  emergencyState: EmergencyBehavior   // [07] 참조: normal | halt | yield | evacuate | respond
  mission?: MissionRef
}
```

### OHT (Overhead Hoist Transport)
- 레일 그래프의 세그먼트(kind: `trunk | spine | cross | bay-port | stocker`) 위를 크루즈.
- 물리 모델: accel 1.0 / decel 1.4 m/s², 코너 감속 0.7 m/s, headway 정차거리 5.1m / 목표 8.4m.
- 셀 루프 인셋 1.2m로 인접 루프와 레일 미공유 → 교차 충돌 구조적 배제 (이전 프로젝트 검증됨).
- 호이스트 동작: bay-port에서 정지 → 캐리어 승강(3초 연출) → 출발.

### AGV / IGV
- 지상 도로 그래프에서 A* 경로. 양방향 차선은 레인 오프셋(agv ±1.4m, igv ±0.95m)으로 분리.
- 사람과 교차 시 trafficSystem이 감속/정차 directive 발행 (사람 우선).

### Person
- role: `engineer | operator | responder(방재요원)`
- 행동 트리(단순 상태머신): `patrol → inspect(설비 앞 작업 애니) → walk → idle` 루프.
- 비상 시 evacuate 행동으로 전환 ([07] 참조). GLTF 스키닝 애니메이션: `idle / walk / run / work / collapse`.

## 4. 반송 미션 (Transport Mission)

물류의 기본 단위. 팹이 "살아있어 보이게" 하는 핵심.

```
Mission { id, carrierId, from: Loadport|Stocker, to: Loadport|Stocker, assignee?: AgentId,
          state: queued → assigned → picking → carrying → dropping → done | aborted }
```

- **디스패처(missionSystem)**: 설비가 processing 완료 → 산출 캐리어 반출 미션 생성 →
  가까운 idle 차량에 할당(거리 기반 greedy, 추후 헝가리안 개선 여지).
- 미션 체인이 설비 상태머신과 맞물려 "설비가 일감을 받고, 처리하고, 내보내는" 흐름이 자연 발생.

## 5. 존(Zone)과 안전 모델

- 팹은 존으로 분할: `bay-interior, corridor, transfer-aisle, stocker-area, exit-zone`.
- 각 존은 재난 시 `hazardLevel: safe | warning | danger`를 가진다.
- emergencySystem이 발생원 좌표 기준으로 존 hazard를 갱신 → nav 그래프의 엣지 비용에 반영
  (danger 존 엣지 = 통행 불가, warning = 고비용) → **모든 개체의 경로계획이 자동으로 위험 지역을 회피**.

## 6. 엔티티 저장 방식 (ECS-lite)

- 완전한 ECS 프레임워크는 도입하지 않는다(과설계). 대신:
  - 엔티티 = 정수 id + 타입별 컴포넌트를 `Struct-of-Arrays`(TypedArray)로 저장.
  - pose(x,y,z,yaw,speed)는 PoseBuffer와 동일 레이아웃 → 복사 없이 공유.
  - 시스템은 `(world, dt) => void` 순수 함수. 시스템 파이프라인 순서는 `world.ts`에 명시.
- 파일당 500줄 상한. 초과 조짐이면 시스템 분리가 우선.
