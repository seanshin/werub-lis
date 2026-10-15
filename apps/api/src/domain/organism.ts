/**
 * 균명 정규화(순수) — 소문자·마침표 정리 + **축약 속명 확장**.
 *
 * 왜: 균명은 자유 텍스트로 축약 입력이 흔하다("K. pneumoniae", "E. cloacae"). 정규화가 축약 속명을
 * 펼치지 않으면 MDRO/CRE 분류·AST 브레이크포인트 매칭이 속 키워드('klebsiella' 등)에 걸리지 않아
 * **조용히 실패**한다 → 격리 미발령·법정감염병 신고 누락·AST 자동판정 누락(회귀 금지).
 * (S. aureus·E. coli만 우연히 종 epithet이 키워드라 동작했다 — 나머지 속은 전부 누락됐다.)
 *
 * 확장은 안전하게: 속명이 1글자 이니셜인 "<i> <종>" 형태에서, 종 epithet의 정식 속명이 그 이니셜로
 * 시작할 때만 펼친다 — "S. pneumoniae"(Streptococcus)를 Klebsiella로 오확장하지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
const SPECIES_TO_GENUS: Record<string, string> = {
  pneumoniae: 'klebsiella', oxytoca: 'klebsiella', aerogenes: 'enterobacter', cloacae: 'enterobacter',
  marcescens: 'serratia', freundii: 'citrobacter', mirabilis: 'proteus', vulgaris: 'proteus', morganii: 'morganella',
  coli: 'escherichia', aureus: 'staphylococcus', epidermidis: 'staphylococcus',
  faecium: 'enterococcus', faecalis: 'enterococcus', aeruginosa: 'pseudomonas', baumannii: 'acinetobacter',
};

export function normalizeOrganism(s: string | null | undefined): string {
  const o = (s ?? '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  const m = o.match(/^([a-z]) ([a-z]+)/); // "k pneumoniae"처럼 속명이 1글자 이니셜
  if (m) {
    const genus = SPECIES_TO_GENUS[m[2]];
    if (genus && genus.startsWith(m[1])) return `${genus} ${o.slice(2)}`; // 이니셜 일치 시에만 확장
  }
  return o;
}
