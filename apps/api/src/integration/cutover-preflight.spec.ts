/**
 * cutoverPreflight — 컷오버 프리플라이트 (①accession ②PID) — 단위 테스트 8건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { IntegrationService } from './integration.service';

// cutoverPreflight는 prisma를 사용하지 않는 순수 검증 메서드 → 더미 주입
const svc = new IntegrationService({} as never);

describe('cutoverPreflight — 컷오버 프리플라이트 (①accession ②PID)', () => {
  it('① accession: 2자리 연도 축약 후 전부 ≤16, allPass', () => {
    const r = svc.cutoverPreflight(['SP-2026-0456', 'SP-2026-10000', 'C-2026-0042'], []);
    expect(r.accession.every((a) => a.length <= 16 && a.ok)).toBe(true);
    expect(r.summary.accessionFail).toBe(0);
  });

  it('① accession: 16자 초과 시 loud-fail(ok=false, reason)', () => {
    const r = svc.cutoverPreflight(['SP-2026-1234567890'], []);
    expect(r.accession[0].ok).toBe(false);
    expect(r.accession[0].reason).toContain('초과');
    expect(r.summary.allPass).toBe(false);
  });

  it('② PID: 선행0 보존', () => {
    const r = svc.cutoverPreflight([], ['00123456']);
    expect(r.patientId[0].preserved).toBe(true);
    expect(r.patientId[0].roundTrip).toBe('00123456');
    expect(r.patientId[0].risks).toContain('선행0');
  });

  it('② PID: 하이픈 보존', () => {
    const r = svc.cutoverPreflight([], ['9-12345']);
    expect(r.patientId[0].preserved).toBe(true);
    expect(r.patientId[0].roundTrip).toBe('9-12345');
    expect(r.patientId[0].risks).toContain('하이픈');
  });

  it('② PID: 후행공백은 edge-trim 정규화(유의바이트 보존)', () => {
    const r = svc.cutoverPreflight([], ['123456 ']);
    expect(r.patientId[0].preserved).toBe(true); // 정규화 후 유의바이트 보존
    expect(r.patientId[0].roundTrip).toBe('123456'); // 후행공백 제거
    expect(r.patientId[0].normalized).toBe('123456');
    expect(r.patientId[0].edgeTrimmed).toBe(true);
    expect(r.patientId[0].note).toContain('edge-trim');
  });
  it('② PID: 선행0은 edge-trim에도 보존(유의 문자)', () => {
    const r = svc.cutoverPreflight([], ['00123456 ']);
    expect(r.patientId[0].roundTrip).toBe('00123456'); // 선행0 유지, 후행공백만 제거
    expect(r.patientId[0].preserved).toBe(true);
    expect(r.patientId[0].edgeTrimmed).toBe(true);
    expect(r.patientId[0].risks).toContain('선행0');
  });

  it('② PID: HL7 구분자 포함 값은 부적합 처리(preserved=false)', () => {
    const r = svc.cutoverPreflight([], ['12^34']);
    expect(r.patientId[0].preserved).toBe(false);
    expect(r.patientId[0].note).toContain('부적합');
  });

  it('요약: 정상 입력이면 allPass=true, 규칙 메타 포함', () => {
    const r = svc.cutoverPreflight(['SP-2026-0456'], ['00123456', '9-12345']);
    expect(r.summary.allPass).toBe(true);
    expect(r.summary.rule.accessionMaxLen).toBe(16);
    expect(r.summary.rule.yearDigits).toBe(2);
  });
});
