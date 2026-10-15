/**
 * expiryStatus — 단위 테스트 7건.
 *
 * 묶음: addDays, 부작용.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { expiryStatus, addDays, isValidReaction, reactionGuidance } from './transfusion-lifecycle';

describe('expiryStatus', () => {
  it('만료/임박/정상', () => {
    expect(expiryStatus('2026-07-10', '2026-07-14')).toBe('EXPIRED');
    expect(expiryStatus('2026-07-18', '2026-07-14')).toBe('EXPIRING'); // 4일 후
    expect(expiryStatus('2026-08-30', '2026-07-14')).toBe('OK');
  });
  it('경계: 정확히 warnDays', () => {
    expect(expiryStatus('2026-07-21', '2026-07-14', 7)).toBe('EXPIRING');
    expect(expiryStatus('2026-07-22', '2026-07-14', 7)).toBe('OK');
  });
  it('null → OK', () => expect(expiryStatus(null, '2026-07-14')).toBe('OK'));
});

describe('addDays', () => {
  it('월 경계', () => {
    expect(addDays('2026-07-28', 5)).toBe('2026-08-02');
  });
});

describe('부작용', () => {
  it('유효성', () => {
    expect(isValidReaction('HEMOLYTIC', 'SEVERE')).toBe(true);
    expect(isValidReaction('XYZ', 'MILD')).toBe(false);
  });
  it('중증/용혈 → 즉시 중단 권고', () => {
    expect(reactionGuidance('HEMOLYTIC', 'MILD')).toContain('즉시 수혈 중단');
    expect(reactionGuidance('FEBRILE', 'SEVERE')).toContain('즉시 수혈 중단');
  });
  it('TACO → 감속', () => {
    expect(reactionGuidance('TACO', 'MODERATE')).toContain('감속');
  });
});
