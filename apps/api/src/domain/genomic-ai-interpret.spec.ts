/**
 * 유전체 AI 해석(로컬 지식기반) — 단위 테스트 10건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { aiInterpret } from './genomic-ai-interpret';

describe('유전체 AI 해석(로컬 지식기반)', () => {
  it('ACMG 근거로 분류 제안 + 유전자 맥락', () => {
    const r = aiInterpret({ gene: 'BRCA2', testType: 'GERMLINE', acmgEvidence: { pvs: 1, strongP: 1 } });
    expect(r.suggestedClassification).toBe('Pathogenic');
    expect(r.geneContext?.conditions).toContain('유방');
    expect(r.confidence).toBe('high');
  });

  it('SOMATIC actionable 유전자는 표적치료 시사점', () => {
    const r = aiInterpret({ gene: 'FLT3', variantType: 'VARIANT', testType: 'SOMATIC' });
    expect(r.therapyImplications.join(' ')).toMatch(/midostaurin|gilteritinib/);
  });

  it('germline 병원성이면 유전상담·재접촉 주의', () => {
    const r = aiInterpret({ gene: 'MLH1', testType: 'GERMLINE', acmgEvidence: { pvs: 1, strongP: 1 } });
    expect(r.caveats.join(' ')).toContain('유전상담');
  });

  it('생식세포 VAF가 이형접합에서 벗어나면 모자이시즘 주의', () => {
    const r = aiInterpret({ gene: 'TP53', testType: 'GERMLINE', vaf: 12 });
    expect(r.caveats.join(' ')).toMatch(/모자이시즘|아티팩트/);
  });

  it('미등재 유전자는 초안+주의, geneContext 없음', () => {
    const r = aiInterpret({ gene: 'FOOBAR', testType: 'GERMLINE' });
    expect(r.geneContext).toBeNull();
    expect(r.caveats.join(' ')).toContain('미등재');
    expect(r.disclaimer).toContain('외부로 전송되지 않');
  });

  it('근거 DB 인용이 있으면 그것을 1순위로 — 별점이 신뢰도를 정한다', () => {
    const r = aiInterpret({ gene: 'BRCA1', hgvsP: 'p.Q1756fs', testType: 'GERMLINE' },
      { significance: 'Pathogenic', stars: 3, gnomadAf: 0.00001, source: 'ClinVar', citation: 'VCV000017661', catalogVersion: 'ClinVar-2026-07' });
    expect(r.suggestedClassification).toBe('Pathogenic');
    expect(r.confidence).toBe('high'); // 3★ >= 2
    expect(r.citedEvidence?.source).toBe('ClinVar');
    expect(r.rationale.join(' ')).toContain('VCV000017661');
    expect(r.draftNarrative).toContain('ClinVar');
  });

  it('근거 DB와 ACMG 규칙이 다르면 불일치 환기', () => {
    const r = aiInterpret({ gene: 'BRCA1', testType: 'GERMLINE', acmgEvidence: { standaloneB: 1 } },
      { significance: 'Pathogenic', stars: 2, source: 'ClinVar' });
    expect(r.caveats.join(' ')).toContain('다릅니다');
  });

  it('gnomAD 빈도 높으면 흔한 변이 주의(BA1/BS1)', () => {
    const r = aiInterpret({ gene: 'BRCA2', testType: 'GERMLINE' }, { significance: 'Benign', stars: 2, gnomadAf: 0.05, source: 'gnomAD' });
    expect(r.caveats.join(' ')).toMatch(/집단 빈도가 높|BA1|BS1/);
  });

  it('OncoKB level은 표적치료 시사점으로', () => {
    const r = aiInterpret({ gene: 'EGFR', testType: 'SOMATIC' }, { significance: 'Pathogenic', stars: 4, oncokbLevel: 'Level 1', source: 'OncoKB' });
    expect(r.therapyImplications.join(' ')).toContain('OncoKB Level 1');
  });

  it('근거 없으면 VUS·낮은 신뢰도', () => {
    const r = aiInterpret({ gene: 'EGFR', testType: 'SOMATIC' });
    expect(r.suggestedClassification).toBe('VUS');
    expect(r.confidence).toBe('low');
  });
});
