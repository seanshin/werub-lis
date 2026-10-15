/**
 * 분자진단(PCR) 도메인 규칙 — 값 검증과 해석 보조.
 *
 * 왜 필요한가: Ct는 PCR 증폭 사이클 수라 물리적으로 유한한 범위를 갖는다. 검증이 없으면
 * 음수·세 자리 값이 그대로 저장되고(실측: -5·999가 통과했다), 그 값이 정량 해석·추세 비교에
 * 쓰이면 임상 판단이 틀어진다. 판정 로직이 아니라 **입력 위생**이다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** Ct 허용 범위 — 통상 40~45 사이클로 종료하며, 장비·프로토콜 여유를 두고 50까지 허용. */
export const CT_MIN = 0;
export const CT_MAX = 50;

/** 카탈로그에 타깃별 컷오프가 없을 때 쓰는 기본 판정 한계 */
export const DEFAULT_CT_CUTOFF = 40;

export const DETECTIONS = ['DETECTED', 'NOT_DETECTED', 'EQUIVOCAL', 'INVALID'] as const;
export type Detection = typeof DETECTIONS[number];

export const MOL_STATUSES = ['PRELIMINARY', 'FINAL', 'AMENDED'] as const;

/** Ct 값 검증 — 범위 밖이면 사유 반환(null이면 정상). 미입력(null/undefined)은 허용(정성 검사). */
export function validateCt(ct: number | null | undefined): string | null {
  if (ct == null) return null;
  if (!Number.isFinite(ct)) return 'Ct는 숫자여야 합니다';
  if (ct < CT_MIN || ct > CT_MAX) return `Ct는 ${CT_MIN}~${CT_MAX} 범위여야 합니다(입력: ${ct})`;
  return null;
}

/**
 * 검출유무 ↔ Ct 정합성 경고(하드블록 아님).
 * 미검출인데 낮은 Ct가 붙어 있으면 둘 중 하나가 잘못됐을 가능성이 높다 — 사람이 확인해야 한다.
 */
export function ctConsistencyWarning(
  detection: string,
  ct: number | null | undefined,
  cutoff = DEFAULT_CT_CUTOFF,
): string | null {
  if (ct == null) return null;
  if (detection === 'NOT_DETECTED' && ct <= cutoff) {
    return `미검출로 보고했으나 Ct ${ct}가 입력됐습니다 — 검출유무 또는 Ct를 확인하세요`;
  }
  if (detection === 'DETECTED' && ct > cutoff) {
    return `검출로 보고했으나 Ct ${ct}는 판정 한계(${cutoff})를 넘습니다 — 판정보류(EQUIVOCAL) 여부를 확인하세요`;
  }
  return null;
}

/**
 * 판정 해석 제안(DRAFT) — 검출유무 + Ct + assay 카탈로그(컷오프·회색지대)로 해석문 초안을 만든다.
 *
 * ⚠ 확정 아님 — 검사자가 검토·수정·확정한다. 카탈로그(검사실 등록값)에 근거하며, 임의 추정은 하지 않는다.
 * (C-대 스텁 "해석 규칙"의 로컬 구현 — 실 키트 규칙 확정 시 assay 값 교체로 반영)
 */
export interface MolInterpretSuggestion { text: string; basis: string; caution: boolean }

export function suggestInterpretation(
  detection: string,
  ct: number | null | undefined,
  assay?: { ctCutoff?: number | null; equivocalFrom?: number | null } | null,
): MolInterpretSuggestion | null {
  const cutoff = assay?.ctCutoff ?? null;
  const eqFrom = assay?.equivocalFrom ?? null;
  switch (detection) {
    case 'NOT_DETECTED':
      return { text: '음성 — 표적 미검출', basis: '검출유무 NOT_DETECTED', caution: false };
    case 'INVALID':
      return { text: '무효 — 대조 실패 등, 재검 필요', basis: '검출유무 INVALID', caution: true };
    case 'EQUIVOCAL':
      return { text: '경계(판정보류) — 재검/추가검사 권고', basis: eqFrom != null ? `회색지대(Ct ≥ ${eqFrom})` : '검출유무 EQUIVOCAL', caution: true };
    case 'DETECTED': {
      if (ct == null) return { text: '양성 — 표적 검출', basis: '검출유무 DETECTED(Ct 미기재)', caution: false };
      if (eqFrom != null && ct >= eqFrom && (cutoff == null || ct <= cutoff)) {
        return { text: '약양성/경계 — 낮은 표적량, 재검 고려', basis: `Ct ${ct} 회색지대(${eqFrom}~${cutoff ?? DEFAULT_CT_CUTOFF})`, caution: true };
      }
      if (cutoff != null && ct > cutoff) {
        return { text: '판정보류 — Ct가 컷오프 초과, 재검 권고', basis: `Ct ${ct} > 컷오프 ${cutoff}`, caution: true };
      }
      return { text: '양성 — 표적 검출', basis: cutoff != null ? `Ct ${ct} ≤ 컷오프 ${cutoff}` : `Ct ${ct}`, caution: false };
    }
    default:
      return null;
  }
}

/**
 * 판정보류(회색지대) 안내 — 컷오프 직전 구간은 키트마다 재검을 권고한다.
 * 카탈로그에 equivocalFrom이 있을 때만 판단한다(임의 추정은 하지 않는다).
 */
export function ctEquivocalWarning(
  detection: string,
  ct: number | null | undefined,
  equivocalFrom: number | null | undefined,
  cutoff: number | null | undefined,
): string | null {
  if (ct == null || equivocalFrom == null) return null;
  const hi = cutoff ?? DEFAULT_CT_CUTOFF;
  if (ct >= equivocalFrom && ct <= hi && detection === 'DETECTED') {
    return `Ct ${ct}는 판정보류 구간(${equivocalFrom}~${hi})입니다 — 재검 또는 EQUIVOCAL 보고를 검토하세요`;
  }
  return null;
}
