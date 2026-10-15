/**
 * 단위 사전(UX §2-4) — 단위 테스트 7건.
 *
 * 묶음: formatRange — 참고치는 단위와 함께(§1-6 en-dash).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { UNIT_DICT, unitDisplay, formatRange } from '@lis/shared';

describe('단위 사전(UX §2-4)', () => {
  it('운영 마스터에서 쓰는 단위 14종이 모두 등재돼 있다', () => {
    const inUse = ['%', '10*3/uL', '10*6/uL', 'U/L', 'fL', 'g/dL', 'mIU/L', 'mL/min/1.73m2',
      'mg/L', 'mg/dL', 'mmol/L', 'ng/dL', 's', 'uIU/mL', 'ug/mL'];
    for (const u of inUse) expect(UNIT_DICT[u], `단위 미등재: ${u}`).toBeDefined();
  });

  it('혼동 위험 단위에는 주의 문구가 있다(값 오판 방지)', () => {
    for (const u of ['mg/dL', 'mmol/L', 'mg/L', 'g/dL', '10*3/uL', '10*6/uL', 'uIU/mL']) {
      expect(UNIT_DICT[u].caution, `caution 없음: ${u}`).toBeTruthy();
    }
  });

  it('미등록 단위는 원문 그대로 — 빈칸이 되지 않는다', () => {
    expect(unitDisplay('kPa')).toBe('kPa');
    expect(unitDisplay(null)).toBe('');
    expect(unitDisplay('10*3/uL')).toContain('천 개');
  });
});

describe('formatRange — 참고치는 단위와 함께(§1-6 en-dash)', () => {
  it('양끝 있음', () => {
    expect(formatRange(4.0, 5.6, '%')).toBe('4 – 5.6 %');
  });
  it('한쪽만 있으면 부등호', () => {
    expect(formatRange(60, null, 'mL/min/1.73m2')).toBe('≥ 60 mL/분/1.73 m²');
    expect(formatRange(null, 130, 'mg/dL')).toBe('≤ 130 mg/dL');
  });
  it('단위 없으면 숫자만, 값 없으면 —', () => {
    expect(formatRange(1, 2, null)).toBe('1 – 2');
    expect(formatRange(null, null, 'mg/dL')).toBe('—');
  });
  it('하이픈이 아니라 en-dash를 쓴다(표기 통일)', () => {
    expect(formatRange(1, 2)).toContain('–');
    expect(formatRange(1, 2)).not.toContain('-');
  });
});
