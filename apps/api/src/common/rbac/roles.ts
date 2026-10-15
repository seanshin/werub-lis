/**
 * LIS 역할(Role) 및 권한 매트릭스 — 근거: 08_상세설계_권한매트릭스.md
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export enum LisRole {
  RCP = 'RCP', // 접수 담당
  TEC = 'TEC', // 검사자(임상병리사)
  PHY = 'PHY', // 검증의
  PAT = 'PAT', // 병리 판독의
  BB = 'BB', // 수혈 담당
  MIC = 'MIC', // 미생물 검사자
  GEN = 'GEN', // 유전체 판독의
  GC = 'GC', // 유전상담사
  ADM = 'ADM', // 관리자
  AUD = 'AUD', // 감사자
}

/** 접근유형 (08 §1) */
export enum Access {
  R = 'R', // 조회
  W = 'W', // 입력/수정
  V = 'V', // 검증
  S = 'S', // 서명/확정
  A = 'A', // 승인
}

/** 기능코드 (08 §3) */
export enum Feature {
  ORD = 'F-ORD', // 처방 조회
  RCV = 'F-RCV', // 접수/라벨 발행
  SPC = 'F-SPC', // 검체 상태관리
  RES = 'F-RES', // 결과 입력
  V1 = 'F-V1', // 1차 검증
  V2 = 'F-V2', // 2차 검증/확정
  CRT = 'F-CRT', // 위험치 통보/확인
  RPT = 'F-RPT', // 결과 보고(HIS전송)
  GEN_RES = 'F-GEN-RES', // 유전체 결과 조회
  MST = 'F-MST', // 마스터
  AUD = 'F-AUD', // 감사추적 조회
  STAT = 'F-STAT', // 통계·리포트(TAT·antibiogram·QC)
  BIL = 'F-BIL', // 청구(수가 캡처·청구배치) — 통계 조회와 분리된 관리 업무
  SEND = 'F-SEND', // 외부검사 위탁(send-out) — 결과입력(F-RES)과 분리(판독의 도메인 위탁 허용)
}

/**
 * 기능 × 역할 × 접근유형 매트릭스.
 * 각 기능에 대해 역할별 허용 접근유형 집합을 정의. (08 §3 발췌 구현)
 */
export const PERMISSION_MATRIX: Record<Feature, Partial<Record<LisRole, Access[]>>> = {
  [Feature.ORD]: {
    RCP: [Access.R], TEC: [Access.R], PHY: [Access.R], PAT: [Access.R], BB: [Access.R],
    MIC: [Access.R], GEN: [Access.R], GC: [Access.R], ADM: [Access.R], AUD: [Access.R],
  },
  [Feature.RCV]: { RCP: [Access.R, Access.W], TEC: [Access.R], ADM: [Access.R], AUD: [Access.R] },
  [Feature.SPC]: { RCP: [Access.R, Access.W], TEC: [Access.R, Access.W], PHY: [Access.R], MIC: [Access.R, Access.W], ADM: [Access.R], AUD: [Access.R] },
  [Feature.RES]: { TEC: [Access.R, Access.W], PHY: [Access.R, Access.W], MIC: [Access.R, Access.W], ADM: [Access.R], AUD: [Access.R] },
  [Feature.V1]: { TEC: [Access.V], PHY: [Access.V], MIC: [Access.V], AUD: [Access.R] },
  [Feature.V2]: { PHY: [Access.V, Access.S], AUD: [Access.R] },
  [Feature.CRT]: { RCP: [Access.R], TEC: [Access.R, Access.W], PHY: [Access.R, Access.W], MIC: [Access.R, Access.W], ADM: [Access.R], AUD: [Access.R] },
  [Feature.RPT]: { PHY: [Access.S], ADM: [Access.R], AUD: [Access.R] },
  // 유전체 결과: 직무 기반 최소권한 (GEN/GC/PHY 제한, 별도 감사) — 08 §3.3
  //   R=조회 / W=변이·해석 등록·큐레이션·배포 / S=보고서 최종 서명.
  //   서명(S)은 판독 자격이 있는 GEN·PHY만 — 상담사(GC)는 조회 전용, 관리자(ADM)는 운영(W)까지.
  //   ※쓰기·서명을 Access.R로 게이팅하면 조회 권한만으로 보고서 확정이 가능해진다(회귀 금지).
  [Feature.GEN_RES]: {
    PHY: [Access.R, Access.W, Access.S], GEN: [Access.R, Access.W, Access.S],
    GC: [Access.R], ADM: [Access.R, Access.W], AUD: [Access.R],
  },
  [Feature.MST]: { TEC: [Access.R], ADM: [Access.R, Access.W, Access.A], AUD: [Access.R] },
  // 통계·리포트: QA/관리·검증의·미생물(antibiogram)·감사 조회.
  //   PAT(병리 판독의)=병리 QA, BB(수혈담당)=수혈 통계 조회 위해 R. GEN은 유전 전용 QA 지표 없어 제외.
  [Feature.STAT]: { TEC: [Access.R], PHY: [Access.R], MIC: [Access.R], PAT: [Access.R], BB: [Access.R], ADM: [Access.R], AUD: [Access.R] },
  // 청구: 조회는 관리·감사, 캡처·청구배치 생성(W)은 관리자만. 감사자(AUD)는 읽기 전용 유지.
  [Feature.BIL]: { ADM: [Access.R, Access.W], AUD: [Access.R] },
  [Feature.AUD]: { ADM: [Access.R], AUD: [Access.R] },
  // 외부위탁(send-out): 결과입력(F-RES) 보유 역할(TEC/PHY/MIC 쓰기·ADM/AUD 조회)을 그대로 계승하고,
  //   도메인 판독의(PAT 병리·GEN 유전)가 자기 케이스를 외부 의뢰할 수 있도록 R,W 추가.
  //   F-RES와 분리해 판독의에게 일반 결과입력 권한이 함께 새지 않도록 한다(최소권한).
  [Feature.SEND]: {
    TEC: [Access.R, Access.W], PHY: [Access.R, Access.W], MIC: [Access.R, Access.W],
    PAT: [Access.R, Access.W], GEN: [Access.R, Access.W], ADM: [Access.R], AUD: [Access.R],
  },
};

/** 역할 표시명 */
export const ROLE_LABELS: Record<LisRole, string> = {
  [LisRole.RCP]: '접수담당', [LisRole.TEC]: '검사자', [LisRole.PHY]: '검증의',
  [LisRole.PAT]: '병리판독의', [LisRole.BB]: '수혈담당', [LisRole.MIC]: '미생물검사자',
  [LisRole.GEN]: '유전체판독의', [LisRole.GC]: '유전상담사', [LisRole.ADM]: '관리자', [LisRole.AUD]: '감사자',
};

/** 기능 표시명 */
export const FEATURE_LABELS: Record<Feature, string> = {
  [Feature.ORD]: '처방 조회', [Feature.RCV]: '접수/라벨', [Feature.SPC]: '검체 관리',
  [Feature.RES]: '결과 입력', [Feature.V1]: '1차 검증', [Feature.V2]: '2차 검증/확정',
  [Feature.CRT]: '위험치 통보', [Feature.RPT]: '결과 보고', [Feature.GEN_RES]: '유전체 결과',
  [Feature.MST]: '마스터 관리', [Feature.AUD]: '감사 조회', [Feature.STAT]: '통계·리포트',
  [Feature.BIL]: '청구', [Feature.SEND]: '외부위탁',
};

/** 권한 매트릭스를 표시용 구조로 직렬화(읽기 전용 조회). */
export function describeMatrix(): {
  features: { code: string; label: string; roles: Partial<Record<string, string[]>> }[];
  roles: { code: string; label: string }[];
} {
  return {
    features: (Object.keys(PERMISSION_MATRIX) as Feature[]).map((f) => ({
      code: f,
      label: FEATURE_LABELS[f],
      roles: PERMISSION_MATRIX[f] as Partial<Record<string, string[]>>,
    })),
    roles: (Object.values(LisRole) as LisRole[]).map((r) => ({ code: r, label: ROLE_LABELS[r] })),
  };
}

/**
 * 권한 판정 — 순수 함수(테스트 용이).
 * 사용자의 역할들 중 하나라도 해당 기능·접근유형을 허용하면 true.
 */
export function can(roles: LisRole[], feature: Feature, access: Access): boolean {
  const entry = PERMISSION_MATRIX[feature];
  if (!entry) return false;
  return roles.some((role) => (entry[role] ?? []).includes(access));
}
