/**
 * 외부정도관리(EQA/숙련도시험) 도메인 (순수 함수).
 * 근거: 기획 22 §5·인증(외부정도관리 EQA).
 * SDI(Standard Deviation Index) = (측정값 - 또래군 평균) / 또래군 SD.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export function computeSdi(value: number, peerMean: number, peerSd: number): number {
  if (!peerSd) return 0;
  return Math.round(((value - peerMean) / peerSd) * 100) / 100;
}

export type EqaVerdict = 'ACCEPT' | 'WARNING' | 'UNACCEPTABLE';

/** |SDI| ≤2 수용, ≤3 경고, >3 부적합. */
export function eqaVerdict(sdi: number): EqaVerdict {
  const a = Math.abs(sdi);
  if (a <= 2) return 'ACCEPT';
  if (a <= 3) return 'WARNING';
  return 'UNACCEPTABLE';
}
