/**
 * 경량 HL7 v2.x 파서/빌더 — 근거: 01 연계규격서, 09 §2 필드매핑.
 * 대상 세그먼트: MSH/PID/PV1/ORC/OBR/OBX. 순수 함수로 구현(테스트 용이).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface Hl7Segment {
  id: string;
  tokens: string[]; // '|' 분리
}

export interface Hl7Message {
  segments: Hl7Segment[];
}

/** 원문 → 세그먼트 배열 (구분자 \r, \n, \r\n 허용) */
export function parseHl7(raw: string): Hl7Message {
  const lines = raw
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const segments = lines.map((line) => {
    const tokens = line.split('|');
    return { id: tokens[0], tokens };
  });
  return { segments };
}

/** 첫 번째 해당 세그먼트 반환 */
export function seg(msg: Hl7Message, id: string): Hl7Segment | undefined {
  return msg.segments.find((s) => s.id === id);
}

/** 모든 해당 세그먼트 */
export function segs(msg: Hl7Message, id: string): Hl7Segment[] {
  return msg.segments.filter((s) => s.id === id);
}

/**
 * 필드 조회. HL7 MSH 오프셋 처리:
 *  MSH-1 = '|'(구분자), MSH-2 = '^~\&', MSH-3 = tokens[2] ...
 *  기타 세그먼트: field N = tokens[N] (tokens[0]=세그먼트ID)
 */
export function field(s: Hl7Segment | undefined, n: number): string {
  if (!s) return '';
  if (s.id === 'MSH') {
    if (n === 1) return '|';
    return s.tokens[n - 1] ?? '';
  }
  return s.tokens[n] ?? '';
}

/** 컴포넌트(^ 분리) 조회 (1-base) */
export function comp(value: string, c: number): string {
  return value.split('^')[c - 1] ?? '';
}

// ============================================================
// 파싱 결과 → 도메인 매핑용 구조 (OML^O21)
// ============================================================
export interface ParsedOrder {
  messageControlId: string; // MSH-10 (멱등키)
  messageType: string; // MSH-9
  patient: {
    patientId: string; // PID-3
    familyName: string;
    givenName: string;
    birthDate: string; // PID-7 YYYYMMDD → YYYY-MM-DD
    sex: string; // PID-8
  };
  visit: {
    type: string; // PV1-2
    ward: string; // PV1-3 comp1 (구역/병동)
    dept: string; // PV1-3 comp2 (진료과)
    provider: string; // PV1-7 component1
  };
  hisOrderNo: string; // ORC-2 / OBR-2
  orderControl: string; // ORC-1 (NW/CA/XO)
  priority: string; // OBR-27 (S/R)
  testCodes: string[]; // OBR-4 component1 (반복 OBR)
  orderingProvider: { id: string; name: string }; // 처방의: ORC-12 → OBR-16 → PV1-7 폴백
}

/** OML^O21 → ParsedOrder (09 §2.1) */
export function mapOml(msg: Hl7Message): ParsedOrder {
  const msh = seg(msg, 'MSH');
  const pid = seg(msg, 'PID');
  const pv1 = seg(msg, 'PV1');
  const orc = seg(msg, 'ORC');
  const obrList = segs(msg, 'OBR');

  const birthRaw = field(pid, 7);
  const birthDate =
    birthRaw.length === 8
      ? `${birthRaw.slice(0, 4)}-${birthRaw.slice(4, 6)}-${birthRaw.slice(6, 8)}`
      : birthRaw;

  return {
    messageControlId: field(msh, 10),
    messageType: field(msh, 9),
    patient: {
      // PACS 컷오버 정책: PatientID 후행공백 정규화(edge-trim). 선행0·하이픈 등 유의 문자는 보존(trimEnd만).
      patientId: comp(field(pid, 3), 1).replace(/\s+$/, ''),
      familyName: comp(field(pid, 5), 1),
      givenName: comp(field(pid, 5), 2),
      birthDate,
      sex: field(pid, 8),
    },
    visit: {
      type: field(pv1, 2),
      ward: comp(field(pv1, 3), 1),
      dept: comp(field(pv1, 3), 2) || comp(field(pv1, 3), 1),
      provider: comp(field(pv1, 7), 1),
    },
    hisOrderNo: field(orc, 2) || field(obrList[0], 2),
    orderControl: field(orc, 1) || 'NW',
    priority: field(obrList[0], 27) || 'R',
    testCodes: obrList.map((o) => comp(field(o, 4), 1)).filter((c) => c.length > 0),
    orderingProvider: (() => {
      // 처방의(ordering provider): ORC-12 우선 → OBR-16 → PV1-7(주치의) 폴백. id^성^명
      const id = comp(field(orc, 12), 1) || comp(field(obrList[0], 16), 1) || comp(field(pv1, 7), 1);
      const fam = comp(field(orc, 12), 2) || comp(field(obrList[0], 16), 2) || comp(field(pv1, 7), 2);
      const giv = comp(field(orc, 12), 3) || comp(field(obrList[0], 16), 3) || comp(field(pv1, 7), 3);
      return { id, name: [fam, giv].filter(Boolean).join(' ').trim() };
    })(),
  };
}

// ============================================================
// 결과 발신 (ORU^R01) 빌더 (09 §2.2)
// ============================================================
export interface OruResultLine {
  loinc: string;
  testName: string;
  value: string;
  unit: string;
  refRange: string;
  flag: string; // N/H/L/HH/LL
  status: string; // P/F/C
}

export interface OruInput {
  sendingApp: string;
  receivingApp: string;
  facility: string;
  messageControlId: string;
  nowStamp: string; // YYYYMMDDHHMMSS
  patientId: string;
  patientName: string; // family^given
  hisOrderNo: string;
  specimenNo: string;
  orderCode: string;
  orderName: string;
  results: OruResultLine[];
}

/**
 * HL7 v2 데이터 필드 이스케이프 — 자유텍스트(값·명칭·사유)에 포함된 구분자를
 * 이스케이프 시퀀스로 치환해 필드 주입/메시지 손상 방지(반드시 `\` 먼저).
 */
export function escHl7(v: string | number | null | undefined): string {
  if (v == null) return '';
  return String(v)
    .replace(/\\/g, '\\E\\')
    .replace(/\|/g, '\\F\\')
    .replace(/\^/g, '\\S\\')
    .replace(/~/g, '\\R\\')
    .replace(/&/g, '\\T\\')
    // CR/LF는 세그먼트 구분자 — 자유텍스트에 있으면 가짜 세그먼트가 주입되므로 HL7 이스케이프로 치환
    .replace(/\r\n|\r|\n/g, '\\X0D\\');
}

/** ORU^R01 메시지 생성 (세그먼트 \r 결합) */
export function buildOru(input: OruInput): string {
  const lines: string[] = [];
  lines.push(
    `MSH|^~\\&|${input.sendingApp}|${input.facility}|${input.receivingApp}|${input.facility}|${input.nowStamp}||ORU^R01|${input.messageControlId}|P|2.5.1`,
  );
  // 외부 유입 식별자도 이스케이프(값에 ^/| 등 구분자가 있으면 필드 밀림 방지)
  lines.push(`PID|1||${escHl7(input.patientId)}^^^${input.facility}^MR||${escHl7(input.patientName)}`);
  lines.push(
    `OBR|1|${escHl7(input.hisOrderNo)}|${escHl7(input.specimenNo)}|${escHl7(input.orderCode)}^${escHl7(input.orderName)}^L|||${input.nowStamp}|||||||||||||||${input.nowStamp}|||F`,
  );
  input.results.forEach((r, i) => {
    lines.push(
      `OBX|${i + 1}|NM|${escHl7(r.loinc)}^${escHl7(r.testName)}^LN||${escHl7(r.value)}|${escHl7(r.unit)}|${escHl7(r.refRange)}|${r.flag}|||${r.status}|||${input.nowStamp}`,
    );
  });
  return lines.join('\r');
}

// ============================================================
// PACS 모달리티 워크리스트 (ORM^O01) 빌더 — PACS 정본 스펙(§3) 준수
//   AccessionNumber: OBR-3 = ORC-3 = ORC-2 동일값 / OBR-24 = Modality(SM)
//   OBR-7 = ScheduledProcedureStep 시작일시 / MSH 버전 2.3
// ============================================================
export interface OrmInput {
  sendingApp?: string; // 기본 LIS
  sendingFac?: string; // 기본 WEVE
  receivingApp?: string; // 기본 OPENPACS
  receivingFac?: string; // 기본 WERUB
  messageControlId: string;
  nowStamp: string; // YYYYMMDDHHMMSS
  patientId: string;
  patientFamily: string;
  patientGiven: string;
  birthDate: string; // YYYYMMDD
  sex: string;
  accession: string; // ACC-{병리번호} (≤16자)
  procedureId: string; // 예: PATH
  procedureDesc: string; // 예: 병리 슬라이드 스캔
  scheduledTs: string; // YYYYMMDDHHMMSS
  modality: string; // 병리 WSI = SM
  orderControl?: string; // ORC-1: 신규 NW(기본) / 취소 CA (PACS 결정2)
}

export function buildOrm(input: OrmInput): string {
  const sApp = input.sendingApp ?? 'LIS';
  const sFac = input.sendingFac ?? 'WEVE';
  const rApp = input.receivingApp ?? 'OPENPACS';
  const rFac = input.receivingFac ?? 'WERUB';

  const msh = `MSH|^~\\&|${sApp}|${sFac}|${rApp}|${rFac}|${input.nowStamp}||ORM^O01|${input.messageControlId}|P|2.3`;
  // 데이터 필드는 전부 escHl7 — 값에 |^~\& 나 CR/LF가 있으면 필드 밀림·세그먼트 주입이 된다(buildOru와 동일 규약).
  const pid = `PID|1||${escHl7(input.patientId)}||${escHl7(input.patientFamily)}^${escHl7(input.patientGiven)}||${escHl7(input.birthDate)}|${escHl7(input.sex)}`;
  // ORC-1 = 오더 컨트롤(신규 NW / 취소 CA), ORC-2 = ORC-3 = accession (§3 폴백 대비 동일값)
  const orc = `ORC|${input.orderControl ?? 'NW'}|${escHl7(input.accession)}|${escHl7(input.accession)}`;

  // OBR: 필드 위치 정본 준수 (OBR-3 accession, OBR-4 proc, OBR-7 scheduled, OBR-24 modality)
  const obr: string[] = new Array(25).fill('');
  obr[0] = 'OBR';
  obr[1] = '1';
  obr[3] = escHl7(input.accession);
  obr[4] = `${escHl7(input.procedureId)}^${escHl7(input.procedureDesc)}`;
  obr[7] = escHl7(input.scheduledTs);
  obr[24] = escHl7(input.modality);

  return [msh, pid, orc, obr.join('|')].join('\r');
}

/**
 * 검사 신규 오더 ORM^O01 (LIS→HIS) — Reflex 양방향 오더 대안 경로(FHIR ServiceRequest 대신).
 *   ORC-1=NW(신규), ORC-2=placer(LIS reflex 오더참조), ORC-4=원오더(placer group), ORC-16=사유
 *   OBR-2=placer, OBR-4=universal service id(검사코드^명칭^L[^LOINC]), OBR-31=사유
 */
export interface LabOrmInput {
  sendingApp?: string;
  sendingFac?: string;
  receivingApp?: string; // 기본 HIS
  receivingFac?: string; // 기본 HOSP
  messageControlId: string;
  nowStamp: string; // YYYYMMDDHHMMSS
  patientId: string;
  placerOrderNo: string; // LIS reflex 오더 참조(멱등키)
  parentOrderId: string; // 원 오더(placer group)
  testCode: string;
  testName: string;
  loinc?: string;
  reason: string; // "Reflex: {프로토콜명} ({protocolId})"
}

export function buildLabOrm(i: LabOrmInput): string {
  const sApp = i.sendingApp ?? 'LIS';
  const sFac = i.sendingFac ?? 'WEVE';
  const rApp = i.receivingApp ?? 'HIS';
  const rFac = i.receivingFac ?? 'HOSP';

  const msh = `MSH|^~\\&|${sApp}|${sFac}|${rApp}|${rFac}|${i.nowStamp}||ORM^O01|${i.messageControlId}|P|2.5.1`;
  // 데이터 필드 전부 escHl7(세그먼트 주입 차단) — loinc·testCode는 CSV 대량반입 유입 경로가 있다.
  const pid = `PID|1||${escHl7(i.patientId)}`;

  const orc: string[] = new Array(17).fill('');
  orc[0] = 'ORC';
  orc[1] = 'NW'; // 신규 오더
  orc[2] = escHl7(i.placerOrderNo); // placer order number
  orc[4] = escHl7(i.parentOrderId); // placer group(원 오더)
  orc[16] = escHl7(i.reason); // order control code reason(반사 사유)

  const svc = `${escHl7(i.testCode)}^${escHl7(i.testName)}^L${i.loinc ? `^${escHl7(i.loinc)}^${escHl7(i.testName)}^LN` : ''}`;
  const obr: string[] = new Array(32).fill('');
  obr[0] = 'OBR';
  obr[1] = '1';
  obr[2] = escHl7(i.placerOrderNo);
  obr[4] = svc; // universal service identifier
  obr[31] = escHl7(i.reason);

  return [msh, pid, orc.join('|'), obr.join('|')].join('\r');
}

/** ACK 메시지 생성 */
export function buildAck(messageControlId: string, code: 'AA' | 'AE' | 'AR', text = ''): string {
  const msh = `MSH|^~\\&|LIS|HOSP|HIS|HOSP|||ACK|${messageControlId}|P|2.5.1`;
  const msa = `MSA|${code}|${messageControlId}${text ? '|' + escHl7(text) : ''}`;
  return [msh, msa].join('\r');
}
