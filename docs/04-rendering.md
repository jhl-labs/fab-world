# 04 — 렌더링 파이프라인

메인 스레드, 순수 Three.js. 목표: **450개체 + 대형 팹 씬을 60fps, draw call < 150.**

## 1. 렌더 루프

```ts
// render/engine.ts
renderer.setAnimationLoop(() => {
  const alpha = poseReader.sample()   // PoseBuffer 최신 세대 읽기 + 보간 계수
  agents.update(alpha)                // 인스턴스 행렬/애니 갱신 (보간)
  camera.update(dt)
  fx.update(simTime)
  renderer.render(scene, camera)
})
```

- **보간**: Worker는 60Hz지만 배속/스로틀로 화면 프레임과 어긋난다.
  직전 2개 세대의 pose를 유지하고 렌더 시각으로 선형 보간 + yaw는 최단각 보간.
- 렌더러 설정: `antialias: false`(고해상도에선 불필요, 저해상도는 FXAA 옵션),
  `ACESFilmicToneMapping`, `powerPreference: 'high-performance'`, near 1 / far 1500.

## 2. 정적 씬 — 인스턴싱/병합으로 draw call 고정

| 대상 | 기법 | draw call |
|---|---|---|
| 베이 바닥/패드/통로 마감 | 요소 종류별 `InstancedMesh` | ~8 |
| 벽/천장/기둥 | `BufferGeometryUtils.mergeGeometries` → 머티리얼별 1 mesh | ~4 |
| OHT 레일 | 세그먼트 병합 (structure/accent/support 3 머티리얼) | 3 |
| 설비 (10종 × 다층 프리미티브) | **타입별 병합 지오메트리 1개 → InstancedMesh** (인스턴스 컬러로 processBand 틴트) | ~10 |
| 천장등/도어/파이프/가구 | 종류별 InstancedMesh | ~10 |

- 설비 형상은 이전 프로젝트처럼 box/cylinder 프리미티브 다층 조합으로 절차 생성하되,
  타입당 1회 생성 후 병합·재사용. 상태 표시등만 별도 인스턴스드 emissive 쿼드.
- 정적 씬은 로드 후 행렬 갱신 없음 (`matrixAutoUpdate = false`, frustum culling은 인스턴스 단위 불필요 — 전체 바운딩만).

## 3. 동적 개체 — 3단계 LOD

화면공간 픽셀 크기 기준 (거리 아님 — FOV/줌에 강건):

| LOD | 조건 | 표현 |
|---|---|---|
| LOD0 | > 40px & 상위 24대 | 사람: GLTF 스키닝 + 애니메이션 믹서 / 차량: 디테일 메시(바퀴 회전, 호이스트 승강) |
| LOD1 | 8~40px | 종류별 간이 메시 InstancedMesh (인스턴스 attribute로 애니 위상 전달, 정점 셰이더 보행 흔들림) |
| LOD2 | < 8px | 단색 박스 InstancedMesh (인스턴스 컬러 = 개체 타입색) |

- LOD 재평가는 매 프레임이 아니라 **프레임 분산**(개체를 6그룹으로 나눠 프레임당 1그룹) — 이전 프로젝트 검증 기법.
- 카메라 추적/1인칭 대상 개체는 항상 LOD0 강제.
- 스키닝 개체 수 상한: high 24 / balanced 12 / low 4.

## 4. 품질 프로파일 & 적응형 조정

```ts
QUALITY = {
  high:     { pixelRatio: min(dpr,2), shadows: true,  skinnedMax: 24, fxDensity: 1.0 },
  balanced: { pixelRatio: 1.5,        shadows: true,  skinnedMax: 12, fxDensity: 0.6 },
  low:      { pixelRatio: 1,          shadows: false, skinnedMax: 4,  fxDensity: 0.3 },
}
```

- `AdaptiveQuality`: 3초 이동평균 FPS < 50 → 한 단계 하향, > 58 지속 60초 → 상향 시도.
- 그림자: 주광 1개만 캐스캐이드 없이 2048 shadow map, **정적 씬은 shadow를 라이트맵처럼 취급**
  (렌더 타겟에 1회 굽고 갱신 중지 — `shadow.autoUpdate = false`, 동적 개체 그림자는
  인스턴스드 blob shadow(원형 그라디언트 쿼드)로 대체). 실시간 그림자 갱신 비용 제거.

## 5. 포스트프로세싱 (최소주의)

- 기본: **없음** (톤매핑만). "결코 느려선 안됨"이 우선.
- high 프로파일 한정 옵션: SMAA + 미세 bloom(설비 상태등·비상 경광등 강조). 단일 EffectComposer,
  low/balanced에서는 컴포저 자체를 생성하지 않음.
- 비상 상황 비네트/플래시는 이전 프로젝트처럼 **CSS 오버레이**로 처리 (GPU 부담 0).

## 6. 로딩 전략

- 부트 순서: 바닥/벽(즉시) → 설비/레일(1프레임 후) → 개체(worker ready 후) → 장식(idle callback).
- GLTF는 DRACO 압축 + 사전 로드 매니페스트. 총 자산 예산 < 15MB.
- 환경맵: 소형 HDR 1장 (`PMREMGenerator`) — 금속 반사 품질 확보.

## 7. 계측

- `?stats=1`: fps/draw call/triangle 패널. `?no=env,agents,fx`: 컴포넌트 토글 (병목 이등분 탐색).
- worker `metrics`(tickMs)와 함께 HUD 디버그 탭에 표시.
- 성능 회귀 방지: 로드맵 M2부터 Playwright + `performance_start_trace`로 대표 씬 트레이스를 CI에서 측정.
