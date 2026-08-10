# FabWorld

반도체 팹(Fab) 내부를 브라우저에서 실시간 3D(WebGL)로 시뮬레이션하고,
Open-RMF가 운영하는 휴머노이드의 설비 점검·현장 대응 가치를 시연하는 프로젝트.
설비, OHT, AGV, IGV, 사람이 상호작용하며 일하는 팹을 재현하고,
**재난/비상 상황(가스 유출·화재·응급 환자) 시 인간-로봇 협업 대응**을 연출한다.

## 특징

- 서버 없는 클라이언트 단독 실행 — 시뮬레이션은 Web Worker, 렌더링은 Three.js
- 448개 개체 60fps 목표 (인스턴싱 + SharedArrayBuffer pose 파이프)
- 결정적(deterministic) 시뮬레이션, 일시정지/배속(0.5×~16×)
- Orbit / Follow / 1인칭(탑승·워크스루) 카메라
- JSON 데이터 기반 레이아웃·시나리오 (zod 스키마)

## 설계 문서

[docs/00-overview.md](docs/00-overview.md)부터 순서대로. 전신인 `fab-simulator`의
분석과 교훈이 개요 문서에 정리되어 있다.

## 실행

Node.js 22 이상에서 다음 명령으로 실행한다.

```bash
npm install
npm run dev
```

실제 Open-RMF 연계용 참조 Bridge는 별도 프로세스로 실행한다.

```bash
RMF_BRIDGE_CONFIG="$PWD/services/rmf-bridge/config.example.json" \
FABWORLD_BRIDGE_TOKEN="<16자 이상의 token>" \
RMF_INGEST_TOKEN="<16자 이상의 callback token>" \
npm run bridge:rmf
```

RMF-Web 주소·좌표계·Fleet Adapter action 설정과 보안 구성은
[docs/12-rmf-bridge-deployment.md](docs/12-rmf-bridge-deployment.md)에 정리되어 있다.

Bridge 없이 정규화된 Open-RMF 이벤트를 같은 wall-clock 시간축으로 재생하는 참조 모드는
다음 URL로 실행한다. HUD의 `REPLAY`는 `LIVE`와 명확히 구분되며, 내장 trace는 합성 참조
데이터이지 실제 로봇 기록이 아니다.

```text
http://localhost:5173/?rmfTrace=reference
```

현장 Bridge 이벤트를 실제 trace로 기록하려면 다음 명령을 사용한다.

```bash
npm run record:rmf -- \
  'wss://bridge.example/fabworld?token=...' \
  ./private/site-rmf-trace.json \
  --duration 90 --name 'Site acceptance run'
```

RMF map과 FabWorld 좌표는 측정점 파일로 자동 보정할 수 있다.

```bash
npm run calibrate:rmf -- services/rmf-bridge/calibration.example.json --max-error 0.25
```

전체 검증은 다음과 같다.

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

## 구현 상태

- 6×12 베이, 324개 설비를 담은 커밋된 JSON 레이아웃과 생성 스크립트
- Web Worker 고정 60Hz 시뮬레이션, 결정적 시드 RNG, SharedArrayBuffer/메시지 폴백 Pose 파이프라인
- OHT·AGV·IGV·휴머노이드·작업자·로봇암 448개체, 경로 그래프·A* 위험 회피·사람 우선 교통 제어
- Open-RMF Bridge 계약, 실제 RMF pose 권위 모드, 목적 기반 휴머노이드 태스크 상태머신
- Worker가 해석한 작업 접근점을 실제 RMF nav waypoint와 target pose로 결합해
  `go_to_place → perform_action`으로 스케줄링하고, 의료 실물 인계·가스 격리 센서 확인
  콜백으로 현장 상태를 전환
- 일반 점검의 `reporting`은 재난을 만들지 않는다. 통합 시연은 Fleet Adapter가 인증된
  `inspection_anomaly_reported`를 보고한 경우에만 가스 사건과 RMF 재조율을 시작한다.
- WebSocket 연결과 실제 RMF readiness를 분리한다. map/location/pose freshness가 정상이기
  전에는 브라우저 버튼과 Bridge 서버가 새 dispatch를 이중 차단하고, 시작 버튼 아래 preflight에
  robot 정규화 수·map·pose age·poll 지연 또는 정확한 차단 원인을 표시한다.
- EHS 작업허가 발급·철회·executor 조회 계약. live 가스 조작은 인증된 원격 허가와
  1.5m 밸브 작업점 무인 확인 없이는 Bridge 콜백과 화면 팔 동작
  모두 게이트된다. LIVE/TRACE의 양손 접촉·팔 진행률·밸브 위치·가스 농도는 태스크 경과시간이
  아니라 action executor 텔레메트리가 직접 구동하고, 선택적 `base_link` 양손 말단 위치는
  화면의 양팔 IK까지 직접 구동한다. 1.5초 동안 새 샘플이 없으면 마지막
  관절·밸브 상태를 유지한 채 `safeStop`하고, verified 텔레메트리 없이는 최종 격리 콜백도
  거절한다. 허가 뒤 사람이 작업점에 진입해도 즉시 관찰 단계로 중지하며, 브라우저 새로고침·
  WebSocket 재접속 시 진행·완료 태스크의 제한된 권위 이력과 비상 상태·허가 증거를 Bridge
  스냅샷으로 복구한다. 복원 이벤트는 과거 로그·카메라 연출을 새 사건처럼 재생하지 않는다.
- RMF가 다른 FabWorld 태스크에 이미 연결된 booking id를 재사용하면 상관관계를 덮어쓰지 않고
  `rmf_booking_collision`로 거절하며 Bridge readiness를 `degraded`로 전환
- 검증된 RMF trace 기록/재생, reference/recorded 표시, wall-clock pose/action heartbeat와 task id 재매핑
- 관절형 휴머노이드와 cleanroom 후드·마스크·장갑·안전화·2절 팔다리를 가진 인스턴스드 작업자 렌더링,
  휴머노이드 지지기/스윙기 분리·다리 IK·수평 발바닥, 제한된 가감속·회전·개인 공간·
  인지 제스처·쓰러짐 및 장비 여유를 고려한 안전거리 확보. 사람마다 고정된 평시/비상 보행
  속도와 역할별 경보 반응 시차를 사용하고, 움직일 수 없는 `safeStop`·외부 RMF 로봇은 감속과
  측방 회피로 통과하면서 최소 0.68m 중심 간격을 유지
- 설비 공정/반송 배경 활동, 인스턴스드 상태등, 재난별 국소 HOLD·복구
- 가스 유출·화재·응급 환자 시나리오와 역할별 대응. operator는 loadport, engineer는 service
  face를 점검하고 responder는 평시에 권역별 대응 거점에서 대기한다. 비상 시에는 위험·수용량
  기반 집결지와 0.75m 격자 슬롯을 사용
- 가스는 시간 경과로 자동 해제하지 않고 `밸브 접촉 → 폐쇄 위치 도달 → 가스 센서 안정 확인`
  순서가 끝나야만 통제된다. 현장 인원을 스포터로 잔류시키지 않고, 원격 EHS 허가와
  밸브 작업점 1.5m 안 사람 0명을 확인해야 조작이 시작된다.
  허가 뒤 침범에도 조작을 중지하고, 폐쇄 후 잔류 농도를 교차 확인한다.
  휴머노이드는 0.75m 서비스 면 정밀 접근·5cm pose 게이트·양손 2-link IK로 실제 휠 표면
  접촉을 표현한다.
- 시나리오 seed 기반 새 월드 재현, 의료 키트 랑데부·시선 확인·양팔 대면 인계·1.2초 수령
  유지·2인 무릎 처치·구조요원 소유권 이전·IGV 의무실 이송
- Three.js 인스턴싱 기반 팹 렌더링, Orbit/Follow/1인칭 카메라, 비상 FX. 출구가 실제로 열린
  외벽과 외부 서비스 에이프런, 유도선·개별 슬롯 표식·한/영 표지판이 있는 집결지를 전용
  사선 카메라로 함께 렌더링
- React HUD의 시간 제어, 카메라·개체 추적, 시나리오 발동, 이벤트 로그·성능 계측. 2대
  휴머노이드의 배터리·SIM/TRACE/RMF/NO POSE 권위·현재 활동·task id·pose age를 Worker 운영 상태에서
  250ms마다 갱신하는 플릿 보드 포함
- 태스크 단계별 “왜 휴머노이드인가” 가치 문구, 가림 없는 관찰·조작 자동 카메라, 2.2m 협업 거리 및 대피 대형 완성 샷.
  통합 시연은 재실행 시 기존 RMF 태스크를 취소하고 하나의 새 사슬만 만들며,
  `실제 배정 로봇의 현장 점검 → 명시적 이상 보고 → RMF 재조율 → 별도 로봇 격리 배정`
  원인을 뒤의 안전 증거와 분리해 표시
- LOCAL DEMO 전용 위험작업 A/B 실측. 같은 seed에서 사람·휴머노이드 대응 거점의 최대 접근
  거리가 가장 작은 위험원을 선택하고, 방재요원 직접 조작 장면을 완료한 뒤 같은 설비·밸브·
  조작/검증 시간으로 월드를 새로 만들어 휴머노이드 투입을 재생한다. 두 실행의 실제 distinct
  진입 수, 사람 작업점 person·seconds, 격리 시간을 모두 표시하므로 유리한 값만 선택하지 않는다.
- 임의 절감액 대신 실제 상태에서 계산한 `허가 후 작업점 human/humanoid 투입·EHS 허가 권위·센서 검증 후 격리`
  임무 효과 KPI와 `OPEN-RMF → EHS → HUMANOID → PLC/GAS` 책임 주체별 증거 사슬.
  데모 실패 주입 시 이미 통과한 게이트는 보존하고 실패한 센서 게이트를 적색으로 표시하며,
  위험원을 미통제로 유지하고 로봇이 후퇴한 뒤 EHS 수동 대응에 인계하는 전용 구도

`data/layouts/fab-default.json`은 런타임의 레이아웃 SSOT다. 수정이 필요하면
`npm run generate:layout`으로 재생성한 뒤 결과 JSON을 검토한다.

현재 구현과 설계 문서의 추적표, 자동 검증 수치, 실제 Open-RMF/실기 환경에서 남은 항목은
[docs/11-implementation-audit.md](docs/11-implementation-audit.md)에 정리되어 있다.
