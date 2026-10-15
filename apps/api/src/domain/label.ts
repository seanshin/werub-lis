/**
 * 검체 라벨(ZPL) 생성 — Zebra 라벨 프린터용 (Domain, 순수 함수).
 * 근거: 기획 22 §6-4(검체 생명주기·라벨 실물 출력).
 * 프런트/프린트 큐가 이 ZPL을 프린터로 전송한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface LabelInput {
  specimenNo: string; // 바코드 값
  patientName: string;
  patientId: string;
  testSummary: string; // 예: "CBC, 전해질"
  collectedDt?: string; // 표시용 문자열
}

/** 문자열 내 ZPL 제어 문자(^, ~) 제거로 필드 주입 방지. */
function sanitize(s: string): string {
  return (s ?? '').replace(/[\^~]/g, ' ').slice(0, 40);
}

/**
 * Code128 바코드(specimenNo) + 환자·검사 요약을 담은 ZPL 라벨.
 * 40x30mm 라벨 기준(203dpi). 실제 배치는 프린터 모델에 맞게 조정 가능.
 */
export function buildZplLabel(input: LabelInput): string {
  const sp = sanitize(input.specimenNo);
  return [
    '^XA',
    '^CI28', // UTF-8
    `^FO20,20^BY2^BCN,80,Y,N,N^FD${sp}^FS`, // Code128 바코드 + 판독값
    `^FO20,120^A0N,28,28^FD${sanitize(input.patientName)} (${sanitize(input.patientId)})^FS`,
    `^FO20,155^A0N,24,24^FD${sanitize(input.testSummary)}^FS`,
    `^FO20,185^A0N,20,20^FD${sanitize(input.collectedDt ?? '')}^FS`,
    '^XZ',
  ].join('\n');
}
