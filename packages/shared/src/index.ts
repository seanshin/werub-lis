/**
 * @lis/shared — LIS 공용 타입·상수·순수함수 (HIS packages/shared 준거)
 *
 * ⚠ **여기 있는 것은 API와 웹이 함께 쓴다. 한쪽에 복사본을 만들지 말 것.**
 * 과거에 `normalizeBarcode`가 양쪽에 바이트 동일하게 복제돼 있었고,
 * **테스트된 사본(API)은 죽어 있고 실제로 도는 사본(웹)은 무테스트**인 상태였다.
 * 화면 라벨도 페이지마다 복제돼 같은 상태가 화면마다 다른 단어로 표시됐다.
 * (근거: docs/재검토_2026-07-21_발견목록.md Q6·M7)
 *
 * Node·브라우저 양쪽에서 돌아야 하므로 **런타임 의존성을 넣지 말 것**(순수 TS만).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export const DOMAINS = ['DIAGNOSTIC', 'MICROBIOLOGY', 'PATHOLOGY', 'TRANSFUSION', 'GENOMIC'] as const;
export type Domain = (typeof DOMAINS)[number];

export const RESULT_FLAGS = ['N', 'H', 'L', 'HH', 'LL'] as const;
export type ResultFlag = (typeof RESULT_FLAGS)[number];

/** API 표준 응답 형태 (HIS 규약: { data, meta } / { error }) */
export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
  meta?: Record<string, unknown>;
}

// ── 바코드 정규화 ────────────────────────────────────────────────
// 서버(수신 검증)와 클라이언트(스캔 즉시 적용)가 **반드시 같은 규칙**이어야 하므로 여기 둔다.

export interface BarcodeNormalizeCfg {
  trimWhitespace: boolean;
  prefixStrip: string | null; // 접두 문자열 제거(있을 때만)
  suffixStrip: string | null; // 접미 문자열 제거(있을 때만)
  stripPattern: string | null; // 정규식 전역 제거 — 잘못된 정규식은 무시(원문 유지)
  minLength: number | null;
  maxLength: number | null;
}

export interface BarcodeNormalizeResult {
  value: string; // 정규화 결과(검체번호 후보)
  valid: boolean; // 길이 규칙 통과 + 비어있지 않음
  warning?: string; // 길이 경고 등
}

export function normalizeBarcode(raw: string, cfg: BarcodeNormalizeCfg): BarcodeNormalizeResult {
  let v = raw ?? '';
  if (cfg.trimWhitespace) v = v.trim();
  if (cfg.prefixStrip && v.startsWith(cfg.prefixStrip)) v = v.slice(cfg.prefixStrip.length);
  if (cfg.suffixStrip && v.endsWith(cfg.suffixStrip)) v = v.slice(0, v.length - cfg.suffixStrip.length);
  if (cfg.stripPattern) {
    // 잘못된 정규식이 스캔을 막지 않도록 무시한다(설정 오류는 저장 시점에 검증 — barcode.service).
    try {
      v = v.replace(new RegExp(cfg.stripPattern, 'g'), '');
    } catch {
      /* 무시 — 원문 유지 */
    }
  }
  if (cfg.trimWhitespace) v = v.trim();

  let warning: string | undefined;
  if (v.length === 0) warning = '빈 값';
  else if (cfg.minLength != null && v.length < cfg.minLength) warning = `길이 부족(${v.length} < ${cfg.minLength})`;
  else if (cfg.maxLength != null && v.length > cfg.maxLength) warning = `길이 초과(${v.length} > ${cfg.maxLength})`;

  return { value: v, valid: v.length > 0 && !warning, warning };
}

// ── HTML 이스케이프 ──────────────────────────────────────────────

/**
 * 보고서·인쇄물 HTML에 값을 넣기 전 이스케이프.
 *
 * ★이것이 유일한 XSS 방어다(보안 검토 2026-07-21). 병리·결과 보고서는 환자명·진단·코멘트를
 * 그대로 문서에 넣고 렌더 결과가 인쇄·포털로 나간다. 우회 경로를 만들지 말 것.
 */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

// ── 상태 라벨 ────────────────────────────────────────────────────
// 화면마다 라벨 맵을 복제해 같은 상태가 다른 단어로 보이던 것을 정본화한다.

/** 오더·오더항목 상태 표시명 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  RECEIVED: '접수',
  IN_PROCESS: '진행',
  COMPLETED: '완료',
  REPORTED: '보고',
  CANCELLED: '취소',
  HOLD: '보류',
};

/** 검체 상태 표시명 */
export const SPECIMEN_STATUS_LABEL: Record<string, string> = {
  RECEIVED: '접수',
  COLLECTED: '채취',
  IN_PROCESS: '진행',
  COMPLETED: '완료',
  REJECTED: '반려',
  STORED: '보관',
  DISPOSED: '폐기',
};

/** 결재 게이트 상태 표시명 — 화면마다 '승인됨'/'승인'으로 갈렸던 것 통일 */
export const GATE_STATUS_LABEL: Record<string, string> = {
  PENDING: '미상신',
  SUBMITTED: '상신',
  IN_PROGRESS: '진행중',
  APPROVED: '완료(승인)',
  REJECTED: '반려',
};

/** 라벨 조회 — 미등록 값은 원문을 그대로 보여준다(빈칸이 되지 않도록). */
export function labelOf(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '';
  return map[key] ?? key;
}

/**
 * Code 128 (subset B) 인코더 — 검체 라벨 화면 인쇄용 실물 바코드(P1-19).
 *
 * 이전 화면 라벨은 문자코드 기반 장식 막대라 스캔되지 않았다(ZPL 출력만 실물).
 * 화면 인쇄 라벨을 실제 스캔 가능하게 하려면 규격 심볼로지가 필요하다.
 *
 * 반환은 모듈 폭 배열(막대·공백 교대, 막대부터 시작) — 렌더러(SVG 등)가 그대로 그린다.
 * 검증: 각 심볼 6요소 11모듈, STOP 7요소 13모듈, 체크섬 mod 103 (ISO/IEC 15417).
 */

// 코드값 0~106의 요소 폭(막대/공백 교대). 105개 데이터·시작 코드 + STOP(106).
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
] as const;

const START_B = 104;
const STOP = 106;

/** 내부 검증용 — 패턴 테이블 노출(스펙 테스트가 11모듈 불변식을 검사한다). */
export const _CODE128_PATTERNS = CODE128_PATTERNS;

/**
 * 텍스트를 Code 128 B로 인코딩해 모듈 폭 배열을 반환(막대부터 시작, 막대/공백 교대).
 * 지원 문자: ASCII 32~126(검체번호·병리번호는 영숫자·하이픈이라 충분). 그 외는 오류.
 */
export function code128Widths(text: string): number[] {
  if (!text) throw new Error('code128: 빈 문자열은 인코딩할 수 없습니다');
  const codes: number[] = [START_B];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`code128: 지원하지 않는 문자(U+${c.toString(16).toUpperCase()}): ${ch}`);
    codes.push(c - 32);
  }
  let checksum = codes[0];
  for (let i = 1; i < codes.length; i++) checksum += codes[i] * i;
  codes.push(checksum % 103);
  codes.push(STOP);
  const widths: number[] = [];
  for (const code of codes) for (const w of CODE128_PATTERNS[code]) widths.push(Number(w));
  return widths;
}

/** 총 모듈 수(quiet zone 제외) — 렌더러가 viewBox 폭 계산에 사용. */
export function code128TotalModules(widths: number[]): number {
  return widths.reduce((s, w) => s + w, 0);
}

// ============================================================
// 단위(UCUM) 사전 — UX 기획 §2-4
// ============================================================

/**
 * UCUM 표기 ↔ 사람이 읽는 뜻. 화면의 단위 텍스트에 붙여 오해를 막는다.
 *
 * 필요한 이유: `10*3/uL`·`mL/min/1.73m2` 같은 UCUM 표기는 검사자도 즉시 읽지 못하고,
 * `mg/dL`↔`mmol/L`처럼 **혼동하면 값을 오판**하는 쌍이 있다. 참고치에 단위 컬럼이 없어
 * "참고치의 단위 = 결과의 단위"가 시스템으로 보장되지 않는 현 구조에서 특히 중요하다.
 */
export interface UnitInfo {
  /** 사람이 읽는 표기(화면 별칭) */
  display: string;
  /** 무엇을 재는가 */
  meaning: string;
  /** 혼동하기 쉬운 단위·주의 */
  caution?: string;
}

export const UNIT_DICT: Record<string, UnitInfo> = {
  '%': { display: '%', meaning: '백분율' },
  '10*3/uL': { display: '×10³/µL (천 개/µL)', meaning: '부피당 세포 수', caution: '1,000/µL 단위 — 4.5는 4,500개/µL를 뜻합니다' },
  '10*6/uL': { display: '×10⁶/µL (백만 개/µL)', meaning: '부피당 세포 수(적혈구)', caution: '백만 단위 — 4.5는 450만/µL' },
  'U/L': { display: 'U/L', meaning: '리터당 효소 활성 단위' },
  fL: { display: 'fL (펨토리터)', meaning: '세포 하나의 부피(MCV 등)' },
  'g/dL': { display: 'g/dL', meaning: '데시리터당 그램', caution: 'g/L과 10배 차이' },
  'mIU/L': { display: 'mIU/L', meaning: '리터당 밀리 국제단위' },
  'uIU/mL': { display: 'µIU/mL', meaning: '밀리리터당 마이크로 국제단위', caution: 'mIU/L과 수치가 같습니다(1 µIU/mL = 1 mIU/L)' },
  'mL/min/1.73m2': { display: 'mL/분/1.73 m²', meaning: '체표면적 보정 사구체여과율' },
  'mg/L': { display: 'mg/L', meaning: '리터당 밀리그램', caution: 'mg/dL과 10배 차이' },
  'mg/dL': { display: 'mg/dL', meaning: '데시리터당 밀리그램', caution: 'SI 단위(mmol/L)와 값이 다릅니다 — 장비 설정 확인' },
  'mmol/L': { display: 'mmol/L', meaning: '리터당 밀리몰(SI)', caution: 'mg/dL과 환산 계수가 물질마다 다릅니다' },
  'ng/dL': { display: 'ng/dL', meaning: '데시리터당 나노그램' },
  'ug/mL': { display: 'µg/mL', meaning: '밀리리터당 마이크로그램' },
  s: { display: '초(s)', meaning: '응고 시간' },
};

/** 단위 표시 별칭 — 미등록 단위는 원문 그대로(빈칸이 되지 않게). */
export function unitDisplay(unit: string | null | undefined): string {
  const u = (unit ?? '').trim();
  if (!u) return '';
  return UNIT_DICT[u]?.display ?? u;
}

/** 참고치 문자열 — 단위와 함께. 하이픈·물결 대신 en-dash 통일(기획 §1-6). */
export function formatRange(low: number | null | undefined, high: number | null | undefined, unit?: string | null): string {
  if (low == null && high == null) return '—';
  const lo = low != null ? String(low) : '';
  const hi = high != null ? String(high) : '';
  const body = low != null && high != null ? `${lo} – ${hi}` : low != null ? `≥ ${lo}` : `≤ ${hi}`;
  const u = (unit ?? '').trim();
  return u ? `${body} ${unitDisplay(u)}` : body;
}

// ============================================================
// 용어 사전 — UX 기획 §2-1 (화면 팝오버·용어집·상태 라벨 공용 정본)
// ============================================================

export interface GlossaryTerm {
  key: string;
  term: string;
  /** 한 줄 — 팝오버용 */
  short: string;
  /** 왜 중요한가(임상·업무 의미) — 용어집용 */
  why?: string;
  /** 검색 동의어(영문·약어·표기 변형) */
  synonyms?: string[];
  category: '결과판정' | '품질(QC)' | '수혈' | '미생물' | '병리' | '유전체' | '운영·연계';
  /** 약어 여부 — <abbr> 시맨틱 적용 */
  abbr?: boolean;
}

export const GLOSSARY: GlossaryTerm[] = [
  // ── 결과 판정 ──
  { key: 'panic', term: '위험치', short: '즉시 담당의에게 알려야 하는 생명 위협 수준의 결과값.', why: '통보·확인(read-back)까지 기록해야 폐루프가 닫힌다. 미확인은 자동 에스컬레이션된다.', synonyms: ['panic value', 'critical value', 'HH', 'LL', '패닉치'], category: '결과판정' },
  { key: 'delta-check', term: '델타 체크', short: '같은 환자의 직전 결과 대비 급격한 변화를 잡는 검사.', why: '검체 뒤바뀜·오입력을 잡는 대표적 안전장치라, 걸리면 자동확정을 막고 사람이 본다.', synonyms: ['delta', '델타', 'Δ'], category: '결과판정' },
  { key: 'auto-verify', term: '자동확정', short: '규칙을 모두 통과한 결과를 사람 검토 없이 확정하는 것.', why: '참고치·QC·델타·검사별 정책 중 하나라도 걸리면 자동확정하지 않고 보류된다.', synonyms: ['AUTO', 'auto verify', '자동검증'], category: '결과판정' },
  { key: 'verify', term: '확정(검증)', short: '사람이 결과를 검토해 보고 가능 상태로 만드는 것.', why: '확정된 결과만 보고서·HIS 발신·청구 대상이 된다.', synonyms: ['VERIFIED', '2차검증'], category: '결과판정' },
  { key: 'ref-range', term: '참고치', short: '정상으로 보는 값의 범위(성별·연령별).', why: '참고치가 없으면 정상/위험 판정 자체가 불가능해 자동확정이 차단된다(NO_RANGE).', synonyms: ['reference range', '정상범위', '기준치'], category: '결과판정' },
  { key: 'rerun', term: '재검', short: '같은 검체를 다시 검사해 새 버전으로 등록하는 것.', why: '재검값이 최신 버전이 되어 보고서에 실린다(원본은 이력으로 남는다).', synonyms: ['rerun', '재실험'], category: '결과판정' },
  { key: 'correction', term: '정정', short: '이미 확정된 결과를 고쳐 새 버전으로 보고하는 것.', why: '이전 값은 지워지지 않고 버전으로 남아 감사 추적이 가능하다.', synonyms: ['correction', 'C', '개정'], category: '결과판정' },
  { key: 'dilution', term: '희석배수', short: '측정 범위를 넘는 검체를 묽혀 재측정할 때의 배수.', why: '저장되는 값은 원측정값 × 배수(참값)다.', synonyms: ['dilution factor', '희석'], category: '결과판정' },
  { key: 'hold-critical', term: '보류: 위험치', short: '위험치라서 자동확정하지 않고 사람 확인을 기다리는 상태.', category: '결과판정' },
  { key: 'hold-delta', term: '보류: 델타', short: '직전 결과 대비 급변이라 확인이 필요한 상태.', category: '결과판정' },
  { key: 'hold-qc', term: '보류: QC', short: '해당 검사의 당일 QC가 실패해 결과를 확정할 수 없는 상태.', why: '장비 재교정·QC 재실행 후 검토한다.', category: '결과판정' },
  { key: 'hold-no-range', term: '보류: 참고치 없음', short: '참고치가 없어 정상/위험 판정을 할 수 없는 상태.', why: '마스터에 참고치를 등록하면 해소된다.', category: '결과판정' },
  { key: 'hold-policy', term: '보류: 정책', short: '이 검사는 항상 사람이 검증하도록 설정돼 있다.', category: '결과판정' },
  { key: 'hold-sendout', term: '보류: 위탁회신', short: '외부 위탁 결과라 자동확정하지 않고 검토 대상으로 둔다.', category: '결과판정' },
  { key: 'calculated', term: '계산검사', short: '직접 측정하지 않고 다른 결과로 계산한 값(eGFR·LDL 등).', why: '입력 검사가 바뀌면 다시 계산된다. 산출식은 값 옆 설명에서 볼 수 있다.', synonyms: ['CALCULATED', '파생검사', 'derived'], category: '결과판정' },
  { key: 'panel', term: '패널', short: '여러 검사를 묶은 오더 코드(전해질 = Na·K·Cl).', why: '패널 코드로 들어온 오더는 구성 검사로 자동 전개된다.', synonyms: ['panel', '묶음검사'], category: '결과판정' },
  { key: 'tat', term: 'TAT', short: '접수부터 결과 보고까지 걸린 시간.', why: '진료 대기와 직결되는 대표 품질지표다.', synonyms: ['turnaround time', '소요시간'], category: '품질(QC)', abbr: true },
  { key: 'p90', term: 'p90', short: '90%의 건이 이 시간 안에 끝났다는 뜻(90분위수).', why: '평균은 극단값에 가려지므로 p90을 함께 본다.', synonyms: ['90분위', 'percentile'], category: '품질(QC)' },

  // ── 품질(QC) ──
  { key: 'qc', term: 'QC(정도관리)', short: '알고 있는 값의 관리물질을 측정해 장비 상태를 확인하는 것.', why: 'QC가 실패하면 그 검사의 환자 결과를 확정할 수 없다.', synonyms: ['quality control', '정도관리'], category: '품질(QC)', abbr: true },
  { key: 'westgard', term: 'Westgard 규칙', short: 'QC 값이 벗어난 정도를 판정하는 표준 규칙(1-3s·2-2s 등).', why: '1-3s는 즉시 실패, 2-2s·10x 등은 경향성 경고다.', synonyms: ['웨스트가드', '1-3s', '2-2s'], category: '품질(QC)' },
  { key: 'lj-chart', term: 'Levey-Jennings 차트', short: 'QC 값을 시간순으로 그린 관리도(평균 ±SD 밴드).', synonyms: ['LJ', '관리도'], category: '품질(QC)' },
  { key: 'lot-crossover', term: '로트 크로스오버', short: '새 QC 로트의 목표값(평균·SD)을 평행검사로 확립하는 절차.', why: '로트가 바뀌면 목표값도 바뀌므로 반드시 다시 잡아야 한다.', synonyms: ['crossover', '로트 전환'], category: '품질(QC)' },
  { key: 'eqa', term: 'EQA(외부정도관리)', short: '외부 기관이 보낸 검체를 측정해 타 기관과 비교하는 평가.', synonyms: ['external quality assessment', '숙련도검사'], category: '품질(QC)', abbr: true },

  // ── 수혈 ──
  { key: 'abo-barrier', term: 'ABO 독립검증 방벽', short: '출고 직전 환자 혈액형을 독립적으로 재확인하는 차단 장치.', why: 'ABO 불일치 수혈은 즉시 치명적이라 어떤 사유로도 우회할 수 없다.', synonyms: ['ABO', '독립방벽'], category: '수혈' },
  { key: 'crossmatch', term: '교차시험', short: '환자 혈청과 제제 적혈구의 적합성을 확인하는 검사.', why: '적합/부적합 외에 "추가검사필요"(항체양성 → AHG 교차)가 있다.', synonyms: ['crossmatch', 'XM', '교차적합'], category: '수혈' },
  { key: 'antibody-screen', term: '항체선별', short: '환자 혈청에 비예기 항체가 있는지 확인하는 검사.', why: '양성이면 전자교차가 불가하고 항체동정·항원음성 혈액이 필요하다.', synonyms: ['antibody screening', '비예기항체'], category: '수혈' },
  { key: 'antigen-neg', term: '항원음성 혈액', short: '환자 항체가 반응하는 항원이 없는 제제.', category: '수혈' },
  { key: 'special-req', term: '특수수혈 요구', short: '방사선조사·CMV음성·백혈구제거·세척 등 환자별 필수 조건.', why: 'TA-GVHD 등 예방 목적이라 서버가 출고 시 강제 확인한다.', synonyms: ['방사선조사', 'CMV음성', '백혈구제거', '세척'], category: '수혈' },
  { key: 'lookback', term: 'Look-back(역추적)', short: '문제 헌혈에서 나온 제제를 받은 수혈자를 거꾸로 찾는 것.', why: '공혈자 사후 양성 통보 시 추가검사·통보 대상을 확정한다.', synonyms: ['룩백', '역추적'], category: '수혈' },
  { key: 'mtp', term: 'MTP(대량수혈)', short: '대량출혈 응급 시 교차시험 전 O형 등을 즉시 출고하는 절차.', why: '응급이어도 ABO 방벽과 사후 기록은 유지된다.', synonyms: ['massive transfusion', '대량수혈프로토콜'], category: '수혈', abbr: true },
  { key: 'return-window', term: '냉장 30분 규칙', short: '출고 후 일정 시간(기본 30분)을 넘기면 재입고할 수 없다.', why: '통제 온도를 벗어난 제제는 안전을 보장할 수 없어 폐기한다.', synonyms: ['30분', '재입고'], category: '수혈' },

  // ── 미생물 ──
  { key: 'gram-prelim', term: '그람 예비보고', short: '배양 확정 전 그람염색 소견을 먼저 알리는 단계 보고.', why: '초기 항생제 선택을 앞당긴다.', synonyms: ['gram stain', '그람염색'], category: '미생물' },
  { key: 'mdro', term: 'MDRO(다제내성균)', short: '여러 항생제에 내성인 균 — 격리·감염관리 대상.', synonyms: ['multidrug-resistant', '다제내성'], category: '미생물', abbr: true },
  { key: 'ast', term: 'AST(항생제 감수성)', short: '균이 어떤 항생제에 듣는지 보는 검사(S/I/R).', why: 'S=감수성, I=중간, R=내성. 1차약이 S면 예비약 보고를 억제한다(선택적 보고).', synonyms: ['antimicrobial susceptibility', '감수성검사', 'S/I/R'], category: '미생물', abbr: true },
  { key: 'mic', term: 'MIC(최소억제농도)', short: '균의 증식을 억제하는 항생제의 최소 농도.', why: 'CLSI 기준으로 S/I/R을 판정하는 근거값이다.', synonyms: ['minimum inhibitory concentration'], category: '미생물', abbr: true },
  { key: 'notifiable', term: '법정감염병 신고', short: '법으로 정해진 감염병 검출 시 기한 내 신고해야 하는 절차.', why: '등급별 신고 기한이 다르며 감염관리팀 알림이 함께 발생한다.', synonyms: ['법정전염병', '신고대상'], category: '미생물' },

  // ── 병리 ──
  { key: 'grossing', term: '그로싱(육안검사)', short: '조직을 육안으로 관찰·기술하고 블록용으로 자르는 단계.', synonyms: ['gross', '육안검사'], category: '병리' },
  { key: 'block-slide', term: '블록·슬라이드', short: '조직을 파라핀에 굳힌 것(블록)과 얇게 잘라 염색한 것(슬라이드).', category: '병리' },
  { key: 'signout', term: '2단계 사인아웃', short: '초안 작성 후 판독의가 전자서명해 최종 확정하는 절차.', why: '확정된 진단은 덮어쓸 수 없고 개정으로만 바꾼다.', synonyms: ['sign-out', '판독확정'], category: '병리' },
  { key: 'amend-vs-addendum', term: '개정 vs 추가보고', short: '개정=진단이 바뀜(버전 증가), 추가보고=진단은 그대로 결과만 덧붙임.', why: '법적·임상적 의미가 달라 구분해 기록한다.', synonyms: ['amend', 'addendum', '개정', '추가보고'], category: '병리' },
  { key: 'frozen', term: '동결절편', short: '수술 중 즉시 진단을 위해 조직을 얼려 절편하는 검사.', why: '이후 영구절편 결과와 일치도(concordance)를 기록한다.', synonyms: ['frozen section', '동결'], category: '병리' },

  // ── 유전체 ──
  { key: 'acmg', term: 'ACMG 분류', short: '유전 변이를 병원성 5단계로 나누는 국제 기준.', synonyms: ['pathogenic', 'benign', '병원성분류'], category: '유전체', abbr: true },
  { key: 'vus', term: 'VUS(의미불명 변이)', short: '병원성 여부를 판단할 근거가 부족한 변이.', why: '단독으로 임상 결정을 내리지 않는다.', synonyms: ['variant of uncertain significance', '의의불명'], category: '유전체', abbr: true },
  { key: 'secondary-finding', term: '2차 발견(SF)', short: '검사 목적과 무관하게 발견된 임상적으로 중요한 변이.', why: '환자 동의 범위 안에서만 보고한다.', synonyms: ['secondary finding', 'SF', '부수적 발견'], category: '유전체' },

  // ── 운영·연계 ──
  { key: 'watermark', term: '워터마크(폴링)', short: 'HIS에서 어디까지 받아왔는지 표시하는 시각 기준점.', why: '실패한 오더 앞에서 멈춰야 유실이 생기지 않는다.', synonyms: ['watermark', '폴링기준'], category: '운영·연계' },
  { key: 'dlq', term: 'DLQ(격리 큐)', short: '재시도를 다 쓰고도 실패한 발신 메시지가 모이는 곳.', why: '쌓이면 HIS로 결과가 못 나가고 있다는 뜻이라 즉시 확인해야 한다.', synonyms: ['dead letter queue', '격리'], category: '운영·연계', abbr: true },
  { key: 'dropped-queue', term: '미적재 대기열', short: '코드 미매핑 등으로 LIS에 못 들어온 HIS 오더 보관함.', why: '매핑을 고친 뒤 재적재하면 유실 없이 복구된다.', synonyms: ['dropped', '보류 오더'], category: '운영·연계' },
  { key: 'downtime-order', term: '다운타임 오더', short: 'HIS 장애 중 LIS에서 직접 수기로 접수한 오더.', why: 'HIS 복구 후 오더번호를 연결(대사)해 이중 청구를 막는다.', synonyms: ['downtime', '수기접수'], category: '운영·연계' },
  { key: 'addon', term: 'Add-on(추가검사)', short: '이미 접수된 검체에 검사를 더하는 것(재채취 없이).', why: '환자 재천자를 피할 수 있으나 검체 잔량은 사람이 판단한다.', synonyms: ['add-on', '추가오더'], category: '운영·연계' },
  { key: 'request-id', term: '문의번호(요청 ID)', short: '오류 화면에 표시되는 요청 식별자.', why: '이 번호를 알려주면 담당자가 해당 요청 로그를 바로 찾는다.', synonyms: ['requestId', 'correlation id', 'rid'], category: '운영·연계' },
];

export const GLOSSARY_BY_KEY: Record<string, GlossaryTerm> = Object.fromEntries(GLOSSARY.map((g) => [g.key, g]));

/** 용어 검색 — 용어명·동의어·설명 부분일치(대소문자 무시). */
export function searchGlossary(q: string): GlossaryTerm[] {
  const s = q.trim().toLowerCase();
  if (!s) return GLOSSARY;
  return GLOSSARY.filter((g) =>
    g.term.toLowerCase().includes(s) ||
    g.short.toLowerCase().includes(s) ||
    g.key.includes(s) ||
    (g.synonyms ?? []).some((x) => x.toLowerCase().includes(s)),
  );
}

/** 상태 코드 → 한글 라벨 + 용어 key(팝오버 연결). 화면에 원시 코드를 노출하지 않기 위함. */
export const STATUS_LABEL: Record<string, { label: string; termKey?: string }> = {
  CRITICAL: { label: '위험치', termKey: 'hold-critical' },
  DELTA: { label: '델타 초과', termKey: 'hold-delta' },
  QC: { label: 'QC 실패', termKey: 'hold-qc' },
  NO_RANGE: { label: '참고치 없음', termKey: 'hold-no-range' },
  PANIC_UNSET: { label: '위험치 경계 미설정' },
  UNIT_MISMATCH: { label: '단위 불일치' },
  POLICY: { label: '검사 정책', termKey: 'hold-policy' },
  SENDOUT: { label: '위탁 회신', termKey: 'hold-sendout' },
  NONNUMERIC: { label: '비수치 결과' },
  INSTRUMENT: { label: '장비 오류' },
  AUTO: { label: '자동확정', termKey: 'auto-verify' },
  VERIFIED: { label: '확정', termKey: 'verify' },
  PENDING: { label: '미확정' },
  DLQ: { label: '격리(DLQ)', termKey: 'dlq' },
  STAGED: { label: '발신 대기' },
  DROPPED: { label: '미적재', termKey: 'dropped-queue' },
  CALCULATED: { label: '계산값', termKey: 'calculated' },
};

/** 상태 코드 라벨 — 미등록 코드는 원문 그대로(빈칸 방지). */
export function statusLabel(code: string | null | undefined): string {
  const c = (code ?? '').trim();
  if (!c) return '';
  return STATUS_LABEL[c]?.label ?? c;
}
