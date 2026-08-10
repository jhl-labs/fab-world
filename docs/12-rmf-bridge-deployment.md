# 12 — Open-RMF Bridge 배포·연계 런북

## 1. 범위와 안전 경계

`services/rmf-bridge`는 FabWorld 브라우저와 RMF-Web 사이에서 태스크·pose·비상 이벤트를
정규화하는 실행 가능한 참조 Bridge다. 브라우저가 RMF-Web 내부 소켓에 직접 의존하지 않게 하고,
현재 공개 REST API만 사용한다.

이 Bridge와 FabWorld는 **시연·관측 계층**이다. 로봇의 E-stop, 안전 PLC, 출입 인터록,
속도 제한과 실제 위험 구역 진입 허가는 Fleet Adapter·로봇 제어기·현장 안전 시스템이
권위자로 남아야 한다.

```text
FabWorld ── WebSocket ── RMF Bridge ── REST ── RMF-Web ── Open-RMF
          work_permit ▲        ▲                         │
                      │        └── action/emergency ─────┘
                 EHS gateway       stage callback
```

참조 구현은 Open-RMF의 공식 연계 모델과 현재 rmf-web API를 기준으로 한다.

- [Open-RMF interfacing guide](https://openrmf.readthedocs.io/en/latest/interfacing/index.html)
- [rmf-web API server](https://github.com/open-rmf/rmf-web)
- [rmf_ros2 Fleet Adapter](https://github.com/open-rmf/rmf_ros2)
- [rmf_demos](https://github.com/open-rmf/rmf_demos)

## 2. 사전 조건

- Node.js 22 이상
- 실행 중인 RMF-Web API 서버
- `fab_humanoid_fleet`과 휴머노이드 Fleet Adapter
- RMF level 이름과 FabWorld map 이름 사이의 좌표 캘리브레이션
- 실제 RMF navigation graph의 waypoint 이름·좌표와 작업 접근점별 허용 반경
- `inspection_round`, `gas_isolation`, `medical_support`를 수락하고 실행하는
  `perform_action` 구현

현재 Bridge가 호출하는 RMF-Web 공개 경계는 다음과 같다.

| 용도 | RMF-Web API |
|---|---|
| fleet/pose | `GET /fleets/{fleet}/state` |
| task 상태 | `GET /tasks?task_id=id1,id2` |
| task 배정 | `POST /tasks/dispatch_task` |
| task 취소 | `POST /tasks/cancel_task` |
| 화재 알람 | `GET /building_map/previous_fire_alarm_trigger` |

`/_internal`은 Fleet Adapter와 rmf-web 사이의 내부 경계이므로 FabWorld에서 사용하지 않는다.

## 3. Bridge 설정과 실행

예제 파일을 복사해 URL, fleet, origin과 map 변환을 수정한다.

```bash
cp services/rmf-bridge/config.example.json rmf-bridge.local.json

RMF_BRIDGE_CONFIG="$PWD/rmf-bridge.local.json" \
RMF_API_TOKEN="<rmf-web bearer token>" \
FABWORLD_BRIDGE_TOKEN="<16자 이상의 browser token>" \
RMF_INGEST_TOKEN="<16자 이상의 adapter callback token>" \
npm run bridge:rmf
```

토큰은 저장소나 JSON에 커밋하지 않고 환경 변수 또는 secret manager로 주입한다. 주요 설정은
다음 환경 변수로도 덮어쓸 수 있다.

| 변수 | 의미 | 기본값 |
|---|---|---|
| `RMF_API_URL` | RMF-Web base URL | `http://127.0.0.1:8000` |
| `RMF_FLEET_NAME` | 휴머노이드 fleet | `fab_humanoid_fleet` |
| `RMF_BRIDGE_HOST/PORT/PATH` | Bridge listen 주소 | `127.0.0.1:4190/fabworld` |
| `RMF_POLL_MS` | RMF 상태 폴링 주기 | `250` |
| `RMF_ALLOWED_ORIGINS` | 허용 브라우저 origin, 쉼표 구분 | 빈 배열 |
| `RMF_MAP_NAME`, `FABWORLD_MAP_NAME` | 입력/출력 map 이름 | `fab-L1` |
| `RMF_MAP_OFFSET_X/Z`, `RMF_MAP_YAW`, `RMF_MAP_SCALE` | 2D similarity transform | `0, 0, 0, 1` |

브라우저 빌드의 `VITE_FAB_MAP_NAME`도 `maps.*.fabMap` 중 하나와 일치해야 한다(기본
`fab-L1`). Worker가 해석한 접근점은 이 FabWorld map으로 전송되고 Bridge가 아래 보정식의
역변환으로 RMF `(map,x,y,yaw)`를 만든다. 같은 `fabMap`을 가리키는 RMF map이 둘 이상이면
임의 선택하지 않으므로, 층별 FabWorld map 이름을 고유하게 정한다.

`navigationWaypoints`에는 실제 RMF navigation graph의 waypoint와 그 RMF 좌표를 등록한다.
Bridge는 역변환한 작업 접근점과 같은 map에서 가장 가까운 waypoint를 찾고, 그 거리와
`maxDistance`를 비교한다.

```jsonc
{
  "navigationWaypoints": [
    {
      "map": "L1",
      "waypoint": "inspection_northwest",
      "x": -82.7,
      "y": -85.1,
      "maxDistance": 4
    }
  ]
}
```

예제 설정의 `demo_*` 이름은 샘플일 뿐이다. 현장 graph에 존재하는 이름 또는 0 이상의 waypoint
index로 교체해야 한다. map에 후보가 없거나, 최근접점이 허용 반경 밖이거나, 두 후보가 같은
거리이면 Bridge는 각각 `target_waypoint_unmapped/ambiguous`로 거절한다. 따라서 잘못된
waypoint를 임의로 골라 “RMF가 이동을 조율했다”고 표시하지 않는다.

상태 확인:

```bash
curl -fsS http://127.0.0.1:4190/healthz
curl -fsS http://127.0.0.1:4190/readyz
```

`healthz`는 프로세스 생존 여부다. `readyz`는 최근 RMF-Web 폴링 성공뿐 아니라 모든 fleet
robot pose가 등록된 map과 유효한 location으로 정규화되는지도 검사한다. 오케스트레이터는
각각 liveness/readiness probe로 사용한다.

| Bridge 상태 | 조건 | 화면 동작 |
|---|---|---|
| `ready` | RMF poll 성공, map/location/pose age 정상 | `LIVE READY`, pose와 task 반영, 새 dispatch 허용 |
| `degraded` | 미등록 map, location 누락 또는 1.5초 초과 pose | 원인·`DISPATCH BLOCKED`, 외부 로봇 `safeStop`, 새 dispatch 0건 |
| `offline` | RMF-Web poll 실패 | 원인·`DISPATCH BLOCKED`, 외부 로봇 `safeStop`, 새 dispatch 0건 |

WebSocket의 `bridge_status`와 `/readyz` 응답의 `diagnostics`에는 `robotsSeen`, `robotsPublished`,
`unknownMaps`, `robotsWithoutLocation`, `pollLatencyMs`, `maxPoseAgeMs`와 최근
`actionStageLatencyMs`가 포함된다. 현장에서는 `robotsSeen === robotsPublished`를 기본 게이트로
사용한다. 문제가 해소되면 다음 poll에서 자동으로 `ready`와 `LIVE`로 복구한다.

브라우저는 소켓 연결 직후에도 첫 `bridge_status=ready`까지 태스크를 보류한다. `degraded`나
`offline`을 받으면 보류 요청을 실패로 종결하고, 이미 전송 중인 요청에는 취소를 보낸다.
Bridge 서버는 별도로 같은 readiness를 검사해 `bridge_not_ready`로 거절하므로 UI 우회나
경합으로 RMF-Web dispatch가 발생하지 않는다. RMF-Web 응답 대기 중 readiness가 해제되면
반환된 booking을 취소하고 상관관계에 등록하지 않는다.

FabWorld는 실행 시 쿼리로 Bridge를 선택할 수 있다.

```text
http://localhost:5173/?rmf=ws%3A%2F%2F127.0.0.1%3A4190%2Ffabworld%3Ftoken%3D...
```

고정 시연 환경은 `VITE_RMF_BRIDGE_URL`로 빌드할 수도 있다. 공개 배포에서는 정적 번들에 장기
토큰을 넣지 말고, TLS reverse proxy가 짧은 수명의 접속 자격을 검증하도록 구성한다.
HUD의 연결 상세에는 URL의 query, fragment, user info를 제거한 endpoint만 표시한다. 다만
`?token=...` 방식 자체는 브라우저 방문 기록과 reverse proxy 로그에 남을 수 있으므로 현장에서는
짧은 수명의 자격 또는 proxy가 검증하는 쿠키/헤더 기반 접속을 사용한다.

Bridge가 loopback 이외의 인터페이스(`0.0.0.0` 포함)에 바인딩될 때는 시작 시
`FABWORLD_BRIDGE_TOKEN`과 하나 이상의 `RMF_ALLOWED_ORIGINS`를 모두 강제한다. 예제 설정은
외부 바인딩이므로 두 값을 환경 변수로 주지 않으면 의도적으로 기동에 실패한다. Origin 검사는
인증을 대체하지 않으며, 운영에서는 TLS와 네트워크 정책으로 `/healthz`, `/readyz` 접근 범위도
제한한다.

### 3.1 현장 trace 기록과 폴백 재생

Bridge가 보내는 정규화 이벤트는 category별 재생 template로 기록할 수 있다. 기록 중 실제
`inspection_round`, `gas_isolation`, `medical_support`를 배정하면 같은 category에서 완료
이벤트와 pose가 가장 많이 포함된 실행을 선택한다.

```bash
npm run record:rmf -- \
  'wss://bridge.example/fabworld?token=...' \
  ./private/site-rmf-trace.json \
  --duration 120 \
  --name 'Site acceptance 2026-07-30'
```

기록 파일에는 현장 좌표, robot/task id와 운영 순서가 포함되므로 소스 저장소에 커밋하지 않고
실제 운영 데이터와 같은 접근 제어를 적용한다. 정적 호스트에 배치한 뒤 CORS를 허용하고
`?rmfTrace=https://secure.example/site-rmf-trace.json` 또는 `VITE_RMF_TRACE_URL`로 선택한다.
trace 설정은 Bridge URL보다 우선한다.

내장 `?rmfTrace=reference`는 합성 검증 데이터다. HUD는 이를 `REPLAY · REFERENCE TRACE`,
recorder 출력은 `REPLAY · RECORDED TRACE`, 실제 Bridge는 `LIVE`로 표시한다. 재생도 source
timestamp 순서, 1.5초 pose watchdog, task 단계 권위와 wall-clock 보간을 그대로 사용하므로
시뮬레이션 16×나 일시정지가 로봇 궤적을 바꾸지 않는다.

## 4. Fleet Adapter 작업 계약

Bridge는 FabWorld 요청을 공식 `compose` 태스크 안의 `go_to_place → perform_action` 두 phase로
변환한다. `go_to_place`는 등록된 RMF navigation waypoint까지의 교통 일정·경로 충돌 조정을
RMF에 맡긴다. 이어지는 `perform_action` 실행기는 action description의 정밀 `target_pose`까지
로컬 안전 제어로 접근한 후 관찰·조작·인계를 수행한다.

Fleet Adapter는 세 category를 `add_performable_action`으로 등록하고, 중첩된
`description.fabworld_task_id`를 상관관계 키로 보존한다. 같은 description의 `target_id`는
업무 대상이고 `target_pose`는 Bridge가 역보정한 실제 RMF map 좌표,
`navigation_waypoint`는 앞 phase에서 사용한 graph waypoint다.

```jsonc
{
  "category": "compose",
  "description": {
    "phases": [
      {
        "activity": {
          "category": "go_to_place",
          "description": { "waypoint": "inspection_northwest" }
        }
      },
      {
        "activity": {
          "category": "perform_action",
          "description": {
            "category": "inspection_round",
            "description": {
              "fabworld_task_id": "inspection-42",
              "target_id": "lithography-001",
              "target_pose": { "map": "L1", "x": -82.7, "y": -85.1 },
              "navigation_waypoint": "inspection_northwest"
            }
          }
        }
      }
    ]
  }
}
```

이 형태는 공식 [`compose` task schema](https://github.com/open-rmf/rmf_ros2/blob/main/rmf_fleet_adapter/schemas/task_description__compose.json),
[`go_to_place` event schema](https://github.com/open-rmf/rmf_ros2/blob/main/rmf_fleet_adapter/schemas/event_description__go_to_place.json),
[`place` schema](https://github.com/open-rmf/rmf_ros2/blob/main/rmf_fleet_adapter/schemas/place.json)와
[`perform_action` event schema](https://github.com/open-rmf/rmf_ros2/blob/main/rmf_fleet_adapter/schemas/event_description__perform_action.json)를
따른다. 공식 `place`는 임의 좌표가 아니라 waypoint 이름 또는 index를 받기 때문에
`target_pose`만 전달해서는 RMF가 그 이동을 스케줄했다고 간주하지 않는다.

| category | 물리적 의미 | 완료 조건 |
|---|---|---|
| `inspection_round` | 설비 전면 정밀 접근, 다각도 관찰, 패널 확인 | 점검 결과 보고 |
| `gas_isolation` | 원격 EHS 작업허가와 무인 작업구역 확인 뒤 서비스 면 0.75m pose에서 격리 밸브 조작 | 1.5m 작업점 사람 0명, 5cm 위치·밸브 방향 yaw, 밸브 피드백과 누출 제어 확인 |
| `medical_support` | 구급 물품 운반, responder 작업 공간 지원 | 인계 확인 |

로봇 실행기는 아래 단계를 실제 행동 전환 시점에 Bridge로 보낸다.

```text
assigned → navigating → observing → interacting → reporting
         → returning → completed
```

점검의 `reporting`은 정상 결과도 포함하므로 그 자체는 재난 신호가 아니다. 현장 계기·설비
상태에서 이상이 실제로 확인된 경우에만 action executor가 같은 reporting 단계에 명시적
증거를 붙인다.

```bash
curl -X POST http://127.0.0.1:4190/ingest/action-stage \
  -H "Authorization: Bearer $RMF_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fabworld_task_id": "inspection-42",
    "stage": "reporting",
    "interaction_kind": "inspection_anomaly_reported",
    "robot": "humanoid-001"
  }'
```

`inspection_anomaly_reported`는 `inspection_round/reporting` 조합에서만 허용한다. 일반
`reporting` callback은 점검 태스크를 보고 단계로만 바꾸고 가스 사건이나 후속 격리 태스크를
만들지 않는다. 로컬/reference 시연은 같은 명시적 이벤트를 생성하므로 live와 인과 계약이 같다.

```bash
curl -X POST http://127.0.0.1:4190/ingest/action-stage \
  -H "Authorization: Bearer $RMF_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fabworld_task_id": "medical-support-1",
    "stage": "interacting",
    "interaction_kind": "medical_handoff",
    "robot": "humanoid-002"
  }'
```

`rmf_task_id`도 사용할 수 있다. 세부 단계 콜백이 시작되면 그 task의 비종료 단계는 일반 RMF
상태 추정보다 우선한다. RMF가 `completed`, `failed`, `canceled`를 보고하면 종결 상태는 다시
RMF가 권위를 가진다. `interaction_kind=medical_handoff`는 실제 키트 전달이 확인된
`interacting` 콜백에만 넣는다. FabWorld는 이 확인 전에는 외부 제어 로봇의 키트를 구조요원에게
옮기지 않으며, 확인 후 로봇·구조요원·환자 3자 카메라 이벤트를 발생시킨다.

가스 격리는 실행기의 단계 전환만으로 통제되지 않는다. 밸브가 폐쇄 위치에 도달했고 현장 가스
센서가 안정 범위에 들어온 것을 실제 PLC/센서 피드백으로 확인한 뒤 아래 콜백을 보낸다.

로컬 결정적 데모는 1.5m 작업점이 비어 있는지 확인할 때까지 `observing`에서 기다린다.
live RMF에서는 화면상 상태로 허가를 자동 생성하지 않는다. EHS gateway가 `observing` 단계의
가스 태스크에 아래의 인증된 작업허가를 보내야
`work_permit` 이벤트가 브라우저에 전달된다.

```bash
curl -X POST http://127.0.0.1:4190/ingest/work-permit \
  -H "Authorization: Bearer $RMF_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fabworld_task_id": "gas-isolation-1",
    "authorized": true,
    "authorized_by": "ehs-controller",
    "clearance_m": 2.4
  }'
```

`clearance_m`는 현장 인원의 위치가 아니라 EHS가 승인한 작업점 최소 배제 반경이다. 2.2~3.4m만
허용하며, 허가는 `gas_isolation`의 `observing` 단계에서만 발급할 수 있다. 태스크 종류·FabWorld/RMF
id 상관관계·종결 여부가 맞지 않으면 Bridge는 HTTP 409로 거절한다. 같은 태스크의 이전 허가보다
오래된 `timestamp`도 수용하지 않는다.

action executor는 팔을 움직이기 직전에 브라우저 이벤트가 아닌 아래 서버 조회를 사용한다.

```bash
curl -fsS \
  -H "Authorization: Bearer $RMF_INGEST_TOKEN" \
  http://127.0.0.1:4190/action-permits/gas-isolation-1
```

응답의 `authorized=true`만 조작 허가다. 미발급은 `state=pending`, 철회는 `state=revoked`,
`reporting/returning`으로 작업 구간을 벗어났거나 종결된 태스크는 `state=expired`이며 모두
`authorized=false`다. Bridge도 현재 허가가 없으면
가스 태스크의 `stage=interacting`과 `gas_isolation_verified` 콜백을
`work_permit_required`로 거절한다. 다만 Bridge가 로봇 제어기를 직접 멈추는 것은 아니므로,
Fleet Adapter/action executor가 이 조회를 실제 팔 제어 인터록으로 구현해야 한다.

허가 확인 뒤 실행기는 먼저 `action-stage`를 `interacting`으로 전환하고, 물리 작업 중
`/ingest/action-telemetry`를 1.5초보다 짧은 주기로 보낸다. 이 스트림이 LIVE/TRACE 팔과
밸브의 유일한 외부 권위다.

```bash
curl -X POST http://127.0.0.1:4190/ingest/action-telemetry \
  -H "Authorization: Bearer $RMF_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fabworld_task_id": "gas-isolation-1",
    "robot": "humanoid-002",
    "phase": "turning",
    "progress": 0.65,
    "left_hand_contact": true,
    "right_hand_contact": true,
    "valve_position": 0.55,
    "sensor_stable": false,
    "hand_pose": {
      "frame_id": "base_link",
      "left_position_m": [0.4195, 1.1549, -0.1934],
      "right_position_m": [0.4195, 1.2083, 0.1528]
    },
    "timestamp": 1785400000400
  }'
```

단계는 `approach → contact → turning → monitoring → verified` 순서이고 timestamp,
`progress`, `valve_position`은 감소할 수 없다. `contact/turning`은 양손 접촉을,
`monitoring/verified`는 폐쇄 위치와 `gas_ppm`을 요구한다. 마지막 `verified`는
`progress=1`, `valve_position=1`, `sensor_stable=true`여야 한다. task/category/robot,
현재 `interacting`, EHS 허가가 맞지 않거나 샘플이 역행하면 400/409다. 스트림이 1.5초
끊기면 화면은 마지막 관절·밸브 상태에서 safe-stop하며 task 시간으로 진행률을 만들지 않는다.

`hand_pose`는 executor가 계산한 선택적 렌더링 증거다. `frame_id`는 현재 `base_link`만
허용하며 좌표 순서는 로봇 전방·상방·측방 축의 미터 단위다. 로봇별 관절 이름과 URDF
링크는 Fleet Adapter에서 이 공통 좌표로 변환한다. 두 손은 함께 제공해야 하며 팔 도달 범위를
넘을 수 없다. `left_hand_contact/right_hand_contact=true`이면 각 손이 자기 측 밸브 링과
전면에서 8cm 안에 있어야 한다. 유효 measured 좌표는 HUD의 `MEASURED EE`와 양팔 IK를 직접
구동한다. 필드가 없으면 진행률 기반 참조 동작은 `REFERENCE IK`로 명시된다.

허가 철회는 다음처럼 별도 감사 이벤트로 남긴다.

```bash
curl -X POST http://127.0.0.1:4190/ingest/work-permit \
  -H "Authorization: Bearer $RMF_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fabworld_task_id": "gas-isolation-1",
    "authorized": false,
    "authorized_by": "ehs-controller",
    "reason": "residual gas rise"
  }'
```

FabWorld는 허가 없는 live `interacting` 상태를 태스크 권위 기록으로는 보존하되, 휴머노이드의
팔 조작 애니메이션은 보여주지 않는다. 외부 허가 뒤에도 action telemetry가 오기 전에는
`WAITING FOR MEASURED STATE`로 남는다. EHS 승인자, 무인 작업구역, executor 진행률과
센서값을 서로 다른 권위로 표시한다. 화면 애니메이션 자체를 실기 안전 인터록으로
사용해서는 안 된다.

로컬 데모의 실패 주입은 로봇에게 후퇴점을 배정하지만, live RMF pose 권위 로봇을 FabWorld가
임의로 이동시키지는 않는다. 실기 실패 시 action executor가 팔을
안전 자세로 복귀시키고 Fleet Adapter/RMF가 후퇴 경로를 스케줄링한 뒤 `failed`를 보고해야
한다. 통신이 끊긴 경우에는 화면과 실기 모두 현재 위치 safe-stop을 우선하며 로컬 추정
후퇴로 대체하지 않는다.

```bash
curl -X POST http://127.0.0.1:4190/ingest/action-stage \
  -H "Authorization: Bearer $RMF_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fabworld_task_id": "gas-isolation-1",
    "stage": "interacting",
    "interaction_kind": "gas_isolation_verified",
    "robot": "humanoid-002"
  }'
```

Bridge는 `inspection_anomaly_reported`를 점검/reporting에, `medical_handoff`를
의료/interacting에, `gas_isolation_verified`를 가스 격리/interacting에만 허용하며 category나
stage가 맞지 않으면 HTTP 400/409로 거절한다. 가스 확인은 1.5초 안에 수신한 `verified`
action telemetry가 없으면 `verified_action_telemetry_required`로 거절한다. FabWorld는 후자의
확인 전에는 위험원 통제나 all-clear를 허용하지 않는다.

화재는 RMF-Web fire alarm을 자동 폴링한다. 가스·의료 이벤트는 현장 이벤트 게이트웨이 또는
시연 오케스트레이터가 명시적으로 전달한다.

```bash
curl -X POST http://127.0.0.1:4190/ingest/emergency \
  -H "Authorization: Bearer $RMF_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active":true,"kind":"gasLeak"}'
```

## 5. 좌표 캘리브레이션

RMF `(x, y)`는 FabWorld 바닥 `(X, Z)`로 다음과 같이 변환한다.

```text
X = offsetX + scale × (cos(yaw) × x - sin(yaw) × y)
Z = offsetZ + scale × (sin(yaw) × x + cos(yaw) × y)
heading = rmfYaw + yaw
```

태스크 목표는 같은 식의 역변환을 사용한다.

```text
dx = (X - offsetX) / scale
dz = (Z - offsetZ) / scale
x =  cos(yaw) × dx + sin(yaw) × dz
y = -sin(yaw) × dx + cos(yaw) × dz
```

도면 숫자만 복사하지 말고, 현장에서 같은 물리 지점의 RMF `(x,y)`와 FabWorld `(X,Z)`를
측정한다. 예제 파일을 복사해 서로 일직선이 아닌 기준점 3개 이상, 권장 4~6개를 입력한다.

```bash
cp services/rmf-bridge/calibration.example.json rmf-calibration.local.json

npm run calibrate:rmf -- rmf-calibration.local.json --max-error 0.25
```

도구는 최소제곱 2D similarity transform을 계산해 `maps` 설정 조각과 품질을 출력한다.

- `pointSpan`: 가장 먼 RMF 기준점 거리. 팹의 양 축을 가로지르도록 충분히 크게 잡는다.
- `geometryRatio`: 2D 분포 품질. `0.01` 미만인 사실상 공선 배치는 거부한다.
- `rmsError`: 전체 기준점의 평균적인 위치 오차.
- `maxError`: 가장 나쁜 기준점 오차. 기본 게이트 `0.25m`를 넘으면 명령이 실패한다.
- `residuals`: 지점별 예측 위치·측정 위치·오차. 오기입 또는 잘못 짚은 마커를 찾는 데 사용한다.

출력의 `maps.L1`을 Bridge 설정에 복사한 뒤, 계산에 사용하지 않은 통로 중심·설비 작업점·안전
지점에서도 독립 검증한다. 시연 전 게이트는 정지 pose 오차, 이동 방향, level 이름, 180° 축
반전 여부를 각각 확인하는 것이다. 측정 오차 허용치는 로봇 footprint와 현장 안전 여유를 기준으로
더 엄격하게 조정할 수 있다.

## 6. 보안·복구 규칙

- 외부 구간은 `https/wss`로 종료하고 RMF-Web과 Bridge는 사설망에 둔다.
- browser token과 adapter ingest token을 분리하고, origin allowlist를 설정한다.
- WebSocket 입력은 64KiB, ingest는 16KiB로 제한되며 zod 스키마 검증과 rate limit을 거친다.
- 작업허가 발급·철회·조회는 browser token이 아닌 adapter ingest token으로만 가능하다.
  브라우저 WebSocket에는 허가 이벤트를 읽는 기능만 있고 허가를 생성하는 명령은 없다.
- 동일 `fabworld_task_id` 재전송은 새 RMF 태스크를 만들지 않는다.
- RMF가 다른 FabWorld 태스크에 이미 연결된 booking id를 다시 반환하면 Bridge는 상관관계를
  덮어쓰지 않고 `rmf_booking_collision`을 반환하며 `/readyz=503`, `degraded`로 전환한다.
- 브라우저가 재연결되면 미확정 요청을 같은 id로 다시 전송한다.
- 브라우저가 구독하면 Bridge가 보유한 현재 비상 상태와 태스크별 최대 64개의 권위 이력을 즉시
  스냅샷으로 보낸다. 이력은 최초 사건, 단계·상호작용·허가 상태별 최신 증거와 최근 전이를
  우선 보존한다. 따라서 브라우저 새로고침·WebSocket 재접속은 다음 RMF 단계 변화가 없어도
  진행·완료 태스크와 EHS/PLC 증거를 복구하며 새 booking을 생성하지 않는다.
- 스냅샷 이벤트는 `snapshot=true`로 구분한다. 화면은 상태와 증거만 재구성하고 과거 로그,
  자동 카메라 cue, 알림을 새 활동처럼 반복하지 않는다. 타임스탬프만 달라진 동일 RMF 상태도
  새 전이로 재발행하지 않는다.
- Bridge 또는 pose 연결이 끊기면 FabWorld가 외부 로봇을 임의 추정 이동시키지 않고
  마지막 pose에서 `safeStop`으로 표시한다.
- 정상 live pose는 source timestamp 순서를 검증하고 wall-clock으로 샘플 사이를 보간한다.
  따라서 FabWorld의 일시정지·배속은 실제 로봇 움직임에 적용되지 않는다. 1.5초 동안 신선한
  pose가 없으면 화면도 `safeStop`으로 전환하고, 더 최신인 pose가 도착하면 복구한다.
- Bridge의 현재 비상 상태, task 상관관계와 작업허가는 메모리 기반이다. 프로세스 재시작을 task 도중
  허용하려면 비상 상태, RMF booking id ↔ FabWorld id와 허가 감사 이력을 Redis/DB에 영속화하고,
  재시작 시 기존 허가는 기본 철회 상태로 복구하는 운영 확장이 필요하다.

## 7. 연계 수용 시험

실기 전 최소 통과 항목은 다음과 같다.

1. `healthz=200`, RMF 연결 후 `readyz=200`, 화면 `LIVE READY`, 시작 버튼 활성화를 확인한다.
2. 미등록 map을 보냈을 때 `readyz=503`, `degraded`, `unknownMaps`, 화면
   `DISPATCH BLOCKED`가 표시되고 브라우저·직접 WebSocket 요청 모두 RMF-Web dispatch 0건이어야
   한다. map 수정 후 자동으로 `LIVE READY`와 버튼 활성 상태를 복구한다.
3. 같은 FabWorld task id를 두 번 보내도 RMF booking이 하나만 생성된다.
4. `calibrate:rmf`가 비공선 기준점으로 transform을 계산하고 max residual 허용 오차를 통과한다.
5. 실제 pose가 계산에 쓰지 않은 독립 기준점에서도 허용 오차 안에 표시된다.
6. 세 action이 단계 순서대로 표시되고 취소·실패도 종결된다. dispatch가
   `go_to_place → perform_action` 순서이며, 전자의 waypoint가 실제 graph에 존재하고 후자의
   `target_pose`가 독립 기준점에서 기대 RMF 좌표와 일치한다.
7. gas/fire/medical 이벤트가 서로 다른 사람·차량·설비 행동을 만든다.
8. RMF-Web, Bridge, Wi-Fi를 각각 단절했을 때 로봇이 화면에서 순간 이동하지 않고 안전 정지한다.
9. 목표 시연 PC에서 전체 서사 동안 frame time, pose 지연, action 지연과 누락률을 기록한다.
10. 의료 키트 실물 인계 시점의 `interaction_kind=medical_handoff`가 화면의 키트 소유권과
    3자 카메라 이벤트를 정확히 한 번만 바꾼다.
11. waypoint 누락·허용 반경 초과·동률 후보를 각각 넣었을 때 RMF-Web dispatch가 0건이고
    화면 태스크가 실패로 종결된다.
12. 가스 태스크가 `interacting` 또는 `completed`여도 센서 확인 콜백 전에는 위험원이
    통제되지 않는다. 밸브 폐쇄 위치와 센서 안정 확인 뒤
    `interaction_kind=gas_isolation_verified`를 보낼 때만 통제되며, 다른 category에 같은
    콜백을 보내면 HTTP 409가 반환된다.
13. `gas_isolation`의 `perform_action.target_pose`에 서비스 면 위치와 밸브 방향 yaw가 모두
    존재한다. 실행기는 `go_to_place` 뒤 이 pose의 위치 오차 5cm·현장 승인 yaw 오차 이내에서
    정지한 후 팔 작업을 시작한다.
14. 인증된 EHS/관제의 작업허가가 없을 때 action executor가 팔 작업을 시작하지 않는다.
    무허가 `interacting` 콜백은 HTTP 409이고 조회 응답은 `authorized=false`다. EHS 허가
    이후 조회가 `authorized=true`로 바뀌고 화면에는 승인자와 작업점 무인 상태가 표시된다.
    폐쇄 뒤 잔류 농도 확인이 `gas_isolation_verified`보다 먼저 발생한다.
15. 밸브 고착·센서 불안정·팔 제어 실패를 각각 주입했을 때 실행기가 안전 자세 복귀와 RMF
    후퇴 요청을 수행하고 `failed`를 보고한다. FabWorld에는 성공 센서 게이트·격리 시간·
    allClear가 생기지 않으며, 네트워크 단절이면 후퇴 추정보다 현재 위치 safe-stop이 우선한다.
16. 허가를 철회하면 조회가 즉시 `state=revoked, authorized=false`가 되고 이후
    `interacting` 콜백이 거절된다. 잘못된 태스크 종류, 상충하는 두 task id, 과거 timestamp,
    2.2~3.4m 밖의 clearance도 각각 거절된다.
17. 유효한 `observing` 가스 태스크와 EHS 허가가 있는 상태에서 브라우저를 새로고침하거나
    WebSocket을 재접속하면 구독 직후 같은 비상 종류·태스크 단계·로봇·허가 주체·거리 이벤트가 복구되고,
    RMF dispatch 횟수는 증가하지 않는다.
18. 가스 태스크 완료 후 다시 새로고침해도 완료 상태와 RMF·EHS·휴머노이드·PLC/GAS 4개 증거가
    복구되고, 과거 태스크 로그와 카메라 cue는 재생되지 않는다.
19. 두 개의 서로 다른 FabWorld task dispatch에 RMF가 같은 booking id를 반환하면 두 번째
    요청은 `rmf_booking_collision`으로 실패하고, 기존 상관관계는 유지되며 `/readyz`가 원인을
    포함한 `503/degraded`를 반환한다.
20. 점검의 일반 `reporting` callback은 비상을 시작하지 않는다. 같은 태스크에서
    `inspection_anomaly_reported`를 점검/reporting 조합으로 보낸 경우에만 incident origin,
    가스 이벤트와 후속 격리 dispatch가 발생하며 다른 category/stage 조합은 거절된다.
21. 두 로봇의 작업 중·완료 후 pose heartbeat를 계속 보내 플릿 보드가 실제 RMF 권위, task id,
    battery와 pose age를 표시한다. 완료 뒤 heartbeat를 끊으면 1.5초 후 해당 로봇만
    `safeStop`이 되어야 하고, 새 pose가 들어오면 복구되어야 한다.
22. EHS 허가가 유효해도 밸브 작업점 1.5m 안에 사람이 있으면 화면
    팔 동작과 `gas_isolation_verified` 수용이 모두 중지되어야 한다. 침범자를 제거한 뒤
    EHS 허가와 무인 구역을 다시 확인하면 재개되고, HUD의 허가 후 작업점 기록은 정상
    시연에서 `human=0, humanoid=1`이어야 한다. 실제 현장에서는 이 렌더링 게이트와 별도로
    로봇 안전제어 또는 출입통제 인터록이 같은 조건을 강제해야 한다.
23. action executor가 `approach/contact/turning/monitoring/verified` 텔레메트리를 1.5초
    이하 간격으로 보내면 화면 양팔과 밸브가 보고값을 따른다. 스트림을 중단하면 pose heartbeat가
    계속돼도 팔 진행은 멈추고 `STALE / SAFE STOP`이 표시된다.
24. 양손 접촉이 아닌 turning, 감소하는 progress/valve position, verified 전 최종 콜백을
    보내면 Bridge가 거절한다. verified에는 폐쇄 위치, gas ppm, sensor stable이 모두 필요하다.
25. `hand_pose`를 포함한 LIVE/TRACE에서는 HUD가 `MEASURED EE`를 표시하고 양팔이 보고된
    `base_link` 말단 위치를 따른다. 도달 불가능한 손 위치와 접촉 중 밸브 링에서 8cm 넘게
    벗어난 위치는 400이어야 하며, 필드가 없는 호환 샘플은 `REFERENCE IK`로 구분되어야 한다.

저장소의 자동 검증은 실제 HTTP RMF-Web 대역과 Bridge, WebSocket, Chromium을 모두 통과하지만,
이는 실제 ROS graph·Fleet Adapter·로봇 안전 제어의 현장 검증을 대체하지 않는다.
