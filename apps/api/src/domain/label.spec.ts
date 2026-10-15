/**
 * buildZplLabel (ZPL 검체 라벨) — 단위 테스트 4건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { buildZplLabel } from './label';

describe('buildZplLabel (ZPL 검체 라벨)', () => {
  const zpl = buildZplLabel({
    specimenNo: 'S2607130001',
    patientName: '김테스트',
    patientId: 'P-100023',
    testSummary: 'CBC, 전해질',
    collectedDt: '2026-07-13 08:30',
  });

  it('ZPL 시작/종료 태그', () => {
    expect(zpl.startsWith('^XA')).toBe(true);
    expect(zpl.trim().endsWith('^XZ')).toBe(true);
  });

  it('Code128 바코드에 검체번호 포함', () => {
    expect(zpl).toContain('^BCN');
    expect(zpl).toContain('S2607130001');
  });

  it('환자·검사 요약 포함', () => {
    expect(zpl).toContain('김테스트');
    expect(zpl).toContain('CBC, 전해질');
  });

  it('ZPL 제어문자(^~) 주입 방지', () => {
    const evil = buildZplLabel({ specimenNo: 'S1^XZ~CMD', patientName: 'a^b', patientId: 'x', testSummary: 't' });
    // 필드 값에서 ^, ~ 제거 → 라벨 구조 태그만 ^로 남음
    expect(evil).not.toContain('S1^XZ');
    expect(evil).toContain('S1 XZ CMD');
  });
});
