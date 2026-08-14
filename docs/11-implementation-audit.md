# 11 — 구현 추적 및 검증 보고서

최초 기준일: 2026-07-31  
최신 재감사: 2026-08-13

> 1~6절은 2026-07-31 구현 스냅샷과 당시 수치를 보존한다. 현재 코드·UX·보안 판단과
> 재현 명령은 7절을 우선한다.

이 문서는 00~10의 목표 설계와 현재 저장소의 실제 구현을 구분한다. 충돌하는 설명이 있다면
현재 상태는 이 문서와 소스 코드를 우선한다.

## 1. 구현 결론

독립 시연 모드는 처음부터 끝까지 실행된다. 448개 엔티티가 평시 생산·반송·설비 점검을
수행하고, Open-RMF mock·정규화 WebSocket Bridge 또는 검증된 RMF trace가 휴머노이드 태스크와
pose의 권위를 가진다. trace는 `REFERENCE/RECORDED`와 `LIVE`를 구분한다. 가스 유출·화재·응급
환자는 서로 다른 역할 매트릭스, 사람 반응, 차량 양보,
휴머노이드 태스크, FX와 카메라 큐를 사용한다.

실제 휴머노이드와 Open-RMF Fleet Adapter를 사용한 현장 종단 검증은 이 저장소만으로 완료할
수 없다. Fleet Adapter, 로봇 실행기, 현장 좌표 변환, 네트워크·안전 승인 환경이 외부 입력으로
남아 있다.

## 2. 실행 구조와 근거

| 영역 | 현재 구현 | 소스 근거 |
|---|---|---|
| 레이아웃 | 6×12 베이, 324 설비, 3종 nav graph, 의미 검증 | [`fab-default.json`](../data/layouts/fab-default.json), [`core/layout/index.ts`](../src/core/layout/index.ts) |
| 시뮬레이션 | Worker 고정 60Hz, seed RNG, 448개 엔티티, 저빈도 이벤트 | [`sim/clock.ts`](../src/sim/clock.ts), [`sim/worker.ts`](../src/sim/worker.ts), [`sim/world.ts`](../src/sim/world.ts) |
| 평시 활동 | 설비 프로세스, 산출 캐리어 반송, operator loadport 점검, engineer service-face 진단, responder 대응 거점 대기 | [`equipmentSystem.ts`](../src/sim/systems/equipmentSystem.ts), [`missionSystem.ts`](../src/sim/systems/missionSystem.ts), [`personSystem.ts`](../src/sim/systems/personSystem.ts) |
| 교통·안전 | 공간 해시, 사람 우선, headway, 응급 우선권, 양보 교착 해소, 설비·스토커·안전장치·기둥 점유 경계와 몸체별 swept-circle 검사, 막힌 graph node/edge 제거, 움직일 수 없는 `safeStop`·외부 RMF 로봇 선제 감속·측방 회피 | [`core/layout/obstacles.ts`](../src/core/layout/obstacles.ts), [`core/layout/index.ts`](../src/core/layout/index.ts), [`trafficSystem.ts`](../src/sim/systems/trafficSystem.ts), [`movementSystem.ts`](../src/sim/systems/movementSystem.ts) |
| 재난 | 단계 상태머신, graph hazard 비용, 개인별 평시/비상 속도·역할별 경보 인지 시차와 방향 확인, 권역별 responder 스테이징, 수용량 기반 집결지·0.75m 슬롯 배정, 개인 공간·시설 측 확인 방향까지 포함한 대형 완성 게이트, 무경로 안전 정지, 통제 후 responder 분산 후퇴, 국소 설비 HOLD, 의료 처치·IGV 이송 | [`population.ts`](../src/sim/population.ts), [`world.ts`](../src/sim/world.ts), [`movementSystem.ts`](../src/sim/systems/movementSystem.ts), [`emergencySystem.ts`](../src/sim/systems/emergencySystem.ts), [`equipmentSystem.ts`](../src/sim/systems/equipmentSystem.ts) |
| 휴머노이드 | 분리된 운영/안전 스테이징, 점검 담당 작업자 예약·인계, 안전거리 협의 후 저속 정밀 접근, 점검·의료 지원, 안전감시자 집결·작업허가·1.5m 무인 작업점→접촉→밸브 폐쇄→휴대용 검지기 모니터링→센서 확인형 가스 격리, 침범 시 local/live 중지·재확인, 실패 시 미통제 유지·로봇/감시자 분리 후퇴·EHS 인계 | [`humanoidSystem.ts`](../src/sim/systems/humanoidSystem.ts), [`movementSystem.ts`](../src/sim/systems/movementSystem.ts), [`personSystem.ts`](../src/sim/systems/personSystem.ts), [`targeting.ts`](../src/sim/targeting.ts) |
| 위험작업 A/B | LOCAL 전용 순차 비교, 사람/로봇 거점 균형 위험원 선택, 방재요원 직접 양손 조작·별도 검지 감시, 동일 seed/source/valve/8.2초 작업으로 새 월드 재생, 양쪽 진입·person·seconds·격리 시간 동시 표시 | [`sim/worker.ts`](../src/sim/worker.ts), [`sim/world.ts`](../src/sim/world.ts), [`personRenderer.ts`](../src/render/agents/personRenderer.ts), [`ui/Hud.tsx`](../src/ui/Hud.tsx) |
| Open-RMF 경계 | zod 검증 이벤트, 공개 RMF-Web REST 참조 Bridge, Worker 목표 해석, FabWorld→RMF target pose 역보정과 map 누락/중복 거절, 현장 nav waypoint 최근접·반경·동률 검증, `compose(go_to_place→perform_action)`, 브라우저·Bridge 이중 readiness dispatch 게이트와 in-flight booking 취소, terminal state 비부활, 일반 점검 reporting과 명시적 `inspection_anomaly_reported` 분리, 의료 인계, 인증된 EHS 작업허가 발급·철회·executor 조회, 양손 접촉·팔 진행·밸브 위치·가스 농도·센서 안정·`base_link` 양손 말단 위치 action telemetry의 schema/도달범위/밸브 접촉잔차/단조성/1.5초 freshness와 최종 callback 게이트, 구독 시 현재 비상·태스크·허가·telemetry 스냅샷 복구, 측정점 기반 map calibration, wall-clock pose 보간·stale 폐기, task 단계 보존 heartbeat, map/location/pose/action 진단, 인증·취소·재연결·단절 safeStop, telemetry 포함 trace recorder/player | [`integrations/rmf/client.ts`](../src/integrations/rmf/client.ts), [`integrations/rmf/trace.ts`](../src/integrations/rmf/trace.ts), [`rmf-bridge/server.ts`](../services/rmf-bridge/server.ts), [`rmf-bridge/traceRecording.ts`](../services/rmf-bridge/traceRecording.ts), [`sim/world.ts`](../src/sim/world.ts) |
| 렌더링 | Three.js 인스턴싱, 라운드 외피·서비스 패널·환기구·타입별 상부 모듈 설비, 휠/범퍼/센서/도킹부를 병합한 OHT·AGV·IGV와 FOUP, cleanroom PPE 작업자, 2-link 휴머노이드 보행·양손 IK, 의료 인계/처치 자세, 단일 draw-call 접지 그림자, 조작 연동 밸브, cloudlet 가스·연기와 3-lobe 화염·의료 비콘, 대피 유도 경광봉·지시 자세, 안전거리 cue·순간 설비 투시, 가스 협업/실패/의료/집결 카메라 | [`interactionGeometry.ts`](../src/core/interactionGeometry.ts), [`humanoidGait.ts`](../src/render/agents/humanoidGait.ts), [`render/engine.ts`](../src/render/engine.ts), [`render/world/fabScene.ts`](../src/render/world/fabScene.ts), [`agentRenderer.ts`](../src/render/agents/agentRenderer.ts), [`carrierRenderer.ts`](../src/render/agents/carrierRenderer.ts), [`personRenderer.ts`](../src/render/agents/personRenderer.ts), [`humanoidRenderer.ts`](../src/render/agents/humanoidRenderer.ts), [`emergencyFx.ts`](../src/render/fx/emergencyFx.ts), [`interactionCue.ts`](../src/render/fx/interactionCue.ts), [`shotPlanner.ts`](../src/render/camera/shotPlanner.ts) |
| 운영 UI | 배속/정지, 3종 시나리오, 구조화된 `LIVE READY/DISPATCH BLOCKED` preflight와 시작 버튼 gate, 실제 점검·격리 로봇 호출부호를 따르는 incident/proof, 배터리·SIM/TRACE/RMF/NO POSE 권위·활동·task·pose age 2대 플릿 보드, 단계별 휴머노이드 가치 문구, `OPEN-RMF→EHS→HUMANOID→PLC/GAS` 실제 이벤트 증거 사슬, 허가 후 작업점 human/humanoid 실제 진입·감시자 거리·센서 게이트/격리 시간 KPI, 동일 조건 A/B 양쪽 원시 관측값과 차이, 실패 주입, 태스크 스코어보드, 이벤트 로그 | [`ui/Hud.tsx`](../src/ui/Hud.tsx), [`ui/taskNarrative.ts`](../src/ui/taskNarrative.ts), [`app.tsx`](../src/app.tsx) |

## 3. 목적성·사실성 추적

| 시연 질문 | 구현 답변 | 상태 |
|---|---|---|
| 휴머노이드는 평시에 왜 필요한가? | 사람용 설비 전면까지 이동해 관찰·패널 작업·보고를 수행한다. | 구현 |
| 재난은 휴머노이드 장점을 어떻게 보여주는가? | 일반 점검 보고가 아니라 명시적 `inspection_anomaly_reported`만 가스 사건을 발동한다. 화면은 실제 점검 로봇과 RMF가 격리에 배정한 별도 로봇을 표시하고, 안전감시자가 측면 허가 위치에서 검지기를 준비한 뒤 작업을 승인한다. 로봇은 사람용 격리 밸브의 서비스 면 5cm 이내로 정밀 접근하고 실제 링크 길이의 양손 IK로 휠을 잡아 폐쇄한다. 사람이 잔류 농도를 교차 확인하고 센서 안정 피드백이 들어오기 전에는 가스가 자동 통제되지 않는다. | 구현 |
| 사람은 단순 랜덤 보행인가? | 평시 operator는 loadport, engineer는 반대 service face에서 목표 선택→이동→정렬→점검→휴식하고 responder는 대응 거점에서 대기한다. 비상 시 역할뿐 아니라 사람마다 안정적으로 다른 선호/비상 속도와 인지 지연을 사용한다. 위험원·출구 방향을 확인한 뒤 대피/양보/응급처치로 전환한다. | 구현 |
| 군중이 같은 출구로 몰리거나 위험 구역을 직선 횡단하는가? | 도달 가능한 집결지만 경로 길이·수용량으로 안정 배정하고, 위험 확대로 경로가 끊기면 재배정한다. 집결지에서는 접근 방향 기반 슬롯을 채우고 0.6m 이상 대형 간격을 검증한다. 대안도 없으면 제자리 정지한다. | 구현 |
| 사람과 로봇은 실제로 상호작용하는가? | 평시 작업자는 인지 후 장비 점유 여유가 있는 지점으로 실제 이동해 2.2m 거리를 확보해야 로컬 휴머노이드가 작업한다. 가스 안전감시자도 WalkGraph로 측면 허가 위치까지 이동해 2.2~3.4m를 유지하고 검지기 준비·승인·폐쇄 후 모니터링 pose를 수행한다. 동시에 1.5m 작업점 안 사람이 0명이어야 하며 승인 뒤 침범도 local/live 조작을 중지한다. 대피자는 움직일 수 없는 `safeStop`·외부 pose 권위 로봇을 1.8m 전방부터 감속·측방 회피하고 0.68m 외피를 유지한다. | 구현 |
| 장점이 홍보 문구가 아니라 결과로 남는가? | 단일 로봇 시연은 허가 이후 작업점 distinct 진입을 실제 pose에서 세어 `human=0, humanoid=1`을 증명한다. 별도 A/B는 같은 seed/source/valve에서 방재요원 직접 작업도 실제 이동·양손 조작으로 실행한 뒤 새 월드에서 로봇 실행을 재생한다. 양쪽 진입, 사람 person·seconds, 격리 시간을 모두 노출하고 차이만 계산한다. | 구현 |
| 허가 뒤 사람이 작업점에 들어오면 계속 조작하는가? | 1.5m 침범을 감지하면 local은 관찰 단계로 복귀하고 LIVE 완료 콜백은 거절한다. 사람 제거 뒤 감시자 자세·무인 구역을 다시 확인해야 재개한다. 침범 id는 KPI에 남는다. | 구현 |
| 실패해도 성공처럼 보이지 않는가? | 센서 확인 전 실패는 위험원을 미통제로 유지하고 allClear를 거절한다. 로봇은 2.5m 이상 후퇴 후 safeStop, 감시자는 반대 방향 4m 이상 이탈하고 EHS 수동 대응으로 인계한다. | 구현 |
| responder가 대피 동선을 영구 차단하거나 평시 설비 작업에 섞이는가? | 평시에는 권역별 거점에서 대기하고 비상에만 출동한다. 위험원 통제 즉시 서로 3m 이상 떨어진 도달 가능 안전 집결점으로 후퇴해 작업 구역을 개방한다. | 구현 |
| 의료 대응에 목적 있는 이송이 있는가? | H2와 지정 responder가 안전 WalkGraph 노드에서 시선 정렬·수령 확인 후 키트를 대면 인계한다. responder 2인은 환자 곁 무릎 처치 자세로 전환하고, 30초 처치 후 IGV가 의무실로 이송한다. 키트 소유권과 통행 우선권도 pose로 바뀐다. | 구현 |
| 화재·가스·의료 행동이 서로 다른가? | 종류별 OHT/AGV/IGV/휴머노이드 역할 매트릭스와 FX가 분리되어 있다. | 구현 |
| 동작이 실기와 같은가? | 보행은 지지기/스윙기·다리 IK·수평 발바닥으로 보강했고 팔·시선도 목적별 절차 동작이다. 실기 관절 로그, 접촉력, 균형 제어 기반 보정은 외부 작업이다. | 부분 |
| 네트워크가 없는 시연에서 실제 RMF 계약을 유지하는가? | 같은 정규화 이벤트를 wall-clock으로 재생하고 task/target id만 현재 요청에 재매핑한다. HUD는 합성 `REFERENCE`와 현장 `RECORDED`, 실제 `LIVE`를 구분한다. | 구현 |
| 리허설 중 시연을 다시 눌러도 서사가 겹치지 않는가? | 진행 중 RMF 태스크를 취소하고 Worker의 기존 권위를 정리한 뒤 새 점검 id 하나만 만든다. 750ms 중복 입력을 막고, E2E는 빠른 더블클릭에서 단일 사슬과 이전 태스크 취소를 확인한다. | 구현 |
| WebSocket만 연결되면 잘못된 현장 태스크를 보낼 수 있는가? | `bridge_status=ready` 전에는 시작 버튼과 client 전송을 막고, Bridge가 동일 freshness·map·pose 조건을 다시 검사한다. degraded 직접 요청은 `bridge_not_ready`, RMF-Web dispatch 0건이며, 복구 시 자동 활성화된다. in-flight 응답도 readiness가 해제되면 booking을 취소한다. | 구현 |
| 정상 점검 보고가 거짓 재난을 만들 수 있는가? | `reporting`만 받은 live 점검은 정상 phase를 유지하고, 점검/reporting 조합의 인증된 `inspection_anomaly_reported`가 있어야 incident origin과 가스 재조율을 시작한다. 잘못된 stage는 400, 잘못된 category는 409다. | 구현 |
| LIVE 화면에서 어느 로봇이 실제 권위자인지 알 수 있는가? | 플릿 보드가 각 휴머노이드의 배터리·SIM/TRACE/RMF/NO POSE 권위·활동·task id·pose age를 250ms마다 표시한다. 증거 사슬도 하드코딩 H1/H2 대신 실제 배정 id를 사용하며 완료 후 heartbeat가 끊기면 해당 로봇만 1.5초 뒤 safeStop으로 드러난다. | 구현 |
| LIVE 팔과 밸브가 실제 executor보다 앞서 움직일 수 있는가? | 가스 interacting의 wall-clock `auxA` 적분을 제거했다. 팔은 executor progress, 밸브는 valvePosition, 검지 UI는 gasPpm/sensorStable만 따르며, 누락·1.5초 stale이면 마지막 상태에서 safeStop한다. verified 텔레메트리 없이는 최종 콜백도 Bridge/Worker 양쪽에서 거절한다. | 구현 |
| LIVE 양손 자세도 실제 executor를 따르는가? | 선택적 `base_link` 양손 말단 위치를 6개 pose slot으로 전달해 2-link IK를 직접 구동한다. 도달 범위·좌우·밸브 접촉잔차를 검증하고 HUD는 `MEASURED EE`와 `REFERENCE IK`를 구분한다. 실제 로봇 link→base 변환은 현장 매핑이 남았다. | 부분 |

## 4. 자동 검증 결과

아래 수치는 같은 seed로 재현되는 현재 기준값이다.

| 검증 | 결과 |
|---|---|
| lint | 통과 |
| unit/integration | 7 files, 82 tests 통과. 정상 점검 reporting의 무사건·명시적 anomaly만 사건 발생, Bridge와 공통 정규화 schema의 anomaly/action telemetry 물리 일관성 gate, measured 양손 도달범위·밸브 접촉잔차·pose slot 전달, 텔레메트리 단조성·stale safeStop·verified 선행조건, degraded dispatch 0건·terminal RMF task 비부활, 통합 시연 단일 재시작 사슬, responder 평시 거점, EHS 허가·1.5m 작업점 침범 local/live 중지, 동일 조건 사람/휴머노이드 A/B, RMF booking id 충돌 거절 포함 |
| 통합 목적 시연 | H1 점검 → 18.183초 명시적 이상 보고 → 21.200초 H2 가스 격리 태스크 → 34.967초 센서 검증 → 176.417초 정상 복귀. 점검과 위험 격리를 서로 다른 휴머노이드가 수행하고 `showcase` 출처를 완료까지 보존 |
| 위험작업 A/B | 같은 `20260729` seed의 거점 균형 위험원 `lithography-001`, 동일 `gas-valve-west`, 동일 8.2초 조작/검증. 사람 직접 조작은 human 1명·9.767 person·sec·39.683초, 휴머노이드는 human 0명/humanoid 1대·0 person·sec·17.783초. 두 실행의 별도 양손 작업 장면과 최종 비교 카드 Chromium 검증 |
| 가스 격리/대피 | 안전감시자 승인 14.200초 → 접촉 17.900초 → 밸브 폐쇄·휴대용 검지기 모니터링 21.900초 → 센서 확인·휴머노이드 통제 22.900초 순서 통과. 승인 거리 2.257m, 허가 후 1.5m 작업점 진입 human 0/humanoid 1, 검지 자세 관측, 접촉 pose 오차 0.037m·yaw 오차 0, 센서 확인 전 통제 0건. 일반 인원 94명 전원 157.550초 집결 구역 진입, 최대 HOLD 설비 11대 |
| 화재 대피/복구 | 94명 전원 260.433초 집결 구역 진입, 266.567초 대형·확인 방향 완성, 269.600초 정상 복귀, HOLD 22대, 휴머노이드 2대 안전 정지 |
| 대피 seed 스트레스 | 화재 4개 seed 239.383~260.433초 집결·248.000~269.600초 정상 복귀, 가스 4개 seed 143.667~279.200초 집결·154.883~287.567초 정상 복귀 |
| 사람 동작 품질 | 화재/가스 대피 중 사람 중첩 샘플 0건, 순간 사람 중심 최소 0.412m/0.379m, 사람–휴머노이드 최소 0.680m/1.500m, 완성 대형 최소 0.615m/0.603m·반경 4.176m·확인 방향 최대 오차 0.062/0.074rad. 개인 반응 0.605~3.091초, 출발 분산 2.467/2.483초, 250ms 최다 동시 출발 22/21명, 비상 속도 1.563~1.719m/s, 최대 가감속·회전 2.8 |
| 의료 이송 | 실제 `medical.json` 기준 responder 확인 5.050초 → H2 키트 인계 7.483초 → 휴머노이드 작업 완료 16.050초 → 의무실 인계 77.767초. 2인 처치 자세·3자 카메라 이벤트 통과, 차량 간섭 tick 0, HOLD 설비 0대 |
| 복구 처리량 | 워밍업 평시 308 lot 대비 복구 후 292 lot, 94.8% |
| 시뮬레이션 비용 | 448개체, 1,800 tick 평균 1.912ms, p95 2.408ms, 최대 6.063ms. p95 8ms 게이트 통과 |
| 실패 안전 | 센서 확인 전 실패 주입 시 위험 통제·검증 게이트·격리 시간 0, 로봇 후퇴 2.5m 초과 후 safeStop, 감시자 반대 방향 4m 초과 이탈, EHS 인계·allClear 거절 통과 |
| 브라우저 E2E | live mock, 실제 참조 Bridge, wall-clock reference trace에서 `UNMAPPED/degraded→DISPATCH BLOCKED·전송 0건→ready 자동 복구`, 실제 target pose 이동, 빠른 더블클릭 단일 사슬·이전 태스크 취소, H2 점검→명시적 anomaly→H1 격리, 완료 후 idle heartbeat, 인증 EHS 허가→감시자/무인 작업점→human 0/humanoid 1→executor approach/contact/turning/monitoring/verified+`MEASURED EE`→최종 콜백, telemetry 포함 관찰·완료 reload 복구, 침범 callback 거절, 실패 후퇴, 사람 직접/휴머노이드 동일 밸브 A/B와 DOM 원시 관측값, 카메라, 3종 재난, 단절 safeStop 통과 |
| draw call | cleanroom PPE·2절 작업자, 의료 처치, measured 양손·가스 검지기·밸브 협업, incident origin, 외부 집결 환경 및 실패 후퇴 카메라를 포함한 SwiftShader E2E 관측 최대 107, 문서 예산 150 미만 |
| production build | 통과. 메인 JS 967.53kB(253.51kB gzip), Worker 192.86kB, CSS 17.56kB(4.55kB gzip), measured-hand trace 51.86kB(2.51kB gzip) 별도 asset. 500kB chunk 경고는 남음 |

실행 명령:

```bash
npm run lint
npm test
npm run test:acceptance
npm run test:stress
npm run test:human-motion
npm run benchmark:sim
npm run test:e2e
npm run build
```

헤드리스 테스트의 SwiftShader FPS는 실제 GPU 성능을 대표하지 않는다. 60fps 목표는 sim tick과
draw-call 예산으로만 선행 검증했으며, 목표 시연 PC에서의 60fps와 내장 GPU 30fps는 별도 측정이
필요하다.

## 5. 남은 결정과 외부 검증

1. **실제 RMF 경계** — 참조 Bridge는 구현됐으나, 사용할 RMF 릴리스와 Fleet Adapter 배포 방식,
   map 이름을 현장 구성으로 확정한다.
2. **좌표 캘리브레이션** — 계산 CLI와 잔차 게이트는 구현됐다. 실제 RMF/FabWorld 현장
   기준점을 측정하고 독립 검증점으로 최종 오차를 확인한다.
3. **현장 waypoint 등록** — 실제 RMF navigation graph에서 설비·밸브·의료 랑데부에 사용할
   waypoint 이름과 RMF 좌표를 추출하고, 작업 접근점별 `maxDistance`를 안전 검토 후 확정한다.
4. **실기 동작 보정** — 보행 속도, 가감속, 머리 스캔, 팔 조작 시간을 로봇 로그/영상으로 맞추고,
   제조사별 end-effector link pose를 `base_link`의 전방·상방·측방 미터 좌표로 변환한다.
5. **안전 의미** — 이 화면은 시연용 디지털 트윈이다. 실제 안전 정지·위험 구역 출입 권한은 Fleet Adapter와 현장 PLC/안전 시스템이 가져야 한다.
6. **작업허가 실기 연결** — Bridge의 EHS 허가 발급·철회·조회와 무허가 callback 게이트는
   구현됐다. 실제 안전감시자/관제 UI를 이 ingest에 연결하고, Fleet Adapter action executor가
   팔 제어 직전 `authorized=true` 조회를 강제해야 한다. 실기 관절/접촉/PLC 센서 출력과
   양손 말단 위치를 action telemetry로 정규화하고 1.5초 heartbeat·safe-stop을 실제 제어기와
   함께 검증해야 한다.
7. **시연 하드웨어** — 목표 PC/GPU, 화면 해상도, 네트워크 지연·단절 조건에서 프레임과 복구를 측정한다.
8. **대피 정책 검증** — 현재 수용량은 경로 선택 가중치이며 물리적 정원 초과 차단은 아니다.
   실제 EHS의 집결지 정원, 출입구 폭, 장애인/부상자 이동 규칙과 맞춘다.
9. **시각 폴리시** — 실제 장비 GLTF/작업자 모션캡처, 화면공간 LOD/AdaptiveQuality, 화재 접근로와 대피 유도선을 필요 수준에 맞춰 선택한다.
10. **번들 분할** — 약 966kB 메인 chunk를 Three.js/운영 UI/시나리오 단위로 나눠 첫 화면 로딩과 현장 캐시 실패 위험을 줄인다.
11. **운영 배포** — 정적 호스팅과 COOP/COEP 헤더, TLS WebSocket 인증, 관측 로그와 장애 대응을 확정한다.
12. **Bridge 영속성** — 시연 중 Bridge 재시작까지 복구해야 한다면 현재 비상 상태, booking id
   상관관계와 허가 감사 이력을 외부 저장소에 영속화한다.

## 6. 감사 방법과 한계

Architect CLI 0.2.0-dev로 실제 작업 트리를 새 프로젝트로 스캔했으나 `discovered=120`,
`analyzed=1`, `skipped=119`이고 인식 언어가 Kubernetes/YAML뿐이어서 네이티브 TypeScript
커버리지는 0이었다. 임시 Git 인덱스 기반 제품 소스 보조 수집으로
106파일·73 TypeScript/TSX·268 import를
인벤토리하고, 설계 문서와 TypeScript/JSON 소스, 자동 테스트와 브라우저 E2E를 대조했다.
11개 사용 사례→15개 기능 요구→9개 품질 시나리오→6개 ASR→7개 설계정책의 orphan/undefined
0건은 별도 [as-is 감사 문서](../projects/fab-world-audit-20260730/report/README.md)에 보존했다.
실제 ROS graph, Fleet Adapter, 로봇 로그와 현장 안전 구성은 이 저장소에 없으므로 추론하지 않았다.

## 7. 2026-08-12 전체 UX·기능·보안 재감사

### 7.1 범위와 결론

현재 작업 트리의 제품 코드·설정·문서·테스트 107개 파일을 다시 대조했다. Architect CLI
0.2.0-dev의 TypeScript 네이티브 추출은 `analyzed=0`, `skipped=107`로 충분하지 않아, 소스의
import·상태 전이·입력 경계 직접 추적, 자동화 시나리오, 1280×800/모바일 브라우저 점검으로
보완했다. 소스 digest는
`0f9129c391d7f0f4d72c2d7968d774bd955c0791e44a1f69e608318a1138e026`, Architect snapshot은
`sha256:30a93473e60e4112271fc9892a00283025f6338282ce7286865ba1cab6883b1e`다.

독립 시연의 평시→점검→가스/화재/의료→복구 사용자 여정과 live RMF의 degraded 차단→ready
복구→배정→executor 증거→완료/단절 안전정지 여정은 실행 가능하다. 저장소 내부에서 즉시 악용
가능한 치명적 보안 취약점은 재감사와 의존성 검사에서 확인되지 않았다. 다만 이 결론은 웹 앱과
참조 Bridge에 한정되며, 실제 로봇·PLC·출입 통제·Fleet Adapter까지 포함한 기능 안전 승인을
의미하지 않는다.

### 7.2 이번에 보완한 작은 변경

| 영역 | 발견 | 안전한 보완 |
|---|---|---|
| 키보드 접근성 | 전역 `Tab` 단축키가 브라우저 포커스 이동을 막고, `Space`가 포커스된 버튼과 일시정지를 함께 실행할 수 있었다. | 엔티티 이동 단축키를 `E`로 옮기고 입력 요소의 기본 키 동작을 보존했다. `:focus-visible` 표시와 E2E 회귀 검사를 추가했다. |
| 작은 화면 | 390px 폭에서 상단 제목·시나리오·제어 행이 겹쳤다. | 600px 이하에서 제목을 줄이고 제어/시나리오를 2열, 임무 카드를 전체 폭으로 재배치했다. |
| 연결 정보 노출 | query token이 포함된 Bridge URL을 HUD에 그대로 표시할 수 있었다. | 화면용 endpoint는 userinfo·query·fragment를 제거한다. 실제 URL에는 query token이 남을 수 있으므로 운영에서는 헤더/프록시 주입을 우선한다. |
| 외부 bind 인증 | 예제는 `0.0.0.0`인데 browser token과 origin allowlist는 선택 사항이었다. | loopback이 아닌 bind는 두 설정이 모두 없으면 시작 단계에서 거절한다. loopback 개발 모드만 무인증을 허용한다. |
| 가스 작업 정책 | 최신 무인 1.5m 작업점 정책과 과거 현장 spotter 설명·테스트가 충돌했다. | LOCAL은 무인 작업점, LIVE는 인증된 원격 EHS 허가+신선한 executor telemetry로 통일했다. 사람 진입 시 local/live 모두 작업을 중지하고 재관찰한다. A/B의 사람 직접 작업만 별도 비교 시나리오로 유지한다. |
| 시나리오 완결성 | 집결 완료, responder 후퇴, 의료 처치 시작 조건과 일부 테스트 기대가 실제 상태 전이와 어긋났다. | 비대피 responder를 집결 KPI에서 제외하고 통제 후 분산 후퇴를 추가했다. 환자 처치는 키트 인계와 2인 처치 자세가 모두 확인된 뒤 시작한다. |
| 가스 가시성 | 작은 저농도 입자가 설비 내부와 바닥에 묻히고 경보 카메라가 바로 광역 샷으로 전환해 유출원을 읽기 어려웠다. | 서비스 면 점멸 제트, 설비 위 5.8m 수직 플룸, 48개 반투명 입자를 추가하고 경보 첫 샷을 실제 누출점에 고정한 뒤 광역 대피로 전환한다. |
| 이동 충돌 | nav graph와 최종 몸체 이동이 렌더 시설 점유 경계를 공유하지 않아 설비·스토커·기둥을 가로지르거나 정지 로봇 뒤에서 교착될 수 있었다. | 렌더 치수 기반 공통 장애물 인덱스, graph node/edge 사전 제거, 몸체 반경별 swept 검사·측방 steering·재경로와 최종 분리 투영을 추가했다. 정지 로봇은 경로 비용으로 우회하고 근접 시 저속 측방 통과한다. |
| 대피 안내 | 휴머노이드가 경보 중 정지해도 안내 역할이 실루엣으로 드러나지 않았다. | 가스·화재 경보 중 조작/오류 상태가 아닌 휴머노이드가 점등 경광봉을 높이 들고 반대팔로 흐름을 지시한다. |
| 사람·휴머노이드 외형 | 몸통과 팔다리가 단순 원통·구체로 분절돼 Follow 근접 화면에서 나무토막/마네킹처럼 보였다. | 사람은 테이퍼 몸통·힙 셸·낮은 어깨·후드 봉제선·호흡기 그릴·손가락/엄지와 전완 연동 손 자세로 보강하고, 진한 관절 밴드를 방진복 봉제색으로 낮췄다. 휴머노이드는 링크 내부 명암 패널, 축소된 구형 관절, 3지+엄지 손과 분할 발을 같은 메시 안에 병합했다. 충돌 외피·작업 IK·사람 24 draw-call 구조는 유지했고, 소형 디테일을 저분할화해 사람 반복 형상을 약 81.5만→55.7만 triangles로 줄였다. |
| 산업 오브젝트 외형 | 설비·OHT·AGV·IGV·로봇팔이 큰 박스 위주이고, 화재·연기·의료 위치 표식도 원시 프리미티브처럼 보였다. | 설비에는 라운드 외피·전면 이음선·측면 환기구·공정별 상부 모듈을, 차량에는 범퍼·주행부·센서 덱·비콘·도킹 구조를 병합했다. 화염은 3-lobe, 가스·연기는 3구 cloudlet, 의료 위치는 회전 비콘·십자로 강화했다. 설비 디테일은 장비당 2개 복합 노드로 묶고 공용 라운드 지오메트리를 캐시해 초기 렌더 준비 시간을 약 2.7초로 유지했다. |
| 의료 역할 | 장애물 경로 갱신 뒤 최근접 배정만으로 H1이 의료 지원을 가져가 H2 안전 대응 역할과 문서가 어긋났다. | H2가 가용하면 의료 지원과 랑데부를 우선 배정하고, H2가 이미 사용 중일 때만 가장 가까운 유휴 기체로 대체한다. |
| 의존성 | 전이 의존성 `nanoid`, `brace-expansion` 취약점 2건이 보고됐다. | lockfile을 호환 패치 버전으로 갱신했고 `npm audit --omit=dev` 0건을 확인했다. |

### 7.3 현재 검증 근거

| 검증 | 2026-08-13 결과 |
|---|---|
| unit/integration | 9 files, 99 tests 통과. 시설·기둥 우회, 초기 차량·휴머노이드 외피 분리, 정지 waypoint 재경로, 집결 슬롯 차체 여유, 가스 로봇의 대피자 우선 양보, 실패 후퇴, 대피 유도 pose flag, 복합 외형·재난 FX, 의료 timeout 비해제 회귀 포함 |
| 통합 목적 시연 | 점검 이상 59.033초 → 가스 태스크 62.050초 → sensor verified 76.850초 → 정상 198.517초. 점검/격리 기체 분리와 `showcase` 출처 보존 |
| 위험작업 A/B | 사람 진입 1명·노출 9.767 person·sec·격리 39.683초, 휴머노이드 진입 1대·사람 진입/노출 0·격리 17.783초 |
| 가스/화재 | 기준 seed 가스 94명 174.300초 집결·182.267초 대형·185.283초 정상, 화재 219.267초 집결·227.450초 대형·230.467초 정상. 화재 안전정지 휴머노이드 앞 대피자는 감속 후 측방 통과 |
| 8-seed 대피 스트레스 | 화재 4시드 normal 230.467~268.000초, 가스 4시드 185.283~283.483초로 전 사례 300 sim초 안에 정상 복귀. 각 시드를 독립 프로세스로 병렬 실행해 fail-fast 사각지대 없이 전체 결과를 수집한다. |
| 의료 | H2 responder 확인 32.150초 → 키트 인계 33.683초 → 지원 완료 79.383초 → 의무실 인계 84.917초. 충돌 없는 랑데부·2인 처치·IGV 우선권 분리 |
| 사람 동작 | 화재/가스 모두 중첩 샘플 0, 순간 사람 최소 0.412/0.416m, 완성 대형 0.75m, 사람–로봇 최소 0.92/0.68m, 최대 가감속·회전 2.8 |
| 브라우저 E2E | degraded 전송 차단, live/trace RMF 권위, measured hand telemetry, 키보드 포커스, 3종 재난, 가스 플룸·경광봉, 단절 safeStop 통과. 보강된 설비·차량·PPE·휴머노이드·재난 FX 기준 draw call 통합 117·화재 117·의료 112·인계 118·가스 118(예산 150 미만) |
| 시뮬레이션 비용 | 448개체·1,800 tick 평균 5.131ms, p95 7.383ms, 최대 20.517ms. 시설·정지 로봇 회피 포함 p95 8ms 게이트 통과 |
| 정적·공급망 | lint/build 통과, production·전체 dependency audit 0건. 진입 316.62kB, 공용 protocol 84.82kB, 지연 로드 renderer 70.19kB, Worker 209.38kB, 격리된 Three.js 542.80kB |

재현 명령은 4절의 명령에 `npm audit --omit=dev`를 추가한다. 테스트가 검증하는 것은 결정론적
시뮬레이션과 참조 경계이며, 실제 GPU FPS·현장 네트워크·로봇 접촉력·PLC 인터록은 별도 실기
검증 대상이다.

### 7.4 사용자 시나리오 기준 잔여 위험

1. **P0 · 외부 기능 안전** — 실제 executor가 팔 제어 직전 허가를 재조회하고, 1.5m 침범·telemetry
   stale·네트워크 단절 때 물리적으로 정지하는지 PLC/로봇 로그로 증명해야 한다. 현장 좌표
   calibration과 출입 권한도 이 저장소 밖이다.
2. **P1 · 운영 보안** — WebSocket query token은 브라우저 history·프록시 access log에 남을 수
   있다. `/healthz`, `/readyz`도 운영 정보를 노출하므로 TLS reverse proxy에서 네트워크 범위와
   로그 마스킹을 강제한다. Bridge 상태는 메모리 기반이라 재시작 감사 연속성이 필요하면 외부
   영속 저장소를 연결한다.
3. **P2 · 정보 밀도** — 모바일 주요 조작은 40px 높이, 증거 라벨은 최소 7px로 보완했지만
   장시간 관제·터치 사용에는 여전히 조밀하다. 모바일은 보조 확인 화면으로 보고, 핵심 경보의
   색 대비와 전체 키보드 순서를 실제 보조기기에서 별도 접근성 시험으로 확정한다.
4. **P2 · 초기 로딩** — 정적 진입 chunk는 약 992kB에서 400kB로 줄었고 renderer/Three.js를
   지연 로드한다. 다만 단일 Three.js vendor chunk 539.75kB(134.84kB gzip)는 남으므로 저속망의
   최초 3D 표시 시간은 목표 장비에서 측정해야 한다. 현재 SwiftShader 1280×800 개발 환경에서는
   공용 라운드 지오메트리 캐시와 설비 디테일 노드 병합 후 준비 완료 UI를 약 2.7초에 관측했다.

### 7.5 후속 소규모 개선

- Google Fonts 런타임 요청을 제거해 오프라인 시연의 글꼴 지연과 외부 referrer 노출을 없앴다.
- production build가 주입하는 문서 기본 CSP, `no-referrer`, 개발/preview의
  CSP·COOP·COEP·`nosniff`·Permissions-Policy를 추가했다. 개발 CSP만 React HMR 초기화에 필요한
  inline script를 허용하며 production/preview는 허용하지 않는다. 운영 정적 호스트도 같은 응답
  헤더를 배포 설정에서 유지해야 한다.
- RMF 연결·비상 단계·preflight·운영 로그에 live-region 의미를 추가하고 선택형 버튼에
  `aria-pressed`를 제공했다. 장식용 WebGL canvas는 접근성 트리에서 제외한다.
- 600px 이하 주요 버튼은 최소 40px, 증거 텍스트는 최소 7px로 올렸고 감소 모션 설정에서는
  HUD의 점멸·회전·transition을 억제한다. E2E가 390×844 viewport에서 이를 회귀 검사한다.
- Three.js 렌더러를 동적 import하고 Three.js를 독립 vendor chunk로 분리했다. 시뮬레이션 준비와
  renderer 로드를 모두 마친 뒤 HUD를 열며, renderer import 실패는 무한 빈 화면 대신 재로드
  안내를 표시한다.

## 8. 2026-08-13 전체 저장소 재점검

### 8.1 범위와 신뢰 경계

추적·미추적 제품 파일 110개(그중 TypeScript/TSX 77개)와 문서, JSON 시나리오, Bridge, 테스트를
다시 대조했다. 이 감사 문서 자체를 제외한 현재 작업 트리 digest는
`846fbcec5bc0ec8de506613935243f4ca0d4c6001f5fa1beee5616e2b662afdd`다. Architect CLI
0.2.0-dev snapshot `sha256:b516964ff36b60592277b04b7dd2813ba54ab7cc0b23f9199c5c57eb00b2e1a6`는
176개 후보 중 Kubernetes/YAML 2개만 분석하고 174개를 건너뛰어 TypeScript 구조 추출에는
불충분했다. 따라서 import·상태 전이·입력 경계 직접 추적과 실행 검증을 주 근거로 사용했다.

이 감사는 브라우저 시뮬레이터, Web Worker, 참조 RMF Bridge와 trace 경계까지만 다룬다. 실제
ROS graph, 로봇 제어기, PLC, 출입 통제, 배포 네트워크는 저장소에 없으므로 운영·기능 안전
승인으로 확대 해석하지 않는다.

### 8.2 사용자 여정 평가

| 사용자 여정 | 평가 | 근거와 남은 문제 |
|---|---|---|
| 평시 관찰·설비 점검 | 양호 | 448개체 운영 상태, 개체 Follow, 점검 태스크와 증거 사슬이 연결된다. 다만 첫 사용자 온보딩이 없고 개체 목록은 첫 30개만 보여 전체 탐색성이 낮다. |
| 가스 유출 대응 | 양호 | 누출원 FX, 대피, EHS 허가, 무인 작업점, 밸브·센서 검증, 실패 후퇴까지 원인-결과가 이어진다. |
| 화재 대피 | 부분 | 기준 seed 77은 완주하고 충돌 샘플 0이지만, 다중 seed 스트레스의 seed 1에서는 정지 AGV와 밀집 집결 대형 때문에 300 sim초 내 정상 복귀하지 못한다. |
| 의료 대응 | 양호 | H2 키트 인계, 2인 처치, IGV 이송과 의무실 인계가 이어진다. 90초 초과는 지휘 확인 경고만 내고 실제 이송 완료 전에는 해제하지 않도록 수정했다. |
| LIVE RMF·TRACE·단절 | 양호(참조 경계) | preflight 차단, EHS 허가, 신선한 executor telemetry, reload 복구, 단절 safe-stop을 Bridge/trace E2E로 확인했다. 실기는 별도 검증 대상이다. |
| A/B 위험작업 비교 | 양호 | 동일 조건 두 실행의 원시 관측값을 표시한다. 완료 후 결과를 유지한 채 다시 실행할 수 있게 했다. |
| 오류·재시작·접속 | 개선됨 | 시나리오는 항상 1×로 시작하고 렌더러 로드 실패에 재로드 버튼이 있다. 개발 서버는 LAN 시연을 위해 `0.0.0.0`에 bind한다. |

기능 데모로서는 원인·행동·안전 증거가 충분하지만, 영화적 각본으로는 아직 부분 완성이다.
phase cue의 `duration`을 일반 태스크 샷으로부터 보호하도록 연결했으나, 사용자 카메라 개입 후
디렉터 복귀, 화재 클라이맥스·의료 이송 전용 샷, 음향·내레이션·자막 큐는 없다. 새 기능을 크게
추가하지 않는 이번 범위에서는 문서의 과장된 포인터락·팬·씬 더블클릭·1인칭 충돌 주장을 실제
구현 수준으로 낮췄다.

### 8.3 이번 소규모 보완

| 영역 | 보완 |
|---|---|
| 시나리오 안전 | 의료 90초 timeout의 강제 `allClear`를 제거하고 지휘 확인 경고만 유지했다. 시나리오 버튼은 이전 pause/16× 상태를 이어받지 않고 1×로 시작한다. |
| 카메라 UX | JSON `cameraCues[].duration` 동안 일반 assignment 샷의 덮어쓰기를 막았다. 개체 선택은 Follow 상태를 HUD와 동기화하고, Follow 드래그로 Orbit이 되면 활성 버튼도 함께 바뀐다. |
| 반복 사용 | A/B 완료 버튼을 활성화해 같은 조건을 다시 실측할 수 있게 했다. 렌더러 import 실패에는 실행 가능한 재로드 버튼을 제공한다. |
| 개발 접속 | Vite dev를 `0.0.0.0`에 bind하고 LAN URL·방화벽·포트 전달·공용망 비노출 주의를 README에 추가했다. |
| 공급망 재현성 | `latest` 직접 의존성을 현재 lockfile의 정확한 버전으로 고정했다. lockfile 해석 결과는 바뀌지 않는다. |
| 문서 정확성 | Tailwind 미사용, 현재 카메라 입력·1인칭 한계, 의료 timeout, cue duration의 실제 의미를 코드와 맞췄다. |
| 테스트 안정성 | 시나리오 1× 초기화 뒤 가스 중간 프레임을 0.5×로 관측하게 했고, Bridge telemetry freshness 안에 executor callback을 먼저 보내도록 E2E 순서를 수정했다. 안전 기대값은 낮추지 않았다. |

### 8.4 보안 결론

저장소 안에서 즉시 악용 가능한 치명적 취약점이나 커밋된 실제 비밀정보는 확인하지 못했다.
production·전체 의존성 모두 `npm audit` 알려진 취약점 0건(총 212 dependency)이었고,
Architect의 네 건 `POSSIBLE_SECRET`은 문서 placeholder와 테스트 token이었다. Bridge는 비-loopback
bind의 browser token·origin allowlist 강제, 64KB WebSocket payload, 16KB JSON body, zod 입력,
Bearer token 상수시간 비교, socket당 rate limit, 허가·telemetry freshness·단조성 gate를 둔다.

잔여 운영 위험은 유지된다. query token은 history/proxy log에 남을 수 있고, 인증 없는
`/healthz`·`/readyz`는 상태를 노출하며, TLS·전체 연결 수 제한은 reverse proxy 책임이다. 사용자가
지정할 수 있는 `rmf`/`rmfTrace` 원격 주소와 외부 trace 배열 크기도 브라우저 자원 고갈 관점의
상한이 없다. 이는 현재 코드의 치명적 exploit로 확인된 것은 아니지만, 운영 배포 전에 URL
allowlist·응답 크기/이벤트 수 제한을 두는 편이 안전하다.

### 8.5 현재 실행 증거

| 검증 | 결과 |
|---|---|
| lint / unit·integration | 통과 / 9 files, 99 tests 통과. 초기 겹침·정지 로봇 재경로·가스 대피 우선권·의료 timeout 비해제 회귀 포함 |
| acceptance | 통과. 통합 시연 정상 198.517초, 의료 의무실 인계 84.917초, 차량 간섭 0 tick, 동일 simTime counterfactual 60초 대비 복구 처리량 99.6% |
| 사람 동작 감사 | 통과. 화재/가스 겹침 샘플 0, 집결 최소 0.75m, 사람–로봇 최소 0.953/0.68m |
| 시뮬레이션 benchmark | 448개체·1,800 tick 평균 5.131ms, p95 7.383ms, 최대 20.517ms |
| Chromium 제품 E2E | 통과. 카메라 상태 동기화·시나리오 1×·의료·가스·A/B 재실행·모바일 포함, draw call 최대 118/150 |
| RMF Bridge / trace E2E | 둘 다 통과. dispatch·EHS·executor telemetry·reload·단절 safe-stop·trace heartbeat 포함 |
| build | 통과. 진입 316.62kB, renderer 70.19kB, Worker 209.38kB, Three.js 542.80kB |
| 8-seed 대피 stress | 통과. 화재 seed 1/19/77/999 normal 255.000/256.267/230.467/268.000초, 가스 seed 2/42/314/1001 normal 283.483/185.283/197.550/260.067초 |

화재 즉시 정지 차량은 현재 위치를 권위 pose로 유지하되, 사람은 정지 차체 주변 graph node 비용과
시설 swept-circle 가시성을 함께 확인해 재경로한다. 가스 차량은 서로 분리된 안전 주차 노드를
예약하고 집결 슬롯도 정지 차체 외피를 제외한다. 남은 기능 안전 과제는 실제 로봇·PLC·출입 통제와
현장 좌표에서 이 소프트웨어 경계를 실기 검증하는 일이다.
