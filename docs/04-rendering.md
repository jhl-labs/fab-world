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

현재 빌드는 324개 설비의 `idle/loading/processing/unloading/held` 상태를 단일
`InstancedMesh` 상태등 draw call로 표시한다. Worker는 상태 배열이 달라질 때만 저빈도 메시지를 보낸다.

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

현재 시연 빌드는 외부 GLTF 없이도 행동이 읽히도록 사람의 머리·몸통·팔·다리를 각각
`InstancedMesh`로 렌더링한다. 100명의 피부·바이저·안전모·장갑·안전화와 팔꿈치·무릎이 있는
2절 팔다리를 20개 동적 draw call로 표현한다. 보행·대피 달리기 외에도 휴머노이드 인지,
양팔 키트 수령, 환자 곁 무릎 처치, 응급 쓰러짐이 서로 다른 실루엣을 가진다.
휴머노이드는 수가 2대로 제한되어 팔꿈치·무릎이 있는 2절 링크로 관찰·조작·보고 실루엣을
구분한다. 보행은 단순 사인파 다리 흔들기가 아니라 62% 지지기와 스윙기로 나눈다. 지지발은
몸체 이동 반대 방향으로 진행해 바닥 미끄러짐을 줄이고, 반대발만 smoothstep 궤적과 최대
0.11m 높이로 들어 이동한다. 두 발 목표는 0.39m+0.39m 다리 IK로 풀며, 합성 관절 회전의
역회전을 발목에 적용해 발바닥이 수평을 유지한다. 보행 속도에 따라 보폭·몸통 상하/측면
하중 이동을 조절한다. 밸브 작업에서는 팔의 접근 진행도와 안전 설비 손잡이 회전을 같은 pose
값으로 구동한다.

사람–휴머노이드 작업 인계 중에는 2.2m 안전 반경, 두 개체의 발 위치, 실제 거리선을 약 2.6초간
표시한다. 이는 충돌 판정을 대신하지 않고, 시뮬레이터가 이미 확인한 물리적 간격을 시연 관객에게
설명하는 운영 오버레이다. 밀집 설비가 두 개체를 가리는 경우 이 짧은 구간에만 설비 머티리얼을
20% 불투명도로 낮추고 depth write를 끈 뒤 원상 복구한다.

의료 시연은 구조요원이 로봇을 바라보는 확인 자세, 양팔 수령, 로봇에서 사람으로 이동하는
키트, 환자 곁 두 구조요원의 무릎 처치 순서로 이어진다. 처치 시작 시 로봇·구조요원·환자를
포함한 3자 구도로 다시 전환해 인계가 실제 후속 행동으로 연결됐음을 보여준다.

전원 집결 대형이 완성되면 가까운 집결지를 향한 24m 거리의 낮은 사선 샷으로 전환한다.
공장 외벽은 비상구 위치만 실제로 열려 있고, 출구에서 외부 서비스 에이프런의 집결 패드까지
녹색 유도선이 이어진다. 패드에는 노란 경계, 시설 측 확인선, 0.75m 슬롯 링,
`MUSTER POINT / 비상 집결지` 표지판을 두어 사람이 어디로 나와 왜 같은 방향을 보는지 한
장면에서 읽힌다. `allClear` 동안 HUD 로그는 최신 두 줄만 남겨 반원 대형과 `94/94` KPI를
가리지 않는다.

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
  단일 `InstancedMesh` 접지 그림자로 대체). 실시간 그림자 갱신 비용 제거.

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

## 8. 시연용 밀도 패스 (현재 구현)

- 공정 장비는 타입별로 평평한 직육면체 하나를 그리지 않는다. 방진 플린스, 이중 외피,
  전면 loadport, HMI/상태등, 유틸리티 팩, 타입별 상부 모듈(노광 광학부·CMP 헤드·furnace
  튜브)을 조합해 원거리 실루엣과 근거리 작업면이 모두 읽히게 한다.
- OHT는 이중 주행 레일, 하부 트레이, 7m 간격 행거로 만들며, 바닥에는 공정 밴드와 이송
  통로의 반투명 유도 마감을 둔다. 따라서 장면의 라인이 단순 경로선이 아니라 실제 상부
  물류 인프라로 보인다.
- 이 다층 부품은 씬 생성 뒤 같은 머티리얼 단위로 정적 지오메트리를 병합한다. 밸브처럼
  애니메이션해야 하는 안전설비만 분리하므로, 고밀도 장비 외관과 항공 관제 화면의 드로우콜을
  함께 유지한다.
- 휴머노이드는 관절 가드, 흉부 패널/상태등, 센서 헤드, 전원 팩을 갖는 절차 모델이며,
  실제 pose를 짧게 감쇠해 렌더한다. 저속 접근은 보폭을 줄이고, 작업/관찰 시 머리 움직임은
  벽시계가 아니라 결정론적 pose phase를 사용한다.
