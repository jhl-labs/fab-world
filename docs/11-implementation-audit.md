# 11 — 구현 추적 및 검증 보고서

최초 기준일: 2026-07-31  
최신 재감사: 2026-08-11

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
| 교통·안전 | 공간 해시, 사람 우선, headway, 응급 우선권, 양보 교착 해소, 움직일 수 없는 `safeStop`·외부 RMF 로봇 선제 감속·측방 회피와 0.68m 외피 | [`trafficSystem.ts`](../src/sim/systems/trafficSystem.ts), [`movementSystem.ts`](../src/sim/systems/movementSystem.ts) |
| 재난 | 단계 상태머신, graph hazard 비용, 개인별 평시/비상 속도·역할별 경보 인지 시차와 방향 확인, 권역별 responder 스테이징, 수용량 기반 집결지·0.75m 슬롯 배정, 개인 공간·시설 측 확인 방향까지 포함한 대형 완성 게이트, 무경로 안전 정지, 통제 후 responder 분산 후퇴, 국소 설비 HOLD, 의료 처치·IGV 이송 | [`population.ts`](../src/sim/population.ts), [`world.ts`](../src/sim/world.ts), [`movementSystem.ts`](../src/sim/systems/movementSystem.ts), [`emergencySystem.ts`](../src/sim/systems/emergencySystem.ts), [`equipmentSystem.ts`](../src/sim/systems/equipmentSystem.ts) |
| 휴머노이드 | 분리된 운영/안전 스테이징, 점검 담당 작업자 예약·인계, 안전거리 협의 후 저속 정밀 접근, 점검·의료 지원, 안전감시자 집결·작업허가·1.5m 무인 작업점→접촉→밸브 폐쇄→휴대용 검지기 모니터링→센서 확인형 가스 격리, 침범 시 local/live 중지·재확인, 실패 시 미통제 유지·로봇/감시자 분리 후퇴·EHS 인계 | [`humanoidSystem.ts`](../src/sim/systems/humanoidSystem.ts), [`movementSystem.ts`](../src/sim/systems/movementSystem.ts), [`personSystem.ts`](../src/sim/systems/personSystem.ts), [`targeting.ts`](../src/sim/targeting.ts) |
| 위험작업 A/B | LOCAL 전용 순차 비교, 사람/로봇 거점 균형 위험원 선택, 방재요원 직접 양손 조작·별도 검지 감시, 동일 seed/source/valve/6.2초 작업으로 새 월드 재생, 양쪽 진입·person·seconds·격리 시간 동시 표시 | [`sim/worker.ts`](../src/sim/worker.ts), [`sim/world.ts`](../src/sim/world.ts), [`personRenderer.ts`](../src/render/agents/personRenderer.ts), [`ui/Hud.tsx`](../src/ui/Hud.tsx) |
| Open-RMF 경계 | zod 검증 이벤트, 공개 RMF-Web REST 참조 Bridge, Worker 목표 해석, FabWorld→RMF target pose 역보정과 map 누락/중복 거절, 현장 nav waypoint 최근접·반경·동률 검증, `compose(go_to_place→perform_action)`, 브라우저·Bridge 이중 readiness dispatch 게이트와 in-flight booking 취소, terminal state 비부활, 일반 점검 reporting과 명시적 `inspection_anomaly_reported` 분리, 의료 인계, 인증된 EHS 작업허가 발급·철회·executor 조회, 양손 접촉·팔 진행·밸브 위치·가스 농도·센서 안정·`base_link` 양손 말단 위치 action telemetry의 schema/도달범위/밸브 접촉잔차/단조성/1.5초 freshness와 최종 callback 게이트, 구독 시 현재 비상·태스크·허가·telemetry 스냅샷 복구, 측정점 기반 map calibration, wall-clock pose 보간·stale 폐기, task 단계 보존 heartbeat, map/location/pose/action 진단, 인증·취소·재연결·단절 safeStop, telemetry 포함 trace recorder/player | [`integrations/rmf/client.ts`](../src/integrations/rmf/client.ts), [`integrations/rmf/trace.ts`](../src/integrations/rmf/trace.ts), [`rmf-bridge/server.ts`](../services/rmf-bridge/server.ts), [`rmf-bridge/traceRecording.ts`](../services/rmf-bridge/traceRecording.ts), [`sim/world.ts`](../src/sim/world.ts) |
| 렌더링 | Three.js 인스턴싱, cleanroom 후드·마스크·장갑·안전화와 팔꿈치/무릎이 있는 작업자, responder 전용 화학 대응 색·헬멧, 휴대용 가스 검지기와 상태 화면, 지지기/스윙기 발 목표·2-link 다리 IK·수평 발바닥을 가진 휴머노이드 보행, 휠 서비스 면과 팔 길이를 공유하는 양손 IK·재그립, 의료 확인/양팔 수령/무릎 처치 자세, 단일 draw-call 접지 그림자, 조작 연동 밸브, 안전거리 cue·순간 설비 투시, 밸브·양손·검지기를 함께 담는 가스 협업 카메라, 밸브와 양측 후퇴 목표를 담는 실패 카메라·붉은 분리선, 인계·처치 3자 카메라, 열린 비상구·외부 에이프런·유도선·슬롯 링·한/영 표지를 함께 담는 집결 사선 카메라, 3종 FX | [`interactionGeometry.ts`](../src/core/interactionGeometry.ts), [`humanoidGait.ts`](../src/render/agents/humanoidGait.ts), [`render/engine.ts`](../src/render/engine.ts), [`render/world/fabScene.ts`](../src/render/world/fabScene.ts), [`limbIk.ts`](../src/render/agents/limbIk.ts), [`personRenderer.ts`](../src/render/agents/personRenderer.ts), [`humanoidRenderer.ts`](../src/render/agents/humanoidRenderer.ts), [`interactionCue.ts`](../src/render/fx/interactionCue.ts), [`shotPlanner.ts`](../src/render/camera/shotPlanner.ts), [`safetyDeviceAnimator.ts`](../src/render/world/safetyDeviceAnimator.ts) |
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
| 위험작업 A/B | 같은 `20260729` seed의 거점 균형 위험원 `lithography-001`, 동일 `gas-valve-west`, 동일 6.2초 조작/검증. 사람 직접 조작은 human 1명·7.683 person·sec·32.533초, 휴머노이드는 human 0명/humanoid 1대·0 person·sec·16.750초. 두 실행의 별도 양손 작업 장면과 최종 비교 카드 Chromium 검증 |
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

## 7. 2026-08-11 전체 UX·기능·보안 재감사

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
| 의존성 | 전이 의존성 `nanoid`, `brace-expansion` 취약점 2건이 보고됐다. | lockfile을 호환 패치 버전으로 갱신했고 `npm audit --omit=dev` 0건을 확인했다. |

### 7.3 현재 검증 근거

| 검증 | 2026-08-11 결과 |
|---|---|
| unit/integration | 7 files, 86 tests 통과 |
| 통합 목적 시연 | 점검 이상 18.517초 → 가스 태스크 21.533초 → sensor verified 34.633초 → 정상 169.867초 |
| 위험작업 A/B | 사람 진입 1명·노출 7.75 person·sec·격리 35초, 휴머노이드 진입 1대·사람 진입/노출 0·격리 16.083초 |
| 가스/화재 | 가스 94명 156.067초 집결, 화재 94명 259.750초 집결·269.183초 정상 복귀 |
| 8-seed 대피 스트레스 | 화재 237.933~259.750초 집결·246.433~269.183초 정상, 가스 155.367~268.000초 집결·165.500~276.367초 정상. 모든 실행 94명 완료 |
| 의료 | responder 확인 5.550초 → 키트 인계 7.883초 → 지원 완료 16.967초 → 의무실 인계 78.767초, 차량 간섭 0 |
| 사람 동작 | 화재/가스 모두 중첩 샘플 0, 완성 대형 0.75m 간격, 사람–휴머노이드 최소 0.68m |
| 브라우저 E2E | degraded 전송 차단, live RMF 태스크 권위, measured hand telemetry, 키보드 포커스, 3종 재난, 단절 safeStop 통과. draw call 최대 148/150 |
| 시뮬레이션 비용 | 448개체·1,800 tick 평균 1.919ms, p95 2.324ms, 최대 7.353ms. p95 8ms 게이트 통과 |
| 정적·공급망 | lint/build 통과, production dependency audit 0건. 메인 chunk 약 992kB로 분할 경고는 남음 |

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
3. **P2 · 정보 밀도** — 목표 1280×800에서는 조작 가능하지만 HUD의 작은 글자와 조밀한 정보는
   장시간 관제·터치 사용에 충분하지 않다. 모바일은 보조 확인 화면으로만 보고, 핵심 경보/태스크
   조작의 최소 터치 크기와 대비를 별도 접근성 시험으로 확정한다.
4. **P2 · 초기 로딩** — 약 992kB 메인 JavaScript chunk는 저속 네트워크와 캐시 실패 때 첫 화면을
   늦출 수 있다. 기능 변경 없이 Three.js와 운영 패널을 지연 분할하는 후속 최적화가 적합하다.
