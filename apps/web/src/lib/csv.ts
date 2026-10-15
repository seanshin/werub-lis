/**
 * csv.ts — lib 모듈 구성요소.
 *
 * 제공: parseCsv, csvToObjects.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

// 간이 CSV 파서 — 따옴표·이스케이프("")·CRLF 처리. 대량 반입(코드매핑·용어) 공용.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * CSV 셀 인용 — 따옴표 이스케이프 + **수식 주입 중화**.
 *
 * Excel·LibreOffice는 `=`·`+`·`-`·`@`(및 탭/CR)로 시작하는 셀을 수식으로 해석한다.
 * 감사로그 detail·환자명·오더 항목처럼 사용자 입력이 섞이는 값이 그대로 나가면,
 * 감사 대응용으로 받은 CSV를 여는 순간 수식·DDE가 실행될 수 있다(2026-07-30 보안 검토).
 * 앞에 작은따옴표를 붙여 텍스트로 고정한다 — 사람이 읽는 값은 그대로 보인다.
 */
export function csvCell(v: string | number | boolean | null | undefined): string {
  const s = v == null ? '' : String(v);
  const neutralized = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

/** 헤더 행 기준 객체 배열로 변환. 헤더는 트림. */
export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}
