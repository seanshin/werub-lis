/**
 * gramCategory — 단위 테스트 6건.
 *
 * 묶음: 단계 전이, preliminaryText.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { gramCategory, canRecordGram, canFinalize, preliminaryText } from './microbiology';

describe('gramCategory', () => {
  it('그람양성 구균 → GPC', () => {
    expect(gramCategory('Gram-positive cocci in clusters')).toBe('GPC');
  });
  it('그람음성 간균 → GNR', () => {
    expect(gramCategory('Gram-negative rods')).toBe('GNR');
    expect(gramCategory('그람음성 간균')).toBe('GNR');
  });
  it('효모 → YEAST, 미검출 → NONE', () => {
    expect(gramCategory('yeast cells seen')).toBe('YEAST');
    expect(gramCategory('No growth')).toBe('NONE');
  });
});

describe('단계 전이', () => {
  it('그람 기록: 접종/그람 단계만', () => {
    expect(canRecordGram(null)).toBe(true);
    expect(canRecordGram('INOCULATED')).toBe(true);
    expect(canRecordGram('AST_FINAL')).toBe(false);
  });
  it('최종 확정: 그람 예비 후', () => {
    expect(canFinalize(null)).toBe(false);
    expect(canFinalize('INOCULATED')).toBe(false);
    expect(canFinalize('GRAM')).toBe(true);
  });
});

describe('preliminaryText', () => {
  it('예비보고 문구에 분류 포함', () => {
    expect(preliminaryText('Gram-positive cocci')).toContain('그람양성 구균');
    expect(preliminaryText('Gram-positive cocci')).toContain('[예비]');
  });
});
