/**
 * parseVcf — 단위 테스트 8건.
 *
 * 묶음: acmgClassify, isValidClassification.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { parseVcf, acmgClassify, isValidClassification } from './genomic';

describe('parseVcf', () => {
  const vcf = [
    '##fileformat=VCFv4.2',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE',
    '17\t41245466\t.\tG\tA\t100\tPASS\tGENE=BRCA1;AF=0.48\tGT:DP\t0/1:120',
    '13\t32914438\t.\tT\tC\t99\tPASS\tGENE=BRCA2;AF=0.99\tGT:DP\t1/1:88',
  ].join('\n');

  it('데이터 라인만 파싱', () => {
    const v = parseVcf(vcf);
    expect(v).toHaveLength(2);
  });
  it('CHROM/POS/REF/ALT + GENE/AF/접합성', () => {
    const [a, b] = parseVcf(vcf);
    expect(a).toMatchObject({ chrom: '17', pos: 41245466, refAllele: 'G', altAllele: 'A', gene: 'BRCA1', vaf: 0.48, zygosity: 'HET' });
    expect(b.zygosity).toBe('HOM');
  });
  it('멀티 ALT는 첫 대립만', () => {
    const v = parseVcf('1\t100\t.\tA\tT,C\t.\t.\tGENE=X');
    expect(v[0].altAllele).toBe('T');
  });
});

describe('acmgClassify', () => {
  it('PVS1 + PM → Pathogenic', () => {
    expect(acmgClassify({ pvs: 1, moderateP: 1 })).toBe('Likely Pathogenic');
    expect(acmgClassify({ pvs: 1, strongP: 1 })).toBe('Pathogenic');
  });
  it('2 strong → Pathogenic', () => {
    expect(acmgClassify({ strongP: 2 })).toBe('Pathogenic');
  });
  it('BA1 → Benign', () => {
    expect(acmgClassify({ standaloneB: 1, strongP: 2 })).toBe('Benign');
  });
  it('근거 부족 → VUS', () => {
    expect(acmgClassify({ supportingP: 1 })).toBe('VUS');
    expect(acmgClassify({})).toBe('VUS');
  });
});

describe('isValidClassification', () => {
  it('허용 분류', () => {
    expect(isValidClassification('Pathogenic')).toBe(true);
    expect(isValidClassification('Unknown')).toBe(false);
  });
});
