/**
 * validateCt — Ct 입력 위생(오입력이 정량 해석을 틀어지게 한다) — 단위 테스트 13건.
 *
 * 묶음: ctConsistencyWarning — 검출유무와 Ct가 어긋나면 사람이 본다(차단 아님), suggestInterpretation (판정 해석 초안).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { validateCt, ctConsistencyWarning, suggestInterpretation, CT_MAX } from './molecular';

describe('validateCt — Ct 입력 위생(오입력이 정량 해석을 틀어지게 한다)', () => {
  it('정상 범위는 통과', () => {
    expect(validateCt(0)).toBeNull();
    expect(validateCt(28.4)).toBeNull();
    expect(validateCt(CT_MAX)).toBeNull();
  });

  it('음수는 차단 — 실측에서 -5가 저장됐다', () => {
    expect(validateCt(-5)).toContain('범위');
  });

  it('범위 초과는 차단 — 실측에서 999가 저장됐다', () => {
    expect(validateCt(999)).toContain('범위');
    expect(validateCt(CT_MAX + 0.1)).toContain('범위');
  });

  it('미입력은 허용 — 정성 검사는 Ct가 없다', () => {
    expect(validateCt(null)).toBeNull();
    expect(validateCt(undefined)).toBeNull();
  });

  it('NaN·Infinity 차단', () => {
    expect(validateCt(NaN)).toBeTruthy();
    expect(validateCt(Infinity)).toBeTruthy();
  });
});

describe('ctConsistencyWarning — 검출유무와 Ct가 어긋나면 사람이 본다(차단 아님)', () => {
  it('미검출인데 낮은 Ct → 경고', () => {
    expect(ctConsistencyWarning('NOT_DETECTED', 22)).toContain('미검출');
  });

  it('검출인데 판정 한계 초과 Ct → 판정보류 확인 안내', () => {
    expect(ctConsistencyWarning('DETECTED', 44)).toContain('EQUIVOCAL');
  });

  it('정합적이면 경고 없음', () => {
    expect(ctConsistencyWarning('DETECTED', 28)).toBeNull();
    expect(ctConsistencyWarning('NOT_DETECTED', null)).toBeNull();
    expect(ctConsistencyWarning('EQUIVOCAL', 41)).toBeNull();
  });
});

describe('suggestInterpretation (판정 해석 초안)', () => {
  it('NOT_DETECTED → 음성', () => {
    expect(suggestInterpretation('NOT_DETECTED', null)?.text).toContain('음성');
  });
  it('DETECTED + Ct < 컷오프 → 양성', () => {
    const s = suggestInterpretation('DETECTED', 22, { ctCutoff: 40, equivocalFrom: 37 });
    expect(s?.text).toContain('양성'); expect(s?.caution).toBe(false);
  });
  it('DETECTED + Ct 회색지대 → 약양성/경계(주의)', () => {
    const s = suggestInterpretation('DETECTED', 38, { ctCutoff: 40, equivocalFrom: 37 });
    expect(s?.text).toContain('경계'); expect(s?.caution).toBe(true);
  });
  it('DETECTED + Ct > 컷오프 → 판정보류(주의)', () => {
    const s = suggestInterpretation('DETECTED', 42, { ctCutoff: 40, equivocalFrom: 37 });
    expect(s?.caution).toBe(true);
  });
  it('INVALID → 무효(재검)', () => {
    expect(suggestInterpretation('INVALID', null)?.caution).toBe(true);
  });
});
