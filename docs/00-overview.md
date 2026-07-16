# FabWorld — 개요 및 비전

## 1. 프로젝트 목적

FabWorld는 반도체 팹(Fab) 내부 상황을 **브라우저(WebGL)에서 실시간 3D로 시뮬레이션**하는 프로젝트다.

핵심 시나리오는 **인간-로봇 협업 환경에서의 재난/비상 대응 시연**이다:

- 설비 가스 유출 (Gas Leak)
- 응급 환자 발생 (Medical Emergency)
- 화재 발생 (Fire)

위 상황에서 **사람, OHT, AGV, IGV, 설비**가 각각 어떻게 감지 → 전파 → 대피/대응하는지를
설득력 있는 연출로 보여주는 것이 최종 목표다.

## 2. 핵심 요구사항

| 요구사항 | 기준 |
|---|---|
| 등장 개체 | 설비(10종), OHT, AGV, IGV, 사람(엔지니어/오퍼레이터), 로봇암 |
| 상호작용 | 반송 미션(캐리어 운반), 설비 프로세스, 사람의 순회/작업, 비상 대응 |
| 시점 | 자유 궤도(Orbit) 3인칭, 개체 추적(Follow), 1인칭(Pilot) 자유 전환 |
| 성능 | **60fps 필수** (수백 대 개체 기준), draw call 최소화, 저사양 자동 품질 조정 |
| 시간 제어 | 일시정지, 배속 재생(0.5× ~ 16×), 결정적(deterministic) 시뮬레이션 |
| 비주얼 | 명확한 색채 체계 + 의도된 조명 설계. "예뻐 보이는" 수준의 디자인 퀄리티 |
| 시나리오 | 재난 시나리오를 데이터(JSON)로 정의, 트리거/액션 기반 이벤트 시스템 |

## 3. 이전 프로젝트(fab-simulator)로부터의 교훈

기존 `../fab-simulator`는 pnpm 모노레포(frontend + gateway + Python RMF)로 동작했으나
스파게티화되어 재작성한다. **계승할 것**과 **버릴 것**을 명확히 한다.

### 계승 (검증된 전략)

- 화면공간 픽셀 기반 3단계 LOD + `InstancedMesh` 중심의 draw call 최소화
- OHT 레일 루프 인셋(inset)으로 충돌을 구조적으로 제거하는 설계
- 물리적 가감속(accel/decel)·headway(차간거리) 기반의 사실적 차량 거동
- 배속을 `dt × timeScale`로 일괄 적용하는 시간 모델
- zod 단일 소스 스키마 + 충실한 유닛 테스트
- FPS 기반 적응형 품질 조정(AdaptiveQuality)

### 폐기 (스파게티 원인)

| 문제 | FabWorld의 해결책 |
|---|---|
| God 파일 (SimulationEngine 10,820줄 등) | 시스템 단위 분해(ECS-lite), 파일당 500줄 가이드라인 |
| 레이아웃 생성 로직이 프론트/게이트웨이에 이중 복제 | **레이아웃은 단일 패키지 + JSON 데이터가 SSOT** |
| 에디터 포맷과 런타임 레이아웃이 분리(통합 안 됨) | 스키마 하나로 에디터·런타임 공용 |
| zustand store에 고빈도 로봇 pose 저장 → 리렌더 폭풍과 우회책 누적 | **pose는 store 밖 Float32Array 버퍼**, store는 저빈도 UI 상태만 |
| 별도 게이트웨이 서버(권위 시뮬레이션) — 배포·동기화 복잡도 | **클라이언트 단독 실행**: 시뮬레이션을 Web Worker로 분리 (서버 불필요) |
| 미사용 의존성(postprocessing), 19개 store 암묵 결합 | 의존성 최소화, store 5개 이내 |

## 4. 아키텍처 한 줄 요약

> **"시뮬레이션은 Web Worker에서 고정 타임스텝으로, 렌더링은 메인 스레드에서
> Three.js(순수, React 없이)로. 둘 사이는 SharedArrayBuffer pose 버퍼로 잇는다.
> UI(HUD)만 React."**

상세는 [01-architecture.md](01-architecture.md) 참조.

## 5. 문서 목차

| 문서 | 내용 |
|---|---|
| [01-architecture.md](01-architecture.md) | 전체 아키텍처, 기술 스택, 모듈 구조 |
| [02-domain-model.md](02-domain-model.md) | 팹/베이/설비/로봇/사람 도메인 모델 |
| [03-simulation.md](03-simulation.md) | 시뮬레이션 엔진: 루프, 배속, 경로계획, 교통 제어 |
| [04-rendering.md](04-rendering.md) | 렌더링 파이프라인: 인스턴싱, LOD, 성능 예산 |
| [05-visual-design.md](05-visual-design.md) | 색채 체계, 조명 설계, 머티리얼 가이드 |
| [06-camera.md](06-camera.md) | 카메라 시스템: Orbit / Follow / 1인칭 |
| [07-emergency-scenarios.md](07-emergency-scenarios.md) | 재난 시나리오 설계 (가스/화재/응급환자) |
| [08-data-schema.md](08-data-schema.md) | 레이아웃·시나리오 JSON 스키마 |
| [09-roadmap.md](09-roadmap.md) | 구현 로드맵 및 마일스톤 |
