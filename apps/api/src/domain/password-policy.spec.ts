/**
 * validatePasswordStrength — 단위 테스트 8건.
 *
 * 묶음: nextLockState / isLocked.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { validatePasswordStrength, nextLockState, isLocked, LOCK_THRESHOLD } from './password-policy';

describe('validatePasswordStrength', () => {
  it('정책 충족 → null', () => {
    expect(validatePasswordStrength('LisSecure2026')).toBeNull();
  });
  it('짧으면 거부', () => {
    expect(validatePasswordStrength('Ab1')).toContain('10자');
  });
  it('대문자 없음', () => {
    expect(validatePasswordStrength('lissecure2026')).toContain('대문자');
  });
  it('숫자 없음', () => {
    expect(validatePasswordStrength('LisSecurePwd')).toContain('숫자');
  });
  it('취약 비번(demo1234 포함) 거부', () => {
    expect(validatePasswordStrength('Mydemo1234Pw')).toContain('취약');
  });
});

describe('nextLockState / isLocked', () => {
  it('임계 미만 → 잠금 없음', () => {
    const s = nextLockState(2);
    expect(s.attempts).toBe(3);
    expect(s.lockedUntilMs).toBeNull();
  });
  it('임계 도달 → 잠금 시간 부여', () => {
    const s = nextLockState(LOCK_THRESHOLD - 1);
    expect(s.attempts).toBe(LOCK_THRESHOLD);
    expect(s.lockedUntilMs).toBeGreaterThan(0);
  });
  it('isLocked: 미래 시각이면 잠금', () => {
    expect(isLocked(new Date(1000), 500)).toBe(true);
    expect(isLocked(new Date(500), 1000)).toBe(false);
    expect(isLocked(null, 1000)).toBe(false);
  });
});
