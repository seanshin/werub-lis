/**
 * isSecondaryFinding (이차소견 판정) — 단위 테스트 8건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { isSecondaryFinding, ACMG_SF_GENES, findingBucket, normalizeGeneSymbol } from './genomic-report';

describe('isSecondaryFinding (이차소견 판정)', () => {
  it('SF 유전자 + Pathogenic → 이차소견', () => {
    expect(isSecondaryFinding('BRCA1', 'Pathogenic')).toBe(true);
    expect(isSecondaryFinding('brca2', 'Likely Pathogenic')).toBe(true); // 대소문자 무관
  });
  it('SF 유전자지만 VUS/Benign → 이차소견 아님', () => {
    expect(isSecondaryFinding('BRCA1', 'VUS')).toBe(false);
    expect(isSecondaryFinding('TP53', 'Likely Benign')).toBe(false);
  });
  it('비SF 유전자 P/LP → 이차소견 아님(1차 소견)', () => {
    expect(isSecondaryFinding('CFTR', 'Pathogenic')).toBe(false);
  });
  it('gene/classification 결측 → false', () => {
    expect(isSecondaryFinding(null, 'Pathogenic')).toBe(false);
    expect(isSecondaryFinding('BRCA1', null)).toBe(false);
  });
  it('대표 SF 유전자 포함(v3.2 확장: PALB2·TTR·RPE65·CDH1·PLN 등)', () => {
    ['BRCA1', 'BRCA2', 'TP53', 'LDLR', 'MLH1', 'RET', 'PALB2', 'TTR', 'RPE65', 'MAX', 'TMEM127',
      'CDH1', 'CDKN2A', 'PLN', 'ACTN2', 'JPH2', 'MYLK'].forEach((g) => expect(ACMG_SF_GENES.has(g)).toBe(true));
  });
  it('유전자 별칭·표기변형 정규화 후 SF 판정', () => {
    expect(normalizeGeneSymbol(' fbn-1 ')).toBe('FBN1');
    expect(isSecondaryFinding('FBN-1', 'Pathogenic')).toBe(true); // 별칭
    expect(isSecondaryFinding('P53', 'Pathogenic')).toBe(true);
  });
  it('findingBucket — SF P/LP는 secondary, 유전자 미확정 P/LP는 review(누출 방지)', () => {
    expect(findingBucket('BRCA1', 'Pathogenic')).toBe('secondary');
    expect(findingBucket('CFTR', 'Pathogenic')).toBe('primary'); // 비SF는 1차
    expect(findingBucket(null, 'Pathogenic')).toBe('review'); // 심볼 미확정 P/LP → 자동 primary 금지
    expect(findingBucket('', 'Likely Pathogenic')).toBe('review');
    expect(findingBucket(null, 'VUS')).toBe('primary'); // 비P/LP는 review 불필요
  });
  it('SF 유전자에 전사체·주석·구두점이 붙어도 secondary로 인식(무동의 누출 방지)', () => {
    // 수탁 자유텍스트 부착물 — 정규화가 못 벗기면 primary로 새던 케이스
    expect(findingBucket('BRCA1;NM_007294.4', 'Pathogenic')).toBe('secondary');
    expect(findingBucket('BRCA-1', 'Pathogenic')).toBe('secondary');
    expect(findingBucket('TP_53', 'Likely Pathogenic')).toBe('secondary');
    expect(findingBucket('TP53 (p.R175H)', 'Pathogenic')).toBe('secondary');
    expect(normalizeGeneSymbol('BRCA1;NM_007294.4')).toBe('BRCA1');
    // 비SF 정상 심볼은 여전히 primary(과잉 review 방지)
    expect(findingBucket('CFTR', 'Pathogenic')).toBe('primary');
  });
});
