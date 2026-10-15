/**
 * Westgard 다중규칙 QC 판정 — 근거: 07 §8, 03 SCR-07.
 * 입력: 최근 QC 측정값 시퀀스(오래된→최신), 목표 평균/표준편차.
 * 반환: 위반 규칙 목록과 최종 verdict(PASS/WARN/FAIL).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface WestgardResult {
  z: number; // 최신값 z-score
  violations: string[];
  verdict: 'PASS' | 'WARN' | 'FAIL';
}

export function evaluateWestgard(values: number[], mean: number, sd: number): WestgardResult {
  if (sd <= 0 || values.length === 0) {
    return { z: 0, violations: [], verdict: 'PASS' };
  }
  const z = (v: number) => (v - mean) / sd;
  const zs = values.map(z);
  const last = zs[zs.length - 1];
  const violations: string[] = [];

  // 1-3s: 최신값 ±3SD 초과 → 기각(FAIL)
  if (Math.abs(last) > 3) violations.push('1-3s');

  // 2-2s: 연속 2회 동측 ±2SD 초과
  if (zs.length >= 2) {
    const a = zs[zs.length - 1];
    const b = zs[zs.length - 2];
    if (a > 2 && b > 2) violations.push('2-2s');
    if (a < -2 && b < -2) violations.push('2-2s');
  }

  // R-4s: 연속 2회가 서로 반대방향으로 각각 2s 초과(범위 >4s). 같은쪽으로 멀리 떨어진 것은 R-4s 아님(위양성 방지).
  if (zs.length >= 2) {
    const a = zs[zs.length - 1];
    const b = zs[zs.length - 2];
    if ((a > 2 && b < -2) || (a < -2 && b > 2)) violations.push('R-4s');
  }

  // 4-1s: 연속 4회 동측 ±1SD 초과 → 계통오차(기각)
  if (zs.length >= 4) {
    const last4 = zs.slice(-4);
    if (last4.every((v) => v > 1) || last4.every((v) => v < -1)) violations.push('4-1s');
  }

  // 10x: 연속 10회 평균 동측 → 편향(기각)
  if (zs.length >= 10) {
    const last10 = zs.slice(-10);
    if (last10.every((v) => v > 0) || last10.every((v) => v < 0)) violations.push('10x');
  }

  // 1-2s: 경고 규칙(단독이면 통과, 다른 규칙 검토 트리거)
  const warn12s = Math.abs(last) > 2 && Math.abs(last) <= 3;
  if (warn12s && violations.length === 0) violations.push('1-2s(warn)');

  const hardFail = violations.some((v) => ['1-3s', '2-2s', 'R-4s', '4-1s', '10x'].includes(v));
  const verdict = hardFail ? 'FAIL' : violations.length > 0 ? 'WARN' : 'PASS';

  return { z: Number(last.toFixed(2)), violations, verdict };
}

/**
 * Within-run 다중레벨 규칙 — 같은 런에서 여러 컨트롤 레벨의 z를 교차 평가.
 *  - 2-2s(within-run): 두 레벨 이상이 같은 방향으로 2s 초과
 *  - R-4s(within-run): 한 레벨 >+2s, 다른 레벨 <-2s (계통오차)
 * zScores: 같은 실행(run)에서 측정된 각 레벨의 z-score(현재값 포함).
 */
export function crossLevelViolations(zScores: number[]): string[] {
  const v: string[] = [];
  if (zScores.length < 2) return v;
  const over = zScores.filter((z) => z > 2).length;
  const under = zScores.filter((z) => z < -2).length;
  if (over >= 2 || under >= 2) v.push('2-2s(within-run)');
  if (zScores.some((z) => z > 2) && zScores.some((z) => z < -2)) v.push('R-4s(within-run)');
  return v;
}
