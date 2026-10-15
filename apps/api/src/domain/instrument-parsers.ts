/**
 * 장비 인터페이스 파서 (Domain, 순수 함수) — 자동 결과 수집 경로.
 * 근거: 기획 22 §6-2. 협조 업체 장비의 원시 결과를 표준 RawResult[]로 정규화.
 * 지원: ASTM E1394(레코드 H/P/O/R/L), 계기 CSV. (HL7 ORU는 기존 parseHl7 재사용 예정)
 *
 * 수기·문서 경로와 무관하게, 산출된 RawResult[]는 동일한 결과 수집 파이프라인
 * (코드매핑 → 자동평가 → 2차검증)으로 수렴한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface RawResult {
  specimenId: string; // 검체 식별자(바코드) = LIS specimenNo
  rawCode: string; // 장비 검사코드
  value: string;
  unit?: string;
}

/** ASTM E1394 컨트롤 문자(STX/ETX/CR/LF/체크섬)를 제거하고 레코드 라인 배열로. */
function astmRecords(raw: string): string[] {
  return raw
    .replace(/[\x02\x03\x04\x05\x06\x15]/g, '') // STX ETX EOT ENQ ACK NAK
    .split(/[\r\n]+/)
    .map((l) => l.replace(/^\d+/, '').trim()) // 선두 프레임 시퀀스 번호 제거
    .filter((l) => l.length > 0);
}

/** ASTM R-2(Universal Test ID, `^^^CODE^`)에서 검사코드 추출 — 마지막 비어있지 않은 컴포넌트. */
function astmTestCode(universalTestId: string): string {
  const comps = universalTestId.split('^').filter((c) => c.trim() !== '');
  return comps.length ? comps[comps.length - 1] : universalTestId;
}

/**
 * ASTM E1394 파싱 — O(오더/검체) 레코드로 현재 검체를 추적, R(결과) 레코드를 수집.
 * O-3(검체ID) 우선, 없으면 O-2. R-2=검사코드, R-3=값, R-4=단위.
 */
export function parseAstm(raw: string): RawResult[] {
  const out: RawResult[] = [];
  let specimenId = '';
  for (const rec of astmRecords(raw)) {
    const f = rec.split('|');
    const type = f[0].toUpperCase();
    if (type === 'O') {
      specimenId = (f[3] && f[3].trim()) || (f[2] && f[2].trim()) || specimenId;
    } else if (type === 'R') {
      const rawCode = astmTestCode(f[2] ?? '');
      const value = (f[3] ?? '').trim();
      const unit = (f[4] ?? '').trim() || undefined;
      if (rawCode && value !== '') out.push({ specimenId, rawCode, value, unit });
    }
  }
  return out;
}

/**
 * 계기 CSV 파싱 — 헤더 포함, 열: specimen,test,value[,unit].
 * 열 이름 유연 매칭(specimen/sample/barcode, test/code, value/result, unit).
 */
export function parseInstrumentCsv(raw: string): RawResult[] {
  const lines = raw.split(/[\r\n]+/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const si = idx(['specimen', 'specimenno', 'sample', 'barcode']);
  const ti = idx(['test', 'testcode', 'code']);
  const vi = idx(['value', 'result']);
  const ui = idx(['unit', 'units']);
  if (si < 0 || ti < 0 || vi < 0) return [];
  const out: RawResult[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',').map((x) => x.trim());
    const specimenId = c[si];
    const rawCode = c[ti];
    const value = c[vi];
    if (specimenId && rawCode && value !== undefined && value !== '') {
      out.push({ specimenId, rawCode, value, unit: ui >= 0 ? c[ui] || undefined : undefined });
    }
  }
  return out;
}

/** 포맷 자동 판별 후 파싱. */
export function parseInstrumentPayload(format: 'ASTM' | 'CSV', raw: string): RawResult[] {
  return format === 'CSV' ? parseInstrumentCsv(raw) : parseAstm(raw);
}
