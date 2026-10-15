/**
 * retention policy — 단위 테스트 4건.
 *
 * 묶음: cutoffDate.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { RETENTION_POLICY, cutoffDate, ruleFor } from './retention';

describe('retention policy', () => {
  it('임상 결과는 자동삭제 제외', () => {
    expect(ruleFor('result')?.purgeable).toBe(false);
  });
  it('운영 로그는 정리 대상', () => {
    expect(ruleFor('interface_log')?.purgeable).toBe(true);
    expect(ruleFor('audit_log')?.purgeable).toBe(true);
  });
  it('각 규칙에 날짜 컬럼 명시', () => {
    for (const r of RETENTION_POLICY) expect(r.dateField).toBeTruthy();
  });
});

describe('cutoffDate', () => {
  it('now-days', () => {
    const now = Date.UTC(2026, 6, 14); // 2026-07-14
    expect(cutoffDate(90, now).toISOString().slice(0, 10)).toBe('2026-04-15');
  });
});
