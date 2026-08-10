import type { HumanoidTaskKind, HumanoidTaskStatus } from '../core/schema'

interface NarrativeTask {
  kind: HumanoidTaskKind
  status: HumanoidTaskStatus
}

export interface TaskNarrative {
  stage: string
  value: string
}

const stageLabel: Record<HumanoidTaskStatus, string> = {
  queued: 'RMF 요청',
  assigned: '역량 기반 배정',
  navigating: '사람 공유 공간 이동',
  observing: '현장 관찰',
  interacting: '물리 작업',
  reporting: '운영 결과 보고',
  returning: '안전 복귀',
  completed: '작업 완료',
  failed: '안전 실패',
  cancelled: '작업 취소'
}

const interactionValue: Record<HumanoidTaskKind, string> = {
  inspection_round: '사람용 계기와 패널을 여러 각도에서 확인합니다.',
  gas_isolation: '사람 손을 전제로 한 수동 격리 밸브를 개조 없이 조작합니다.',
  medical_support: '사람 중심 응급 현장에 물품을 전달하고 처치 공간을 지원합니다.'
}

export function taskNarrative(task?: NarrativeTask): TaskNarrative {
  if (!task) return {
    stage: '운영 가치',
    value: '평시 설비 점검부터 비상 시 사람용 안전 설비 조작까지 하나의 RMF 태스크로 연결합니다.'
  }
  const common: Partial<Record<HumanoidTaskStatus, string>> = {
    queued: 'Open-RMF가 작업 목적과 우선순위를 바탕으로 수행자를 찾습니다.',
    assigned: 'Open-RMF가 필요한 현장 역량을 가진 휴머노이드를 배정했습니다.',
    navigating: '사람과 같은 통로를 공유하며 현장 작업점까지 안전하게 접근합니다.',
    observing: task.kind === 'medical_support'
      ? '응급요원과 환자의 위치를 확인하고 안전한 지원 공간을 판단합니다.'
      : '머리와 시선을 움직여 설비 상태와 접근 가능성을 현장에서 확인합니다.',
    interacting: interactionValue[task.kind],
    reporting: '현장 결과를 Open-RMF에 반환해 후속 사람·로봇·설비 대응을 조율합니다.',
    returning: '공유 통로의 우선순위를 지키며 다음 작업을 위해 안전 지점으로 복귀합니다.',
    completed: '사람의 접근 부담을 줄이면서 현장 확인과 마지막 물리 작업을 마쳤습니다.',
    failed: task.kind === 'gas_isolation'
      ? '위험원은 미통제로 유지하고 로봇을 후퇴시켜 EHS 수동 대응에 인계합니다.'
      : '작업을 중단하고 안전 정지 상태와 실패 원인을 운영자에게 보고합니다.',
    cancelled: '상황 변경에 따라 작업을 취소하고 현장 안전 상태를 유지합니다.'
  }
  return { stage: stageLabel[task.status], value: common[task.status]! }
}
