/**
 * 발신 실패 사유 문구 — 단위 테스트.
 *
 * 지키려는 것은 하나다: **실패 기록에 사유가 비지 않는다.**
 * DLQ는 "사람이 판단해 재큐하라"는 상태인데, 사유가 없으면 판단할 수 없고
 * 원인 모를 재큐는 같은 실패를 반복한다(2026-07-30 파일럿 DLQ 4건 전량 공란).
 */
import { describe, it, expect } from 'vitest';
import {
  mllpFailureReason, fhirFailureReason, thrownFailureReason,
  outboundErrorText, UNKNOWN_OUTBOUND_REASON,
} from './outbound-failure';

describe('발신 실패 사유', () => {
  it('MLLP 거절 — MSA-1 코드를 남긴다', () => {
    expect(mllpFailureReason('AE')).toContain('AE');
    expect(mllpFailureReason('AR')).toContain('AR');
  });

  it('MLLP ACK 파싱 실패(빈 코드)도 공란이 아니다', () => {
    expect(mllpFailureReason('')).toBe('MLLP ACK (파싱실패)');
  });

  it('FHIR 비정상 응답 — HTTP 상태를 남긴다(401 자격/5xx 장애 구분)', () => {
    expect(fhirFailureReason(401)).toContain('401');
    expect(fhirFailureReason(503)).toContain('503');
  });

  it('예외 — 이름과 메시지를 함께 남긴다(TimeoutError 구분이 원인 규명의 핵심)', () => {
    const e = new Error('연결 시간초과');
    e.name = 'TimeoutError';
    expect(thrownFailureReason(e)).toBe('TimeoutError: 연결 시간초과');
  });

  it('Error가 아닌 throw도 문자열로 남긴다', () => {
    expect(thrownFailureReason('socket hang up')).toBe('socket hang up');
    expect(thrownFailureReason(undefined)).toBe('undefined');
  });

  it('★사유를 못 잡아도 공란으로 두지 않는다 — 공란은 "기록 안 됨"과 구분되지 않는다', () => {
    const text = outboundErrorText('', 5, 5);
    expect(text).not.toBe('');
    expect(text).toContain(UNKNOWN_OUTBOUND_REASON);
  });

  it('재시도 진행도(n/max)를 앞에 붙인다 — 일시 장애/항구적 오류 판단의 첫 단서', () => {
    expect(outboundErrorText('HIS FHIR 응답 HTTP 500', 5, 5)).toBe('[5/5] HIS FHIR 응답 HTTP 500');
    expect(outboundErrorText('HIS FHIR 응답 HTTP 500', 1, 5)).toBe('[1/5] HIS FHIR 응답 HTTP 500');
  });

  it('긴 사유는 잘라도 컬럼 상한(500)을 넘지 않는다', () => {
    const text = outboundErrorText('x'.repeat(2000), 3, 5);
    expect(text.length).toBe(500);
    expect(text.startsWith('[3/5] ')).toBe(true);
  });
});
