/**
 * 결과 첨부 접근 판정 — 누가 어떤 첨부를 볼 수 있는지 결정한다.
 *
 * 첨부는 원본 결과지·수탁 보고서 등 **PHI 그 자체**다. 목록에 보이는 것과 내려받을 수 있는 것을
 * 분리해 판정하며, 다운로드는 `inline`+`nosniff`로 브라우저가 임의 실행하지 않게 한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { LisRole } from '../../common/rbac/roles';

/**
 * 첨부 접근 역할 — 도메인(소유 대상)별로 분리한다.
 *
 * 첨부는 검체·병리·유전체·수혈이상반응·EQA 다섯 도메인이 한 테이블(ResultAttachment)을 공유한다.
 * 업로드·목록은 도메인별 엔드포인트라 가드로 분리되지만, **다운로드·삭제는 attachmentId 하나만
 * 받는 공용 엔드포인트**다. 따라서 가드만으로는 도메인을 알 수 없고, 레코드를 읽은 뒤
 * 서비스 계층에서 소유 도메인을 판정해 재검증해야 한다(그렇지 않으면 미생물 담당자가 유전체
 * 수탁 결과지를, 검사자가 수혈 이상반응 조사서를 내려받는다).
 */
export type AttachmentDomain = 'SPECIMEN' | 'PATHOLOGY' | 'GENOMIC' | 'REACTION' | 'EQA';

export const ATTACH_READ_BY_DOMAIN: Record<AttachmentDomain, LisRole[]> = {
  SPECIMEN: [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM, LisRole.AUD],
  PATHOLOGY: [LisRole.PAT, LisRole.PHY, LisRole.ADM, LisRole.AUD],
  // 유전정보 최소권한(08 §3.3)
  GENOMIC: [LisRole.GEN, LisRole.GC, LisRole.PHY, LisRole.ADM, LisRole.AUD],
  REACTION: [LisRole.BB, LisRole.PHY, LisRole.ADM, LisRole.AUD],
  EQA: [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM, LisRole.AUD],
};

export const ATTACH_WRITE_BY_DOMAIN: Record<AttachmentDomain, LisRole[]> = {
  SPECIMEN: [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM],
  PATHOLOGY: [LisRole.PAT, LisRole.PHY, LisRole.ADM],
  GENOMIC: [LisRole.GEN, LisRole.GC, LisRole.PHY, LisRole.ADM],
  REACTION: [LisRole.BB, LisRole.PHY, LisRole.ADM],
  EQA: [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM],
};

/** 공용 다운로드/삭제 엔드포인트의 1차 가드용 — 도메인 판정은 서비스가 다시 한다. */
export const ATTACH_ANY_READ_ROLES = [
  ...new Set(Object.values(ATTACH_READ_BY_DOMAIN).flat()),
];
export const ATTACH_ANY_WRITE_ROLES = [
  ...new Set(Object.values(ATTACH_WRITE_BY_DOMAIN).flat()),
];

/** 첨부 레코드의 소유 도메인 판정(선점 순서: 구체적 도메인 우선). */
export function attachmentDomain(rec: {
  genomicOrderId?: string | null;
  reactionId?: string | null;
  eqaId?: string | null;
  spNo?: string | null;
  specimenNo?: string | null;
  reportId?: string | null;
}): AttachmentDomain {
  if (rec.genomicOrderId) return 'GENOMIC';
  if (rec.reactionId) return 'REACTION';
  if (rec.eqaId) return 'EQA';
  if (rec.spNo) return 'PATHOLOGY';
  // 법정감염병 신고 첨부는 미생물/감염관리 담당(MIC/PHY/ADM/AUD) 권한 = SPECIMEN 도메인과 동일.
  return 'SPECIMEN';
}

export function canAccessAttachment(
  domain: AttachmentDomain,
  roles: string[],
  mode: 'READ' | 'WRITE',
): boolean {
  const allowed = mode === 'READ' ? ATTACH_READ_BY_DOMAIN[domain] : ATTACH_WRITE_BY_DOMAIN[domain];
  return roles.some((r) => (allowed as string[]).includes(r));
}
