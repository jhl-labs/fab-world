# FabWorld

반도체 팹(Fab) 내부를 브라우저에서 실시간 3D(WebGL)로 시뮬레이션하는 프로젝트.
설비, OHT, AGV, IGV, 사람이 상호작용하며 일하는 팹을 재현하고,
**재난/비상 상황(가스 유출·화재·응급 환자) 시 인간-로봇 협업 대응**을 연출한다.

## 특징

- 서버 없는 클라이언트 단독 실행 — 시뮬레이션은 Web Worker, 렌더링은 Three.js
- 450+ 개체 60fps 목표 (인스턴싱 + 화면공간 LOD + SharedArrayBuffer pose 파이프)
- 결정적(deterministic) 시뮬레이션, 일시정지/배속(0.5×~16×)
- Orbit / Follow / 1인칭(탑승·워크스루) 카메라
- JSON 데이터 기반 레이아웃·시나리오 (zod 스키마)

## 설계 문서

[docs/00-overview.md](docs/00-overview.md)부터 순서대로. 전신인 `fab-simulator`의
분석과 교훈이 개요 문서에 정리되어 있다.

## 상태

설계 단계. 구현 로드맵: [docs/09-roadmap.md](docs/09-roadmap.md)
