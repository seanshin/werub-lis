/**
 * percentile — 단위 테스트 9건.
 *
 * 묶음: summarizeTat, antibiogramFrom, ljPoints.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { percentile, summarizeTat, antibiogramFrom, antibiogramCsv, ljPoints } from './stats';

describe('percentile', () => {
  it('p50/p90 선형보간', () => {
    const s = [10, 20, 30, 40, 50];
    expect(percentile(s, 50)).toBe(30);
    expect(percentile(s, 90)).toBe(46);
  });
  it('빈 배열 0', () => expect(percentile([], 50)).toBe(0));
});

describe('summarizeTat', () => {
  it('평균·중앙·p90·버킷', () => {
    const s = summarizeTat([30, 90, 150, 300, 600]); // ≤1h,1-2h,2-4h,4-8h,>8h 각 1
    expect(s.count).toBe(5);
    expect(s.medianMin).toBe(150);
    expect(s.buckets.map((b) => b.count)).toEqual([1, 1, 1, 1, 1]);
  });
  it('음수·비정상 제외', () => {
    expect(summarizeTat([-5, NaN, 60]).count).toBe(1);
  });
});

describe('antibiogramFrom', () => {
  const rows = [
    { organism: 'E. coli', antibiotic: 'Ampicillin', interpretation: 'R' },
    { organism: 'E. coli', antibiotic: 'Ampicillin', interpretation: 'S' },
    { organism: 'E. coli', antibiotic: 'Meropenem', interpretation: 'S' },
    { organism: 'E. coli', antibiotic: 'Meropenem', interpretation: 'S' },
    { organism: null, antibiotic: 'X', interpretation: 'S' }, // 제외
    { organism: 'E. coli', antibiotic: 'Amp', interpretation: 'N' }, // 판정없음 제외
  ];
  it('organism×antibiotic %S 집계', () => {
    const agg = antibiogramFrom(rows);
    const ecoli = agg.find((a) => a.organism === 'E. coli')!;
    const amp = ecoli.antibiotics.find((a) => a.antibiotic === 'Ampicillin')!;
    expect(amp).toEqual({ antibiotic: 'Ampicillin', tested: 2, susceptible: 1, pctS: 50 });
    const mero = ecoli.antibiotics.find((a) => a.antibiotic === 'Meropenem')!;
    expect(mero.pctS).toBe(100);
  });
  it('CSV 출력', () => {
    const csv = antibiogramCsv(antibiogramFrom(rows));
    expect(csv.split('\n')[0]).toBe('organism,antibiotic,tested,susceptible,pctS');
    expect(csv).toContain('E. coli,Ampicillin,2,1,50');
  });
});

describe('ljPoints', () => {
  it('z-score 계산', () => {
    const pts = ljPoints([{ measuredDt: '2026-07-13T00:00:00Z', value: 4.5 }], 4.2, 0.15);
    expect(pts[0].z).toBe(2); // (4.5-4.2)/0.15
  });
  it('sd 0 → z 0', () => {
    expect(ljPoints([{ measuredDt: null, value: 5 }], 5, 0)[0].z).toBe(0);
  });
});
