/**
 * 발신 실패 사유 문구 — 순수 함수.
 *
 * 왜 분리했나: DLQ는 정의상 "자동 재시도를 포기했으니 사람이 판단해 재큐하라"는 상태다.
 * 그런데 사유가 없으면 판단할 근거가 없다 — HIS 다운인지·페이로드 오류인지·토큰 만료인지
 * 구분이 안 되고, 페이로드 오류를 그대로 재큐하면 또 실패한다. 실제로 파일럿 DLQ 4건이
 * 전부 사유 공란이라(2026-07-30 점검) 16일 지난 시점에 원인을 되짚을 수 없었다.
 *
 * 사유를 만드는 자리를 한 곳으로 모아 "사유 없는 실패 기록"이 다시 생기지 않게 한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** 실패 사유를 만들 수 없을 때 쓰는 문구 — 공란으로 두면 "기록 안 됨"과 구분되지 않는다. */
export const UNKNOWN_OUTBOUND_REASON = '사유 미상(발신 실패)';

/** interface_log.errorText 상한(스키마 여유분 확보). */
const REASON_MAX = 500;

/** MLLP ACK 거절 — MSA-1 코드를 남긴다(AE=에러, AR=거절, ''=파싱 실패). */
export function mllpFailureReason(ackCode: string): string {
  return `MLLP ACK ${ackCode || '(파싱실패)'}`;
}

/** FHIR 발신 비정상 응답 — HTTP 상태를 남긴다(401=자격, 4xx=페이로드, 5xx=HIS 장애 구분용). */
export function fhirFailureReason(httpStatus: number): string {
  return `HIS FHIR 응답 HTTP ${httpStatus}`;
}

/** 예외 — 이름까지 남긴다(TimeoutError·TypeError 구분이 원인 규명의 대부분이다). */
export function thrownFailureReason(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * 저장 문구 — 재시도 진행도(n/max)를 앞에 붙인다.
 * 몇 번째 실패인지가 "일시 장애인가 항구적 오류인가" 판단의 첫 단서다.
 */
export function outboundErrorText(reason: string, retry: number, maxRetry: number): string {
  return `[${retry}/${maxRetry}] ${reason || UNKNOWN_OUTBOUND_REASON}`.slice(0, REASON_MAX);
}
