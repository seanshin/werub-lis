/**
 * validateSynoptic — 단위 테스트 4건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { validateSynoptic, getProtocol } from './synoptic-protocols';

describe('validateSynoptic', () => {
  it('필수요소 모두 있으면 valid', () => {
    const proto = getProtocol('STOMACH')!;
    const values = Object.fromEntries(proto.required.map((k) => [k, 'x']));
    expect(validateSynoptic('STOMACH', values).valid).toBe(true);
  });
  it('필수요소 누락 → invalid + missing 목록', () => {
    const v = validateSynoptic('STOMACH', { 종양부위: '전정부' });
    expect(v.valid).toBe(false);
    expect(v.missing.length).toBeGreaterThan(0);
  });
  it('알 수 없는 프로토콜 → 검증 생략(valid)', () => {
    expect(validateSynoptic('UNKNOWN', {}).valid).toBe(true);
  });
  it('BREAST는 ER/PR/HER2 필수', () => {
    expect(getProtocol('BREAST')!.required).toEqual(expect.arrayContaining(['ER', 'PR', 'HER2']));
  });
});
