/**
 * evaluateNgsQc — 단위 테스트 5건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { evaluateNgsQc, NGS_QC_THRESHOLDS } from './ngs-qc';

/** NGS QC 게이트 — 미달 런의 변이를 임상 보고로 내보내지 않기 위한 판정. */
describe('evaluateNgsQc', () => {
  const ok = { q30: 95, meanCoverage: 500, uniformityPct: 95 };

  it('전 지표 충족이면 PASS', () => {
    expect(evaluateNgsQc(ok).verdict).toBe('PASS');
  });

  it('하나라도 임계 미달이면 FAIL하고 실패 항목을 알린다', () => {
    const r = evaluateNgsQc({ ...ok, q30: NGS_QC_THRESHOLDS.q30 - 1 });
    expect(r.verdict).toBe('FAIL');
    expect(r.failed.length).toBeGreaterThan(0);
  });

  it('★지표가 전부 없으면 FAIL이 아니라 WARN — 미측정과 미달을 구분한다', () => {
    expect(evaluateNgsQc({}).verdict).toBe('WARN');
  });

  it('일부만 측정됐고 그것이 충족이면 PASS(측정된 것만 판정)', () => {
    expect(evaluateNgsQc({ q30: 95 }).verdict).toBe('PASS');
  });

  it('임계 경계값은 충족으로 본다', () => {
    expect(evaluateNgsQc({ q30: NGS_QC_THRESHOLDS.q30 }).verdict).toBe('PASS');
  });
});
