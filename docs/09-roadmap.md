# 09 — 구현 로드맵

각 마일스톤은 **눈으로 확인 가능한 데모**를 산출한다. 성능 게이트(60fps)는 M2부터 상시 측정.

## M0 — 골격 (기반 공사)

- [ ] Vite + TS strict + vitest + ESLint(계층 의존 규칙: `core←sim`, `core←render` 강제)
- [ ] `core/schema` FabLayout·Scenario zod 정의
- [ ] `scripts/generate-layout.ts` → `data/layouts/fab-default.json` 생성 (6×12 베이)
- [ ] `core/layout` 로더 + 3중 nav 그래프 빌드 + 의미 검증 (+유닛 테스트)
- [ ] Worker 부트스트랩 + PoseBuffer 왕복 (더미 개체 1개가 원 그리며 이동)
- **데모: 회색 바닥 위에 박스 1개가 움직인다. Worker↔Main 파이프 검증 완료.**

## M1 — 정적 팹 씬

- [ ] 바닥/벽/천장/기둥 (병합 지오메트리)
- [ ] 베이 + 설비 10종 절차 메시 → 타입별 InstancedMesh
- [ ] OHT 레일 병합 렌더
- [ ] 조명 시스템 (05 문서 사양) + 색채 팔레트 적용
- [ ] Orbit 카메라
- **데모: 팹 전경이 예쁘게 보인다. draw call < 60 확인.**

## M2 — 개체와 이동

- [ ] ohtSystem: 레일 크루즈 + headway (+결정성/headway 테스트)
- [ ] vehicleSystem: AGV/IGV A* 주행 + 레인 오프셋
- [ ] personSystem: 순회/작업 행동 + GLTF 애니메이션
- [ ] LOD 3단계 + 프레임 분산 + AdaptiveQuality
- [ ] 배속/일시정지 (tick 반복 방식) + HUD 시간 컨트롤
- **성능 게이트: 450개체 @60fps (미들 GPU), sim tick < 8ms. 미달 시 다음 단계 진입 금지.**
- **데모: 수백 대가 흐르는 살아있는 팹. 16× 배속 재생.**

## M3 — 물류 루프 (팹이 일한다)

- [ ] equipmentSystem 상태머신 + 프로세스 윈도우 + 상태등
- [ ] missionSystem: 캐리어 반송 미션 (stocker↔loadport), OHT 호이스트 연출
- [ ] trafficSystem: 사람 우선, 교차점 티켓, 데드락 해소
- [ ] Follow / FirstPerson(Ride·Walk) 카메라
- [ ] 개체 선택 + 정보 패널 HUD
- **데모: 캐리어가 설비 사이를 오가고, 1인칭으로 OHT에 탑승해 본다.**

## M4 — 재난 시나리오 ★ 핵심 가치

- [ ] emergencySystem: 단계 상태머신 + 존 hazard + nav 비용 연동
- [ ] 시나리오 엔진 (트리거/액션) + 3종 시나리오 JSON
- [ ] 역할별 비상 행동 (07 매트릭스 전체 구현)
- [ ] FX: 가스 볼륨, 화염/연기, 경광등, 대피 유도 라인, 사이렌 링
- [ ] CameraDirector (cameraCues) + 비상 조명 연출 + CSS 비네트
- [ ] 상황판 HUD (대피 인원, 경과 시간, 이벤트 로그)
- [ ] 수용 기준 자동 테스트 (07 §6)
- **데모: 버튼 하나로 가스 유출 → 감지 → 대피 → 복구 전 과정이 자동 연출된다.**

## M5 — 폴리시 & 배포

- [ ] high 프로파일 한정 SMAA/bloom, 로딩 시퀀스/스플래시
- [ ] 저사양 검증 (내장 GPU 30fps), SAB 불가 환경 postMessage 폴백
- [ ] Playwright 성능 트레이스 CI, 스크린샷 회귀
- [ ] 정적 호스팅 배포 (COOP/COEP 헤더 설정 포함)

## 운영 원칙

1. **성능은 기능이다**: 매 마일스톤 종료 시 `?stats=1` 수치를 README에 기록. 회귀 시 기능 추가 중단.
2. **파일 500줄 상한**: 리뷰에서 강제. God 파일 재발 방지.
3. **sim은 테스트 없이 머지 금지**: 렌더는 스크린샷, sim은 유닛 테스트.
4. 커밋 단위 = 체크박스 단위. 각 마일스톤 데모는 태그로 남긴다 (`m1-static-fab` 등).
