/**
 * PACS AccessionNumber 파생 — DICOM VR=SH 16자 제약(PACS 회신 반영).
 *
 * 규칙(PACS 결정1 수용, 2026-07-13): 헤드룸 확보를 위해 **2자리 연도** 사용.
 *   병리번호 `{prefix}-YYYY-{seq}` → accession `ACC-{prefix}-YY-{seq}`
 *   예) SP-2026-0456 → ACC-SP-26-0456 (14자, 6자리 일련까지 16자 내 수용)
 * 4자리 연도 패턴이 없으면 원본을 그대로 사용(`ACC-{spNo}`)하고 길이 가드로 보호.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const DICOM_ACCESSION_MAX = 16;

export function buildAccession(spNo: string): string {
  // `-YYYY-` 의 연도를 2자리로 축약(마지막 두 자리만 유지)
  const shortened = spNo.replace(/-\d{2}(\d{2})-/, '-$1-');
  return `ACC-${shortened}`;
}

/** 16자 초과 시 사유 메시지 반환(초과 아니면 null) — loud-fail 용. */
export function accessionOverflow(accession: string): string | null {
  if (accession.length > DICOM_ACCESSION_MAX) {
    return `AccessionNumber(${accession}) ${DICOM_ACCESSION_MAX}자 초과 — 병리번호 축약 후에도 초과(DICOM VR=SH 제약)`;
  }
  return null;
}
