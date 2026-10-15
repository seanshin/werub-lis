/**
 * normalizeBarcode — 단위 테스트 7건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { normalizeBarcode, BarcodeNormalizeCfg } from './barcode';

const base: BarcodeNormalizeCfg = { trimWhitespace: true, prefixStrip: null, suffixStrip: null, stripPattern: null, minLength: null, maxLength: null };

describe('normalizeBarcode', () => {
  it('공백 trim', () => {
    expect(normalizeBarcode('  S-2607-001  ', base).value).toBe('S-2607-001');
  });
  it('접두/접미 제거', () => {
    const cfg = { ...base, prefixStrip: ']C1', suffixStrip: '\r' };
    expect(normalizeBarcode(']C1S-2607-001\r', cfg).value).toBe('S-2607-001');
  });
  it('정규식 문자 제거(체크섬 등)', () => {
    expect(normalizeBarcode('S-2607-001*', { ...base, stripPattern: '[*]' }).value).toBe('S-2607-001');
  });
  it('잘못된 정규식은 원문 유지(무시)', () => {
    expect(normalizeBarcode('S-1', { ...base, stripPattern: '[' }).value).toBe('S-1');
  });
  it('길이 경고 — 미만/초과', () => {
    expect(normalizeBarcode('S-1', { ...base, minLength: 8 }).warning).toContain('길이 부족');
    expect(normalizeBarcode('S-1', { ...base, minLength: 8 }).valid).toBe(false);
    expect(normalizeBarcode('S-1234567890', { ...base, maxLength: 8 }).warning).toContain('길이 초과');
  });
  it('길이 규칙 통과 → valid', () => {
    const r = normalizeBarcode('S2607150001', { ...base, minLength: 8, maxLength: 16 });
    expect(r.valid).toBe(true);
    expect(r.warning).toBeUndefined();
  });
  it('빈 값 → invalid', () => {
    expect(normalizeBarcode('   ', base).valid).toBe(false);
  });
});
