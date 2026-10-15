/**
 * NGS 런 QC 게이트(Domain, 순수 함수) — Q30·평균 coverage·uniformity 임계 판정.
 * 임계값은 **패널·플랫폼별로 다르다**(타깃 패널과 WES는 요구 coverage가 자릿수로 다르다).
 * 패널 마스터에 값이 있으면 그것을, 없으면 아래 기본값을 쓴다. 미달은 보고 경고(하드블록 아님 —
 * 재검·판독은 사람 판단).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface NgsQcInput { q30?: number | null; meanCoverage?: number | null; uniformityPct?: number | null }
export interface NgsQcResult { verdict: 'PASS' | 'WARN' | 'FAIL'; failed: string[]; thresholds: { q30: number; meanCoverage: number; uniformityPct: number } }

/** 패널 미지정·미등록 시 기본 임계 */
export const NGS_QC_THRESHOLDS = { q30: 80, meanCoverage: 100, uniformityPct: 90 };

export interface NgsQcThresholds { q30?: number | null; meanCoverage?: number | null; uniformityPct?: number | null }

/** 패널 값이 있으면 그것을, 없으면 기본값을 — 부분 지정(coverage만 등)도 허용한다. */
export function resolveThresholds(panel?: NgsQcThresholds | null): { q30: number; meanCoverage: number; uniformityPct: number } {
  return {
    q30: panel?.q30 ?? NGS_QC_THRESHOLDS.q30,
    meanCoverage: panel?.meanCoverage ?? NGS_QC_THRESHOLDS.meanCoverage,
    uniformityPct: panel?.uniformityPct ?? NGS_QC_THRESHOLDS.uniformityPct,
  };
}

export function evaluateNgsQc(run: NgsQcInput, panel?: NgsQcThresholds | null): NgsQcResult {
  const th = resolveThresholds(panel);
  const failed: string[] = [];
  if (run.q30 != null && run.q30 < th.q30) failed.push(`Q30 ${run.q30}% < ${th.q30}%`);
  if (run.meanCoverage != null && run.meanCoverage < th.meanCoverage) failed.push(`평균 coverage ${run.meanCoverage}x < ${th.meanCoverage}x`);
  if (run.uniformityPct != null && run.uniformityPct < th.uniformityPct) failed.push(`uniformity ${run.uniformityPct}% < ${th.uniformityPct}%`);
  // 지표가 하나도 없으면 미평가(WARN). 하나라도 미달이면 FAIL. 전부 충족이면 PASS.
  const anyMetric = run.q30 != null || run.meanCoverage != null || run.uniformityPct != null;
  const verdict = failed.length > 0 ? 'FAIL' : anyMetric ? 'PASS' : 'WARN';
  return { verdict, failed, thresholds: th };
}
