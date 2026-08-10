# 10 — Open-RMF 휴머노이드 운영 시연

## 1. 시연의 중심 명제

FabWorld의 중심은 재난 그 자체가 아니다.

> **Open-RMF가 이기종 로봇의 이동과 자원을 조율하고, 휴머노이드는 사람이 쓰도록 설계된
> 공간·설비·도구와 물리적으로 상호작용한다.**

OHT·AGV·IGV가 반송에 강한 반면 휴머노이드는 다음과 같은 마지막 물리 작업을 담당한다.

- 설비 전면까지 이동해 표시등·패널·센서를 여러 각도에서 확인
- 사람과 작업 구역을 공유하며 안전거리와 접근 순서를 협의
- 사람 손을 전제로 한 격리 밸브·비상 패널을 조작
- 결과를 RMF 태스크 상태와 현장 이벤트로 보고

재난 시나리오는 이 차이가 가장 선명해지는 상황으로 사용한다.

## 2. 대표 통합 시연

단일 버튼으로 아래 서사를 실행한다.

1. **RMF 태스크 배정** — `inspection_round` 태스크가 가용 점검 로봇에 배정된다. 참조
   trace와 로컬 데모에서는 H1이다.
2. **목적 이동** — 배정된 로봇은 사람 우선 교통 규칙을 지키며 설비 로드포트 앞으로 이동한다.
3. **현장 상호작용** — 주변 작업자가 로봇을 인지하고 작업 구역을 비운다.
4. **관찰·점검** — 로봇이 시선을 이동해 설비를 확인하고 패널 작업을 수행한다.
5. **이상 보고** — 정상 `reporting`과 구분되는 `inspection_anomaly_reported`로 가스 이상
   징후를 RMF/상황판에 보고한다.
6. **비상 재조율** — 사람은 외부 집결지로 대피하고, AGV/OHT는 대피 동선을 비운다. OHT는 현재 rail 구간을 빠져나와 위험 경계 밖 rail-side 안전 대기 노드에서 머문다.
7. **역할 분리** — RMF가 별도 가용 로봇에 `gas_isolation`을 배정한다. 참조 trace와 로컬
   데모에서는 H2가 위험원 외부의 격리 밸브로 이동한다.
8. **무인 작업허가** — responder를 포함한 모든 사람은 외부 집결지로 대피한다. 원격 EHS
   허가와 작업점 1.5m 안 인원 0명 interlock이 H2의 단독 밸브 조작을 보장한다.
9. **물리 격리·복구** — H2가 밸브 손잡이에 접촉하고 폐쇄 위치까지 회전한다. H2의 내장 센서가
  잔류 가스 농도 하강을 확인하는 동안 IGV·AGV는 위험 반경 밖 설비를 비접촉 점검한다. 센서
  안정 뒤에만 배기 감쇠, allClear, 사람의 정상 업무 복귀가 시작된다.

이 시퀀스에서 휴머노이드의 장점은 “두 발로 걷는다”가 아니라,
**기존 사람용 설비를 개조하지 않고 현장 확인과 마지막 조작을 수행한다**는 점이다.

HUD는 현재 태스크 단계마다 `역량 기반 배정 → 사람 공유 공간 이동 → 현장 관찰 → 물리 작업 →
운영 결과 보고`의 가치 문구를 표시한다. 카메라는 관찰·조작 시 작업 대상에 근접하고 보고·복귀
시 로봇을 다시 추적해, 관객이 이동 자체보다 목적과 결과를 보게 한다.

안전 증거 앞에는 별도의 incident origin 행을 둔다. 통합 시연에서는 실제 RMF 배정 결과를
따라 `H1 또는 H2 / FIELD · 설비 현장 점검 → 가스 이상 보고 → RMF 재조율 요청`, 단독 가스 시연에서는
`FAB SENSOR · 가스 이상 감지 → RMF 재조율 요청`으로 표시한다. 따라서 관객은 재난이 임의로
시작된 연출인지, 휴머노이드의 현장 점검 결과에서 이어진 운영 사건인지 구분할 수 있다.
`OPEN-RMF 배정·이동` 증거에는 실제 격리 로봇 호출부호를 표시하므로 관객은 점검과 위험
격리가 같은 로봇인지 역할이 분리됐는지도 확인할 수 있다.

가스 시연에는 `OPEN-RMF 배정·이동 → EHS 작업허가 → HUMANOID 수동 밸브 → PLC/GAS 잔류
농도` 증거 사슬을 상시 표시한다. 각 단계는 실제 runtime flag가 들어올 때만 진행/완료로
바뀐다. 실패하면 이미 통과한 허가·접촉 증거를 되돌리지 않고 미검증 센서 게이트와
`FAILED / UNCONTROLLED`를 적색으로 남겨 성공처럼 보이는 연출을 막는다.

임무 효과에는 사람 단독 시간을 임의 가정하지 않는다. EHS 허가 이후 밸브 작업점 1.5m 안에
실제로 들어간 distinct 인원과 휴머노이드를 각각 기록해 `0 / 1 human / humanoid`로 보여준다.
허가 뒤 사람이 진입하면 로컬 상태머신은 관찰 단계로 돌아가고 LIVE 완료 콜백도 거절된다.
사람이 빠지고 원격 EHS 허가와 무인 구역을 다시 확인해야 조작을 재개한다.

### 동일 조건 위험작업 A/B

`위험작업 A/B 실측`은 LOCAL DEMO 전용 보조 시연이다. 실제 RMF 권위와 사람 기준선의 월드
재생성을 섞지 않기 위해 LIVE/TRACE에서는 실행하지 않는다.

1. 같은 seed `20260729`에서 사람 responder 거점과 휴머노이드 거점까지의 최대 접근 거리가
   가장 작은 hazard-capable 설비를 선택한다. 특정 방식에 유리한 가장 가까운 점만 고르지 않는다.
2. A 실행은 방재요원 2인을 직접 조작자와 가스 안전감시자로 배정한다. 조작자는 1.5m 밖에서
   무인 상태와 허가를 기다린 뒤 작업점에 들어가 양손으로 밸브를 조작한다.
3. A의 설비·밸브 id와 결과를 고정하고 월드를 같은 seed로 새로 만든다.
4. B 실행은 기존 로컬 RMF 태스크 상태머신과 작업점 무인 게이트를 그대로 사용해
   휴머노이드를 같은 밸브에 투입한다.
5. 양쪽 모두 밸브 조작·센서 검증 구간은 6.2초로 같고, 접근 시간은 실제 각 거점과 경로에서
   계산한다. HUD는 distinct 사람/휴머노이드 진입 수, 사람 작업점 `person·sec`, 격리 검증
   시간을 양쪽 모두 표시한다.

현재 결정적 수용 기준값은 `lithography-001 / gas-valve-west`에서 A가
`human 1, 7.683 person·sec, 32.533초`, B가
`human 0, humanoid 1, 0 person·sec, 16.750초`다. 이는 시뮬레이션 배치의 관측값이며
실제 현장 작업시간·노출량을 주장하지 않는다. 현장 수치로 바꾸려면 responder/robot 실제
대기 위치, 작업허가 절차, 가스 농도 기반 노출 모델과 실기 action log가 필요하다.

시연 버튼을 다시 누르면 진행 중인 외부 태스크에 먼저 `cancel_task`를 보내고 Worker의 기존
로컬 태스크·비상 권위를 취소한 다음, 새 id의 점검 태스크 하나만 만든다. 750ms 안의 빠른
중복 클릭은 무시해 리허설 중 두 점검 결과가 서로 다른 가스 사건을 만드는 것을 막는다.

## 3. Open-RMF와 FabWorld의 책임 경계

| 계층 | 권위 데이터 | 책임 |
|---|---|---|
| Open-RMF | 태스크·배정·로봇 위치·교통 일정 | 멀티 플릿 조율, 태스크 경매/배정, 공유 자원 충돌 회피 |
| 휴머노이드 Fleet Adapter | 로봇 상태와 실행 결과 | RMF 이동 명령 ↔ 로봇 내비게이션, `perform_action` 실행 |
| FabWorld RMF Bridge | 정규화 이벤트·EHS 작업허가 | ROS/RMF 버전별 메시지 변환, 허가 발급·철회 보존, executor 조회·가스 callback 게이트 |
| FabWorld | 디지털 트윈·사람·설비·연출 | 현장 상황 렌더링, 사람 행동, 물리 작업 애니메이션, 시연 카메라 |

독립 시연에서는 결정적 mock RMF 피드를 사용한다. 실제 연계에서는 RMF가 휴머노이드 위치와
태스크 상태의 권위자이며 FabWorld의 로컬 이동 적분을 중단한다.

브라우저가 rmf-web의 내부 `/_internal` 소켓에 직접 결합하지 않는다. 이 엔드포인트는
Fleet Adapter와 API 서버 사이의 내부 계약이므로, 배포별 변화를 흡수하는 작은 Bridge를 둔다.

## 4. FabWorld RMF Bridge 계약

연결 URL은 `VITE_RMF_BRIDGE_URL` 또는 `?rmf=ws://host:port/path`로 지정한다.
Bridge가 연결된 경우 통합 시연의 점검·가스 격리 태스크도 이 소켓으로 전송되며, RMF가
반환한 배정·단계·pose가 화면의 권위 상태가 된다. 연결 중이거나 재연결 중인 요청은
클라이언트 대기 큐에서 task id 기준으로 중복 제거된다. URL이 없을 때만 Worker의 결정적
RMF 데모 디스패처를 사용한다.

시나리오 전환 시 진행 중인 태스크는 `cancel_task`로 Bridge에 취소 요청하고, 뒤늦게 도착한
상태 이벤트는 task id tombstone으로 무시한다. Bridge 연결이 끊기면 외부 pose 권위를 로컬
추정으로 대체하지 않고, 마지막 위치에서 `safeStop`으로 표시한 뒤 재연결 상태를 HUD에 노출한다.

Bridge → FabWorld:

```jsonc
{ "type": "robot_state", "fleet": "fab_humanoid_fleet", "robot": "humanoid-001",
  "map": "fab-L1", "x": 12.4, "y": -8.2, "yaw": 1.2, "battery": 73,
  "mode": "moving", "taskId": "inspection-42", "timestamp": 1785378000000 }

{ "type": "task_state", "taskId": "inspection-42", "category": "inspection_round",
  "status": "reporting", "assignedRobot": "humanoid-001",
  "targetId": "lithography-001", "interactionKind": "inspection_anomaly_reported",
  "timestamp": 1785378001000 }

{ "type": "emergency", "active": true, "kind": "gasLeak", "timestamp": 1785378002000 }

{ "type": "bridge_status", "status": "ready", "fleet": "fab_humanoid_fleet",
  "robotsSeen": 2, "robotsPublished": 2, "robotsWithoutLocation": 0,
  "unknownMaps": [], "pollLatencyMs": 18, "maxPoseAgeMs": 42,
  "detail": "2/2대 pose 정규화", "timestamp": 1785378002100 }
```

FabWorld → Bridge:

```jsonc
{
  "type": "dispatch_task",
  "request": {
    "category": "perform_action",
    "description": {
      "category": "inspection_round",
      "target_id": "lithography-001",
      "target_pose": {
        "map": "fab-L1",
        "x": -81.0,
        "y": -69.0,
        "yaw": 1.57
      },
      "fabworld_task_id": "operator-inspection-1"
    },
    "priority": 60
  }
}
```

참조 Bridge는 [`services/rmf-bridge`](../services/rmf-bridge)에 구현되어 있다. 위 요청을
RMF의 `compose(go_to_place → perform_action)`으로 변환해 공개 RMF-Web REST API로 dispatch하고, booking id와
FabWorld task id를 연결한다. Fleet Adapter가 별도 HTTP 콜백으로 보내는 실제 관찰·조작·보고
단계, 점검 이상 증거와 gas/medical 이벤트도 수신한다. 일반 `reporting`은 정상 점검 결과일
수 있으므로 가스 사건을 시작하지 않으며, 점검 category의 reporting 단계에
`inspection_anomaly_reported`가 함께 있을 때만 통합 시연의 재조율 원인이 된다.
EHS gateway의 인증된 `work_permit`을 별도 보존해
허가 없는 가스 `interacting`·센서 확인 callback을 거절하고, action executor가 조작 직전
조회할 수 있는 API도 제공한다. 가스 `interacting` 중에는 양손 접촉·팔 진행률·밸브 위치·
가스 농도·센서 안정과 선택적 `base_link` 양손 말단 위치를 별도 수신해 화면 물리 상태의
권위로 사용한다. 브라우저 구독 시
현재 비상 상태·태스크 단계·허가·action telemetry를 즉시 다시 보내므로
새로고침·WebSocket 재접속 뒤에도 진행 중이거나 완료된 책임 사슬이 사라지지 않는다. 이 스냅샷은
복원 표식을 가져 Worker 상태만 조용히 재구성하며 과거 로그·카메라 연출을 새 활동처럼 반복하지
않는다. 같은 RMF booking id가 서로 다른 FabWorld task에 반환되면 Bridge는 기존 상관관계를
보존하고 새 요청을 명시적으로 거절한다.
실행·보안·좌표 보정 절차는
[12-rmf-bridge-deployment.md](12-rmf-bridge-deployment.md)를 따른다.

태스크는 브라우저에서 바로 RMF로 보내지 않는다. Worker가 설비 loadport, 격리 밸브 또는
의료 랑데부 WalkGraph 노드로 `target_id`와 `target_pose`를 먼저 해석한다. Bridge는 pose의
FabWorld map을 설정의 유일한 RMF map으로 역변환하고, 현장 설정에서 가장 가까운 실제
navigation waypoint를 허용 반경 안에서 선택한다. RMF는 먼저 그 waypoint까지의 이동을
스케줄링하고, action 실행기는 정밀 target pose에서 마지막 물리 작업을 수행한다. map 매핑이
없거나 둘 이상이면 `target_map_unmapped/ambiguous`, waypoint가 없거나 동률이면
`target_waypoint_unmapped/ambiguous`로 거절하고 화면 태스크도 실패로 종결한다.

`bridge_status`는 poll/action 지연, 입력 로봇 수, 화면에 정규화된 로봇 수, location 누락과
미등록 map을 HUD에 노출한다. RMF-Web 소켓만 연결됐더라도 pose를 화면에 적용할 수 없으면
`LIVE`가 아니라 `ERROR/degraded`로 표시하고 외부 제어 로봇을 안전 정지한다. 시작 버튼
아래 preflight는 `LIVE READY · published/seen robot · map 정상 · pose age · poll latency`
또는 `DISPATCH BLOCKED · 원인`을 표시한다.

우측 플릿 보드는 두 휴머노이드의 배터리, `SIM/TRACE/RMF/NO POSE` 권위, 활동, task id와 pose age를
Worker metrics에서 250ms마다 표시한다. live 태스크 완료 뒤에도 Fleet Adapter pose heartbeat는
계속 발행되어야 하며 1.5초를 넘기면 완료 로봇도 `safeStop`으로 보인다. 따라서 `LIVE READY`와
로봇 안전정지가 동시에 보인다면 readiness뿐 아니라 개별 로봇 heartbeat를 조사해야 한다.

WebSocket `open`은 dispatch 허가가 아니다. 브라우저는 `bridge_status=ready`를 받기 전에는
점검·통합 시연 버튼을 비활성화하고, Bridge도 `/readyz`와 같은 poll freshness·map·location·
pose 조건으로 새 `dispatch_task`를 다시 검사한다. 배정 요청 중 readiness가 해제되면 생성된
RMF booking을 즉시 취소한다. terminal 태스크에는 늦게 도착한 non-terminal 이벤트를 적용하지
않아 실패·완료 로봇이 다시 이동하는 모순을 막는다.

### Trace 재생 모드

현장 네트워크와 무관한 시연 폴백은 Bridge와 같은 `RmfBridgeEvent`를 기록한 trace를
wall-clock으로 재생한다. `?rmfTrace=reference`는 합성 참조 trace이며 HUD에 `REPLAY`와
`REFERENCE TRACE`로 표시해 실제 연동처럼 오인하지 않게 한다. 현장 recorder로 만든 파일은
`RECORDED TRACE`로 표시한다.

재생기는 task category별 기록을 현재 FabWorld task/target id로 바꾸지만 robot·map·pose·단계
순서는 보존한다. 이동 중뿐 아니라 관찰·조작·보고 정지 구간에도 1초 미만 pose heartbeat를
재생한다. `waiting` heartbeat는 현재 task 단계 애니메이션을 덮어쓰지 않으며, 완료 후에는
마지막 pose에서 idle heartbeat를 이어 1.5초 live watchdog을 우회하지 않고 만족한다.

참조 trace의 H1/H2는 서로 다른 운영·안전 스테이징 지점에서 출발한다. H1 점검 대상에는 담당
작업자가 실제로 점검 중인 상태로 예약되며, 로봇 도착 시 인지→측방 이동→2.2m 확보→승인이
반드시 pose로 발생한다.

## 5. 사실적 행동 기준

### 이동

- 휴머노이드는 보행 그래프와 RMF 일정을 따르며 순간 방향 전환하지 않는다.
- live RMF pose 샘플은 wall-clock으로 보간한다. 화면 일시정지·16× 배속이 실기 로봇의
  이동 속도나 보행 주기를 바꾸지 않으며, 오래된 timestamp의 pose는 폐기한다. 새 pose가
  1.5초 이상 없으면 제자리 보행 대신 `safeStop`으로 전환한다.
- 사람 0.85m 이내에서는 정지하고, 1.8m 이내에서는 감속한다.
- 사람도 로봇을 인지하면 저속 통과하거나 작업 공간을 비운다. `safeStop` 또는 외부 RMF pose
  권위 때문에 움직일 수 없는 로봇은 비양보 물체로 보고 1.8m 전방부터 감속·측방 회피한 뒤
  최소 중심 간격 0.68m를 보장한다. 로컬 이동 가능한 로봇은 사람 우선으로 비키므로 양쪽이
  동시에 영구 정지하지 않는다.
- 사람 보행은 가속 1.5m/s², 대피 감속·회전 2.8 상한을 사용하고, 0.42m 개인 공간과
  0.30m 물리 외피를 제한 반복으로 유지한다. 각 사람은 안정적인 개인별 평시/비상 속도와
  역할별 0.55~3.10초 경보 반응 시차를 가진다.
- 목표 근처에서는 그래프 노드에서 로드포트/밸브의 정확한 작업 위치로 정밀 접근한다.
  작업자 안전거리 협의를 먼저 끝내고, 이후 저속으로 밸브 서비스 면 0.75m 작업 pose의
  5cm 이내까지 접근한다. RMF 요청의 `target_pose`에는 위치뿐 아니라 밸브를 향하는 yaw도
  포함한다.

### 현장 작업

- `navigating → observing → interacting → reporting → returning` 단계가 화면에서 구분된다.
- 관찰 단계는 머리·시선 탐색, 작업 단계는 팔 접근, 보고 단계는 정지 자세로 표현한다.
- 작업자는 로봇이 접근하자마자 사라지지 않고, 인지 → 시선 정렬 → 옆으로 이동 →
  2.2m 이상 안전거리 확인 → 작업 승인 순서로 반응한다. 로컬 태스크의 휴머노이드는 이 승인을
  기다린 뒤 관찰을 시작하며, live RMF 태스크에서도 동일한 작업자 pose 반응을 재생한다.
- 양보 목적지는 단순 방사형 점이 아니라 주변 설비 점유 사각형과 0.55m 여유를 검사해 고른다.
  승인 순간에는 파랑 로봇 위치, 주황 작업자 위치, 2.2m 안전 반경과 실제 거리선을 짧게 표시한다.
- 승인 장면에서 설비가 두 사람을 가리면 해당 설비를 2.6초 동안만 반투명 처리해 상호작용
  당사자와 안전거리를 동시에 보여준 뒤 자동 복원한다.
- 승인된 공간 양보 횟수는 HUD의 `안전 협업` KPI에 누적해 관객이 상호작용 결과를 확인한다.
- 로봇 격리 실행은 현장 인원을 안전감시자로 잔류시키지 않는다. 로컬 데모는 1.5m 작업점의
  무인 상태를 결정적으로 확인하고, live 가스 태스크는 인증된 외부 EHS 허가와 같은 무인
  구역 조건을 모두 만족해야 한다. 허가만으로 팔을 움직이지 않으며 action executor의 fresh 텔레메트리가 팔 진행률과
  밸브 위치를 직접 구동한다. `base_link` 양손 말단 위치가 있으면 절차형 진행률 자세 대신
  해당 위치로 양팔 IK를 풀고 HUD에 `MEASURED EE`를 표시한다. 없으면 `REFERENCE IK`로
  명시해 측정 자세처럼 오인하지 않는다. 밸브 폐쇄 시 검지기 화면과 전용 카메라가 보고된 잔류 농도
  교차 확인을 보여준다.
- HUD의 `검증된 임무 효과`는 홍보용 추정 절감액을 사용하지 않는다. 실제 밸브 폐쇄 이벤트의
  위험 수동작업 대체 건수, EHS 허가 권위, 센서 게이트 통과 시점의 격리 시간을
  각각 독립적으로 표시한다. 실패하면 폐쇄 시도는 남더라도 `0/1 gate`와 격리 시간 미확정이 유지된다.
- 격리 밸브는 위험원 내부가 아니라 접근 가능한 통로 측 안전 설비로 모델링한다.
- 가스 격리는 `손 접촉 → 밸브 폐쇄 위치 → 센서 안정 확인` 세 단계가 순서대로 발생한다.
  타이머나 responder 도착만으로는 위험원이 통제되지 않는다. live RMF에서는 실행기가
  단조 증가하는 `action_telemetry`로 양손 접촉·밸브 폐쇄·가스 안정 상태를 먼저 증명하고,
  fresh `verified` 샘플 뒤 `interaction_kind=gas_isolation_verified`를 보낸 시점만 위험 통제
  의미를 가진다. 샘플이 1.5초 끊기면 measured 말단 위치를 포함한 현재 관절/밸브 상태에서
  safe-stop하며 화면이 시간을 적분해 나머지 동작을 꾸며내지 않는다.
- 휠과 로봇 접근점은 같은 서비스 면을 사용한다. 양팔은 실제 0.31m+0.31m 링크 길이로
  IK를 풀고, 손 중심을 휠 전면과 링 중심선이 만나는 그립 위치에 둔다. 접촉 전에는 팔이 먼저
  뻗고, 폐쇄 회전 중에는 좌우 손이 상단 구간에서 재그립한다.
- 의료 지원은 환자에게 직접 접근하는 대신 치료 경계 밖 WalkGraph 노드에서 지정 responder와
  랑데부한다. 2.2m 이내 대면, responder의 시선 정렬·수령 확인, 양팔 접근 완료, 키트 소유권
  이전 순서가 충족돼야 인계 이벤트가 발생한다. 수령 자세를 1.2초 유지한 뒤 환자에게 합류하고,
  두 responder는 별도 무릎 처치 자세로 전환한다. 카메라는 인계와 처치 시작에 각각
  로봇·키트를 든 responder·쓰러진 환자를 한 구도에 담는다.

### 안전

- 사람의 대피 경로와 responder 접근로가 최우선이다.
- 일반 인원은 반응 시차 후 도달 가능한 집결지에 안정적으로 배정되고, 수용량 혼잡과 위험 존을
  고려한 경로를 사용한다. 안전 경로가 없으면 직선 횡단 대신 정지한다. 집결지에서는 접근
  방향과 횡위치에 맞는 0.75m 슬롯을 바깥 열부터 채운다. 전원이 슬롯 0.12m 안에서 시설 측
  확인 출구를 0.08rad 이내로 향해야 해제한다. 전용 사선 카메라는 열린 비상구, 외부
  서비스 에이프런, 유도선·확인선·슬롯 표식·한/영 집결 표지와 대형을 함께 보여준다.
- 위험원 통제 후 responder는 서로 떨어진 안전 집결 지점으로 후퇴해 대피 동선을 다시 열며,
  일반 인원은 위험 반경이 사라질 때까지 집결지에 머문다. responder는 세 안전 설비 권역의
  2인 1조 대기 지점에서 출발해 난수 배치에 따른 대응 시간 편차를 제거한다.
- 휴머노이드는 일반 물류 차량처럼 무조건 정지하지 않고 사람 공유 공간에 맞는 저속·협상 규칙을 쓴다.
- 화재 시 로컬 휴머노이드는 일반 태스크를 선점 중단하고 최종 위험 반경 밖 안전 지점까지 이동한 뒤
  `safeStop`한다. 외부 RMF pose 권위 로봇은 로컬에서 임의 이동시키지 않는다.
- 실제 RMF 상태가 `offline`이면 로컬 추정 이동을 이어가지 않고 `safeStop`으로 표시한다.
- 데모 실패 주입은 센서 확인 전 가스 태스크만 대상으로 한다. 위험원을 미통제로 유지한 채
  로봇에 도달 가능한 후퇴점을 배정하고, 도착 전까지 `yielding`, 이후 `safeStop`한다.
  전용 실패 카메라는 밸브와 후퇴 목표를 함께 잡는다.

## 6. 수용 기준

1. 통합 시연 시작 후 `inspection_round`이 실제 로봇에 배정되고 모든 태스크 단계가 순서대로
   발생한다. 로컬/reference 기준은 H1이지만 live HUD는 RMF가 반환한 호출부호를 표시한다.
2. 통합 시연 재시작은 기존 진행 태스크를 취소하고 새 점검 태스크 하나만 생성한다. 빠른
   더블클릭도 중복 사슬을 만들지 않는다.
3. 설비 작업 중 인접 작업자 1명 이상이 실제 pose로 작업 구역을 벗어나 2.2m 이상 안전거리
   확보 이벤트를 발생시킨다.
4. 일반 `reporting`만으로는 비상이 시작되지 않고, `inspection_anomaly_reported` 후에만
   incident origin이 완료로 바뀌며 사람 대피·물류 양보·H2 가스 격리 태스크가 동시에
   관찰된다. 로컬 수용 테스트는 H1 점검과 H2 격리가 서로 다른 로봇인지 확인한다.
5. RMF `robot_state`가 들어오면 해당 휴머노이드의 로컬 이동 적분이 중지되고 외부 pose가 유지된다.
6. 같은 seed의 mock RMF 시연은 태스크·상호작용·비상 단계 순서가 결정적이다.
7. 16×에서도 일시정지와 RMF 명령이 지연 없이 처리된다.
8. 의료 JSON은 평시 월드를 먼저 움직인 뒤 로드해도 H2 배정과 키트 인계가 재현되며,
   구조요원 확인이 인계보다 먼저 발생하고 2인 처치 자세를 거쳐, 환자·구급 IGV 사이 교착 없이
   의무실 인계까지 끝난다.
9. 연결된 RMF의 점검·격리·의료 요청은 실제 graph waypoint의 `go_to_place` 뒤에 해석된
   target id와 캘리브레이션된 RMF target pose를 가진 `perform_action`을 포함한다. 의료 실행기의
   명시적 인계 확인은 키트 소유권과 카메라 이벤트를 발생시키며, 가스 실행기의 명시적 폐쇄·센서
   확인 전에는 위험원 통제와 all-clear가 발생하지 않는다.
10. 가스 접촉 이벤트는 로봇이 서비스 면 작업점 5cm 이내이고 목표 yaw 오차 0.05rad 이하일
   때만 발생하며, 렌더의 양손 목표는 휠 표면 기하 테스트를 통과한다.
11. 로컬 가스 대응은 작업점 무인 확인 뒤에만 시작하고,
    `무인 확인 < 접촉 < 폐쇄 ≤ 검지기 모니터링 < 센서 확인` 순서를 지킨다.
    승인 이후 1.5m 물리 작업점의 관측 진입 수는 `human=0`, `humanoid=1`이어야 한다.
12. 센서 확인 전 실패 주입은 태스크를 실패로 종결하고, 위험원·검증 게이트·격리 시간을
    성공 상태로 바꾸지 않는다. 로봇은 후퇴하고 EHS 수동 대응 메시지를 남긴다.
13. live 가스 태스크가 `observing`이고 EHS 허가가 유효한 상태에서 브라우저를 새로고침해도
    구독 스냅샷으로 같은 비상 종류·태스크·로봇·허가 주체와 증거 사슬 앞 두 단계가 복구되며,
    새 RMF booking을 만들지 않는다.
14. 가스 격리와 4단계 증거 사슬이 완료된 뒤 다시 새로고침해도 완료 상태와 허가·접촉·폐쇄·
    센서 확인 증거가 모두 복원된다. 복원 과정은 과거 태스크 로그나 작업 카메라 cue를 다시
    발생시키지 않는다.
15. live mock에서 점검 완료 로봇은 idle heartbeat로 `standby`를 유지하고, 플릿 보드는
    점검 로봇·격리 로봇의 실제 id와 task 권위를 서로 바꾸어 표시하지 않는다.
16. 허가 뒤 사람을 1.5m 밸브 작업점에 진입시키면 로컬 로봇은 관찰 단계로 중지하고 LIVE
    `gas_isolation_verified`도 거절한다. 사람이 빠진 뒤 EHS 허가·무인 구역을 다시 확인해야
    물리 작업과 완료가 허용된다.
17. 평시 responder는 생산 설비 점검에 배정되지 않고 권역별 대응 거점에서 대기한다.
    operator는 loadport, engineer는 반대 service face에서 점검하며 cleanroom PPE로 렌더링된다.
18. A/B의 두 실행은 같은 seed, source equipment, valve id와 6.2초 조작/검증 시간을 사용한다.
    A 완료 뒤 B 시작 전에 새 `SimWorld`를 생성해 사람 위치·설비·교통 상태를 복원한다.
19. A는 허가 전 1.5m 밖에서 대기하고 안전감시자는 2.2~3.4m 위치를 유지한다. 완료 결과는
    `human=1`, `humanoid=0`, 사람 작업점 체류 6.2 person·sec 이상이어야 하며 양손 밸브
    자세가 관측되어야 한다.
20. B는 같은 target에서 `human=0`, `humanoid=1`, 사람 작업점 체류 0이어야 한다. 브라우저
    최종 카드는 양쪽 격리 시간을 숨기지 않고, 제거된 person·seconds를 두 실행 차이로 계산한다.
21. LIVE/TRACE 가스 작업의 팔 진행률과 밸브 회전은 `action_telemetry.progress/valvePosition`을
    그대로 따른다. 텔레메트리가 없는 `interacting`은 조작 대기로 보이고 1.5초 뒤 safe-stop하며,
    pose heartbeat만으로 팔 진행률이 증가하지 않는다.
22. `gas_isolation_verified`는 유효 허가와 무인 작업점뿐 아니라 fresh `verified` 텔레메트리
    (`valvePosition=1`, `gasPpm`, `sensorStable=true`)가 있어야 수용된다. 잘못된 양손 접촉,
    역행 progress/밸브 위치, stale timestamp는 Bridge가 400/409로 거절한다.
23. 선택적 양손 말단 위치가 있으면 `base_link` 미터 좌표가 pose buffer의 전용 6개 슬롯을
    거쳐 렌더 IK를 직접 구동하고 HUD가 `MEASURED EE`를 표시한다. 팔 도달 범위를 넘거나 접촉
    중 휠 전면·링 중심선에서 8cm 넘게 벗어난 좌표는 Bridge/schema가 거절한다. 위치가 없는
    호환 샘플은 `REFERENCE IK`로 구분한다.

## 7. 실제 연계 체크리스트

- 휴머노이드 Fleet Adapter의 fleet/robot 이름을 `fab_humanoid_fleet`, `humanoid-001/002`와 매핑
- RMF map 좌표 ↔ FabWorld X/Z 좌표의 원점·축·스케일 변환 보정
- 작업 접근점 근처의 실제 RMF navigation waypoint 이름·좌표·허용 반경 등록
- `perform_action`의 `inspection_round`, `gas_isolation`, `medical_support` 실행기 구현
- RMF `go_to_place` 도착 뒤 action description의 `target_pose(map,x,y,yaw)`로 정밀 접근하고
  두 구간의 도착 오차를 각각 확인
- `/fleet_states`, 태스크 상태, 비상 상태를 Bridge 계약으로 변환
- 실제 로봇의 양손 접촉·팔 작업 진행률·밸브 위치·가스 농도·센서 안정 상태와
  `base_link` 기준 양손 말단 위치(m)를 `/ingest/action-telemetry`의 정규화 값으로 매핑하고
  1.5초 이하 heartbeat 유지
- 이상이 실제 확인된 점검의 `reporting`에서만
  `interaction_kind=inspection_anomaly_reported` 콜백 전송
- 현장 Bridge에서 대표 태스크 trace를 기록하고 `RECORDED TRACE` 재생 E2E 수행
- 네트워크 단절·pose 지연·태스크 취소 시 안전 정지 시각화 검증
- Bridge `/healthz`, `/readyz`, origin/token과 action-stage ingest 검증
- action telemetry의 schema·단조성·robot/task 상관관계·stale safe-stop과 reconnect snapshot 검증
- 의료 키트가 실제 전달된 시점에 `interaction_kind=medical_handoff` 콜백 전송
- 밸브 폐쇄 위치와 가스 센서 안정 상태를 실제 PLC/센서에서 함께 확인한 시점에만
  `interaction_kind=gas_isolation_verified` 콜백 전송
- 실제 현장 작업허가를 원격 EHS/관제 UI 중 누가 승인할지 정하고, Fleet Adapter가
  `perform_action` 조작 단계로 들어가기 전에 그 허가를 강제하는 인터페이스 구현
- 사람 검지 또는 출입통제 신호로 밸브 작업점 반경 1.5m 무인 상태를 확인하고, 조작 도중
  침범하면 action executor를 정지·재확인하는 현장 인터록 구현

## 8. Open-RMF 참고

- [Open-RMF 공식 문서](https://openrmf.readthedocs.io/en/latest/)
- [Open-RMF 연계 인터페이스](https://openrmf.readthedocs.io/en/latest/interfacing/index.html)
- [rmf_demos — RMF Web, 태스크 배정, 비상 알람 예제](https://github.com/open-rmf/rmf_demos)
- [rmf_visualization — 외부 UI용 일정 WebSocket](https://github.com/open-rmf/rmf_visualization)
