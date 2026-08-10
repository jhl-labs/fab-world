# 09 — 구현 로드맵

각 마일스톤은 **눈으로 확인 가능한 데모**를 산출한다. 성능 게이트(60fps)는 M2부터 상시 측정.
`[x]`는 현재 저장소에서 자동 테스트 또는 브라우저 시연으로 확인한 항목이다.
`🟡`은 핵심 경로는 구현했지만 원 설계의 세부 항목이 남은 상태다.

## M0 — 골격 (기반 공사)

- [x] Vite + TS strict + vitest + ESLint(계층 의존 규칙: `core←sim`, `core←render` 강제)
- [x] `core/schema` FabLayout·Scenario zod 정의
- [x] `scripts/generate-layout.ts` → `data/layouts/fab-default.json` 생성 (6×12 베이)
- [x] `core/layout` 로더 + 3중 nav 그래프 빌드 + 의미 검증 (+유닛 테스트)
- [x] Worker 부트스트랩 + SharedArrayBuffer/transferable PoseBuffer 왕복
- **데모: 회색 바닥 위에 박스 1개가 움직인다. Worker↔Main 파이프 검증 완료.**

## M1 — 정적 팹 씬

- [x] 바닥/벽/기둥/천장 조명 패널 정적 씬
- [x] 베이 + 공정 설비 9종과 stocker → 타입별 InstancedMesh
- [x] OHT 레일 병합 렌더
- [x] 기본 조명 시스템 + 공정 색채 팔레트
- [x] Orbit 카메라
- **데모: 팹 전경과 동적 운영 개체가 보인다. 전체 통합 시연 draw call 91, 예산 150 미만 확인.**

## M2 — 개체와 이동

- [x] OHT 레일 크루즈 + 공간 해시 headway (+결정성/headway 테스트)
- [ ] 🟡 AGV/IGV A* 주행 완료, 차선별 레인 오프셋은 미구현
- [x] personSystem 순회/설비 점검 + 인스턴스드 관절 애니메이션
- [ ] LOD 3단계 + 프레임 분산 + AdaptiveQuality
- [x] 배속/일시정지 (tick 반복 방식) + HUD 시간 컨트롤
- **성능 게이트: 450개체 @60fps (미들 GPU), sim tick < 8ms. 미달 시 다음 단계 진입 금지.**
- **데모: 수백 대가 흐르는 살아있는 팹. 16× 배속 재생.**

## M3 — 물류 루프 (팹이 일한다)

- [x] equipmentSystem 상태머신 + 프로세스 윈도우 + 인스턴스드 상태등 + 재난별 국소 HOLD/복구
- [x] missionSystem: 캐리어 반송 미션 (loadport→stocker), OHT 호이스트 연출
- [ ] 🟡 trafficSystem 사람 우선·headway·데드락 재경로 완료, 교차점 티켓은 미구현
- [ ] 🟡 Follow / FirstPerson(Ride·Walk) 카메라 완료, 포인터락·벽 충돌은 미구현
- [x] 개체 선택 + 태스크/상태 HUD
- **데모: 캐리어가 설비 사이를 오가고, 1인칭으로 OHT에 탑승해 본다.**

## M4 — 재난 시나리오 ★ 핵심 가치

- [x] emergencySystem: 단계 상태머신 + 존 hazard + nav 비용 연동
- [x] 시나리오 엔진 (트리거/액션) + 3종 시나리오 JSON
- [ ] 🟡 역할별 핵심 행동 완료, 화재 접근로 예약·설비별 hold 세분화는 미구현
- [ ] 🟡 가스 볼륨·화염·연기·응급 마커 완료, 대피 유도 라인·사이렌 링은 미구현
- [ ] 🟡 cameraCues 단계별 자동 샷 완료, 사용자 개입 후 디렉터 재개 정책은 미구현
- [x] 상황판 HUD (대피 인원, 경과 시간, 안전 정지, 휴머노이드 작업, 처리량, 이벤트 로그)
- [x] 반응 시차·수용량 기반 안정적 집결지 배정·무경로 안전 정지·통제 후 responder 분산 후퇴
- [x] 보행 가감속·회전·개인 공간, 권역별 responder 스테이징, 0.75m 집결 슬롯·대형 완성 게이트·결과 카메라
- [x] 수용 기준 자동 테스트 (`npm run test:acceptance`)
- **데모: 버튼 하나로 가스 유출 → 감지 → 대피 → 복구 전 과정이 자동 연출된다.**

## M5 — 폴리시 & 배포

- [ ] 🟡 로딩 스플래시 완료, high 프로파일 SMAA/bloom은 미구현
- [ ] 🟡 SAB 불가 환경 postMessage 폴백 완료, 실제 내장 GPU 30fps 검증은 미완료
- [ ] 🟡 Playwright 기능·draw-call E2E 완료, CI 성능 트레이스·스크린샷 회귀는 미구현
- [ ] 정적 호스팅 배포 (COOP/COEP 헤더 설정 포함)

## M6 — Open-RMF 휴머노이드 시연

- [x] 휴머노이드 엔티티·목적 기반 태스크 상태머신
- [x] 설비 점검 → 이상 보고 → 가스 격리 통합 시연
- [x] 정규화 RMF Bridge WebSocket 계약과 live pose 권위 모드
- [x] 관절형 휴머노이드 보행·관찰·조작·보고 렌더링
- [x] 인스턴스드 작업자 보행·대피·인지 제스처·응급 자세 렌더링
- [x] 사람-휴머노이드 안전거리·양보 상호작용
- [x] 장비 점유 여유를 반영한 양보점 선택, 안전 반경·거리선, 가림 회피 작업 카메라
- [x] 통합 시연 태스크의 live RMF 왕복 배정과 재연결 대기 큐
- [x] 일반 점검 reporting과 명시적 anomaly 증거 분리, category/stage callback gate
- [x] 실제 점검/격리 배정과 배터리·권위·task·pose age를 표시하는 2대 플릿 보드
- [x] 시나리오 전환 task cancel 및 RMF 단절 시 외부 제어 로봇 safeStop
- [x] 공개 RMF-Web REST API용 참조 Bridge, 인증·health probe·action/emergency ingest
- [x] 현장 navigation waypoint 검증과 `go_to_place → perform_action` RMF 일정 계약
- [x] 정규화 RMF trace 스키마·현장 recorder·wall-clock 재생·Reference/Recorded UI 구분
- [x] 정지 pose heartbeat 중 관찰/조작/보고 단계 권위 보존과 task 종료 후 idle heartbeat
- [ ] 실제 휴머노이드 Fleet Adapter와 좌표·태스크 end-to-end 연결
- [ ] 실기 보행/팔 동작 로그 기반 애니메이션 타이밍 보정
- [ ] 현업 안전 절차 검토와 시연 승인

## 운영 원칙

1. **성능은 기능이다**: 매 마일스톤 종료 시 `?stats=1` 수치를 README에 기록. 회귀 시 기능 추가 중단.
2. **파일 500줄 상한**: 리뷰에서 강제. God 파일 재발 방지.
3. **sim은 테스트 없이 머지 금지**: 렌더는 스크린샷, sim은 유닛 테스트.
4. 커밋 단위 = 체크박스 단위. 각 마일스톤 데모는 태그로 남긴다 (`m1-static-fab` 등).
