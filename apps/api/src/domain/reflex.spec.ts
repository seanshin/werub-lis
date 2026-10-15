/**
 * reflexMatches — Reflex 트리거 판정 — 단위 테스트 10건.
 *
 * 묶음: reflexEffective — 유효기간, extractHisOrderNo — R-5 승인 정식 오더번호 추출.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { reflexMatches, reflexEffective, extractHisOrderNo } from './reflex';

describe('reflexMatches — Reflex 트리거 판정', () => {
  it('>= 임계값', () => {
    expect(reflexMatches({ operator: '>=', threshold: 200, flag: null }, 200, 'H')).toBe(true);
    expect(reflexMatches({ operator: '>=', threshold: 200, flag: null }, 199, 'N')).toBe(false);
  });
  it('<= / > / <', () => {
    expect(reflexMatches({ operator: '<=', threshold: 0.3, flag: null }, 0.2, 'L')).toBe(true);
    expect(reflexMatches({ operator: '>', threshold: 5, flag: null }, 5, 'N')).toBe(false);
    expect(reflexMatches({ operator: '<', threshold: 5, flag: null }, 4.9, 'L')).toBe(true);
  });
  it('OUT_OF_REF — 비정상 플래그면 참', () => {
    expect(reflexMatches({ operator: 'OUT_OF_REF', threshold: null, flag: null }, 12, 'HH')).toBe(true);
    expect(reflexMatches({ operator: 'OUT_OF_REF', threshold: null, flag: null }, 12, 'N')).toBe(false);
  });
  it('FLAG — 지정 플래그 일치', () => {
    expect(reflexMatches({ operator: 'FLAG', threshold: null, flag: 'HH' }, 12, 'HH')).toBe(true);
    expect(reflexMatches({ operator: 'FLAG', threshold: null, flag: 'HH' }, 8, 'H')).toBe(false);
  });
  it('BETWEEN — 하한~상한 포함(thresholdHigh 사용)', () => {
    const t = { operator: 'BETWEEN', threshold: 4, thresholdHigh: 10, flag: null };
    expect(reflexMatches(t, 7, 'N')).toBe(true);
    expect(reflexMatches(t, 4, 'N')).toBe(true);
    expect(reflexMatches(t, 10, 'N')).toBe(true);
    expect(reflexMatches(t, 3.9, 'L')).toBe(false);
    expect(reflexMatches(t, 11, 'H')).toBe(false);
    // 상한 없으면 매칭 안 됨(안전)
    expect(reflexMatches({ operator: 'BETWEEN', threshold: 4, thresholdHigh: null, flag: null }, 7, 'N')).toBe(false);
  });
  it('값 없음(비수치)이면 비교연산자는 거짓', () => {
    expect(reflexMatches({ operator: '>=', threshold: 200, flag: null }, null, 'N')).toBe(false);
  });
});

describe('reflexEffective — 유효기간', () => {
  it('시작/종료 범위', () => {
    expect(reflexEffective('2026-01-01', '2026-12-31', '2026-07-14')).toBe(true);
    expect(reflexEffective('2026-08-01', null, '2026-07-14')).toBe(false);
    expect(reflexEffective(null, '2026-06-30', '2026-07-14')).toBe(false);
    expect(reflexEffective(null, null, '2026-07-14')).toBe(true);
  });
});

describe('extractHisOrderNo — R-5 승인 정식 오더번호 추출', () => {
  it('urn:his:order system의 value 추출(멱등키는 제외)', () => {
    const ids = [
      { system: 'urn:lis:weve:reflex-order', value: 'RX-O-1-CHE-HBA1C' }, // 멱등키
      { system: 'urn:his:order', value: 'HORD-20260715-001' }, // 정식 오더번호
    ];
    expect(extractHisOrderNo(ids)).toBe('HORD-20260715-001');
  });
  it('없거나 빈 배열이면 null', () => {
    expect(extractHisOrderNo(null)).toBeNull();
    expect(extractHisOrderNo([])).toBeNull();
    expect(extractHisOrderNo([{ system: 'urn:lis:weve:reflex-order', value: 'RX-1' }])).toBeNull();
  });
  it('유사 system(urn:this:order) 오탐 방지', () => {
    expect(extractHisOrderNo([{ system: 'urn:this:order', value: 'X' }])).toBeNull();
    expect(extractHisOrderNo([{ system: 'urn:his:order', value: 'H1' }])).toBe('H1');
  });
});
